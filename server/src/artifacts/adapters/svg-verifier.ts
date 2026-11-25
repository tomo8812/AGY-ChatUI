import type { AdapterVerifyCheck, AdapterVerifyIssue, AdapterVerifyResult } from '../types.js';
import {
  decodeVerificationText, MAX_VERIFY_DIAGNOSTICS, textVerificationReport, verificationMessage,
} from './text-verification.js';
import { validateXmlWellFormedness } from './xml-validator.js';

export const SVG_VERIFICATION_CHECKS: [string, ...string[]] = [
  'svg_encoding', 'svg_xml_syntax', 'svg_viewbox', 'svg_security', 'svg_overlap', 'svg_bounds',
];

const SVG_NS = 'http://www.w3.org/2000/svg';
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const LENGTH = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(?:px)?$/i;
const NON_RENDERED = new Set([
  'defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker', 'title', 'desc', 'metadata',
  'linearGradient', 'radialGradient', 'filter',
]);
const COMMON_UNMEASURED_EFFECTS = [
  'style', 'clip', 'clip-path', 'mask', 'filter', 'transform-origin', 'transform-box', 'vector-effect',
  'marker', 'marker-start', 'marker-mid', 'marker-end', 'stroke-dasharray', 'fill-opacity', 'color', 'class',
];
const PAINT_URL_ATTRIBUTES = new Set(['fill', 'stroke', 'clip-path', 'filter', 'mask', 'marker', 'marker-start', 'marker-end', 'marker-mid']);
const ANIMATION = new Set(['animate', 'animateMotion', 'animateTransform', 'set']);
const MAX_OVERLAP_SHAPES = 400;
const MAX_PROJECTIONS = 2_000_000;
const MAX_TRANSFORM_OPERATIONS = 64;

type Matrix = [number, number, number, number, number, number];
type Point = [number, number];
interface Box { x: number; y: number; width: number; height: number }
interface Shape { corners: Point[]; box: Box; label: string; line: number; isRect: boolean }
interface State { matrix: Matrix; display: boolean; visibility: boolean; unsupported: boolean; stroke: string; fill: string }

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const ROOT: State = { matrix: IDENTITY, display: true, visibility: true, unsupported: false, stroke: 'none', fill: 'black' };

function finiteNumbers(text: string): number[] | undefined {
  const words = text.trim().split(/\s*,\s*|\s+/);
  if (words.some((word) => !NUMBER.test(word))) return undefined;
  const numbers = words.map(Number);
  return numbers.every(Number.isFinite) ? numbers : undefined;
}

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function transformOperation(name: string, args: number[]): Matrix | undefined {
  const [x, y, z] = args;
  switch (name) {
    case 'matrix':
      if (args.length === 6) return [x, y, z, args[3], args[4], args[5]];
      break;
    case 'translate':
      if (args.length === 1 || args.length === 2) return [1, 0, 0, 1, x, y ?? 0];
      break;
    case 'scale':
      if (args.length === 1 || args.length === 2) return [x, 0, 0, y ?? x, 0, 0];
      break;
    case 'rotate': {
      if (args.length !== 1 && args.length !== 3) break;
      const radians = (x % 360) * Math.PI / 180;
      const cosine = Math.cos(radians);
      const sine = Math.sin(radians);
      const rotation: Matrix = [cosine, sine, -sine, cosine, 0, 0];
      if (args.length === 1) return rotation;
      return multiply(multiply([1, 0, 0, 1, y, z], rotation), [1, 0, 0, 1, -y, -z]);
    }
    case 'skewX':
    case 'skewY': {
      if (args.length !== 1 || Math.abs(x % 180) === 90) break;
      const shear = Math.tan((x % 180) * Math.PI / 180);
      return name === 'skewX' ? [1, 0, shear, 1, 0, 0] : [1, shear, 0, 1, 0, 0];
    }
  }
}

function transform(text: string): Matrix | undefined {
  const source = text.trim();
  if (!source) return IDENTITY;
  if (source.length > 4_096) return undefined;
  let matrix = IDENTITY;
  let end = 0;
  let operations = 0;
  for (const match of source.matchAll(/([A-Za-z]+)\s*\(([^()]*)\)/g)) {
    if (++operations > MAX_TRANSFORM_OPERATIONS) return undefined;
    const gap = source.slice(end, match.index);
    if (end === 0 ? gap.length > 0 : !/^\s*,?\s*$/.test(gap)) return undefined;
    const args = finiteNumbers(match[2]);
    const next = args && transformOperation(match[1], args);
    if (!next) return undefined;
    matrix = multiply(matrix, next);
    end = match.index + match[0].length;
  }
  return end === source.length && matrix.every(Number.isFinite) ? matrix : undefined;
}

function rectangle(attrs: Record<string, string>, matrix: Matrix): { corners: Point[]; box: Box } | undefined {
  const values = ['x', 'y', 'width', 'height'].map((name) => {
    const raw = attrs[name];
    if (raw === undefined) return 0;
    const match = LENGTH.exec(raw.trim());
    return match ? Number(match[1]) : NaN;
  });
  const [x, y, width, height] = values;
  if (!values.every(Number.isFinite) || width < 0 || height < 0) return undefined;
  const corners: Point[] = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  return transformCorners(corners, matrix);
}

function polygon(points: string | undefined, matrix: Matrix): { corners: Point[]; box: Box } | undefined {
  if (points === undefined || points.length > 4_096) return;
  const coordinates = finiteNumbers(points);
  if (!coordinates || coordinates.length < 6 || coordinates.length > 32 || coordinates.length % 2 !== 0) return;
  const vertices: Point[] = [];
  for (let i = 0; i < coordinates.length; i += 2) vertices.push([coordinates[i], coordinates[i + 1]]);
  // A convex outline lies on one side of every edge and can be tested with
  // separating axes. Concave, degenerate, and self-intersecting paths stay unverified.
  for (let i = 0; i < vertices.length; i++) {
    const [x, y] = vertices[i];
    const [nx, ny] = vertices[(i + 1) % vertices.length];
    if (x === nx && y === ny) return;
    const turns = vertices.map(([px, py]) => (nx - x) * (py - y) - (ny - y) * (px - x));
    if (turns.some((turn) => !Number.isFinite(turn))) return;
    if (turns.every((turn) => turn === 0) || (turns.some((turn) => turn < 0) && turns.some((turn) => turn > 0))) return;
  }
  return transformCorners(vertices, matrix);
}

function transformCorners(corners: Point[], matrix: Matrix): { corners: Point[]; box: Box } | undefined {
  for (const point of corners) {
    const [x, y] = point;
    point[0] = matrix[0] * x + matrix[2] * y + matrix[4];
    point[1] = matrix[1] * x + matrix[3] * y + matrix[5];
  }
  if (corners.some((point) => !point.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e9))) return;
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { corners, box: { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top } };
}

function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function intersects(first: Shape, second: Shape): boolean {
  for (const { corners, isRect } of [first, second]) {
    const axes = isRect ? 2 : corners.length;
    for (let i = 0; i < axes; i++) {
      const from = corners[i];
      const to = corners[(i + 1) % corners.length];
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const length = Math.hypot(dx, dy);
      if (!length) return false;
      const normalX = -dy / length;
      const normalY = dx / length;
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const [x, y] of first.corners) {
        const projection = (x - from[0]) * normalX + (y - from[1]) * normalY;
        aMin = Math.min(aMin, projection);
        aMax = Math.max(aMax, projection);
      }
      for (const [x, y] of second.corners) {
        const projection = (x - from[0]) * normalX + (y - from[1]) * normalY;
        bMin = Math.min(bMin, projection);
        bMax = Math.max(bMax, projection);
      }
      if (Math.min(aMax, bMax) - Math.max(aMin, bMin) <= 1e-7) return false;
    }
  }
  return true;
}

function inside(inner: Box, outer: Box): boolean {
  return inner.x >= outer.x - 1e-7 && inner.y >= outer.y - 1e-7 &&
    inner.x + inner.width <= outer.x + outer.width + 1e-7 && inner.y + inner.height <= outer.y + outer.height + 1e-7;
}

export function verifySvg(buffer: Buffer): AdapterVerifyResult {
  const input = decodeVerificationText(buffer, SVG_VERIFICATION_CHECKS);
  if ('report' in input) return input.report;
  const xml = validateXmlWellFormedness(input.text, true);
  const issues = xml.issues;
  const checks: AdapterVerifyCheck[] = [{ id: 'svg_encoding', status: 'passed', evidence: 'Valid UTF-8 with no NUL bytes.' }];
  const issue = (severity: AdapterVerifyIssue['severity'], code: string, message: string, line: number) => {
    if (issues.length < MAX_VERIFY_DIAGNOSTICS) {
      issues.push({ severity, code, message: verificationMessage(message), location: `line:${line}` });
    }
  };

  let status = xml.status;
  if (status === 'passed' && (xml.root?.name !== 'svg' || xml.root.namespace !== SVG_NS)) {
    issue('error', 'SVG_INVALID_ROOT', 'Expected an svg root in the SVG namespace.', xml.root?.line ?? 1);
    status = 'failed';
  }
  checks.push({ id: 'svg_xml_syntax', status, evidence: status !== xml.status ? 'The root is not an SVG element.' : xml.evidence });
  if (status !== 'passed' || !xml.root) {
    for (const id of SVG_VERIFICATION_CHECKS.slice(2)) checks.push({ id, status: 'unverified', evidence: 'Requires successfully parsed SVG XML.' });
    return textVerificationReport(checks, issues);
  }

  const viewBox = xml.root.attrs.viewBox;
  const coordinates = viewBox === undefined ? undefined : finiteNumbers(viewBox);
  const [x, y, width, height] = coordinates ?? [];
  const validViewBox = coordinates?.length === 4 && width >= 0 && height >= 0 &&
    Number.isFinite(x + width) && Number.isFinite(y + height);
  const viewport = validViewBox && width > 0 && height > 0 ? { x, y, width, height } : undefined;
  const renderingDisabled = validViewBox && !viewport;
  if (viewBox !== undefined && !validViewBox) {
    issue('error', 'SVG_INVALID_VIEWBOX', 'viewBox requires four finite coordinates and nonnegative dimensions.', xml.root.line);
  }
  checks.push({
    id: 'svg_viewbox',
    status: validViewBox ? 'passed' : viewBox === undefined ? 'unverified' : 'failed',
    evidence: renderingDisabled ? 'A zero viewBox dimension disables rendering.' : validViewBox ? 'Parsed a finite root viewBox.'
      : viewBox === undefined ? 'Valid SVG can omit viewBox; viewport bounds are not inferred.' : 'Invalid root viewBox.',
  });

  let securityFindings = 0;
  const securityUnknown = new Set<string>();
  const exclusions = new Set<string>();
  if (xml.hasStylesheet || xml.elements.some((element) => element.namespace === SVG_NS && (element.name === 'style' || ANIMATION.has(element.name)))) {
    securityUnknown.add('stylesheets or animation');
    exclusions.add('stylesheets or animation affect computed geometry');
  }

  const states: State[] = [];
  const shapes: Shape[] = [];
  let boundsFindings = 0;
  let excludedElements = 0;
  for (const el of xml.elements) {
    const { attrs, name, namespace, line } = el;
    const flag = (code: string, message: string) => { securityFindings++; issue('error', code, message, line); };
    if (['script', 'foreignObject'].includes(name)) {
      flag(name === 'script' ? 'SVG_DANGEROUS_SCRIPT' : 'SVG_FOREIGN_OBJECT', `Active <${name}> content detected.`);
    }
    if (namespace !== SVG_NS || attrs.style || attrs['xml:base']) securityUnknown.add('foreign markup or inline CSS');
    for (const [key, value] of Object.entries(attrs)) {
      const localName = key.split(':').at(-1)!.toLowerCase();
      const url = value.trim().replace(/[\t\r\n]/g, '');
      const isUrlAttribute = ['href', 'src', 'action', 'formaction'].includes(localName);
      if (/^on[a-z]/.test(localName) || (isUrlAttribute && /^(?:javascript:|vbscript:|data:\s*text\/html)/i.test(url))) {
        flag('SVG_DANGEROUS_HANDLER', `Active content indicator in "${key}" on <${name}>.`);
      }
      if ((isUrlAttribute && url && !url.startsWith('#')) || (PAINT_URL_ATTRIBUTES.has(localName) && /url\s*\(/i.test(url))) {
        securityUnknown.add('linked or embedded resources');
      }
    }

    const parent = el.parentIndex === null ? ROOT : states[el.parentIndex];
    const parsed = attrs.transform === undefined ? IDENTITY : transform(attrs.transform);
    // The outermost svg transform moves the viewport as a whole. Compare its
    // children in the SVG's own viewBox coordinate system.
    const local = el.parentIndex === null && parsed && parsed[0] * parsed[3] - parsed[1] * parsed[2] !== 0 ? IDENTITY : parsed;
    const state: State = {
      matrix: local ? multiply(parent.matrix, local) : parent.matrix,
      display: parent.display && !NON_RENDERED.has(name) && attrs.display?.trim() !== 'none' && !(attrs.opacity?.trim() && Number(attrs.opacity) === 0),
      visibility: attrs.visibility === 'visible' || (attrs.visibility !== 'hidden' && attrs.visibility !== 'collapse' && parent.visibility),
      stroke: attrs.stroke?.trim() ?? parent.stroke,
      fill: attrs.fill?.trim() ?? parent.fill,
      unsupported: parent.unsupported || namespace !== SVG_NS || !local ||
        !['svg', 'g', 'a', 'rect', 'polygon'].includes(name) || (name === 'svg' && el.parentIndex !== null) ||
        COMMON_UNMEASURED_EFFECTS.some((attr) => Object.hasOwn(attrs, attr)),
    };
    states.push(state);
    if (renderingDisabled || !state.display || name === 'style' || ANIMATION.has(name)) continue;
    if (['svg', 'g', 'a'].includes(name) && !state.unsupported) continue;
    if (!state.visibility && !state.unsupported) continue;
    const exclude = (reason: string) => { excludedElements++; exclusions.add(reason); };
    if (exclusions.has('stylesheets or animation affect computed geometry')) {
      exclude('stylesheets or animation affect computed geometry');
      continue;
    }
    if (state.unsupported || state.stroke !== 'none' || attrs.rx !== undefined || attrs.ry !== undefined ||
        /url\s*\(|^(?:currentColor|context-fill|context-stroke|inherit|revert|unset)$/i.test(state.fill)) {
      exclude('unsupported geometry, paint, nested viewport, or transform');
      continue;
    }
    if (['transparent', 'none'].includes(state.fill)) continue;
    const isRect = name === 'rect';
    const geometry = isRect ? rectangle(attrs, state.matrix) : polygon(attrs.points, state.matrix);
    if (!geometry) {
      exclude('unsupported coordinates, units, or polygon outline');
      continue;
    }
    const [a, b, c, d] = state.matrix;
    if (!geometry.box.width || !geometry.box.height || a * d - b * c === 0 ||
        (isRect && (!parseFloat(attrs.width ?? '0') || !parseFloat(attrs.height ?? '0')))) continue;
    const label = attrs.id ? `#${attrs.id}` : `<${name}>`;
    if (viewport && !inside(geometry.box, viewport)) {
      boundsFindings++;
      issue('warning', 'SVG_OUT_OF_VIEWBOX', `Transformed shape ${label} extends outside viewBox.`, line);
    }
    shapes.push({ ...geometry, label, line, isRect });
  }

  let exceeded = shapes.length > MAX_OVERLAP_SHAPES;
  let overlaps = 0;
  let remainingProjections = MAX_PROJECTIONS;
  if (!exceeded) {
    // Treat an initial, axis-aligned, viewport-sized rectangle as an intentional background.
    const first = shapes[0];
    const background = Boolean(viewport && first?.isRect &&
      (first.corners[0][0] === first.corners[1][0] || first.corners[0][1] === first.corners[1][1]) &&
      (first.corners[1][0] === first.corners[2][0] || first.corners[1][1] === first.corners[2][1]) &&
      inside(first.box, viewport) && inside(viewport, first.box));
    for (let i = background ? 1 : 0; i < shapes.length && !exceeded; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const first = shapes[i];
        const second = shapes[j];
        if (!boxesIntersect(first.box, second.box)) continue;
        remainingProjections -= ((first.isRect ? 2 : first.corners.length) + (second.isRect ? 2 : second.corners.length)) *
          (first.corners.length + second.corners.length);
        if (remainingProjections < 0) {
          exceeded = true;
          break;
        }
        if (!intersects(first, second)) continue;
        overlaps++;
        issue('warning', 'SVG_ELEMENT_OVERLAP', `Transformed shapes ${first.label} and ${second.label} intersect.`, first.line);
      }
    }
  }

  function check(id: string, findings: number, unverified: boolean, evidence: string) {
    checks.push({ id, status: findings ? 'failed' : unverified ? 'unverified' : 'passed', evidence });
    if (findings && unverified) checks.push({ id: `${id}_remaining`, status: 'unverified', evidence });
  }
  const exclusionsText = exclusions.size ? ` Excluded ${excludedElements} element(s): ${[...exclusions].join(', ')}.` : '';
  check('svg_security', securityFindings, securityUnknown.size > 0,
    `Static active-content indicators: ${securityFindings}.${securityUnknown.size ? ' Unverified: ' + [...securityUnknown].join(', ') + '.' : ''}`);
  check('svg_overlap', overlaps, exceeded || exclusions.size > 0 || renderingDisabled, renderingDisabled ? 'A zero viewBox dimension disables rendering.' : exceeded
    ? `Pairwise overlap exceeds the ${MAX_OVERLAP_SHAPES}-shape or ${MAX_PROJECTIONS}-projection budget (${overlaps} intersections found before stopping).${exclusionsText}`
    : `Compared ${shapes.length} transformed rectangles and convex polygons (first full-viewBox background exempt); ${overlaps} intersecting pairs.${exclusionsText}`);
  check('svg_bounds', boundsFindings, !viewport || exclusions.size > 0,
    `${viewport ? `Checked ${shapes.length} shape(s) against viewBox: ${boundsFindings} out of bounds.` : 'Requires a usable root viewBox.'}${exclusionsText}`);
  return textVerificationReport(checks, issues, { elementCount: xml.elementCount, measuredElements: shapes.length, excludedElements,
    ...(exceeded ? {} : { overlapPairs: overlaps }), ...(viewport ? { outOfViewBoxCount: boundsFindings } : {}),
  });
}
