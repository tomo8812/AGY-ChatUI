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
import { sha256Buffer, sha256Text, splitLines, type AdapterCapabilityContext, type AdapterFileMeta, type FormatAdapter } from './base.js';

interface ParsedSvgElement {
  tag: string;
  id: string | null;
  rawMatch: string;
  fingerprint: string;
}

function extractSvgElements(svg: string): ParsedSvgElement[] {
  const results: ParsedSvgElement[] = [];
  const walk = (fragment: string) => {
    const tagRe = /<([a-zA-Z][a-zA-Z0-9:_-]*)(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
    for (const m of fragment.matchAll(tagRe)) {
      const tag = m[1];
      const attrs = m[2] ?? '';
      const inner = m[3] ?? '';
      const idMatch = /\bid\s*=\s*["']([^"']+)["']/.exec(attrs);
      results.push({
        tag,
        id: idMatch ? idMatch[1] : null,
        rawMatch: m[0],
        fingerprint: sha256Text(`${tag}|${m[0].trim()}`),
      });
      if (inner) {
        walk(inner);
      }
    }
  };
  walk(svg);
  return results;
}

export class SvgAdapter implements FormatAdapter {
  readonly format = 'svg' as const;
  readonly previewKind = 'svg' as const;
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
        operation: 'export_png',
        availability: ctx.runtimeProfile === 'base_chatui' ? 'disabled_by_resource_tier' : 'supported',
        scope: 'mcp_and_ui',
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
    const vbMatch = /viewBox\s*=\s*["']([^"']+)["']/i.exec(text);
    const elements = extractSvgElements(text).map((el, index) => ({
      index,
      tag: el.tag,
      id: el.id,
      fingerprint: el.fingerprint,
    }));
    return {
      format: 'svg',
      viewBox: vbMatch ? vbMatch[1] : null,
      lineCount: splitLines(text).length,
      svgSha256: sha256Buffer(buffer),
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
      } else if (op.op === 'search_replace' && typeof op.search === 'string' && typeof op.replace === 'string') {
        if (!text.includes(op.search)) {
          throw new ArtifactError('SEARCH_NOT_FOUND', 'SVG search target not found.', 409);
        }
        text = text.replace(op.search, op.replace);
      } else if (op.op === 'set_attr' && typeof op.elementId === 'string' && typeof op.attr === 'string') {
        const attrName = op.attr.trim();
        if (!/^[a-zA-Z_:][a-zA-Z0-9:._-]*$/.test(attrName) || /^on/i.test(attrName)) {
          throw new ArtifactError('INVALID_SVG_ATTRIBUTE', `Invalid or forbidden SVG attribute '${op.attr}'.`, 400);
        }
        const rawVal = String(op.value ?? '');
        if (/^(?:href|xlink:href)$/i.test(attrName) && /^\s*(?:javascript|vbscript):/i.test(rawVal)) {
          throw new ArtifactError('INVALID_SVG_ATTRIBUTE', `Forbidden URI scheme for SVG attribute '${attrName}'.`, 400);
        }
        const escapedId = op.elementId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(<[a-zA-Z][^>]*\\bid=["']${escapedId}["'][^>]*?)(\\/?>)`);
        if (!re.test(text)) {
          throw new ArtifactError('ELEMENT_NOT_FOUND', `SVG element '${op.elementId}' not found.`, 404);
        }
        const escapedAttr = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const attrVal = rawVal
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        text = text.replace(re, (_full, openTag: string, close: string) => {
          const attrRe = new RegExp(`(\\s)${escapedAttr}\\s*=\\s*["'][^"']*["']`);
          if (attrRe.test(openTag)) {
            return `${openTag.replace(attrRe, (_m, ws: string) => `${ws}${attrName}="${attrVal}"`)}${close}`;
          }
          return `${openTag} ${attrName}="${attrVal}"${close}`;
        });
      } else {
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `SVG adapter does not support op '${op.op}'.`);
      }
    }
    return {
      buffer: Buffer.from(text, 'utf8'),
      summary: `Updated SVG (${operations.length} op${operations.length === 1 ? '' : 's'})`,
    };
  }

  verify(buffer: Buffer, _meta: AdapterFileMeta): AdapterVerifyResult {
    const text = buffer.toString('utf8');
    const issues: AdapterVerifyIssue[] = [];
    if (!/<svg\b/i.test(text) || !/<\/svg\s*>/i.test(text)) {
      issues.push({ severity: 'error', code: 'SVG_INVALID_ROOT', message: 'Missing <svg> root or closing </svg> tag.' });
    }
    if (!/viewBox\s*=\s*["'][^"']+["']/i.test(text)) {
      issues.push({ severity: 'warning', code: 'SVG_MISSING_VIEWBOX', message: 'SVG is missing viewBox attribute.' });
    }
    if (/<script\b/i.test(text)) {
      issues.push({ severity: 'error', code: 'SVG_DANGEROUS_SCRIPT', message: 'Dangerous <script> element detected in SVG.' });
    }
    if (/<foreignObject\b/i.test(text)) {
      issues.push({ severity: 'warning', code: 'SVG_FOREIGN_OBJECT', message: '<foreignObject> detected in SVG.' });
    }
    if (/\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text)) {
      issues.push({ severity: 'error', code: 'SVG_DANGEROUS_HANDLER', message: 'Inline event handler or javascript: URI detected.' });
    }
    return {
      ok: !issues.some((i) => i.severity === 'error'),
      issues,
    };
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
      const matches = extractSvgElements(text).filter((el) => el.id === elementId);
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
      return { status: 'resolved', resolvedSnippet: el.rawMatch };
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
