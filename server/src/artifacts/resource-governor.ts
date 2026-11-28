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

export interface TargetInspectionBudget {
  rssLimitMb: number;
  maxOldSpaceMb: number;
  timeoutMs: number;
  availableMemoryMb: number;
}

/**
 * Computes a dynamic memory & timeout budget for isolated target inspection
 * based on host available memory and actual input workload (§4.2, PERF-01).
 *
 * Replaces any fixed target-inspection input size cap while protecting normal
 * chat, ACP, and existing viewers on low-RAM hosts.
 */
export function computeTargetInspectionBudget(params: {
  inputBytes: number;
  isDocumentOrMedia: boolean;
  minReserveMb?: number;
  memAvailableMb?: number | null;
}): TargetInspectionBudget {
  const inputMb = Math.max(0, params.inputBytes) / (1024 ** 2);
  const physicalAvailable = params.memAvailableMb !== undefined
    ? (params.memAvailableMb ?? Infinity)
    : (readMemAvailableMb() ?? Infinity);
  const processAvailable = typeof process.availableMemory === 'function'
    ? process.availableMemory() / (1024 ** 2)
    : Infinity;
  const availableMemoryMb = Math.min(physicalAvailable, processAvailable);
  const reserveMb = params.minReserveMb ?? 256;
  const usableMb = availableMemoryMb - reserveMb;
  const estimatedMinMb = Math.ceil((params.isDocumentOrMedia ? 192 : 128) + inputMb * (params.isDocumentOrMedia ? 2.5 : 2));
  if (usableMb < estimatedMinMb) {
    throw new ArtifactError('RESOURCE_BUSY', '対象の解析に必要なメモリが不足しています。', 503);
  }
  const targetRssMb = Math.ceil((params.isDocumentOrMedia ? 320 : 256) + inputMb * (params.isDocumentOrMedia ? 12 : 8));
  const hostCapMb = Number.isFinite(usableMb) ? Math.floor(usableMb * 0.75) : targetRssMb;
  const rssLimitMb = Math.max(estimatedMinMb, Math.min(targetRssMb, Math.max(estimatedMinMb, hostCapMb)));
  const maxOldSpaceMb = Math.max(256, Math.floor(rssLimitMb * 0.65));
  const timeoutMs = inputMb > 16 ? 60_000 : 30_000;
  return { rssLimitMb, maxOldSpaceMb, timeoutMs, availableMemoryMb };
}

export function detectRuntimeProfile(config: AppConfig): RuntimeProfile {
  const explicit = config.installDocRuntime;
  if (['0', 'false', 'no', 'off', 'base', 'base_chatui', 'none'].includes(explicit)) {
    return 'base_chatui';
  }
  if (!fs.existsSync(path.join(config.docRuntimeDir, 'venv/bin/python3'))) {
    return 'base_chatui';
  }
  const totalRamGib = os.totalmem() / (1024 ** 3);
  const forcedCompact = ['1', 'true', 'yes', 'on', 'compact', 'compact_doc_runtime'].includes(explicit);
  const forcedFull = explicit === 'full' || explicit === 'full_runtime';
  if (!forcedCompact && !forcedFull && totalRamGib < 2.2) return 'base_chatui';
  const hasChromium = fs.existsSync(path.join(config.docRuntimeDir, 'playwright'));
  if (!forcedCompact && hasChromium && (forcedFull || totalRamGib >= 3.5)) return 'full_runtime';
  return 'compact_doc_runtime';
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

  async runWithBudget<T>(kind: DocWorkerKind, fn: (checkMemoryBeforeSpawn: () => Promise<void>) => Promise<T>): Promise<T> {
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
      await this.ensureMemAvailableForHeavyWorker(kind);
      return await fn(() => this.ensureMemAvailableForHeavyWorker(kind));
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
