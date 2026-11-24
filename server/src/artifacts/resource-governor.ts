import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { ArtifactError } from './errors.js';
import type { RuntimeProfile } from './types.js';

export type DocWorkerKind = 'libreoffice' | 'chromium' | 'python' | 'ffmpeg' | 'resvg';

const WORKER_WEIGHTS: Record<DocWorkerKind, number> = {
  libreoffice: 2,
  chromium: 2,
  python: 1,
  ffmpeg: 1,
  resvg: 1,
};

export function readMemAvailableMb(): number | null {
  try {
    const content = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(content);
    if (!match) return null;
    return Math.floor(Number(match[1]) / 1024);
  } catch {
    return null;
  }
}

export function detectRuntimeProfile(config: AppConfig): RuntimeProfile {
  const explicit = config.installDocRuntime;
  if (explicit === '0' || explicit === 'base' || explicit === 'base_chatui' || explicit === 'none') {
    return 'base_chatui';
  }
  const hasRuntimeDir = fs.existsSync(config.docRuntimeDir);
  const hasPythonVenv = hasRuntimeDir && fs.existsSync(path.join(config.docRuntimeDir, 'venv'));
  const hasChromium = hasRuntimeDir && fs.existsSync(path.join(config.docRuntimeDir, 'playwright'));
  const totalRamGb = os.totalmem() / (1024 * 1024 * 1024);

  if (explicit === 'full' && (hasRuntimeDir || totalRamGb >= 3.5)) {
    return hasRuntimeDir ? 'full_runtime' : 'base_chatui';
  }
  if (!hasRuntimeDir || totalRamGb < 2.2) {
    return 'base_chatui';
  }
  if (hasPythonVenv && hasChromium && totalRamGb >= 3.5) {
    return 'full_runtime';
  }
  if (hasPythonVenv) {
    return 'compact_doc_runtime';
  }
  return 'base_chatui';
}

interface Waiter {
  weight: number;
  resolve: () => void;
}

/**
 * Weighted concurrency & memory governor exclusively for external doc/media workers.
 * Completely independent from ACP `ExecutionScheduler` so heavy document work never blocks ACP (`PERF-01`, `PERF-02`).
 */
export class ResourceGovernor {
  public readonly maxWeightBudget: number;
  private usedWeight = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly memAvailableReader: () => number | null = readMemAvailableMb
  ) {
    if (config.docWorkerBudget !== null) {
      this.maxWeightBudget = Math.max(1, config.docWorkerBudget);
    } else {
      const totalRamGb = os.totalmem() / (1024 * 1024 * 1024);
      this.maxWeightBudget = totalRamGb >= 8 ? 4 : 2;
    }
  }

  getRuntimeProfile(): RuntimeProfile {
    return detectRuntimeProfile(this.config);
  }

  getUsedWeight(): number {
    return this.usedWeight;
  }

  private async ensureMemAvailableForHeavyWorker(kind: DocWorkerKind): Promise<void> {
    if (kind !== 'libreoffice' && kind !== 'chromium') return;
    const threshold = this.config.minMemAvailableMb;
    for (let attempt = 0; attempt < 4; attempt++) {
      const avail = this.memAvailableReader();
      if (avail === null || avail >= threshold) return;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new ArtifactError(
      'RESOURCE_BUSY',
      `利用可能メモリが不足しているため（${threshold}MB未満）、ドキュメント処理を一時待機してください。`,
      503
    );
  }

  async runWithBudget<T>(kind: DocWorkerKind, fn: () => Promise<T>): Promise<T> {
    const weight = Math.min(WORKER_WEIGHTS[kind], this.maxWeightBudget);
    await this.ensureMemAvailableForHeavyWorker(kind);

    if (this.usedWeight + weight <= this.maxWeightBudget) {
      this.usedWeight += weight;
    } else {
      await new Promise<void>((resolve) => {
        this.waiters.push({ weight, resolve });
      });
      // Weight was reserved atomically by drainWaiters() before resolving this waiter.
    }

    try {
      return await fn();
    } finally {
      this.usedWeight = Math.max(0, this.usedWeight - weight);
      this.drainWaiters();
    }
  }

  private drainWaiters(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i];
      if (this.usedWeight + w.weight <= this.maxWeightBudget) {
        this.waiters.splice(i, 1);
        this.usedWeight += w.weight;
        w.resolve();
      } else {
        i += 1;
      }
    }
  }
}
