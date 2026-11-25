import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterOperation,
  AdapterVerifyCheck,
  AdapterVerifyIssue,
  AdapterVerifyResult,
  OperationCapability,
  TargetResolutionResult,
  TargetSelector,
} from '../types.js';
import { sha256Buffer, sha256Text, splitLines, type AdapterCapabilityContext, type AdapterFileMeta, type FormatAdapter } from './base.js';
import { validateXmlWellFormedness, type XmlParsedElement } from './xml-validator.js';

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type Matrix2D = [number, number, number, number, number, number];

const IDENTITY_MATRIX: Matrix2D = [1, 0, 0, 1, 0, 0];

const NON_RENDERED_SVG_CONTAINERS = new Set([
  'defs',
  'clippath',
  'mask',
  'symbol',
  'pattern',
  'marker',
  'style',
  'title',
  'desc',
  'metadata',
  'lineargradient',
  'radialgradient',
  'filter',
]);

function multiplyMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function parseSvgTransform(raw: string | undefined): Matrix2D | null {
  if (!raw || !raw.trim()) return IDENTITY_MATRIX;
  let current: Matrix2D = IDENTITY_MATRIX;
  const opRe = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let matchedAny = false;
  for (const m of raw.matchAll(opRe)) {
    matchedAny = true;
    const fn = m[1].toLowerCase();
    const nums = (m[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (nums.some((v) => !Number.isFinite(v))) return null;
    let next: Matrix2D;
    if (fn === 'translate') {
      next = [1, 0, 0, 1, nums[0] ?? 0, nums[1] ?? 0];
    } else if (fn === 'scale') {
      const sx = nums[0] ?? 1;
      const sy = nums[1] ?? sx;
      next = [sx, 0, 0, sy, 0, 0];
    } else if (fn === 'rotate') {
      const deg = nums[0] ?? 0;
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rot: Matrix2D = [cos, sin, -sin, cos, 0, 0];
      if (nums.length >= 3) {
        const cx = nums[1];
        const cy = nums[2];
        next = multiplyMatrix(multiplyMatrix([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
      } else {
        next = rot;
      }
    } else if (fn === 'matrix' && nums.length === 6) {
      next = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
    } else {
      return null;
    }
    current = multiplyMatrix(current, next);
  }
  return matchedAny ? current : null;
}

function transformBBox(box: BBox, m: Matrix2D): BBox {
  const corners: Array<[number, number]> = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.minX, box.maxY],
    [box.maxX, box.maxY],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    const tx = m[0] * x + m[2] * y + m[4];
    const ty = m[1] * x + m[3] * y + m[5];
    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tx > maxX) maxX = tx;
    if (ty > maxY) maxY = ty;
  }
  return { minX, minY, maxX, maxY };
}

function parseSvgNumber(raw: string | undefined, fallback = 0): number | null {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  // Reject percentage units for absolute bbox calculation
  if (trimmed.endsWith('%')) return null;
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(?:px|pt|pc|mm|cm|in|em|rem)?$/i.exec(trimmed);
  if (!m) return null;
  const val = Number(m[1]);
  return Number.isFinite(val) ? val : null;
}

function parseStyleProp(style: string | undefined, prop: string): string | undefined {
  if (!style) return undefined;
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, 'i').exec(style);
  return m ? m[1].trim() : undefined;
}

function parsePathBBox(d: string): BBox | null {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const nextNum = (): number | null => {
    if (i >= tokens.length) return null;
    const val = Number(tokens[i]);
    if (!Number.isFinite(val)) return null;
    i += 1;
    return val;
  };

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) {
      cmd = tokens[i++];
    } else if (!cmd) {
      return null;
    }
    const lower = cmd.toLowerCase();
    const rel = cmd === lower;
    if (lower === 'z') {
      cx = startX;
      cy = startY;
      include(cx, cy);
      cmd = '';
      continue;
    }
    if (lower === 'm' || lower === 'l' || lower === 't') {
      const x = nextNum();
      const y = nextNum();
      if (x === null || y === null) return null;
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      if (lower === 'm') {
        startX = cx;
        startY = cy;
        cmd = rel ? 'l' : 'L';
      }
      include(cx, cy);
    } else if (lower === 'h') {
      const x = nextNum();
      if (x === null) return null;
      cx = rel ? cx + x : x;
      include(cx, cy);
    } else if (lower === 'v') {
      const y = nextNum();
      if (y === null) return null;
      cy = rel ? cy + y : y;
      include(cx, cy);
    } else if (lower === 'c') {
      const x1 = nextNum();
      const y1 = nextNum();
      const x2 = nextNum();
      const y2 = nextNum();
      const x = nextNum();
      const y = nextNum();
      if (x1 === null || y1 === null || x2 === null || y2 === null || x === null || y === null) return null;
      include(rel ? cx + x1 : x1, rel ? cy + y1 : y1);
      include(rel ? cx + x2 : x2, rel ? cy + y2 : y2);
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      include(cx, cy);
    } else if (lower === 's' || lower === 'q') {
      const x1 = nextNum();
      const y1 = nextNum();
      const x = nextNum();
      const y = nextNum();
      if (x1 === null || y1 === null || x === null || y === null) return null;
      include(rel ? cx + x1 : x1, rel ? cy + y1 : y1);
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      include(cx, cy);
    } else if (lower === 'a') {
      const rx = nextNum();
      const ry = nextNum();
      const rot = nextNum();
      const large = nextNum();
      const sweep = nextNum();
      const x = nextNum();
      const y = nextNum();
      if (rx === null || ry === null || rot === null || large === null || sweep === null || x === null || y === null) {
        return null;
      }
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      include(cx, cy);
    } else {
      return null;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function computeLocalSvgElementBBox(el: XmlParsedElement, fullText: string): BBox | null {
  const tag = el.localName.toLowerCase();
  const a = el.attrs;
  if (tag === 'rect' || tag === 'image') {
    const x = parseSvgNumber(a.x, 0);
    const y = parseSvgNumber(a.y, 0);
    const w = parseSvgNumber(a.width, 0);
    const h = parseSvgNumber(a.height, 0);
    if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
    return { minX: x, minY: y, maxX: x + w, maxY: y + h };
  }
  if (tag === 'circle') {
    const cx = parseSvgNumber(a.cx, 0);
    const cy = parseSvgNumber(a.cy, 0);
    const r = parseSvgNumber(a.r, 0);
    if (cx === null || cy === null || r === null || r <= 0) return null;
    return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
  }
  if (tag === 'ellipse') {
    const cx = parseSvgNumber(a.cx, 0);
    const cy = parseSvgNumber(a.cy, 0);
    const rx = parseSvgNumber(a.rx, 0);
    const ry = parseSvgNumber(a.ry, 0);
    if (cx === null || cy === null || rx === null || ry === null || rx <= 0 || ry <= 0) return null;
    return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
  }
  if (tag === 'line') {
    const x1 = parseSvgNumber(a.x1, 0);
    const y1 = parseSvgNumber(a.y1, 0);
    const x2 = parseSvgNumber(a.x2, 0);
    const y2 = parseSvgNumber(a.y2, 0);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    const sw = Math.max(1, parseSvgNumber(a['stroke-width'] ?? parseStyleProp(a.style, 'stroke-width'), 1) ?? 1) / 2;
    return {
      minX: Math.min(x1, x2) - sw,
      minY: Math.min(y1, y2) - sw,
      maxX: Math.max(x1, x2) + sw,
      maxY: Math.max(y1, y2) + sw,
    };
  }
  if (tag === 'polygon' || tag === 'polyline') {
    const nums = (a.points ?? '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
    if (nums.length < 4 || nums.some((v) => !Number.isFinite(v))) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      minX = Math.min(minX, nums[i]);
      maxX = Math.max(maxX, nums[i]);
      minY = Math.min(minY, nums[i + 1]);
      maxY = Math.max(maxY, nums[i + 1]);
    }
    return { minX, minY, maxX, maxY };
  }
  if (tag === 'path') {
    return a.d ? parsePathBBox(a.d) : null;
  }
  if (tag === 'text') {
    const label = fullText.trim();
    if (!label) return null;
    const x = parseSvgNumber(a.x, 0);
    const y = parseSvgNumber(a.y, 0);
    const fs = parseSvgNumber(a['font-size'] ?? parseStyleProp(a.style, 'font-size'), 16);
    if (x === null || y === null || fs === null || fs <= 0) return null;
    let estUnits = 0;
    for (const ch of label) {
      estUnits += ch.charCodeAt(0) > 0x2e80 ? 1.0 : 0.58;
    }
    const width = Math.max(fs * 0.6, estUnits * fs);
    const height = fs * 1.1;
    const anchor = (a['text-anchor'] ?? parseStyleProp(a.style, 'text-anchor') ?? 'start').toLowerCase();
    let minX = x;
    if (anchor === 'middle') minX = x - width / 2;
    else if (anchor === 'end') minX = x - width;
    // SVG text y is baseline; box extends roughly 0.85*fs above and 0.25*fs below
    return { minX, minY: y - fs * 0.85, maxX: minX + width, maxY: y + fs * 0.25 + (height - fs * 1.1) };
  }
  return null;
}

function bboxArea(b: BBox): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
}

function bboxContains(outer: BBox, inner: BBox, tol = 2): boolean {
  return (
    inner.minX >= outer.minX - tol &&
    inner.minY >= outer.minY - tol &&
    inner.maxX <= outer.maxX + tol &&
    inner.maxY <= outer.maxY + tol
  );
}

function bboxIntersection(a: BBox, b: BBox): { width: number; height: number } {
  const width = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const height = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

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
    const checks: AdapterVerifyCheck[] = [];

    // 1. XML 1.0 well-formedness + root <svg> validation
    const xml = validateXmlWellFormedness(text);
    issues.push(...xml.issues);
    const hasValidSvgRoot = xml.rootLocalName !== null && xml.rootLocalName.toLowerCase() === 'svg';
    if (!hasValidSvgRoot) {
      issues.push({
        severity: 'error',
        code: 'SVG_INVALID_ROOT',
        message: xml.rootTag
          ? `Expected <svg> root element, found <${xml.rootTag}>.`
          : 'Missing <svg> root element.',
        location: 'line:1',
      });
    }
    const xmlErrors = issues.filter((i) => i.severity === 'error').length;
    checks.push({
      id: 'svg_xml_syntax',
      status: xml.ok && hasValidSvgRoot ? 'passed' : 'failed',
      evidence:
        xml.ok && hasValidSvgRoot
          ? `Validated well-formed SVG XML (${xml.elementCount} element(s)).`
          : `Detected ${xmlErrors} XML/root error(s).`,
    });

    // 2. viewBox presence and validity
    const rootEl = xml.elements.find((e) => e.depth === 0 && e.localName.toLowerCase() === 'svg') ?? null;
    const rawViewBox = rootEl?.attrs.viewBox ?? rootEl?.attrs.viewbox;
    let viewBoxRect: BBox | null = null;
    let viewBoxIssues = 0;
    if (rawViewBox === undefined) {
      viewBoxIssues += 1;
      issues.push({
        severity: 'warning',
        code: 'SVG_MISSING_VIEWBOX',
        message: 'SVG is missing viewBox attribute.',
        location: rootEl ? `line:${rootEl.line}` : 'line:1',
      });
    } else {
      const parts = rawViewBox.trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v)) || parts[2] <= 0 || parts[3] <= 0) {
        viewBoxIssues += 1;
        issues.push({
          severity: 'error',
          code: 'SVG_INVALID_VIEWBOX',
          message: `Invalid SVG viewBox '${rawViewBox}'; expected 4 finite numbers with positive width and height.`,
          location: rootEl ? `line:${rootEl.line}` : 'line:1',
        });
      } else {
        viewBoxRect = {
          minX: parts[0],
          minY: parts[1],
          maxX: parts[0] + parts[2],
          maxY: parts[1] + parts[3],
        };
      }
    }
    checks.push({
      id: 'svg_viewbox',
      status: viewBoxIssues === 0 ? 'passed' : 'failed',
      evidence:
        viewBoxRect !== null
          ? `Valid viewBox (${viewBoxRect.minX} ${viewBoxRect.minY} ${viewBoxRect.maxX - viewBoxRect.minX} ${viewBoxRect.maxY - viewBoxRect.minY}).`
          : rawViewBox === undefined
            ? 'Missing viewBox attribute.'
            : `Malformed viewBox '${rawViewBox}'.`,
    });

    // 3. XSS / dangerous elements, handlers, and URIs
    let securityErrors = 0;
    let securityWarnings = 0;
    const securityDetected = new Set<string>();
    const addSec = (severity: 'error' | 'warning', code: string, message: string, location: string) => {
      const key = `${code}|${location}|${message}`;
      if (securityDetected.has(key)) return;
      securityDetected.add(key);
      if (severity === 'error') securityErrors += 1;
      else securityWarnings += 1;
      issues.push({ severity, code, message, location });
    };

    for (const el of xml.elements) {
      const lowerTag = el.localName.toLowerCase();
      const loc = `line:${el.line}`;
      if (lowerTag === 'script') {
        addSec('error', 'SVG_DANGEROUS_SCRIPT', 'Dangerous <script> element detected in SVG.', loc);
      } else if (lowerTag === 'foreignobject') {
        addSec('warning', 'SVG_FOREIGN_OBJECT', '<foreignObject> detected in SVG.', loc);
      }
      for (const [attrName, attrVal] of Object.entries(el.attrs)) {
        const lowerAttr = attrName.toLowerCase();
        if (/^on[a-z]+$/.test(lowerAttr)) {
          addSec('error', 'SVG_DANGEROUS_HANDLER', `Inline event handler '${attrName}' detected on <${el.tag}>.`, loc);
        }
        if (
          lowerAttr === 'href' ||
          lowerAttr === 'xlink:href' ||
          lowerAttr === 'src' ||
          lowerAttr === 'action' ||
          lowerAttr === 'formaction'
        ) {
          const v = attrVal.trim().toLowerCase();
          if (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html')) {
            addSec('error', 'SVG_DANGEROUS_HANDLER', `Dangerous URI in '${attrName}' on <${el.tag}>.`, loc);
          }
        }
        if (lowerAttr === 'style' && /(?:javascript:|expression\s*\()/i.test(attrVal)) {
          addSec('error', 'SVG_DANGEROUS_HANDLER', `Dangerous expression or javascript: URI in style attribute on <${el.tag}>.`, loc);
        }
      }
      if ((lowerTag === 'animate' || lowerTag === 'set') && el.attrs.attributeName) {
        const targetAttr = el.attrs.attributeName.trim().toLowerCase();
        if (targetAttr === 'href' || targetAttr === 'xlink:href' || /^on[a-z]+$/.test(targetAttr)) {
          addSec('error', 'SVG_DANGEROUS_HANDLER', `Animation element <${el.tag}> targets dangerous attribute '${el.attrs.attributeName}'.`, loc);
        }
      }
    }
    // Fallback raw scan if XML parsing aborted early before scanning the entire file
    if (!xml.ok) {
      if (/<script\b/i.test(text) && securityErrors === 0) {
        addSec('error', 'SVG_DANGEROUS_SCRIPT', 'Dangerous <script> element detected in SVG.', 'line:1');
      }
      if ((/\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text)) && securityErrors === 0) {
        addSec('error', 'SVG_DANGEROUS_HANDLER', 'Inline event handler or javascript: URI detected.', 'line:1');
      }
    }
    checks.push({
      id: 'svg_security',
      status: securityErrors === 0 && securityWarnings === 0 ? 'passed' : 'failed',
      evidence:
        securityErrors === 0 && securityWarnings === 0
          ? 'No <script>, inline event handlers, dangerous URIs, or <foreignObject> detected.'
          : `Detected ${securityErrors} security error(s) and ${securityWarnings} warning(s).`,
    });

    // 4. Geometric overlap and viewBox bounds verification
    const byIndex = new Map<number, XmlParsedElement>();
    for (const el of xml.elements) byIndex.set(el.index, el);

    // Aggregate <tspan> text into parent <text> elements
    const aggregatedText = new Map<number, string>();
    for (const el of xml.elements) {
      if (el.localName.toLowerCase() === 'text') {
        aggregatedText.set(el.index, el.textContent);
      }
    }
    for (const el of xml.elements) {
      if (el.localName.toLowerCase() === 'tspan') {
        let p = el.parentIndex;
        while (p !== null) {
          const parentEl = byIndex.get(p);
          if (!parentEl) break;
          if (parentEl.localName.toLowerCase() === 'text') {
            aggregatedText.set(parentEl.index, `${aggregatedText.get(parentEl.index) ?? ''} ${el.textContent}`.trim());
            break;
          }
          p = parentEl.parentIndex;
        }
      }
    }

    const isHiddenOrNonRendered = (el: XmlParsedElement): boolean => {
      let cur: XmlParsedElement | undefined = el;
      while (cur) {
        const lt = cur.localName.toLowerCase();
        if (NON_RENDERED_SVG_CONTAINERS.has(lt)) return true;
        const display = (cur.attrs.display ?? parseStyleProp(cur.attrs.style, 'display') ?? '').toLowerCase();
        const vis = (cur.attrs.visibility ?? parseStyleProp(cur.attrs.style, 'visibility') ?? '').toLowerCase();
        const op = cur.attrs.opacity ?? parseStyleProp(cur.attrs.style, 'opacity');
        if (display === 'none' || vis === 'hidden' || op === '0') return true;
        cur = cur.parentIndex !== null ? byIndex.get(cur.parentIndex) : undefined;
      }
      return false;
    };

    const cumulativeTransform = (el: XmlParsedElement): Matrix2D | null => {
      const chain: XmlParsedElement[] = [];
      let cur: XmlParsedElement | undefined = el;
      while (cur) {
        chain.push(cur);
        cur = cur.parentIndex !== null ? byIndex.get(cur.parentIndex) : undefined;
      }
      chain.reverse();
      let mat: Matrix2D = IDENTITY_MATRIX;
      for (const node of chain) {
        if (node.attrs.transform) {
          const parsed = parseSvgTransform(node.attrs.transform);
          if (!parsed) return null;
          mat = multiplyMatrix(mat, parsed);
        }
      }
      return mat;
    };

    interface MeasuredSvgItem {
      el: XmlParsedElement;
      tag: string;
      isText: boolean;
      isWireframe: boolean;
      isCanvasBg: boolean;
      bbox: BBox;
    }

    const SHAPE_TAGS = new Set(['rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'path', 'image', 'text']);
    const measured: MeasuredSvgItem[] = [];
    let unmeasurableCount = 0;
    const viewBoxArea = viewBoxRect ? bboxArea(viewBoxRect) : 0;

    if (xml.ok && hasValidSvgRoot) {
      for (const el of xml.elements) {
        const lt = el.localName.toLowerCase();
        if (isHiddenOrNonRendered(el)) continue;
        if (lt === 'use') {
          unmeasurableCount += 1;
          continue;
        }
        if (!SHAPE_TAGS.has(lt)) continue;
        const mat = cumulativeTransform(el);
        const localBox = computeLocalSvgElementBBox(el, lt === 'text' ? (aggregatedText.get(el.index) ?? el.textContent) : '');
        if (!mat || !localBox) {
          // Empty <text></text> is benign; other unmeasurable primitives reduce coverage
          if (!(lt === 'text' && !(aggregatedText.get(el.index) ?? el.textContent).trim())) {
            unmeasurableCount += 1;
          }
          continue;
        }
        const worldBox = transformBBox(localBox, mat);
        const fill = (el.attrs.fill ?? parseStyleProp(el.attrs.style, 'fill') ?? '').trim().toLowerCase();
        const isWireframe = fill === 'none' || fill === 'transparent';
        const isCanvasBg =
          lt === 'rect' && viewBoxArea > 0 && bboxArea(worldBox) >= viewBoxArea * 0.85;
        measured.push({
          el,
          tag: lt,
          isText: lt === 'text',
          isWireframe,
          isCanvasBg,
          bbox: worldBox,
        });
      }
    }

    let overlapPairs = 0;
    let textOverlapPairs = 0;
    let outOfViewBoxCount = 0;
    const MAX_OVERLAP_ELEMENTS = 400;
    const overlapBudgetExceeded = measured.length > MAX_OVERLAP_ELEMENTS;

    if (xml.ok && hasValidSvgRoot && !overlapBudgetExceeded) {
      // Check out-of-viewBox bounds
      if (viewBoxRect) {
        for (const item of measured) {
          if (item.isCanvasBg) continue;
          if (
            item.bbox.minX < viewBoxRect.minX - 1 ||
            item.bbox.minY < viewBoxRect.minY - 1 ||
            item.bbox.maxX > viewBoxRect.maxX + 1 ||
            item.bbox.maxY > viewBoxRect.maxY + 1
          ) {
            outOfViewBoxCount += 1;
            const idLabel = item.el.attrs.id ? `#${item.el.attrs.id}` : `<${item.tag}>`;
            issues.push({
              severity: 'warning',
              code: 'SVG_OUT_OF_VIEWBOX',
              message: `Element ${idLabel} extends outside the SVG viewBox bounds.`,
              location: `line:${item.el.line}`,
            });
          }
        }
      }

      // Pairwise overlap detection
      const candidates = measured.filter((m) => !m.isCanvasBg);
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const a = candidates[i];
          const b = candidates[j];
          const inter = bboxIntersection(a.bbox, b.bbox);
          if (inter.width <= 2 || inter.height <= 2) continue;

          const aLabel = a.el.attrs.id ? `#${a.el.attrs.id}` : `<${a.tag}@L${a.el.line}>`;
          const bLabel = b.el.attrs.id ? `#${b.el.attrs.id}` : `<${b.tag}@L${b.el.line}>`;

          if (a.isText && b.isText) {
            textOverlapPairs += 1;
            overlapPairs += 1;
            issues.push({
              severity: 'warning',
              code: 'SVG_TEXT_OVERLAP',
              message: `Text elements ${aLabel} and ${bLabel} overlap (${inter.width.toFixed(1)}x${inter.height.toFixed(1)}).`,
              location: `line:${a.el.line}`,
            });
          } else if (a.isText !== b.isText) {
            const textItem = a.isText ? a : b;
            const shapeItem = a.isText ? b : a;
            // Allow intentional text labels cleanly centered/contained inside a box/shape
            if (shapeItem.tag !== 'line' && bboxContains(shapeItem.bbox, textItem.bbox, 2)) {
              continue;
            }
            // Flag partial boundary clipping between text and shape
            if (inter.width > 3 && inter.height > 3) {
              overlapPairs += 1;
              issues.push({
                severity: 'warning',
                code: 'SVG_TEXT_SHAPE_OVERLAP',
                message: `Text ${textItem.el.attrs.id ? `#${textItem.el.attrs.id}` : `<text@L${textItem.el.line}>`} partially clips shape ${shapeItem.el.attrs.id ? `#${shapeItem.el.attrs.id}` : `<${shapeItem.tag}@L${shapeItem.el.line}>`}.`,
                location: `line:${textItem.el.line}`,
              });
            }
          } else {
            // Shape vs shape: skip lines/connectors and wireframe frames containing inner items
            if (a.tag === 'line' || b.tag === 'line') continue;
            if ((a.isWireframe && bboxContains(a.bbox, b.bbox, 2)) || (b.isWireframe && bboxContains(b.bbox, a.bbox, 2))) {
              continue;
            }
            overlapPairs += 1;
            issues.push({
              severity: 'warning',
              code: 'SVG_ELEMENT_OVERLAP',
              message: `Shapes ${aLabel} and ${bLabel} overlap (${inter.width.toFixed(1)}x${inter.height.toFixed(1)}).`,
              location: `line:${a.el.line}`,
            });
          }
        }
      }
    }

    const overlapStatus: AdapterVerifyCheck['status'] =
      !xml.ok || !hasValidSvgRoot
        ? 'unverified'
        : overlapPairs > 0 || outOfViewBoxCount > 0
          ? 'failed'
          : overlapBudgetExceeded || unmeasurableCount > 0
            ? 'unverified'
            : 'passed';

    checks.push({
      id: 'svg_overlap',
      status: overlapStatus,
      evidence:
        !xml.ok || !hasValidSvgRoot
          ? 'Skipped geometric overlap inspection because SVG XML is malformed.'
          : overlapBudgetExceeded
            ? `Skipped pairwise overlap check because ${measured.length} elements exceed the ${MAX_OVERLAP_ELEMENTS}-element inspection cap.`
            : `Inspected ${measured.length} measurable element(s) (${unmeasurableCount} unmeasurable); overlaps: ${overlapPairs} (text overlaps: ${textOverlapPairs}), out-of-viewBox: ${outOfViewBoxCount}.`,
    });

    return {
      ok: !issues.some((i) => i.severity === 'error'),
      coverage: checks.some((c) => c.status === 'unverified') ? 'partial' : 'complete',
      checks,
      issues,
      metrics: {
        elementCount: xml.elementCount,
        measuredElements: measured.length,
        unmeasurableElements: unmeasurableCount,
        overlapPairs,
        textOverlapPairs,
        outOfViewBoxCount,
      },
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
