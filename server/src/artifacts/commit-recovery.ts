import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppDatabase } from '../db/database.js';
import {
  fsyncDir,
  openContainedRegularFileNoFollow,
  sha256Fd,
} from '../files/workspace.js';
import type { SyncHub } from '../sync/hub.js';
import type { ArtifactRecord, ArtifactScopeKind } from '../types.js';
import type { PerUserBlobManager } from './blob-store.js';
import type {
  ActorKind,
  ArtifactCommitJournalRow,
  ArtifactDependencyEntry,
  CommitJournalState,
  StagingIsolationKind,
} from './types.js';

export interface CommitRecoveryHost {
  db: AppDatabase;
  hub: SyncHub;
  blobManager: PerUserBlobManager;
  getStagingIsolation(): StagingIsolationKind;
  resolveScopeRootDir(userId: string, scopeKind: ArtifactScopeKind, chatId: string | null, projectId: string | null): string | null;
  finalizeStageT6InTx(journal: ArtifactCommitJournalRow, opts?: { suppressDependencyPropagation?: boolean }): {
    artifact: ArtifactRecord;
    envelopes: ReturnType<AppDatabase['insertSyncEventInTx']>[];
  };
  recordExternalSyncOnRecovery(params: {
    userId: string;
    artifactId: string;
    rootDir: string;
    relPath: string;
  }): void;
}

export interface RecoveryReport {
  rolledForward: number;
  aborted: number;
  quarantined: number;
  completedOutbox: number;
}

function mapJournalRow(r: Record<string, unknown>): ArtifactCommitJournalRow {
  return {
    commitId: String(r.commit_id),
    artifactId: String(r.artifact_id),
    userId: String(r.user_id),
    chatId: r.chat_id ? String(r.chat_id) : null,
    projectId: r.project_id ? String(r.project_id) : null,
    scopeKind: String(r.scope_kind) as ArtifactScopeKind,
    relPath: String(r.rel_path),
    isCreate: Boolean(r.is_create),
    targetRevision: Number(r.target_revision),
    parentRevision: r.parent_revision !== null && r.parent_revision !== undefined ? Number(r.parent_revision) : null,
    expectedPrevSha256: r.expected_prev_sha256 ? String(r.expected_prev_sha256) : null,
    expectedPrevIno: r.expected_prev_ino ? String(r.expected_prev_ino) : null,
    newSha256: String(r.new_sha256),
    newDependencyManifestHash: r.new_dependency_manifest_hash ? String(r.new_dependency_manifest_hash) : null,
    newDeps: r.new_deps_json ? (JSON.parse(String(r.new_deps_json)) as ArtifactDependencyEntry[]) : [],
    newSizeBytes: Number(r.new_size_bytes),
    prevBlobSha256: r.prev_blob_sha256 ? String(r.prev_blob_sha256) : null,
    newBlobSha256: String(r.new_blob_sha256),
    privateStagePath: String(r.private_stage_path),
    stageIno: r.stage_ino ? String(r.stage_ino) : null,
    actorKind: String(r.actor_kind) as ActorKind,
    actorId: r.actor_id ? String(r.actor_id) : null,
    operationType: String(r.operation_type),
    operationSummary: String(r.operation_summary ?? ''),
    operationPayloadJson: r.operation_payload_json ? String(r.operation_payload_json) : null,
    batchId: r.batch_id ? String(r.batch_id) : null,
    idempotencyScopeKey: r.idempotency_scope_key ? String(r.idempotency_scope_key) : null,
    idempotencyKey: r.idempotency_key ? String(r.idempotency_key) : null,
    requestFingerprint: r.request_fingerprint ? String(r.request_fingerprint) : null,
    diffPatch: r.diff_patch ? String(r.diff_patch) : null,
    state: String(r.state) as CommitJournalState,
    auditNote: r.audit_note ? String(r.audit_note) : null,
    syncEventSeq: r.sync_event_seq !== null && r.sync_event_seq !== undefined ? Number(r.sync_event_seq) : null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function inspectTargetFile(rootDir: string | null, relPath: string): {
  exists: boolean;
  ino: string | null;
  sha256: string | null;
  unreadableOrTampered: boolean;
} {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return { exists: false, ino: null, sha256: null, unreadableOrTampered: false };
  }
  try {
    const opened = openContainedRegularFileNoFollow(rootDir, relPath, { allowHardlinks: true });
    try {
      const { sha256 } = sha256Fd(opened.fd);
      return {
        exists: true,
        ino: opened.stat.ino.toString(),
        sha256,
        unreadableOrTampered: false,
      };
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { exists: false, ino: null, sha256: null, unreadableOrTampered: false };
    }
    return { exists: true, ino: null, sha256: null, unreadableOrTampered: true };
  }
}

function inspectStageFile(stagePath: string): { exists: boolean; ino: string | null; sha256: string | null } {
  try {
    const fd = fs.openSync(stagePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      if (!st.isFile()) return { exists: false, ino: null, sha256: null };
      const { sha256 } = sha256Fd(fd);
      return { exists: true, ino: st.ino.toString(), sha256 };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { exists: false, ino: null, sha256: null };
  }
}

function removeStageAndSync(stagePath: string): void {
  try {
    if (fs.existsSync(stagePath)) {
      fs.unlinkSync(stagePath);
      fsyncDir(path.dirname(stagePath));
    }
  } catch {
    // ignore
  }
}

/**
 * Complete, idempotent crash recovery matrix implementing every row of Section 3.2 (`ARCH-05`).
 */
export function recoverPendingCommits(host: CommitRecoveryHost): RecoveryReport {
  const report: RecoveryReport = {
    rolledForward: 0,
    aborted: 0,
    quarantined: 0,
    completedOutbox: 0,
  };

  const rows = host.db.db
    .prepare(
      `SELECT * FROM artifact_commit_journal
       WHERE state IN ('prepared', 'replacing', 'file_replaced', 'db_committed')
       ORDER BY created_at ASC`
    )
    .all() as Array<Record<string, unknown>>;

  const stagingIsolation = host.getStagingIsolation();
  const isMountIsolated = stagingIsolation === 'bwrap_mount_isolated';

  const markAborted = (j: ArtifactCommitJournalRow, note: string) => {
    removeStageAndSync(j.privateStagePath);
    const now = Date.now();
    host.db.db.exec('BEGIN IMMEDIATE;');
    try {
      if (j.isCreate) {
        host.db.db
          .prepare("DELETE FROM artifacts WHERE id = ? AND lifecycle_state = 'pending_create'")
          .run(j.artifactId);
      }
      if (j.idempotencyScopeKey && j.idempotencyKey) {
        host.db.db
          .prepare(
            'DELETE FROM artifact_idempotency WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?'
          )
          .run(j.userId, j.idempotencyScopeKey, j.idempotencyKey);
      }
      host.db.db
        .prepare("UPDATE artifact_commit_journal SET state = 'aborted', audit_note = ?, updated_at = ? WHERE commit_id = ?")
        .run(note, now, j.commitId);
      host.db.db.exec('COMMIT;');
    } catch (err) {
      host.db.db.exec('ROLLBACK;');
      throw err;
    }
    report.aborted += 1;
  };

  const markQuarantined = (j: ArtifactCommitJournalRow, note: string, syncExternalAfter = false, rootDir: string | null = null) => {
    removeStageAndSync(j.privateStagePath);
    const now = Date.now();
    host.db.db.exec('BEGIN IMMEDIATE;');
    try {
      if (j.isCreate) {
        host.db.db
          .prepare("DELETE FROM artifacts WHERE id = ? AND lifecycle_state = 'pending_create'")
          .run(j.artifactId);
      }
      if (j.idempotencyScopeKey && j.idempotencyKey) {
        host.db.db
          .prepare(
            `UPDATE artifact_idempotency
             SET status = 'ambiguous_quarantined', updated_at = ?
             WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?`
          )
          .run(now, j.userId, j.idempotencyScopeKey, j.idempotencyKey);
      }
      host.db.db
        .prepare(
          "UPDATE artifact_commit_journal SET state = 'ambiguous_quarantined', audit_note = ?, updated_at = ? WHERE commit_id = ?"
        )
        .run(note, now, j.commitId);
      host.db.db.exec('COMMIT;');
    } catch (err) {
      host.db.db.exec('ROLLBACK;');
      throw err;
    }
    if (syncExternalAfter && !j.isCreate && rootDir) {
      host.recordExternalSyncOnRecovery({
        userId: j.userId,
        artifactId: j.artifactId,
        rootDir,
        relPath: j.relPath,
      });
    }
    report.quarantined += 1;
  };

  const rollForwardToT6 = (j: ArtifactCommitJournalRow, syncExternalAfter = false, rootDir: string | null = null) => {
    removeStageAndSync(j.privateStagePath);
    let envelopes: ReturnType<AppDatabase['insertSyncEventInTx']>[] = [];
    host.db.db.exec('BEGIN IMMEDIATE;');
    try {
      const finalized = host.finalizeStageT6InTx(j, { suppressDependencyPropagation: Boolean(j.batchId) });
      envelopes = finalized.envelopes;
      host.db.db.exec('COMMIT;');
    } catch (err) {
      host.db.db.exec('ROLLBACK;');
      throw err;
    }
    for (const env of envelopes) {
      host.hub.broadcastPersistedEvent(env);
    }
    host.db.db.prepare('DELETE FROM artifact_commit_journal WHERE commit_id = ?').run(j.commitId);
    if (syncExternalAfter && rootDir) {
      host.recordExternalSyncOnRecovery({
        userId: j.userId,
        artifactId: j.artifactId,
        rootDir,
        relPath: j.relPath,
      });
    }
    report.rolledForward += 1;
  };

  for (const raw of rows) {
    const j = mapJournalRow(raw);
    const rootDir = host.resolveScopeRootDir(j.userId, j.scopeKind, j.chatId, j.projectId);
    const stage = inspectStageFile(j.privateStagePath);
    const target = inspectTargetFile(rootDir, j.relPath);

    // 1. db_committed: verify outbox sync_event exists, broadcast if needed, delete completed journal
    if (j.state === 'db_committed') {
      if (j.syncEventSeq !== null) {
        const evRow = host.db.db
          .prepare('SELECT * FROM sync_events WHERE seq = ? AND user_id = ?')
          .get(j.syncEventSeq, j.userId) as Record<string, unknown> | undefined;
        if (evRow) {
          host.hub.broadcastPersistedEvent({
            seq: Number(evRow.seq),
            userSeq: Number(evRow.user_seq ?? 0),
            eventId: String(evRow.event_id),
            userId: String(evRow.user_id),
            type: String(evRow.event_type),
            chatId: evRow.chat_id ? String(evRow.chat_id) : null,
            projectId: evRow.project_id ? String(evRow.project_id) : null,
            runId: evRow.run_id ? String(evRow.run_id) : null,
            payload: JSON.parse(String(evRow.payload_json)),
            createdAt: Number(evRow.created_at),
          });
        }
      }
      host.db.db.prepare('DELETE FROM artifact_commit_journal WHERE commit_id = ?').run(j.commitId);
      report.completedOutbox += 1;
      continue;
    }

    // 2. file_replaced: placement succeeded -> roll forward to Stage T6 (+ external_sync if subsequently changed)
    if (j.state === 'file_replaced') {
      const changedAfter =
        !target.exists ||
        target.unreadableOrTampered ||
        target.sha256 !== j.newSha256;
      rollForwardToT6(j, changedAfter, rootDir);
      continue;
    }

    // 3. prepared: link/rename has not been entered yet
    if (j.state === 'prepared') {
      const targetUnchanged = j.isCreate
        ? !target.exists
        : target.exists && !target.unreadableOrTampered && target.sha256 === j.expectedPrevSha256;
      const stageIntact =
        j.stageIno === null ||
        (stage.exists && stage.ino === j.stageIno && stage.sha256 === j.newSha256);

      if (targetUnchanged && stageIntact) {
        markAborted(j, 'prepared_aborted_before_replace');
      } else {
        markQuarantined(
          j,
          !stageIntact ? 'prepared_stage_tampered_or_missing' : 'prepared_target_changed',
          !j.isCreate && !targetUnchanged,
          rootDir
        );
      }
      continue;
    }

    // 4. replacing (is_create = 1)
    if (j.state === 'replacing' && j.isCreate) {
      if (
        !target.unreadableOrTampered &&
        target.exists &&
        j.stageIno !== null &&
        target.ino === j.stageIno &&
        target.sha256 === j.newSha256
      ) {
        rollForwardToT6(j, false, rootDir);
      } else {
        // ALL other cases for replacing(is_create=1) MUST be quarantined (cannot distinguish post-link external delete)
        markQuarantined(j, 'replacing_create_ambiguous_state', false, rootDir);
      }
      continue;
    }

    // 5. replacing (is_create = 0)
    if (j.state === 'replacing' && !j.isCreate) {
      if (stage.exists) {
        const targetMatchesPrev =
          target.exists && !target.unreadableOrTampered && target.sha256 === j.expectedPrevSha256;
        if (targetMatchesPrev) {
          if (isMountIsolated) {
            markAborted(j, 'replacing_update_not_performed_isolated');
          } else {
            markQuarantined(j, 'replacing_update_stage_present_non_isolated', false, rootDir);
          }
        } else {
          if (isMountIsolated) {
            markAborted(j, 'replacing_update_not_performed_external_change_isolated');
            if (rootDir) {
              host.recordExternalSyncOnRecovery({
                userId: j.userId,
                artifactId: j.artifactId,
                rootDir,
                relPath: j.relPath,
              });
            }
          } else {
            markQuarantined(j, 'replacing_update_external_change_non_isolated', true, rootDir);
          }
        }
      } else {
        // Stage absent
        const targetMatchesNew =
          !target.unreadableOrTampered &&
          target.exists &&
          j.stageIno !== null &&
          target.ino === j.stageIno &&
          target.sha256 === j.newSha256;
        if (targetMatchesNew) {
          rollForwardToT6(j, false, rootDir);
        } else if (isMountIsolated) {
          // Rename completed before subsequent external modification/deletion
          rollForwardToT6(j, true, rootDir);
        } else {
          markQuarantined(j, 'replacing_update_stage_absent_mismatch_non_isolated', true, rootDir);
        }
      }
    }
  }

  return report;
}
