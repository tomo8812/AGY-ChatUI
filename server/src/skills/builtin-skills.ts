import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BUILTIN_STATE_FILENAME = '.builtin-skills-state.json';
export const LEGACY_BUILTIN_SYNC_MARKER = '.agy-builtin-skill';
const BUILTIN_MANIFEST_FILENAME = '.builtin-skills-manifest.json';
const BACKUP_DIR_NAME = '.builtin-migration-backups';

const VALID_SKILL_SLUG_RE = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,62}[a-z0-9])$/;

export interface BuiltinSkillEntry {
  slug: string;
  dir: string;
  sha256: string | null;
}

export interface PreservedLegacySkillNotice {
  slug: string;
  skillDir: string;
  backupDir: string;
  reason: 'digest_mismatch' | 'missing_digest' | 'unreadable';
  migratedAt: number;
}

export interface LegacyMigrationResult {
  removed: string[];
  preservedCustom: PreservedLegacySkillNotice[];
}

export function isValidSkillSlug(rawSlug: string): boolean {
  const normalized = rawSlug.trim().toLowerCase();
  return Boolean(normalized && normalized === rawSlug && VALID_SKILL_SLUG_RE.test(normalized));
}

export function getProfileCustomSkillScanDirs(profileDir: string): string[] {
  const profileAbs = path.resolve(profileDir);
  return [
    path.join(profileAbs, '.gemini', 'config', 'skills'),
    path.join(profileAbs, '.gemini', 'config', 'skills-disabled'),
    path.join(profileAbs, '.gemini', 'skills'),
    path.join(profileAbs, '.gemini', 'antigravity', 'skills'),
  ];
}

/**
 * Computes the same deterministic SHA-256 directory digest as `scripts/fetch-anthropic-skills.mjs`
 * (excluding sync marker and VCS/cache metadata). Returns `null` if symlinks or read errors occur.
 */
export function computeSkillDirectoryDigest(skillDir: string): string | null {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(skillDir);
  } catch {
    return null;
  }

  const files: Array<{ rel: string; abs: string }> = [];
  let unsafeOrUnreadable = false;

  const walk = (currentDir: string, relBase = '') => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.name === LEGACY_BUILTIN_SYNC_MARKER ||
        entry.name === '.agy-project-skill' ||
        entry.name === '.git' ||
        entry.name === '__pycache__' ||
        entry.name === '.DS_Store'
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        unsafeOrUnreadable = true;
        continue;
      }
      const full = path.join(currentDir, entry.name);
      const real = fs.realpathSync(full);
      if (!real.startsWith(rootReal + path.sep)) {
        unsafeOrUnreadable = true;
        continue;
      }
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(real, rel);
      } else if (entry.isFile()) {
        files.push({ rel, abs: real });
      }
    }
  };

  try {
    walk(rootReal);
  } catch {
    return null;
  }
  if (unsafeOrUnreadable) return null;

  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = crypto.createHash('sha256');
  try {
    for (const item of files) {
      const data = fs.readFileSync(item.abs);
      hash.update(item.rel);
      hash.update('\0');
      hash.update(String(data.byteLength));
      hash.update('\0');
      hash.update(data);
      hash.update('\0');
    }
  } catch {
    return null;
  }

  return hash.digest('hex');
}

function copyTreeSafeForBackup(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
  const rootReal = fs.realpathSync(srcDir);
  const walk = (dir: string, relBase = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === LEGACY_BUILTIN_SYNC_MARKER || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const real = fs.realpathSync(full);
      if (!real.startsWith(rootReal + path.sep)) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const target = path.join(dstDir, rel);
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        walk(real, rel);
      } else if (entry.isFile()) {
        fs.copyFileSync(real, target);
        fs.chmodSync(target, 0o600);
      }
    }
  };
  walk(rootReal);
}

/**
 * Reads the read-only Built-in skills catalog from `builtinSkillsDir`.
 * Returns a deterministic map keyed by slug.
 */
export function readBuiltinSkillsCatalog(builtinSkillsDir?: string | null): Map<string, BuiltinSkillEntry> {
  const catalog = new Map<string, BuiltinSkillEntry>();
  if (!builtinSkillsDir || !builtinSkillsDir.trim()) return catalog;

  let baseReal: string;
  try {
    baseReal = fs.realpathSync(path.resolve(builtinSkillsDir));
    if (!fs.statSync(baseReal).isDirectory()) return catalog;
  } catch {
    return catalog;
  }

  const manifestShas = new Map<string, string>();
  const manifestPath = path.join(baseReal, BUILTIN_MANIFEST_FILENAME);
  try {
    if (fs.existsSync(manifestPath)) {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        skills?: Record<string, { sha256?: unknown }>;
      };
      if (parsed && parsed.skills && typeof parsed.skills === 'object') {
        for (const [slug, meta] of Object.entries(parsed.skills)) {
          if (meta && typeof meta.sha256 === 'string' && meta.sha256) {
            manifestShas.set(slug, meta.sha256);
          }
        }
      }
    }
  } catch {
    // ignore malformed manifest and fall back to scanning directories
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseReal, { withFileTypes: true });
  } catch {
    return catalog;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const slug = entry.name.trim().toLowerCase();
    if (!isValidSkillSlug(slug) || slug !== entry.name) continue;
    const skillDir = path.join(baseReal, entry.name);
    let skillDirReal: string;
    try {
      skillDirReal = fs.realpathSync(skillDir);
    } catch {
      continue;
    }
    if (!skillDirReal.startsWith(baseReal + path.sep)) continue;
    if (!fs.existsSync(path.join(skillDirReal, 'SKILL.md'))) continue;
    catalog.set(slug, {
      slug,
      dir: skillDirReal,
      sha256: manifestShas.get(slug) ?? null,
    });
  }

  return catalog;
}

function readExistingProfileStateRaw(configDir: string): {
  disabled?: unknown;
  manifestDigest?: unknown;
  skills?: Record<string, { status?: unknown; sha256?: unknown }>;
  migratedCustomNotices?: PreservedLegacySkillNotice[];
} | null {
  const statePath = path.join(configDir, BUILTIN_STATE_FILENAME);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      disabled?: unknown;
      manifestDigest?: unknown;
      skills?: Record<string, { status?: unknown; sha256?: unknown }>;
      migratedCustomNotices?: PreservedLegacySkillNotice[];
    };
  } catch {
    return null;
  }
}

/**
 * Reads per-profile Built-in disabled slugs from `.gemini/config/.builtin-skills-state.json`.
 */
export function readProfileDisabledBuiltins(profileDir: string): Set<string> {
  const disabled = new Set<string>();
  const configDir = path.join(path.resolve(profileDir), '.gemini', 'config');
  const parsed = readExistingProfileStateRaw(configDir);
  if (!parsed) return disabled;

  if (Array.isArray(parsed.disabled)) {
    for (const item of parsed.disabled) {
      if (typeof item === 'string' && isValidSkillSlug(item)) {
        disabled.add(item);
      }
    }
  }
  // Support reading legacy state shape if present before migration
  if (parsed.skills && typeof parsed.skills === 'object') {
    for (const [slug, meta] of Object.entries(parsed.skills)) {
      if (
        isValidSkillSlug(slug) &&
        meta &&
        (meta.status === 'disabled' || meta.status === 'deleted')
      ) {
        disabled.add(slug);
      }
    }
  }
  return disabled;
}

export function writeProfileDisabledBuiltins(
  profileDir: string,
  disabledSet: ReadonlySet<string>,
  extraNotices?: PreservedLegacySkillNotice[]
): void {
  const configDir = path.join(path.resolve(profileDir), '.gemini', 'config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const existing = readExistingProfileStateRaw(configDir);
  const priorNotices = Array.isArray(existing?.migratedCustomNotices)
    ? existing.migratedCustomNotices
    : [];
  const mergedNotices = [...priorNotices, ...(extraNotices ?? [])];

  const statePath = path.join(configDir, BUILTIN_STATE_FILENAME);
  const tmpPath = `${statePath}.tmp.${process.pid}`;
  const payload: {
    disabled: string[];
    migratedCustomNotices?: PreservedLegacySkillNotice[];
  } = {
    disabled: [...disabledSet].filter(isValidSkillSlug).sort(),
  };
  if (mergedNotices.length > 0) {
    payload.migratedCustomNotices = mergedNotices;
  }
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, statePath);
}

/**
 * Migrates legacy `.agy-builtin-skill` copies out of user skill directories:
 * - Only removes a legacy copy if its current directory SHA-256 strictly matches
 *   the distributed digest recorded in `.agy-builtin-skill` (or legacy state).
 * - If any file (`SKILL.md` or attached scripts/references/assets) was modified or added,
 *   or the recorded digest is missing/unverifiable, creates a backup and converts the
 *   directory into a Custom skill by stripping `.agy-builtin-skill` instead of deleting it.
 */
export function migrateLegacySyncedBuiltins(profileDir: string): LegacyMigrationResult {
  const profileAbs = path.resolve(profileDir);
  const configDir = path.join(profileAbs, '.gemini', 'config');
  const enabledDir = path.join(configDir, 'skills');
  const disabledDir = path.join(configDir, 'skills-disabled');
  const existingState = readExistingProfileStateRaw(configDir);
  const disabledSet = readProfileDisabledBuiltins(profileAbs);
  const removed: string[] = [];
  const preservedCustom: PreservedLegacySkillNotice[] = [];
  let stateNeedsRewrite = Boolean(existingState && existingState.manifestDigest !== undefined);

  for (const [dir, isDisabledDir] of [
    [enabledDir, false],
    [disabledDir, true],
  ] as const) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      const markerPath = path.join(skillDir, LEGACY_BUILTIN_SYNC_MARKER);
      if (!fs.existsSync(markerPath)) continue;

      let markerSha: string | null = null;
      try {
        const parsedMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { sha256?: unknown };
        if (typeof parsedMarker?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(parsedMarker.sha256)) {
          markerSha = parsedMarker.sha256.toLowerCase();
        }
      } catch {
        markerSha = null;
      }

      if (!markerSha && existingState?.skills && typeof existingState.skills === 'object') {
        const legacyMeta = existingState.skills[entry.name];
        if (
          legacyMeta &&
          typeof legacyMeta.sha256 === 'string' &&
          /^[a-f0-9]{64}$/i.test(legacyMeta.sha256)
        ) {
          markerSha = legacyMeta.sha256.toLowerCase();
        }
      }

      const actualSha = computeSkillDirectoryDigest(skillDir);
      if (markerSha && actualSha && actualSha.toLowerCase() === markerSha) {
        if (isDisabledDir && isValidSkillSlug(entry.name)) {
          disabledSet.add(entry.name);
        }
        fs.rmSync(skillDir, { recursive: true, force: true });
        removed.push(entry.name);
        stateNeedsRewrite = true;
        continue;
      }

      const reason: PreservedLegacySkillNotice['reason'] = !markerSha
        ? 'missing_digest'
        : actualSha === null
          ? 'unreadable'
          : 'digest_mismatch';

      const backupDir = path.join(
        configDir,
        BACKUP_DIR_NAME,
        `${entry.name}-${Date.now()}-${preservedCustom.length}`
      );
      try {
        copyTreeSafeForBackup(skillDir, backupDir);
      } catch {
        // Backup best-effort failed; still preserve the original directory in place and do not delete
      }
      fs.rmSync(markerPath, { force: true });
      const notice: PreservedLegacySkillNotice = {
        slug: entry.name,
        skillDir,
        backupDir,
        reason,
        migratedAt: Date.now(),
      };
      preservedCustom.push(notice);
      stateNeedsRewrite = true;
      console.warn(
        `[builtin-skills] Preserved modified legacy skill "${entry.name}" as custom (${reason}); backup: ${backupDir}`
      );
    }
  }

  if (stateNeedsRewrite) {
    writeProfileDisabledBuiltins(profileAbs, disabledSet, preservedCustom);
  }

  return { removed, preservedCustom };
}

/**
 * Lists all Custom global skill slugs across canonical, disabled, and legacy paths
 * so Built-in skills never overwrite or hide an existing user-authored skill.
 */
export function listCustomGlobalSkillSlugs(profileDir: string): Set<string> {
  const slugs = new Set<string>();
  for (const baseDir of getProfileCustomSkillScanDirs(profileDir)) {
    if (!fs.existsSync(baseDir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const slug = entry.name.trim().toLowerCase();
      if (!isValidSkillSlug(slug) || slug !== entry.name) continue;
      const skillDir = path.join(baseDir, entry.name);
      if (fs.existsSync(path.join(skillDir, LEGACY_BUILTIN_SYNC_MARKER))) continue;
      if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
        slugs.add(slug);
      }
    }
  }
  return slugs;
}

/**
 * Resolves the active Built-in skills to expose to Antigravity for a given profile:
 * excludes user-disabled Built-in skills and any Built-in skill colliding with a
 * Custom global skill (including legacy paths).
 */
export function resolveActiveBuiltinSkillsForProfile(
  profileDir: string,
  builtinSkillsDir?: string | null
): {
  active: BuiltinSkillEntry[];
  conflicts: string[];
} {
  const catalog = readBuiltinSkillsCatalog(builtinSkillsDir);
  if (catalog.size === 0) {
    return { active: [], conflicts: [] };
  }
  const disabledSet = readProfileDisabledBuiltins(profileDir);
  const customSlugs = listCustomGlobalSkillSlugs(profileDir);

  const active: BuiltinSkillEntry[] = [];
  const conflicts: string[] = [];

  for (const [slug, entry] of catalog.entries()) {
    if (customSlugs.has(slug)) {
      conflicts.push(slug);
      continue;
    }
    if (disabledSet.has(slug)) {
      continue;
    }
    active.push(entry);
  }

  return { active, conflicts };
}
