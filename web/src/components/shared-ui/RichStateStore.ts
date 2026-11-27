import type { RichDocumentV1, RichStateAction, RichStateValue } from '../../../../shared/rich-schema';
import {
  compileRichDynamicPlan,
  createRichEvalBudget,
  evaluateRichAst,
  evaluateRichDynamicState,
  evaluateRichExpr,
  RichExprError,
  assertRichStateLimit,
  cloneRichStateValue,
  mergeRichState,
  validateRichDocument,
  type RichDynamicPlan,
  type RichDynamicStats,
  type RichEvalBudget,
  type RichEvalContext,
  type RichSubtreeCache,
} from './RichExprEvaluator';

type Theme = 'light' | 'dark';
type State = Record<string, RichStateValue>;
type Listener = () => void;
export interface RichStateSnapshot {
  readonly state: Readonly<State>;
  readonly computed: Readonly<Record<string, unknown>>;
  readonly theme: Theme;
  readonly version: number;
  readonly stats: Readonly<RichDynamicStats>;
}

const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** Store one independent rich block. A failed mutation never publishes partial state. */
export class RichStateStore {
  private readonly document: RichDocumentV1;
  private readonly initial: State;
  private readonly plan: RichDynamicPlan;
  private readonly authorized: Set<string>;
  private readonly listeners = new Set<Listener>();
  private readonly keyListeners = new Map<string, Set<Listener>>();
  private readonly projectionListeners = new Map<string, Set<Listener>>();
  private snapshot: RichStateSnapshot;
  private subtreeCache: RichSubtreeCache | undefined;
  private computedStepsByKey: Map<string, number> | undefined;
  private versionCounter = 0;

  constructor(document: RichDocumentV1, authorizedArtifactIds: Iterable<string> = [], theme: Theme = 'light', restoredState?: State | null) {
    this.document = JSON.parse(JSON.stringify(document)) as RichDocumentV1;
    this.authorized = new Set(authorizedArtifactIds);
    this.initial = Object.freeze(mergeRichState(this.document.state));

    // Run full static + initial dynamic validation once at construction time.
    const initialValidation = validateRichDocument({ ...this.document, state: this.initial }, {
      authorizedArtifactIds: this.authorized,
      theme,
    });
    if (!initialValidation.valid) {
      throw new RichExprError(
        initialValidation.primaryErrorCode ?? 'RICH_INVALID_STATE',
        initialValidation.issues[0]?.message ?? 'Invalid rich state.',
        initialValidation.statusCode,
      );
    }

    // Compile AST + dependency plan once so subsequent slider/control updates
    // avoid whole-document JSON serialization, static re-validation, AST
    // re-parsing, and untouched computed/subtree re-evaluation.
    this.plan = compileRichDynamicPlan(this.document, undefined);
    const evaluate = (state: State) => evaluateRichDynamicState(this.plan, {
      state, theme, authorizedArtifactIds: this.authorized,
    });
    let state = this.initial;
    let initialEval = evaluate(state);
    if (restoredState) {
      try {
        const restored = Object.freeze(mergeRichState(this.initial, restoredState));
        const evaluation = evaluate(restored);
        if (evaluation.valid) {
          state = restored;
          initialEval = evaluation;
        }
      } catch (error) {
        if (!(error instanceof RichExprError)) throw error;
      }
    }
    if (!initialEval.valid) {
      throw new RichExprError(
        initialEval.primaryErrorCode ?? 'RICH_INVALID_STATE',
        initialEval.issues[0]?.message ?? 'Invalid rich state.',
        initialEval.statusCode,
      );
    }
    this.subtreeCache = initialEval.subtreeCache;
    this.computedStepsByKey = initialEval.computedStepsByKey;
    this.versionCounter = 1;
    this.snapshot = Object.freeze({
      state,
      computed: Object.freeze(initialEval.computed),
      theme,
      version: this.versionCounter,
      stats: Object.freeze(initialEval.stats),
    });
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
    if (theme !== this.snapshot.theme) this.validateAndPublish({ ...this.snapshot.state }, theme);
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

  private computeForActions(state: State, theme: Theme, budget: RichEvalBudget): Record<string, unknown> {
    const computed: Record<string, unknown> = Object.create(null);
    const ctx: RichEvalContext = { state, computed, theme };
    for (const key of this.plan.computedOrder) {
      if (forbidden.has(key)) throw new RichExprError('RICH_INVALID_COMPUTED_KEY', 'Invalid computed key.');
      computed[key] = evaluateRichAst(this.plan.computedAsts.get(key)!, ctx, budget);
    }
    return computed;
  }

  private validateAndPublish(state: State, theme: Theme): void {
    assertRichStateLimit(state);
    const previous = this.snapshot;
    const result = evaluateRichDynamicState(this.plan, {
      state,
      theme,
      authorizedArtifactIds: this.authorized,
      previousState: previous.state,
      previousComputed: previous.computed,
      previousTheme: previous.theme,
      previousSubtreeCache: this.subtreeCache,
      previousComputedSteps: this.computedStepsByKey,
    });
    if (!result.valid) {
      throw new RichExprError(
        result.primaryErrorCode ?? 'RICH_INVALID_STATE',
        result.issues[0]?.message ?? 'Invalid rich state.',
        result.statusCode,
      );
    }

    this.subtreeCache = result.subtreeCache;
    this.computedStepsByKey = result.computedStepsByKey;
    this.versionCounter += 1;

    const frozenState = Object.freeze(state);
    const frozenComputed = Object.freeze(result.computed);
    const nextSnapshot: RichStateSnapshot = Object.freeze({
      state: frozenState,
      computed: frozenComputed,
      theme,
      version: this.versionCounter,
      stats: Object.freeze(result.stats),
    });

    this.snapshot = nextSnapshot;
    const pending = new Set<Listener>();
    const notify = (key: string) => {
      for (const listener of this.projectionListeners.get(key) ?? []) pending.add(listener);
    };
    for (const key of Object.keys(frozenState)) {
      if (!Object.is(previous.state[key], frozenState[key])) {
        notify('state:' + key);
        notify('state:*');
      }
    }
    for (const key of Object.keys(frozenComputed)) {
      if (!Object.is(previous.computed[key], frozenComputed[key])) {
        notify('computed:' + key);
        notify('computed:*');
      }
    }
    if (previous.theme !== theme) notify('theme');
    for (const listener of pending) listener();
    for (const [key, listeners] of this.keyListeners) {
      if (!Object.is(previous.state[key], frozenState[key])) {
        for (const listener of [...listeners]) listener();
      }
    }
    for (const listener of [...this.listeners]) listener();
  }

  private apply(actions: readonly RichStateAction[], binding?: { key: string; value: unknown }, local: Partial<RichEvalContext> = {}): void {
    const next: State = Object.assign(Object.create(null), this.snapshot.state);
    const theme = this.snapshot.theme;
    const budget = createRichEvalBudget();
    if (binding) next[binding.key] = cloneRichStateValue(binding.value);
    assertRichStateLimit(next);
    for (const action of actions) {
      const evalValue = (expr: string) => evaluateRichExpr(expr, {
        ...local, state: next, computed: this.computeForActions(next, theme, budget), theme,
      }, budget);
      switch (action.type) {
        case 'set_state':
          this.assertKey(action.key);
          next[action.key] = cloneRichStateValue(evalValue(action.valueExpr));
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
          next[action.key] = cloneRichStateValue(Math.max(min, Math.min(max, current + delta)));
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
      assertRichStateLimit(next);
    }
    this.validateAndPublish(next, theme);
  }
}
