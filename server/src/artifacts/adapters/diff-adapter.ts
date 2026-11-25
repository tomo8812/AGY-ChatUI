import { parsePatch } from 'diff';
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
  editCapabilities,
  resolveTextSnippetByContext,
  sha256Text,
  splitLines,
  type AdapterCapabilityContext,
  type AdapterFileMeta,
  type FormatAdapter,
} from './base.js';

const HUNK_OPS = ['replace_hunk', 'remove_hunk'] as const;
const hunkHeader = (h: ReturnType<typeof parsePatch>[number]['hunks'][number]) =>
  `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;

function editHunk(source: string, op: AdapterOperation, remove: boolean): string {
  const parsed = parsePatch(source);
  const headers = [...source.matchAll(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@[^\r\n]*(?:\r?\n|$)/gm)];
  let position = 0;
  const candidates = parsed.flatMap((file, fileIndex) => file.hunks.map((hunk, hunkIndex) => ({
    file, fileIndex, hunk, hunkIndex, location: headers[position++],
  })));
  const matches = candidates.filter(({ file, fileIndex, hunk, hunkIndex }) => (
    (op.fileIndex === undefined || fileIndex === op.fileIndex) &&
    (op.filePath === undefined || (file.newFileName || file.oldFileName || '').replace(/^[ab]\//, '') === op.filePath) &&
    (op.hunkIndex !== undefined ? hunkIndex === op.hunkIndex : typeof op.hunkHeader === 'string' && hunkHeader(hunk) === op.hunkHeader)
  ));
  if (matches.length !== 1 || !matches[0].location ||
      (op.expectedHunkHash !== undefined && sha256Text(matches[0].hunk.lines.join('\n')) !== op.expectedHunkHash)) {
    throw new ArtifactError('DIFF_HUNK_CONFLICT', 'Select a unique hunk from the current structure.', 409);
  }
  const { file, hunk, hunkIndex, location } = matches[0];
  const lines = remove ? [] : op.lines;
  if (!Array.isArray(lines) || (!remove && (!lines.length || lines.some((line) => typeof line !== 'string' ||
      /[\r\n]/.test(line) || !/^(?:[ +\-]|\\ No newline at end of file$)/.test(line))))) {
    throw new ArtifactError('INVALID_DIFF_HUNK', 'Provide an array of unified diff body lines.', 400);
  }
  const start = location.index;
  const bodyStart = start + location[0].length;
  let end = bodyStart;
  for (let i = 0; i < hunk.lines.length; i++) {
    const newline = source.indexOf('\n', end);
    end = newline < 0 ? source.length : newline + 1;
  }
  const newCount = lines.filter((line) => line.startsWith('+') || line.startsWith(' ')).length;
  const oldCount = lines.filter((line) => line.startsWith('-') || line.startsWith(' ')).length;
  const delta = newCount - oldCount - (hunk.newLines - hunk.oldLines);
  if (!remove && hunkIndex + 1 < file.hunks.length && hunk.oldStart + oldCount > file.hunks[hunkIndex + 1].oldStart) {
    throw new ArtifactError('DIFF_HUNK_OVERLAP', 'The edited hunk overlaps the next hunk.', 422);
  }
  let suffix = source.slice(end);
  for (const next of candidates.filter((item) => item.file === file && item.hunkIndex > hunkIndex).reverse()) {
    const offset = next.location.index - end;
    const updated = next.location[0].replace(/ \+(\d+)/, (_, n) => ` +${Number(n) + delta}`);
    suffix = suffix.slice(0, offset) + updated + suffix.slice(offset + next.location[0].length);
  }
  const eol = location[0].endsWith('\r\n') ? '\r\n' : '\n';
  const header = location[0].replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/,
    `@@ -${hunk.oldStart - Number(oldCount === 0)},${oldCount} +${hunk.newStart - Number(newCount === 0)},${newCount} @@`).trimEnd();
  const revised = source.slice(0, start) + (remove ? '' : header + eol + lines.join(eol) + (suffix || source.endsWith('\n') ? eol : '')) + suffix;
  parsePatch(revised);
  return revised;
}

export class DiffAdapter implements FormatAdapter {
  readonly format = 'diff' as const;
  readonly previewKind = 'diff' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(_ctx: AdapterCapabilityContext): OperationCapability[] {
    return [
      ...editCapabilities('diff', HUNK_OPS),
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

  getStructure(buffer: Buffer, _meta: AdapterFileMeta): Record<string, unknown> {
    const text = buffer.toString('utf8');
    let parsed: ReturnType<typeof parsePatch> = [];
    try {
      parsed = parsePatch(text);
    } catch {
      parsed = [];
    }
    return {
      format: 'diff',
      lineCount: splitLines(text).length,
      files: parsed.map((f, fileIndex) => ({
        fileIndex,
        oldFileName: f.oldFileName,
        newFileName: f.newFileName,
        hunks: f.hunks.map((h, hunkIndex) => ({
          hunkIndex,
          header: hunkHeader(h),
          hunkHash: sha256Text(h.lines.join('\n')),
        })),
      })),
    };
  }

  readRange(buffer: Buffer, range: Record<string, unknown>, _meta: AdapterFileMeta): Record<string, unknown> {
    const lines = splitLines(buffer.toString('utf8'));
    const startLine = Math.max(1, Number(range.startLine ?? 1));
    const endLine = Math.min(lines.length, Math.max(startLine, Number(range.endLine ?? lines.length)));
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
      } else if (op.op === 'search_replace' && typeof op.search === 'string' && typeof op.replace === 'string') {
        if (!text.includes(op.search)) {
          throw new ArtifactError('SEARCH_NOT_FOUND', 'Diff search target not found.', 409);
        }
        text = text.replace(op.search, op.replace);
      } else if (HUNK_OPS.some((name) => op.op === `diff.${name}` || op.op === name)) {
        try {
          text = editHunk(text, op, op.op.endsWith('remove_hunk'));
        } catch (error) {
          if (error instanceof ArtifactError) throw error;
          throw new ArtifactError('INVALID_DIFF_HUNK', error instanceof Error ? error.message : 'Invalid diff.', 422);
        }
      } else {
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `Diff adapter does not support op '${op.op}'.`);
      }
    }
    return {
      buffer: Buffer.from(text, 'utf8'),
      summary: `Updated diff (${operations.length} op${operations.length === 1 ? '' : 's'})`,
    };
  }

  verify(buffer: Buffer, _meta: AdapterFileMeta): AdapterVerifyResult {
    const text = buffer.toString('utf8');
    const issues: AdapterVerifyIssue[] = [];
    try {
      const parsed = parsePatch(text);
      if (parsed.length === 0 && text.trim().length > 0) {
        issues.push({ severity: 'error', code: 'DIFF_INVALID_PATCH', message: 'No valid unified diff hunks found.' });
      }
    } catch (err) {
      issues.push({
        severity: 'error',
        code: 'DIFF_PARSE_ERROR',
        message: err instanceof Error ? err.message : 'Failed to parse diff.',
      });
    }
    return { ok: !issues.some((i) => i.severity === 'error'), issues };
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    if (selector.kind === 'diff_hunk') {
      const filePath = String(selector.filePath ?? '');
      const hunkHeader = String(selector.hunkHeader ?? '');
      const expectedHunkHash = String(selector.expectedHunkHash ?? '');
      try {
        const parsed = parsePatch(text);
        const matches: string[] = [];
        for (const f of parsed) {
          const fname = (f.newFileName || f.oldFileName || '').replace(/^[ab]\//, '');
          if (filePath && fname !== filePath) continue;
          for (const h of f.hunks) {
            const hdr = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
            if (hunkHeader && hdr !== hunkHeader) continue;
            const body = h.lines.join('\n');
            if (!expectedHunkHash || sha256Text(body) === expectedHunkHash) {
              matches.push(`${hdr}\n${body}`);
            }
          }
        }
        if (matches.length === 0) return { status: 'stale', reason: 'hunk_not_found' };
        if (matches.length > 1) return { status: 'needs_review', reason: 'ambiguous_multiple_hunks' };
        return { status: 'resolved', resolvedSnippet: matches[0] };
      } catch {
        return { status: 'needs_review', reason: 'diff_parse_error' };
      }
    }

    if (selector.kind === 'diff_line_range') {
      return resolveTextSnippetByContext({
        text,
        startLine: Number(selector.startLine ?? 1),
        endLine: Number(selector.endLine ?? 1),
        expectedSnippetHash: selector.expectedSnippetHash ? String(selector.expectedSnippetHash) : undefined,
        contextBeforeHash: selector.contextBeforeHash ? String(selector.contextBeforeHash) : undefined,
        contextAfterHash: selector.contextAfterHash ? String(selector.contextAfterHash) : undefined,
      });
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
