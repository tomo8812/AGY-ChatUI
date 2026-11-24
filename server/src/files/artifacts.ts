import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { ArtifactService } from '../artifacts/artifact-service.js';
import type { AppDatabase } from '../db/database.js';
import type { ArtifactRecord } from '../types.js';
import { detectMimeAndPreviewKind, resolveContainedExistingPath, sha256File } from './workspace.js';

export interface FileSnapshotItem {
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  textSample: string | null;
}

export type WorkspaceSnapshot = Map<string, FileSnapshotItem>;

const MAX_DIFF_TEXT_BYTES = 256 * 1024;

function maybeReadUtf8Sample(absPath: string, sizeBytes: number): string | null {
  if (sizeBytes > MAX_DIFF_TEXT_BYTES) return null;
  try {
    const buf = fs.readFileSync(absPath);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

export function captureWorkspaceSnapshot(workspaceDir: string): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = new Map();
  if (!fs.existsSync(workspaceDir)) return snapshot;
  const rootReal = fs.realpathSync(workspaceDir);

  const walk = (dir: string, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (prefix === '' && (entry.name === '.agents' || entry.name === '.agent')) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const real = fs.realpathSync(full);
      if (!real.startsWith(rootReal + path.sep)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(real, rel);
      } else if (entry.isFile()) {
        const stat = fs.statSync(real);
        let sha256: string;
        try {
          sha256 = sha256File(real);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EACCES' || code === 'EPERM') continue;
          throw err;
        }
        snapshot.set(rel, {
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256,
          textSample: maybeReadUtf8Sample(real, stat.size),
        });
      }
    }
  };
  walk(rootReal);
  return snapshot;
}

export function syncWorkspaceChangesAsArtifacts(params: {
  artifactService: ArtifactService;
  db: AppDatabase;
  userId: string;
  chatId: string;
  workspaceDir: string;
  messageId: string | null;
  runId: string | null;
  before: WorkspaceSnapshot;
  hintPaths?: string[];
  skipIfAlreadyOwnedByOtherMessage?: boolean;
}): ArtifactRecord[] {
  const registered: ArtifactRecord[] = [];
  if (!fs.existsSync(params.workspaceDir)) return registered;
  const rootReal = fs.realpathSync(params.workspaceDir);
  const hintSet = new Set<string>();
  for (const p of params.hintPaths ?? []) {
    try {
      const resolved = resolveContainedExistingPath(rootReal, p);
      hintSet.add(resolved.relPath);
    } catch {
      // ignore out-of-workspace hints
    }
  }

  const currentMap = captureWorkspaceSnapshot(rootReal);
  for (const [relPath, after] of currentMap.entries()) {
    const prev = params.before.get(relPath);
    const changed = !prev || prev.sha256 !== after.sha256;
    const isInitialProjectCopy = relPath.startsWith('.project-context/');
    if (!changed && !hintSet.has(relPath)) {
      continue;
    }
    const existing = params.db.findArtifactByRelPath(params.userId, params.chatId, relPath);
    if (
      params.skipIfAlreadyOwnedByOtherMessage &&
      !hintSet.has(relPath) &&
      existing?.messageId &&
      existing.messageId !== params.messageId &&
      existing.sha256 === after.sha256
    ) {
      continue;
    }

    const filename = existing?.filename ?? path.basename(relPath);
    const { mimeType, previewKind } = existing ?? detectMimeAndPreviewKind(filename);
    let diffPatch: string | null = null;
    if (changed && after.textSample !== null && (!prev || prev.textSample !== null)) {
      diffPatch = createTwoFilesPatch(
        `a/${relPath}`,
        `b/${relPath}`,
        prev?.textSample ?? '',
        after.textSample,
        undefined,
        undefined,
        { context: 3 }
      );
    }

    const { artifact } = params.artifactService.ingestWorkspaceFile({
      userId: params.userId,
      chatId: params.chatId,
      workspaceDir: rootReal,
      relPath,
      filename,
      mimeType,
      previewKind,
      source: isInitialProjectCopy && !changed ? 'project_copy' : 'generated',
      messageId: params.messageId,
      runId: params.runId,
      diffPatch,
      emitEvent: false,
    });
    registered.push(artifact);
  }
  return registered;
}

export async function convertPresentationToPdfCached(params: {
  artifactService: ArtifactService;
  artifactId: string;
  revision: number;
  sourceAbsPath: string;
  sourceSha256: string;
  dependencyManifestHash?: string | null;
}): Promise<string | null> {
  return params.artifactService.renderCache.renderPresentationToPdf({
    artifactId: params.artifactId,
    revision: params.revision,
    sourceAbsPath: params.sourceAbsPath,
    sourceSha256: params.sourceSha256,
    dependencyManifestHash: params.dependencyManifestHash ?? null,
  });
}
