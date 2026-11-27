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

export type DeleteTargetStatus =
  | 'deleted'
  | 'intact'
  | 'partially_deleted'
  | 'externally_recreated'
  | 'indeterminate';

export interface DeleteTargetInspection {
  status: DeleteTargetStatus;
  detail: string;
  /** True when the journal proves the target was already absent before T1 began. */
  absentAtT1?: boolean;
}

export interface CommitRecoveryHost {
  db: AppDatabase;
  hub: SyncHub;
  blobManager: PerUserBlobManager;
  resolveScopeRootDir(userId: string, scopeKind: ArtifactScopeKind, chatId: string | null, projectId: string | null): string | null;
  finalizeStageT6InTx(journal: ArtifactCommitJournalRow, opts?: { suppressDependencyPropagation?: boolean }): {
    artifact: ArtifactRecord;
    envelopes: ReturnType<AppDatabase['insertSyncEventInTx']>[];
  };
  inspectDeleteTarget?(journal: ArtifactCommitJournalRow): DeleteTargetInspection;
  performVerifiedPartialDeleteCleanup?(journal: ArtifactCommitJournalRow): { ok: true } | { ok: false; reason: string };
  finalizeDeleteStageT6InTx?(journal: ArtifactCommitJournalRow): {
    envelopes: ReturnType<AppDatabase['insertSyncEventInTx']>[];
  };
  recordExternalSyncOnRecovery(params: {
    userId: string;
    artifactId: string;
    rootDir: string;
    relPath: string;
    strict?: boolean;
  }): boolean;
}

export interface RecoveryReport {
  rolledForward: number;
  aborted: number;
  quarantined: number;
  completedOutbox: number;
}

function parseStagingIsolationMode(raw: unknown): StagingIsolationKind | null {
  if (raw === 'bwrap_mount_isolated' || raw === 'non_isolated_same_uid') {
    return raw;
  }
  return null;
}

function mapJournalRow(r: Record<string, unknown>): ArtifactCommitJournalRow {
  return {
    commitId: String(r.commit_id),
    finalization: r.finalization_json ? JSON.parse(String(r.finalization_json)) : undefined,
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
    batchSeq: r.batch_seq !== null && r.batch_seq !== undefined ? Number(r.batch_seq) : null,
    stagingIsolationMode: parseStagingIsolationMode(r.staging_isolation_mode),
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
  if (!rootDir) {
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

function inspectStageFile(stagePath: string): { state: 'present' | 'missing' | 'unreadable'; ino?: string; sha256?: string } {
  try {
    const fd = fs.openSync(stagePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile()) return { state: 'unreadable' };
      return { state: 'present', ino: stat.ino.toString(), sha256: sha256Fd(fd).sha256 };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

export function removeStageAndSync(stagePath: string): void {
  if (!stagePath) return;
  try {
    fs.unlinkSync(stagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const directory = path.dirname(stagePath);
  // A previous recovery may have unlinked the stage before fsync.
  if (fs.existsSync(directory)) fsyncDir(directory);
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
          OR (state IN ('aborted', 'ambiguous_quarantined') AND audit_note LIKE '{"recoveryCleanup":%')
       ORDER BY created_at ASC`
    )
    .all() as Array<Record<string, unknown>>;

  const syncExternal = (j: ArtifactCommitJournalRow, rootDir: string | null) => {
    if (!rootDir) throw new Error('Cannot resolve scope for commit recovery');
    host.recordExternalSyncOnRecovery({
      userId: j.userId, artifactId: j.artifactId, rootDir, relPath: j.relPath, strict: true,
    });
  };

  const finishTerminal = (j: ArtifactCommitJournalRow, note: string, needsExternalSync: boolean) => {
    if (needsExternalSync) {
      syncExternal(j, host.resolveScopeRootDir(j.userId, j.scopeKind, j.chatId, j.projectId));
    }
    removeStageAndSync(j.privateStagePath);
    host.db.db.prepare('UPDATE artifact_commit_journal SET audit_note = ? WHERE commit_id = ?')
      .run(note, j.commitId);
  };

  const markTerminal = (j: ArtifactCommitJournalRow, state: 'aborted' | 'ambiguous_quarantined',
    note: string, syncExternalAfter: boolean) => {
    const needsExternalSync = syncExternalAfter && !j.isCreate;
    const now = Date.now();
    host.db.db.exec('BEGIN IMMEDIATE;');
    try {
      if (j.isCreate) {
        host.db.db.prepare("DELETE FROM artifacts WHERE id = ? AND lifecycle_state = 'pending_create'").run(j.artifactId);
      }
      if (state === 'aborted') {
        host.db.db.prepare('DELETE FROM artifact_idempotency WHERE commit_id = ? AND user_id = ?')
          .run(j.commitId, j.userId);
      } else {
        host.db.db.prepare(`UPDATE artifact_idempotency SET status = 'ambiguous_quarantined', updated_at = ?
          WHERE commit_id = ? AND user_id = ?`).run(now, j.commitId, j.userId);
      }
      host.db.db.prepare('UPDATE artifact_commit_journal SET state = ?, audit_note = ?, updated_at = ? WHERE commit_id = ?')
        .run(state, JSON.stringify({ recoveryCleanup: note, needsExternalSync }), now, j.commitId);
      host.db.db.exec('COMMIT;');
    } catch (err) {
      host.db.db.exec('ROLLBACK;');
      throw err;
    }
    finishTerminal(j, note, needsExternalSync);
    if (state === 'aborted') report.aborted += 1;
    else report.quarantined += 1;
  };

  const markAborted = (j: ArtifactCommitJournalRow, note: string, syncExternalAfter = false) =>
    markTerminal(j, 'aborted', note, syncExternalAfter);
  const markQuarantined = (j: ArtifactCommitJournalRow, note: string, syncExternalAfter = false) =>
    markTerminal(j, 'ambiguous_quarantined', note, syncExternalAfter);

  const rollForwardToT6 = (j: ArtifactCommitJournalRow, rootDir: string | null) => {
    if ((j.operationType === 'reflect_from_chat_working_copy' && !j.finalization?.updateWorkingCopyId) ||
        (j.operationType === 'project_sync' && (!j.finalization?.sourceArtifactId || j.finalization.sourceBaseRevision == null))) {
      markQuarantined(j, 'project_provenance_missing_from_legacy_journal');
      return;
    }
    let envelopes: ReturnType<AppDatabase['insertSyncEventInTx']>[];
    host.db.db.exec('BEGIN IMMEDIATE;');
    try {
      envelopes = host.finalizeStageT6InTx(j, { suppressDependencyPropagation: Boolean(j.batchId) }).envelopes;
      host.db.db.exec('COMMIT;');
    } catch (err) {
      host.db.db.exec('ROLLBACK;');
      throw err;
    }
    removeStageAndSync(j.privateStagePath);
    for (const env of envelopes) host.hub.broadcastPersistedEvent(env);
    syncExternal(j, rootDir);
    host.db.db.prepare('DELETE FROM artifact_commit_journal WHERE commit_id = ?').run(j.commitId);
    report.rolledForward += 1;
  };

  const readCommittedOutbox = (j: ArtifactCommitJournalRow) => {
    let refs: Array<{ seq: unknown; eventId?: unknown }>;
    if (j.auditNote !== null) {
      try {
        const audit = JSON.parse(j.auditNote);
        if (Array.isArray(audit.syncEvents)) {
          if (!audit.syncEvents.every((ref: unknown) => ref && typeof ref === 'object' &&
            'eventId' in ref && typeof ref.eventId === 'string' && ref.eventId)) return null;
          refs = audit.syncEvents;
        } else if (Array.isArray(audit.syncEventSeqs)) {
          refs = audit.syncEventSeqs.map((seq: unknown) => ({ seq }));
        } else {
          return null;
        }
      } catch {
        return null;
      }
    } else {
      if (j.syncEventSeq === null) return null;
      refs = [{ seq: j.syncEventSeq }];
    }
    if (refs.length === 0) {
      // A physical delete with no tracked artifact can legitimately emit no events.
      return j.operationType === 'delete_sync_file' && j.syncEventSeq === null ? [] : null;
    }
    if (refs[0].seq !== j.syncEventSeq) return null;
    const envelopes: ReturnType<AppDatabase['insertSyncEventInTx']>[] = [];
    let previousSeq = 0;
    for (const [i, { seq, eventId }] of refs.entries()) {
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= previousSeq) return null;
      previousSeq = seq;
      const ev = host.db.db.prepare('SELECT * FROM sync_events WHERE seq = ?').get(seq);
      if (!ev) {
        const expired = typeof eventId === 'string' && host.db.db.prepare(
          'SELECT 1 FROM artifact_commit_outbox_expirations WHERE commit_id = ? AND seq = ? AND event_id = ?',
        ).get(j.commitId, seq, eventId);
        if (expired) continue;
        return null;
      }
      if (ev.user_id !== j.userId || (eventId !== undefined && eventId !== ev.event_id)) return null;
      try {
        const payload = JSON.parse(String(ev.payload_json));
        const reflectedCopy = j.finalization?.updateWorkingCopyId &&
          ev.event_type === 'artifact.updated' && ev.project_id === null && payload?.artifact?.chatId === ev.chat_id &&
          payload.artifact.id === j.finalization.updateWorkingCopyId &&
          payload.artifact.sourceArtifactId === j.artifactId && payload.artifact.sourceBaseRevision === j.targetRevision;
        if (!reflectedCopy && (ev.chat_id !== j.chatId || ev.project_id !== j.projectId)) return null;
        if (!j.operationType.startsWith('delete_') && i === refs.length - 1 &&
            (ev.event_type !== (j.isCreate ? 'artifact.created' : 'artifact.updated') ||
            payload?.artifact?.id !== j.artifactId || payload.artifact.revision !== j.targetRevision)) return null;
        envelopes.push({
          seq, userSeq: Number(ev.user_seq), eventId: String(ev.event_id), userId: j.userId,
          type: String(ev.event_type), chatId: ev.chat_id ? String(ev.chat_id) : null, projectId: ev.project_id ? String(ev.project_id) : null,
          runId: ev.run_id ? String(ev.run_id) : null, payload, createdAt: Number(ev.created_at),
        });
      } catch {
        return null;
      }
    }
    return envelopes;
  };

  const rollForwardDeleteToT6 = (j: ArtifactCommitJournalRow, performPartialCleanup: boolean) => {
    if (performPartialCleanup) {
      if (!host.performVerifiedPartialDeleteCleanup) {
        markQuarantined(j, 'delete_partial_cleanup_unavailable');
        return;
      }
      const cleaned = host.performVerifiedPartialDeleteCleanup(j);
      if (!cleaned.ok) {
        markQuarantined(j, `delete_partial_cleanup_aborted:${cleaned.reason}`);
        return;
      }
    }
    let envelopes: ReturnType<AppDatabase['insertSyncEventInTx']>[] = [];
    host.db.db.exec('BEGIN IMMEDIATE;');
    try {
      const finalized = host.finalizeDeleteStageT6InTx!(j);
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
    report.rolledForward += 1;
  };

  for (const raw of rows) {
    try {
      const j = mapJournalRow(raw);

      if (j.state === 'aborted' || j.state === 'ambiguous_quarantined') {
        const audit = JSON.parse(j.auditNote!);
        finishTerminal(j, audit.recoveryCleanup, audit.needsExternalSync);
        continue;
      }

      // 1. db_committed: verify outbox sync_event(s) exist, broadcast if needed, delete completed journal
      if (j.state === 'db_committed') {
        const outbox = readCommittedOutbox(j);
        if (!outbox) {
          // A gap in replay history cannot prove that this commit's event ever existed.
          // Preserve the journal and completed revisions for diagnosis and retry.
          console.error('[artifact-recovery] Cannot verify committed outbox', j.commitId, j.syncEventSeq);
          report.quarantined += 1;
          continue;
        }
        removeStageAndSync(j.privateStagePath);
        for (const envelope of outbox) host.hub.broadcastPersistedEvent(envelope);
        if (!j.operationType.startsWith('delete_')) {
          syncExternal(j, host.resolveScopeRootDir(j.userId, j.scopeKind, j.chatId, j.projectId));
        }
        host.db.db.prepare('DELETE FROM artifact_commit_journal WHERE commit_id = ?').run(j.commitId);
        report.completedOutbox += 1;
        continue;
      }

      // 1b. Journaled delete operations (delete_project_file, delete_project, delete_sync_file, delete_chat)
      if (j.operationType.startsWith('delete_') && host.finalizeDeleteStageT6InTx) {
        const inspection: DeleteTargetInspection = host.inspectDeleteTarget
          ? host.inspectDeleteTarget(j)
          : { status: 'indeterminate', detail: 'no_delete_inspector' };

        if (j.state === 'prepared') {
          if (inspection.status === 'intact' || (inspection.absentAtT1 && inspection.status === 'deleted')) {
            markAborted(j, 'delete_aborted_before_unlink');
          } else {
            markQuarantined(j, `delete_prepared_${inspection.status}:${inspection.detail}`);
          }
          continue;
        }

        if (j.state === 'file_replaced') {
          if (inspection.status === 'deleted') {
            // FS deletion already completed before T5; finalize DB only without touching FS.
            rollForwardDeleteToT6(j, false);
          } else if (inspection.status === 'externally_recreated') {
            // Original target was already deleted before T5, and a new external file/dir now occupies the path.
            // Finalize DB deletion of the old record WITHOUT touching the externally recreated FS target.
            rollForwardDeleteToT6(j, false);
          } else {
            // Target still intact, partially deleted, or indeterminate despite T5 -> quarantine, NEVER blindly re-delete.
            markQuarantined(j, `delete_file_replaced_${inspection.status}:${inspection.detail}`);
          }
          continue;
        }

        if (j.state === 'replacing') {
          if (inspection.status === 'intact') {
            markAborted(j, 'delete_aborted_target_still_intact');
          } else if (inspection.status === 'deleted') {
            // T4 already finished deleting the target before crashing prior to T5; finalize DB without FS re-delete.
            rollForwardDeleteToT6(j, false);
          } else if (inspection.status === 'partially_deleted') {
            // Subtree deletion crashed mid-way and every remaining entry matches the T1 snapshot:
            // complete identity-verified cleanup of remaining T1 entries only, then finalize T6.
            rollForwardDeleteToT6(j, true);
          } else if (inspection.status === 'externally_recreated' && inspection.absentAtT1) {
            // Target was already absent before T1, so any current entry is provably a brand-new external creation:
            // finalize old DB record deletion without touching the new FS target.
            rollForwardDeleteToT6(j, false);
          } else {
            // externally_recreated (with existedAtT1=true) or indeterminate -> quarantine, NEVER unconditionally re-delete.
            markQuarantined(j, `delete_replacing_${inspection.status}:${inspection.detail}`);
          }
          continue;
        }
      }

      // ARCH-05 & SEC-10: Use ONLY the isolation mode recorded at commit time (T1).
      // If unknown/null or non_isolated_same_uid, NEVER assume mount isolation.
      const isMountIsolated = j.stagingIsolationMode === 'bwrap_mount_isolated';
      const rootDir = host.resolveScopeRootDir(j.userId, j.scopeKind, j.chatId, j.projectId);
      if (!rootDir) throw new Error('Cannot resolve scope for commit recovery');
      const stage = inspectStageFile(j.privateStagePath);
      const target = inspectTargetFile(rootDir, j.relPath);

      // 2. file_replaced: placement succeeded -> roll forward to Stage T6 (+ external_sync if subsequently changed)
      if (j.state === 'file_replaced') {
        rollForwardToT6(j, rootDir);
        continue;
      }

      // 3. prepared: link/rename has not been entered yet
      if (j.state === 'prepared') {
        const targetUnchanged = j.isCreate
          ? !target.exists
          : target.exists && !target.unreadableOrTampered && target.sha256 === j.expectedPrevSha256;
        const stageIntact =
          j.stageIno === null ||
          (stage.state === 'present' && stage.ino === j.stageIno && stage.sha256 === j.newSha256);

        if (targetUnchanged && stageIntact) {
          markAborted(j, 'prepared_aborted_before_replace');
        } else {
          markQuarantined(
            j,
            !stageIntact ? 'prepared_stage_tampered_or_missing' : 'prepared_target_changed',
            !j.isCreate && !targetUnchanged
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
          rollForwardToT6(j, rootDir);
        } else {
          // ALL other cases for replacing(is_create=1) MUST be quarantined (cannot distinguish post-link external delete)
          markQuarantined(j, 'replacing_create_ambiguous_state');
        }
        continue;
      }

      // 5. replacing (is_create = 0)
      if (j.state === 'replacing' && !j.isCreate) {
        if (stage.state !== 'missing') {
          if (stage.state !== 'present' || stage.ino !== j.stageIno || stage.sha256 !== j.newSha256) {
            markQuarantined(j, 'replacing_stage_unreadable_or_tampered', true);
            continue;
          }
          const targetMatchesPrev =
            target.exists && !target.unreadableOrTampered && target.sha256 === j.expectedPrevSha256;
          if (targetMatchesPrev) {
            if (isMountIsolated) {
              markAborted(j, 'replacing_update_not_performed_isolated');
            } else {
              markQuarantined(j, 'replacing_update_stage_present_non_isolated');
            }
          } else {
            if (isMountIsolated) {
              markAborted(j, 'replacing_update_not_performed_external_change_isolated', true);
            } else {
              markQuarantined(j, 'replacing_update_external_change_non_isolated', true);
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
            rollForwardToT6(j, rootDir);
          } else if (isMountIsolated) {
            // Rename completed before subsequent external modification/deletion
            rollForwardToT6(j, rootDir);
          } else {
            markQuarantined(j, 'replacing_update_stage_absent_mismatch_non_isolated', true);
          }
        }
      }
    } catch (error) {
      // Preserve the journal so transient I/O errors can be retried without
      // reclassifying the commit or losing an external change.
      console.error('[artifact-recovery] Commit recovery deferred', raw.commit_id, error);
      report.quarantined += 1;
    }
  }

  return report;
}
