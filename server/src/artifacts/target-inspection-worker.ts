import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import type { PreviewKind } from '../types.js';
import { fingerprintsMatch, openContainedRegularFileNoFollow, readContainedRegularFileNoFollowStable } from '../files/workspace.js';
import { sha256Buffer, sha256Text, splitLines } from './adapters/base.js';
import { FormatAdapterRegistry } from './adapters/registry.js';
import { ArtifactError } from './errors.js';
import type { TargetSelector } from './types.js';

interface Snapshot {
  path: string;
  sha256: string;
  sizeBytes: number;
}

interface FileMeta {
  filename: string;
  relPath: string;
  mimeType: string;
  previewKind: PreviewKind;
}

export type InspectionJob = { file: FileMeta; maxBytes?: number } & (
  | { range: Record<string, unknown>; snapshot: Snapshot }
  | { selector: TargetSelector; rootDir: string; snippetHint?: string; baseSnapshot?: Snapshot }
);

function readSnapshot(snapshot: Snapshot, maxBytes?: number) {
  if (maxBytes !== undefined && snapshot.sizeBytes > maxBytes) {
    throw new ArtifactError('DOC_WORKER_INPUT_TOO_LARGE', 'Document input exceeds the worker size limit.', 413);
  }
  const fd = fs.openSync(snapshot.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isFile() && stat.size === snapshot.sizeBytes) {
      const bytes = fs.readFileSync(fd);
      if (bytes.length === snapshot.sizeBytes && sha256Buffer(bytes) === snapshot.sha256) return bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
  throw new ArtifactError('REVISION_SNAPSHOT_UNAVAILABLE', 'Revision snapshot failed integrity verification.', 422);
}

function inspect(job: InspectionJob) {
  const adapter = new FormatAdapterRegistry().resolve(job.file.filename, job.file.previewKind);
  if ('range' in job) return adapter.readRange(readSnapshot(job.snapshot, job.maxBytes), job.range, job.file);

  let source: ReturnType<typeof readContainedRegularFileNoFollowStable>;
  try {
    source = readContainedRegularFileNoFollowStable(job.rootDir, job.file.relPath, { maxBytes: job.maxBytes });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'stale', reason: 'artifact_file_missing' };
    return { status: 'needs_review', reason: 'target_content_unavailable' };
  }
  let snippetHint = job.snippetHint;
  const { startLine, endLine, kind } = job.selector;
  if (job.baseSnapshot && (snippetHint === undefined || sha256Text(snippetHint) !== job.selector.expectedSnippetHash) && (kind === 'code_line_range' || kind === 'md_text_range') &&
      typeof startLine === 'number' && typeof endLine === 'number' &&
      Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && startLine > 0 && endLine >= startLine) {
    try {
      const base = readSnapshot(job.baseSnapshot, job.maxBytes);
      snippetHint = splitLines(base.toString('utf8')).slice(startLine - 1, endLine).join('\n');
    } catch {
      // The resolver can still use an independently hash-verified snapshot or current match.
    }
  }
  const result = adapter.resolveTarget(source.buffer, job.selector, { ...job.file, snippetHint });
  if (result.status === 'resolved') {
    try {
      const latest = openContainedRegularFileNoFollow(job.rootDir, job.file.relPath);
      try {
        if (fingerprintsMatch(source.fingerprint, latest.fingerprint)) return result;
      } finally {
        fs.closeSync(latest.fd);
      }
    } catch {
      // A result derived from a file we can no longer verify must be reviewed.
    }
    return { status: 'needs_review', reason: 'file_changed_during_resolution' };
  }
  return result;
}

try {
  parentPort!.postMessage({ result: inspect(workerData as InspectionJob) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof ArtifactError
    ? { code: error.code, message: error.message, statusCode: error.statusCode, details: error.details }
    : { code: 'TARGET_INSPECTION_FAILED', message: '対象の構造を読み取れません。', statusCode: 422 } });
}
