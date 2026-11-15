import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { decryptSmallSecret } from '../auth/password.js';
import type { SyncHub } from '../sync/hub.js';
import type { QuotaBucket, QuotaSnapshotRecord } from '../types.js';
import { buildAgyCommandSpec } from './env-isolation.js';

const execFileAsync = promisify(execFile);

/**
 * Fetches quota strictly on-demand via official `agy -p /usage --output-format json`.
 * Never uses background polling timers, never scrapes tokens, never fabricates percentages.
 * If the official command cannot provide quota info, records `status = 'unavailable'`.
 */
export class QuotaService {
  private readonly inFlight = new Map<string, Promise<QuotaSnapshotRecord>>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: SyncHub
  ) {}

  getCachedOrUnavailable(userId: string): QuotaSnapshotRecord {
    return (
      this.db.getQuotaSnapshot(userId) ?? {
        userId,
        status: 'unavailable',
        buckets: [],
        rawSummary: null,
        errorMessage: '未取得（手動更新で公式CLIから取得できます）',
        fetchedAt: 0,
      }
    );
  }

  async refreshOnDemand(userId: string): Promise<QuotaSnapshotRecord> {
    const existing = this.inFlight.get(userId);
    if (existing) return existing;

    const promise = this.doRefresh(userId).finally(() => {
      this.inFlight.delete(userId);
    });
    this.inFlight.set(userId, promise);
    return promise;
  }

  private async doRefresh(userId: string): Promise<QuotaSnapshotRecord> {
    const profile = this.db.getAgyProfile(userId);
    const now = Date.now();
    if (!profile || profile.authStatus !== 'authenticated') {
      const snap: QuotaSnapshotRecord = {
        userId,
        status: 'unavailable',
        buckets: [],
        rawSummary: null,
        errorMessage: 'Antigravity未認証のため取得できません',
        fetchedAt: now,
      };
      this.db.saveQuotaSnapshot(snap);
      return snap;
    }

    let apiKey: string | null = null;
    const enc = this.db.getAgyEncryptedApiKey(userId);
    if (enc) {
      try {
        apiKey = decryptSmallSecret(enc, this.config.sessionSecret);
      } catch {
        apiKey = null;
      }
    }

    fs.mkdirSync(profile.profileDir, { recursive: true, mode: 0o700 });
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: ['-p', '/usage', '--output-format', 'json'],
      profileDir: profile.profileDir,
      geminiApiKey: apiKey,
      enableSandboxBwrap: false,
    });

    try {
      const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
        cwd: profile.profileDir,
        env: spec.env,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });

      const parsed = this.parseUsageOutput(stdout);
      const snap: QuotaSnapshotRecord = {
        userId,
        status: parsed.buckets.length > 0 || parsed.rawSummary ? 'ok' : 'unavailable',
        buckets: parsed.buckets,
        rawSummary: parsed.rawSummary ?? (stderr?.trim() || null),
        errorMessage:
          parsed.buckets.length === 0 && !parsed.rawSummary ? '取得不可（公式CLI出力に利用枠情報が含まれません）' : null,
        fetchedAt: now,
      };
      this.db.saveQuotaSnapshot(snap);
      this.hub.emitDurable({
        userId,
        type: 'quota.updated',
        payload: { quota: snap },
      });
      return snap;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const snap: QuotaSnapshotRecord = {
        userId,
        status: 'unavailable',
        buckets: [],
        rawSummary: null,
        errorMessage: `取得不可 (${msg.slice(0, 120)})`,
        fetchedAt: now,
      };
      this.db.saveQuotaSnapshot(snap);
      this.hub.emitDurable({
        userId,
        type: 'quota.updated',
        payload: { quota: snap },
      });
      return snap;
    }
  }

  private parseUsageOutput(stdout: string): { buckets: QuotaBucket[]; rawSummary: string | null } {
    const trimmed = stdout.trim();
    if (!trimmed) return { buckets: [], rawSummary: null };

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const rawBuckets = Array.isArray(parsed.buckets)
        ? parsed.buckets
        : Array.isArray(parsed.models)
          ? parsed.models
          : null;

      if (rawBuckets) {
        const buckets: QuotaBucket[] = [];
        for (const item of rawBuckets) {
          if (!item || typeof item !== 'object') continue;
          const row = item as Record<string, unknown>;
          const model = String(row.model ?? row.name ?? row.id ?? 'unknown');
          const rem =
            typeof row.remainingPercent === 'number'
              ? row.remainingPercent
              : typeof row.remaining_percent === 'number'
                ? row.remaining_percent
                : null;
          const used =
            typeof row.usedPercent === 'number'
              ? row.usedPercent
              : rem !== null
                ? Math.max(0, 100 - rem)
                : null;
          buckets.push({
            model,
            remainingPercent: rem,
            usedPercent: used,
            remainingLabel:
              typeof row.remainingLabel === 'string'
                ? row.remainingLabel
                : rem !== null
                  ? `${rem}%`
                  : '不明',
            resetAt:
              typeof row.resetAt === 'string'
                ? row.resetAt
                : typeof row.reset_at === 'string'
                  ? row.reset_at
                  : null,
            status: rem !== null && rem <= 0 ? 'limited' : rem !== null ? 'ok' : 'unknown',
          });
        }
        return {
          buckets,
          rawSummary: typeof parsed.response === 'string' ? parsed.response : null,
        };
      }

      if (typeof parsed.response === 'string' && parsed.response.trim()) {
        return { buckets: [], rawSummary: parsed.response.trim() };
      }
      if (typeof parsed.text === 'string' && parsed.text.trim()) {
        return { buckets: [], rawSummary: parsed.text.trim() };
      }
    } catch {
      // Fall through if CLI outputs plain human summary
    }

    return { buckets: [], rawSummary: trimmed.slice(0, 500) };
  }
}
