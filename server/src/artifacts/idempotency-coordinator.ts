import crypto from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import { ArtifactError } from './errors.js';
import type { ActorKind } from './types.js';

// T1 links the request and journal atomically. A linked request can only be
// released by recovery after a verified rollback and its cleanup.
const UNJOURNALED = `commit_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM artifact_commit_journal j
  WHERE j.user_id = artifact_idempotency.user_id
    AND j.idempotency_scope_key = artifact_idempotency.scope_key
    AND j.idempotency_key = artifact_idempotency.idempotency_key
    AND (j.state NOT IN ('aborted') OR j.audit_note LIKE '{"recoveryCleanup":%')
)`;

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
    return JSON.stringify([userId, scopeKey, idempotencyKey]);
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
           AND ${UNJOURNALED}`
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
    const replay = async (result: T): Promise<T> => {
      await params.reverifyAuth();
      const saved = (result as { artifact?: { id: string; scopeKind: string; chatId: string | null; projectId: string | null } })?.artifact;
      if (saved) {
        const live = this.db.getArtifact(params.userId, saved.id);
        if (!live || live.lifecycleState !== 'active' || live.deletedOnDisk ||
            live.scopeKind !== saved.scopeKind || live.chatId !== saved.chatId || live.projectId !== saved.projectId ||
            (live.chatId && !this.db.getChat(params.userId, live.chatId)) ||
            (live.projectId && !this.db.getProject(params.userId, live.projectId))) {
          throw new ArtifactError('NOT_FOUND', '対象の成果物が見つからないか権限がありません。', 404);
        }
      }
      return result;
    };

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
            const claimed = this.db.db
              .prepare(
                `UPDATE artifact_idempotency
                 SET server_boot_id = ?, updated_at = ?, expires_at = ?
                 WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?
                   AND ${UNJOURNALED}`
              )
              .run(
                this.serverBootId,
                now,
                now + DEFAULT_IDEMPOTENCY_TTL_MS,
                params.userId,
                params.scopeKey,
                params.idempotencyKey
              );
            if (Number(claimed.changes) !== 1) {
              throw new ArtifactError('IDEMPOTENCY_IN_PROGRESS', '前回の保存処理の復旧が完了していません。', 409);
            }
            mode = 'run';
            this.db.db.exec('COMMIT;');
          }
        }
      } else {
        // Recovery may already have rolled back the DB row while its durable
        // journal still records pending cleanup.
        const pending = this.db.db.prepare(`
          SELECT state FROM artifact_commit_journal
          WHERE user_id = ? AND idempotency_scope_key = ? AND idempotency_key = ?
            AND (state != 'aborted' OR audit_note LIKE '{"recoveryCleanup":%')
        `).get(params.userId, params.scopeKey, params.idempotencyKey);
        if (pending?.state === 'ambiguous_quarantined') {
          throw new ArtifactError('ARTIFACT_AMBIGUOUS_QUARANTINED', '前回の保存結果は隔離されています。', 409);
        }
        if (pending) throw new ArtifactError('IDEMPOTENCY_IN_PROGRESS', '前回の保存処理の復旧が完了していません。', 409);
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
      return replay(JSON.parse(cachedResponseJson ?? '{}') as T);
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
        return replay(awaited);
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
        return replay(JSON.parse(latest.response_json ?? '{}') as T);
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
               AND ${UNJOURNALED}`
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
