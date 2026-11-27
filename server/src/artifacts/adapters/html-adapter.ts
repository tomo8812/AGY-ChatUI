import { applyPatch } from 'diff';
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
  browserVerifyCapability,
  resolveTextSnippetByContext,
  sha256Buffer,
  sha256Text,
  splitLines,
  type AdapterCapabilityContext,
  type AdapterFileMeta,
  type FormatAdapter,
} from './base.js';

import { selectHtmlElements } from './html-select.js';
import { verifyHtml } from './html-validator.js';

import { editMarkup, elementMetadata, markupCapabilities, markupElements } from './markup-edit.js';

export class HtmlAdapter implements FormatAdapter {
  readonly format = 'html' as const;
  readonly previewKind = 'html' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(ctx: AdapterCapabilityContext): OperationCapability[] {
    const webReady = ctx.runtimeProfile === 'full_runtime' && ctx.sandboxAvailable;
    const remediation =
      ctx.runtimeProfile === 'full_runtime'
        ? 'bubblewrap サンドボックスを有効化してください。'
        : 'Full Runtime（deploy/setup-doc-runtime.sh, INSTALL_DOC_RUNTIME=full）を有効化してください。';
    return [
      ...markupCapabilities('html'),
      browserVerifyCapability(ctx),
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
      {
        operation: 'render_png',
        availability: webReady ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_only',
        remediation: webReady ? undefined : remediation,
      },
      {
        operation: 'export:png',
        availability: webReady ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_and_ui',
        remediation: webReady ? undefined : remediation,
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
    const elements = elementMetadata(markupElements(text, 'html'));
    return {
      format: 'html',
      title: titleMatch ? titleMatch[1].trim() : null,
      lineCount: splitLines(text).length,
      docSha256: sha256Buffer(buffer),
      identifiedElements: elements.filter(({ id }) => id !== null),
      elements,
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
      } else if ((op.op === 'apply_patch' || op.op === 'html.apply_patch') && typeof op.patch === 'string') {
        const edited = applyPatch(text, op.patch);
        if (edited === false) throw new ArtifactError('PATCH_CONFLICT', 'HTML patch does not match the current revision.', 409);
        text = edited;
      } else {
        const edited = editMarkup(text, op, 'html');
        if (edited !== undefined) {
          text = edited;
          continue;
        }
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
    if (selector.kind === 'html_dom_element' || selector.kind === 'html_text_range') {
      const cssSelector = String(selector.cssSelector ?? '').trim();
      const expectedTag = selector.expectedTag ? String(selector.expectedTag).toLowerCase() : null;
      let found: ReturnType<typeof selectHtmlElements>;
      try {
        found = selectHtmlElements(text, cssSelector);
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
        return { status: 'needs_review', reason: 'invalid_dom_selector' };
      }
      if (found.length === 0) return { status: 'stale', reason: 'element_not_found' };
      if (found.length !== 1 || (selector.matchCountInDoc !== undefined && found.length !== selector.matchCountInDoc)) {
        return { status: 'needs_review', reason: 'ambiguous_multiple_elements' };
      }
      const el = found[0];
      if (selector.kind === 'html_text_range') {
        const { charStart, charEnd } = selector;
        if (typeof charStart !== 'number' || typeof charEnd !== 'number' || !Number.isInteger(charStart) ||
            !Number.isInteger(charEnd) || charStart < 0 || charEnd <= charStart || charEnd > el.textContent.length) {
          return { status: 'needs_review', reason: 'invalid_text_range' };
        }
        const content = el.textContent.slice(charStart, charEnd);
        const contextMatches = (offset: number) => {
          const end = offset + content.length;
          return sha256Text(el.textContent.slice(Math.max(0, offset - 64), offset)) === selector.contextBeforeHash &&
            sha256Text(el.textContent.slice(end, end + 64)) === selector.contextAfterHash;
        };
        if (sha256Text(content) !== selector.expectedSnippetHash || !contextMatches(charStart)) {
          return { status: 'needs_review', reason: 'text_range_changed' };
        }
        let occurrence = 0;
        for (let offset = el.textContent.indexOf(content); offset >= 0; offset = el.textContent.indexOf(content, offset + 1)) {
          if (offset === charStart && occurrence !== selector.occurrenceIndex) {
            return { status: 'needs_review', reason: 'text_occurrence_changed' };
          }
          if (offset !== charStart && contextMatches(offset)) {
            return { status: 'needs_review', reason: 'ambiguous_multiple_matches' };
          }
          occurrence++;
        }
        return { status: 'resolved', resolvedSnippet: content, resolvedRange: { charStart, charEnd } };
      }
      if ((expectedTag && el.tag.toLowerCase() !== expectedTag) || el.fingerprint !== selector.expectedElementFingerprint) {
        return { status: 'needs_review', reason: 'element_replaced_or_modified' };
      }
      return { status: 'resolved', resolvedSnippet: text.slice(el.start, el.end) };
    }

    if (selector.kind === 'html_source_range') {
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
