import path from 'node:path';
import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterOperation,
  AdapterVerifyResult,
  OperationCapability,
  TargetResolutionResult,
  TargetSelector,
} from '../types.js';
import {
  resolveTextSnippetByContext,
  sha256Buffer,
  sha256Text,
  splitLines,
  type AdapterCapabilityContext,
  type AdapterFileMeta,
  type FormatAdapter,
} from './base.js';

import { verifyHtml } from './html-validator.js';

function findHtmlElementsById(html: string, id: string): Array<{ tag: string; raw: string; fingerprint: string }> {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)([^>]*\\bid\\s*=\\s*["']${escaped}["'][^>]*)(?:\\/>|>([\\s\\S]*?)<\\/\\1>)`, 'gi');
  const out: Array<{ tag: string; raw: string; fingerprint: string }> = [];
  for (const m of html.matchAll(re)) {
    const tag = m[1].toLowerCase();
    out.push({ tag, raw: m[0], fingerprint: sha256Text(`${tag}|${m[0].trim()}`) });
  }
  return out;
}

export class HtmlAdapter implements FormatAdapter {
  readonly format = 'html' as const;
  readonly previewKind = 'html' as const;
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
      {
        operation: 'render_png',
        availability: ctx.runtimeProfile === 'full_runtime' && ctx.sandboxAvailable ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_only',
        remediation: ctx.runtimeProfile !== 'full_runtime' ? 'Full Runtime（deploy/setup-doc-runtime.sh --profile full）を有効化してください。' : undefined,
      },
      {
        operation: 'export:png',
        availability: ctx.runtimeProfile === 'full_runtime' && ctx.sandboxAvailable ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_and_ui',
        remediation: ctx.runtimeProfile !== 'full_runtime' ? 'Full Runtime（deploy/setup-doc-runtime.sh --profile full）を有効化してください。' : undefined,
      },
    ];
  }

  create(params: Record<string, unknown>, _meta: AdapterFileMeta): Buffer {
    if (typeof params.content === 'string') {
      return Buffer.from(params.content, 'utf8');
    }
    const title = String(params.title ?? 'Document');
    const body = String(params.body ?? '');
    return Buffer.from(
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <title>${title}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`,
      'utf8'
    );
  }

  getStructure(buffer: Buffer, _meta: AdapterFileMeta): Record<string, unknown> {
    const text = buffer.toString('utf8');
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    const ids: Array<{ id: string; tag: string; fingerprint: string }> = [];
    for (const m of text.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*\bid\s*=\s*["']([^"']+)["'][^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/gi)) {
      const tag = m[1].toLowerCase();
      ids.push({ id: m[3], tag, fingerprint: sha256Text(`${tag}|${m[0].trim()}`) });
    }
    return {
      format: 'html',
      title: titleMatch ? titleMatch[1].trim() : null,
      lineCount: splitLines(text).length,
      docSha256: sha256Buffer(buffer),
      identifiedElements: ids,
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
          throw new ArtifactError('SEARCH_NOT_FOUND', 'HTML search target not found.', 409);
        }
        text = text.replace(op.search, op.replace);
      } else {
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `HTML adapter does not support op '${op.op}'.`);
      }
    }
    return {
      buffer: Buffer.from(text, 'utf8'),
      summary: `Updated HTML (${operations.length} op${operations.length === 1 ? '' : 's'})`,
    };
  }

  verify(buffer: Buffer, meta: AdapterFileMeta): AdapterVerifyResult {
    return verifyHtml(buffer, meta);
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    if (selector.kind === 'html_dom_element') {
      const cssSelector = String(selector.cssSelector ?? '').trim();
      const expectedTag = selector.expectedTag ? String(selector.expectedTag).toLowerCase() : null;
      const expectedFp = selector.expectedElementFingerprint ? String(selector.expectedElementFingerprint) : null;
      if (!cssSelector || !expectedFp) {
        return { status: 'needs_review', reason: 'missing_dom_fingerprint' };
      }
      const idMatch = /^#([a-zA-Z0-9_-]+)$/.exec(cssSelector);
      if (idMatch) {
        const found = findHtmlElementsById(text, idMatch[1]);
        if (found.length === 0) return { status: 'stale', reason: 'element_not_found' };
        if (found.length > 1) return { status: 'needs_review', reason: 'ambiguous_multiple_elements' };
        const el = found[0];
        if ((expectedTag && el.tag !== expectedTag) || el.fingerprint !== expectedFp) {
          return { status: 'needs_review', reason: 'element_replaced_or_modified' };
        }
        return { status: 'resolved', resolvedSnippet: el.raw };
      }
      return { status: 'needs_review', reason: 'complex_css_selector_requires_review' };
    }

    if (selector.kind === 'html_source_range' || selector.kind === 'html_text_range') {
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

    if (selector.kind === 'html_viewport_region') {
      if (selector.expectedDocSha256 && sha256Buffer(buffer) !== String(selector.expectedDocSha256)) {
        return { status: 'needs_review', reason: 'document_changed' };
      }
      return { status: 'resolved', resolvedCoords: { rectNorm: selector.rectNorm } };
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
