import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import type { AppDatabase } from '../db/database.js';
import type { ArtifactRecord } from '../types.js';
import { detectMimeAndPreviewKind, resolveContainedExistingPath, sha256File } from './workspace.js';

const execFileAsync = promisify(execFile);

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
        snapshot.set(rel, {
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: sha256File(real),
          textSample: maybeReadUtf8Sample(real, stat.size),
        });
      }
    }
  };
  walk(rootReal);
  return snapshot;
}

export function syncWorkspaceChangesAsArtifacts(params: {
  db: AppDatabase;
  userId: string;
  chatId: string;
  workspaceDir: string;
  messageId: string | null;
  runId: string | null;
  before: WorkspaceSnapshot;
  hintPaths?: string[];
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
    if (isInitialProjectCopy && !changed && !hintSet.has(relPath)) {
      continue;
    }

    const absPath = path.join(rootReal, relPath);
    const filename = path.basename(relPath);
    const { mimeType, previewKind } = detectMimeAndPreviewKind(filename);
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

    const record = params.db.upsertArtifact({
      id: crypto.randomUUID(),
      userId: params.userId,
      chatId: params.chatId,
      messageId: params.messageId,
      runId: params.runId,
      relPath,
      filename,
      mimeType,
      sizeBytes: after.sizeBytes,
      sha256: after.sha256,
      source: isInitialProjectCopy && !changed ? 'project_copy' : 'generated',
      previewKind,
      diffPatch,
    });
    registered.push(record);
  }
  return registered;
}

export async function convertPresentationToPdfCached(params: {
  libreOfficeBin: string;
  cacheRoot: string;
  sourceAbsPath: string;
  sourceSha256: string;
}): Promise<string | null> {
  const outDir = path.join(params.cacheRoot, params.sourceSha256);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const base = path.basename(params.sourceAbsPath, path.extname(params.sourceAbsPath));
  const expectedPdf = path.join(outDir, `${base}.pdf`);
  if (fs.existsSync(expectedPdf)) {
    return expectedPdf;
  }

  try {
    await execFileAsync(
      params.libreOfficeBin,
      ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, params.sourceAbsPath],
      { timeout: 30_000 }
    );
    if (fs.existsSync(expectedPdf)) {
      return expectedPdf;
    }
    const found = fs.readdirSync(outDir).find((f) => f.toLowerCase().endsWith('.pdf'));
    return found ? path.join(outDir, found) : null;
  } catch {
    return null;
  }
}
