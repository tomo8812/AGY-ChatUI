export class ArtifactLockManager {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    this.tails.set(key, chained);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === chained) {
        this.tails.delete(key);
      }
    }
  }

  /**
   * Deadlock-free multi-key lock acquisition: deduplicates and sorts keys lexicographically.
   */
  async withLocks<T>(keys: string[], fn: () => Promise<T> | T): Promise<T> {
    const sorted = [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const runNested = (idx: number): Promise<T> => {
      if (idx >= sorted.length) {
        return Promise.resolve().then(fn);
      }
      return this.withLock(sorted[idx], () => runNested(idx + 1));
    };
    return runNested(0);
  }
}
