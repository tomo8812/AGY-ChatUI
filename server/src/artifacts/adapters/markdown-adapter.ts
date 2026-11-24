import path from 'node:path';
import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterExportResult,
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

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

export class MarkdownAdapter implements FormatAdapter {
  readonly format = 'markdown' as const;
  readonly previewKind = 'markdown' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(ctx: AdapterCapabilityContext): OperationCapability[] {
    return [
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'export', availability: 'supported', scope: 'mcp_and_ui', notes: 'html, txt' },
      {
        operation: 'render_png',
        availability: ctx.runtimeProfile === 'full_runtime' ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_only',
      },
    ];
  }

  create(params: Record<string, unknown>, _meta: AdapterFileMeta): Buffer {
    if (typeof params.content === 'string') return Buffer.from(params.content, 'utf8');
    const title = String(params.title ?? 'Untitled');
    const body = String(params.body ?? '');
    return Buffer.from(`# ${title}\n\n${body}\n`, 'utf8');
  }

  getStructure(buffer: Buffer, _meta: AdapterFileMeta): Record<string, unknown> {
    const lines = splitLines(buffer.toString('utf8'));
    const headings: Array<{ level: number; text: string; slug: string; line: number; hash: string }> = [];
    const codeFences: Array<{ fenceIndex: number; lang: string; startLine: number; endLine: number; hash: string }> = [];

    let inFence = false;
    let fenceStart = 0;
    let fenceLang = '';
    let fenceLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fenceMatch = /^```(.*)$/.exec(line.trim());
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fenceStart = i + 1;
          fenceLang = fenceMatch[1].trim();
          fenceLines = [];
        } else {
          codeFences.push({
            fenceIndex: codeFences.length,
            lang: fenceLang,
            startLine: fenceStart,
            endLine: i + 1,
            hash: sha256Text(fenceLines.join('\n')),
          });
          inFence = false;
        }
        continue;
      }
      if (inFence) {
        fenceLines.push(line);
        continue;
      }
      const h = /^(#{1,6})\s+(.+)$/.exec(line);
      if (h) {
        headings.push({
          level: h[1].length,
          text: h[2].trim(),
          slug: slugifyHeading(h[2]),
          line: i + 1,
          hash: sha256Text(line.trim()),
        });
      }
    }

    return {
      format: 'markdown',
      lineCount: lines.length,
      headings,
      codeFences,
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
      } else if (op.op === 'replace_range') {
        const lines = splitLines(text);
        const startLine = Math.max(1, Number(op.startLine ?? 1));
        const endLine = Math.min(lines.length, Math.max(startLine, Number(op.endLine ?? startLine)));
        const replacement = splitLines(String(op.content ?? ''));
        lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
        text = lines.join('\n');
      } else if (op.op === 'search_replace' && typeof op.search === 'string' && typeof op.replace === 'string') {
        if (!text.includes(op.search)) {
          throw new ArtifactError('SEARCH_NOT_FOUND', 'Markdown search target not found.', 409);
        }
        text = text.replace(op.search, op.replace);
      } else if (op.op === 'replace_section' && typeof op.headingSlug === 'string' && typeof op.content === 'string') {
        const lines = splitLines(text);
        let startIdx = -1;
        let level = 0;
        for (let i = 0; i < lines.length; i++) {
          const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
          if (m && slugifyHeading(m[2]) === op.headingSlug) {
            startIdx = i;
            level = m[1].length;
            break;
          }
        }
        if (startIdx < 0) {
          throw new ArtifactError('SECTION_NOT_FOUND', `Heading '${op.headingSlug}' not found.`, 404);
        }
        let endIdx = lines.length;
        for (let i = startIdx + 1; i < lines.length; i++) {
          const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
          if (m && m[1].length <= level) {
            endIdx = i;
            break;
          }
        }
        lines.splice(startIdx + 1, endIdx - startIdx - 1, ...splitLines(op.content));
        text = lines.join('\n');
      } else {
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `Markdown adapter does not support op '${op.op}'.`);
      }
    }
    return {
      buffer: Buffer.from(text, 'utf8'),
      summary: `Updated Markdown (${operations.length} op${operations.length === 1 ? '' : 's'})`,
    };
  }

  verify(buffer: Buffer, _meta: AdapterFileMeta): AdapterVerifyResult {
    const lines = splitLines(buffer.toString('utf8'));
    const issues: AdapterVerifyIssue[] = [];
    let fenceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^```/.test(lines[i].trim())) fenceDepth = fenceDepth === 0 ? 1 : 0;
    }
    if (fenceDepth !== 0) {
      issues.push({ severity: 'error', code: 'MD_UNCLOSED_FENCE', message: 'Unclosed fenced code block.' });
    }
    return { ok: !issues.some((i) => i.severity === 'error'), issues };
  }

  exportAs(buffer: Buffer, targetFormat: string, meta: AdapterFileMeta): AdapterExportResult {
    const text = buffer.toString('utf8');
    const stem = path.basename(meta.filename, path.extname(meta.filename));
    const fmt = targetFormat.toLowerCase();
    if (fmt === 'txt') {
      return { buffer: Buffer.from(text, 'utf8'), filename: `${stem}.txt`, mimeType: 'text/plain' };
    }
    if (fmt === 'html') {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return {
        buffer: Buffer.from(`<!DOCTYPE html><html><body><pre>${escaped}</pre></body></html>\n`, 'utf8'),
        filename: `${stem}.html`,
        mimeType: 'text/html',
      };
    }
    throw unsupportedOperationError(`export:${fmt}`, 'unsupported_by_format', `Markdown export to '${fmt}' is unsupported in Pure-JS mode.`);
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    const lines = splitLines(text);

    if (selector.kind === 'md_heading') {
      const slug = String(selector.headingSlug ?? '');
      const expectedHash = selector.expectedHeadingHash ? String(selector.expectedHeadingHash) : '';
      const matches: Array<{ line: number; text: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
        if (m && slugifyHeading(m[2]) === slug && (!expectedHash || sha256Text(lines[i].trim()) === expectedHash)) {
          matches.push({ line: i + 1, text: lines[i] });
        }
      }
      if (matches.length === 0) return { status: 'stale', reason: 'heading_not_found' };
      if (matches.length > 1) return { status: 'needs_review', reason: 'ambiguous_multiple_headings' };
      return { status: 'resolved', resolvedSnippet: matches[0].text, resolvedRange: { startLine: matches[0].line, endLine: matches[0].line } };
    }

    if (selector.kind === 'md_text_range' || selector.kind === 'md_block' || selector.kind === 'md_code_block') {
      const expectedHash =
        selector.expectedSnippetHash ?? selector.expectedBlockHash ?? selector.expectedCodeHash;
      return resolveTextSnippetByContext({
        text,
        startLine: Number(selector.startLine ?? 1),
        endLine: Number(selector.endLine ?? 1),
        expectedSnippetHash: expectedHash ? String(expectedHash) : undefined,
        contextBeforeHash: selector.contextBeforeHash ? String(selector.contextBeforeHash) : undefined,
        contextAfterHash: selector.contextAfterHash ? String(selector.contextAfterHash) : undefined,
        occurrenceIndex: selector.occurrenceIndex !== undefined ? Number(selector.occurrenceIndex) : undefined,
      });
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
