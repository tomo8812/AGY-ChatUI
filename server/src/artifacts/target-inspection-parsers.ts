import fs from 'node:fs';
import { inspectMediaMetadata, inspectVideoMetadata } from './adapters/media-target.js';
import { MAX_INSPECTION_OUTPUT_BYTES } from './target-inspection-limits.js';
import type { PreviewKind } from '../types.js';
import { fingerprintsMatch, openContainedRegularFileNoFollow, readContainedRegularFileNoFollowStable } from '../files/workspace.js';
import { createLineMatcher, createSourceCharMatcher, sourceCharSlice, sourceRangeContext, sha256Buffer, sha256Text, splitLines } from './adapters/base.js';
import { xlsxGridTargetIsUnique } from './adapters/ooxml-target.js';
import { CsvAdapter } from './adapters/csv-adapter.js';
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
  sizeBytes?: number;
}

export type InspectionJob = { file: FileMeta; maxBytes?: number } & (
  | { range: Record<string, unknown>; snapshot: Snapshot }
  | { selector: TargetSelector; rootDir: string; expectedSha256: string; snippetHint?: string; baseSnapshot?: Snapshot }
);

function readSnapshot(snapshot: Snapshot, maxBytes?: number) {
  if (!Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 0 ||
      (maxBytes !== undefined && snapshot.sizeBytes > maxBytes)) {
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
  const { startCol, endCol } = range;
  const hasColumns = startCol !== undefined || endCol !== undefined;
  if (hasColumns) {
    if (typeof startCol !== 'number' || !Number.isSafeInteger(startCol) || startCol < 1 ||
        typeof endCol !== 'number' || !Number.isSafeInteger(endCol) || endCol < 1 ||
        (startLine === endLine && startCol >= endCol)) {
      throw new ArtifactError('INVALID_INPUT', '選択範囲が存在しません。', 400);
    }
    const first = sourceCharSlice(selected[0], startCol - 1, selected.length === 1 ? endCol - 1 : undefined);
    const last = selected.length === 1 ? first : sourceCharSlice(selected.at(-1)!, 0, endCol - 1);
    if (first === undefined || last === undefined) throw new ArtifactError('INVALID_INPUT', '選択範囲が存在しません。', 400);
    selected[0] = first;
    selected[selected.length - 1] = last;
  }
  const text = selected.join('\n');
  const { before, after } = sourceRangeContext(lines, startLine - 1, selected.length,
    typeof startCol === 'number' ? startCol : undefined, typeof endCol === 'number' ? endCol : undefined);
  const matches = createLineMatcher(selected);
  const matchChars = hasColumns ? createSourceCharMatcher(selected, Number(startCol) - 1, Number(endCol) - 1) : null;
  let occurrenceIndex = 0;
  let duplicateCount = 0;
  for (let i = 0; i < (matchChars ? lines.length - selected.length + 1 : lines.length); i++) {
    if (!(matchChars ? matchChars(lines, i) : matches(lines[i]))) continue;
    if (matchChars ? i + 1 === startLine : i + 1 === endLine) occurrenceIndex = duplicateCount;
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
  const maxBytes = job.maxBytes;
  const adapter = new FormatAdapterRegistry().resolve(job.file.filename, job.file.previewKind);
  if ('range' in job) {
    const bytes = readSnapshot(job.snapshot, maxBytes);
    if (job.range.sourceTarget === true && ['code', 'markdown', 'html', 'svg', 'mermaid', 'diff'].includes(adapter.format)) {
      return describeSourceTarget(bytes, job.range);
    }
    if (adapter.format === 'media' && job.range.mediaStructure === true) {
      const video = job.file.previewKind === 'video' ? await inspectVideoMetadata(bytes) : null;
      return {
        format: 'media',
        filename: job.file.filename,
        sizeBytes: bytes.length,
        ...(video ?? await inspectMediaMetadata(bytes, job.file.filename, job.file.mimeType)),
      };
    }
    return adapter.readRange(bytes, job.range, job.file);
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
  if (job.baseSnapshot && (snippetHint === undefined || sha256Text(snippetHint) !== job.selector.expectedSnippetHash) &&
      (kind === 'code_line_range' || kind === 'code_char_range' || kind === 'md_text_range' ||
       kind === 'html_source_range' || kind === 'mermaid_source_range') &&
      typeof startLine === 'number' && typeof endLine === 'number' &&
      Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && startLine > 0 && endLine >= startLine) {
    try {
      const base = readSnapshot(job.baseSnapshot, maxBytes);
      snippetHint = describeSourceTarget(base, job.selector).text;
    } catch {
      // The resolver can still use an independently hash-verified snapshot or current match.
    }
  }
  const video = adapter.format === 'media' && job.file.previewKind === 'video'
    ? await inspectVideoMetadata(source.buffer) : null;
  const media = adapter.format === 'media' && !video
    ? await inspectMediaMetadata(source.buffer, job.file.filename, job.file.mimeType) : video;
  const selector = job.selector;
  const isGridTarget = ['csv_range', 'csv_row_col', 'xlsx_range', 'xlsx_row_col'].includes(selector.kind);
  let baseGrid: Buffer | undefined;
  if (isGridTarget && job.baseSnapshot) {
    try {
      baseGrid = job.baseSnapshot.sha256 === source.sha256 ? source.buffer : readSnapshot(job.baseSnapshot, maxBytes);
    } catch {
      return { status: 'needs_review', reason: 'base_revision_content_unavailable' };
    }
  }
  const result = adapter.resolveTarget(source.buffer, selector, {
    ...job.file, snippetHint, mediaDurationSeconds: media?.durationSeconds,
  });
  if (result.status === 'resolved') {
    if (baseGrid && baseGrid !== source.buffer) {
      const original = adapter.resolveTarget(baseGrid, selector, job.file);
      if (original.status !== 'resolved') return { status: 'needs_review', reason: 'base_revision_target_unverified' };
      const archivedContext = adapter instanceof CsvAdapter
        ? adapter.targetContextHash(baseGrid, selector, job.file) : original.resolvedRange?.targetContextHash;
      const currentContext = adapter instanceof CsvAdapter
        ? adapter.targetContextHash(source.buffer, selector, job.file) : result.resolvedRange?.targetContextHash;
      const sameContext = typeof archivedContext === 'string' && archivedContext === currentContext;
      if (!sameContext) return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
      if (selector.kind === 'xlsx_range' || selector.kind === 'xlsx_row_col') {
        const grid = {
          sheetId: String(selector.sheetId),
          ...(selector.kind === 'xlsx_range' ? { rangeA1: String(selector.rangeA1) } :
            { axis: selector.axis === 'row' ? 'row' as const : 'col' as const, start: Number(selector.start), end: Number(selector.end) }),
        };
        try {
          if (!xlsxGridTargetIsUnique(baseGrid, grid) || !xlsxGridTargetIsUnique(source.buffer, grid)) {
            return { status: 'needs_review', reason: 'ambiguous_multiple_matches' };
          }
        } catch {
          return { status: 'needs_review', reason: 'target_context_could_not_be_verified' };
        }
      }
    }
    try {
      const latest = openContainedRegularFileNoFollow(job.rootDir, job.file.relPath);
      try {
        if (fingerprintsMatch(source.fingerprint, latest.fingerprint)) {
          return result;
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

if (process.send) process.once('message', async (job: InspectionJob) => {
  let response: InspectionResponse;
  try {
    const result = await inspect(job);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_INSPECTION_OUTPUT_BYTES) {
      throw new ArtifactError('TARGET_INSPECTION_OUTPUT_LIMIT', '対象の解析結果が上限を超えました。', 413);
    }
    response = { result };
  } catch (error) {
    response = { error: error instanceof ArtifactError
      ? { code: error.code, message: error.message, statusCode: error.statusCode, details: error.details }
      : { code: 'TARGET_INSPECTION_FAILED', message: '対象の構造を読み取れません。', statusCode: 422 } };
  }
  process.send!(response, () => process.disconnect());
});
