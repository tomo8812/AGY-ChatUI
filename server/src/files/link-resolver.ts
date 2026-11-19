import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mime from 'mime-types';
import { getChatBrainHostDir, SANDBOX_HOME_MOUNT, SANDBOX_WORKSPACE_MOUNT } from '../acp/env-isolation.js';
import type { AppDatabase } from '../db/database.js';
import type { ArtifactRecord, ChatRecord } from '../types.js';
import { detectMimeAndPreviewKind, normalizeRelPath, resolveContainedExistingPath, sha256File } from './workspace.js';

export interface ResolvedWorkspaceLink {
  artifact: ArtifactRecord;
  previewUrl: string;
  downloadUrl: string;
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
      if (parsed.hostname) return null;
      return decodeURIComponent(parsed.pathname) || null;
    } catch {
      return null;
    }
  }
  // Strip optional line suffix (e.g. path/to/file.ts#L10 or path/to/file.ts:10)
  candidate = candidate.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
  return candidate.trim() || null;
}

function encodeMarkdownUrl(url: string): string {
  return url.replace(/[()[\]"'<>\s]/g, char =>
    [...Buffer.from(char)].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  );
}

export function formatFileLink(filename: string, reference: string, image = false): string {
  const label = filename.replace(/[\\[\]]/g, '\\$&');
  let destination = reference;
  if (!reference.startsWith('~/') && !/^[a-z][a-z\d+.-]*:/i.test(reference)) {
    destination = pathToFileURL(path.posix.resolve(SANDBOX_WORKSPACE_MOUNT, reference)).href;
  }
  return `${image ? '!' : ''}[${label}](${encodeMarkdownUrl(destination)})`;
}

export function detectContentFileType(filename: string, declaredMime?: string | null): ReturnType<typeof detectMimeAndPreviewKind> {
  if (!declaredMime || declaredMime === 'application/octet-stream') {
    return detectMimeAndPreviewKind(filename);
  }
  const extension = mime.extension(declaredMime) || 'bin';
  return { ...detectMimeAndPreviewKind(`content.${extension}`, declaredMime), mimeType: declaredMime };
}

type ResolvedChatFile = { absPath: string; relPath: string };

const BLOCKED_PROFILE_TOP_DIRS = new Set([
  '.chat-brains',
  '.chat-homes',
  '.chat-scratch',
  '.chat-playground',
  '.probe',
  '.tmp',
  '.config',
  '.local',
  '.cache',
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.azure',
  '.gcp',
]);

const BLOCKED_GEMINI_SUBDIRS = new Set([
  'brain',
  'scratch',
  'playground',
  'code_tracker',
  'implicit',
  'conversations',
  'sessions',
  'logs',
  'cache',
  'tmp',
  'auth',
  'credentials',
  'tokens',
]);

const BLOCKED_SECRET_FILENAMES = new Set([
  '.mock-agy-auth.json',
  '.env',
  '.netrc',
  '.git-credentials',
  '.gitcookies',
  '.npmrc',
  '.pypirc',
  '.bash_history',
  '.zsh_history',
  '.sh_history',
  'oauth_creds.json',
  'google_accounts.json',
  'credentials.json',
  'client_secret.json',
  'client_secrets.json',
  'service_account.json',
  'service-account.json',
  'application_default_credentials.json',
  'installation_id',
  'mcp_config.json',
  'settings.json',
  'auth.json',
  'token.json',
  'tokens.json',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
]);

const BLOCKED_SECRET_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.kdbx',
  '.pb',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.ldb',
]);

function isBlockedProfileRelPath(relPath: string): boolean {
  const segments = relPath.split('/').filter(Boolean);
  if (segments.length === 0) return true;

  const top = segments[0].toLowerCase();
  if (BLOCKED_PROFILE_TOP_DIRS.has(top) || top.startsWith('.usage-home-')) {
    return true;
  }

  if (top === '.gemini') {
    const sub = segments[1]?.toLowerCase();
    const vendorSub =
      sub === 'antigravity-cli' || sub === 'antigravity' || sub === 'jetski'
        ? segments[2]?.toLowerCase()
        : sub;
    if (vendorSub && BLOCKED_GEMINI_SUBDIRS.has(vendorSub)) {
      return true;
    }
  }

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (lower === '.ssh' || lower === '.gnupg') return true;
  }

  const basename = segments[segments.length - 1].toLowerCase();
  if (
    BLOCKED_SECRET_FILENAMES.has(basename) ||
    basename.startsWith('.env') ||
    /(?:^|[._-])(?:oauth|cred|creds|credential|credentials|secret|secrets|token|tokens|auth)\.json$/.test(basename)
  ) {
    return true;
  }

  const ext = path.extname(basename);
  if (BLOCKED_SECRET_EXTENSIONS.has(ext)) {
    return true;
  }

  return false;
}

function workspaceRelativePath(candidate: string): string {
  return candidate.startsWith(`${SANDBOX_WORKSPACE_MOUNT}/`)
    ? candidate.slice(SANDBOX_WORKSPACE_MOUNT.length).replace(/^\/+/, '') : candidate;
}

/** Map native paths to this chat's private roots or non-sensitive user profile files without moving them. */
function resolveChatFile(db: AppDatabase, chat: ChatRecord, candidate: string): ResolvedChatFile | null {
  try {
    const resolved = resolveContainedExistingPath(chat.workspaceDir, workspaceRelativePath(candidate));
    if (fs.statSync(resolved.absPath).isFile()) return resolved;
  } catch {
    // A native Antigravity path may be outside the workspace.
  }

  const profile = db.getAgyProfile(chat.userId);
  if (!profile) return null;
  const home = path.resolve(profile.profileDir);
  const workspaceKey = path.basename(path.resolve(chat.workspaceDir));
  const chatHome = path.join(home, '.chat-homes', workspaceKey);
  const homePrefix = [SANDBOX_HOME_MOUNT, chatHome, home].find(root => candidate.startsWith(`${root}/`));
  const rawRelative = candidate.startsWith('~/') ? candidate.slice(2)
    : homePrefix ? candidate.slice(homePrefix.length + 1) : '';
  if (!rawRelative) return null;

  let relative: string;
  try {
    relative = normalizeRelPath(rawRelative);
  } catch {
    return null;
  }

  const alias = /^\.gemini\/(?:antigravity-cli\/|antigravity\/|jetski\/)?(brain|scratch|playground)\/(.+)$/.exec(relative);
  const directory = alias?.[1] ?? /^\.chat-(brains|scratch|playground)\//.exec(relative)?.[1];
  if (directory) {
    const kind = directory === 'brains' ? 'brain' : directory;
    const root = kind === 'brain' ? getChatBrainHostDir(home, chat.workspaceDir)
      : path.join(home, `.chat-${kind}`, workspaceKey);
    try {
      if (fs.realpathSync(root) !== path.join(fs.realpathSync(home), path.relative(home, root))) return null;
      const resolved = resolveContainedExistingPath(root, alias ? alias[2] : candidate);
      if (!fs.statSync(resolved.absPath).isFile()) return null;
      return { absPath: resolved.absPath, relPath: `${SANDBOX_HOME_MOUNT}/.gemini/${kind}/${resolved.relPath}` };
    } catch {
      return null;
    }
  }

  const chatHomeMatch = /^\.chat-homes\/([^/]+)\/(.+)$/.exec(relative);
  if (chatHomeMatch) {
    if (chatHomeMatch[1] !== workspaceKey) return null;
    const subRelative = chatHomeMatch[2];
    if (isBlockedProfileRelPath(subRelative)) return null;
    try {
      const homeReal = fs.realpathSync(home);
      const chatHomeReal = fs.realpathSync(chatHome);
      if (chatHomeReal !== path.join(homeReal, '.chat-homes', workspaceKey)) return null;
      const resolved = resolveContainedExistingPath(chatHomeReal, subRelative);
      if (isBlockedProfileRelPath(resolved.relPath)) return null;
      if (!fs.statSync(resolved.absPath).isFile()) return null;
      return {
        absPath: resolved.absPath,
        relPath: `${SANDBOX_HOME_MOUNT}/.chat-homes/${workspaceKey}/${resolved.relPath}`,
      };
    } catch {
      return null;
    }
  }

  if (isBlockedProfileRelPath(relative)) return null;

  const resolveFromHome = (): ResolvedChatFile | null => {
    try {
      const resolved = resolveContainedExistingPath(home, relative);
      if (isBlockedProfileRelPath(resolved.relPath)) return null;
      if (!fs.statSync(resolved.absPath).isFile()) return null;
      return { absPath: resolved.absPath, relPath: `${SANDBOX_HOME_MOUNT}/${resolved.relPath}` };
    } catch {
      return null;
    }
  };

  const resolveFromChatHome = (): ResolvedChatFile | null => {
    try {
      const homeReal = fs.realpathSync(home);
      const chatHomeReal = fs.realpathSync(chatHome);
      if (chatHomeReal !== path.join(homeReal, '.chat-homes', workspaceKey)) return null;
      const resolved = resolveContainedExistingPath(chatHomeReal, relative);
      if (isBlockedProfileRelPath(resolved.relPath)) return null;
      if (!fs.statSync(resolved.absPath).isFile()) return null;
      return {
        absPath: resolved.absPath,
        relPath: `${SANDBOX_HOME_MOUNT}/.chat-homes/${workspaceKey}/${resolved.relPath}`,
      };
    } catch {
      return null;
    }
  };

  if (homePrefix === chatHome) {
    try {
      const homeReal = fs.realpathSync(home);
      const chatHomeReal = fs.realpathSync(chatHome);
      if (chatHomeReal !== path.join(homeReal, '.chat-homes', workspaceKey)) return null;
      const targetReal = fs.realpathSync(path.resolve(chatHomeReal, relative));
      if (!fs.statSync(targetReal).isFile()) return null;

      if (targetReal.startsWith(chatHomeReal + path.sep)) {
        const resolvedRelPath = path.relative(chatHomeReal, targetReal).split(path.sep).join('/');
        if (!resolvedRelPath || isBlockedProfileRelPath(resolvedRelPath)) return null;
        return {
          absPath: targetReal,
          relPath: `${SANDBOX_HOME_MOUNT}/.chat-homes/${workspaceKey}/${resolvedRelPath}`,
        };
      }
      if (targetReal.startsWith(homeReal + path.sep)) {
        const resolvedRelPath = path.relative(homeReal, targetReal).split(path.sep).join('/');
        if (!resolvedRelPath || isBlockedProfileRelPath(resolvedRelPath)) return null;
        return { absPath: targetReal, relPath: `${SANDBOX_HOME_MOUNT}/${resolvedRelPath}` };
      }
      return null;
    } catch {
      return null;
    }
  }

  if (candidate.startsWith('~/')) {
    return resolveFromChatHome() ?? resolveFromHome();
  }

  const inHome = resolveFromHome();
  if (inHome) return inHome;

  if (homePrefix === SANDBOX_HOME_MOUNT) {
    return resolveFromChatHome();
  }

  return null;
}

/** Resolve a stored artifact for every file endpoint, using the same chat boundary as link resolution. */
export function resolveArtifactFile(db: AppDatabase, chat: ChatRecord, artifact: Pick<ArtifactRecord, 'relPath'>): ResolvedChatFile | null {
  return resolveChatFile(db, chat, artifact.relPath);
}

function buildArtifactUrls(artifact: ArtifactRecord): { previewUrl: string; downloadUrl: string } {
  const versionSuffix = artifact.sha256 ? `?v=${artifact.sha256.slice(0, 12)}` : '';
  return {
    previewUrl: `/api/files/${artifact.id}/content${versionSuffix}`,
    downloadUrl: `/api/files/${artifact.id}/content?download=1`,
  };
}

export function resolveAuthorizedChatFileReference(params: {
  db: AppDatabase;
  userId: string;
  chatId: string;
  reference: string;
  label?: string;
  mimeType?: string | null;
  messageId?: string;
  runId?: string;
}): ResolvedWorkspaceLink | null {
  const { db, userId, chatId } = params;
  const chat = db.getChat(userId, chatId);
  if (!chat) return null;
  const candidate = normalizeLinkCandidatePath(params.reference);
  if (!candidate || candidate === SANDBOX_WORKSPACE_MOUNT) return null;

  const register = (file: ResolvedChatFile | null): ResolvedWorkspaceLink | null => {
    if (!file) return null;
    try {
      const { absPath, relPath } = file;
      const stat = fs.statSync(absPath);
      const existing = db.findArtifactByRelPath(userId, chatId, relPath);
      const filename = existing?.source === 'attachment'
        ? existing.filename : params.label ?? existing?.filename ?? path.basename(relPath);
      const { mimeType, previewKind } = params.mimeType && existing?.source !== 'attachment'
        ? detectContentFileType(filename, params.mimeType)
        : existing ?? detectMimeAndPreviewKind(path.basename(relPath));
      const mtimeChanged = !existing || Math.floor(stat.mtimeMs) > existing.updatedAt;
      const sha256 = path.isAbsolute(relPath) || mtimeChanged || stat.size !== existing?.sizeBytes || stat.size <= 512 * 1024
        ? sha256File(absPath) : existing.sha256;
      const artifact = existing && !mtimeChanged && existing.sha256 === sha256 &&
        existing.sizeBytes === stat.size && existing.filename === filename &&
        existing.mimeType === mimeType && existing.previewKind === previewKind &&
        (!params.messageId || existing.messageId === params.messageId)
        ? existing
        : db.upsertArtifact({
          id: existing?.id ?? crypto.randomUUID(),
          userId, chatId,
          messageId: params.messageId ?? existing?.messageId ?? null,
          runId: params.runId ?? existing?.runId ?? null,
          relPath, filename, mimeType,
          sizeBytes: stat.size, sha256,
          source: existing?.source ?? (relPath.startsWith('.project-context/') ? 'project_copy' : 'generated'),
          previewKind, diffPatch: null, minUpdatedAt: stat.mtimeMs,
        });
      return { artifact, ...buildArtifactUrls(artifact) };
    } catch {
      return null;
    }
  };

  const byId = db.getArtifact(userId, candidate);
  if (byId?.chatId === chatId) return register(resolveArtifactFile(db, chat, byId));

  const exact = resolveChatFile(db, chat, candidate);
  if (exact) return register(exact);

  if (!/^file:\/\//i.test(params.reference.trim()) && /%[a-f0-9]{2}/i.test(candidate)) {
    try {
      const decoded = resolveChatFile(db, chat, decodeURIComponent(candidate));
      if (decoded) return register(decoded);
    } catch {
      // A literal percent sign is valid in a raw path.
    }
  }

  const workspaceRelative = workspaceRelativePath(candidate);
  // Older chunk-by-chunk rewriting produced generated//brain/<session>/<filename>.
  // Exact workspace paths win. A collision copy only makes recovery ambiguous
  // when it contains different bytes from the original filename.
  const legacy = /^generated\/\/brain\/[^/.][^/]*\/([^/]+)$/.exec(workspaceRelative);
  if (legacy && legacy[1] !== '.' && legacy[1] !== '..') {
    const native = resolveChatFile(db, chat, `${SANDBOX_HOME_MOUNT}/.gemini/brain/${legacy[0].slice('generated//brain/'.length)}`);
    if (native) return register(native);
    const filename = legacy[1];
    const ext = path.extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    try {
      const relPath = `generated/${filename}`;
      const original = resolveContainedExistingPath(chat.workspaceDir, relPath);
      const originalStat = fs.statSync(original.absPath);
      const generated = resolveContainedExistingPath(chat.workspaceDir, 'generated');
      if (originalStat.isFile()) {
        let originalHash: string | undefined;
        const hasCollision = fs.readdirSync(generated.absPath, { withFileTypes: true }).some((entry) => {
          const name = entry.name;
          if (!entry.isFile() || !name.startsWith(`${stem}-`) || !name.endsWith(ext) ||
            !/^[a-f0-9]{8}$/.test(name.slice(stem.length + 1, ext ? -ext.length : undefined))) return false;

          const copy = resolveContainedExistingPath(generated.absPath, name);
          if (fs.statSync(copy.absPath).size !== originalStat.size) return true;
          originalHash ??= sha256File(original.absPath);
          return sha256File(copy.absPath) !== originalHash;
        });
        if (!hasCollision) return register(resolveChatFile(db, chat, relPath));
      }
    } catch {
      // No legacy workspace file to recover.
    }
  }

  return null;
}
