import type { RichStateAction, RichValue, RichColorToken } from '../../../../shared/rich-schema';
import {
  createRichEvalBudget,
  evaluateRichExpr,
  RICH_LIMITS,
  RichExprError,
  type RichEvalBudget,
  type RichEvalContext,
} from './RichExprEvaluator';

export interface RenderCycle {
  budget: RichEvalBudget;
  nodes: number;
  svgElements: number;
  dataPoints?: number;
  readonly accounting?: BlockRenderAccounting;
  readonly scopePath?: string;
}

interface ScopeContribution {
  nodes: number;
  svgElements: number;
  dataPoints: number;
  steps: number;
}

/**
 * Block-wide render safety accountant shared across every RichNodeView,
 * repeat instance, partial re-render, and lazy-loaded renderer (SvgScene,
 * RichChart, NodeEdgeDiagram) inside a single RichRenderer block.
 *
 * Each mounted scope (identified by its deterministic node path) owns its own
 * contribution slot. Re-rendering a scope replaces only its own previous
 * contribution while preserving all sibling scopes, preventing both:
 *   1. Cross-node/cross-lazy budget evasion (total <= block ceilings), and
 *   2. False drift from React StrictMode double-renders or partial slider updates.
 */
export class BlockRenderAccounting {
  private readonly scopes = new Map<string, ScopeContribution>();
  private baseSteps = 0;
  private totalNodes = 0;
  private totalSvgElements = 0;
  private totalDataPoints = 0;
  private totalScopeSteps = 0;

  setBaseSteps(steps: number): void {
    this.baseSteps = Math.max(0, Number.isFinite(steps) ? Math.floor(steps) : 0);
    if (this.baseSteps + this.totalScopeSteps > RICH_LIMITS.maxAstSteps) {
      throw new RichExprError(
        'RICH_EXPR_BUDGET_EXCEEDED',
        `Expression evaluation exceeded the maximum budget of ${RICH_LIMITS.maxAstSteps} AST steps.`,
        422,
      );
    }
  }

  getTotals(): { nodes: number; svgElements: number; dataPoints: number; steps: number; scopeCount: number } {
    return {
      nodes: this.totalNodes,
      svgElements: this.totalSvgElements,
      dataPoints: this.totalDataPoints,
      steps: this.baseSteps + this.totalScopeSteps,
      scopeCount: this.scopes.size,
    };
  }

  removeScope(scopePath: string): void {
    const prev = this.scopes.get(scopePath);
    if (!prev) return;
    this.totalNodes -= prev.nodes;
    this.totalSvgElements -= prev.svgElements;
    this.totalDataPoints -= prev.dataPoints;
    this.totalScopeSteps -= prev.steps;
    this.scopes.delete(scopePath);
  }

  removeSubtree(prefix: string): void {
    for (const key of [...this.scopes.keys()]) {
      if (key === prefix || key.startsWith(prefix + '-') || key.startsWith(prefix + ':')) {
        this.removeScope(key);
      }
    }
  }

  beginScope(scopePath: string): RenderCycle {
    this.removeScope(scopePath);
    const slot: ScopeContribution = { nodes: 0, svgElements: 0, dataPoints: 0, steps: 0 };
    this.scopes.set(scopePath, slot);
    const accounting = this;
    const budget: RichEvalBudget = {
      get steps() {
        return accounting.baseSteps + accounting.totalScopeSteps;
      },
      set steps(nextTotal: number) {
        const delta = nextTotal - (accounting.baseSteps + accounting.totalScopeSteps);
        if (delta !== 0) {
          slot.steps += delta;
          accounting.totalScopeSteps += delta;
        }
      },
      maxSteps: RICH_LIMITS.maxAstSteps,
    };

    return {
      budget,
      get nodes() {
        return accounting.totalNodes;
      },
      set nodes(nextTotal: number) {
        const delta = nextTotal - accounting.totalNodes;
        if (delta !== 0) {
          slot.nodes += delta;
          accounting.totalNodes += delta;
        }
      },
      get svgElements() {
        return accounting.totalSvgElements;
      },
      set svgElements(nextTotal: number) {
        const delta = nextTotal - accounting.totalSvgElements;
        if (delta !== 0) {
          slot.svgElements += delta;
          accounting.totalSvgElements += delta;
        }
      },
      get dataPoints() {
        return accounting.totalDataPoints;
      },
      set dataPoints(nextTotal: number) {
        const delta = nextTotal - accounting.totalDataPoints;
        if (delta !== 0) {
          slot.dataPoints += delta;
          accounting.totalDataPoints += delta;
        }
      },
      accounting,
      scopePath,
    };
  }
}

export function createStandaloneRenderCycle(): RenderCycle {
  return { budget: createRichEvalBudget(), nodes: 0, svgElements: 0, dataPoints: 0 };
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
    if (++cycle.svgElements > RICH_LIMITS.maxExpandedSvgElements) {
      throw new RichExprError('RICH_EXPANDED_SVG_LIMIT_EXCEEDED', '図の表示上限を超えました。', 422);
    }
  } else if (++cycle.nodes > RICH_LIMITS.maxExpandedNodes) {
    throw new RichExprError('RICH_EXPANDED_NODE_LIMIT_EXCEEDED', '表示項目数の上限を超えました。', 422);
  }
}
export function addDataPoints(cycle: RenderCycle, count: number): void {
  if (count <= 0) return;
  const next = (cycle.dataPoints ?? 0) + count;
  cycle.dataPoints = next;
  if (next > RICH_LIMITS.maxArrayPoints) {
    throw new RichExprError('RICH_EXPANDED_ARRAY_LIMIT_EXCEEDED', 'データ点数の上限を超えました。', 422);
  }
}
export function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}
export function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export function safeArray<T>(value: unknown, cycle?: RenderCycle, multiplier = 1): T[] {
  if (!Array.isArray(value)) return [];
  const weight = value.length * Math.max(1, multiplier);
  if (weight > RICH_LIMITS.maxArrayPoints) {
    throw new RichExprError('RICH_EXPANDED_ARRAY_LIMIT_EXCEEDED', 'データ点数の上限を超えました。', 422);
  }
  if (cycle) addDataPoints(cycle, weight);
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
