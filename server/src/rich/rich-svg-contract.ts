import type { RichSvgDef, RichSvgElement } from '../../../shared/rich-schema.js';

export const SVG_TAGS = new Set(['g', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan']);
export const SVG_ATTRS = new Set([
  'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points', 'd',
  'transform', 'fill', 'stroke', 'strokeWidth', 'strokeDasharray', 'strokeLinecap', 'strokeLinejoin',
  'opacity', 'fillOpacity', 'strokeOpacity', 'fontSize', 'fontWeight', 'textAnchor', 'dominantBaseline',
  'markerStart', 'markerEnd', 'clipPath',
]);

const paints = new Set(['fill', 'stroke', 'stopColor']);
const referenceAttrs = new Set(['markerStart', 'markerEnd', 'clipPath']);
const opacityAttrs = new Set(['opacity', 'fillOpacity', 'strokeOpacity']);
const protectedPaint = /^(?:[a-zA-Z]+|#[a-fA-F0-9]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.,% +\/-]+\)|var\(--(?:rich-series[1-6]|text-primary|text-secondary|text-muted|link-color|bg-surface|bg-subtle|accent|ok|warn|danger|border)\))$/;
export const svgLocalRef = /^url\(#([a-zA-Z_][\w-]*)\)$/;
const svgId = /^[a-zA-Z_][\w-]*$/;

export function validSvgViewBox(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const numbers = value.trim().split(/\s*,\s*|\s+/);
  return numbers.length === 4 && numbers.every(part => /^-?\d+(?:\.\d+)?$/.test(part) && Number.isFinite(Number(part))) &&
    Number(numbers[2]) > 0 && Number(numbers[3]) > 0;
}

export function validateSvgAttrValue(name: string, value: unknown, defs: ReadonlySet<string>): string | null {
  if (value == null) return null;
  const error = `Invalid SVG attribute value for '${name}'.`;
  if (opacityAttrs.has(name)) return typeof value === 'number' && value >= 0 && value <= 1 ? null : error;
  if (typeof value === 'number') return Number.isFinite(value) && !paints.has(name) && !referenceAttrs.has(name) && name !== 'd' ? null : error;
  if (typeof value !== 'string' || value.length > 50_000) return error;
  const raw = value.trim();
  if (name === 'd') return /^[Mm][MmZzLlHhVvCcSsQqTtAaEe0-9 .,+\s-]*$/.test(raw) ? null : error;
  const ref = svgLocalRef.exec(raw);
  if (ref) return (referenceAttrs.has(name) || name === 'fill' || name === 'stroke') && defs.has(ref[1]) ? null : error;
  if (referenceAttrs.has(name)) return raw === 'none' ? null : error;
  if (paints.has(name)) return protectedPaint.test(raw) ? null : error;
  if (name === 'offset') return /^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(raw) &&
    parseFloat(raw) <= (raw.endsWith('%') ? 100 : 1) ? null : error;
  return /[\\;{}<>]|url\s*\(|(?:https?|data|blob|javascript|vbscript):|expression\s*\(|@import/i.test(raw) ? error : null;
}

export function isSvgDefinition(def: unknown): def is RichSvgDef {
  if (!def || typeof def !== 'object' || !('kind' in def) || !('id' in def) ||
      typeof def.id !== 'string' || !svgId.test(def.id)) return false;
  const d = def as RichSvgDef;
  switch (d.kind) {
    case 'linearGradient':
    case 'radialGradient':
      return Array.isArray(d.stops) && d.stops.length > 0 && d.stops.every(stop =>
        stop && typeof stop.offset === 'string' && stop.color != null);
    case 'marker':
      return validSvgViewBox(d.viewBox) && typeof d.pathD === 'string' &&
        Number.isFinite(d.refX) && Number.isFinite(d.refY) &&
        Number.isFinite(d.markerWidth) && d.markerWidth > 0 && Number.isFinite(d.markerHeight) && d.markerHeight > 0 &&
        (d.orient === undefined || Number.isFinite(d.orient) || d.orient === 'auto' || d.orient === 'auto-start-reverse');
    case 'clipPath':
      return ['rect', 'circle', 'polygon'].includes(d.shape) && !!d.attrs && typeof d.attrs === 'object' && !Array.isArray(d.attrs);
    default:
      return false;
  }
}

export function svgDefinitionElementCount(def: RichSvgDef): number {
  return def.kind === 'linearGradient' || def.kind === 'radialGradient' ? 1 + def.stops.length : 2;
}

export function visitSvgDefinitionValues(def: RichSvgDef, visit: (name: string, value: unknown, field: string) => void): void {
  if (def.kind === 'linearGradient' || def.kind === 'radialGradient') {
    const positions = def.kind === 'linearGradient'
      ? { x1: def.x1, y1: def.y1, x2: def.x2, y2: def.y2 } : { cx: def.cx, cy: def.cy, r: def.r };
    for (const [name, value] of Object.entries(positions)) {
      if (value !== undefined) visit(name, value, name);
    }
    def.stops.forEach((stop, i) => {
      visit('offset', stop.offset, `stops[${i}].offset`);
      visit('stopColor', stop.color, `stops[${i}].color`);
      if (stop.opacity !== undefined) visit('opacity', stop.opacity, `stops[${i}].opacity`);
    });
  } else if (def.kind === 'marker') {
    visit('d', def.pathD, 'pathD');
    if (def.fill !== undefined) visit('fill', def.fill, 'fill');
  } else {
    for (const [name, value] of Object.entries(def.attrs)) visit(name, value, `attrs.${name}`);
  }
}

function svgHasActions(elements: RichSvgElement[]): boolean {
  const pending = [...elements];
  while (pending.length) {
    const element = pending.pop();
    if (!element) continue;
    if (Array.isArray(element.onClick) && element.onClick.length) return true;
    if (Array.isArray(element.children)) {
      for (const child of element.children) pending.push(child);
    }
  }
  return false;
}

export function svgRoleMatchesActions(role: unknown, elements: RichSvgElement[]): boolean {
  if (role !== undefined && role !== 'diagram' && role !== 'wireframe' && role !== 'interactive') return false;
  return (role === 'interactive') === svgHasActions(elements);
}
