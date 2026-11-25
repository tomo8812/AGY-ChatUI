import { describe, expect, it } from 'vitest';
import { UserSequenceBuffer } from '../../web/src/api/userSequence';

const event = (userSeq: number, seq = userSeq * 4) => ({ userSeq, seq });

describe('user-scoped WebSocket replay buffer', () => {
  it('applies only contiguous events in user sequence, ignoring duplicate frames and gaps in global sequence', () => {
    const buffer = new UserSequenceBuffer<ReturnType<typeof event>>();
    const seen: number[] = [];
    const apply = (item: ReturnType<typeof event>) => seen.push(item.userSeq);
    buffer.offer(event(2));
    buffer.drain(apply);
    expect(seen).toEqual([]);
    expect(buffer.needsReplay(2)).toBe(true);
    buffer.offer(event(1));
    buffer.offer(event(2));
    buffer.drain(apply);
    buffer.offer(event(1));
    buffer.drain(apply);
    expect(seen).toEqual([1, 2]);
    expect(buffer.contiguousUserSeq).toBe(2);
    expect(buffer.lastSeq).toBe(8);
    expect(buffer.needsReplay(2)).toBe(false);
  });

  it('buffers live events during snapshot and discards only those covered by its atomic cursor', () => {
    const buffer = new UserSequenceBuffer<ReturnType<typeof event>>();
    const seen: number[] = [];
    buffer.beginSnapshot();
    buffer.offer(event(7));
    buffer.offer(event(5));
    buffer.offer(event(6));
    buffer.drain(item => seen.push(item.userSeq));
    expect(seen).toEqual([]);
    buffer.completeSnapshot(5, 20);
    buffer.drain(item => seen.push(item.userSeq));
    expect(seen).toEqual([6, 7]);
    expect(buffer.contiguousUserSeq).toBe(7);
  });

  it('keeps the old cursor when delivery or snapshot validation fails', () => {
    const buffer = new UserSequenceBuffer<ReturnType<typeof event>>();
    buffer.offer(event(1));
    expect(() => buffer.drain(() => { throw new Error('apply failed'); })).toThrow();
    expect(buffer.contiguousUserSeq).toBe(0);
    buffer.drain(() => {});
    buffer.beginSnapshot();
    expect(() => buffer.completeSnapshot(0, 0)).toThrow('INVALID_SYNC_SNAPSHOT');
    expect(buffer.isResyncing).toBe(true);
    buffer.offer(event(2));
    buffer.completeSnapshot(1, 4);
    buffer.drain(() => {});
    expect(buffer.contiguousUserSeq).toBe(2);
  });
});
