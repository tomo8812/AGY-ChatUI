import { isRichChartCoordinate, isRichChartPoint, richChartAxisPosition } from '../../../shared/rich-chart-display.js';
import type { RichNode } from '../../../shared/rich-schema.js';

type Check = (value: unknown) => boolean;
type Fields = Record<string, Check>;

const string: Check = value => typeof value === 'string';
const boolean: Check = value => typeof value === 'boolean';
const number: Check = value => typeof value === 'number' && Number.isFinite(value);
const integer: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const scalar: Check = value => value === null || string(value) || number(value);
const oneOf = (...values: unknown[]): Check => value => values.includes(value);
const array = (element: Check): Check => value => Array.isArray(value) && value.every(element);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonEmpty: Check = value => typeof value === 'string' && value.trim().length > 0;
const either = (...checks: Check[]): Check => value => checks.some(check => check(value));
const responsive = (valueCheck: Check): Check => value =>
  valueCheck(value) || object(value) && valueCheck(value.pc) && valueCheck(value.mobile);

const tone = oneOf('default', 'muted', 'info', 'success', 'warning', 'danger');
const align = oneOf('left', 'center', 'right');
const variant = oneOf('default', 'subtle', 'outline', 'accent');
const sizes = oneOf('none', 'xs', 'sm', 'md', 'lg');
const children = { children: Array.isArray };
const textDisplay = { content: string };
const statDisplay = { label: string, value: scalar };
const numericControl = { min: number, max: number };
const optionControl = { options: Array.isArray };
const listTypes = { items: Array.isArray };
const activeText = { label: string };

interface NodeContract {
  required?: Fields;
  optional?: Fields;
  values?: Fields;
  optionalValues?: Fields;
}
const bound = { bind: nonEmpty };
const textInput = { required: bound, optional: { placeholder: string, maxLength: integer }, optionalValues: activeText };
const choices = { required: bound, values: optionControl, optionalValues: activeText };
const numericInput = { required: bound, values: numericControl, optional: { unit: string }, optionalValues: { label: string, step: number } };
const toggle = { required: bound, values: activeText };
const stat = { values: statDisplay, optional: { sourceId: nonEmpty, missingLabel: string },
  optionalValues: { unit: string, delta: scalar, deltaTone: oneOf('neutral', 'positive', 'negative'), missingReason: string, asOf: string, fetchedAt: string } };
const textNode = { values: textDisplay, optional: { tone, align, mono: boolean } };
const badge = { values: activeText, optional: { tone, dot: boolean } };
const list = { optional: { children: Array.isArray, bindKey: nonEmpty }, optionalValues: listTypes };
const overlay = { required: { trigger: object } };
const clickable = { required: children, optional: { selectedWhen: nonEmpty } };

const contracts: Record<RichNode['type'], NodeContract> = {
  stack: { required: { ...children, direction: responsive(oneOf('row', 'col')) } },
  grid: { required: { ...children, columns: either(responsive(integer), oneOf('auto-fit')) }, optional: { minColWidthPx: number } },
  columns: { required: children, optional: { ratios: array(number), keepRowOnMobile: boolean } },
  container: { required: children, optional: { variant } },
  card: { required: children, optional: { variant, headerAction: object, footer: object }, optionalValues: { title: string, subtitle: string } },
  divider: { optional: { orientation: oneOf('horizontal', 'vertical') }, optionalValues: activeText },
  spacer: { required: { size: oneOf('xs', 'sm', 'md', 'lg') } },
  scroll_area: { required: { ...children, axis: oneOf('x', 'y', 'both') }, optional: { maxHeightPx: number } },
  carousel: { required: children, optional: { itemMinWidthPx: number, showIndicators: boolean } },
  responsive_box: { required: children, optional: { pc: layout, mobile: layout } },
  text: textNode, caption: textNode, note: textNode, quote: textNode, emphasis: textNode,
  heading: { required: { level: oneOf(1, 2, 3, 4) }, values: textDisplay, optional: { tone } },
  markdown: { values: textDisplay },
  icon: { required: { name: nonEmpty }, optional: { size: oneOf('sm', 'md', 'lg'), tone, decorative: boolean } },
  badge, status: badge,
  stat, kpi_card: stat,
  progress: { values: { value: number }, optional: { showPercent: boolean, tone }, optionalValues: { max: number, label: string } },
  list, checklist: list, steps: list, timeline: list,
  data_table: { required: { columns: columns }, values: { rows: Array.isArray }, optional: { sortable: boolean, searchable: boolean, pageSize: integer } },
  source_attribution: { optional: { sourceIds: array(nonEmpty), compact: boolean } },
  mermaid: { values: { code: string }, optional: { zoomable: boolean } },
  svg_scene: { required: { viewBox: string, elements: Array.isArray }, optional: {
    aspectRatio: string, interactiveRole: oneOf('diagram', 'wireframe', 'interactive'), zoomable: boolean,
  }, optionalValues: { title: string } },
  node_edge_diagram: { required: { diagramLayout: oneOf('dag_tb', 'dag_lr', 'radial', 'manual') },
    values: { nodes: Array.isArray, edges: Array.isArray }, optional: { zoomable: boolean } },
  chart: { optional: { heightPx: number, legend: oneOf('top', 'bottom', 'none'), connectNulls: boolean }, optionalValues: { title: string } },
  button: { values: activeText, optional: { variant: oneOf('primary', 'secondary', 'ghost', 'danger'), icon: string, disabledWhen: nonEmpty } },
  clickable, selectable_card: clickable,
  text_input: textInput, textarea: textInput,
  number_input: numericInput, slider: numericInput,
  checkbox: toggle, toggle,
  radio_group: choices, select: choices, segmented: choices,
  date_input: { required: bound, optional: { min: string, max: string }, optionalValues: activeText },
  tabs: { required: { items: Array.isArray }, optional: bound },
  collapsible: { required: children, values: { title: string }, optional: { bind: nonEmpty, defaultOpen: boolean } },
  popover: overlay, tooltip: overlay,
  form: { required: children },
  editable_draft: { required: bound, optional: { format: oneOf('text', 'markdown', 'code'), language: string }, optionalValues: activeText },
  code_block: { values: { code: string }, optional: { language: string, copyable: boolean } },
  diff_block: { values: { oldText: string, newText: string }, optional: { language: string } },
  math_block: { values: { tex: string }, optional: { displayMode: boolean } },
  media_asset: { values: { alt: string }, optionalValues: { artifactId: string, caption: string } },
};

function layout(value: unknown) {
  return object(value) && validOptional(value, {
    span: value => integer(value) || object(value) && validOptional(value, { pc: integer, mobile: integer }),
    align: oneOf('start', 'center', 'end', 'stretch'), justify: oneOf('start', 'center', 'end', 'between', 'around'),
    gap: sizes, padding: sizes, minWidthPx: number, maxWidthPx: number, grow: number, shrink: number, wrap: boolean,
    hideOn: oneOf('pc', 'mobile'),
  });
}

function validOptional(value: Record<string, unknown>, fields: Fields) {
  return Object.entries(fields).every(([key, check]) => value[key] === undefined || check(value[key]));
}

function columns(value: unknown) {
  if (!Array.isArray(value) || !value.length) return false;
  const keys = new Set<string>();
  return value.every(column => {
    if (!object(column) || typeof column.key !== 'string' || !column.key.trim() || keys.has(column.key) || !string(column.label) ||
        !validOptional(column, { align, format: oneOf('text', 'number', 'currency', 'percent', 'date', 'badge'), unit: string, sortable: boolean, missingLabel: string })) return false;
    keys.add(column.key);
    return true;
  });
}

export function isRichExpressionValue(value: unknown): value is { expr: string } {
  return object(value) && typeof value.expr === 'string' && Object.keys(value).length === 1;
}

/** The same field contracts apply to literal and evaluated RichValue data. */
export function visitRichNodeValues(node: RichNode, visit: (value: unknown, check: Check, path: string) => void) {
  const contract = contracts[node.type];
  const record = node as unknown as Record<string, unknown>;
  for (const [key, check] of Object.entries(contract.values ?? {})) visit(record[key], check, key);
  for (const [key, check] of Object.entries({ ariaLabel: string, ...contract.optionalValues })) {
    if (record[key] !== undefined) visit(record[key], check, key);
  }
  if (node.type === 'chart' && Array.isArray(node.series)) {
    const xAxis = node.xAxis;
    const checkX: Check = value => isRichChartCoordinate(value) &&
      (xAxis?.type !== 'number' && xAxis?.type !== 'time' || Number.isFinite(richChartAxisPosition(value, xAxis.type)));
    if (node.categories !== undefined) visit(node.categories, array(checkX), 'categories');
    if (xAxis !== undefined) visit(xAxis, value => object(value) && validOptional(value, {
      label: string, unit: string, format: string, type: oneOf('category', 'number', 'time'),
    }), 'xAxis');
    node.series.forEach((series, index) => {
      if (!series || typeof series !== 'object') return;
      const base = `series[${index}]`;
      visit(series.label, string, base + '.label');
      visit(series.data, array(point => isRichChartPoint(point) &&
        (!point || typeof point !== 'object' || point.x === undefined || checkX(point.x))), base + '.data');
      if (series.asOf !== undefined) visit(series.asOf, string, base + '.asOf');
    });
    for (const [path, axis] of [['yAxis', node.yAxis], ['yAxisRight', node.yAxisRight]] as const) {
      if (axis === undefined) continue;
      visit(axis, value => object(value) && validOptional(value, { label: string, unit: string, format: string }), path);
      if (axis?.min !== undefined) visit(axis.min, number, path + '.min');
      if (axis?.max !== undefined) visit(axis.max, number, path + '.max');
    }
    if (node.referenceLines !== undefined) {
      visit(node.referenceLines, array(value => object(value) && ['x', 'y'].includes(String(value.axis)) &&
        validOptional(value, { tone })), 'referenceLines');
      if (Array.isArray(node.referenceLines)) node.referenceLines.forEach((line, index) => {
        if (!line || typeof line !== 'object') return;
        const base = `referenceLines[${index}]`;
        visit(line.value, line.axis === 'y' ? number : checkX, base + '.value');
        if (line.label !== undefined) visit(line.label, string, base + '.label');
      });
    }
  }
  if ((node.type === 'popover' || node.type === 'tooltip') && !Array.isArray(node.content)) visit(node.content, string, 'content');
  if (node.type === 'tabs' && Array.isArray(node.items)) {
    node.items.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      visit(item.label, string, `items[${index}].label`);
      if (item.badge !== undefined) visit(item.badge, string, `items[${index}].badge`);
    });
  }
}

export function visitRichNodeStaticFields(node: RichNode, visit: (value: unknown, check: Check, path: string) => void) {
  const contract = contracts[node.type];
  const record = node as unknown as Record<string, unknown>;
  for (const [key, check] of Object.entries(contract.required ?? {})) visit(record[key], check, key);
  for (const [key, check] of Object.entries({ layout, visibleWhen: nonEmpty,
    repeat: (value: unknown) => object(value) && nonEmpty(value.itemsExpr) && nonEmpty(value.as) &&
      validOptional(value, { keyField: nonEmpty }), ...contract.optional })) {
    if (record[key] !== undefined) visit(record[key], check, key);
  }
  visitRichNodeValues(node, (value, check, path) => visit(value, value => check(value) || isRichExpressionValue(value), path));
}

export function richCollectionIsValid(type: RichNode['type'], value: unknown, isSource: Check): boolean {
  if (!Array.isArray(value)) return false;
  if (type === 'data_table') {
    return value.every(row => object(row) && Object.values(row).every(cell =>
      scalar(cell) || boolean(cell) || object(cell) && (scalar(cell.value) || boolean(cell.value)) &&
      validOptional(cell, { sourceId: isSource, missingReason: string, asOf: string, fetchedAt: string, tone })));
  }
  if (type === 'select' || type === 'radio_group' || type === 'segmented') {
    const keys = new Set<unknown>();
    return value.every(option => {
      if (!object(option) || !isRichChartCoordinate(option.value) || !string(option.label) ||
          !validOptional(option, { disabled: boolean }) || keys.has(option.value)) return false;
      keys.add(option.value);
      return true;
    });
  }
  return value.every(item => object(item) && string(item.title) && validOptional(item, {
    id: nonEmpty, description: string, meta: string, asOf: string, checked: boolean, sourceId: isSource,
    status: oneOf('pending', 'active', 'done', 'error', 'missing'),
  }));
}
