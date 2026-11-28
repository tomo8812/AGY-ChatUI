import { describe, expect, it, vi } from 'vitest';
import type { RichDocumentV1, RichStateAction } from '../../shared/rich-schema';
import { RichStateStore } from '../../web/src/components/shared-ui/RichStateStore';

const document: RichDocumentV1 = {
  schemaVersion: 1,
  state: { amount: 2, enabled: false, other: 'stable' },
  computed: { double: '$state.amount * 2' },
  root: { id: 'text', type: 'text', content: { expr: 'concat("Amount ", $computed.double)' } },
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
  it('notifies only dependent state/computed projections, including dynamic access', () => {
    const store = new RichStateStore(document);
    const computed=vi.fn(), unrelated=vi.fn(), wildcard=vi.fn(), both=vi.fn();
    const unsubscribe=store.subscribeProjection(['computed:double'],computed);
    store.subscribeProjection(['state:other'],unrelated);
    store.subscribeProjection(['state:*'],wildcard);
    store.subscribeProjection(['state:amount','computed:double'],both);
    store.set('amount',5);
    expect(computed).toHaveBeenCalledTimes(1);
    expect(unrelated).not.toHaveBeenCalled();
    expect(wildcard).toHaveBeenCalledTimes(1);
    expect(both).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set('amount',6);
    expect(computed).toHaveBeenCalledTimes(1);
    store.set('other','changed');
    expect(unrelated).toHaveBeenCalledTimes(1);
    expect(both).toHaveBeenCalledTimes(2);
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
  it('rejects a dynamic external image URL after state evaluation', () => {
    const store = new RichStateStore({
      schemaVersion: 1,
      state: { payload: 'safe' },
      root: { id: 'markdown', type: 'markdown', content: { expr: '$state.payload' } },
    });
    const before = store.getSnapshot();
    expect(() => store.set('payload', '![remote](https://example.com/image.png)')).toThrow();
    expect(store.getSnapshot()).toBe(before);
  });
  it('rejects repeated evaluated chart arrays before publishing an oversized render', () => {
    const store = new RichStateStore({
      schemaVersion: 1, state: { data: [] },
      root: { id:'root', type:'stack', direction:'col', children:[
        { id:'first', type:'chart', chartType:'line', series:[{key:'s',label:'S',data:{expr:'$state.data'}}] },
        { id:'second', type:'chart', chartType:'bar', series:[{key:'s',label:'S',data:{expr:'$state.data'}}] },
      ] },
    });
    const before=store.getSnapshot();
    expect(() => store.set('data',Array(6000).fill(1))).toThrow('Expanded data point limit');
    expect(store.getSnapshot()).toBe(before);
  });
  it('rejects repeat expansion beyond the dynamic node limit', () => {
    const store = new RichStateStore({
      schemaVersion: 1,
      state: { rows: [] },
      root: {
        id: 'list', type: 'stack', direction: 'col', children: [
          { id: 'row', type: 'text', content: { expr: 'concat("", $item)' },
            repeat: { itemsExpr: '$state.rows', as: 'row' } },
        ],
      },
    });
    expect(() => store.set('rows', Array(2001).fill('x'))).toThrow();
    expect(store.getStateValue('rows')).toEqual([]);
  });
});
