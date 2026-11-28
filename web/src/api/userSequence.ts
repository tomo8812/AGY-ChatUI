/** User-scoped sequence numbers, not the global SQLite sequence, define delivery order. */
export interface UserSequencedEvent {
  seq: number;
  userSeq: number;
}

export class UserSequenceBuffer<T extends UserSequencedEvent> {
  private readonly pendingBuffer = new Map<number, T>();
  private contiguous = 0;
  private globalSeq = 0;
  private resyncing = false;

  get contiguousUserSeq(): number { return this.contiguous; }
  get lastSeq(): number { return this.globalSeq; }
  get isResyncing(): boolean { return this.resyncing; }
  get pendingCount(): number { return this.pendingBuffer.size; }

  offer(event: T): void {
    if (!Number.isSafeInteger(event.userSeq) || event.userSeq < 1 ||
        !Number.isSafeInteger(event.seq) || event.seq < 1) {
      throw new Error('INVALID_SYNC_SEQUENCE');
    }
    if (event.userSeq > this.contiguous && !this.pendingBuffer.has(event.userSeq)) {
      this.pendingBuffer.set(event.userSeq, event);
    }
  }

  /** A callback failure must not advance the durable cursor. */
  drain(apply: (event: T) => void): void {
    if (this.resyncing) return;
    while (true) {
      const next = this.pendingBuffer.get(this.contiguous + 1);
      if (!next) return;
      apply(next);
      this.pendingBuffer.delete(next.userSeq);
      this.contiguous = next.userSeq;
      this.globalSeq = Math.max(this.globalSeq, next.seq);
    }
  }

  needsReplay(latestUserSeq: number): boolean {
    if (this.resyncing) return false;
    return latestUserSeq > this.contiguous || this.pendingBuffer.size > 0;
  }

  beginSnapshot(): void {
    this.resyncing = true;
  }

  /** Call only after the authoritative snapshot has been successfully applied. */
  completeSnapshot(snapshotUserSeq: number, latestSeq: number): void {
    if (!this.resyncing || !Number.isSafeInteger(snapshotUserSeq) || snapshotUserSeq < this.contiguous ||
        !Number.isSafeInteger(latestSeq) || latestSeq < this.globalSeq) {
      throw new Error('INVALID_SYNC_SNAPSHOT');
    }
    this.contiguous = snapshotUserSeq;
    this.globalSeq = latestSeq;
    for (const seq of this.pendingBuffer.keys()) {
      if (seq <= snapshotUserSeq) this.pendingBuffer.delete(seq);
    }
    this.resyncing = false;
  }
}
