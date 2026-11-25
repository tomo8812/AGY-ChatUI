import type { RichDocumentV1, RichStateAction, RichStateValue } from '../../../../shared/rich-schema';
import {
  createRichEvalBudget, evaluateRichAst, evaluateRichExpr, RichExprError, topologicalSortComputed,
  RICH_LIMITS, validateRichDocument, type RichEvalBudget, type RichEvalContext,
} from './RichExprEvaluator';

type Theme = 'light' | 'dark';
type State = Record<string, RichStateValue>;
type Listener = () => void;
export interface RichStateSnapshot {
  readonly state: Readonly<State>;
  readonly computed: Readonly<Record<string, unknown>>;
  readonly theme: Theme;
}

const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}
function isPrimitiveRecord(value: unknown): value is Record<string, string | number | boolean | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) &&
    Object.entries(value).every(([key, item]) => !forbidden.has(key) && isPrimitive(item));
}
function cloneValue(value: unknown): RichStateValue {
  if (isPrimitive(value)) return value;
  if (isPrimitiveRecord(value)) return Object.freeze({ ...value });
  if (Array.isArray(value) && value.length <= RICH_LIMITS.maxArrayPoints) {
    if (value.every(isPrimitive)) return Object.freeze([...value]) as unknown as RichStateValue;
    if (value.every(isPrimitiveRecord)) {
      return Object.freeze(value.map(item => Object.freeze({ ...item }))) as unknown as RichStateValue;
    }
  }
  throw new RichExprError('RICH_INVALID_STATE_VALUE', 'Invalid state value.');
}

function assertStateLimit(state: State): void {
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (bytes > RICH_LIMITS.maxStateBytes) {
    throw new RichExprError('RICH_STATE_TOO_LARGE', 'State exceeds the byte limit.', 422);
  }
}

/** Store one independent rich block. A failed mutation never publishes partial state. */
export class RichStateStore {
  private readonly document: RichDocumentV1;
  private readonly initial: State;
  private readonly computedPlan: ReturnType<typeof topologicalSortComputed>;
  private readonly authorized: Set<string>;
  private readonly listeners = new Set<Listener>();
  private readonly keyListeners = new Map<string, Set<Listener>>();
  private readonly projectionListeners = new Map<string, Set<Listener>>();
  private snapshot: RichStateSnapshot;

  constructor(document: RichDocumentV1, authorizedArtifactIds: Iterable<string> = [], theme: Theme = 'light') {
    this.document = JSON.parse(JSON.stringify(document)) as RichDocumentV1;
    this.authorized = new Set(authorizedArtifactIds);
    this.initial = Object.create(null) as State;
    for (const [key, value] of Object.entries(this.document.state ?? {})) {
      if (forbidden.has(key)) throw new RichExprError('RICH_INVALID_STATE_KEY', 'Invalid state key.');
      this.initial[key] = cloneValue(value);
    }
    Object.freeze(this.initial);
    this.computedPlan = topologicalSortComputed(this.document.computed ?? {});
    if (this.computedPlan.cycle) throw new RichExprError('RICH_COMPUTED_CYCLE', 'Circular computed values.');
    this.snapshot = this.validateAndCompute(this.initial, theme);
  }

  getSnapshot = (): RichStateSnapshot => this.snapshot;
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Subscribe to one state key; unrelated state writes do not notify this listener. */
  subscribeKey(key: string, listener: Listener): () => void {
    this.assertKey(key);
    const listeners = this.keyListeners.get(key) ?? new Set<Listener>();
    listeners.add(listener);
    this.keyListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.keyListeners.delete(key);
    };
  }

  /** A projection publishes only when one of its referenced values changes.
   * Wildcards cover computed/dynamic property lookups and whole-record expressions. */
  subscribeProjection(keys: readonly string[], listener: Listener): () => void {
    for (const key of keys) {
      const set = this.projectionListeners.get(key) ?? new Set<Listener>();
      set.add(listener);
      this.projectionListeners.set(key, set);
    }
    return () => {
      for (const key of keys) {
        const set = this.projectionListeners.get(key);
        set?.delete(listener);
        if (!set?.size) this.projectionListeners.delete(key);
      }
    };
  }

  getStateValue(key: string): RichStateValue {
    this.assertKey(key);
    return this.snapshot.state[key];
  }

  setTheme(theme: Theme): void {
    if (theme !== this.snapshot.theme) this.publish(this.validateAndCompute({ ...this.snapshot.state }, theme));
  }

  set(key: string, value: unknown, actions: readonly RichStateAction[] = [], context: Partial<RichEvalContext> = {}): void {
    this.assertKey(key);
    this.apply(actions, { key, value }, context);
  }

  dispatch(actions: readonly RichStateAction[], context: Partial<RichEvalContext> = {}): void {
    this.apply(actions, undefined, context);
  }

  /** Expose an evaluation context for a bounded renderer; action context cannot override state/computed. */
  context(item?: unknown, index?: number, aliases?: Record<string, unknown>): RichEvalContext {
    return { state: this.snapshot.state, computed: this.snapshot.computed, theme: this.snapshot.theme, item, index, aliases };
  }

  private assertKey(key: string): void {
    if (forbidden.has(key) || !own(this.initial, key)) {
      throw new RichExprError('RICH_UNDECLARED_STATE_KEY', 'State key is not declared.');
    }
  }

  private compute(state: State, theme: Theme, budget: RichEvalBudget): Record<string, unknown> {
    const computed: Record<string, unknown> = Object.create(null);
    const ctx: RichEvalContext = { state, computed, theme };
    for (const key of this.computedPlan.order) {
      if (forbidden.has(key)) throw new RichExprError('RICH_INVALID_COMPUTED_KEY', 'Invalid computed key.');
      computed[key] = evaluateRichAst(this.computedPlan.asts.get(key)!, ctx, budget);
    }
    return computed;
  }

  private validateAndCompute(state: State, theme: Theme): RichStateSnapshot {
    assertStateLimit(state);
    const result = validateRichDocument({ ...this.document, state }, {
      authorizedArtifactIds: this.authorized,
      theme,
    });
    if (!result.valid) throw new RichExprError(result.primaryErrorCode ?? 'RICH_INVALID_STATE', result.issues[0]?.message ?? 'Invalid rich state.', result.statusCode);
    const computed = this.compute(state, theme, createRichEvalBudget());
    return Object.freeze({ state: Object.freeze(state), computed: Object.freeze(computed), theme });
  }

  private apply(actions: readonly RichStateAction[], binding?: { key: string; value: unknown }, local: Partial<RichEvalContext> = {}): void {
    const next: State = Object.assign(Object.create(null), this.snapshot.state);
    const theme = this.snapshot.theme;
    const budget = createRichEvalBudget();
    if (binding) next[binding.key] = cloneValue(binding.value);
    assertStateLimit(next);
    for (const action of actions) {
      const evalValue = (expr: string) => evaluateRichExpr(expr, {
        ...local, state: next, computed: this.compute(next, theme, budget), theme,
      }, budget);
      switch (action.type) {
        case 'set_state':
          this.assertKey(action.key);
          next[action.key] = cloneValue(evalValue(action.valueExpr));
          break;
        case 'toggle_state':
          this.assertKey(action.key);
          if (typeof next[action.key] !== 'boolean') throw new RichExprError('RICH_INVALID_STATE_VALUE', 'Expected boolean.');
          next[action.key] = !next[action.key];
          break;
        case 'increment_state': {
          this.assertKey(action.key);
          const current = next[action.key];
          const delta = action.deltaExpr === undefined ? 1 : evalValue(action.deltaExpr);
          if (typeof current !== 'number' || typeof delta !== 'number') throw new RichExprError('RICH_INVALID_STATE_VALUE', 'Expected numeric state and delta.');
          const min = action.min ?? -Infinity;
          const max = action.max ?? Infinity;
          if (min > max) throw new RichExprError('RICH_INVALID_STATE_VALUE', 'Invalid increment limits.');
          next[action.key] = cloneValue(Math.max(min, Math.min(max, current + delta)));
          break;
        }
        case 'reset_state':
          for (const key of action.keys ?? Object.keys(this.initial)) {
            this.assertKey(key);
            next[key] = this.initial[key];
          }
          break;
        default:
          throw new RichExprError('RICH_SIDE_EFFECT_FORBIDDEN', 'State events cannot execute side effects.');
      }
      assertStateLimit(next);
    }
    this.publish(this.validateAndCompute(next, theme));
  }

  private publish(snapshot: RichStateSnapshot): void {
    const previous = this.snapshot;
    // The evaluator can return new arrays for unchanged computed values.
    // Preserve their identity so unrelated state changes do not redraw charts.
    const computed = Object.assign(Object.create(null), snapshot.computed) as Record<string, unknown>;
    for (const key of Object.keys(computed)) {
      const old = previous.computed[key], next = computed[key];
      if (Object.is(old, next) || (old !== undefined && next !== undefined &&
        typeof old === 'object' && typeof next === 'object' && JSON.stringify(old) === JSON.stringify(next))) {
        computed[key] = old;
      }
    }
    this.snapshot = Object.freeze({ ...snapshot, computed: Object.freeze(computed) });
    const pending = new Set<Listener>();
    const notify = (key: string) => { for (const listener of this.projectionListeners.get(key) ?? []) pending.add(listener); };
    for (const key of Object.keys(snapshot.state)) if (!Object.is(previous.state[key], snapshot.state[key])) {
      notify('state:' + key); notify('state:*');
    }
    for (const key of Object.keys(computed)) if (!Object.is(previous.computed[key], computed[key])) {
      notify('computed:' + key); notify('computed:*');
    }
    if (previous.theme !== snapshot.theme) notify('theme');
    for (const listener of pending) listener();
    for (const [key, listeners] of this.keyListeners) {
      if (!Object.is(previous.state[key], snapshot.state[key])) {
        for (const listener of [...listeners]) listener();
      }
    }
    for (const listener of [...this.listeners]) listener();
  }
}
