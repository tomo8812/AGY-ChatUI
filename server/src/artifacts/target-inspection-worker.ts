import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import type { PreviewKind } from '../types.js';
import { fingerprintsMatch, openContainedRegularFileNoFollow, readContainedRegularFileNoFollowStable } from '../files/workspace.js';
import { createLineMatcher, sha256Buffer, sha256Text, splitLines } from './adapters/base.js';
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
  | { selector: TargetSelector; rootDir: string; expectedSha256: string; snippetHint?: string; baseSnapshot?: Snapshot }
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

function describeSourceTarget(bytes: Buffer, range: Record<string, unknown>) {
  const { startLine, endLine } = range;
  if (typeof startLine !== 'number' || typeof endLine !== 'number' ||
      !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new ArtifactError('INVALID_INPUT', '選択範囲が存在しません。', 400);
  }
  const lines = splitLines(bytes.toString('utf8'));
  if (endLine > lines.length) throw new ArtifactError('INVALID_INPUT', '選択範囲が存在しません。', 400);
  const selected = lines.slice(startLine - 1, endLine);
  const text = selected.join('\n');
  const before = lines.slice(Math.max(0, startLine - 3), startLine - 1).join('\n');
  const after = lines.slice(endLine, endLine + 2).join('\n');
  const matches = createLineMatcher(selected);
  let occurrenceIndex = 0;
  let duplicateCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!matches(lines[i])) continue;
    if (i + 1 === endLine) occurrenceIndex = duplicateCount;
    duplicateCount++;
  }
  // Excerpts share the existing source range response budget. All selected
  // lines still participate in the hashes and in the occurrence calculation.
  const maxExcerpt = 512 * 1024;
  return {
    startLine, endLine, text: text.slice(0, maxExcerpt),
    before: before.slice(-maxExcerpt), after: after.slice(0, maxExcerpt),
    expectedSnippetHash: sha256Text(text), contextBeforeHash: sha256Text(before), contextAfterHash: sha256Text(after),
    occurrenceIndex, duplicateCount,
  };
}

function inspect(job: InspectionJob) {
  const adapter = new FormatAdapterRegistry().resolve(job.file.filename, job.file.previewKind);
  if ('range' in job) {
    const bytes = readSnapshot(job.snapshot, job.maxBytes);
    return job.range.sourceTarget === true && ['code', 'markdown', 'html', 'svg', 'mermaid', 'diff'].includes(adapter.format)
      ? describeSourceTarget(bytes, job.range)
      : adapter.readRange(bytes, job.range, job.file);
  }

  let source: ReturnType<typeof readContainedRegularFileNoFollowStable>;
  try {
    source = readContainedRegularFileNoFollowStable(job.rootDir, job.file.relPath, { maxBytes: job.maxBytes });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'stale', reason: 'artifact_file_missing' };
    return { status: 'needs_review', reason: 'target_content_unavailable' };
  }
  if (source.sha256 !== job.expectedSha256) return { status: 'needs_review', reason: 'revision_content_changed' };
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
  if (result.status === 'resolved' || result.reason === 'image_region_unconfirmed' || result.reason === 'media_duration_unconfirmed') {
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
