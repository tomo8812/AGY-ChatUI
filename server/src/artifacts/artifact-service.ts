import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { probeBwrapSandbox } from '../acp/env-isolation.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import {
  checkSameFilesystem,
  detectMimeAndPreviewKind,
  ensureContainedDirectoryNoFollow,
  ExternalConcurrentWriteError,
  fingerprintsMatch,
  fsyncDir,
  normalizeRelPath,
  openContainedRegularFileNoFollow,
  readContainedRegularFileNoFollowStable,
  sanitizeFileName,
  sha256Fd,
  type FileFingerprint,
} from '../files/workspace.js';
import type { SyncHub } from '../sync/hub.js';
import type {
  ArtifactRecord,
  ArtifactScopeKind,
  ProjectFileRecord,
  SyncEventEnvelope,
} from '../types.js';
import { detectArtifactFormat, FormatAdapterRegistry } from './adapters/registry.js';
import { executeRestoreBundle, getRestoreBatchRecord, recoverPendingRestoreBatches } from './batch-restore.js';
import { PerUserBlobManager, type BlobLease } from './blob-store.js';
import { recoverPendingCommits, type RecoveryReport } from './commit-recovery.js';
import { scanArtifactDependencies } from './dependency-manifest.js';
import { drainDepPropagationQueue } from './dep-propagation.js';
import { artifactConflictError, ArtifactError, unsupportedOperationError } from './errors.js';
import { computeRequestFingerprint, IdempotencyFlightCoordinator } from './idempotency-coordinator.js';
import { ArtifactLockManager } from './lock-manager.js';
import { RenderCacheManager } from './render-cache.js';
import { ResourceGovernor } from './resource-governor.js';
import { DocWorkerSandbox } from './sandbox-worker.js';
import type {
  ActorKind,
  AdapterExportResult,
  AdapterOperation,
  AdapterVerifyResult,
  ArtifactCapabilitiesResponse,
  ArtifactCommitJournalRow,
  ArtifactDependencyEntry,
  ArtifactRestoreBatchRecord,
  ArtifactRevisionRecord,
  CommitFaultHook,
  StagingIsolationKind,
  TargetResolutionResult,
  TargetSelector,
} from './types.js';
import { ArtifactUndoService, type UndoStateSummary } from './undo-service.js';

export interface ArtifactServiceOptions {
  serverBootId?: string;
  stagingIsolationOverride?: StagingIsolationKind;
  sameFsCheckOverride?: (pathA: string, pathB: string) => boolean;
}

const MAX_TEXT_DIFF_BYTES = 256 * 1024;

function maybeTextDiff(relPath: string, prevBuf: Buffer | null, nextBuf: Buffer): string | null {
  if (nextBuf.length > MAX_TEXT_DIFF_BYTES) return null;
  if (nextBuf.includes(0)) return null;
  if (prevBuf && (prevBuf.length > MAX_TEXT_DIFF_BYTES || prevBuf.includes(0))) return null;
  return createTwoFilesPatch(
    `a/${relPath}`,
    `b/${relPath}`,
    prevBuf ? prevBuf.toString('utf8') : '',
    nextBuf.toString('utf8'),
    undefined,
    undefined,
    { context: 3 }
  );
}

export class ArtifactService {
  public readonly blobManager: PerUserBlobManager;
  public readonly lockManager: ArtifactLockManager;
  public readonly idempotency: IdempotencyFlightCoordinator;
  public readonly registry: FormatAdapterRegistry;
  public readonly governor: ResourceGovernor;
  public readonly sandboxWorker: DocWorkerSandbox;
  public readonly renderCache: RenderCacheManager;
  public readonly undoService: ArtifactUndoService;

  private stagingIsolationOverride?: StagingIsolationKind;
  private sameFsCheckOverride?: (pathA: string, pathB: string) => boolean;
  public commitFaultHook?: CommitFaultHook;
  private readonly updateListeners = new Set<(artifact: ArtifactRecord) => void>();

  constructor(
    public readonly config: AppConfig,
    public readonly db: AppDatabase,
    public readonly hub: SyncHub,
    opts: ArtifactServiceOptions = {}
  ) {
    fs.mkdirSync(config.artifactHistoryRoot, { recursive: true, mode: 0o700 });
    this.blobManager = new PerUserBlobManager(
      config.artifactHistoryRoot,
      config.artifactHistoryMaxMb * 1024 * 1024
    );
    this.lockManager = new ArtifactLockManager();
    this.idempotency = new IdempotencyFlightCoordinator(db, opts.serverBootId);
    this.registry = new FormatAdapterRegistry();
    this.governor = new ResourceGovernor(config);
    this.sandboxWorker = new DocWorkerSandbox(config, this.governor);
    this.renderCache = new RenderCacheManager(config);
    this.undoService = new ArtifactUndoService(db);
    this.stagingIsolationOverride = opts.stagingIsolationOverride;
    this.sameFsCheckOverride = opts.sameFsCheckOverride;
  }

  onArtifactUpdated(listener: (artifact: ArtifactRecord) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  private notifyUpdateListeners(artifact: ArtifactRecord): void {
    for (const listener of this.updateListeners) {
      try {
        listener(artifact);
      } catch {
        // non-fatal listener error
      }
    }
  }

  setStagingIsolationOverride(mode?: StagingIsolationKind): void {
    this.stagingIsolationOverride = mode;
  }

  setSameFsCheckOverride(fn?: (pathA: string, pathB: string) => boolean): void {
    this.sameFsCheckOverride = fn;
  }

  getStagingIsolation(): StagingIsolationKind {
    if (this.stagingIsolationOverride) return this.stagingIsolationOverride;
    const status = probeBwrapSandbox(this.config);
    return status.active && status.backend === 'bwrap' ? 'bwrap_mount_isolated' : 'non_isolated_same_uid';
  }

  private assertSameFilesystem(stagingDir: string, targetRootDir: string): void {
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(targetRootDir, { recursive: true, mode: 0o700 });
    const checker = this.sameFsCheckOverride ?? checkSameFilesystem;
    if (!checker(stagingDir, targetRootDir)) {
      throw new ArtifactError(
        'UNSUPPORTED_CROSS_FS_STORAGE',
        'artifact-history とワークスペース/プロジェクトが異なるファイルシステム上にあるため、安全な原子的保存を実行できません。同一ファイルシステムに配置してください。',
        503
      );
    }
  }

  resolveScopeRootDir(
    userId: string,
    scopeKind: ArtifactScopeKind,
    chatId: string | null,
    projectId: string | null
  ): string | null {
    if (scopeKind === 'chat' && chatId) {
      const chat = this.db.getChat(userId, chatId);
      return chat ? chat.workspaceDir : null;
    }
    if (scopeKind === 'project' && projectId) {
      const project = this.db.getProject(userId, projectId);
      return project ? project.storageDir : null;
    }
    return null;
  }

  /**
   * Startup recovery in exact Section 3.3 order:
   * 1) recoverPendingCommits
   * 2) recoverStaleIdempotency
   * 3) recoverPendingRestoreBatches
   * 4) drainDepPropagationQueue
   */
  async recoverOnStartup(): Promise<{
    commits: RecoveryReport;
    staleIdempotencyDeleted: number;
    restoreBatchesRecovered: number;
    depPropagationProcessed: number;
  }> {
    const commits = recoverPendingCommits({
      db: this.db,
      hub: this.hub,
      blobManager: this.blobManager,
      getStagingIsolation: () => this.getStagingIsolation(),
      resolveScopeRootDir: (u, sk, cid, pid) => this.resolveScopeRootDir(u, sk, cid, pid),
      finalizeStageT6InTx: (j, opts) => this.finalizeStageT6InTx(j, opts),
      recordExternalSyncOnRecovery: (p) => this.recordExternalSyncOnRecovery(p),
    });
    const staleIdempotencyDeleted = this.idempotency.recoverStaleIdempotency();
    const restoreBatchesRecovered = recoverPendingRestoreBatches(this.db);
    const depPropagationProcessed = await this.drainDepPropagationQueue();
    return {
      commits,
      staleIdempotencyDeleted,
      restoreBatchesRecovered,
      depPropagationProcessed,
    };
  }

  async drainDepPropagationQueue(): Promise<number> {
    return drainDepPropagationQueue({
      db: this.db,
      hub: this.hub,
      blobManager: this.blobManager,
      lockManager: this.lockManager,
      resolveScopeRootDir: (u, sk, cid, pid) => this.resolveScopeRootDir(u, sk, cid, pid),
      readActiveArtifactBytes: (a) => this.readActiveArtifactBytes(a),
    });
  }

  readActiveArtifactBytes(artifact: ArtifactRecord): Buffer | null {
    const rootDir = this.resolveScopeRootDir(artifact.userId, artifact.scopeKind, artifact.chatId, artifact.projectId);
    if (!rootDir) return null;
    try {
      const res = readContainedRegularFileNoFollowStable(rootDir, artifact.relPath);
      return res.buffer;
    } catch {
      return null;
    }
  }

  /**
   * Ensures a legacy artifact row (created before revision history existed) has its initial baseline recorded.
   * Implements exact Section 3.1 rule:
   * - diskSha256 === db.sha256 -> revision 1 (`legacy_baseline`, blob_available=1)
   * - diskSha256 !== db.sha256 -> revision 1 (`legacy_unarchived`, blob_sha256=NULL, blob_available=0)
   *                               + revision 2 (`external_sync`, current disk file, blob_available=1)
   */
  ensureLegacyHistoryMigrated(artifact: ArtifactRecord): ArtifactRecord {
    const countRow = this.db.db
      .prepare('SELECT COUNT(*) AS cnt FROM artifact_revisions WHERE artifact_id = ?')
      .get(artifact.id) as { cnt: number };
    if (Number(countRow.cnt) > 0) return artifact;

    const rootDir = this.resolveScopeRootDir(artifact.userId, artifact.scopeKind, artifact.chatId, artifact.projectId);
    if (!rootDir || path.isAbsolute(artifact.relPath)) {
      return artifact;
    }

    let diskRead: ReturnType<typeof readContainedRegularFileNoFollowStable> | null = null;
    try {
      diskRead = readContainedRegularFileNoFollowStable(rootDir, artifact.relPath);
    } catch {
      return artifact;
    }

    const lease = this.blobManager.putBlobWithLease(artifact.userId, diskRead.buffer);
    try {
      const now = Date.now();
      this.db.db.exec('BEGIN IMMEDIATE;');
      try {
        const recheck = this.db.db
          .prepare('SELECT COUNT(*) AS cnt FROM artifact_revisions WHERE artifact_id = ?')
          .get(artifact.id) as { cnt: number };
        if (Number(recheck.cnt) === 0) {
          if (diskRead.sha256 === artifact.sha256) {
            this.db.db
              .prepare(
                `INSERT INTO artifact_revisions (
                   id, artifact_id, user_id, chat_id, project_id, revision, parent_revision,
                   sha256, dependency_manifest_hash, size_bytes, blob_sha256, blob_available,
                   actor_kind, actor_id, operation_type, operation_summary, operation_payload_json,
                   batch_id, diff_patch, created_at
                 ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, 1, 'system', NULL, 'legacy_baseline', 'Migrated baseline', NULL, NULL, NULL, ?)`
              )
              .run(
                crypto.randomUUID(),
                artifact.id,
                artifact.userId,
                artifact.chatId,
                artifact.projectId,
                artifact.sha256,
                artifact.dependencyManifestHash,
                artifact.sizeBytes,
                lease.sha256,
                artifact.createdAt
              );
          } else {
            // Do NOT fabricate unarchived legacy revision 1; record as legacy_unarchived + rev 2 external_sync
            this.db.db
              .prepare(
                `INSERT INTO artifact_revisions (
                   id, artifact_id, user_id, chat_id, project_id, revision, parent_revision,
                   sha256, dependency_manifest_hash, size_bytes, blob_sha256, blob_available,
                   actor_kind, actor_id, operation_type, operation_summary, operation_payload_json,
                   batch_id, diff_patch, created_at
                 ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, NULL, ?, NULL, 0, 'system', NULL, 'legacy_unarchived', 'Legacy revision snapshot unavailable', NULL, NULL, NULL, ?)`
              )
              .run(
                crypto.randomUUID(),
                artifact.id,
                artifact.userId,
                artifact.chatId,
                artifact.projectId,
                artifact.sha256,
                artifact.sizeBytes,
                artifact.createdAt
              );
            this.db.db
              .prepare(
                `INSERT INTO artifact_revisions (
                   id, artifact_id, user_id, chat_id, project_id, revision, parent_revision,
                   sha256, dependency_manifest_hash, size_bytes, blob_sha256, blob_available,
                   actor_kind, actor_id, operation_type, operation_summary, operation_payload_json,
                   batch_id, diff_patch, created_at
                 ) VALUES (?, ?, ?, ?, ?, 2, 1, ?, NULL, ?, ?, 1, 'system', NULL, 'external_sync', 'Synchronized current disk version', NULL, NULL, NULL, ?)`
              )
              .run(
                crypto.randomUUID(),
                artifact.id,
                artifact.userId,
                artifact.chatId,
                artifact.projectId,
                diskRead.sha256,
                diskRead.sizeBytes,
                lease.sha256,
                now
              );
            this.db.db
              .prepare(
                `UPDATE artifacts
                 SET sha256 = ?, size_bytes = ?, revision = 2, updated_at = ?
                 WHERE id = ? AND user_id = ?`
              )
              .run(diskRead.sha256, diskRead.sizeBytes, now, artifact.id, artifact.userId);
          }
        }
        this.db.db.exec('COMMIT;');
      } catch (err) {
        this.db.db.exec('ROLLBACK;');
        throw err;
      }
    } finally {
      lease.release();
    }

    return this.db.getArtifact(artifact.userId, artifact.id) ?? artifact;
  }

  private recordExternalSyncOnRecovery(params: {
    userId: string;
    artifactId: string;
    rootDir: string;
    relPath: string;
  }): void {
    const artifact = this.db.getArtifact(params.userId, params.artifactId);
    if (!artifact) return;

    const now = Date.now();
    try {
      const read = readContainedRegularFileNoFollowStable(params.rootDir, params.relPath);
      if (read.sha256 === artifact.sha256) return;
      const lease = this.blobManager.putBlobWithLease(params.userId, read.buffer);
      try {
        const nextRev = artifact.revision + 1;
        let env: SyncEventEnvelope;
        this.db.db.exec('BEGIN IMMEDIATE;');
        try {
          this.db.db
            .prepare(
              `UPDATE artifacts
               SET sha256 = ?, size_bytes = ?, revision = ?, deleted_on_disk = 0, updated_at = ?
               WHERE id = ? AND user_id = ?`
            )
            .run(read.sha256, read.sizeBytes, nextRev, now, artifact.id, params.userId);
          this.db.db
            .prepare(
              `INSERT INTO artifact_revisions (
                 id, artifact_id, user_id, chat_id, project_id, revision, parent_revision,
                 sha256, dependency_manifest_hash, size_bytes, blob_sha256, blob_available,
                 actor_kind, actor_id, operation_type, operation_summary, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, 'system', NULL, 'external_sync', 'External file change detected during recovery', ?)`
            )
            .run(
              crypto.randomUUID(),
              artifact.id,
              params.userId,
              artifact.chatId,
              artifact.projectId,
              nextRev,
              artifact.revision,
              read.sha256,
              read.sizeBytes,
              lease.sha256,
              now
            );
          const updated = this.db.getArtifact(params.userId, artifact.id)!;
          env = this.db.insertSyncEventInTx({
            userId: params.userId,
            eventId: crypto.randomUUID(),
            type: 'artifact.updated',
            chatId: updated.chatId,
            projectId: updated.projectId,
            payload: { artifact: updated, reason: 'external_sync' },
            createdAt: now,
          });
          this.db.db.exec('COMMIT;');
        } catch (err) {
          this.db.db.exec('ROLLBACK;');
          throw err;
        }
        this.hub.broadcastPersistedEvent(env);
      } finally {
        lease.release();
      }
    } catch {
      // File disappeared on disk -> mark deleted_on_disk = 1
      this.db.db
        .prepare('UPDATE artifacts SET deleted_on_disk = 1, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(now, artifact.id, params.userId);
    }
  }

  /**
   * Stage T6 transactional finalization shared between normal commit path and crash recovery roll-forward.
   */
  private finalizeStageT6InTx(
    journal: ArtifactCommitJournalRow,
    opts: {
      suppressDependencyPropagation?: boolean;
      extraArtifactFields?: {
        filename?: string;
        mimeType?: string;
        previewKind?: ArtifactRecord['previewKind'];
        source?: ArtifactRecord['source'];
        messageId?: string | null;
        runId?: string | null;
        sourceArtifactId?: string | null;
        sourceBaseRevision?: number | null;
      };
      idempotencyResponseBuilder?: (artifact: ArtifactRecord) => unknown;
      updateWorkingCopyId?: string;
    } = {}
  ): { artifact: ArtifactRecord; envelopes: SyncEventEnvelope[] } {
    const now = Date.now();
    const existing = this.db.getArtifactInternal(journal.artifactId);
    const filename = opts.extraArtifactFields?.filename ?? existing?.filename ?? path.basename(journal.relPath);
    const detected = detectMimeAndPreviewKind(filename, opts.extraArtifactFields?.mimeType ?? existing?.mimeType);
    const mimeType = opts.extraArtifactFields?.mimeType ?? existing?.mimeType ?? detected.mimeType;
    const previewKind = opts.extraArtifactFields?.previewKind ?? existing?.previewKind ?? detected.previewKind;
    const source =
      opts.extraArtifactFields?.source ??
      existing?.source ??
      (journal.scopeKind === 'project' ? 'project_upload' : 'user_edit');

    if (existing) {
      this.db.db
        .prepare(
          `UPDATE artifacts
           SET lifecycle_state = 'active',
               deleted_on_disk = 0,
               revision = ?,
               sha256 = ?,
               size_bytes = ?,
               dependency_manifest_hash = ?,
               filename = ?,
               mime_type = ?,
               preview_kind = ?,
               source = ?,
               message_id = COALESCE(?, message_id),
               run_id = COALESCE(?, run_id),
               diff_patch = COALESCE(?, diff_patch),
               source_artifact_id = COALESCE(?, source_artifact_id),
               source_base_revision = COALESCE(?, source_base_revision),
               updated_at = ?
           WHERE id = ? AND user_id = ?`
        )
        .run(
          journal.targetRevision,
          journal.newSha256,
          journal.newSizeBytes,
          journal.newDependencyManifestHash,
          filename,
          mimeType,
          previewKind,
          source,
          opts.extraArtifactFields?.messageId ?? null,
          opts.extraArtifactFields?.runId ?? null,
          journal.diffPatch,
          opts.extraArtifactFields?.sourceArtifactId ?? null,
          opts.extraArtifactFields?.sourceBaseRevision ?? null,
          now,
          journal.artifactId,
          journal.userId
        );
    } else {
      this.db.db
        .prepare(
          `INSERT INTO artifacts (
             id, user_id, scope_kind, chat_id, project_id, message_id, run_id,
             rel_path, filename, mime_type, size_bytes, sha256, source, preview_kind,
             diff_patch, lifecycle_state, deleted_on_disk, revision, dependency_manifest_hash,
             source_artifact_id, source_base_revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          journal.artifactId,
          journal.userId,
          journal.scopeKind,
          journal.chatId,
          journal.projectId,
          opts.extraArtifactFields?.messageId ?? null,
          opts.extraArtifactFields?.runId ?? null,
          journal.relPath,
          filename,
          mimeType,
          journal.newSizeBytes,
          journal.newSha256,
          source,
          previewKind,
          journal.diffPatch,
          journal.targetRevision,
          journal.newDependencyManifestHash,
          opts.extraArtifactFields?.sourceArtifactId ?? null,
          opts.extraArtifactFields?.sourceBaseRevision ?? null,
          now,
          now
        );
    }

    // Insert revision record (idempotent on re-run via INSERT OR IGNORE)
    this.db.db
      .prepare(
        `INSERT OR IGNORE INTO artifact_revisions (
           id, artifact_id, user_id, chat_id, project_id, revision, parent_revision,
           sha256, dependency_manifest_hash, size_bytes, blob_sha256, blob_available,
           actor_kind, actor_id, operation_type, operation_summary, operation_payload_json,
           batch_id, diff_patch, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        journal.artifactId,
        journal.userId,
        journal.chatId,
        journal.projectId,
        journal.targetRevision,
        journal.parentRevision,
        journal.newSha256,
        journal.newDependencyManifestHash,
        journal.newSizeBytes,
        journal.newBlobSha256,
        journal.actorKind,
        journal.actorId,
        journal.operationType,
        journal.operationSummary,
        journal.operationPayloadJson,
        journal.batchId,
        journal.diffPatch,
        now
      );

    // Record dependencies for this revision
    for (const dep of journal.newDeps) {
      this.db.db
        .prepare(
          `INSERT OR REPLACE INTO artifact_revision_deps (
             artifact_id, revision, user_id, scope_kind, chat_id, project_id,
             rel_path, status, sha256, blob_sha256, size_bytes, mime_type
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          journal.artifactId,
          journal.targetRevision,
          journal.userId,
          journal.scopeKind,
          journal.chatId,
          journal.projectId,
          dep.relPath,
          dep.status,
          dep.sha256,
          dep.blobSha256,
          dep.sizeBytes,
          dep.mimeType
        );
    }

    // Enqueue persistent dependency propagation unless suppressed by batch restore
    if (!opts.suppressDependencyPropagation) {
      this.db.db
        .prepare(
          `INSERT INTO artifact_dep_propagation_queue (
             id, user_id, scope_kind, chat_id, project_id, changed_rel_path,
             source_artifact_id, source_revision, batch_id, exclude_artifact_ids_json, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'pending', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          journal.userId,
          journal.scopeKind,
          journal.chatId,
          journal.projectId,
          journal.relPath,
          journal.artifactId,
          journal.targetRevision,
          journal.batchId,
          now,
          now
        );
    }

    const artifact = this.db.getArtifact(journal.userId, journal.artifactId)!;
    const envelopes: SyncEventEnvelope[] = [];

    // Sync project_files metadata + projects.context_version in same tx when project scope
    if (journal.scopeKind === 'project' && journal.projectId) {
      const existingPf = this.db.db
        .prepare('SELECT id FROM project_files WHERE project_id = ? AND rel_path = ? AND user_id = ?')
        .get(journal.projectId, journal.relPath, journal.userId) as { id: string } | undefined;
      this.db.upsertProjectFileInTx(
        {
          id: existingPf?.id ?? crypto.randomUUID(),
          projectId: journal.projectId,
          userId: journal.userId,
          artifactId: artifact.id,
          relPath: artifact.relPath,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          createdAt: now,
        },
        now
      );
      if (opts.updateWorkingCopyId) {
        this.db.db
          .prepare(
            'UPDATE artifacts SET source_base_revision = ?, updated_at = ? WHERE id = ? AND user_id = ?'
          )
          .run(artifact.revision, now, opts.updateWorkingCopyId, journal.userId);
      }
      const latestProj = this.db.getProject(journal.userId, journal.projectId);
      if (latestProj) {
        envelopes.push(
          this.db.insertSyncEventInTx({
            userId: journal.userId,
            eventId: crypto.randomUUID(),
            type: 'project.updated',
            projectId: journal.projectId,
            payload: {
              project: {
                ...latestProj,
                files: this.db.listProjectFiles(journal.userId, journal.projectId),
              },
            },
            createdAt: now,
          })
        );
      }
    }

    // Outbox artifact event
    const artEnvelope = this.db.insertSyncEventInTx({
      userId: journal.userId,
      eventId: crypto.randomUUID(),
      type: journal.isCreate ? 'artifact.created' : 'artifact.updated',
      chatId: artifact.chatId,
      projectId: artifact.projectId,
      runId: artifact.runId,
      payload: { artifact },
      createdAt: now,
    });
    envelopes.push(artEnvelope);

    // Finalize idempotency row inside same tx
    if (journal.idempotencyScopeKey && journal.idempotencyKey) {
      const respObj = opts.idempotencyResponseBuilder
        ? opts.idempotencyResponseBuilder(artifact)
        : { artifact, noOp: false };
      this.db.db
        .prepare(
          `UPDATE artifact_idempotency
           SET status = 'completed',
               commit_id = ?,
               artifact_id = ?,
               committed_revision = ?,
               no_op = 0,
               response_json = ?,
               updated_at = ?
           WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?`
        )
        .run(
          journal.commitId,
          artifact.id,
          artifact.revision,
          JSON.stringify(respObj),
          now,
          journal.userId,
          journal.idempotencyScopeKey,
          journal.idempotencyKey
        );
    }

    // Mark journal db_committed with outbox seq
    this.db.db
      .prepare(
        `UPDATE artifact_commit_journal
         SET state = 'db_committed', sync_event_seq = ?, updated_at = ?
         WHERE commit_id = ?`
      )
      .run(artEnvelope.seq, now, journal.commitId);

    return { artifact, envelopes };
  }

  /**
   * Core T0 -> T7 durable commit pipeline (`ARCH-04`, `ARCH-05`, `SEC-10`).
   */
  private async commitFileMutation(params: {
    userId: string;
    scopeKind: ArtifactScopeKind;
    chatId: string | null;
    projectId: string | null;
    rootDir: string;
    relPath: string;
    filename: string;
    mimeType: string;
    previewKind: ArtifactRecord['previewKind'];
    source: ArtifactRecord['source'];
    isCreate: boolean;
    artifactId: string;
    parentRevision: number | null;
    targetRevision: number;
    expectedPrevSha256: string | null;
    expectedPrevFingerprint: FileFingerprint | null;
    prevBuffer: Buffer | null;
    prevDepHash: string | null;
    newBuffer: Buffer;
    actorKind: ActorKind;
    actorId: string | null;
    operationType: string;
    operationSummary: string;
    operationPayload?: Record<string, unknown> | null;
    batchId?: string | null;
    idempotencyScopeKey?: string | null;
    idempotencyKey?: string | null;
    requestFingerprint?: string | null;
    messageId?: string | null;
    runId?: string | null;
    sourceArtifactId?: string | null;
    sourceBaseRevision?: number | null;
    suppressDependencyPropagation?: boolean;
    updateWorkingCopyId?: string;
    assertAuthorizedBeforeCommit: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord; noOp: boolean }> {
    const normalizedRel = normalizeRelPath(params.relPath);
    const stagingDir = this.blobManager.getUserStagingDir(params.userId);
    this.assertSameFilesystem(stagingDir, params.rootDir);

    const newSha256 = crypto.createHash('sha256').update(params.newBuffer).digest('hex');
    const depScan = scanArtifactDependencies({
      rootDir: params.rootDir,
      relPath: normalizedRel,
      previewKind: params.previewKind,
      contentBuffer: params.newBuffer,
    });

    // No-Op edit detection (Section 3.2)
    if (
      !params.isCreate &&
      params.expectedPrevSha256 &&
      newSha256 === params.expectedPrevSha256 &&
      depScan.manifestHash === params.prevDepHash
    ) {
      const current = this.db.getArtifact(params.userId, params.artifactId)!;
      return { artifact: current, noOp: true };
    }

    const diffPatch = maybeTextDiff(normalizedRel, params.prevBuffer, params.newBuffer);
    const commitId = crypto.randomUUID();
    const privateStagePath = path.join(stagingDir, `${commitId}.stage`);
    const finalTargetPath = path.join(fs.realpathSync(params.rootDir), ...normalizedRel.split('/'));
    const faultCtx = {
      commitId,
      artifactId: params.artifactId,
      isCreate: params.isCreate,
      privateStagePath,
      finalTargetPath,
    };

    const leases: BlobLease[] = [];
    let stageFileCreated = false;
    let journalInserted = false;

    try {
      // ---- T0: putBlobWithLease for prev_blob, new_blob, and dependency blobs ----
      let prevBlobSha256: string | null = null;
      if (params.prevBuffer) {
        const prevLease = this.blobManager.putBlobWithLease(params.userId, params.prevBuffer);
        leases.push(prevLease);
        prevBlobSha256 = prevLease.sha256;
      }
      const newLease = this.blobManager.putBlobWithLease(params.userId, params.newBuffer);
      leases.push(newLease);
      for (const depBuf of depScan.depBuffers.values()) {
        leases.push(this.blobManager.putBlobWithLease(params.userId, depBuf));
      }

      await this.commitFaultHook?.('before_T1', faultCtx);

      // ---- T1: Persist artifact_commit_journal(state='prepared', stage_ino=NULL) (+ pending_create if create) ----
      const t1Now = Date.now();
      this.db.db.exec('BEGIN IMMEDIATE;');
      try {
        if (params.isCreate) {
          this.db.db
            .prepare(
              `INSERT INTO artifacts (
                 id, user_id, scope_kind, chat_id, project_id, message_id, run_id,
                 rel_path, filename, mime_type, size_bytes, sha256, source, preview_kind,
                 diff_patch, lifecycle_state, deleted_on_disk, revision, dependency_manifest_hash,
                 source_artifact_id, source_base_revision, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_create', 0, 0, ?, ?, ?, ?, ?)`
            )
            .run(
              params.artifactId,
              params.userId,
              params.scopeKind,
              params.chatId,
              params.projectId,
              params.messageId ?? null,
              params.runId ?? null,
              normalizedRel,
              params.filename,
              params.mimeType,
              params.newBuffer.length,
              newSha256,
              params.source,
              params.previewKind,
              diffPatch,
              depScan.manifestHash,
              params.sourceArtifactId ?? null,
              params.sourceBaseRevision ?? null,
              t1Now,
              t1Now
            );
        }

        this.db.db
          .prepare(
            `INSERT INTO artifact_commit_journal (
               commit_id, artifact_id, user_id, chat_id, project_id, scope_kind, rel_path,
               is_create, target_revision, parent_revision, expected_prev_sha256, expected_prev_ino,
               new_sha256, new_dependency_manifest_hash, new_deps_json, new_size_bytes,
               prev_blob_sha256, new_blob_sha256, private_stage_path, stage_ino,
               actor_kind, actor_id, operation_type, operation_summary, operation_payload_json,
               batch_id, idempotency_scope_key, idempotency_key, request_fingerprint, diff_patch,
               state, audit_note, sync_event_seq, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, ?, ?)`
          )
          .run(
            commitId,
            params.artifactId,
            params.userId,
            params.chatId,
            params.projectId,
            params.scopeKind,
            normalizedRel,
            params.isCreate ? 1 : 0,
            params.targetRevision,
            params.parentRevision,
            params.expectedPrevSha256,
            params.expectedPrevFingerprint ? params.expectedPrevFingerprint.ino.toString() : null,
            newSha256,
            depScan.manifestHash,
            JSON.stringify(depScan.deps),
            params.newBuffer.length,
            prevBlobSha256,
            newLease.sha256,
            privateStagePath,
            params.actorKind,
            params.actorId,
            params.operationType,
            params.operationSummary,
            params.operationPayload ? JSON.stringify(params.operationPayload) : null,
            params.batchId ?? null,
            params.idempotencyScopeKey ?? null,
            params.idempotencyKey ?? null,
            params.requestFingerprint ?? null,
            diffPatch,
            t1Now,
            t1Now
          );

        if (params.idempotencyScopeKey && params.idempotencyKey) {
          this.db.db
            .prepare(
              `UPDATE artifact_idempotency
               SET commit_id = ?, updated_at = ?
               WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?`
            )
            .run(commitId, t1Now, params.userId, params.idempotencyScopeKey, params.idempotencyKey);
        }

        this.db.db.exec('COMMIT;');
        journalInserted = true;
      } catch (err) {
        this.db.db.exec('ROLLBACK;');
        throw err;
      }

      await this.commitFaultHook?.('after_T1', faultCtx);
      await this.commitFaultHook?.('before_T2', faultCtx);

      // ---- T2: Write private_stage_path + fchmod + fsync(stageFd) + fsync(stagingDir) + record stage_ino ----
      const stageFd = fs.openSync(
        privateStagePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600
      );
      let stageIno: string;
      try {
        fs.writeFileSync(stageFd, params.newBuffer);
        fs.fchmodSync(stageFd, 0o600);
        fs.fsyncSync(stageFd);
        const st = fs.fstatSync(stageFd, { bigint: true });
        stageIno = st.ino.toString();
        stageFileCreated = true;
      } finally {
        fs.closeSync(stageFd);
      }
      fsyncDir(stagingDir);

      this.db.db
        .prepare('UPDATE artifact_commit_journal SET stage_ino = ?, updated_at = ? WHERE commit_id = ?')
        .run(stageIno, Date.now(), commitId);

      await this.commitFaultHook?.('after_T2', faultCtx);
      await this.commitFaultHook?.('before_T3', faultCtx);

      // ---- T3: Pre-replace disk fingerprint check + assertAuthorizedBeforeCommit (both create & update!) + stage FD hash check -> state='replacing' ----
      await params.assertAuthorizedBeforeCommit();

      if (!params.isCreate && params.expectedPrevFingerprint && params.expectedPrevSha256) {
        const latestDisk = readContainedRegularFileNoFollowStable(params.rootDir, normalizedRel);
        if (
          !fingerprintsMatch(latestDisk.fingerprint, params.expectedPrevFingerprint) ||
          latestDisk.sha256 !== params.expectedPrevSha256
        ) {
          throw new ExternalConcurrentWriteError('保存直前にファイルの外部変更を検出しました。');
        }
      }

      // Verify private_stage_path FD hash matches new_sha256 before promoting to replacing
      const verifyStageFd = fs.openSync(privateStagePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stVerify = fs.fstatSync(verifyStageFd, { bigint: true });
        const hashed = sha256Fd(verifyStageFd);
        if (stVerify.ino.toString() !== stageIno || hashed.sha256 !== newSha256) {
          throw new ArtifactError('STAGE_INTEGRITY_MISMATCH', 'ステージングファイルの整合性検証に失敗しました。', 409);
        }
      } finally {
        fs.closeSync(verifyStageFd);
      }

      this.db.db
        .prepare("UPDATE artifact_commit_journal SET state = 'replacing', updated_at = ? WHERE commit_id = ?")
        .run(Date.now(), commitId);

      await this.commitFaultHook?.('after_T3', faultCtx);
      await this.commitFaultHook?.('before_T4', faultCtx);

      // ---- T4: Atomic placement via O_NOFOLLOW verified parent directory ----
      const segments = normalizedRel.split('/');
      const leafName = segments.pop()!;
      const parentRel = segments.join('/');
      const { dirFd, absDirPath } = ensureContainedDirectoryNoFollow(params.rootDir, parentRel, {
        createMissing: true,
      });
      const verifiedTargetViaProc = `/proc/self/fd/${dirFd}/${leafName}`;
      try {
        if (params.isCreate) {
          try {
            // link(2) atomically fails with EEXIST if file already exists
            fs.linkSync(privateStagePath, verifiedTargetViaProc);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
              throw artifactConflictError('指定パスにすでにファイルが存在します。', { relPath: normalizedRel });
            }
            throw err;
          }
          fs.fsyncSync(dirFd);
          // Non-isolated post-placement check (SEC-10)
          if (this.getStagingIsolation() === 'non_isolated_same_uid') {
            this.verifyPostPlacementOrQuarantine(
              commitId,
              params.artifactId,
              params.userId,
              params.idempotencyScopeKey ?? null,
              params.idempotencyKey ?? null,
              true,
              params.rootDir,
              normalizedRel,
              stageIno,
              newSha256
            );
          }
          fs.unlinkSync(privateStagePath);
          stageFileCreated = false;
          fsyncDir(stagingDir);
        } else {
          fs.renameSync(privateStagePath, verifiedTargetViaProc);
          stageFileCreated = false;
          fs.fsyncSync(dirFd);
          fsyncDir(stagingDir);
          if (this.getStagingIsolation() === 'non_isolated_same_uid') {
            this.verifyPostPlacementOrQuarantine(
              commitId,
              params.artifactId,
              params.userId,
              params.idempotencyScopeKey ?? null,
              params.idempotencyKey ?? null,
              false,
              params.rootDir,
              normalizedRel,
              stageIno,
              newSha256
            );
          }
        }
      } finally {
        fs.closeSync(dirFd);
        void absDirPath;
      }

      await this.commitFaultHook?.('after_T4', faultCtx);
      await this.commitFaultHook?.('before_T5', faultCtx);

      // ---- T5: Persist state='file_replaced' ----
      this.db.db
        .prepare("UPDATE artifact_commit_journal SET state = 'file_replaced', updated_at = ? WHERE commit_id = ?")
        .run(Date.now(), commitId);

      await this.commitFaultHook?.('after_T5', faultCtx);
      await this.commitFaultHook?.('before_T6', faultCtx);

      // ---- T6: Single BEGIN IMMEDIATE transaction committing DB + revisions + deps + idempotency + outbox ----
      const journalObj: ArtifactCommitJournalRow = {
        commitId,
        artifactId: params.artifactId,
        userId: params.userId,
        chatId: params.chatId,
        projectId: params.projectId,
        scopeKind: params.scopeKind,
        relPath: normalizedRel,
        isCreate: params.isCreate,
        targetRevision: params.targetRevision,
        parentRevision: params.parentRevision,
        expectedPrevSha256: params.expectedPrevSha256,
        expectedPrevIno: params.expectedPrevFingerprint ? params.expectedPrevFingerprint.ino.toString() : null,
        newSha256,
        newDependencyManifestHash: depScan.manifestHash,
        newDeps: depScan.deps,
        newSizeBytes: params.newBuffer.length,
        prevBlobSha256,
        newBlobSha256: newLease.sha256,
        privateStagePath,
        stageIno,
        actorKind: params.actorKind,
        actorId: params.actorId,
        operationType: params.operationType,
        operationSummary: params.operationSummary,
        operationPayloadJson: params.operationPayload ? JSON.stringify(params.operationPayload) : null,
        batchId: params.batchId ?? null,
        idempotencyScopeKey: params.idempotencyScopeKey ?? null,
        idempotencyKey: params.idempotencyKey ?? null,
        requestFingerprint: params.requestFingerprint ?? null,
        diffPatch,
        state: 'file_replaced',
        auditNote: null,
        syncEventSeq: null,
        createdAt: t1Now,
        updatedAt: Date.now(),
      };

      let committedArtifact!: ArtifactRecord;
      let envelopes: SyncEventEnvelope[] = [];
      this.db.db.exec('BEGIN IMMEDIATE;');
      try {
        const res = this.finalizeStageT6InTx(journalObj, {
          suppressDependencyPropagation: params.suppressDependencyPropagation,
          extraArtifactFields: {
            filename: params.filename,
            mimeType: params.mimeType,
            previewKind: params.previewKind,
            source: params.source,
            messageId: params.messageId,
            runId: params.runId,
            sourceArtifactId: params.sourceArtifactId,
            sourceBaseRevision: params.sourceBaseRevision,
          },
          updateWorkingCopyId: params.updateWorkingCopyId,
        });
        committedArtifact = res.artifact;
        envelopes = res.envelopes;
        this.db.db.exec('COMMIT;');
      } catch (err) {
        this.db.db.exec('ROLLBACK;');
        throw err;
      }

      await this.commitFaultHook?.('after_T6', faultCtx);
      await this.commitFaultHook?.('before_T7', faultCtx);

      // ---- T7: Broadcast persisted outbox events and remove completed journal ----
      for (const env of envelopes) {
        this.hub.broadcastPersistedEvent(env);
      }
      this.db.db.prepare('DELETE FROM artifact_commit_journal WHERE commit_id = ?').run(commitId);

      await this.commitFaultHook?.('after_T7', faultCtx);

      this.notifyUpdateListeners(committedArtifact);
      return { artifact: committedArtifact, noOp: false };
    } catch (err) {
      // If we failed cleanly BEFORE replacing (journal is still 'prepared'), clean up stage & abort
      if (journalInserted && !this.commitFaultHook) {
        const row = this.db.db
          .prepare('SELECT state FROM artifact_commit_journal WHERE commit_id = ?')
          .get(commitId) as { state: string } | undefined;
        if (row?.state === 'prepared') {
          if (stageFileCreated) {
            try {
              fs.unlinkSync(privateStagePath);
            } catch {
              // ignore
            }
          }
          this.db.db.exec('BEGIN IMMEDIATE;');
          try {
            if (params.isCreate) {
              this.db.db
                .prepare("DELETE FROM artifacts WHERE id = ? AND lifecycle_state = 'pending_create'")
                .run(params.artifactId);
            }
            this.db.db
              .prepare("UPDATE artifact_commit_journal SET state = 'aborted', updated_at = ? WHERE commit_id = ?")
              .run(Date.now(), commitId);
            this.db.db.exec('COMMIT;');
          } catch {
            this.db.db.exec('ROLLBACK;');
          }
        }
      }
      throw err;
    } finally {
      for (const l of leases) l.release();
    }
  }

  private verifyPostPlacementOrQuarantine(
    commitId: string,
    artifactId: string,
    userId: string,
    idempotencyScopeKey: string | null,
    idempotencyKey: string | null,
    isCreate: boolean,
    rootDir: string,
    relPath: string,
    expectedIno: string,
    expectedSha256: string
  ): void {
    let ok = false;
    try {
      const opened = openContainedRegularFileNoFollow(rootDir, relPath, { allowHardlinks: isCreate });
      try {
        const hashed = sha256Fd(opened.fd);
        ok = opened.stat.ino.toString() === expectedIno && hashed.sha256 === expectedSha256;
      } finally {
        fs.closeSync(opened.fd);
      }
    } catch {
      ok = false;
    }

    if (!ok) {
      const now = Date.now();
      this.db.db.exec('BEGIN IMMEDIATE;');
      try {
        if (isCreate) {
          this.db.db
            .prepare("DELETE FROM artifacts WHERE id = ? AND lifecycle_state = 'pending_create'")
            .run(artifactId);
        }
        if (idempotencyScopeKey && idempotencyKey) {
          this.db.db
            .prepare(
              `UPDATE artifact_idempotency
               SET status = 'ambiguous_quarantined', updated_at = ?
               WHERE user_id = ? AND scope_key = ? AND idempotency_key = ?`
            )
            .run(now, userId, idempotencyScopeKey, idempotencyKey);
        }
        this.db.db
          .prepare(
            "UPDATE artifact_commit_journal SET state = 'ambiguous_quarantined', audit_note = 'post_placement_hash_mismatch_non_isolated', updated_at = ? WHERE commit_id = ?"
          )
          .run(now, commitId);
        this.db.db.exec('COMMIT;');
      } catch (err) {
        this.db.db.exec('ROLLBACK;');
        throw err;
      }
      throw new ArtifactError(
        'ARTIFACT_AMBIGUOUS_QUARANTINED',
        '配置直後の整合性検証で異常を検出したため隔離しました。',
        409
      );
    }
  }

  // =========================================================================
  // Public Gateway Methods (ALL mutations & ingestions pass through here)
  // =========================================================================

  async createArtifact(params: {
    userId: string;
    scopeKind: ArtifactScopeKind;
    chatId?: string | null;
    projectId?: string | null;
    relPath: string;
    filename?: string;
    mimeType?: string | null;
    content?: Buffer;
    createParams?: Record<string, unknown>;
    source?: ArtifactRecord['source'];
    messageId?: string | null;
    runId?: string | null;
    sourceArtifactId?: string | null;
    sourceBaseRevision?: number | null;
    actorKind: ActorKind;
    actorId?: string | null;
    idempotencyKey?: string;
    operationSummary?: string;
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord; noOp: boolean }> {
    const scopeId = params.scopeKind === 'chat' ? params.chatId ?? '' : params.projectId ?? '';
    const relPath = normalizeRelPath(params.relPath);
    const filename = params.filename ?? path.basename(relPath);
    const detected = detectMimeAndPreviewKind(filename, params.mimeType);
    const scopeKey = `create:${params.scopeKind}:${scopeId}`;

    const reverifyAuth = async () => {
      const rootDir = this.resolveScopeRootDir(
        params.userId,
        params.scopeKind,
        params.chatId ?? null,
        params.projectId ?? null
      );
      if (!rootDir) {
        throw new ArtifactError('NOT_FOUND', '対象のチャットまたはプロジェクトが見つからないか権限がありません。', 404);
      }
      await params.assertAuthorized?.();
    };

    const contentBuf =
      params.content !== undefined
        ? params.content
        : (() => {
            const adapter = this.registry.resolve(filename, detected.previewKind);
            if (!adapter.create) {
              throw unsupportedOperationError(
                'create',
                adapter.requiresExternalWorker ? 'disabled_by_resource_tier' : 'unsupported_by_format',
                `形式 '${adapter.format}' の新規作成はこの環境ではサポートされていません。`
              );
            }
            return adapter.create(params.createParams ?? {}, {
              filename,
              relPath,
              mimeType: detected.mimeType,
            });
          })();

    const fingerprint = computeRequestFingerprint({
      actorKind: params.actorKind,
      actorId: params.actorId ?? null,
      operationType: 'create',
      target: { scopeKind: params.scopeKind, scopeId, relPath },
      operations: { sha256: crypto.createHash('sha256').update(contentBuf).digest('hex') },
      baseRevision: 0,
    });

    const result = await this.idempotency.execute<{ artifact: ArtifactRecord; noOp: boolean }>({
      userId: params.userId,
      scopeKey,
      idempotencyKey: params.idempotencyKey,
      actorKind: params.actorKind,
      actorId: params.actorId ?? null,
      fingerprint,
      reverifyAuth,
      run: async () => {
        const pathLockKey = `path:${params.userId}:${params.scopeKind}:${scopeId}:${relPath}`;
        const out = await this.lockManager.withLock(pathLockKey, async () => {
          const rootDir = this.resolveScopeRootDir(
            params.userId,
            params.scopeKind,
            params.chatId ?? null,
            params.projectId ?? null
          );
          if (!rootDir) throw new ArtifactError('NOT_FOUND', '対象スコープが見つかりません。', 404);

          const existing =
            params.scopeKind === 'chat' && params.chatId
              ? this.db.findArtifactByRelPath(params.userId, params.chatId, relPath)
              : params.scopeKind === 'project' && params.projectId
                ? this.db.findProjectArtifactByRelPath(params.userId, params.projectId, relPath)
                : null;
          if (existing) {
            throw artifactConflictError('同一パスの成果物がすでに存在します。', {
              artifactId: existing.id,
              currentRevision: existing.revision,
            });
          }

          const artifactId = crypto.randomUUID();
          return this.commitFileMutation({
            userId: params.userId,
            scopeKind: params.scopeKind,
            chatId: params.scopeKind === 'chat' ? (params.chatId ?? null) : null,
            projectId: params.scopeKind === 'project' ? (params.projectId ?? null) : null,
            rootDir,
            relPath,
            filename,
            mimeType: detected.mimeType,
            previewKind: detected.previewKind,
            source:
              params.source ??
              (params.scopeKind === 'project'
                ? 'project_upload'
                : params.actorKind === 'ai'
                  ? 'mcp'
                  : 'user_edit'),
            isCreate: true,
            artifactId,
            parentRevision: null,
            targetRevision: 1,
            expectedPrevSha256: null,
            expectedPrevFingerprint: null,
            prevBuffer: null,
            prevDepHash: null,
            newBuffer: contentBuf,
            actorKind: params.actorKind,
            actorId: params.actorId ?? null,
            operationType: 'create',
            operationSummary: params.operationSummary ?? `Created ${filename}`,
            idempotencyScopeKey: params.idempotencyKey ? scopeKey : null,
            idempotencyKey: params.idempotencyKey ?? null,
            requestFingerprint: fingerprint,
            messageId: params.messageId,
            runId: params.runId,
            sourceArtifactId: params.sourceArtifactId,
            sourceBaseRevision: params.sourceBaseRevision,
            assertAuthorizedBeforeCommit: reverifyAuth,
          });
        });
        return {
          result: out,
          alreadyCommittedInTx: !out.noOp,
          artifactId: out.artifact.id,
          committedRevision: out.artifact.revision,
          noOp: out.noOp,
        };
      },
    });

    if (!result.noOp) {
      await this.drainDepPropagationQueue();
    }
    return result;
  }

  /**
   * Unified ingestion for files already created/updated on disk inside a chat workspace (ACP / link-resolver / inline assets).
   * Records content blobs, dependency manifests, and revisions inside `ArtifactService`.
   */
  ingestWorkspaceFile(params: {
    userId: string;
    chatId: string;
    workspaceDir: string;
    relPath: string;
    absPath?: string;
    filename?: string;
    mimeType?: string | null;
    previewKind?: ArtifactRecord['previewKind'];
    source?: ArtifactRecord['source'];
    messageId?: string | null;
    runId?: string | null;
    diffPatch?: string | null;
    sourceArtifactId?: string | null;
    sourceBaseRevision?: number | null;
    emitEvent?: boolean;
  }): { artifact: ArtifactRecord; created: boolean; changed: boolean } {
    const existing = this.db.findArtifactByRelPath(params.userId, params.chatId, params.relPath);
    const filename =
      existing?.source === 'attachment'
        ? existing.filename
        : params.filename ?? existing?.filename ?? path.basename(params.relPath);
    const detected = params.mimeType
      ? detectMimeAndPreviewKind(filename, params.mimeType)
      : existing
        ? { mimeType: existing.mimeType, previewKind: existing.previewKind }
        : detectMimeAndPreviewKind(filename);
    const mimeType = params.mimeType && existing?.source !== 'attachment' ? params.mimeType : detected.mimeType;
    const previewKind = params.previewKind ?? detected.previewKind;

    let buf: Buffer;
    let sha256: string;
    let sizeBytes: number;
    let mtimeMs = Date.now();
    if (params.absPath) {
      const st = fs.statSync(params.absPath);
      buf = fs.readFileSync(params.absPath);
      sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      sizeBytes = st.size;
      mtimeMs = st.mtimeMs;
    } else {
      const read = readContainedRegularFileNoFollowStable(params.workspaceDir, params.relPath);
      buf = read.buffer;
      sha256 = read.sha256;
      sizeBytes = read.sizeBytes;
      mtimeMs = Number(read.fingerprint.mtimeNs / 1_000_000n);
    }

    const depScan = !path.isAbsolute(params.relPath)
      ? scanArtifactDependencies({
          rootDir: params.workspaceDir,
          relPath: params.relPath,
          previewKind,
          contentBuffer: buf,
        })
      : { deps: [], depBuffers: new Map<string, Buffer>(), manifestHash: null };

    const contentChanged =
      !existing ||
      existing.sha256 !== sha256 ||
      existing.dependencyManifestHash !== depScan.manifestHash ||
      existing.sizeBytes !== sizeBytes;
    const metaChanged =
      !existing ||
      existing.filename !== filename ||
      existing.mimeType !== mimeType ||
      existing.previewKind !== previewKind ||
      (params.messageId && existing.messageId !== params.messageId);

    if (existing && !contentChanged && !metaChanged) {
      return { artifact: existing, created: false, changed: false };
    }

    const leases: BlobLease[] = [];
    try {
      const mainLease = this.blobManager.putBlobWithLease(params.userId, buf);
      leases.push(mainLease);
      for (const depBuf of depScan.depBuffers.values()) {
        leases.push(this.blobManager.putBlobWithLease(params.userId, depBuf));
      }

      const now = Math.max(Date.now(), Math.ceil(mtimeMs));
      const nextRev = existing ? (contentChanged ? existing.revision + 1 : existing.revision) : 1;
      const artifactId = existing?.id ?? crypto.randomUUID();
      let envelope: SyncEventEnvelope | null = null;

      this.db.db.exec('BEGIN IMMEDIATE;');
      try {
        const saved = this.db.upsertArtifact({
          id: artifactId,
          userId: params.userId,
          scopeKind: 'chat',
          chatId: params.chatId,
          projectId: null,
          messageId: params.messageId ?? existing?.messageId ?? null,
          runId: params.runId ?? existing?.runId ?? null,
          relPath: params.relPath,
          filename,
          mimeType,
          sizeBytes,
          sha256,
          source:
            params.source ??
            existing?.source ??
            (params.relPath.startsWith('.project-context/') ? 'project_copy' : 'generated'),
          previewKind,
          diffPatch: params.diffPatch ?? null,
          revision: nextRev,
          dependencyManifestHash: depScan.manifestHash,
          sourceArtifactId: params.sourceArtifactId ?? existing?.sourceArtifactId ?? null,
          sourceBaseRevision: params.sourceBaseRevision ?? existing?.sourceBaseRevision ?? null,
          minUpdatedAt: now,
        });

        if (!existing || contentChanged) {
          this.db.db
            .prepare(
              `INSERT OR IGNORE INTO artifact_revisions (
                 id, artifact_id, user_id, chat_id, project_id, revision, parent_revision,
                 sha256, dependency_manifest_hash, size_bytes, blob_sha256, blob_available,
                 actor_kind, actor_id, operation_type, operation_summary, diff_patch, created_at
               ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, 'ai', NULL, ?, ?, ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              saved.id,
              params.userId,
              params.chatId,
              nextRev,
              existing ? existing.revision : null,
              sha256,
              depScan.manifestHash,
              sizeBytes,
              mainLease.sha256,
              existing ? 'workspace_sync' : 'create',
              existing ? `Workspace updated ${filename}` : `Generated ${filename}`,
              params.diffPatch ?? null,
              now
            );

          for (const dep of depScan.deps) {
            this.db.db
              .prepare(
                `INSERT OR REPLACE INTO artifact_revision_deps (
                   artifact_id, revision, user_id, scope_kind, chat_id, project_id,
                   rel_path, status, sha256, blob_sha256, size_bytes, mime_type
                 ) VALUES (?, ?, ?, 'chat', ?, NULL, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                saved.id,
                nextRev,
                params.userId,
                params.chatId,
                dep.relPath,
                dep.status,
                dep.sha256,
                dep.blobSha256,
                dep.sizeBytes,
                dep.mimeType
              );
          }

          if (!path.isAbsolute(params.relPath)) {
            this.db.db
              .prepare(
                `INSERT INTO artifact_dep_propagation_queue (
                   id, user_id, scope_kind, chat_id, project_id, changed_rel_path,
                   source_artifact_id, source_revision, batch_id, exclude_artifact_ids_json, state, created_at, updated_at
                 ) VALUES (?, ?, 'chat', ?, NULL, ?, ?, ?, NULL, '[]', 'pending', ?, ?)`
              )
              .run(
                crypto.randomUUID(),
                params.userId,
                params.chatId,
                params.relPath,
                saved.id,
                nextRev,
                now,
                now
              );
          }
        }

        if (params.emitEvent) {
          envelope = this.db.insertSyncEventInTx({
            userId: params.userId,
            eventId: crypto.randomUUID(),
            type: existing ? 'artifact.updated' : 'artifact.created',
            chatId: params.chatId,
            runId: params.runId ?? null,
            payload: { artifact: saved },
            createdAt: now,
          });
        }

        this.db.db.exec('COMMIT;');
      } catch (err) {
        this.db.db.exec('ROLLBACK;');
        throw err;
      }

      const finalArt = this.db.getArtifact(params.userId, artifactId)!;
      if (envelope) this.hub.broadcastPersistedEvent(envelope);
      if (contentChanged) {
        this.notifyUpdateListeners(finalArt);
        void this.drainDepPropagationQueue();
      }
      return { artifact: finalArt, created: !existing, changed: contentChanged };
    } finally {
      for (const l of leases) l.release();
    }
  }

  /**
   * Upload chat attachment via ArtifactService (replaces direct fs.writeFile + db.upsertArtifact in chat-routes.ts).
   */
  private lastAttachmentTs = 0;

  async uploadChatAttachment(params: {
    userId: string;
    chatId: string;
    filename: string;
    mimeType?: string | null;
    buffer: Buffer;
  }): Promise<ArtifactRecord> {
    const safeName = sanitizeFileName(params.filename || 'attachment.bin');
    const ts = Math.max(Date.now(), this.lastAttachmentTs + 1);
    this.lastAttachmentTs = ts;
    const relPath = `attachments/${ts}-${safeName}`;
    const res = await this.createArtifact({
      userId: params.userId,
      scopeKind: 'chat',
      chatId: params.chatId,
      relPath,
      filename: safeName,
      mimeType: params.mimeType,
      content: params.buffer,
      source: 'attachment',
      actorKind: 'user',
      actorId: params.userId,
      operationSummary: `Uploaded attachment ${safeName}`,
    });
    return res.artifact;
  }

  /**
   * Upload or update a project file via ArtifactService (unifies project_files & artifacts).
   */
  async uploadProjectFile(params: {
    userId: string;
    projectId: string;
    filename: string;
    mimeType?: string | null;
    buffer: Buffer;
    idempotencyKey?: string;
  }): Promise<{ artifact: ArtifactRecord; file: ProjectFileRecord }> {
    const project = this.db.getProject(params.userId, params.projectId);
    if (!project) {
      throw new ArtifactError('NOT_FOUND', 'プロジェクトが見つかりません。', 404);
    }
    fs.mkdirSync(project.storageDir, { recursive: true, mode: 0o700 });
    const safeName = sanitizeFileName(params.filename || 'file.bin');
    const relPath = normalizeRelPath(safeName);
    const existing = this.db.findProjectArtifactByRelPath(params.userId, params.projectId, relPath);

    let artifact: ArtifactRecord;
    if (!existing) {
      const created = await this.createArtifact({
        userId: params.userId,
        scopeKind: 'project',
        projectId: params.projectId,
        relPath,
        filename: safeName,
        mimeType: params.mimeType,
        content: params.buffer,
        source: 'project_upload',
        actorKind: 'user',
        actorId: params.userId,
        idempotencyKey: params.idempotencyKey,
        operationSummary: `Uploaded project file ${safeName}`,
      });
      artifact = created.artifact;
    } else {
      const updated = await this.replaceArtifactBytes({
        userId: params.userId,
        artifactId: existing.id,
        expectedRevision: existing.revision,
        newBuffer: params.buffer,
        actorKind: 'user',
        actorId: params.userId,
        operationType: 'project_upload_overwrite',
        operationSummary: `Updated project file ${safeName}`,
        idempotencyKey: params.idempotencyKey,
      });
      artifact = updated.artifact;
    }

    const file = this.db
      .listProjectFiles(params.userId, params.projectId)
      .find((f) => f.relPath === relPath)!;
    return { artifact, file };
  }

  async deleteProjectFile(params: {
    userId: string;
    projectId: string;
    fileId: string;
  }): Promise<{ deleted: ProjectFileRecord; project: ReturnType<AppDatabase['getProject']> & { files: ProjectFileRecord[] } }> {
    const project = this.db.getProject(params.userId, params.projectId);
    if (!project) {
      throw new ArtifactError('NOT_FOUND', 'プロジェクトが見つかりません。', 404);
    }
    const existingPf = this.db.getProjectFileById(params.userId, params.projectId, params.fileId);
    if (!existingPf) {
      throw new ArtifactError('NOT_FOUND', 'ファイルが見つかりません。', 404);
    }

    const lockKey = existingPf.artifactId
      ? `artifact:${existingPf.artifactId}`
      : `path:${params.userId}:project:${params.projectId}:${existingPf.relPath}`;

    let envelopes: SyncEventEnvelope[] = [];
    await this.lockManager.withLock(lockKey, async () => {
      // Remove disk file safely via O_NOFOLLOW parent dir
      try {
        const segments = normalizeRelPath(existingPf.relPath).split('/');
        const leaf = segments.pop()!;
        const { dirFd } = ensureContainedDirectoryNoFollow(project.storageDir, segments.join('/'), {
          createMissing: false,
        });
        try {
          fs.unlinkSync(`/proc/self/fd/${dirFd}/${leaf}`);
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        // ignore if already absent on disk
      }

      const now = Date.now();
      this.db.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.db
          .prepare('DELETE FROM project_files WHERE id = ? AND user_id = ?')
          .run(existingPf.id, params.userId);
        if (existingPf.artifactId) {
          this.db.db
            .prepare("UPDATE artifacts SET lifecycle_state = 'deleted', deleted_on_disk = 1, updated_at = ? WHERE id = ? AND user_id = ?")
            .run(now, existingPf.artifactId, params.userId);
          this.db.db
            .prepare(
              `INSERT INTO artifact_dep_propagation_queue (
                 id, user_id, scope_kind, chat_id, project_id, changed_rel_path,
                 source_artifact_id, source_revision, batch_id, exclude_artifact_ids_json, state, created_at, updated_at
               ) VALUES (?, ?, 'project', NULL, ?, ?, ?, 0, NULL, '[]', 'pending', ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              params.userId,
              params.projectId,
              existingPf.relPath,
              existingPf.artifactId,
              now,
              now
            );
        }
        this.db.db
          .prepare('UPDATE projects SET context_version = context_version + 1, updated_at = ? WHERE id = ? AND user_id = ?')
          .run(now, params.projectId, params.userId);

        const latestProj = this.db.getProject(params.userId, params.projectId)!;
        envelopes.push(
          this.db.insertSyncEventInTx({
            userId: params.userId,
            eventId: crypto.randomUUID(),
            type: 'project.updated',
            projectId: params.projectId,
            payload: {
              project: {
                ...latestProj,
                files: this.db.listProjectFiles(params.userId, params.projectId),
              },
            },
            createdAt: now,
          })
        );
        this.db.db.exec('COMMIT;');
      } catch (err) {
        this.db.db.exec('ROLLBACK;');
        throw err;
      }
    });

    for (const env of envelopes) this.hub.broadcastPersistedEvent(env);
    await this.drainDepPropagationQueue();

    const latest = this.db.getProject(params.userId, params.projectId)!;
    return {
      deleted: existingPf,
      project: { ...latest, files: this.db.listProjectFiles(params.userId, params.projectId) },
    };
  }

  async copyArtifactToProject(params: {
    userId: string;
    artifactId: string;
    projectId: string;
    targetFilename?: string;
    srcAbsPathOverride?: string;
  }): Promise<{ artifact: ArtifactRecord; file: ProjectFileRecord }> {
    const srcArtifact = this.db.getArtifact(params.userId, params.artifactId);
    if (!srcArtifact) {
      throw new ArtifactError('ARTIFACT_NOT_FOUND', 'コピー元の成果物が見つかりません。', 404);
    }
    const buf = params.srcAbsPathOverride
      ? fs.readFileSync(params.srcAbsPathOverride)
      : this.readActiveArtifactBytes(srcArtifact);
    if (!buf) {
      throw new ArtifactError('FILE_MISSING', 'コピー元ファイルが見つかりません。', 404);
    }
    return this.uploadProjectFile({
      userId: params.userId,
      projectId: params.projectId,
      filename: params.targetFilename ?? srcArtifact.filename,
      mimeType: srcArtifact.mimeType,
      buffer: buf,
    });
  }

  /**
   * Creates or refreshes a chat working copy `.project-context/<relPath>` from a project original artifact,
   * recording `source_artifact_id` and `source_base_revision` (`PIN-03`, `NEG-10`).
   */
  async createProjectWorkingCopyInChat(params: {
    userId: string;
    projectId: string;
    projectArtifactId: string;
    chatId: string;
  }): Promise<{ artifact: ArtifactRecord }> {
    const project = this.db.getProject(params.userId, params.projectId);
    const chat = this.db.getChat(params.userId, params.chatId);
    if (!project || !chat) {
      throw new ArtifactError('NOT_FOUND', 'プロジェクトまたはチャットが見つかりません。', 404);
    }
    const projArt = this.db.getArtifact(params.userId, params.projectArtifactId);
    if (!projArt || projArt.scopeKind !== 'project' || projArt.projectId !== params.projectId) {
      throw new ArtifactError('NOT_FOUND', 'プロジェクト原本ファイルが見つかりません。', 404);
    }
    const read = readContainedRegularFileNoFollowStable(project.storageDir, projArt.relPath);
    const workingRelPath = normalizeRelPath(`.project-context/${projArt.relPath}`);
    const existingWorkingCopy = this.db.findArtifactByRelPath(params.userId, params.chatId, workingRelPath);

    if (!existingWorkingCopy) {
      const created = await this.createArtifact({
        userId: params.userId,
        scopeKind: 'chat',
        chatId: params.chatId,
        relPath: workingRelPath,
        filename: projArt.filename,
        mimeType: projArt.mimeType,
        content: read.buffer,
        source: 'project_copy',
        sourceArtifactId: projArt.id,
        sourceBaseRevision: projArt.revision,
        actorKind: 'user',
        actorId: params.userId,
        operationSummary: `Created chat working copy of project file ${projArt.relPath}`,
      });
      return { artifact: created.artifact };
    }

    const updated = await this.replaceArtifactBytes({
      userId: params.userId,
      artifactId: existingWorkingCopy.id,
      expectedRevision: existingWorkingCopy.revision,
      newBuffer: read.buffer,
      actorKind: 'user',
      actorId: params.userId,
      operationType: 'project_sync',
      operationSummary: `Refreshed working copy from project rev ${projArt.revision}`,
      sourceArtifactId: projArt.id,
      sourceBaseRevision: projArt.revision,
    });
    return { artifact: updated.artifact };
  }

  /**
   * Synchronizes all project files into chat `.project-context/` via ArtifactService.
   */
  async syncProjectFilesToChat(params: {
    userId: string;
    projectId: string;
    chatId: string;
  }): Promise<string[]> {
    const project = this.db.getProject(params.userId, params.projectId);
    const chat = this.db.getChat(params.userId, params.chatId);
    if (!project || !chat) {
      throw new ArtifactError('NOT_FOUND', 'プロジェクトまたはチャットが見つかりません。', 404);
    }

    const projectFiles = this.db.listProjectFiles(params.userId, params.projectId);
    const expectedRels = new Set(projectFiles.map((f) => normalizeRelPath(`.project-context/${f.relPath}`)));

    // Clean removed files inside .project-context
    const contextDir = path.join(chat.workspaceDir, '.project-context');
    if (fs.existsSync(contextDir)) {
      const walkRemove = (dir: string, prefix = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walkRemove(full, rel);
          } else if (entry.isFile()) {
            const wsRel = `.project-context/${rel}`;
            if (!expectedRels.has(wsRel)) {
              fs.rmSync(full, { force: true });
              const oldArt = this.db.findArtifactByRelPath(params.userId, params.chatId, wsRel);
              if (oldArt) {
                this.db.db
                  .prepare("UPDATE artifacts SET lifecycle_state = 'deleted', deleted_on_disk = 1, updated_at = ? WHERE id = ?")
                  .run(Date.now(), oldArt.id);
              }
            }
          }
        }
      };
      walkRemove(contextDir);
    }

    const syncedPaths: string[] = [];
    for (const pf of projectFiles) {
      let projArt = pf.artifactId ? this.db.getArtifact(params.userId, pf.artifactId) : null;
      if (!projArt) {
        projArt = this.db.findProjectArtifactByRelPath(params.userId, params.projectId, pf.relPath);
      }
      if (!projArt) continue;

      const workingRelPath = normalizeRelPath(`.project-context/${pf.relPath}`);
      try {
        const read = readContainedRegularFileNoFollowStable(project.storageDir, pf.relPath);
        const existing = this.db.findArtifactByRelPath(params.userId, params.chatId, workingRelPath);
        if (!existing) {
          await this.createArtifact({
            userId: params.userId,
            scopeKind: 'chat',
            chatId: params.chatId,
            relPath: workingRelPath,
            filename: pf.filename,
            mimeType: pf.mimeType,
            content: read.buffer,
            source: 'project_copy',
            sourceArtifactId: projArt.id,
            sourceBaseRevision: projArt.revision,
            actorKind: 'system',
            actorId: null,
            operationSummary: `Synced project file ${pf.relPath}`,
          });
        } else if (existing.sha256 !== read.sha256 || existing.sourceBaseRevision !== projArt.revision) {
          // Ensure disk file reflects updated project original and record revision
          await this.replaceArtifactBytes({
            userId: params.userId,
            artifactId: existing.id,
            expectedRevision: existing.revision,
            newBuffer: read.buffer,
            actorKind: 'system',
            actorId: null,
            operationType: 'project_sync',
            operationSummary: `Synced project file ${pf.relPath} (rev ${projArt.revision})`,
            sourceArtifactId: projArt.id,
            sourceBaseRevision: projArt.revision,
          });
        }
        syncedPaths.push(workingRelPath);
      } catch {
        // skip missing project source on disk
      }
    }
    return syncedPaths;
  }

  /**
   * Reflects a chat working copy back to its source project original artifact (`PIN-03`, `NEG-10`).
   * Strictly checks `expectedProjectRevision` (defaulting to `workingCopy.sourceBaseRevision`) against
   * the current project original revision; rejects with `409 ARTIFACT_CONFLICT` if the project original
   * was modified or deleted since the working copy was created/synced!
   */
  async reflectWorkingCopyToProject(params: {
    userId: string;
    workingCopyArtifactId: string;
    expectedProjectRevision?: number;
    actorKind: ActorKind;
    actorId?: string | null;
    idempotencyKey?: string;
  }): Promise<{ projectArtifact: ArtifactRecord; workingCopy: ArtifactRecord }> {
    if (params.actorKind === 'ai') {
      throw new ArtifactError('FORBIDDEN', '内蔵MCPまたはAIからプロジェクト原本へ直接反映することは禁止されています。', 403);
    }

    const workingCopy = this.db.getArtifact(params.userId, params.workingCopyArtifactId);
    if (!workingCopy || workingCopy.scopeKind !== 'chat') {
      throw new ArtifactError('NOT_FOUND', '作業コピー成果物が見つかりません。', 404);
    }
    if (!workingCopy.sourceArtifactId || workingCopy.sourceBaseRevision === null) {
      throw new ArtifactError('NOT_A_PROJECT_WORKING_COPY', 'この成果物はプロジェクト原本の作業コピーではありません。', 400);
    }

    const projectArtifactId = workingCopy.sourceArtifactId;
    const expectedProjRev = params.expectedProjectRevision ?? workingCopy.sourceBaseRevision;

    const projectOriginal = this.db.getArtifact(params.userId, projectArtifactId);
    if (!projectOriginal || projectOriginal.scopeKind !== 'project' || !projectOriginal.projectId) {
      throw artifactConflictError('反映先のプロジェクト原本が削除されているため反映できません。', {
        conflictKind: 'project_original_deleted',
        sourceArtifactId: projectArtifactId,
        expectedProjectRevision: expectedProjRev,
      });
    }

    if (projectOriginal.revision !== expectedProjRev) {
      throw artifactConflictError(
        `作業コピー作成後にプロジェクト原本が更新されています（基準版: ${expectedProjRev}, 最新版: ${projectOriginal.revision}）。差分を確認してください。`,
        {
          conflictKind: 'project_original_modified',
          sourceArtifactId: projectOriginal.id,
          expectedProjectRevision: expectedProjRev,
          currentProjectRevision: projectOriginal.revision,
          currentProjectSha256: projectOriginal.sha256,
        }
      );
    }

    const workingBuf = this.readActiveArtifactBytes(workingCopy);
    if (!workingBuf) {
      throw new ArtifactError('FILE_MISSING', '作業コピーのファイル実体が見つかりません。', 404);
    }

    const res = await this.replaceArtifactBytes({
      userId: params.userId,
      artifactId: projectOriginal.id,
      expectedRevision: expectedProjRev,
      newBuffer: workingBuf,
      actorKind: 'user',
      actorId: params.actorId ?? params.userId,
      operationType: 'reflect_from_chat_working_copy',
      operationSummary: `Reflected changes from chat working copy ${workingCopy.id}`,
      idempotencyKey: params.idempotencyKey,
      updateWorkingCopyId: workingCopy.id,
    });

    const updatedWorkingCopy = this.db.getArtifact(params.userId, workingCopy.id)!;
    return {
      projectArtifact: res.artifact,
      workingCopy: updatedWorkingCopy,
    };
  }

  /**
   * Low-level locked byte replacement for an existing artifact with expectedRevision check and T0..T7 durability.
   */
  async replaceArtifactBytes(params: {
    userId: string;
    artifactId: string;
    expectedRevision: number;
    newBuffer: Buffer;
    actorKind: ActorKind;
    actorId: string | null;
    operationType: string;
    operationSummary: string;
    operationPayload?: Record<string, unknown> | null;
    batchId?: string | null;
    suppressDependencyPropagation?: boolean;
    idempotencyKey?: string;
    sourceArtifactId?: string | null;
    sourceBaseRevision?: number | null;
    updateWorkingCopyId?: string;
    alreadyLocked?: boolean;
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord; noOp: boolean }> {
    const scopeKey = `artifact:${params.artifactId}`;
    const reverifyAuth = async () => {
      const art = this.db.getArtifact(params.userId, params.artifactId);
      if (!art) throw new ArtifactError('NOT_FOUND', '対象の成果物が見つからないか権限がありません。', 404);
      if (params.actorKind === 'ai' && art.scopeKind === 'project') {
        throw new ArtifactError('FORBIDDEN', 'AI/内蔵MCPからプロジェクト原本への書き込みは禁止されています。', 403);
      }
      await params.assertAuthorized?.();
    };

    const fingerprint = computeRequestFingerprint({
      actorKind: params.actorKind,
      actorId: params.actorId,
      operationType: params.operationType,
      target: { artifactId: params.artifactId },
      operations: { sha256: crypto.createHash('sha256').update(params.newBuffer).digest('hex') },
      baseRevision: params.expectedRevision,
    });

    const executeLocked = async () => {
      let current = this.db.getArtifact(params.userId, params.artifactId);
      if (!current) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
      if (params.actorKind === 'ai' && current.scopeKind === 'project') {
        throw new ArtifactError('FORBIDDEN', 'AI/内蔵MCPからプロジェクト原本への書き込みは禁止されています。', 403);
      }
      current = this.ensureLegacyHistoryMigrated(current);

      const rootDir = this.resolveScopeRootDir(current.userId, current.scopeKind, current.chatId, current.projectId);
      if (!rootDir) throw new ArtifactError('NOT_FOUND', '作業ディレクトリが見つかりません。', 404);

      // Read current disk state with single O_NOFOLLOW FD stability check
      let prevRead: ReturnType<typeof readContainedRegularFileNoFollowStable> | null = null;
      try {
        prevRead = readContainedRegularFileNoFollowStable(rootDir, current.relPath);
      } catch (err) {
        if (err instanceof ExternalConcurrentWriteError) throw err;
        prevRead = null;
      }

      // If disk diverged externally before edit started, ingest external_sync first
      if (prevRead && prevRead.sha256 !== current.sha256) {
        this.recordExternalSyncOnRecovery({
          userId: params.userId,
          artifactId: current.id,
          rootDir,
          relPath: current.relPath,
        });
        current = this.db.getArtifact(params.userId, params.artifactId)!;
      }

      if (current.revision !== params.expectedRevision) {
        throw artifactConflictError(
          `成果物の版が競合しています（期待: ${params.expectedRevision}, 現在: ${current.revision}）。`,
          {
            artifactId: current.id,
            expectedRevision: params.expectedRevision,
            currentRevision: current.revision,
            currentSha256: current.sha256,
          }
        );
      }

      return this.commitFileMutation({
        userId: params.userId,
        scopeKind: current.scopeKind,
        chatId: current.chatId,
        projectId: current.projectId,
        rootDir,
        relPath: current.relPath,
        filename: current.filename,
        mimeType: current.mimeType,
        previewKind: current.previewKind,
        source: current.source,
        isCreate: false,
        artifactId: current.id,
        parentRevision: current.revision,
        targetRevision: current.revision + 1,
        expectedPrevSha256: prevRead?.sha256 ?? current.sha256,
        expectedPrevFingerprint: prevRead?.fingerprint ?? null,
        prevBuffer: prevRead?.buffer ?? null,
        prevDepHash: current.dependencyManifestHash,
        newBuffer: params.newBuffer,
        actorKind: params.actorKind,
        actorId: params.actorId,
        operationType: params.operationType,
        operationSummary: params.operationSummary,
        operationPayload: params.operationPayload,
        batchId: params.batchId,
        idempotencyScopeKey: params.idempotencyKey ? scopeKey : null,
        idempotencyKey: params.idempotencyKey ?? null,
        requestFingerprint: fingerprint,
        sourceArtifactId: params.sourceArtifactId ?? current.sourceArtifactId,
        sourceBaseRevision: params.sourceBaseRevision ?? current.sourceBaseRevision,
        suppressDependencyPropagation: params.suppressDependencyPropagation,
        updateWorkingCopyId: params.updateWorkingCopyId,
        assertAuthorizedBeforeCommit: reverifyAuth,
      });
    };

    const outcome = await this.idempotency.execute<{ artifact: ArtifactRecord; noOp: boolean }>({
      userId: params.userId,
      scopeKey,
      idempotencyKey: params.idempotencyKey,
      actorKind: params.actorKind,
      actorId: params.actorId,
      fingerprint,
      reverifyAuth,
      run: async () => {
        const out = params.alreadyLocked
          ? await executeLocked()
          : await this.lockManager.withLock(`artifact:${params.artifactId}`, executeLocked);
        return {
          result: out,
          alreadyCommittedInTx: !out.noOp,
          artifactId: out.artifact.id,
          committedRevision: out.artifact.revision,
          noOp: out.noOp,
        };
      },
    });

    if (!outcome.noOp && !params.suppressDependencyPropagation) {
      await this.drainDepPropagationQueue();
    }
    return outcome;
  }

  /**
   * High-level format-adapter edit / batch-edit with verification and T0..T7 persistence.
   */
  async editArtifact(params: {
    userId: string;
    artifactId: string;
    expectedRevision: number;
    operations: AdapterOperation[];
    actorKind: ActorKind;
    actorId?: string | null;
    idempotencyKey?: string;
    operationSummary?: string;
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord; noOp: boolean; summary: string }> {
    const scopeKey = `artifact:${params.artifactId}`;
    const reverifyAuth = async () => {
      const art = this.db.getArtifact(params.userId, params.artifactId);
      if (!art) throw new ArtifactError('NOT_FOUND', '成果物が見つからないか権限がありません。', 404);
      if (params.actorKind === 'ai' && art.scopeKind === 'project') {
        throw new ArtifactError('FORBIDDEN', 'AI/内蔵MCPからプロジェクト原本への書き込みは禁止されています。', 403);
      }
      await params.assertAuthorized?.();
    };

    const fingerprint = computeRequestFingerprint({
      actorKind: params.actorKind,
      actorId: params.actorId ?? null,
      operationType: params.operations.length > 1 ? 'batch_edit' : 'edit',
      target: { artifactId: params.artifactId },
      operations: params.operations,
      baseRevision: params.expectedRevision,
    });

    const outcome = await this.idempotency.execute<{ artifact: ArtifactRecord; noOp: boolean; summary: string }>({
      userId: params.userId,
      scopeKey,
      idempotencyKey: params.idempotencyKey,
      actorKind: params.actorKind,
      actorId: params.actorId ?? null,
      fingerprint,
      reverifyAuth,
      run: async () => {
        const out = await this.lockManager.withLock(`artifact:${params.artifactId}`, async () => {
          let current = this.db.getArtifact(params.userId, params.artifactId);
          if (!current) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
          if (params.actorKind === 'ai' && current.scopeKind === 'project') {
            throw new ArtifactError('FORBIDDEN', 'AI/内蔵MCPからプロジェクト原本への書き込みは禁止されています。', 403);
          }
          current = this.ensureLegacyHistoryMigrated(current);

          const rootDir = this.resolveScopeRootDir(current.userId, current.scopeKind, current.chatId, current.projectId);
          if (!rootDir) throw new ArtifactError('NOT_FOUND', '作業ディレクトリが見つかりません。', 404);

          const prevRead = readContainedRegularFileNoFollowStable(rootDir, current.relPath);
          if (prevRead.sha256 !== current.sha256) {
            this.recordExternalSyncOnRecovery({
              userId: params.userId,
              artifactId: current.id,
              rootDir,
              relPath: current.relPath,
            });
            current = this.db.getArtifact(params.userId, params.artifactId)!;
          }

          if (current.revision !== params.expectedRevision) {
            throw artifactConflictError(
              `成果物の版が競合しています（期待: ${params.expectedRevision}, 現在: ${current.revision}）。`,
              {
                artifactId: current.id,
                expectedRevision: params.expectedRevision,
                currentRevision: current.revision,
                currentSha256: current.sha256,
              }
            );
          }

          const adapter = this.registry.resolve(current.filename, current.previewKind);
          const editResult = adapter.applyOperations(prevRead.buffer, params.operations, {
            filename: current.filename,
            relPath: current.relPath,
            mimeType: current.mimeType,
          });

          const committed = await this.commitFileMutation({
            userId: params.userId,
            scopeKind: current.scopeKind,
            chatId: current.chatId,
            projectId: current.projectId,
            rootDir,
            relPath: current.relPath,
            filename: current.filename,
            mimeType: current.mimeType,
            previewKind: current.previewKind,
            source: current.source,
            isCreate: false,
            artifactId: current.id,
            parentRevision: current.revision,
            targetRevision: current.revision + 1,
            expectedPrevSha256: prevRead.sha256,
            expectedPrevFingerprint: prevRead.fingerprint,
            prevBuffer: prevRead.buffer,
            prevDepHash: current.dependencyManifestHash,
            newBuffer: editResult.buffer,
            actorKind: params.actorKind,
            actorId: params.actorId ?? null,
            operationType: params.operations.length > 1 ? 'batch_edit' : 'edit',
            operationSummary: params.operationSummary ?? editResult.summary,
            operationPayload: {
              semanticScope: editResult.semanticScope ?? null,
              operations: params.operations,
            },
            idempotencyScopeKey: params.idempotencyKey ? scopeKey : null,
            idempotencyKey: params.idempotencyKey ?? null,
            requestFingerprint: fingerprint,
            assertAuthorizedBeforeCommit: reverifyAuth,
          });

          return {
            artifact: committed.artifact,
            noOp: committed.noOp,
            summary: editResult.summary,
          };
        });
        return {
          result: out,
          alreadyCommittedInTx: !out.noOp,
          artifactId: out.artifact.id,
          committedRevision: out.artifact.revision,
          noOp: out.noOp,
        };
      },
    });

    if (!outcome.noOp) {
      await this.drainDepPropagationQueue();
    }
    return outcome;
  }

  getCapabilities(userId: string, artifactId: string): ArtifactCapabilitiesResponse {
    const artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    return this.registry.buildCapabilitiesResponse({
      filename: artifact.filename,
      previewKind: artifact.previewKind,
      runtimeProfile: this.governor.getRuntimeProfile(),
      sandboxIsolation: this.sandboxWorker.getIsolationStatus(),
      stagingIsolation: this.getStagingIsolation(),
    });
  }

  getStructure(userId: string, artifactId: string): Record<string, unknown> {
    const artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    const buf = this.readActiveArtifactBytes(artifact);
    if (!buf) throw new ArtifactError('FILE_MISSING', 'ファイル実体が見つかりません。', 404);
    const adapter = this.registry.resolve(artifact.filename, artifact.previewKind);
    return {
      artifactId: artifact.id,
      revision: artifact.revision,
      sha256: artifact.sha256,
      ...adapter.getStructure(buf, {
        filename: artifact.filename,
        relPath: artifact.relPath,
        mimeType: artifact.mimeType,
      }),
    };
  }

  readRange(userId: string, artifactId: string, range: Record<string, unknown>): Record<string, unknown> {
    const artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    const buf = this.readActiveArtifactBytes(artifact);
    if (!buf) throw new ArtifactError('FILE_MISSING', 'ファイル実体が見つかりません。', 404);
    const adapter = this.registry.resolve(artifact.filename, artifact.previewKind);
    return {
      artifactId: artifact.id,
      revision: artifact.revision,
      ...adapter.readRange(buf, range, {
        filename: artifact.filename,
        relPath: artifact.relPath,
        mimeType: artifact.mimeType,
      }),
    };
  }

  verifyArtifact(userId: string, artifactId: string): AdapterVerifyResult {
    const artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    const buf = this.readActiveArtifactBytes(artifact);
    if (!buf) throw new ArtifactError('FILE_MISSING', 'ファイル実体が見つかりません。', 404);
    const adapter = this.registry.resolve(artifact.filename, artifact.previewKind);
    return adapter.verify(buf, {
      filename: artifact.filename,
      relPath: artifact.relPath,
      mimeType: artifact.mimeType,
    });
  }

  async exportArtifact(params: {
    userId: string;
    artifactId: string;
    targetFormat: string;
    outputRelPath?: string;
    actorKind: ActorKind;
    actorId?: string | null;
    idempotencyKey?: string;
  }): Promise<{ artifact: ArtifactRecord; exported: AdapterExportResult }> {
    const src = this.db.getArtifact(params.userId, params.artifactId);
    if (!src) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    if (params.actorKind === 'ai' && src.scopeKind === 'project') {
      throw new ArtifactError('FORBIDDEN', 'AI/内蔵MCPからプロジェクト原本スコープへのエクスポートは禁止されています。', 403);
    }
    const buf = this.readActiveArtifactBytes(src);
    if (!buf) throw new ArtifactError('FILE_MISSING', 'ファイル実体が見つかりません。', 404);
    const adapter = this.registry.resolve(src.filename, src.previewKind);
    if (!adapter.exportAs) {
      throw unsupportedOperationError(
        `export:${params.targetFormat}`,
        adapter.requiresExternalWorker ? 'disabled_by_resource_tier' : 'unsupported_by_format',
        `形式 '${adapter.format}' から '${params.targetFormat}' への変換はサポートされていません。`
      );
    }
    const exported = adapter.exportAs(buf, params.targetFormat, {
      filename: src.filename,
      relPath: src.relPath,
      mimeType: src.mimeType,
    });
    const outRelPath = params.outputRelPath ? normalizeRelPath(params.outputRelPath) : normalizeRelPath(exported.filename);
    const created = await this.createArtifact({
      userId: params.userId,
      scopeKind: src.scopeKind,
      chatId: src.chatId,
      projectId: src.projectId,
      relPath: outRelPath,
      filename: path.basename(outRelPath),
      mimeType: exported.mimeType,
      content: exported.buffer,
      actorKind: params.actorKind,
      actorId: params.actorId ?? null,
      idempotencyKey: params.idempotencyKey,
      operationSummary: `Exported ${src.filename} to ${params.targetFormat}`,
    });
    return { artifact: created.artifact, exported };
  }

  resolveTargetOnArtifact(
    userId: string,
    artifactId: string,
    selector: TargetSelector
  ): TargetResolutionResult {
    const artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    const adapter = this.registry.resolve(artifact.filename, artifact.previewKind);
    if (!adapter.targetPinSupported) {
      throw unsupportedOperationError('target_pin', 'unsupported_by_format', `形式 '${adapter.format}' は対象指定に対応していません。`);
    }
    const buf = this.readActiveArtifactBytes(artifact);
    if (!buf) return { status: 'stale', reason: 'artifact_file_missing' };
    return adapter.resolveTarget(buf, selector, {
      filename: artifact.filename,
      relPath: artifact.relPath,
      mimeType: artifact.mimeType,
    });
  }

  listHistory(userId: string, artifactId: string): ArtifactRevisionRecord[] {
    let artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    artifact = this.ensureLegacyHistoryMigrated(artifact);
    return this.undoService.listRevisionsAsc(userId, artifact.id).reverse();
  }

  getRevisionContentBlob(userId: string, artifactId: string, revision: number): {
    artifact: ArtifactRecord;
    revision: ArtifactRevisionRecord;
    blobPath: string;
    sizeBytes: number;
  } {
    let artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    artifact = this.ensureLegacyHistoryMigrated(artifact);
    const revs = this.undoService.listRevisionsAsc(userId, artifact.id);
    const rev = revs.find((r) => r.revision === revision);
    if (!rev) throw new ArtifactError('NOT_FOUND', `Revision ${revision} が見つかりません。`, 404);
    if (!rev.blobAvailable || !rev.blobSha256) {
      throw new ArtifactError(
        'REVISION_SNAPSHOT_UNAVAILABLE',
        `Revision ${revision} のスナップショットは保持されていません。`,
        422
      );
    }
    const blobPath = this.blobManager.getBlobPath(userId, rev.blobSha256);
    if (!fs.existsSync(blobPath)) {
      throw new ArtifactError(
        'REVISION_SNAPSHOT_UNAVAILABLE',
        `Revision ${revision} のブロブが見つかりません。`,
        422
      );
    }
    const st = fs.statSync(blobPath);
    return { artifact, revision: rev, blobPath, sizeBytes: st.size };
  }

  async restoreRevision(params: {
    userId: string;
    artifactId: string;
    targetRevision: number;
    actorKind: ActorKind;
    actorId?: string | null;
    idempotencyKey?: string;
    batchId?: string | null;
    suppressDependencyPropagation?: boolean;
    alreadyLocked?: boolean;
  }): Promise<{ artifact: ArtifactRecord; dependencyDiff: Array<{ relPath: string; targetSha256: string | null; currentSha256: string | null }> }> {
    let artifact = this.db.getArtifact(params.userId, params.artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    if (params.actorKind === 'ai' && artifact.scopeKind === 'project') {
      throw new ArtifactError('FORBIDDEN', 'AI/内蔵MCPからプロジェクト原本を復元することは禁止されています。', 403);
    }
    artifact = this.ensureLegacyHistoryMigrated(artifact);

    const revRow = this.db.db
      .prepare(
        `SELECT blob_sha256, blob_available
         FROM artifact_revisions
         WHERE artifact_id = ? AND user_id = ? AND revision = ?`
      )
      .get(artifact.id, params.userId, params.targetRevision) as
      | { blob_sha256: string | null; blob_available: number }
      | undefined;

    if (!revRow) {
      throw new ArtifactError('NOT_FOUND', `Revision ${params.targetRevision} が見つかりません。`, 404);
    }
    if (!revRow.blob_available || !revRow.blob_sha256) {
      throw new ArtifactError(
        'REVISION_SNAPSHOT_UNAVAILABLE',
        `Revision ${params.targetRevision} のスナップショットは復元できません。`,
        422
      );
    }

    const blobBuf = this.blobManager.readBlob(params.userId, revRow.blob_sha256);
    if (!blobBuf) {
      throw new ArtifactError(
        'REVISION_SNAPSHOT_UNAVAILABLE',
        `Revision ${params.targetRevision} のスナップショットブロブが利用できません。`,
        422
      );
    }

    // Compute dependency diff between target revision and current revision
    const targetDeps = this.db.db
      .prepare('SELECT rel_path, sha256 FROM artifact_revision_deps WHERE artifact_id = ? AND revision = ?')
      .all(artifact.id, params.targetRevision) as Array<{ rel_path: string; sha256: string | null }>;
    const currentDeps = this.db.db
      .prepare('SELECT rel_path, sha256 FROM artifact_revision_deps WHERE artifact_id = ? AND revision = ?')
      .all(artifact.id, artifact.revision) as Array<{ rel_path: string; sha256: string | null }>;
    const curMap = new Map(currentDeps.map((d) => [d.rel_path, d.sha256]));
    const dependencyDiff = targetDeps
      .filter((td) => curMap.get(td.rel_path) !== td.sha256)
      .map((td) => ({
        relPath: td.rel_path,
        targetSha256: td.sha256,
        currentSha256: curMap.get(td.rel_path) ?? null,
      }));

    const res = await this.replaceArtifactBytes({
      userId: params.userId,
      artifactId: artifact.id,
      expectedRevision: artifact.revision,
      newBuffer: blobBuf,
      actorKind: params.actorKind,
      actorId: params.actorId ?? null,
      operationType: 'restore',
      operationSummary: `Restored from revision ${params.targetRevision}`,
      operationPayload: { restoredFromRevision: params.targetRevision },
      batchId: params.batchId ?? null,
      suppressDependencyPropagation: params.suppressDependencyPropagation,
      idempotencyKey: params.idempotencyKey,
      alreadyLocked: params.alreadyLocked,
    });

    return { artifact: res.artifact, dependencyDiff };
  }

  async restoreBundle(params: {
    userId: string;
    parentArtifactId: string;
    targetRevision: number;
    sharedPolicy?: 'overwrite_shared' | 'skip_shared';
    actorKind: ActorKind;
    actorId?: string | null;
    failAfterCommittedCountForTest?: number;
  }): Promise<ArtifactRestoreBatchRecord> {
    const parent = this.db.getArtifact(params.userId, params.parentArtifactId);
    if (!parent) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    if (params.actorKind === 'ai' && parent.scopeKind === 'project') {
      throw new ArtifactError('FORBIDDEN', 'AI/内蔵MCPからプロジェクト原本の一括復元は禁止されています。', 403);
    }

    return executeRestoreBundle(
      {
        db: this.db,
        blobManager: this.blobManager,
        lockManager: this.lockManager,
        restoreSingleArtifactLocked: (p) => this.restoreRevision(p),
        drainDepPropagationQueue: () => this.drainDepPropagationQueue(),
      },
      {
        userId: params.userId,
        parentArtifactId: params.parentArtifactId,
        targetRevision: params.targetRevision,
        sharedPolicy: params.sharedPolicy ?? 'overwrite_shared',
        actorKind: params.actorKind,
        actorId: params.actorId ?? null,
        failAfterCommittedCountForTest: params.failAfterCommittedCountForTest,
      }
    );
  }

  getRestoreBatch(userId: string, batchId: string): ArtifactRestoreBatchRecord | null {
    return getRestoreBatchRecord(this.db, userId, batchId);
  }

  getUndoState(userId: string, artifactId: string, actorKind: ActorKind, actorId: string | null): UndoStateSummary {
    let artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    artifact = this.ensureLegacyHistoryMigrated(artifact);
    const format = detectArtifactFormat(artifact.filename, artifact.previewKind);
    return this.undoService.getUndoState({ userId, artifactId: artifact.id, format, actorKind, actorId });
  }

  async undo(params: {
    userId: string;
    artifactId: string;
    actorKind: ActorKind;
    actorId: string | null;
    idempotencyKey?: string;
  }): Promise<{ artifact: ArtifactRecord; undoState: UndoStateSummary }> {
    let artifact = this.db.getArtifact(params.userId, params.artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    artifact = this.ensureLegacyHistoryMigrated(artifact);
    const format = detectArtifactFormat(artifact.filename, artifact.previewKind);
    const plan = this.undoService.planUndo({
      userId: params.userId,
      artifactId: artifact.id,
      format,
      actorKind: params.actorKind,
      actorId: params.actorId,
    });
    const buf = this.blobManager.readBlob(params.userId, plan.restoreBlobSha256);
    if (!buf) {
      throw new ArtifactError('UNDO_HISTORY_PRUNED', '履歴スナップショットが利用できません。', 422, {
        reason: 'history_pruned',
      });
    }
    const res = await this.replaceArtifactBytes({
      userId: params.userId,
      artifactId: artifact.id,
      expectedRevision: artifact.revision,
      newBuffer: buf,
      actorKind: params.actorKind,
      actorId: params.actorId,
      operationType: 'undo',
      operationSummary: `Undo revision ${plan.undoneRevision} (to rev ${plan.restoreFromRevision})`,
      operationPayload: { undoOfRevision: plan.undoneRevision, restoredFromRevision: plan.restoreFromRevision },
      idempotencyKey: params.idempotencyKey,
    });
    return {
      artifact: res.artifact,
      undoState: this.getUndoState(params.userId, artifact.id, params.actorKind, params.actorId),
    };
  }

  async redo(params: {
    userId: string;
    artifactId: string;
    actorKind: ActorKind;
    actorId: string | null;
    idempotencyKey?: string;
  }): Promise<{ artifact: ArtifactRecord; undoState: UndoStateSummary }> {
    let artifact = this.db.getArtifact(params.userId, params.artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    artifact = this.ensureLegacyHistoryMigrated(artifact);
    const format = detectArtifactFormat(artifact.filename, artifact.previewKind);
    const plan = this.undoService.planRedo({
      userId: params.userId,
      artifactId: artifact.id,
      format,
      actorKind: params.actorKind,
      actorId: params.actorId,
    });
    const buf = this.blobManager.readBlob(params.userId, plan.restoreBlobSha256);
    if (!buf) {
      throw new ArtifactError('REDO_HISTORY_PRUNED', 'やり直し対象のスナップショットが利用できません。', 422, {
        reason: 'history_pruned',
      });
    }
    const res = await this.replaceArtifactBytes({
      userId: params.userId,
      artifactId: artifact.id,
      expectedRevision: artifact.revision,
      newBuffer: buf,
      actorKind: params.actorKind,
      actorId: params.actorId,
      operationType: 'redo',
      operationSummary: `Redo revision ${plan.restoreFromRevision}`,
      operationPayload: { redoOfRevision: plan.restoreFromRevision },
      idempotencyKey: params.idempotencyKey,
    });
    return {
      artifact: res.artifact,
      undoState: this.getUndoState(params.userId, artifact.id, params.actorKind, params.actorId),
    };
  }
}
