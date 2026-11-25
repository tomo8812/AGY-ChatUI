import type { RichStateAction, RichValue, RichColorToken } from '../../../../shared/rich-schema';
import { evaluateRichExpr, RICH_LIMITS, type RichEvalBudget, type RichEvalContext } from './RichExprEvaluator';

export interface RenderCycle {
  budget: RichEvalBudget;
  nodes: number;
  svgElements: number;
}
export function evaluate<T>(value: RichValue<T> | undefined, context: RichEvalContext, cycle: RenderCycle): T | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'expr' in value) {
    return evaluateRichExpr(String(value.expr), context, cycle.budget) as T;
  }
  return value as T | undefined;
}
export function expression(expr: string, context: RichEvalContext, cycle: RenderCycle): unknown {
  return evaluateRichExpr(expr, context, cycle.budget);
}
export function addNode(cycle: RenderCycle, svg = false): void {
  if (svg) {
    if (++cycle.svgElements > RICH_LIMITS.maxExpandedSvgElements) throw Error('図の表示上限を超えました。');
  } else if (++cycle.nodes > RICH_LIMITS.maxExpandedNodes) throw Error('表示項目数の上限を超えました。');
}
export function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}
export function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export function safeArray<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  if (value.length > RICH_LIMITS.maxArrayPoints) throw Error('データ点数の上限を超えました。');
  return value as T[];
}
export function repeatContexts(spec: { itemsExpr: string; as: string; keyField?: string }, context: RichEvalContext, cycle: RenderCycle) {
  const rows = safeArray<unknown>(expression(spec.itemsExpr, context, cycle));
  const keys = rows.map(item => {
    if (!spec.keyField || !item || typeof item !== 'object' || !Object.prototype.hasOwnProperty.call(item, spec.keyField)) return null;
    const value = (item as Record<string, unknown>)[spec.keyField];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  });
  const counts = new Map<string, number>();
  for (const key of keys) if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  return rows.map((item, index) => ({
    key: keys[index] !== null && counts.get(keys[index]!) === 1 ? 'item:' + keys[index] : 'index:' + index,
    context: { ...context, item, index, aliases: { ...context.aliases, [spec.as]: item } },
  }));
}
const palette: Record<RichColorToken, string> = {
  primary: 'var(--text-primary)', secondary: 'var(--text-secondary)', accent: 'var(--link-color)',
  muted: 'var(--text-muted)', info: 'var(--link-color)', success: 'var(--ok)', warning: 'var(--warn)', danger: 'var(--danger)',
  series1: 'var(--rich-series1)', series2: 'var(--rich-series2)', series3: 'var(--rich-series3)',
  series4: 'var(--rich-series4)', series5: 'var(--rich-series5)', series6: 'var(--rich-series6)',
};
export function color(token: unknown, index = 0): string {
  return typeof token === 'string' && Object.prototype.hasOwnProperty.call(palette, token)
    ? palette[token as RichColorToken] : palette[('series' + (index % 6 + 1)) as RichColorToken];
}
export type SelectValue = (bind: string | undefined, value: unknown, actions: RichStateAction[] | undefined, context: RichEvalContext) => void;
