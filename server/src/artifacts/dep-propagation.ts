import crypto from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import type { ArtifactRecord, ArtifactScopeKind } from '../types.js';
import type { SyncHub } from '../sync/hub.js';
import type { PerUserBlobManager } from './blob-store.js';
import { scanArtifactDependencies } from './dependency-manifest.js';
import type { ArtifactLockManager } from './lock-manager.js';

export interface DepPropagationHost {
  db: AppDatabase;
  hub: SyncHub;
  blobManager: PerUserBlobManager;
  lockManager: ArtifactLockManager;
  resolveScopeRootDir(userId: string, scopeKind: ArtifactScopeKind, chatId: string | null, projectId: string | null): string | null;
  readActiveArtifactBytes(artifact: ArtifactRecord): Buffer | null;
}

/**
 * Drains `artifact_dep_propagation_queue` (state = 'pending') via BFS + visitedArtifactIds,
 * acquiring 1 artifact lock at a time and emitting `dependency_sync` revisions + `artifact.updated` SyncEvents (`ARCH-07`).
 */
export async function drainDepPropagationQueue(host: DepPropagationHost): Promise<number> {
  let processed = 0;

  while (true) {
    const row = host.db.db
      .prepare(
        `SELECT * FROM artifact_dep_propagation_queue
         WHERE state = 'pending'
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;

    if (!row) break;

    const queueId = String(row.id);
    const userId = String(row.user_id);
    const scopeKind = String(row.scope_kind) as ArtifactScopeKind;
    const chatId = row.chat_id ? String(row.chat_id) : null;
    const projectId = row.project_id ? String(row.project_id) : null;
    const initialChangedPath = String(row.changed_rel_path);
    const sourceArtifactId = String(row.source_artifact_id);
    const batchId = row.batch_id ? String(row.batch_id) : null;
    const excluded = new Set<string>(JSON.parse(String(row.exclude_artifact_ids_json ?? '[]')) as string[]);

    const rootDir = host.resolveScopeRootDir(userId, scopeKind, chatId, projectId);
    const visitedArtifactIds = new Set<string>([sourceArtifactId]);

    if (rootDir) {
      const bfsQueue: string[] = [initialChangedPath];
      const visitedPaths = new Set<string>([initialChangedPath]);

      while (bfsQueue.length > 0) {
        const changedRelPath = bfsQueue.shift()!;
        const parentRows = host.db.db
          .prepare(
            `SELECT DISTINCT d.artifact_id
             FROM artifact_revision_deps d
             JOIN artifacts a ON a.id = d.artifact_id AND a.revision = d.revision
             WHERE d.user_id = ?
               AND d.scope_kind = ?
               AND COALESCE(d.chat_id, '') = COALESCE(?, '')
               AND COALESCE(d.project_id, '') = COALESCE(?, '')
               AND d.rel_path = ?
               AND a.lifecycle_state = 'active'`
          )
          .all(userId, scopeKind, chatId ?? '', projectId ?? '', changedRelPath) as Array<{ artifact_id: string }>;

        for (const pr of parentRows) {
          const parentId = String(pr.artifact_id);
          if (visitedArtifactIds.has(parentId) || excluded.has(parentId)) continue;
          visitedArtifactIds.add(parentId);

          await host.lockManager.withLock(`artifact:${parentId}`, async () => {
            const parent = host.db.getArtifact(userId, parentId);
            if (!parent) return;
            const buf = host.readActiveArtifactBytes(parent);
            if (!buf) return;

            const scan = scanArtifactDependencies({
              rootDir,
              relPath: parent.relPath,
              previewKind: parent.previewKind,
              contentBuffer: buf,
            });

            if (scan.manifestHash === parent.dependencyManifestHash) {
              return;
            }

            // Store any new dependency blobs under lease before DB commit
            const leases = [];
            try {
              const parentLease = host.blobManager.putBlobWithLease(userId, buf);
              leases.push(parentLease);
              for (const depBuf of scan.depBuffers.values()) {
                leases.push(host.blobManager.putBlobWithLease(userId, depBuf));
              }

              const nextRev = parent.revision + 1;
              const now = Date.now();
              let envelope;
              host.db.db.exec('BEGIN IMMEDIATE;');
              try {
                host.db.db
                  .prepare(
                    `UPDATE artifacts
                     SET revision = ?, dependency_manifest_hash = ?, updated_at = ?
                     WHERE id = ? AND user_id = ?`
                  )
                  .run(nextRev, scan.manifestHash, now, parent.id, userId);

                host.db.db
                  .prepare(
                    `INSERT INTO artifact_revisions (
                       id, artifact_id, user_id, chat_id, project_id, revision, parent_revision,
                       sha256, dependency_manifest_hash, size_bytes, blob_sha256, blob_available,
                       actor_kind, actor_id, operation_type, operation_summary, operation_payload_json,
                       batch_id, diff_patch, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'system', NULL, 'dependency_sync', ?, NULL, ?, NULL, ?)`
                  )
                  .run(
                    crypto.randomUUID(),
                    parent.id,
                    userId,
                    parent.chatId,
                    parent.projectId,
                    nextRev,
                    parent.revision,
                    parent.sha256,
                    scan.manifestHash,
                    parent.sizeBytes,
                    parentLease.sha256,
                    `Dependency updated: ${changedRelPath}`,
                    batchId,
                    now
                  );

                for (const dep of scan.deps) {
                  host.db.db
                    .prepare(
                      `INSERT OR REPLACE INTO artifact_revision_deps (
                         artifact_id, revision, user_id, scope_kind, chat_id, project_id,
                         rel_path, status, sha256, blob_sha256, size_bytes, mime_type
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    )
                    .run(
                      parent.id,
                      nextRev,
                      userId,
                      scopeKind,
                      chatId,
                      projectId,
                      dep.relPath,
                      dep.status,
                      dep.sha256,
                      dep.blobSha256,
                      dep.sizeBytes,
                      dep.mimeType
                    );
                }

                const updatedParent = host.db.getArtifact(userId, parent.id)!;
                envelope = host.db.insertSyncEventInTx({
                  userId,
                  eventId: crypto.randomUUID(),
                  type: 'artifact.updated',
                  chatId: updatedParent.chatId,
                  projectId: updatedParent.projectId,
                  payload: { artifact: updatedParent, reason: 'dependency_sync' },
                  createdAt: now,
                });

                host.db.db.exec('COMMIT;');
              } catch (err) {
                host.db.db.exec('ROLLBACK;');
                throw err;
              }

              host.hub.broadcastPersistedEvent(envelope);
              if (!visitedPaths.has(parent.relPath)) {
                visitedPaths.add(parent.relPath);
                bfsQueue.push(parent.relPath);
              }
            } finally {
              for (const l of leases) l.release();
            }
          });
        }
      }
    }

    host.db.db
      .prepare("UPDATE artifact_dep_propagation_queue SET state = 'done', updated_at = ? WHERE id = ?")
      .run(Date.now(), queueId);
    processed += 1;
  }

  return processed;
}
