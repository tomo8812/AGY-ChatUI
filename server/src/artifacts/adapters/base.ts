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
}

export interface AdapterCapabilityContext {
  runtimeProfile: RuntimeProfile;
  sandboxAvailable: boolean;
  filename?: string;
  previewKind?: PreviewKind;
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
}): TargetResolutionResult {
  const lines = splitLines(params.text);
  const start = Math.max(1, Number(params.startLine ?? 1));
  const end = Math.min(lines.length, Math.max(start, Number(params.endLine ?? start)));

  if (start > lines.length) {
    return { status: 'stale', reason: 'line_range_out_of_bounds' };
  }

  const currentSlice = lines.slice(start - 1, end).join('\n');
  const currentHash = sha256Text(currentSlice);
  const beforeSlice = lines.slice(Math.max(0, start - 3), start - 1).join('\n');
  const afterSlice = lines.slice(end, Math.min(lines.length, end + 2)).join('\n');

  if (!params.expectedSnippetHash) {
    return { status: 'needs_review', reason: 'missing_expected_snippet_hash' };
  }

  const beforeMatches = !params.contextBeforeHash || sha256Text(beforeSlice) === params.contextBeforeHash;
  const afterMatches = !params.contextAfterHash || sha256Text(afterSlice) === params.contextAfterHash;

  if (currentHash === params.expectedSnippetHash && beforeMatches && afterMatches) {
    return {
      status: 'resolved',
      resolvedSnippet: currentSlice,
      surroundingContext: `${beforeSlice}\n---\n${afterSlice}`,
      resolvedRange: { startLine: start, endLine: end },
    };
  }

  // Search for a UNIQUE relocated match using exact span length + snippetHash + context hashes
  const spanLen = end - start + 1;
  const candidates: Array<{ startLine: number; endLine: number; contextMatch: boolean }> = [];
  for (let i = 0; i + spanLen <= lines.length; i++) {
    const seg = lines.slice(i, i + spanLen).join('\n');
    if (sha256Text(seg) !== params.expectedSnippetHash) continue;
    const b = lines.slice(Math.max(0, i - 2), i).join('\n');
    const a = lines.slice(i + spanLen, Math.min(lines.length, i + spanLen + 2)).join('\n');
    const bOk = !params.contextBeforeHash || sha256Text(b) === params.contextBeforeHash;
    const aOk = !params.contextAfterHash || sha256Text(a) === params.contextAfterHash;
    candidates.push({ startLine: i + 1, endLine: i + spanLen, contextMatch: bOk && aOk });
  }

  if (candidates.length === 0) {
    return { status: 'stale', reason: 'snippet_not_found' };
  }

  const exactContext = candidates.filter((c) => c.contextMatch);
  if (exactContext.length === 1) {
    const match = exactContext[0];
    const resolvedSnippet = lines.slice(match.startLine - 1, match.endLine).join('\n');
    return {
      status: 'resolved',
      resolvedSnippet,
      resolvedRange: { startLine: match.startLine, endLine: match.endLine },
    };
  }

  // Multiple candidates or ambiguous context -> NEVER guess (PIN-02)
  return {
    status: 'needs_review',
    reason: candidates.length > 1 ? 'ambiguous_multiple_matches' : 'surrounding_context_changed',
  };
}
