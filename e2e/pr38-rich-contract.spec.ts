import { expect, test, type Page } from '@playwright/test';
import type { RichChartNode, RichDocumentV1, RichNode } from '../shared/rich-schema';

async function mount(page: Page, children: RichNode[], state: RichDocumentV1['state'] = {}, sources?: RichDocumentV1['sources']) {
  const document: RichDocumentV1 = { schemaVersion: 1, state, sources, root: { id: 'root', type: 'stack', direction: 'col', children } };
  await page.addInitScript(value => {
    (window as Window & { __pr3aFixtureRichDocument?: RichDocumentV1 }).__pr3aFixtureRichDocument = value;
  }, document);
  await page.goto('http://127.0.0.1:4174/?kind=rich');
}

test('places continuous horizontal, stacked and combo marks by X and groups reordered categorical series by value', async ({ page }) => {
  const datum = (x: string | number, y: number) => ({ x, y });
  const horizontal: RichChartNode = {
    id: 'horizontal', type: 'chart', chartType: 'hbar', xAxis: { type: 'number' },
    series: [{ key: 'a', label: 'A', data: [datum(0, 1), datum(1, 2), datum(10, 1)] }],
    referenceLines: [{ axis: 'x', value: 1 }],
  };
  const stacked: RichChartNode = {
    id: 'stack', type: 'chart', chartType: 'stacked_bar', xAxis: { type: 'number' },
    series: [
      { key: 'a', label: 'A', data: [datum(0, 1), datum(2, 2), datum(10, 1)] },
      { key: 'b', label: 'B', data: [datum(10, 3), datum(0, -1)] },
    ],
  };
  const combo: RichChartNode = {
    id: 'combo', type: 'chart', chartType: 'combo', xAxis: { type: 'time' },
    series: [
      { key: 'a', label: 'A', type: 'bar', data: [datum('2026-11-01T00:00:00Z', 2), datum('2026-11-02T00:00:00Z', 2)] },
      { key: 'b', label: 'B', type: 'line', data: [datum('2026-11-02T00:00:00Z', 3), datum('2026-11-11T00:00:00Z', 4)] },
    ],
  };
  const categorical: RichChartNode = {
    id: 'cat', type: 'chart', chartType: 'combo', categories: ['north', 'east', 'west'],
    series: [
      { key: 'a', label: 'A', type: 'bar', data: [datum('east', 2), datum('north', 1)] },
      { key: 'b', label: 'B', type: 'line', data: [datum('west', 4), datum('east', 3)] },
    ],
  };
  await mount(page, [horizontal, stacked, combo, categorical]);
  const node = (id: string) => page.locator(`[data-rich-node-id="${id}"]`);
  const coordinates = (id: string, mark: string, attr: string) =>
    node(id).locator(mark).evaluateAll((elements, key) => elements.map(el => Number(el.getAttribute(key))), attr);

  await expect(page.locator('figure.rich-chart')).toHaveCount(4);
  const y = await coordinates('horizontal', 'rect[fill]', 'y');
  expect(y).toHaveLength(3);
  expect((y[2] - y[1]) / (y[1] - y[0])).toBeCloseTo(9, 5);
  const lineY = Number(await node('horizontal').locator('.rich-chart-reference line').getAttribute('y1'));
  const barHeight = Number(await node('horizontal').locator('rect[fill]').nth(1).getAttribute('height'));
  expect(lineY).toBeCloseTo(y[1] + barHeight / 2, 0);

  const x = await coordinates('stack', 'rect[fill]', 'x');
  expect(x).toHaveLength(5);
  expect((x[2] - x[1]) / (x[1] - x[0])).toBeCloseTo(4, 5);
  expect(x[3]).toBe(x[2]);
  expect(x[4]).toBe(x[0]);
  const widths = await coordinates('combo', 'rect[fill]', 'width');
  const bars = await coordinates('combo', 'rect[fill]', 'x');
  const points = await coordinates('combo', 'circle', 'cx');
  expect(points[0]).toBeCloseTo(bars[1] + widths[1] / 2, 0);
  expect((points[1] - points[0]) / (bars[1] - bars[0])).toBeCloseTo(9, 5);

  const categoryBars = await coordinates('cat', 'rect[fill]', 'x');
  const categoryPoints = await coordinates('cat', 'circle', 'cx');
  expect(categoryBars[0]).toBeGreaterThan(categoryBars[1]);
  expect(categoryPoints[0]).toBeGreaterThan(categoryPoints[1]);
  const categoryBarWidths = await coordinates('cat', 'rect[fill]', 'width');
  expect(categoryPoints[1] - categoryBars[0]).toBeLessThan(categoryBarWidths[0] * 0.6);
});

test('pauses conditional and repeated charts and tables offscreen, then resumes with the latest state', async ({ page }) => {
  const button: RichNode = { type: 'button', id: 'change', label: 'Advance', onClick: [{ type: 'increment_state', key: 'value' }, { type: 'set_state', key: 'rows', valueExpr: '$state.nextRows' }] };
  const chart: RichChartNode = {
    type: 'chart', id: 'heavy-chart', chartType: 'line', visibleWhen: '$item.show',
    repeat: { itemsExpr: '$state.charts', as: 'chart', keyField: 'id' },
    title: { expr: '$item.id' }, series: [{ key: 'value', label: 'Value', data: { expr: '[$state.value]' } }],
  };
  const table: RichNode = {
    type: 'data_table', id: 'heavy-table', visibleWhen: '$state.showTable',
    columns: [{ key: 'value', label: 'Value' }], rows: { expr: '$state.rows' },
  };
  const spacers: RichNode[] = Array.from({ length: 80 }, (_, i) => ({ id: 'space-' + i, type: 'spacer', size: 'lg' }));
  await mount(page, [button, ...spacers, chart, table], {
    value: 1, showTable: true, rows: [{value: 1}], nextRows: [{value: 2}], charts: [{ id: 'first', show: true }, { id: 'hidden', show: false }],
  });
  const figure = page.locator('figure[aria-label="first"]');
  const cell = page.locator('[data-rich-node-id="heavy-table"] tbody td');
  await expect(figure.locator('circle title')).toContainText('Value · 1 · 1');
  await expect(cell).toHaveText('1');
  await expect(page.locator('figure[aria-label="hidden"]')).toHaveCount(0);
  expect(await figure.evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThan(1000);
  const advance = page.getByRole('button', { name: 'Advance' });
  await advance.click();
  await expect(figure.locator('circle title')).toContainText('Value · 1 · 1');
  await expect(cell).toHaveText('1');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure.locator('circle title')).toContainText('Value · 1 · 2');
  await cell.scrollIntoViewIfNeeded();
  await expect(cell).toHaveText('2');
});

test('isolates nested actions and gives SVG, tooltip, popover and collapsible their own interaction semantics', async ({ page }, info) => {
  const text = (id: string, content: string): RichNode => ({ id, type: 'text', content });
  await mount(page, [
    { id: 'outer', type: 'selectable_card', onClick: [{ type: 'increment_state', key: 'outer' }], children: [
      text('outer-label', 'Outer card'),
      { id: 'inner', type: 'clickable', onClick: [{ type: 'increment_state', key: 'inner' }], children: [
        text('inner-label', 'Inner card'),
        { id: 'button', type: 'button', label: 'Inner button', onClick: [{ type: 'increment_state', key: 'button' }] },
      ] },
    ] },
    { id: 'counts', type: 'text', content: { expr: 'concat("Counts: ", $state.outer, ",", $state.inner, ",", $state.button)' } },
    { id: 'tooltip', type: 'tooltip', trigger: text('help', 'Help'), content: 'Short description' },
    { id: 'popover', type: 'popover', trigger: text('more', 'More'), content: [text('details', 'Independent content')] },
    { id: 'button-popover', type: 'popover', content: 'Button panel',
      trigger: { id: 'open-button', type: 'button', label: 'Show button panel', onClick: [{ type: 'increment_state', key: 'button' }] } },
    { id: 'collapse', type: 'collapsible', title: 'Section', children: [text('body', 'In-flow content')] },
    { id: 'static', type: 'svg_scene', title: 'Static sample', viewBox: '0 0 10 10', interactiveRole: 'wireframe', elements: [{ tag: 'rect', attrs: { width: 10, height: 10 } }] },
    { id: 'active', type: 'svg_scene', title: 'Active sample', viewBox: '0 0 10 10', interactiveRole: 'interactive',
      elements: [{ tag: 'rect', tooltip: 'SVG action', attrs: { width: 10, height: 10 }, onClick: [{ type: 'increment_state', key: 'button' }] }] },
  ], { outer: 0, inner: 0, button: 0 });
  const counts = page.getByText(/^Counts:/);
  await page.getByRole('button', { name: 'Inner button', exact: true }).click();
  await expect(counts).toHaveText('Counts: 0,0,1');
  await page.getByText('Inner card', { exact: true }).click();
  await expect(counts).toHaveText('Counts: 0,1,1');
  await page.locator('[data-rich-node-id="inner"] .rich-selectable').press('Enter');
  await expect(counts).toHaveText('Counts: 0,2,1');
  await page.getByText('Outer card', { exact: true }).click();
  await expect(counts).toHaveText('Counts: 1,2,1');
  const trigger = page.locator('.rich-tooltip .rich-overlay-trigger');
  if (info.project.name === 'pc-chromium') {
    await trigger.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Short description');
    await page.getByText('Outer card', { exact: true }).hover();
  }
  await trigger.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Short description');
  await trigger.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();

  await page.getByRole('button', { name: 'ポップオーバーを開く' }).click();
  await expect(page.getByRole('region', { name: 'ポップオーバー' })).toHaveText('Independent content');
  await page.getByRole('button', { name: 'ポップオーバーを閉じる' }).press('Escape');
  await expect(page.getByRole('region', { name: 'ポップオーバー' })).toBeHidden();
  const buttonTrigger = page.getByRole('button', { name: 'Show button panel' });
  await buttonTrigger.press('Enter');
  await expect(buttonTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Button panel', { exact: true })).toBeVisible();
  await expect(counts).toHaveText('Counts: 1,2,2');
  await buttonTrigger.press('Escape');
  await expect(buttonTrigger).toBeFocused();
  await expect(buttonTrigger).toHaveAttribute('aria-expanded', 'false');
  const collapse = page.getByRole('button', { name: /Section/ });
  await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  await collapse.click();
  await expect(page.getByText('In-flow content')).toBeVisible();

  await expect(page.getByRole('img', { name: 'Static sample' })).toHaveAttribute('data-diagram-role', 'wireframe');
  await expect(page.getByRole('img', { name: 'Static sample' }).getByRole('button')).toHaveCount(0);
  await page.getByRole('group', { name: 'Active sample' }).getByRole('button', { name: 'SVG action' }).press('Enter');
  await expect(counts).toHaveText('Counts: 1,2,3');
});

test('validates inline SVG definitions on state changes and namespaces definition references in the DOM', async ({ page }) => {
  await mount(page, [
    { id: 'invalid-opacity', type: 'button', label: 'Set invalid opacity', onClick: [{ type: 'set_state', key: 'opacity', valueExpr: '1.5' }] },
    { id: 'valid-opacity', type: 'button', label: 'Set valid opacity', onClick: [{ type: 'set_state', key: 'opacity', valueExpr: '0.75' }] },
    { id: 'inline', type: 'media_asset', sourceKind: 'inline_svg', alt: 'Inline sample',
      svgScene: { id: 'svg', type: 'svg_scene', viewBox: '0 0 100 100', defs: [
        { kind: 'linearGradient', id: 'paint', stops: [{ offset: '50%', color: '#123', opacity: { expr: '$state.opacity' } }] },
        { kind: 'clipPath', id: 'clip', shape: 'rect', attrs: { width: 50, height: 50 } },
        { kind: 'marker', id: 'arrow', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 5, markerHeight: 5,
          pathD: 'M0 0 L10 5 L0 10 Z', fill: '#123' },
      ], elements: [
        { tag: 'rect', attrs: { width: 100, height: 100, fill: 'url(#paint)', clipPath: 'url(#clip)' } },
        { tag: 'line', attrs: { x1: 0, y1: 0, x2: 10, y2: 10, markerEnd: 'url(#arrow)' } },
      ] } },
  ], { opacity: 0.25 });
  const inline = page.locator('[data-rich-node-id="inline"]');
  const stop = inline.locator('linearGradient stop');
  await expect(stop).toHaveAttribute('stop-opacity', '0.25');
  const gradientId = await inline.locator('linearGradient').getAttribute('id');
  await expect(inline.locator('svg > rect')).toHaveAttribute('fill', 'url(#' + gradientId + ')');
  await expect(inline.locator('marker path')).toHaveAttribute('d', 'M0 0 L10 5 L0 10 Z');
  await page.getByRole('button', { name: 'Set invalid opacity' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(stop).toHaveAttribute('stop-opacity', '0.25');
  await page.getByRole('button', { name: 'Set valid opacity' }).click();
  await expect(stop).toHaveAttribute('stop-opacity', '0.75');
});

test('keeps two stacked axes selectable and exposes all missing point sources and code drafts', async ({ page }) => {
  await mount(page, [
    { id: 'stacks', type: 'chart', chartType: 'stacked_bar', categories: ['A', 'B'], selectedPointBind: 'selected',
      series: [
        { key: 'left', label: 'Left', data: [3, -2], sourceId: 'first' },
        { key: 'left-2', label: 'Left stacked', data: [2, -1] },
        { key: 'right', label: 'Right', data: [100, -90], yAxisId: 'right', sourceId: 'second' },
      ], yAxisRight: { unit: 'kg' } },
    { id: 'missing', type: 'chart', chartType: 'line', series: [{ key: 'a', label: 'Value', sourceId: 'first',
      data: Array.from({ length: 101 }, (_, i) => ({ y: null, missingReason: 'Missing ' + (i + 1),
        ...(i === 100 ? { sourceId: 'second', asOf: '2026-11-26' } : {}) })),
    }] },
    { id: 'draft', type: 'editable_draft', format: 'code', language: 'typescript', bind: 'code', label: 'Draft' },
    { id: 'echo', type: 'text', content: { expr: '$state.code' } },
  ], { selected: null, code: 'const a = 1;' }, [
    { id: 'first', name: 'Original report', fetchedAt: '2026-11-24T00:00:00Z' },
    { id: 'second', name: 'Updated report', fetchedAt: '2026-11-25T00:00:00Z' },
  ]);
  const chart = page.locator('[data-rich-node-id="stacks"]');
  const left = chart.getByRole('button', { name: /^Left · A/ });
  const right = chart.getByRole('button', { name: /^Right · A/ });
  const leftBounds = await left.boundingBox(), rightBounds = await right.boundingBox();
  expect(leftBounds).not.toBeNull();
  expect(rightBounds).not.toBeNull();
  expect(leftBounds!.x + leftBounds!.width).toBeLessThan(rightBounds!.x);
  await left.click();
  await right.click();
  const missing = page.locator('[data-rich-node-id="missing"]');
  await missing.locator('summary').click();
  await missing.getByRole('button', { name: '次へ' }).click();
  await expect(missing.getByText(/Missing 101.*Updated report.*2026-11-25.*2026-11-26/)).toBeVisible();
  const editor = page.locator('[data-rich-node-id="draft"]').getByRole('textbox', { name: 'ソース' });
  await expect(editor).toContainText('const a = 1;');
  await editor.fill('const b = 2;');
  await expect(page.locator('[data-rich-node-id="echo"]')).toHaveText('const b = 2;');
});
