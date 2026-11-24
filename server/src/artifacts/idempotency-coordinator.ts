import crypto from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import { ArtifactError } from './errors.js';
import type { ActorKind } from './types.js';

const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function computeRequestFingerprint(params: {
  actorKind: ActorKind;
  actorId: string | null;
  operationType: string;
  target: unknown;
  operations: unknown;
  baseRevision: number | null;
}): string {
  return crypto.createHash('sha256').update(canonicalJson(params)).digest('hex');
}

interface InFlightEntry {
  fingerprint: string;
  actorKind: ActorKind;
  actorId: string | null;
  promise: Promise<unknown>;
}

/**
 * Coordinates concurrent idempotent artifact mutations and persists completion state in `artifact_idempotency`.
 * Enforces fingerprint/actor verification, live DB auth re-verification on replay, in-flight coalescing,
 * transient error cleanup, and stale boot recovery (`ARCH-06`).
 */
export class IdempotencyFlightCoordinator {
  public readonly serverBootId: string;
  private readonly inFlight = new Map<string, InFlightEntry>();

  constructor(
    private readonly db: AppDatabase,
    serverBootId?: string
  ) {
    this.serverBootId = serverBootId ?? crypto.randomUUID();
  }

  private mapKey(userId: string, scopeKey: string, idempotencyKey: string): string {
    return `${userId}|${scopeKey}|${idempotencyKey}`;
  }

  /**
   * Startup recovery step 2 (runs AFTER recoverPendingCommits):
   * Deletes orphan `in_progress` idempotency rows from previous server boots that never reached a commit journal.
   */
  recoverStaleIdempotency(): number {
    const info = this.db.db
      .prepare(
        `DELETE FROM artifact_idempotency
         WHERE status = 'in_progress'
           AND server_boot_id != ?
           AND (commit_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM artifact_commit_journal j WHERE j.commit_id = artifact_idempotency.commit_id
           ))`
      )
      .run(this.serverBootId);
    return Number(info.changes);
  }

  async execute<T>(params: {
    userId: string;
    scopeKey: string;
    idempotencyKey?: string;
    actorKind: ActorKind;
    actorId: string | null;
    fingerprint: string;
    reverifyAuth: () => void | Promise<void>;
    run: () => Promise<{ result: T; alreadyCommittedInTx?: boolean; artifactId?: string; committedRevision?: number; noOp?: boolean }>;
  }): Promise<T> {
    if (!params.idempotencyKey) {
      await params.reverifyAuth();
      const { result } = await params.run();
      return result;
    }

    const key = this.mapKey(params.userId, params.scopeKey, params.idempotencyKey);
    const now = Date.now();
    let mode: 'run' | 'wait_inflight' | 'replay_completed' = 'run';
    let cachedResponseJson: string | null = null;

    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.db.db
        .prepare(
          `SELECT status, server_boot_id, actor_kind, actor_id, request_fingerprint, response_json
           FROM artifact_idempotency
           WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?`
        )
        .get(params.userId, params.scopeKey, params.idempotencyKey) as
        | {
            status: string;
            server_boot_id: string;
            actor_kind: string;
            actor_id: string | null;
            request_fingerprint: string;
            response_json: string | null;
          }
        | undefined;

      if (existing) {
        const sameActor =
          existing.actor_kind === params.actorKind &&
          (existing.actor_id ?? null) === (params.actorId ?? null);
        const sameFingerprint = existing.request_fingerprint === params.fingerprint;

        if (!sameActor || !sameFingerprint) {
          this.db.db.exec('ROLLBACK;');
          throw new ArtifactError(
            'IDEMPOTENCY_KEY_REUSE_MISMATCH',
            '同一の idempotencyKey が異なるリクエスト内容または主体で再利用されました。',
            409
          );
        }

        if (existing.status === 'ambiguous_quarantined') {
          this.db.db.exec('ROLLBACK;');
          throw new ArtifactError(
            'ARTIFACT_AMBIGUOUS_QUARANTINED',
            '前回の書込結果が異常終了により隔離状態です。現在のファイル状態を確認してください。',
            409
          );
        }

        if (existing.status === 'completed') {
          cachedResponseJson = existing.response_json;
          mode = 'replay_completed';
          this.db.db.exec('COMMIT;');
        } else if (existing.status === 'in_progress') {
          if (existing.server_boot_id === this.serverBootId) {
            mode = 'wait_inflight';
            this.db.db.exec('COMMIT;');
          } else {
            // Stale row from previous boot that had no journal — overwrite and execute
            this.db.db
              .prepare(
                `UPDATE artifact_idempotency
                 SET server_boot_id = ?, commit_id = NULL, updated_at = ?, expires_at = ?
                 WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?`
              )
              .run(
                this.serverBootId,
                now,
                now + DEFAULT_IDEMPOTENCY_TTL_MS,
                params.userId,
                params.scopeKey,
                params.idempotencyKey
              );
            mode = 'run';
            this.db.db.exec('COMMIT;');
          }
        }
      } else {
        this.db.db
          .prepare(
            `INSERT INTO artifact_idempotency (
               user_id, scope_key, idempotency_key, status, server_boot_id, commit_id,
               actor_kind, actor_id, request_fingerprint, artifact_id, committed_revision,
               no_op, response_json, created_at, updated_at, expires_at
             ) VALUES (?, ?, ?, 'in_progress', ?, NULL, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?, ?)`
          )
          .run(
            params.userId,
            params.scopeKey,
            params.idempotencyKey,
            this.serverBootId,
            params.actorKind,
            params.actorId,
            params.fingerprint,
            now,
            now,
            now + DEFAULT_IDEMPOTENCY_TTL_MS
          );
        mode = 'run';
        this.db.db.exec('COMMIT;');
      }
    } catch (err) {
      if (this.db.db.isTransaction) {
        this.db.db.exec('ROLLBACK;');
      }
      throw err;
    }

    if (mode === 'replay_completed') {
      // Live DB authorization re-verification before returning cached completed result
      await params.reverifyAuth();
      return JSON.parse(cachedResponseJson ?? '{}') as T;
    }

    if (mode === 'wait_inflight') {
      const flight = this.inFlight.get(key);
      if (flight) {
        if (
          flight.fingerprint !== params.fingerprint ||
          flight.actorKind !== params.actorKind ||
          (flight.actorId ?? null) !== (params.actorId ?? null)
        ) {
          throw new ArtifactError(
            'IDEMPOTENCY_KEY_REUSE_MISMATCH',
            '同一の idempotencyKey が異なるリクエスト内容または主体で再利用されました。',
            409
          );
        }
        const awaited = (await flight.promise) as T;
        await params.reverifyAuth();
        return awaited;
      }
      // Fallback: if in-memory flight already finished between tx and map check, check DB again
      const latest = this.db.db
        .prepare(
          `SELECT status, response_json FROM artifact_idempotency
           WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?`
        )
        .get(params.userId, params.scopeKey, params.idempotencyKey) as
        | { status: string; response_json: string | null }
        | undefined;
      if (latest?.status === 'completed') {
        await params.reverifyAuth();
        return JSON.parse(latest.response_json ?? '{}') as T;
      }
      throw new ArtifactError('IDEMPOTENCY_IN_PROGRESS', '同一リクエストが処理中です。再試行してください。', 409);
    }

    // mode === 'run'
    let resolveFlight!: (v: T) => void;
    let rejectFlight!: (err: unknown) => void;
    const flightPromise = new Promise<T>((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });
    // Prevent unhandled rejection warning if no waiter attaches
    flightPromise.catch(() => {});

    this.inFlight.set(key, {
      fingerprint: params.fingerprint,
      actorKind: params.actorKind,
      actorId: params.actorId,
      promise: flightPromise,
    });

    try {
      await params.reverifyAuth();
      const outcome = await params.run();
      if (!outcome.alreadyCommittedInTx) {
        this.db.db
          .prepare(
            `UPDATE artifact_idempotency
             SET status = 'completed',
                 artifact_id = COALESCE(?, artifact_id),
                 committed_revision = COALESCE(?, committed_revision),
                 no_op = ?,
                 response_json = ?,
                 updated_at = ?
             WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?`
          )
          .run(
            outcome.artifactId ?? null,
            outcome.committedRevision ?? null,
            outcome.noOp ? 1 : 0,
            JSON.stringify(outcome.result),
            Date.now(),
            params.userId,
            params.scopeKey,
            params.idempotencyKey
          );
      }
      resolveFlight(outcome.result);
      return outcome.result;
    } catch (err) {
      // Only remove the in_progress row if it has NOT been promoted to completed or ambiguous_quarantined
      // and is not linked to an active commit journal that requires crash recovery.
      try {
        this.db.db
          .prepare(
            `DELETE FROM artifact_idempotency
             WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?
               AND status = 'in_progress'
               AND (commit_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM artifact_commit_journal j
                 WHERE j.commit_id = artifact_idempotency.commit_id
                   AND j.state NOT IN ('aborted')
               ))`
          )
          .run(params.userId, params.scopeKey, params.idempotencyKey);
      } catch {
        // ignore cleanup error
      }
      rejectFlight(err);
      throw err;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
