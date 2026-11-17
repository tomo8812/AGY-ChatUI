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

const DEFAULT_AUTO_MIN_AGE_MS = 5 * 60 * 1000;
const ERROR_AUTO_MIN_AGE_MS = 2 * 60 * 1000;

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '');
}

function shortenWindowLabel(group: string, windowLabel: string): string {
  const lower = windowLabel.toLowerCase();
  if (/five\s*hour|5\s*h|5時間/.test(lower)) return '5h';
  if (/weekly|週間/.test(lower)) return 'Weekly';
  let cleaned = windowLabel.trim();
  if (cleaned.toLowerCase().startsWith(group.toLowerCase())) {
    cleaned = cleaned.slice(group.length).trim();
  }
  return cleaned.replace(/\s*limit\s*remaining$/i, '').replace(/\s*remaining$/i, '').trim() || windowLabel;
}

export function parseDelimitedUsageLines(rawText: string): QuotaBucket[] {
  const cleaned = stripAnsi(rawText).trim();
  if (!cleaned) return [];

  const buckets: QuotaBucket[] = [];
  const lines = cleaned.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('```') || /^[-+|=\s]+$/.test(line)) continue;

    let cols: string[] = [];
    if (line.includes('\t')) {
      cols = line
        .split('\t')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    } else if (line.startsWith('|') && line.endsWith('|')) {
      cols = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    } else if (/\s{2,}/.test(line)) {
      cols = line
        .split(/\s{2,}/)
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    } else {
      const m = /^(.+?)\s+(\d+(?:\.\d+)?)%(?:\s+(\d{4}-\d{2}-\d{2}T[^\s]+))?$/.exec(line);
      if (m) {
        cols = m[3] ? [m[1], m[1], `${m[2]}%`, m[3]] : [m[1], m[1], `${m[2]}%`];
      }
    }

    if (cols.length < 2) continue;

    const pctIdx = cols.findIndex((c) => /^\d+(?:\.\d+)?\s*%$/.test(c));
    if (pctIdx < 1) continue;

    const pctMatch = /(\d+(?:\.\d+)?)\s*%/.exec(cols[pctIdx]);
    if (!pctMatch) continue;

    const rawPct = Number.parseFloat(pctMatch[1]);
    if (!Number.isFinite(rawPct)) continue;
    const rem = Math.max(0, Math.min(100, Math.round(rawPct * 10) / 10));

    let group: string;
    let windowLabel: string;
    if (pctIdx >= 2) {
      group = cols[0];
      windowLabel = cols.slice(1, pctIdx).join(' ');
    } else {
      group = cols[0];
      windowLabel = cols[0];
    }

    const afterCols = cols.slice(pctIdx + 1);
    const isoCandidate = afterCols.find((c) => /\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(c)) ?? null;
    const resetAt = isoCandidate && !Number.isNaN(Date.parse(isoCandidate)) ? isoCandidate : null;

    const shortWin = shortenWindowLabel(group, windowLabel);
    buckets.push({
      model: shortWin === group ? group : `${group} · ${shortWin}`,
      group,
      windowLabel,
      remainingPercent: rem,
      usedPercent: Math.max(0, Math.round((100 - rem) * 10) / 10),
      remainingLabel: `${rem}%`,
      resetAt,
      status: rem <= 0 ? 'limited' : 'ok',
    });
  }

  return buckets;
}

export function parseUsageOutput(stdout: string): { buckets: QuotaBucket[]; rawSummary: string | null } {
  const trimmed = stripAnsi(stdout).trim();
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
        const group = typeof row.group === 'string' && row.group.trim() ? row.group.trim() : undefined;
        const windowLabel =
          typeof row.windowLabel === 'string' && row.windowLabel.trim()
            ? row.windowLabel.trim()
            : typeof row.window === 'string' && row.window.trim()
              ? row.window.trim()
              : undefined;
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
          ...(group ? { group } : {}),
          ...(windowLabel ? { windowLabel } : {}),
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
      if (buckets.length > 0) {
        return {
          buckets,
          rawSummary: typeof parsed.response === 'string' ? parsed.response : null,
        };
      }
    }

    for (const key of ['response', 'text', 'content', 'output', 'message'] as const) {
      const val = parsed[key];
      if (typeof val === 'string' && val.trim()) {
        const text = val.trim();
        const textBuckets = parseDelimitedUsageLines(text);
        return {
          buckets: textBuckets,
          rawSummary: text,
        };
      }
    }
  } catch {
    // Fall through if CLI outputs plain TSV or human summary directly
  }

  const plainBuckets = parseDelimitedUsageLines(trimmed);
  return { buckets: plainBuckets, rawSummary: trimmed.slice(0, 1200) };
}

/**
 * Fetches quota via official `agy -p /usage` on manual request or infrequent TTL-gated triggers.
 * Never uses rapid polling, never scrapes tokens, never fabricates percentages.
 * If the official command cannot provide quota info, records `status = 'unavailable'`.
 */
export class QuotaService {
  private readonly inFlight = new Map<string, Promise<QuotaSnapshotRecord>>();
  private shuttingDown = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: SyncHub
  ) {}

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled([...this.inFlight.values()]);
  }

  getCachedOrUnavailable(userId: string): QuotaSnapshotRecord {
    return (
      this.db.getQuotaSnapshot(userId) ?? {
        userId,
        status: 'unavailable',
        buckets: [],
        rawSummary: null,
        errorMessage: '未取得（更新で公式CLIから取得できます）',
        fetchedAt: 0,
      }
    );
  }

  async refreshOnDemand(
    userId: string,
    opts: { auto?: boolean; minAgeMs?: number } = {}
  ): Promise<QuotaSnapshotRecord> {
    if (this.shuttingDown) {
      return this.getCachedOrUnavailable(userId);
    }

    if (opts.auto) {
      let cached: QuotaSnapshotRecord | null = null;
      try {
        cached = this.db.getQuotaSnapshot(userId);
      } catch {
        return this.getCachedOrUnavailable(userId);
      }
      if (cached && cached.fetchedAt > 0) {
        const clampedCustomMin =
          typeof opts.minAgeMs === 'number' && Number.isFinite(opts.minAgeMs)
            ? Math.max(5_000, Math.min(15 * 60 * 1000, Math.round(opts.minAgeMs)))
            : null;
        const minAge =
          cached.status === 'ok'
            ? (clampedCustomMin ?? DEFAULT_AUTO_MIN_AGE_MS)
            : clampedCustomMin !== null
              ? Math.max(30_000, clampedCustomMin)
              : Math.min(DEFAULT_AUTO_MIN_AGE_MS, ERROR_AUTO_MIN_AGE_MS);
        if (Date.now() - cached.fetchedAt < minAge) {
          return cached;
        }
      }
    }

    const existing = this.inFlight.get(userId);
    if (existing) return existing;

    const promise = this.doRefresh(userId).finally(() => {
      this.inFlight.delete(userId);
    });
    this.inFlight.set(userId, promise);
    return promise;
  }

  private async runUsageCommand(
    profileDir: string,
    apiKey: string | null,
    subcommandArgs: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs,
      profileDir,
      geminiApiKey: apiKey,
      enableSandboxBwrap: false,
    });
    return execFileAsync(spec.command, spec.args, {
      cwd: profileDir,
      env: spec.env,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
  }

  private async doRefresh(userId: string): Promise<QuotaSnapshotRecord> {
    if (this.shuttingDown) {
      return {
        userId,
        status: 'unavailable',
        buckets: [],
        rawSummary: null,
        errorMessage: 'シャットダウン中',
        fetchedAt: 0,
      };
    }

    const persistSnapshot = (snap: QuotaSnapshotRecord, emitHub: boolean) => {
      if (this.shuttingDown) return;
      try {
        this.db.saveQuotaSnapshot(snap);
        if (emitHub) {
          this.hub.emitDurable({
            userId,
            type: 'quota.updated',
            payload: { quota: snap },
          });
        }
      } catch {
        // Ignore DB-closed race on rapid shutdown
      }
    };

    let profile;
    try {
      profile = this.db.getAgyProfile(userId);
    } catch {
      return {
        userId,
        status: 'unavailable',
        buckets: [],
        rawSummary: null,
        errorMessage: 'DB未利用',
        fetchedAt: 0,
      };
    }

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
      persistSnapshot(snap, false);
      return snap;
    }

    let apiKey: string | null = null;
    try {
      const enc = this.db.getAgyEncryptedApiKey(userId);
      if (enc) {
        try {
          apiKey = decryptSmallSecret(enc, this.config.sessionSecret);
        } catch {
          apiKey = null;
        }
      }
    } catch {
      apiKey = null;
    }

    fs.mkdirSync(profile.profileDir, { recursive: true, mode: 0o700 });

    try {
      let result: { stdout: string; stderr: string };
      try {
        result = await this.runUsageCommand(profile.profileDir, apiKey, [
          '-p',
          '/usage',
          '--output-format',
          'json',
        ]);
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (/unknown option|--output-format|invalid option/i.test(msg)) {
          result = await this.runUsageCommand(profile.profileDir, apiKey, ['-p', '/usage']);
        } else {
          throw firstErr;
        }
      }

      const combinedText = result.stdout.trim() ? result.stdout : result.stderr;
      const parsed = parseUsageOutput(combinedText);
      const snap: QuotaSnapshotRecord = {
        userId,
        status: parsed.buckets.length > 0 || parsed.rawSummary ? 'ok' : 'unavailable',
        buckets: parsed.buckets,
        rawSummary: parsed.rawSummary ?? (result.stderr?.trim() || null),
        errorMessage:
          parsed.buckets.length === 0 && !parsed.rawSummary
            ? '取得不可（公式CLI出力に利用枠情報が含まれません）'
            : null,
        fetchedAt: now,
      };
      persistSnapshot(snap, true);
      return snap;
    } catch (err) {
      const errObj = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
      const stderrText = typeof errObj?.stderr === 'string' ? stripAnsi(errObj.stderr).trim() : '';
      const rawMsg = err instanceof Error ? err.message : String(err);
      const cleanMsg = (stderrText || rawMsg.replace(/^Command failed:[^\n]*\n?/, '').trim() || rawMsg)
        .replace(/\s+/g, ' ')
        .trim();
      const snap: QuotaSnapshotRecord = {
        userId,
        status: 'unavailable',
        buckets: [],
        rawSummary: null,
        errorMessage: `取得不可 (${cleanMsg.slice(0, 240)})`,
        fetchedAt: now,
      };
      persistSnapshot(snap, true);
      return snap;
    }
  }
}
