import path from 'node:path';
import { applyPatch } from 'diff';
import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterOperation,
  AdapterVerifyIssue,
  AdapterVerifyResult,
  OperationCapability,
  TargetResolutionResult,
  TargetSelector,
} from '../types.js';
import {
  resolveTextSnippetByContext,
  sha256Text,
  splitLines,
  type AdapterCapabilityContext,
  type AdapterFileMeta,
  type FormatAdapter,
} from './base.js';

export class CodeAdapter implements FormatAdapter {
  readonly format = 'code' as const;
  readonly previewKind = 'code' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(_ctx: AdapterCapabilityContext): OperationCapability[] {
    return [
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
    ];
  }

  create(params: Record<string, unknown>, _meta: AdapterFileMeta): Buffer {
    return Buffer.from(String(params.content ?? ''), 'utf8');
  }

  getStructure(buffer: Buffer, meta: AdapterFileMeta): Record<string, unknown> {
    const text = buffer.toString('utf8');
    const lines = splitLines(text);
    const ext = path.extname(meta.filename).toLowerCase().replace(/^\./, '') || 'txt';
    const symbols: Array<{ kind: string; name: string; line: number; signatureHash: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:export\s+)?(?:async\s+)?(function|class|interface|type|def|struct|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
        lines[i]
      );
      if (m) {
        symbols.push({
          kind: m[1],
          name: m[2],
          line: i + 1,
          signatureHash: sha256Text(lines[i].trim()),
        });
      }
    }

    return {
      format: 'code',
      language: ext,
      lineCount: lines.length,
      byteLength: buffer.length,
      symbols,
    };
  }

  readRange(buffer: Buffer, range: Record<string, unknown>, _meta: AdapterFileMeta): Record<string, unknown> {
    const lines = splitLines(buffer.toString('utf8'));
    const startLine = Math.max(1, Number(range.startLine ?? 1));
    const endLine = Math.min(lines.length, Math.max(startLine, Number(range.endLine ?? Math.min(lines.length, startLine + 199))));
    return {
      startLine,
      endLine,
      totalLines: lines.length,
      text: lines.slice(startLine - 1, endLine).join('\n'),
    };
  }

  applyOperations(buffer: Buffer, operations: AdapterOperation[], _meta: AdapterFileMeta): AdapterEditResult {
    let text = buffer.toString('utf8');
    for (const op of operations) {
      if (op.op === 'replace_source' && typeof op.content === 'string') {
        text = op.content;
      } else if (op.op === 'replace_range') {
        const lines = splitLines(text);
        const startLine = Math.max(1, Number(op.startLine ?? 1));
        const endLine = Math.min(lines.length, Math.max(startLine, Number(op.endLine ?? startLine)));
        const replacement = splitLines(String(op.content ?? ''));
        lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
        text = lines.join('\n');
      } else if (op.op === 'search_replace' && typeof op.search === 'string' && typeof op.replace === 'string') {
        if (!text.includes(op.search)) {
          throw new ArtifactError('SEARCH_NOT_FOUND', 'Search target not found in file.', 409);
        }
        text = op.all ? text.split(op.search).join(op.replace) : text.replace(op.search, op.replace);
      } else if (op.op === 'apply_patch' && typeof op.patch === 'string') {
        const patched = applyPatch(text, op.patch);
        if (patched === false) {
          throw new ArtifactError('PATCH_CONFLICT', 'Unified diff patch could not be cleanly applied.', 409);
        }
        text = patched;
      } else {
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `Code adapter does not support op '${op.op}'.`);
      }
    }
    return {
      buffer: Buffer.from(text, 'utf8'),
      summary: `Updated source (${operations.length} op${operations.length === 1 ? '' : 's'})`,
    };
  }

  verify(buffer: Buffer, meta: AdapterFileMeta): AdapterVerifyResult {
    const text = buffer.toString('utf8');
    const ext = path.extname(meta.filename).toLowerCase();
    const issues: AdapterVerifyIssue[] = [];

    if (ext === '.json') {
      try {
        JSON.parse(text);
      } catch (err) {
        issues.push({
          severity: 'error',
          code: 'JSON_SYNTAX_ERROR',
          message: err instanceof Error ? err.message : 'Invalid JSON',
        });
      }
    }
    if (buffer.includes(0)) {
      issues.push({ severity: 'error', code: 'BINARY_NULL_BYTE', message: 'NUL byte detected in text/code file.' });
    }

    return { ok: !issues.some((i) => i.severity === 'error'), issues };
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    if (selector.kind === 'code_line_range' || selector.kind === 'code_char_range') {
      return resolveTextSnippetByContext({
        text,
        startLine: Number(selector.startLine ?? 1),
        endLine: Number(selector.endLine ?? 1),
        expectedSnippetHash: selector.expectedSnippetHash ? String(selector.expectedSnippetHash) : undefined,
        contextBeforeHash: selector.contextBeforeHash ? String(selector.contextBeforeHash) : undefined,
        contextAfterHash: selector.contextAfterHash ? String(selector.contextAfterHash) : undefined,
        occurrenceIndex: selector.occurrenceIndex !== undefined ? Number(selector.occurrenceIndex) : undefined,
      });
    }

    if (selector.kind === 'code_symbol') {
      const symbolName = String(selector.symbolName ?? '');
      const expectedSigHash = selector.expectedSignatureHash ? String(selector.expectedSignatureHash) : '';
      const lines = splitLines(text);
      const matches: Array<{ line: number; text: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:export\s+)?(?:async\s+)?(function|class|interface|type|def|struct|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
          lines[i]
        );
        if (m && m[2] === symbolName && (!expectedSigHash || sha256Text(lines[i].trim()) === expectedSigHash)) {
          matches.push({ line: i + 1, text: lines[i] });
        }
      }
      if (matches.length === 0) return { status: 'stale', reason: 'symbol_not_found' };
      if (matches.length > 1) return { status: 'needs_review', reason: 'ambiguous_multiple_symbols' };
      return { status: 'resolved', resolvedSnippet: matches[0].text, resolvedRange: { startLine: matches[0].line, endLine: matches[0].line } };
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
