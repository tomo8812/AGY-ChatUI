import crypto from 'node:crypto';
import type { RichBlockRecord, RichNode, RichSvgElement } from '../../../shared/rich-schema.js';
import { targetSelectorSchema } from '../artifacts/target-selector-schema.js';
import { canonicalJson } from '../artifacts/idempotency-coordinator.js';
import type { TargetResolutionResult, TargetSelector } from '../artifacts/types.js';
import { createRichEvalBudget, evaluateRichExpr } from '../rich/rich-expr-evaluator.js';
import { topologicalSortComputed } from '../rich/rich-validator.js';

function sha256(val: unknown): string {
  const s = typeof val === 'string' ? val : canonicalJson(val);
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function findRichNodeById(root: RichNode | null | undefined, targetId: string): RichNode | null {
  if (!root) return null;
  if (root.id === targetId) return root;
  const anyNode = root as unknown as Record<string, unknown>;
  if (Array.isArray(anyNode.children)) {
    for (const child of anyNode.children as RichNode[]) {
      const found = findRichNodeById(child, targetId);
      if (found) return found;
    }
  }
  if (root.type === 'media_asset' && root.svgScene) {
    const found = findRichNodeById(root.svgScene, targetId);
    if (found) return found;
  }
  if (root.type === 'card') {
    if (root.headerAction) {
      const f = findRichNodeById(root.headerAction, targetId);
      if (f) return f;
    }
    if (root.footer) {
      const f = findRichNodeById(root.footer, targetId);
      if (f) return f;
    }
  }
  if (root.type === 'tabs') {
    for (const it of root.items) {
      for (const c of it.content) {
        const f = findRichNodeById(c, targetId);
        if (f) return f;
      }
    }
  }
  if (root.type === 'popover' || root.type === 'tooltip') {
    if (root.trigger) {
      const t = findRichNodeById(root.trigger, targetId);
      if (t) return t;
    }
    if (Array.isArray(root.content)) {
      for (const c of root.content) {
        const f = findRichNodeById(c, targetId);
        if (f) return f;
      }
    }
  }
  return null;
}

function* svgElements(elements: RichSvgElement[]): Generator<RichSvgElement> {
  for (const element of elements) {
    yield element;
    if (element.children) yield* svgElements(element.children);
  }
}

function evalBlockComputed(block: RichBlockRecord): { state: Record<string, unknown>; computed: Record<string, unknown> } {
  const state: Record<string, unknown> = { ...(block.document.state ?? {}), ...(block.uiStateSnapshot ?? {}) };
  const computed: Record<string, unknown> = {};
  if (block.document.computed) {
    const budget = createRichEvalBudget();
    const { order } = topologicalSortComputed(block.document.computed);
    for (const key of order) {
      computed[key] = evaluateRichExpr(block.document.computed[key], { state, computed, theme: 'light' }, budget);
    }
  }
  return { state, computed };
}

/**
 * Resolves a TargetSelector against a RichBlockRecord enforcing strict PIN-02 safety:
 * - Same nodeId replaced by different nodeType or content -> fingerprint mismatch -> needs_review
 * - repeat array reordered (missing keyField / duplicate itemKey / item content changed / order changed) -> needs_review / stale
 */
export function resolveRichBlockTarget(block: RichBlockRecord, selector: TargetSelector): TargetResolutionResult {
  if (!targetSelectorSchema.safeParse(selector).success || selector.blockId !== block.id ||
      selector.baseRevision === undefined || selector.baseRevision > block.revision) {
    return { status: 'needs_review', reason: 'invalid_target_selector' };
  }
  const kind = selector.kind;

  if (kind === 'rich_block') {
    const docHash = sha256(block.document);
    if (selector.expectedDocHash !== docHash) {
      return { status: 'needs_review', reason: 'rich_document_changed' };
    }
    return { status: 'resolved', resolvedSnippet: block.title || block.id };
  }

  if (kind === 'rich_node') {
    const nodeId = String(selector.nodeId ?? '');
    const node = findRichNodeById(block.document.root, nodeId);
    if (!node) return { status: 'stale', reason: 'rich_node_not_found' };
    const expectedType = selector.expectedNodeType;
    const expectedFp = selector.expectedNodeFingerprint;
    const currentFp = sha256(node);
    if (node.type !== expectedType || currentFp !== expectedFp) {
      return { status: 'needs_review', reason: 'rich_node_replaced_or_modified' };
    }
    return { status: 'resolved', resolvedSnippet: JSON.stringify(node).slice(0, 500) };
  }

  if (kind === 'rich_repeat_item') {
    const repeatNodeId = String(selector.repeatNodeId ?? '');
    const repeatNode = findRichNodeById(block.document.root, repeatNodeId);
    if (!repeatNode || !repeatNode.repeat) {
      return { status: 'stale', reason: 'repeat_node_not_found' };
    }
    const { state, computed } = evalBlockComputed(block);
    const items = evaluateRichExpr(repeatNode.repeat.itemsExpr, { state, computed, theme: 'light' });
    if (!Array.isArray(items)) {
      return { status: 'stale', reason: 'repeat_items_not_array' };
    }

    const keyField = repeatNode.repeat.keyField;
    const itemIndex = Number(selector.itemIndex);
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
      return { status: 'resolved', resolvedSnippet: JSON.stringify(curItem), resolvedRange: { itemIndex } };
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

    return {
      status: 'resolved',
      resolvedSnippet: JSON.stringify(foundItem),
      resolvedRange: { itemIndex: foundIdx, itemKey },
    };
  }

  if (kind === 'rich_svg_element') {
    const svgNode = findRichNodeById(block.document.root, String(selector.svgNodeId ?? ''));
    if (!svgNode || svgNode.type !== 'svg_scene') return { status: 'stale', reason: 'svg_node_not_found' };
    const elements = [...svgElements(svgNode.elements)];
    const matches = selector.elementId === undefined
      ? elements.filter(el => el.tag === selector.expectedTag && sha256(el) === selector.expectedElementFingerprint)
      : elements.filter(el => el.id === selector.elementId);
    if (!matches.length) return { status: 'stale', reason: 'svg_element_not_found' };
    const [el] = matches;
    if (matches.length !== 1 || el.tag !== selector.expectedTag || sha256(el) !== selector.expectedElementFingerprint) {
      return { status: 'needs_review', reason: 'svg_element_replaced_or_modified' };
    }
    return { status: 'resolved', resolvedSnippet: JSON.stringify(el) };
  }

  if (kind === 'rich_chart_series') {
    const chartNode = findRichNodeById(block.document.root, String(selector.chartNodeId ?? ''));
    if (!chartNode || chartNode.type !== 'chart') return { status: 'stale', reason: 'chart_node_not_found' };
    const series = chartNode.series.find((s) => s.key === String(selector.seriesKey ?? ''));
    if (!series) return { status: 'stale', reason: 'chart_series_not_found' };
    const data = Array.isArray(series.data) ? series.data
      : evaluateRichExpr(series.data.expr, { ...evalBlockComputed(block), theme: 'light' });
    if (!Array.isArray(data)) return { status: 'needs_review', reason: 'chart_data_unavailable' };
    const fingerprint = sha256({ ...series, data });
    if (fingerprint !== selector.expectedSeriesFingerprint) return { status: 'needs_review', reason: 'chart_series_changed' };
    const index = selector.dataIndex as number | undefined;
    if (index !== undefined && index >= data.length) return { status: 'stale', reason: 'chart_point_not_found' };
    return { status: 'resolved', resolvedSnippet: JSON.stringify(index === undefined ? { ...series, data } : data[index]),
      resolvedRange: { seriesKey: series.key, ...(index === undefined ? {} : { dataIndex: index }) } };

  }

  if (kind === 'rich_table_cell') {
    const tableNode = findRichNodeById(block.document.root, String(selector.tableNodeId ?? ''));
    if (!tableNode || tableNode.type !== 'data_table') return { status: 'stale', reason: 'table_node_not_found' };
    const rows = Array.isArray(tableNode.rows) ? tableNode.rows
      : evaluateRichExpr(tableNode.rows.expr, { ...evalBlockComputed(block), theme: 'light' });
    if (!Array.isArray(rows)) return { status: 'needs_review', reason: 'table_rows_unavailable' };
    const rowIdx = Number(selector.row);
    const colKey = String(selector.col);
    if (rowIdx >= rows.length || !tableNode.columns.some(column => column.key === colKey)) {
      return { status: 'stale', reason: 'table_cell_not_found' };
    }
    const row = rows[rowIdx];
    if (selector.expectedRowKey !== undefined && (row?.id !== selector.expectedRowKey ||
        rows.filter(candidate => candidate?.id === selector.expectedRowKey).length !== 1)) {
      return { status: 'needs_review', reason: 'table_row_changed' };
    }
    const cell = row?.[colKey] ?? null;
    if (sha256(cell) !== selector.expectedCellHash) return { status: 'needs_review', reason: 'table_cell_changed' };
    return { status: 'resolved', resolvedSnippet: JSON.stringify(cell), resolvedRange: { row: rowIdx, col: colKey } };

  }

  return { status: 'needs_review', reason: 'unsupported_rich_selector_kind' };
}
