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

/**
 * Resolves a line-range snippet strictly by content hash + surrounding context hash.
 * Guarantees single unique match; multiple candidates or missing matches return `needs_review` / `stale` (`PIN-02`).
 */
export function resolveTextSnippetByContext(params: {
  text: string;
  startLine?: number;
  endLine?: number;
  expectedSnippetHash?: string;
  contextBeforeHash?: string;
  contextAfterHash?: string;
  occurrenceIndex?: number;
  requireOccurrenceIndex?: boolean;
}): TargetResolutionResult {
  const lines = splitLines(params.text);
  const start = Math.max(1, Number(params.startLine ?? 1));
  const end = Math.min(lines.length, Math.max(start, Number(params.endLine ?? start)));

  if (!params.expectedSnippetHash) {
    return { status: 'needs_review', reason: 'missing_expected_snippet_hash' };
  }

  const hasOccurrenceIndex = params.occurrenceIndex !== undefined && params.occurrenceIndex !== null;
  if (params.requireOccurrenceIndex && !hasOccurrenceIndex) {
    return { status: 'needs_review', reason: 'missing_occurrence_index' };
  }
  if (hasOccurrenceIndex && (!Number.isInteger(params.occurrenceIndex) || (params.occurrenceIndex as number) < 0)) {
    return { status: 'needs_review', reason: 'invalid_occurrence_index' };
  }
  const expectedOccurrenceIndex = hasOccurrenceIndex ? (params.occurrenceIndex as number) : undefined;

  if (start > lines.length) {
    return { status: 'stale', reason: 'line_range_out_of_bounds' };
  }

  // Enumerate all occurrences of the expected snippet in order so occurrenceIndex is exact.
  const spanLen = end - start + 1;
  const candidates: Array<{
    startLine: number;
    endLine: number;
    occurrenceIndex: number;
    contextMatch: boolean;
    beforeSlice: string;
    afterSlice: string;
  }> = [];
  for (let i = 0; i + spanLen <= lines.length; i++) {
    const seg = lines.slice(i, i + spanLen).join('\n');
    if (sha256Text(seg) !== params.expectedSnippetHash) continue;
    const b = lines.slice(Math.max(0, i - 2), i).join('\n');
    const a = lines.slice(i + spanLen, Math.min(lines.length, i + spanLen + 2)).join('\n');
    const bOk = !params.contextBeforeHash || sha256Text(b) === params.contextBeforeHash;
    const aOk = !params.contextAfterHash || sha256Text(a) === params.contextAfterHash;
    candidates.push({
      startLine: i + 1,
      endLine: i + spanLen,
      occurrenceIndex: candidates.length,
      contextMatch: bOk && aOk,
      beforeSlice: b,
      afterSlice: a,
    });
  }

  if (candidates.length === 0) {
    return { status: 'stale', reason: 'snippet_not_found' };
  }

  const exactContext = candidates.filter((c) => c.contextMatch);
  const atOriginal = candidates.find((c) => c.startLine === start && c.endLine === end);

  if (atOriginal && atOriginal.contextMatch) {
    if (expectedOccurrenceIndex !== undefined && atOriginal.occurrenceIndex !== expectedOccurrenceIndex) {
      return { status: 'needs_review', reason: 'occurrence_index_changed' };
    }
    if (expectedOccurrenceIndex === undefined && exactContext.length > 1) {
      return { status: 'needs_review', reason: 'ambiguous_multiple_matches' };
    }
    const currentSlice = lines.slice(start - 1, end).join('\n');
    return {
      status: 'resolved',
      resolvedSnippet: currentSlice,
      surroundingContext: `${atOriginal.beforeSlice}\n---\n${atOriginal.afterSlice}`,
      resolvedRange: { startLine: start, endLine: end, occurrenceIndex: atOriginal.occurrenceIndex },
    };
  }

  // Relocated match: require a UNIQUE exact-context match whose occurrenceIndex also agrees (PIN-02)
  if (exactContext.length === 1) {
    const match = exactContext[0];
    if (expectedOccurrenceIndex !== undefined && match.occurrenceIndex !== expectedOccurrenceIndex) {
      return { status: 'needs_review', reason: 'occurrence_index_changed' };
    }
    const resolvedSnippet = lines.slice(match.startLine - 1, match.endLine).join('\n');
    return {
      status: 'resolved',
      resolvedSnippet,
      surroundingContext: `${match.beforeSlice}\n---\n${match.afterSlice}`,
      resolvedRange: { startLine: match.startLine, endLine: match.endLine, occurrenceIndex: match.occurrenceIndex },
    };
  }

  // Multiple candidates or ambiguous context -> NEVER guess (PIN-02)
  return {
    status: 'needs_review',
    reason: candidates.length > 1 ? 'ambiguous_multiple_matches' : 'surrounding_context_changed',
  };
}
