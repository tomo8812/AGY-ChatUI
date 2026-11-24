import crypto from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import type { ArtifactRecord, ArtifactScopeKind } from '../types.js';
import type { PerUserBlobManager } from './blob-store.js';
import { ArtifactError } from './errors.js';
import type { ArtifactLockManager } from './lock-manager.js';
import type {
  ActorKind,
  ArtifactRestoreBatchItemRecord,
  ArtifactRestoreBatchRecord,
} from './types.js';

export interface BatchRestoreHost {
  db: AppDatabase;
  blobManager: PerUserBlobManager;
  lockManager: ArtifactLockManager;
  restoreSingleArtifactLocked(params: {
    userId: string;
    artifactId: string;
    targetRevision: number;
    actorKind: ActorKind;
    actorId: string | null;
    batchId: string;
    suppressDependencyPropagation: boolean;
    alreadyLocked: boolean;
  }): Promise<{ artifact: ArtifactRecord }>;
  drainDepPropagationQueue(): Promise<number>;
}

interface PlannedRestoreItem {
  artifactId: string;
  relPath: string;
  targetRevision: number;
  blobSha256: string;
}

/**
 * Plans and executes `artifact_restore_bundle` (parent + referenced dependencies) with:
 * - Pre-pinning of all target past revision & dependency blobs against GC
 * - Deadlock-free lexicographical locking on `T` (`artifactId ASC`)
 * - Sequential commits with `suppressDependencyPropagation: true`
 * - On partial failure or crash recovery (`failed_partial`), un-restored (`pending`/`failed`) parent artifacts
 *   (including inside `T`) are NOT excluded from `artifact_dep_propagation_queue` so BOTH un-restored parents
 *   in `T` and external sibling parents `S` receive `dependency_sync` updates (`ARCH-07`).
 */
export async function executeRestoreBundle(
  host: BatchRestoreHost,
  params: {
    userId: string;
    parentArtifactId: string;
    targetRevision: number;
    sharedPolicy: 'overwrite_shared' | 'skip_shared';
    actorKind: ActorKind;
    actorId: string | null;
    failAfterCommittedCountForTest?: number;
  }
): Promise<ArtifactRestoreBatchRecord> {
  const parent = host.db.getArtifact(params.userId, params.parentArtifactId);
  if (!parent) {
    throw new ArtifactError('NOT_FOUND', '復元対象の成果物が見つかりません。', 404);
  }

  const parentRevRow = host.db.db
    .prepare(
      `SELECT blob_sha256, blob_available
       FROM artifact_revisions
       WHERE artifact_id = ? AND user_id = ? AND revision = ?`
    )
    .get(parent.id, params.userId, params.targetRevision) as
    | { blob_sha256: string | null; blob_available: number }
    | undefined;

  if (!parentRevRow || !parentRevRow.blob_available || !parentRevRow.blob_sha256) {
    throw new ArtifactError(
      'REVISION_SNAPSHOT_UNAVAILABLE',
      `Revision ${params.targetRevision} のスナップショットは復元できません。`,
      422
    );
  }

  const depRows = host.db.db
    .prepare(
      `SELECT rel_path, status, sha256, blob_sha256
       FROM artifact_revision_deps
       WHERE artifact_id = ? AND revision = ? AND user_id = ?
       ORDER BY rel_path ASC`
    )
    .all(parent.id, params.targetRevision, params.userId) as Array<{
    rel_path: string;
    status: string;
    sha256: string | null;
    blob_sha256: string | null;
  }>;

  const planned: PlannedRestoreItem[] = [];
  const pinReleasers: Array<() => void> = [];

  try {
    for (const dep of depRows) {
      if (dep.status !== 'present' || !dep.sha256) continue;
      const depArt =
        parent.scopeKind === 'chat' && parent.chatId
          ? host.db.findArtifactByRelPath(params.userId, parent.chatId, dep.rel_path)
          : parent.scopeKind === 'project' && parent.projectId
            ? host.db.findProjectArtifactByRelPath(params.userId, parent.projectId, dep.rel_path)
            : null;
      if (!depArt) continue;

      if (params.sharedPolicy === 'skip_shared') {
        const otherParents = host.db.db
          .prepare(
            `SELECT COUNT(DISTINCT d.artifact_id) AS cnt
             FROM artifact_revision_deps d
             JOIN artifacts a ON a.id = d.artifact_id AND a.revision = d.revision
             WHERE d.user_id = ?
               AND d.scope_kind = ?
               AND COALESCE(d.chat_id, '') = COALESCE(?, '')
               AND COALESCE(d.project_id, '') = COALESCE(?, '')
               AND d.rel_path = ?
               AND d.artifact_id != ?
               AND a.lifecycle_state = 'active'`
          )
          .get(
            params.userId,
            parent.scopeKind,
            parent.chatId ?? '',
            parent.projectId ?? '',
            dep.rel_path,
            parent.id
          ) as { cnt: number };
        if (Number(otherParents.cnt) > 0) {
          continue;
        }
      }

      // Find matching past revision of dependency artifact with the target sha256
      const depRev = host.db.db
        .prepare(
          `SELECT revision, blob_sha256
           FROM artifact_revisions
           WHERE artifact_id = ? AND user_id = ? AND sha256 = ? AND blob_available = 1 AND blob_sha256 IS NOT NULL
           ORDER BY revision DESC LIMIT 1`
        )
        .get(depArt.id, params.userId, dep.sha256) as { revision: number; blob_sha256: string } | undefined;

      if (!depRev) {
        throw new ArtifactError(
          'REVISION_SNAPSHOT_UNAVAILABLE',
          `依存ファイル ${dep.rel_path} の対象版スナップショットが利用できません。`,
          422
        );
      }
      pinReleasers.push(host.blobManager.pinBlob(params.userId, depRev.blob_sha256));
      planned.push({
        artifactId: depArt.id,
        relPath: depArt.relPath,
        targetRevision: depRev.revision,
        blobSha256: depRev.blob_sha256,
      });
    }

    // Restore dependencies first, parent last (so failure on parent tests un-restored parent propagation cleanly!)
    pinReleasers.push(host.blobManager.pinBlob(params.userId, parentRevRow.blob_sha256));
    planned.push({
      artifactId: parent.id,
      relPath: parent.relPath,
      targetRevision: params.targetRevision,
      blobSha256: parentRevRow.blob_sha256,
    });

    const batchId = crypto.randomUUID();
    const now = Date.now();
    host.db.db.exec('BEGIN IMMEDIATE;');
    try {
      host.db.db
        .prepare(
          `INSERT INTO artifact_restore_batches (
             batch_id, user_id, scope_kind, chat_id, project_id, parent_artifact_id, shared_policy, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)`
        )
        .run(
          batchId,
          params.userId,
          parent.scopeKind,
          parent.chatId,
          parent.projectId,
          parent.id,
          params.sharedPolicy,
          now,
          now
        );

      planned.forEach((item, idx) => {
        host.db.db
          .prepare(
            `INSERT INTO artifact_restore_batch_items (batch_id, seq, artifact_id, target_revision, status)
             VALUES (?, ?, ?, ?, 'pending')`
          )
          .run(batchId, idx + 1, item.artifactId, item.targetRevision);
      });
      host.db.db.exec('COMMIT;');
    } catch (err) {
      host.db.db.exec('ROLLBACK;');
      throw err;
    }

    const lockKeys = planned.map((p) => `artifact:${p.artifactId}`);
    let failed = false;
    const committedItems: Array<{ artifactId: string; relPath: string; committedRevision: number }> = [];

    await host.lockManager.withLocks(lockKeys, async () => {
      for (let i = 0; i < planned.length; i++) {
        const item = planned[i];
        const seq = i + 1;
        try {
          if (
            params.failAfterCommittedCountForTest !== undefined &&
            committedItems.length >= params.failAfterCommittedCountForTest
          ) {
            throw new ArtifactError('INJECTED_BATCH_FAILURE', 'Injected mid-batch failure for testing.', 409);
          }

          const res = await host.restoreSingleArtifactLocked({
            userId: params.userId,
            artifactId: item.artifactId,
            targetRevision: item.targetRevision,
            actorKind: params.actorKind,
            actorId: params.actorId,
            batchId,
            suppressDependencyPropagation: true,
            alreadyLocked: true,
          });
          committedItems.push({
            artifactId: item.artifactId,
            relPath: item.relPath,
            committedRevision: res.artifact.revision,
          });
          host.db.db
            .prepare(
              `UPDATE artifact_restore_batch_items
               SET status = 'committed', committed_revision = ?
               WHERE batch_id = ? AND seq = ?`
            )
            .run(res.artifact.revision, batchId, seq);
        } catch (err) {
          failed = true;
          const errorCode = err instanceof ArtifactError ? err.code : 'RESTORE_FAILED';
          host.db.db
            .prepare(
              `UPDATE artifact_restore_batch_items
               SET status = 'failed', error_code = ?
               WHERE batch_id = ? AND seq = ?`
            )
            .run(errorCode, batchId, seq);
          break;
        }
      }

      const endNow = Date.now();
      const finalState = failed ? 'failed_partial' : 'completed';
      // CRITICAL ARCH-07 invariant:
      // Exclude ONLY committed artifacts — NEVER exclude un-restored (pending/failed) parent artifacts even inside T!
      // That ensures both un-restored parent in T and external sibling parents S receive dependency_sync updates.
      const committedIds = committedItems.map((c) => c.artifactId);

      host.db.db.exec('BEGIN IMMEDIATE;');
      try {
        host.db.db
          .prepare('UPDATE artifact_restore_batches SET state = ?, updated_at = ? WHERE batch_id = ?')
          .run(finalState, endNow, batchId);

        for (const c of committedItems) {
          host.db.db
            .prepare(
              `INSERT INTO artifact_dep_propagation_queue (
                 id, user_id, scope_kind, chat_id, project_id, changed_rel_path,
                 source_artifact_id, source_revision, batch_id, exclude_artifact_ids_json, state, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              params.userId,
              parent.scopeKind,
              parent.chatId,
              parent.projectId,
              c.relPath,
              c.artifactId,
              c.committedRevision,
              batchId,
              JSON.stringify(committedIds),
              endNow,
              endNow
            );
        }
        host.db.db.exec('COMMIT;');
      } catch (err) {
        host.db.db.exec('ROLLBACK;');
        throw err;
      }
    });

    // Release locks before draining propagation queue
    await host.drainDepPropagationQueue();
    return getRestoreBatchRecord(host.db, params.userId, batchId)!;
  } finally {
    for (const release of pinReleasers) release();
  }
}

export function getRestoreBatchRecord(
  db: AppDatabase,
  userId: string,
  batchId: string
): ArtifactRestoreBatchRecord | null {
  const b = db.db
    .prepare('SELECT * FROM artifact_restore_batches WHERE batch_id = ? AND user_id = ?')
    .get(batchId, userId) as Record<string, unknown> | undefined;
  if (!b) return null;
  const items = db.db
    .prepare('SELECT * FROM artifact_restore_batch_items WHERE batch_id = ? ORDER BY seq ASC')
    .all(batchId) as Array<Record<string, unknown>>;
  return {
    batchId: String(b.batch_id),
    userId: String(b.user_id),
    scopeKind: String(b.scope_kind) as ArtifactScopeKind,
    chatId: b.chat_id ? String(b.chat_id) : null,
    projectId: b.project_id ? String(b.project_id) : null,
    parentArtifactId: String(b.parent_artifact_id),
    sharedPolicy: String(b.shared_policy) as 'overwrite_shared' | 'skip_shared',
    state: String(b.state) as 'in_progress' | 'completed' | 'failed_partial',
    items: items.map(
      (i): ArtifactRestoreBatchItemRecord => ({
        batchId: String(i.batch_id),
        seq: Number(i.seq),
        artifactId: String(i.artifact_id),
        targetRevision: Number(i.target_revision),
        status: String(i.status) as 'pending' | 'committed' | 'failed',
        committedRevision:
          i.committed_revision !== null && i.committed_revision !== undefined ? Number(i.committed_revision) : null,
        errorCode: i.error_code ? String(i.error_code) : null,
      })
    ),
    createdAt: Number(b.created_at),
    updatedAt: Number(b.updated_at),
  };
}

/**
 * Startup recovery step 3: transitions any interrupted `in_progress` restore batches to `failed_partial`
 * and enqueues dependency propagation for all already-committed items (without excluding un-restored parents).
 */
export function recoverPendingRestoreBatches(db: AppDatabase): number {
  const batches = db.db
    .prepare("SELECT * FROM artifact_restore_batches WHERE state = 'in_progress'")
    .all() as Array<Record<string, unknown>>;

  let recovered = 0;
  for (const b of batches) {
    const batchId = String(b.batch_id);
    const userId = String(b.user_id);
    const scopeKind = String(b.scope_kind) as ArtifactScopeKind;
    const chatId = b.chat_id ? String(b.chat_id) : null;
    const projectId = b.project_id ? String(b.project_id) : null;

    const committedItems = db.db
      .prepare(
        `SELECT i.artifact_id, i.committed_revision, a.rel_path
         FROM artifact_restore_batch_items i
         JOIN artifacts a ON a.id = i.artifact_id
         WHERE i.batch_id = ? AND i.status = 'committed'`
      )
      .all(batchId) as Array<{ artifact_id: string; committed_revision: number; rel_path: string }>;

    const committedIds = committedItems.map((c) => c.artifact_id);
    const now = Date.now();
    db.db.exec('BEGIN IMMEDIATE;');
    try {
      db.db
        .prepare("UPDATE artifact_restore_batches SET state = 'failed_partial', updated_at = ? WHERE batch_id = ?")
        .run(now, batchId);

      for (const c of committedItems) {
        db.db
          .prepare(
            `INSERT INTO artifact_dep_propagation_queue (
               id, user_id, scope_kind, chat_id, project_id, changed_rel_path,
               source_artifact_id, source_revision, batch_id, exclude_artifact_ids_json, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            userId,
            scopeKind,
            chatId,
            projectId,
            c.rel_path,
            c.artifact_id,
            c.committed_revision,
            batchId,
            JSON.stringify(committedIds),
            now,
            now
          );
      }
      db.db.exec('COMMIT;');
    } catch (err) {
      db.db.exec('ROLLBACK;');
      throw err;
    }
    recovered += 1;
  }
  return recovered;
}
