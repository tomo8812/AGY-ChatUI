import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getChatBrainHostDir,
  SANDBOX_HOME_MOUNT,
  SANDBOX_WORKSPACE_MOUNT,
} from '../acp/env-isolation.js';
import type { AppDatabase } from '../db/database.js';
import type { ArtifactRecord, ToolCallItem } from '../types.js';
import {
  copyFileWithCowFallback,
  detectMimeAndPreviewKind,
  resolveContainedExistingPath,
  resolveContainedWriteTarget,
  sanitizeFileName,
  sha256File,
} from './workspace.js';

export interface ResolvedWorkspaceLink {
  artifact: ArtifactRecord;
  previewUrl: string;
  downloadUrl: string;
}

const ALLOWED_BRAIN_ROOT_REL_PATHS = [
  path.join('.gemini', 'antigravity-cli', 'brain'),
  path.join('.gemini', 'antigravity', 'brain'),
  path.join('.gemini', 'jetski', 'brain'),
  path.join('.gemini', 'brain'),
] as const;

const INTERNAL_BRAIN_EXCLUDED_EXTENSIONS = new Set([
  '.jsonl',
  '.lock',
  '.pid',
  '.tmp',
  '.part',
]);

export function getAllowedBrainRoots(profileDir: string, workspaceDir?: string | null): string[] {
  if (workspaceDir) {
    return [getChatBrainHostDir(profileDir, workspaceDir)];
  }
  const roots: string[] = [];
  for (const rel of ALLOWED_BRAIN_ROOT_REL_PATHS) {
    roots.push(path.resolve(profileDir, rel));
  }
  return roots;
}

export function normalizeLinkCandidatePath(rawReference: string): string | null {
  const raw = rawReference.trim();
  if (!raw || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('mailto:')) {
    return null;
  }

  let candidate = raw;
  if (/^file:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      return decodeURIComponent(parsed.pathname) || null;
    } catch {
      return null;
    }
  }
  // Strip optional line suffix (e.g. path/to/file.ts#L10 or path/to/file.ts:10)
  candidate = candidate.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
  return candidate.trim() || null;
}

export function resolveAuthorizedBrainFile(params: {
  profileDir: string;
  workspaceDir?: string | null;
  candidatePath: string;
}): { absPath: string; relUnderBrain: string } | null {
  let normalized = params.candidatePath.trim();
  if (!normalized) return null;
  if (normalized.startsWith('~/')) {
    normalized = path.join(params.profileDir, normalized.slice(2));
  }
  if (!path.isAbsolute(normalized)) {
    return null;
  }

  const candidateVariants = new Set<string>([normalized]);
  if (normalized.startsWith(`${SANDBOX_HOME_MOUNT}/`)) {
    const relFromHome = normalized.slice(SANDBOX_HOME_MOUNT.length + 1);
    candidateVariants.add(path.join(params.profileDir, relFromHome));
    if (params.workspaceDir) {
      for (const brainRel of ALLOWED_BRAIN_ROOT_REL_PATHS) {
        const prefix = `${brainRel.split(path.sep).join('/')}/`;
        if (relFromHome.startsWith(prefix)) {
          const underBrain = relFromHome.slice(prefix.length);
          candidateVariants.add(
            path.join(getChatBrainHostDir(params.profileDir, params.workspaceDir), underBrain)
          );
        }
      }
    }
  } else if (params.workspaceDir) {
    const profileAbs = path.resolve(params.profileDir);
    if (normalized.startsWith(`${profileAbs}/`)) {
      const relFromHome = normalized.slice(profileAbs.length + 1).split(path.sep).join('/');
      for (const brainRel of ALLOWED_BRAIN_ROOT_REL_PATHS) {
        const prefix = `${brainRel.split(path.sep).join('/')}/`;
        if (relFromHome.startsWith(prefix)) {
          const underBrain = relFromHome.slice(prefix.length);
          candidateVariants.add(
            path.join(getChatBrainHostDir(params.profileDir, params.workspaceDir), underBrain)
          );
        }
      }
    }
  }

  for (const brainRoot of getAllowedBrainRoots(params.profileDir, params.workspaceDir)) {
    if (!fs.existsSync(brainRoot)) continue;
    let brainReal: string;
    try {
      brainReal = fs.realpathSync(brainRoot);
    } catch {
      continue;
    }
    for (const variant of candidateVariants) {
      try {
        const resolved = resolveContainedExistingPath(brainReal, variant);
        // Never expose internal dot-directories / metadata files inside brain (e.g. .system_generated)
        const segments = resolved.relPath.split('/');
        if (segments.some((seg) => seg.startsWith('.'))) {
          continue;
        }
        const stat = fs.statSync(resolved.absPath);
        if (!stat.isFile()) continue;
        return { absPath: resolved.absPath, relUnderBrain: resolved.relPath };
      } catch {
        // Not contained inside this brainRoot
      }
    }
  }
  return null;
}

export interface BrainSnapshotEntry {
  absPath: string;
  relUnderBrain: string;
  sizeBytes: number;
  mtimeMs: number;
}

function isDeliverableBrainFile(relUnderBrain: string): boolean {
  const segments = relUnderBrain.split('/');
  if (segments.some((seg) => !seg || seg.startsWith('.'))) {
    return false;
  }
  const base = segments[segments.length - 1] ?? '';
  const ext = path.extname(base).toLowerCase();
  if (INTERNAL_BRAIN_EXCLUDED_EXTENSIONS.has(ext)) {
    return false;
  }
  return true;
}

export function captureBrainSnapshot(
  profileDir: string,
  workspaceDir?: string | null
): Map<string, BrainSnapshotEntry> {
  const snap = new Map<string, BrainSnapshotEntry>();
  const roots = workspaceDir
    ? [getChatBrainHostDir(profileDir, workspaceDir)]
    : getAllowedBrainRoots(profileDir, workspaceDir);

  const walk = (rootReal: string, currentDir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(rootReal, fullPath);
      } else if (entry.isFile()) {
        try {
          const real = fs.realpathSync(fullPath);
          const rel = path.relative(rootReal, real).split(path.sep).join('/');
          if (!isDeliverableBrainFile(rel)) continue;
          const st = fs.statSync(real);
          snap.set(real, {
            absPath: real,
            relUnderBrain: rel,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          // ignore transient files
        }
      }
    }
  };

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      const rootReal = fs.realpathSync(root);
      walk(rootReal, rootReal);
    } catch {
      // ignore
    }
  }
  return snap;
}

export interface SyncedBrainFile {
  brainAbsPath: string;
  relUnderBrain: string;
  workspaceAbsPath: string;
  workspaceRelPath: string;
  filename: string;
  mimeType?: string;
}

export function syncNewBrainFilesToWorkspace(params: {
  profileDir: string;
  workspaceDir: string;
  snapshot: Map<string, BrainSnapshotEntry>;
  register?: (file: SyncedBrainFile) => boolean;
}): SyncedBrainFile[] {
  const afterSnap = captureBrainSnapshot(params.profileDir, params.workspaceDir);
  const synced: SyncedBrainFile[] = [];

  for (const [absPath, entry] of afterSnap.entries()) {
    if (entry.sizeBytes <= 0) continue;
    const prev = params.snapshot.get(absPath);
    if (prev && prev.sizeBytes === entry.sizeBytes && prev.mtimeMs === entry.mtimeMs) {
      continue;
    }
    try {
      const imported = importAuthorizedBrainFileToWorkspace({
        workspaceDir: params.workspaceDir,
        sourceAbsPath: absPath,
      });
      const file: SyncedBrainFile = {
        brainAbsPath: absPath,
        relUnderBrain: entry.relUnderBrain,
        workspaceAbsPath: imported.absPath,
        workspaceRelPath: imported.relPath,
        filename: path.basename(imported.relPath),
      };
      // A copy is not delivered until its registration and notification succeed.
      if (params.register && !params.register(file)) continue;
      params.snapshot.set(absPath, entry);
      synced.push(file);
    } catch {
      // ignore failed import
    }
  }

  return synced;
}

function encodeMarkdownUrl(url: string): string {
  return url.replace(/[()[\]"'<>\s]/g, char =>
    [...Buffer.from(char)].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  );
}

export function workspaceFileUri(relPath: string): string {
  return encodeMarkdownUrl(pathToFileURL(`${SANDBOX_WORKSPACE_MOUNT}/${relPath}`).href);
}

export function formatFileLink(filename: string, reference: string, image = false): string {
  const label = filename.replace(/[\\[\]]/g, '\\$&');
  let destination = reference;
  if (/^file:\/\//i.test(reference)) {
    const candidate = normalizeLinkCandidatePath(reference);
    if (candidate) destination = pathToFileURL(candidate).href;
  } else if (!/^[a-z][a-z\d+.-]*:/i.test(reference)) {
    destination = pathToFileURL(path.posix.resolve(SANDBOX_WORKSPACE_MOUNT, reference)).href;
  }
  return `${image ? '!' : ''}[${label}](${encodeMarkdownUrl(destination)})`;
}

/** A structured URI/location is one reference, even when its filename contains spaces. */
export function rewriteInternalFileReference(
  reference: string,
  profileDir: string,
  workspaceDir?: string | null
): string {
  const normalized = normalizeLinkCandidatePath(reference);
  if (!normalized) return reference;
  const profileAbs = path.resolve(profileDir);
  const brainFile = resolveAuthorizedBrainFile({
    profileDir: profileAbs, workspaceDir, candidatePath: normalized,
  });
  if (brainFile && workspaceDir) {
    try {
      const imported = importAuthorizedBrainFileToWorkspace({
        workspaceDir, sourceAbsPath: brainFile.absPath,
      });
      return /^file:\/\//i.test(reference) || /[\s%#?()[\]]/.test(imported.relPath)
        ? workspaceFileUri(imported.relPath)
        : `${SANDBOX_WORKSPACE_MOUNT}/${imported.relPath}`;
    } catch {
      // Redact inaccessible internal paths below.
    }
  }
  const isInternalPath =
    normalized.startsWith(`${profileAbs}/`) || normalized === profileAbs ||
    normalized.startsWith(`${SANDBOX_HOME_MOUNT}/`) || normalized === SANDBOX_HOME_MOUNT ||
    normalized.startsWith('/var/lib/antigravity-chat/');
  if (!isInternalPath) return reference;
  const base = path.basename(normalized.replace(/\/+$/, ''));
  const ext = path.extname(base);
  const relPath = ext && !INTERNAL_BRAIN_EXCLUDED_EXTENSIONS.has(ext.toLowerCase())
    ? `generated/${sanitizeFileName(base)}` : 'generated/';
  return /^file:\/\//i.test(reference) || /[\s%#?()[\]]/.test(relPath)
    ? workspaceFileUri(relPath) : `${SANDBOX_WORKSPACE_MOUNT}/${relPath}`;
}

export function rewriteInternalPathsToWorkspace(
  text: string,
  profileDir: string,
  workspaceDir?: string | null
): string {
  return text.replace(/(?:file:\/\/)?(\/[^\s"'`<>()\[\]」』】》〉、。]+)/gi,
    (fullMatch, rawPath: string) => {
      const trailing = /([.,;:!?]+)$/.exec(rawPath)?.[1] ?? '';
      const reference = trailing ? fullMatch.slice(0, -trailing.length) : fullMatch;
      return rewriteInternalFileReference(reference, profileDir, workspaceDir) + trailing;
    }
  );
}

/** Rewrites only complete path tokens; ACP chunks can split anywhere in a URI. */
export class InternalPathStreamRewriter {
  private pending = '';

  constructor(
    private readonly profileDir: string,
    private readonly workspaceDir: string
  ) {}

  write(chunk: string, final = false): string {
    const text = this.pending + chunk;
    // Retain unfinished paths, including partial "file:" prefixes, until a boundary arrives.
    const tail = final ? null : /[^\s"'`<>()\[\]」』】》〉、。]*$/.exec(text);
    const mayBePath = tail && (tail[0].includes('/') || /(?:file:|file|fil|fi|f)$/i.test(tail[0]));
    const boundary = mayBePath ? tail.index : text.length;
    this.pending = text.slice(boundary);
    return rewriteInternalPathsToWorkspace(text.slice(0, boundary), this.profileDir, this.workspaceDir);
  }
}

export function scrubToolCallsInternalPaths(
  toolCalls: ToolCallItem[],
  profileDir: string,
  workspaceDir?: string | null
): ToolCallItem[] {
  const scrubValue = (val: unknown, depth = 0, field?: string): unknown => {
    if (depth > 5 || val == null) return val;
    if (typeof val === 'string') {
      return field && /^(?:path|uri|url|file_path|filepath|absolute_path|relative_path|sourcepath|destinationpath)$/i.test(field)
        ? rewriteInternalFileReference(val, profileDir, workspaceDir)
        : rewriteInternalPathsToWorkspace(val, profileDir, workspaceDir);
    }
    if (Array.isArray(val)) {
      return val.map((item) => scrubValue(item, depth + 1));
    }
    if (typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = scrubValue(v, depth + 1, k);
      }
      return out;
    }
    return val;
  };

  return toolCalls.map((tc) => ({
    ...tc,
    title: rewriteInternalPathsToWorkspace(tc.title, profileDir, workspaceDir),
    contentText: tc.contentText
      ? rewriteInternalPathsToWorkspace(tc.contentText, profileDir, workspaceDir)
      : tc.contentText,
    locations: tc.locations?.map((loc) => ({
      ...loc,
      path: rewriteInternalFileReference(loc.path, profileDir, workspaceDir),
    })),
    subagentContentText: tc.subagentContentText
      ? rewriteInternalPathsToWorkspace(tc.subagentContentText, profileDir, workspaceDir) : tc.subagentContentText,
    subagentThoughtsText: tc.subagentThoughtsText
      ? rewriteInternalPathsToWorkspace(tc.subagentThoughtsText, profileDir, workspaceDir) : tc.subagentThoughtsText,
    subagentToolCalls: tc.subagentToolCalls
      ? scrubToolCallsInternalPaths(tc.subagentToolCalls, profileDir, workspaceDir) : tc.subagentToolCalls,
    rawInput: scrubValue(tc.rawInput),
    rawOutput: scrubValue(tc.rawOutput),
  }));
}

export function importAuthorizedBrainFileToWorkspace(params: {
  workspaceDir: string;
  sourceAbsPath: string;
}): { absPath: string; relPath: string } {
  fs.mkdirSync(params.workspaceDir, { recursive: true, mode: 0o700 });
  const srcSha = sha256File(params.sourceAbsPath);
  const rawName = sanitizeFileName(path.basename(params.sourceAbsPath));
  const ext = path.extname(rawName);
  const stem = ext ? rawName.slice(0, -ext.length) : rawName;

  const primaryRel = `generated/${rawName}`;
  const primaryTarget = resolveContainedWriteTarget(params.workspaceDir, primaryRel);
  if (fs.existsSync(primaryTarget.absPath) && fs.statSync(primaryTarget.absPath).isFile()) {
    const existingSha = sha256File(primaryTarget.absPath);
    if (existingSha === srcSha) {
      return primaryTarget;
    }
    const dedupRel = `generated/${stem}-${srcSha.slice(0, 8)}${ext}`;
    const dedupTarget = resolveContainedWriteTarget(params.workspaceDir, dedupRel);
    if (!fs.existsSync(dedupTarget.absPath)) {
      copyFileWithCowFallback(params.sourceAbsPath, dedupTarget.absPath);
    }
    return dedupTarget;
  }

  copyFileWithCowFallback(params.sourceAbsPath, primaryTarget.absPath);
  return primaryTarget;
}

export function extractCandidatePathsFromText(text: string): string[] {
  const candidates = new Set<string>();
  if (!text) return [];
  const regex = /(?:file:\/\/\/|\/|~\/)[^\s"'`<>()\[\]」』】》〉、。]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const cleaned = normalizeLinkCandidatePath(match[0].replace(/[.,;:!?]+$/, ''));
    if (cleaned) candidates.add(cleaned);
  }
  return [...candidates];
}

export function extractCandidatePathsFromToolCalls(toolCalls: ToolCallItem[]): string[] {
  const candidates = new Set<string>();
  for (const tc of toolCalls) {
    for (const loc of tc.locations ?? []) {
      const cleaned = normalizeLinkCandidatePath(loc.path);
      if (cleaned) candidates.add(cleaned);
    }
    const inspectVal = (val: unknown, depth = 0) => {
      if (depth > 4 || val == null) return;
      if (typeof val === 'string') {
        for (const p of extractCandidatePathsFromText(val)) {
          candidates.add(p);
        }
        return;
      }
      if (Array.isArray(val)) {
        for (const item of val) inspectVal(item, depth + 1);
        return;
      }
      if (typeof val === 'object') {
        for (const v of Object.values(val as Record<string, unknown>)) {
          inspectVal(v, depth + 1);
        }
      }
    };
    inspectVal(tc.rawInput);
    inspectVal(tc.rawOutput);
  }
  return [...candidates];
}

function buildArtifactUrls(artifact: ArtifactRecord): { previewUrl: string; downloadUrl: string } {
  const versionSuffix = artifact.sha256 ? `?v=${artifact.sha256.slice(0, 12)}` : '';
  return {
    previewUrl: `/api/files/${artifact.id}/content${versionSuffix}`,
    downloadUrl: `/api/files/${artifact.id}/content?download=1`,
  };
}

/**
 * Resolves a model-mentioned file reference (relative path, workspace-scoped absolute path,
 * artifact ID, or generated artifact inside the user's own profile `.gemini/<profile>/brain/` dir)
 * strictly within the authorized user's scope.
 * Never resolves files belonging to other users or outside workspace/brain roots.
 */
export function resolveAuthorizedChatFileReference(params: {
  db: AppDatabase;
  userId: string;
  chatId: string;
  reference: string;
}): ResolvedWorkspaceLink | null {
  const chat = params.db.getChat(params.userId, params.chatId);
  if (!chat) return null;

  let candidate = normalizeLinkCandidatePath(params.reference);
  if (!candidate) return null;

  if (candidate === SANDBOX_WORKSPACE_MOUNT) {
    return null;
  }
  if (candidate.startsWith(`${SANDBOX_WORKSPACE_MOUNT}/`)) {
    candidate = candidate.slice(SANDBOX_WORKSPACE_MOUNT.length + 1);
  }

  // All routes register/refresh the same workspace artifact, preserving its message/run ownership.
  const resolveWorkspaceFile = (reference: string): ResolvedWorkspaceLink | null => {
    try {
      const { absPath, relPath } = resolveContainedExistingPath(chat.workspaceDir, reference);
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) return null;
      let artifact = params.db.findArtifactByRelPath(params.userId, params.chatId, relPath);
      if (
        !artifact || stat.size !== artifact.sizeBytes ||
        Math.floor(stat.mtimeMs) > artifact.updatedAt || stat.size <= 512 * 1024
      ) {
        const fileSha = sha256File(absPath);
        if (
          !artifact || artifact.sha256 !== fileSha || stat.size !== artifact.sizeBytes ||
          Math.floor(stat.mtimeMs) > artifact.updatedAt
        ) {
          const filename = artifact?.filename ?? path.basename(relPath);
          const { mimeType, previewKind } = artifact ?? detectMimeAndPreviewKind(filename);
          artifact = params.db.upsertArtifact({
            id: artifact?.id ?? crypto.randomUUID(),
            userId: params.userId,
            chatId: params.chatId,
            messageId: artifact?.messageId ?? null,
            runId: artifact?.runId ?? null,
            relPath,
            filename,
            mimeType,
            sizeBytes: stat.size,
            sha256: fileSha,
            source: relPath.startsWith('.project-context/') ? 'project_copy' : (artifact?.source ?? 'generated'),
            previewKind,
            diffPatch: null,
            minUpdatedAt: stat.mtimeMs,
          });
        }
      }
      return { artifact: artifact!, ...buildArtifactUrls(artifact!) };
    } catch {
      return null;
    }
  };

  const byId = params.db.getArtifact(params.userId, candidate);
  if (byId && byId.chatId === params.chatId) {
    return resolveWorkspaceFile(byId.relPath);
  }

  const workspaceFile = resolveWorkspaceFile(candidate);
  if (workspaceFile) return workspaceFile;

  // Older chunk-by-chunk rewriting produced generated//brain/<session>/<filename>.
  // Recover only that signature, within this chat, and only when no hash-suffixed
  // collision copy makes the original filename ambiguous. Exact workspace paths win.
  const legacy = /^generated\/\/brain\/[^/.][^/]*\/([^/]+)$/.exec(candidate);
  if (legacy && legacy[1] !== '.' && legacy[1] !== '..') {
    const filename = legacy[1];
    const ext = path.extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    try {
      const generated = resolveContainedExistingPath(chat.workspaceDir, 'generated');
      const entries = fs.readdirSync(generated.absPath);
      const hasCollision = entries.some((name) =>
        name.startsWith(`${stem}-`) && name.endsWith(ext) &&
        /^[a-f0-9]{8}$/.test(name.slice(stem.length + 1, ext ? -ext.length : undefined))
      );
      if (!hasCollision) {
        const recovered = resolveWorkspaceFile(`generated/${filename}`);
        if (recovered) return recovered;
      }
    } catch {
      // Missing generated directory; continue with authorized brain resolution.
    }
  }

  const profile = params.db.getAgyProfile(params.userId);
  if (!profile) return null;
  const brainFile = resolveAuthorizedBrainFile({
    profileDir: profile.profileDir,
    workspaceDir: chat.workspaceDir,
    candidatePath: candidate,
  });
  if (!brainFile) return null;

  try {
    const imported = importAuthorizedBrainFileToWorkspace({
      workspaceDir: chat.workspaceDir,
      sourceAbsPath: brainFile.absPath,
    });
    return resolveWorkspaceFile(imported.relPath);
  } catch {
    return null;
  }
}
