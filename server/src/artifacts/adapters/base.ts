import crypto from 'node:crypto';
import type { PreviewKind } from '../../types.js';
import type {
  AdapterEditResult,
  AdapterExportResult,
  AdapterOperation,
  AdapterVerifyResult,
  ArtifactFormat,
  OperationCapability,
  RuntimeProfile,
  TargetResolutionResult,
  TargetSelector,
} from '../types.js';

export interface AdapterFileMeta {
  filename: string;
  relPath: string;
  mimeType: string;
  snippetHint?: string;
  dependencyManifestTruncated?: boolean;
  dependencies?: Array<{ relPath: string; status: 'present' | 'missing' | 'outside_root' }>;
}

export interface AdapterCapabilityContext {
  runtimeProfile: RuntimeProfile;
  sandboxAvailable: boolean;
  strictSandbox?: boolean;
  filename?: string;
  previewKind?: PreviewKind;
  content?: Buffer;
}

export interface FormatAdapter {
  readonly format: ArtifactFormat;
  readonly previewKind: PreviewKind;
  readonly directEditUiSupported: boolean;
  readonly targetPinSupported: boolean;
  readonly requiresExternalWorker: boolean;

  getOperations(ctx: AdapterCapabilityContext): OperationCapability[];
  create?(params: Record<string, unknown>, meta: AdapterFileMeta): Buffer;
  getStructure(buffer: Buffer, meta: AdapterFileMeta): Record<string, unknown>;
  readRange(buffer: Buffer, range: Record<string, unknown>, meta: AdapterFileMeta): Record<string, unknown>;
  applyOperations(buffer: Buffer, operations: AdapterOperation[], meta: AdapterFileMeta): AdapterEditResult;
  verify(buffer: Buffer, meta: AdapterFileMeta): AdapterVerifyResult;
  exportAs?(buffer: Buffer, targetFormat: string, meta: AdapterFileMeta): AdapterExportResult;
  resolveTarget(buffer: Buffer, selector: TargetSelector, meta: AdapterFileMeta): TargetResolutionResult;
}

export function browserVerifyCapability(ctx: AdapterCapabilityContext): OperationCapability {
  const supported = ctx.runtimeProfile === 'full_runtime' && ctx.strictSandbox === true;
  return {
    operation: 'verify:browser',
    availability: supported ? 'supported' : 'disabled_by_resource_tier',
    scope: 'mcp_only',
    notes: 'Pass selector, elementOffset and maxElements to artifact_verify.',
    ...(supported ? {} : { remediation: 'Enable Full Runtime with bubblewrap.' }),
  };
}

export function editCapabilities(format: string, operations: readonly string[]): OperationCapability[] {
  return operations.map((operation) => ({ operation: `${format}.${operation}`, availability: 'supported', scope: 'mcp_and_ui' }));
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Incremental exact line matching, including overlapping occurrences. */
export function createLineMatcher(pattern: readonly string[]): (line: string) => boolean {
  const prefix = new Uint32Array(pattern.length);
  for (let i = 1, length = 0; i < pattern.length; i++) {
    while (length && pattern[i] !== pattern[length]) length = prefix[length - 1];
    if (pattern[i] === pattern[length]) length++;
    prefix[i] = length;
  }
  let length = 0;
  return line => {
    while (length && line !== pattern[length]) length = prefix[length - 1];
    if (line === pattern[length]) length++;
    if (length !== pattern.length) return false;
    length = prefix[length - 1];
    return true;
  };
}

export function resolveTextSnippetByContext(params: {
  text: string;
  startLine?: unknown;
  endLine?: unknown;
  expectedSnippetHash?: unknown;
  contextBeforeHash?: unknown;
  contextAfterHash?: unknown;
  occurrenceIndex?: unknown;
  requireOccurrenceIndex?: boolean;
  requireAfterContext?: boolean;
  snippetHint?: string;
  startCol?: number;
  endCol?: number;
}): TargetResolutionResult {
  const { startLine: start, endLine: end, expectedSnippetHash, contextBeforeHash, contextAfterHash } = params;
  if (!isSha256(expectedSnippetHash)) return { status: 'needs_review', reason: 'missing_expected_snippet_hash' };
  if (!isSha256(contextBeforeHash) ||
      ((params.requireAfterContext !== false || contextAfterHash !== undefined) && !isSha256(contextAfterHash))) {
    return { status: 'needs_review', reason: 'invalid_context_hash' };
  }
  const occurrence = params.occurrenceIndex;
  if (params.requireOccurrenceIndex && occurrence === undefined) {
    return { status: 'needs_review', reason: 'missing_occurrence_index' };
  }
  if (occurrence !== undefined && (typeof occurrence !== 'number' || !Number.isSafeInteger(occurrence) || occurrence < 0)) {
    return { status: 'needs_review', reason: 'invalid_occurrence_index' };
  }
  if (typeof start !== 'number' || typeof end !== 'number' ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    return { status: 'stale', reason: 'invalid_line_range' };
  }

  const lines = splitLines(params.text);
  const span = end - start + 1;
  const lastStart = lines.length - span;
  const before = (i: number) => lines.slice(Math.max(0, i - 2), i).join('\n');
  const after = (i: number) => lines.slice(i + span, i + span + 2).join('\n');
  const snippetAt = (i: number) => {
    const segment = lines.slice(i, i + span);
    if (params.startCol !== undefined && params.endCol !== undefined) {
      if (params.startCol - 1 > segment[0].length || params.endCol - 1 > segment[span - 1].length) return undefined;
      segment[span - 1] = segment[span - 1].slice(0, params.endCol - 1);
      segment[0] = segment[0].slice(params.startCol - 1);
    }
    return segment.join('\n');
  };
  const contextMatches = (i: number) => sha256Text(before(i)) === contextBeforeHash &&
    (contextAfterHash === undefined || sha256Text(after(i)) === contextAfterHash);
  if (lastStart < 0) return { status: 'stale', reason: 'line_range_out_of_bounds' };

  let snippet = params.snippetHint;
  if (snippet === undefined || sha256Text(snippet) !== expectedSnippetHash) {
    snippet = start - 1 <= lastStart ? snippetAt(start - 1) : undefined;
    if (snippet !== undefined && sha256Text(snippet) !== expectedSnippetHash) snippet = undefined;
  }
  if (snippet === undefined) {
    // Legacy requests may have no snapshot. Test context before hashing candidate spans.
    for (let i = 0; i <= lastStart; i++) {
      if (!contextMatches(i)) continue;
      const candidate = snippetAt(i);
      if (candidate !== undefined && sha256Text(candidate) === expectedSnippetHash) {
        snippet = candidate;
        break;
      }
    }
  }
  if (snippet === undefined) return { status: 'needs_review', reason: 'snippet_or_context_changed' };

  const pattern = snippet.split('\n');
  let count = 0;
  let match: { index: number; occurrenceIndex: number } | undefined;
  const register = (index: number) => {
    const occurrenceIndex = count++;
    if (!contextMatches(index)) return true;
    if (match) return false;
    match = { index, occurrenceIndex };
    return true;
  };
  if (params.startCol === undefined) {
    if (pattern.length !== span) return { status: 'needs_review', reason: 'invalid_snippet_span' };
    const accept = createLineMatcher(pattern);
    for (let i = 0; i < lines.length; i++) {
      if (accept(lines[i]) && !register(i - span + 1)) {
        return { status: 'needs_review', reason: 'ambiguous_multiple_matches' };
      }
    }
  } else {
    const startOffset = params.startCol - 1;
    const endOffset = params.endCol! - 1;
    if (pattern.length !== span) return { status: 'needs_review', reason: 'invalid_snippet_span' };
    const sameEdges = (i: number) => span === 1
      ? lines[i].slice(startOffset, endOffset) === pattern[0] && endOffset <= lines[i].length
      : lines[i].slice(startOffset) === pattern[0] && lines[i + span - 1].slice(0, endOffset) === pattern[span - 1] &&
        startOffset <= lines[i].length && endOffset <= lines[i + span - 1].length;
    const inner = span > 2 ? createLineMatcher(pattern.slice(1, -1)) : undefined;
    for (let index = 0; index <= lastStart; index++) {
      const endOfInner = index + span - 2;
      // Prime the interior matcher for the first candidate, then advance it once per line.
      if (inner && index === 0) {
        for (let j = 1; j < endOfInner; j++) inner(lines[j]);
      }
      if ((!inner || inner(lines[endOfInner])) && sameEdges(index) && !register(index)) {
        return { status: 'needs_review', reason: 'ambiguous_multiple_matches' };
      }
    }
  }
  if (!match) return { status: 'needs_review', reason: 'surrounding_context_changed' };
  if (occurrence !== undefined && occurrence !== match.occurrenceIndex) {
    return { status: 'needs_review', reason: 'occurrence_index_changed' };
  }
  return {
    status: 'resolved',
    resolvedSnippet: snippet,
    surroundingContext: `${before(match.index)}\n---\n${after(match.index)}`,
    resolvedRange: {
      startLine: match.index + 1, endLine: match.index + span, occurrenceIndex: match.occurrenceIndex,
      ...(params.startCol !== undefined ? { startCol: params.startCol, endCol: params.endCol } : {}),
    },
  };
}
