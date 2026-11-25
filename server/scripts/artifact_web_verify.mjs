const MAX_FINDINGS = 25;
const MAX_CANDIDATES = 1_200;

function result(checks, issues, metrics) {
  return {
    ok: checks.every(({ status }) => status === 'passed'),
    coverage: checks.some(({ status }) => status === 'unverified') ? 'partial' : 'complete',
    checks, issues: issues.slice(0, MAX_FINDINGS), metrics,
  };
}

export async function verifyHtmlBrowser(page, { entryUrl, browserEntryUrl, authoringUrl, scope, observations }) {
  await page.goto(browserEntryUrl, { waitUntil: 'load', timeout: 7_000 });
  const frame = page.frames().find((item) => item.parentFrame() === page.mainFrame());
  if (!frame) throw new Error('The sandboxed verification frame did not load.');
  // Allow load-triggered scripts and CSP events to settle. The worker deadline
  // still applies if script execution or document loading fails to finish.
  await page.waitForTimeout(350);
  const live = await frame.evaluate((options) => {
    const selected = options.selector ? document.querySelectorAll(options.selector) : [document.documentElement];
    const duplicates = [];
    const seen = new Set();
    let visited = 0;
    let inspected = 0;
    const from = options.elementOffset ?? 0;
    const limit = options.maxElements ?? 10_000;
    let limited = false;
    for (const root of selected) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = root;
      while (node) {
        if (++visited > 10_000) {
          limited = true;
          break;
        }
        if (visited > from && inspected < limit) inspected++;
        if (node.id && visited > from && visited <= from + limit) {
          if (seen.has(node.id) && duplicates.length < 25) duplicates.push(node.id.slice(0, 100));
          seen.add(node.id);
        }
        node = walker.nextNode();
      }
      if (limited) break;
    }
    return { selected: selected.length, visited, inspected, limited: limited || from + inspected < visited || from > 0, duplicates, mode: document.compatMode };
  }, scope);
  // The authoring view loads the revision's assets with JavaScript disabled by
  // CSP, so blocked viewer requests can still be checked against the manifest.
  await page.goto(authoringUrl, { waitUntil: 'load', timeout: 7_000 });
  const checks = [];
  const issues = [];
  function check(id, status, evidence) { checks.push({ id, status, evidence }); }
  function warning(code, message) { issues.push({ severity: 'warning', code, message: message.slice(0, 250) }); }
  for (const violation of observations.violations) warning('HTML_BROWSER_CSP_VIOLATION', `${violation.directive}: ${violation.blocked}`);
  for (const error of observations.errors) warning('HTML_BROWSER_SCRIPT_ERROR', error);
  for (const id of live.duplicates) warning('HTML_BROWSER_DUPLICATE_ID', `Duplicate rendered DOM ID: ${id}.`);
  for (const url of observations.missing) warning('HTML_BROWSER_MISSING_DEPENDENCY', `Missing revision resource: ${url}`);
  for (const url of observations.external) warning('HTML_BROWSER_EXTERNAL_REQUEST', `Request outside revision origin was blocked: ${url}`);
  if (!live.selected && scope.selector) warning('HTML_BROWSER_TARGET_NOT_FOUND', 'The verification selector matched no rendered element.');

  check('html_browser_dom', live.duplicates.length || !live.selected ? 'failed' : live.limited ? 'unverified' : 'passed',
    `Chromium built a ${live.mode} DOM at ${entryUrl}; inspected ${live.inspected} elements with ${live.duplicates.length} duplicate identifiers.`);
  check('html_browser_csp', observations.violations.length || observations.external.size ? 'failed' : observations.ready ? 'passed' : 'unverified',
    `Executed the existing CSP in an opaque sandboxed iframe; ${observations.violations.length} CSP violations and ${observations.external.size} denied external requests during initial load.`);
  check('html_browser_execution', observations.errors.length ? 'failed' : observations.ready ? 'passed' : 'unverified',
    `${observations.errors.length} script errors during load and the 350 ms observation window.`);
  check('html_browser_dependencies', observations.missing.size ? 'failed' : observations.limited ? 'unverified' : 'passed',
    `Offline manifest replay served ${observations.served} resource requests; ${observations.missing.size} requested resources were missing.`);
  if (scope.selector || live.limited || observations.limited) check('html_browser_remaining', 'unverified', 'Inspection was scoped or reached its resource budget.');
  return result(checks, issues, { browser: { elements: live.inspected, violations: observations.violations.length, servedResources: observations.served,
    missingResources: observations.missing.size, mode: live.mode } });
}

export async function verifySvgBrowser(page, entryUrl, scope) {
  await page.goto(entryUrl, { waitUntil: 'load', timeout: 7_000 });
  const observed = await page.evaluate(async ({ scope, maxCandidates }) => {
    await document.fonts.ready;
    const root = document.documentElement;
    if (!(root instanceof SVGSVGElement)) return { invalidRoot: true };
    const rootMatrix = root.getScreenCTM();
    if (!rootMatrix) return { invalidRoot: true };
    const viewport = root.viewBox.baseVal;
    const screen = root.getBoundingClientRect();
    const viewCorners = viewport.width > 0 && viewport.height > 0
      ? [viewport.x, viewport.x + viewport.width].flatMap((x) =>
        [viewport.y, viewport.y + viewport.height].map((y) => new DOMPoint(x, y).matrixTransform(rootMatrix)))
      : [{ x: screen.left, y: screen.top }, { x: screen.right, y: screen.bottom }];
    const bounds = {
      left: Math.min(...viewCorners.map(({ x }) => x)), top: Math.min(...viewCorners.map(({ y }) => y)),
      right: Math.max(...viewCorners.map(({ x }) => x)), bottom: Math.max(...viewCorners.map(({ y }) => y)),
    };
    const selectedRoots = scope.selector ? [...root.querySelectorAll(scope.selector)] : [];
    if (scope.selector && root.matches(scope.selector)) selectedRoots.push(root);
    const all = root.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon,text,use,image,foreignObject');
    const selected = [];
    for (const [index, element] of all.entries()) {
      if (!scope.selector || selectedRoots.some((parent) => parent === element || parent.contains(element))) selected.push(index);
    }
    const start = scope.elementOffset ?? 0;
    const targetWindow = Math.min(scope.maxElements ?? 160, Math.max(1, Math.floor(25_000 / (Math.min(maxCandidates, all.length) + 250))));
    const requested = selected.slice(start, start + targetWindow);
    const wanted = new Set(requested);
    const indices = new Set([...Array.from({ length: Math.min(maxCandidates, all.length) }, (_, index) => index), ...requested]);
    const geometry = [];
    let remainingGlyphs = 20_000;
    let approximate = 0;
    let inspected = 0;
    const visiblePaint = (value) => !['none', 'transparent'].includes(value) && !/^rgba\(.*,[ \t]*0\)$/.test(value);
    const isVisible = (element) => {
      if (element.matches('defs *,symbol *,clipPath *,mask *,pattern *,marker *')) return false;
      if (getComputedStyle(element).visibility !== 'visible') return false;
      for (let node = element; node instanceof SVGElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    for (const index of indices) {
      const element = all[index];
      if (!isVisible(element)) continue;
      const style = getComputedStyle(element);
      const matrix = element.getScreenCTM();
      if (!matrix) continue;
      const shape = element instanceof SVGGeometryElement;
      const fill = Math.max(0, Number(style.fillOpacity)) > 0 && visiblePaint(style.fill);
      const stroke = Math.max(0, Number(style.strokeOpacity)) > 0 && visiblePaint(style.stroke) && parseFloat(style.strokeWidth) > 0;
      if (shape && !fill && !stroke) continue;
      const strokeWidth = stroke ? parseFloat(style.strokeWidth) : 0;
      const dashOrJoin = style.strokeDasharray !== 'none' || style.strokeLinejoin === 'miter';
      const box = element.getBoundingClientRect();
      let padX = 0;
      let padY = 0;
      if (strokeWidth) {
        const radius = strokeWidth * (dashOrJoin && style.strokeLinejoin === 'miter' && shape &&
          ['path', 'polyline', 'polygon'].includes(element.localName) ? Math.max(1, Number(style.strokeMiterlimit)) : 1) / 2;
        padX = style.vectorEffect === 'non-scaling-stroke' ? radius : radius * Math.hypot(matrix.a, matrix.c);
        padY = style.vectorEffect === 'non-scaling-stroke' ? radius : radius * Math.hypot(matrix.b, matrix.d);
      }
      const rectangle = { left: box.left - padX, top: box.top - padY, right: box.right + padX, bottom: box.bottom + padY };
      if (rectangle.left === rectangle.right || rectangle.top === rectangle.bottom) continue;
      if (style.filter !== 'none' || style.clipPath !== 'none' || style.maskImage !== 'none' ||
          [style.markerStart, style.markerMid, style.markerEnd].some((value) => value !== 'none')) approximate++;
      let glyphs;
      if (element instanceof SVGTextContentElement) {
        const count = element.getNumberOfChars();
        if (count > 500 || count > remainingGlyphs) approximate++;
        else {
          remainingGlyphs -= count;
          glyphs = [];
          for (let index = 0; index < count; index++) {
            const extent = element.getExtentOfChar(index);
            if (extent.width && extent.height) glyphs.push(extent);
          }
        }
      }
      geometry.push({ index, element, shape, fill, stroke, glyphs, strokeWidth, rectangle, inverse: matrix.inverse(),
        label: element.id || `${element.localName}[${index}]` });
    }
    const targets = geometry.filter(({ index }) => wanted.has(index));
    const targetSet = new Set(targets);
    const isPainted = (item, x, y) => {
      const local = new DOMPoint(x, y).matrixTransform(item.inverse);
      if (item.glyphs) {
        const pad = item.strokeWidth / 2;
        return item.glyphs.some(({ x, y, width, height }) =>
          local.x >= x - pad && local.x <= x + width + pad && local.y >= y - pad && local.y <= y + height + pad);
      }
      if (!item.shape) return true;
      return (item.fill && item.element.isPointInFill(local)) || (item.stroke && item.element.isPointInStroke(local));
    };
    const sampledOverlap = (a, b) => {
      const x0 = Math.max(a.rectangle.left, b.rectangle.left);
      const x1 = Math.min(a.rectangle.right, b.rectangle.right);
      const y0 = Math.max(a.rectangle.top, b.rectangle.top);
      const y1 = Math.min(a.rectangle.bottom, b.rectangle.bottom);
      if (x1 - x0 < 0.75 || y1 - y0 < 0.75) return false;
      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
        const x = x0 + (x1 - x0) * (i + 0.5) / 7;
        const y = y0 + (y1 - y0) * (j + 0.5) / 7;
        if (isPainted(a, x, y) && isPainted(b, x, y)) return true;
      }
      return false;
    };
    const overlaps = [];
    const outside = [];
    let pairs = 0;
    let pairLimited = false;
    let overlapCount = 0;
    let outsideCount = 0;
    const first = geometry[0];
    const coversViewport = (rect) => Math.abs(rect.left - bounds.left) < 0.75 && Math.abs(rect.top - bounds.top) < 0.75 &&
      Math.abs(rect.right - bounds.right) < 0.75 && Math.abs(rect.bottom - bounds.bottom) < 0.75;
    const background = first?.element.localName === 'rect' && coversViewport(first.rectangle) ? first : null;
    for (const a of targets) {
      inspected++;
      const rect = a.rectangle;
      if (rect.left < bounds.left - 0.75 || rect.right > bounds.right + 0.75 || rect.top < bounds.top - 0.75 || rect.bottom > bounds.bottom + 0.75) {
        outsideCount++;
        if (outside.length < 25) outside.push(a.label.slice(0, 100));
      }
      if (a === background || pairLimited) continue;
      for (const b of geometry) {
        if (a === b || b === background || (targetSet.has(b) && b.index < a.index)) continue;
        if (++pairs > 25_000) {
          pairLimited = true;
          break;
        }
        if (sampledOverlap(a, b)) {
          overlapCount++;
          if (overlaps.length < 25) overlaps.push([a.label.slice(0, 100), b.label.slice(0, 100)]);
        }
      }
    }
    return { inspected, candidates: all.length, matched: selected.length, start, next: start + requested.length < selected.length && requested.length > 0 ? start + requested.length : null,
      pairLimited, approximate, overlaps, outside, overlapCount, outsideCount };
  }, { scope, maxCandidates: MAX_CANDIDATES });
  if (observed.invalidRoot) return result([{ id: 'svg_browser_root', status: 'failed', evidence: 'Chromium did not parse an SVG root.' }], [], {});
  const issues = [
    ...observed.overlaps.map(([a, b]) => ({ severity: 'warning', code: 'SVG_BROWSER_OVERLAP', message: `${a} overlaps ${b} in Chromium geometry samples.` })),
    ...observed.outside.map((id) => ({ severity: 'warning', code: 'SVG_BROWSER_OUT_OF_BOUNDS', message: `${id} extends beyond the SVG viewport.` })),
  ];
  const complete = observed.next === null && !scope.selector && observed.start === 0 && !observed.pairLimited &&
    observed.candidates <= MAX_CANDIDATES && observed.approximate === 0;
  const checks = [
    { id: 'svg_browser_overlap', status: observed.overlapCount ? 'failed' : 'passed',
      evidence: `${observed.overlapCount} overlapping pairs in sampled Chromium fill/stroke and text layout geometry.` },
    { id: 'svg_browser_bounds', status: observed.outsideCount ? 'failed' : 'passed',
      evidence: `${observed.outsideCount} computed bounds extend beyond the viewport; ${observed.inspected} inspected.` },
  ];
  if (observed.start >= observed.matched && (scope.selector || observed.start)) checks.push({
    id: 'svg_browser_target', status: 'failed', evidence: 'No drawable element matched the verification scope.',
  });
  if (!complete) checks.push({
    id: 'svg_browser_remaining', status: 'unverified',
    evidence: 'The report was scoped, reached its budget, or includes geometry expressed as layout bounds (filters, clipping or markers).',
  });
  return result(checks, issues, { browser: observed });
}
