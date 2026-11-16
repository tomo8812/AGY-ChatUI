import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SANDBOX_WORKSPACE_MOUNT } from '../acp/env-isolation.js';
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
] as const;

export function getAllowedBrainRoots(profileDir: string): string[] {
  return ALLOWED_BRAIN_ROOT_REL_PATHS.map((rel) => path.resolve(profileDir, rel));
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
      candidate = decodeURIComponent(parsed.pathname);
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

  for (const brainRoot of getAllowedBrainRoots(params.profileDir)) {
    if (!fs.existsSync(brainRoot)) continue;
    let brainReal: string;
    try {
      brainReal = fs.realpathSync(brainRoot);
    } catch {
      continue;
    }
    try {
      const resolved = resolveContainedExistingPath(brainReal, normalized);
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
  return null;
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
  const regex = /(?:file:\/\/\/|\/|~\/)[^\s"'`<>)\]」』】》〉、。]+/g;
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

  // Check by artifact ID first (must match both userId and chatId!)
  const byId = params.db.getArtifact(params.userId, candidate);
  if (byId && byId.chatId === params.chatId) {
    try {
      const { absPath } = resolveContainedExistingPath(chat.workspaceDir, byId.relPath);
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) return null;
      let current = byId;
      const shouldVerify =
        stat.size !== byId.sizeBytes ||
        Math.floor(stat.mtimeMs) > byId.updatedAt ||
        stat.size <= 512 * 1024;
      if (shouldVerify) {
        const nextSha = sha256File(absPath);
        if (
          nextSha !== byId.sha256 ||
          stat.size !== byId.sizeBytes ||
          Math.floor(stat.mtimeMs) > byId.updatedAt
        ) {
          current = params.db.upsertArtifact({
            id: byId.id,
            userId: byId.userId,
            chatId: byId.chatId,
            messageId: byId.messageId,
            runId: byId.runId,
            relPath: byId.relPath,
            filename: byId.filename,
            mimeType: byId.mimeType,
            sizeBytes: stat.size,
            sha256: nextSha,
            source: byId.source,
            previewKind: byId.previewKind,
            diffPatch: null,
            minUpdatedAt: stat.mtimeMs,
          });
        }
      }
      return {
        artifact: current,
        ...buildArtifactUrls(current),
      };
    } catch {
      return null;
    }
  }

  // Try resolving strictly inside chat.workspaceDir
  try {
    const { absPath, relPath } = resolveContainedExistingPath(chat.workspaceDir, candidate);
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;

    let artifact = params.db.findArtifactByRelPath(params.userId, params.chatId, relPath);
    const shouldHash =
      !artifact ||
      stat.size !== artifact.sizeBytes ||
      Math.floor(stat.mtimeMs) > artifact.updatedAt ||
      stat.size <= 512 * 1024;

    if (shouldHash) {
      const fileSha = sha256File(absPath);
      if (
        !artifact ||
        artifact.sha256 !== fileSha ||
        stat.size !== artifact.sizeBytes ||
        Math.floor(stat.mtimeMs) > artifact.updatedAt
      ) {
        const filename = path.basename(relPath);
        const { mimeType, previewKind } = detectMimeAndPreviewKind(filename);
        artifact = params.db.upsertArtifact({
          id: artifact?.id ?? crypto.randomUUID(),
          userId: params.userId,
          chatId: params.chatId,
          messageId: null,
          runId: null,
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

    return {
      artifact: artifact!,
      ...buildArtifactUrls(artifact!),
    };
  } catch {
    // Fall through to check the user's own Antigravity brain directory
  }

  // Safely resolve artifacts written by Antigravity CLI into this user's own profile brain dir
  const profile = params.db.getAgyProfile(params.userId);
  if (!profile) return null;
  const brainFile = resolveAuthorizedBrainFile({
    profileDir: profile.profileDir,
    candidatePath: candidate,
  });
  if (!brainFile) return null;

  try {
    const imported = importAuthorizedBrainFileToWorkspace({
      workspaceDir: chat.workspaceDir,
      sourceAbsPath: brainFile.absPath,
    });
    const stat = fs.statSync(imported.absPath);
    const filename = path.basename(imported.relPath);
    const { mimeType, previewKind } = detectMimeAndPreviewKind(filename);

    let artifact = params.db.findArtifactByRelPath(params.userId, params.chatId, imported.relPath);
    const fileSha = sha256File(imported.absPath);
    if (
      !artifact ||
      artifact.sha256 !== fileSha ||
      stat.size !== artifact.sizeBytes ||
      Math.floor(stat.mtimeMs) > artifact.updatedAt
    ) {
      artifact = params.db.upsertArtifact({
        id: artifact?.id ?? crypto.randomUUID(),
        userId: params.userId,
        chatId: params.chatId,
        messageId: null,
        runId: null,
        relPath: imported.relPath,
        filename,
        mimeType,
        sizeBytes: stat.size,
        sha256: fileSha,
        source: 'generated',
        previewKind,
        diffPatch: null,
        minUpdatedAt: stat.mtimeMs,
      });
    }

    return {
      artifact,
      ...buildArtifactUrls(artifact),
    };
  } catch {
    return null;
  }
}
