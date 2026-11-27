import crypto from 'node:crypto';
import { resolveRichChartPoint } from '../../../shared/rich-chart-display.js';
import type { RichBlockRecord, RichDocumentV1, RichNode, RichSvgElement } from '../../../shared/rich-schema.js';
import { targetSelectorSchema } from '../artifacts/target-selector-schema.js';
import { canonicalJson } from '../artifacts/idempotency-coordinator.js';
import type { TargetResolutionResult, TargetSelector } from '../artifacts/types.js';
import { evaluateRichExpr } from '../rich/rich-expr-evaluator.js';
import { compileRichDynamicPlan, evaluateRichDynamicState, mergeRichState, richTargetDisplayIdentity } from '../rich/rich-validator.js';
import { mapRichNodeChildren } from '../rich/rich-node-tree.js';

function sha256(val: unknown): string {
  const s = typeof val === 'string' ? val : canonicalJson(val);
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function findRichNodeById(root: RichNode, targetId: string, ancestors: RichNode[] = []): { node: RichNode; ancestors: RichNode[] } | null {
  if (root.id === targetId) return { node: root, ancestors };
  let match: ReturnType<typeof findRichNodeById> = null;
  mapRichNodeChildren(root, child => {
    match ??= findRichNodeById(child, targetId, [...ancestors, root]);
    return child;
  });
  return match;
}

function* svgElements(
  elements: RichSvgElement[],
  parents: RichSvgElement[] = [],
): Generator<{ element: RichSvgElement; parents: RichSvgElement[] }> {
  for (const element of elements) {
    yield { element, parents };
    if (element.children) yield* svgElements(element.children, [...parents, element]);
  }
}

/**
 * Resolves a TargetSelector against a RichBlockRecord enforcing strict PIN-02 safety:
 * - Same nodeId replaced by different nodeType or content -> fingerprint mismatch -> needs_review
 * - repeat array reordered (missing keyField / duplicate itemKey / item content changed / order changed) -> needs_review / stale
 */
export function resolveRichBlockTarget(block: RichBlockRecord, selector: TargetSelector,
  view: { state: Record<string, unknown>; theme: 'light' | 'dark' } = { state: {}, theme: 'light' },
  authorizedArtifactIds?: Set<string>,
  baseDocument?: RichDocumentV1,
): TargetResolutionResult {
  if (!targetSelectorSchema.safeParse(selector).success || selector.blockId !== block.id ||
      selector.baseRevision === undefined || selector.baseRevision > block.revision) {
    return { status: 'needs_review', reason: 'invalid_target_selector' };
  }
  const kind = selector.kind;
  const state = mergeRichState(block.document.state, view.state);
  const plan = compileRichDynamicPlan(block.document, undefined);
  const evaluation = evaluateRichDynamicState(plan, { state, theme: view.theme, authorizedArtifactIds });
  if (!evaluation.valid) return { status: 'needs_review', reason: 'rich_target_evaluation_failed' };
  const context = { state, computed: evaluation.computed, theme: view.theme };

  if (kind === 'rich_block') {
    const docHash = sha256(block.document);
    if (selector.expectedDocHash !== docHash) {
      return { status: 'needs_review', reason: 'rich_document_changed' };
    }
    return { status: 'resolved', resolvedSnippet: block.title || block.id };
  }

  const targetId = selector.nodeId ?? selector.repeatNodeId ?? selector.svgNodeId ?? selector.chartNodeId ?? selector.tableNodeId;
  const target = typeof targetId === 'string' ? findRichNodeById(block.document.root, targetId) : null;
  if (target) {
    if (target.ancestors.some(node => node.repeat) || (target.node.repeat && kind !== 'rich_repeat_item')) {
      return { status: 'needs_review', reason: 'repeat_instance_required' };
    }
    const visibility = kind === 'rich_repeat_item' ? target.ancestors : [...target.ancestors, target.node];
    if (visibility.some(node => node.visibleWhen && !evaluateRichExpr(node.visibleWhen, context))) {
      return { status: 'needs_review', reason: 'rich_target_hidden' };
    }
  }

  const displayIdentity = (doc: RichDocumentV1) => {
    if (!target || typeof targetId !== 'string') return null;
    const selected = doc === block.document ? target : findRichNodeById(doc.root, targetId);
    if (!selected) return null;
    const docPlan = doc === block.document ? plan : compileRichDynamicPlan(doc, undefined);
    const docState = doc === block.document ? state : mergeRichState(doc.state, view.state);
    const validation = doc === block.document ? evaluation
      : evaluateRichDynamicState(docPlan, { state: docState, theme: view.theme, authorizedArtifactIds });
    if (!validation.valid) return null;
    const ancestors = selected.ancestors.map(({ id, type, visibleWhen, repeat }) => ({ id, type, visibleWhen, repeat }));
    const displayContext = { state: docState, computed: validation.computed, theme: view.theme };
    const repeat = selected.node.repeat;
    if (kind === 'rich_table_cell' && selected.node.type === 'data_table') {
      const { rows, columns, ...table } = selected.node;
      const column = columns.find(column => column.key === selector.col);
      if (!column) return null;
      // The row hash and order are checked independently. A change elsewhere
      // in the table does not change the selected column's display contract.
      return richTargetDisplayIdentity(docPlan, { table, column, ancestors }, displayContext);
    }
    if (kind === 'rich_repeat_item' && repeat) {
      const items = evaluateRichExpr(repeat.itemsExpr, displayContext);
      const index = Number(selector.itemIndex);
      if (!Array.isArray(items) || index >= items.length) return null;
      const item = items[index];
      const instance = { ...displayContext, item, index, aliases: { [repeat.as]: item } };
      if (selected.node.visibleWhen && !evaluateRichExpr(selected.node.visibleWhen, instance)) return null;
      const { repeat: _repeat, ...template } = selected.node;
      return richTargetDisplayIdentity(docPlan, { template, repeat, ancestors }, instance);
    }
    return richTargetDisplayIdentity(docPlan, { node: selected.node, ancestors }, displayContext);
  };

  const displayFingerprint = (doc: RichDocumentV1) => {
    try {
      const identity = displayIdentity(doc);
      return identity === null ? null : sha256(identity);
    } catch {
      return null;
    }
  };

  const matchesDisplay = (current: string | null) => {
    if (!current || (selector.expectedDisplayFingerprint !== undefined && selector.expectedDisplayFingerprint !== current)) return false;
    return selector.baseRevision === block.revision || (baseDocument !== undefined && displayFingerprint(baseDocument) === current);
  };

  const displayMatchesBase = () => selector.baseRevision === block.revision || matchesDisplay(displayFingerprint(block.document));

  if (kind === 'rich_node') {
    const node = target?.node;
    if (!node) return { status: 'stale', reason: 'rich_node_not_found' };
    const expectedType = selector.expectedNodeType;
    const expectedFp = selector.expectedNodeFingerprint;
    const currentFp = sha256(node);
    if (node.type !== expectedType || currentFp !== expectedFp || !displayMatchesBase()) {
      return { status: 'needs_review', reason: 'rich_node_replaced_or_modified' };
    }
    return { status: 'resolved', resolvedSnippet: JSON.stringify(node).slice(0, 500) };
  }

  if (kind === 'rich_repeat_item') {
    const repeatNode = target?.node;
    if (!repeatNode || !repeatNode.repeat) {
      return { status: 'stale', reason: 'repeat_node_not_found' };
    }
    const items = evaluateRichExpr(repeatNode.repeat.itemsExpr, context);
    if (!Array.isArray(items)) {
      return { status: 'stale', reason: 'repeat_items_not_array' };
    }

    const keyField = repeatNode.repeat.keyField;
    const itemIndex = Number(selector.itemIndex);
    if (itemIndex < items.length && repeatNode.visibleWhen &&
        !evaluateRichExpr(repeatNode.visibleWhen, {
          ...context, item: items[itemIndex], index: itemIndex, aliases: { [repeatNode.repeat.as]: items[itemIndex] },
        })) return { status: 'needs_review', reason: 'rich_target_hidden' };
    const currentDisplay = displayFingerprint(block.document);
    const expectedItemHash = selector.expectedItemHash;
    const expectedListOrderHash = selector.expectedListOrderHash;
    const keyOf = (item: unknown) => {
      if (!keyField || !item || typeof item !== 'object' || !Object.hasOwn(item, keyField)) return null;
      const key = (item as Record<string, unknown>)[keyField];
      return typeof key === 'string' || typeof key === 'number' ? String(key) : null;
    };
    const itemKey = selector.itemKey === undefined ? keyOf(items[itemIndex]) : String(selector.itemKey);
    const currentOrderKeys = items.map((item, index) => keyOf(item) ?? `__idx_${index}:${sha256(item)}`);
    const currentListOrderHash = sha256(currentOrderKeys);
    const orderChanged = expectedListOrderHash !== currentListOrderHash;

    // An indexed item without a stable key must match both its content and the order fingerprint.
    if (!keyField || itemKey === null) {
      if (itemIndex < 0 || itemIndex >= items.length) {
        return { status: 'stale', reason: 'repeat_item_index_out_of_bounds' };
      }
      const curItem = items[itemIndex];
      const curHash = sha256(curItem);
      if (curHash !== expectedItemHash || orderChanged) {
        return {
          status: 'needs_review',
          reason: orderChanged ? 'repeat_order_changed_without_keyField' : 'repeat_item_content_changed',
          orderChanged,
        };
      }
      if (selector.baseRevision !== block.revision && items.filter(item => sha256(item) === curHash).length !== 1) {
        return { status: 'needs_review', reason: 'ambiguous_multiple_matches' };
      }
      if (!matchesDisplay(currentDisplay)) return { status: 'needs_review', reason: 'repeat_display_changed' };
      return { status: 'resolved', resolvedSnippet: JSON.stringify(curItem), resolvedRange: { itemIndex, displayFingerprint: currentDisplay } };
    }

    // Case B: keyField present -> check uniqueness of itemKey and item hash
    const matchedIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (keyOf(items[i]) === itemKey) {
        matchedIndices.push(i);
      }
    }
    if (matchedIndices.length === 0) {
      return { status: 'stale', reason: 'repeat_item_key_not_found' };
    }
    if (matchedIndices.length > 1) {
      // Duplicate itemKey -> unsafe to auto-resolve!
      return { status: 'needs_review', reason: 'duplicate_repeat_item_key' };
    }
    const foundIdx = matchedIndices[0];
    const foundItem = items[foundIdx];
    const foundHash = sha256(foundItem);
    if (foundHash !== expectedItemHash) {
      return { status: 'needs_review', reason: 'repeat_item_content_changed', orderChanged };
    }
    if (orderChanged || foundIdx !== itemIndex) {
      // Per 5.2: even when unique itemKey + expectedItemHash match, notify/require review on position change
      return {
        status: 'needs_review',
        reason: 'repeat_item_order_changed',
        orderChanged: true,
        resolvedSnippet: JSON.stringify(foundItem),
        resolvedRange: { itemIndex: foundIdx, itemKey },
      };
    }

    if (!matchesDisplay(currentDisplay)) return { status: 'needs_review', reason: 'repeat_display_changed' };
    return {
      status: 'resolved',
      resolvedSnippet: JSON.stringify(foundItem),
      resolvedRange: { itemIndex: foundIdx, itemKey, displayFingerprint: currentDisplay },
    };
  }

  if (kind === 'rich_svg_element') {
    const svgNode = target?.node;
    if (!svgNode || svgNode.type !== 'svg_scene') return { status: 'stale', reason: 'svg_node_not_found' };
    const elements = [...svgElements(svgNode.elements)];
    const matches = selector.elementId === undefined
      ? elements.filter(({ element }) => element.tag === selector.expectedTag && sha256(element) === selector.expectedElementFingerprint)
      : elements.filter(({ element }) => element.id === selector.elementId);
    if (!matches.length) return { status: 'stale', reason: 'svg_element_not_found' };
    const [{ element: el, parents }] = matches;
    const path = [...parents, el];
    if (path.some(element => element.repeat || (element.visibleWhen && !evaluateRichExpr(element.visibleWhen, context)))) {
      return { status: 'needs_review', reason: 'svg_element_hidden_or_repeated' };
    }
    if (matches.length !== 1 || el.tag !== selector.expectedTag || sha256(el) !== selector.expectedElementFingerprint || !displayMatchesBase()) {
      return { status: 'needs_review', reason: 'svg_element_replaced_or_modified' };
    }
    return { status: 'resolved', resolvedSnippet: JSON.stringify(el) };
  }

  if (kind === 'rich_chart_series') {
    const chartNode = target?.node;
    if (!chartNode || chartNode.type !== 'chart') return { status: 'stale', reason: 'chart_node_not_found' };
    const series = chartNode.series.find((s) => s.key === String(selector.seriesKey ?? ''));
    if (!series) return { status: 'stale', reason: 'chart_series_not_found' };
    const data = Array.isArray(series.data) ? series.data
      : evaluateRichExpr(series.data.expr, context);
    if (!Array.isArray(data)) return { status: 'needs_review', reason: 'chart_data_unavailable' };
    const fingerprint = sha256({ ...series, data });
    const currentDisplay = displayFingerprint(block.document);
    if (fingerprint !== selector.expectedSeriesFingerprint || !matchesDisplay(currentDisplay)) return { status: 'needs_review', reason: 'chart_series_changed' };
    const index = selector.dataIndex as number | undefined;
    if (index !== undefined && index >= data.length) return { status: 'stale', reason: 'chart_point_not_found' };
    const categories = Array.isArray(chartNode.categories) ? chartNode.categories
      : chartNode.categories ? evaluateRichExpr(chartNode.categories.expr, context) : [];
    if (!Array.isArray(categories)) return { status: 'needs_review', reason: 'chart_categories_unavailable' };
    const points = data.map((value, index) => resolveRichChartPoint(value, categories, index));
    return { status: 'resolved', resolvedSnippet: JSON.stringify({
      seriesKey: series.key, unit: series.unit, xAxis: chartNode.xAxis,
      yAxis: series.yAxisId === 'right' ? chartNode.yAxisRight : chartNode.yAxis,
      data: index === undefined ? points : points[index],
    }),
      resolvedRange: { seriesKey: series.key, displayFingerprint: currentDisplay, ...(index === undefined ? {} : { dataIndex: index }) } };

  }

  if (kind === 'rich_table_cell') {
    const tableNode = target?.node;
    if (!tableNode || tableNode.type !== 'data_table') return { status: 'stale', reason: 'table_node_not_found' };
    const rows = Array.isArray(tableNode.rows) ? tableNode.rows
      : evaluateRichExpr(tableNode.rows.expr, context);
    if (!Array.isArray(rows)) return { status: 'needs_review', reason: 'table_rows_unavailable' };
    const rowIdx = Number(selector.row);
    const colKey = String(selector.col);
    if (rowIdx >= rows.length || !tableNode.columns.some(column => column.key === colKey)) {
      return { status: 'stale', reason: 'table_cell_not_found' };
    }
    const row = rows[rowIdx];
    const rowHash = sha256(row);
    const ids = rows.map(candidate => candidate?.id);
    const uniqueKeys = new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' || typeof id === 'number');
    const rowOrderHash = sha256(uniqueKeys ? ids : rows.map(candidate => sha256(candidate)));
    if (selector.expectedRowKey !== undefined && (row?.id !== selector.expectedRowKey ||
        rows.filter(candidate => candidate?.id === selector.expectedRowKey).length !== 1)) {
      return { status: 'needs_review', reason: 'table_row_changed' };
    }
    if (selector.expectedRowKey === undefined && rows.filter(candidate => sha256(candidate) === rowHash).length !== 1) {
      return { status: 'needs_review', reason: 'ambiguous_multiple_matches' };
    }
    if ((selector.expectedRowHash !== undefined && selector.expectedRowHash !== rowHash) ||
        (selector.expectedRowOrderHash !== undefined && rowOrderHash !== selector.expectedRowOrderHash) ||
        (selector.baseRevision !== block.revision && (!selector.expectedRowHash || !selector.expectedRowOrderHash))) {
      return { status: 'needs_review', reason: 'table_row_changed' };
    }
    const cell = row?.[colKey] ?? null;
    const currentDisplay = displayFingerprint(block.document);
    if (sha256(cell) !== selector.expectedCellHash || !matchesDisplay(currentDisplay)) {
      return { status: 'needs_review', reason: 'table_cell_changed' };
    }
    const column = tableNode.columns.find(column => column.key === colKey);
    return { status: 'resolved', resolvedSnippet: JSON.stringify({ column, value: cell }), resolvedRange: { row: rowIdx, col: colKey, rowHash, rowOrderHash, displayFingerprint: currentDisplay } };

  }

  return { status: 'needs_review', reason: 'unsupported_rich_selector_kind' };
}
