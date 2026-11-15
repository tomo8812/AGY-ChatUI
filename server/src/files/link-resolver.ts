import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppDatabase } from '../db/database.js';
import type { ArtifactRecord } from '../types.js';
import {
  detectMimeAndPreviewKind,
  resolveContainedExistingPath,
  sha256File,
} from './workspace.js';

export interface ResolvedWorkspaceLink {
  artifact: ArtifactRecord;
  previewUrl: string;
  downloadUrl: string;
}

/**
 * Resolves a model-mentioned file reference (relative path, workspace-scoped absolute path,
 * or artifact ID) strictly inside the authorized user's chat workspace.
 * Never resolves files outside `(userId, chatId)` or non-existent paths.
 */
export function resolveAuthorizedChatFileReference(params: {
  db: AppDatabase;
  userId: string;
  chatId: string;
  reference: string;
}): ResolvedWorkspaceLink | null {
  const chat = params.db.getChat(params.userId, params.chatId);
  if (!chat) return null;

  const raw = params.reference.trim();
  if (!raw || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('mailto:')) {
    return null;
  }

  // Handle file:// URI safely
  let candidate = raw;
  if (candidate.startsWith('file://')) {
    try {
      const parsed = new URL(candidate);
      candidate = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  }
  // Strip optional line suffix (e.g. path/to/file.ts#L10 or path/to/file.ts:10)
  candidate = candidate.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');

  // Check by artifact ID first (must match both userId and chatId!)
  const byId = params.db.getArtifact(params.userId, candidate);
  if (byId && byId.chatId === params.chatId) {
    try {
      resolveContainedExistingPath(chat.workspaceDir, byId.relPath);
      return {
        artifact: byId,
        previewUrl: `/api/files/${byId.id}/content`,
        downloadUrl: `/api/files/${byId.id}/content?download=1`,
      };
    } catch {
      return null;
    }
  }

  // Otherwise resolve strictly inside chat.workspaceDir
  try {
    const { absPath, relPath } = resolveContainedExistingPath(chat.workspaceDir, candidate);
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;

    let artifact = params.db.findArtifactByRelPath(params.userId, params.chatId, relPath);
    if (!artifact) {
      const filename = path.basename(relPath);
      const { mimeType, previewKind } = detectMimeAndPreviewKind(filename);
      artifact = params.db.upsertArtifact({
        id: crypto.randomUUID(),
        userId: params.userId,
        chatId: params.chatId,
        messageId: null,
        runId: null,
        relPath,
        filename,
        mimeType,
        sizeBytes: stat.size,
        sha256: sha256File(absPath),
        source: relPath.startsWith('.project-context/') ? 'project_copy' : 'generated',
        previewKind,
        diffPatch: null,
      });
    }

    return {
      artifact,
      previewUrl: `/api/files/${artifact.id}/content`,
      downloadUrl: `/api/files/${artifact.id}/content?download=1`,
    };
  } catch {
    return null;
  }
}
