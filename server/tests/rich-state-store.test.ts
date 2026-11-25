import { describe, expect, it, vi } from 'vitest';
import type { RichDocumentV1, RichStateAction } from '../../shared/rich-schema';
import { RichStateStore } from '../../web/src/components/shared-ui/RichStateStore';

const document: RichDocumentV1 = {
  schemaVersion: 1,
  state: { amount: 2, enabled: false, other: 'stable' },
  computed: { double: '$state.amount * 2' },
  root: { id: 'text', type: 'text', text: { expr: '$computed.double' } },
};

describe('RichStateStore', () => {
  it('updates computed values and notifies only changed state keys', () => {
    const store = new RichStateStore(document);
    const amount = vi.fn();
    const other = vi.fn();
    store.subscribeKey('amount', amount);
    store.subscribeKey('other', other);
    store.set('amount', 5);
    expect(store.getSnapshot().computed.double).toBe(10);
    expect(amount).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
  it('rejects undeclared state and side effects atomically', () => {
    const store = new RichStateStore(document);
    const before = store.getSnapshot();
    expect(() => store.set('unknown', 1)).toThrow();
    expect(() => store.dispatch([
      { type: 'increment_state', key: 'amount' },
      { type: 'copy_text', textExpr: '"no"' } as unknown as RichStateAction,
    ])).toThrow('State events cannot execute side effects');
    expect(store.getSnapshot()).toBe(before);
  });
  it('rejects oversized state and computed cycles', () => {
    const store = new RichStateStore(document);
    expect(() => store.set('other', 'x'.repeat(140000))).toThrow();
    expect(store.getStateValue('other')).toBe('stable');
    expect(() => new RichStateStore({ ...document, computed: { x: '$computed.y', y: '$computed.x' } })).toThrow();
  });
});
