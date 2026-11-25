import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterOperation,
  AdapterVerifyResult,
  OperationCapability,
  TargetResolutionResult,
  TargetSelector,
} from '../types.js';
import { browserVerifyCapability, sha256Buffer, splitLines, type AdapterCapabilityContext, type AdapterFileMeta, type FormatAdapter } from './base.js';
import { verifySvg } from './svg-verifier.js';

import { editMarkup, elementMetadata, markupCapabilities, markupElements } from './markup-edit.js';

export class SvgAdapter implements FormatAdapter {
  readonly format = 'svg' as const;
  readonly previewKind = 'svg' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(ctx: AdapterCapabilityContext): OperationCapability[] {
    return [
      ...markupCapabilities('svg'),
      browserVerifyCapability(ctx),
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
      {
        operation: 'export:png',
        availability: ctx.runtimeProfile !== 'base_chatui' && ctx.sandboxAvailable ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_and_ui',
        remediation: ctx.runtimeProfile === 'base_chatui' ? 'deploy/setup-doc-runtime.sh を実行してください。' : undefined,
      },
      {
        operation: 'render_png',
        availability: ctx.runtimeProfile !== 'base_chatui' && ctx.sandboxAvailable ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_only',
        remediation: ctx.runtimeProfile === 'base_chatui' ? 'deploy/setup-doc-runtime.sh を実行してください。' : undefined,
      },
    ];
  }

  create(params: Record<string, unknown>, _meta: AdapterFileMeta): Buffer {
    if (typeof params.content === 'string') {
      return Buffer.from(params.content, 'utf8');
    }
    const width = Number(params.width ?? 400);
    const height = Number(params.height ?? 300);
    const body = typeof params.body === 'string' ? params.body : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">\n${body}\n</svg>\n`;
    return Buffer.from(svg, 'utf8');
  }

  getStructure(buffer: Buffer, _meta: AdapterFileMeta): Record<string, unknown> {
    const text = buffer.toString('utf8');
    let elements: ReturnType<typeof markupElements> = [];
    try {
      elements = markupElements(text, 'svg');
    } catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
    }
    return {
      format: 'svg',
      viewBox: elements[0]?.attrs.viewBox ?? null,
      lineCount: splitLines(text).length,
      svgSha256: sha256Buffer(buffer),
      elements: elementMetadata(elements),
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
          throw new ArtifactError('SEARCH_NOT_FOUND', 'SVG search target not found.', 409);
        }
        text = text.replace(op.search, op.replace);
      } else {
        const edited = editMarkup(text, op, 'svg');
        if (edited !== undefined) {
          text = edited;
          continue;
        }
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `SVG adapter does not support op '${op.op}'.`);
      }
    }
    return {
      buffer: Buffer.from(text, 'utf8'),
      summary: `Updated SVG (${operations.length} op${operations.length === 1 ? '' : 's'})`,
    };
  }

  verify(buffer: Buffer, _meta: AdapterFileMeta): AdapterVerifyResult {
    return verifySvg(buffer);
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    if (selector.kind === 'svg_element') {
      const elementId = selector.elementId ? String(selector.elementId) : null;
      const expectedTag = selector.expectedTag ? String(selector.expectedTag) : null;
      const expectedFp = selector.expectedElementFingerprint ? String(selector.expectedElementFingerprint) : null;
      if (!elementId || !expectedFp) {
        return { status: 'needs_review', reason: 'missing_element_fingerprint' };
      }
      let matches: ReturnType<typeof markupElements>;
      try {
        matches = markupElements(text, 'svg').filter((el) => el.id === elementId);
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
        return { status: 'needs_review', reason: 'invalid_svg_structure' };
      }
      if (matches.length === 0) {
        return { status: 'stale', reason: 'element_not_found' };
      }
      if (matches.length > 1) {
        return { status: 'needs_review', reason: 'duplicate_element_id' };
      }
      const el = matches[0];
      // Check BOTH tag AND content/attribute fingerprint (PIN-02 case 4)
      if ((expectedTag && el.tag !== expectedTag) || el.fingerprint !== expectedFp) {
        return { status: 'needs_review', reason: 'element_replaced_or_modified' };
      }
      return { status: 'resolved', resolvedSnippet: text.slice(el.start, el.end) };
    }

    if (selector.kind === 'svg_region') {
      const vbMatch = /viewBox\s*=\s*["']([^"']+)["']/i.exec(text);
      const currentVb = vbMatch ? vbMatch[1] : '';
      if (selector.expectedViewBox && currentVb !== String(selector.expectedViewBox)) {
        return { status: 'needs_review', reason: 'viewbox_changed' };
      }
      if (selector.expectedSvgSha256 && sha256Buffer(buffer) !== String(selector.expectedSvgSha256)) {
        return { status: 'needs_review', reason: 'svg_content_changed' };
      }
      return { status: 'resolved', resolvedCoords: { rectViewBox: selector.rectViewBox } };
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
