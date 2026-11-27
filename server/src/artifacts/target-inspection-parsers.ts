import { parentPort, workerData } from 'node:worker_threads';
import { inspectMediaMetadata, inspectVideoTarget } from './adapters/media-target.js';
import { inspectPdfText } from './adapters/pdf-text-inspection.js';
import fs from 'node:fs';
import { MAX_INSPECTION_INPUT_BYTES, MAX_INSPECTION_OUTPUT_BYTES } from './target-inspection-limits.js';
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

function readSnapshot(snapshot: Snapshot, maxBytes: number) {
  if (!Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 0 || snapshot.sizeBytes > maxBytes) {
    throw new ArtifactError('DOC_WORKER_INPUT_TOO_LARGE', 'Document input exceeds the worker size limit.', 413);
  }
  const fd = fs.openSync(snapshot.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isFile() && stat.size === snapshot.sizeBytes) {
      const bytes = Buffer.allocUnsafe(snapshot.sizeBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      if (offset === snapshot.sizeBytes && fs.fstatSync(fd).size === snapshot.sizeBytes &&
          sha256Buffer(bytes) === snapshot.sha256) return bytes;
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

async function inspect(job: InspectionJob) {
  const maxBytes = Math.min(job.maxBytes ?? MAX_INSPECTION_INPUT_BYTES, MAX_INSPECTION_INPUT_BYTES);
  const adapter = new FormatAdapterRegistry().resolve(job.file.filename, job.file.previewKind);
  if ('range' in job) {
    const bytes = readSnapshot(job.snapshot, maxBytes);
    if (job.range.sourceTarget === true && ['code', 'markdown', 'html', 'svg', 'mermaid', 'diff'].includes(adapter.format)) {
      return describeSourceTarget(bytes, job.range);
    }
    if (adapter.format === 'media' && job.range.mediaStructure === true) {
      const timestamp = job.range.timestampSec === undefined ? undefined : Number(job.range.timestampSec);
      const video = job.file.previewKind === 'video' ? await inspectVideoTarget(bytes, job.snapshot.sha256, timestamp) : null;
      if (timestamp !== undefined && job.file.previewKind === 'video') {
        const frame = video?.frame;
        return { target: frame ? {
          timestampSec: timestamp, expectedDurationSec: frame.expectedDurationSec, expectedWidthPx: frame.expectedWidthPx,
          expectedHeightPx: frame.expectedHeightPx, expectedFrameSha256: frame.expectedFrameSha256,
        } : null };
      }
      return { format: 'media', filename: job.file.filename, sizeBytes: bytes.length,
        ...(video ?? await inspectMediaMetadata(bytes, job.file.filename, job.file.mimeType)) };
    }
    const info = adapter.readRange(bytes, job.range, job.file);
    if (adapter.format === 'pdf' && (job.range.textTarget === true || job.range.textTarget === 'true') && info.target && typeof info.target === 'object') {
      const start = Number(job.range.textOffsetStart), end = Number(job.range.textOffsetEnd);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return { target: null };
      const layout = await inspectPdfText(bytes, Number(job.range.pageIndex), start, end);
      const quadsPt = layout?.quadsForRange(start, end);
      return { target: layout && quadsPt ? { ...info.target, text: layout.text, quadsPt } : null };
    }
    return info;
  }

  let source: ReturnType<typeof readContainedRegularFileNoFollowStable>;
  try {
    source = readContainedRegularFileNoFollowStable(job.rootDir, job.file.relPath, { maxBytes });
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
      const base = readSnapshot(job.baseSnapshot, maxBytes);
      snippetHint = splitLines(base.toString('utf8')).slice(startLine - 1, endLine).join('\n');
    } catch {
      // The resolver can still use an independently hash-verified snapshot or current match.
    }
  }
  const pdfTextLayout = job.selector.kind === 'pdf_text_range'
    ? await inspectPdfText(source.buffer, Number(job.selector.pageIndex), Number(job.selector.textOffsetStart), Number(job.selector.textOffsetEnd))
    : undefined;
  const video = job.file.previewKind === 'video'
    ? await inspectVideoTarget(source.buffer, source.sha256, job.selector.kind === 'video_frame_region' ? Number(job.selector.timestampSec) : undefined)
    : null;
  const media = adapter.format === 'media' && !video
    ? await inspectMediaMetadata(source.buffer, job.file.filename, job.file.mimeType) : video;
  let selector = job.selector;
  if (selector.kind === 'csv_row_col' && selector.expectedHeaderHash === undefined) {
    if (!job.baseSnapshot) return { status: 'needs_review', reason: 'base_revision_content_unavailable' };
    try {
      const base = job.baseSnapshot.sha256 === source.sha256 ? source.buffer : readSnapshot(job.baseSnapshot, maxBytes);
      const { headerHash } = adapter.getStructure(base, job.file);
      if (typeof headerHash !== 'string') return { status: 'needs_review', reason: 'base_revision_target_unverified' };
      selector = { ...selector, expectedHeaderHash: headerHash };
      if (adapter.resolveTarget(base, selector, job.file).status !== 'resolved') {
        return { status: 'needs_review', reason: 'base_revision_target_unverified' };
      }
    } catch {
      return { status: 'needs_review', reason: 'base_revision_content_unavailable' };
    }
  }
  const result = adapter.resolveTarget(source.buffer, selector, {
    ...job.file, snippetHint, pdfTextLayout, mediaDurationSeconds: media?.durationSeconds, videoFrame: video?.frame,
  });
  if (result.status === 'resolved') {
    try {
      const latest = openContainedRegularFileNoFollow(job.rootDir, job.file.relPath);
      try {
        if (fingerprintsMatch(source.fingerprint, latest.fingerprint)) {
          return selector !== job.selector
            ? { ...result, resolvedRange: { ...result.resolvedRange, expectedHeaderHash: selector.expectedHeaderHash } }
            : result;
        }
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


export type InspectionResponse = { result: unknown } |
  { error: { code: string; message: string; statusCode: number; details?: Record<string, unknown> } };

if (parentPort) {
  let response: InspectionResponse;
  try {
    const result = await inspect(workerData as InspectionJob);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_INSPECTION_OUTPUT_BYTES) {
      throw new ArtifactError('TARGET_INSPECTION_OUTPUT_LIMIT', '対象の解析結果が上限を超えました。', 413);
    }
    response = { result };
  } catch (error) {
    response = { error: error instanceof ArtifactError
      ? { code: error.code, message: error.message, statusCode: error.statusCode, details: error.details }
      : { code: 'TARGET_INSPECTION_FAILED', message: '対象の構造を読み取れません。', statusCode: 422 } };
  }
  parentPort.postMessage(response);
  parentPort.close();
}
