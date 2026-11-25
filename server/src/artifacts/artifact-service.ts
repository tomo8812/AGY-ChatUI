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
  listContainedFilesNoFollow,
  normalizeRelPath,
  openContainedRegularFileNoFollow,
  readContainedRegularFileNoFollowStable,
  removeContainedSubtreeNoFollow,
  sanitizeFileName,
  sha256Fd,
  unlinkContainedRegularFileNoFollow,
  type FileFingerprint,
} from '../files/workspace.js';
import type { SyncHub } from '../sync/hub.js';
import type {
  ArtifactRecord,
  ArtifactScopeKind,
  ProjectFileRecord,
  SyncEventEnvelope,
} from '../types.js';
import { DOCUMENT_WORKER_MAX_INPUT_BYTES, DocumentWorker, isDocumentFormat, isWebRenderFormat } from './document-worker.js';
import { detectArtifactFormat, DOCUMENT_ACTIONS, FormatAdapterRegistry } from './adapters/registry.js';
import { executeRestoreBundle, getRestoreBatchRecord, recoverPendingRestoreBatches } from './batch-restore.js';
import { PerUserBlobManager, type BlobLease } from './blob-store.js';
import { recoverPendingCommits, type DeleteTargetInspection, type RecoveryReport } from './commit-recovery.js';
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
const MAX_SUBTREE_SNAPSHOT_ENTRIES = 20_000;
const MAX_SUBTREE_HASH_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SUBTREE_HASH_TOTAL_BYTES = 64 * 1024 * 1024;

interface DeleteFileTargetIdentity {
  existedAtT1: boolean;
  dev: string | null;
  ino: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  mtimeNs: string | null;
  ctimeNs: string | null;
}

interface DeleteSubtreeEntryIdentity {
  relPath: string;
  kind: 'file' | 'dir' | 'other';
  dev: string;
  ino: string;
  sizeBytes?: number | null;
  sha256?: string | null;
  mtimeNs?: string | null;
  ctimeNs?: string | null;
}

interface DeleteSubtreeSnapshot {
  existedAtT1: boolean;
  rootDev: string | null;
  rootIno: string | null;
  rootMtimeNs: string | null;
  rootCtimeNs: string | null;
  captureComplete: boolean;
  entries: DeleteSubtreeEntryIdentity[];
}

type DeleteJournalPayload =
  | {
      kind: 'delete_project_file';
      fileId: string;
      storageDir: string;
      relPath: string;
      artifactId: string | null;
      targetIdentity?: DeleteFileTargetIdentity;
    }
  | {
      kind: 'delete_project';
      projectId: string;
      storageDir: string;
      projectSubtreeRel: string | null;
      fileRelPaths: string[];
      artifacts: Array<{ id: string; relPath: string }>;
      subtreeSnapshot?: DeleteSubtreeSnapshot;
    }
  | {
      kind: 'delete_sync_file';
      chatId: string;
      workspaceDir: string;
      relPath: string;
      artifactId: string | null;
      targetIdentity?: DeleteFileTargetIdentity;
    }
  | {
      kind: 'delete_chat';
      chatId: string;
      workspaceDir: string;
      chatSubtreeRel: string | null;
      artifacts: Array<{ id: string; relPath: string }>;
      subtreeSnapshot?: DeleteSubtreeSnapshot;
    };

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
  private readonly documentWorker: DocumentWorker;
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
    this.documentWorker = new DocumentWorker(config, this.governor, this.sandboxWorker);
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
      resolveScopeRootDir: (u, sk, cid, pid) => this.resolveScopeRootDir(u, sk, cid, pid),
      finalizeStageT6InTx: (j, opts) => this.finalizeStageT6InTx(j, opts),
      inspectDeleteTarget: (j) => this.inspectDeleteTarget(j),
      performVerifiedPartialDeleteCleanup: (j) => this.performVerifiedPartialDeleteCleanup(j),
      finalizeDeleteStageT6InTx: (j) => this.finalizeDeleteStageT6InTx(j),
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
      syncExternalChangeLocked: (p) => this.recordExternalSyncOnRecovery(p),
    });
  }

  readActiveArtifactBytes(artifact: ArtifactRecord, maxBytes?: number): Buffer | null {
    const rootDir = this.resolveScopeRootDir(artifact.userId, artifact.scopeKind, artifact.chatId, artifact.projectId);
    if (!rootDir) return null;
    try {
      const res = readContainedRegularFileNoFollowStable(rootDir, artifact.relPath, { maxBytes });
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
  }): boolean {
    const artifact = this.db.getArtifact(params.userId, params.artifactId);
    if (!artifact) return false;

    const now = Date.now();
    try {
      const read = readContainedRegularFileNoFollowStable(params.rootDir, params.relPath);
      const depScan = !path.isAbsolute(params.relPath)
        ? scanArtifactDependencies({
            rootDir: params.rootDir,
            relPath: params.relPath,
            previewKind: artifact.previewKind,
            contentBuffer: read.buffer,
          })
        : { deps: [], depBuffers: new Map<string, Buffer>(), manifestHash: null };

      if (
        read.sha256 === artifact.sha256 &&
        read.sizeBytes === artifact.sizeBytes &&
        depScan.manifestHash === artifact.dependencyManifestHash
      ) {
        return false;
      }

      const leases: BlobLease[] = [];
      try {
        const lease = this.blobManager.putBlobWithLease(params.userId, read.buffer);
        leases.push(lease);
        for (const depBuf of depScan.depBuffers.values()) {
          leases.push(this.blobManager.putBlobWithLease(params.userId, depBuf));
        }

        const nextRev = artifact.revision + 1;
        let env: SyncEventEnvelope;
        this.db.db.exec('BEGIN IMMEDIATE;');
        try {
          this.db.db
            .prepare(
              `UPDATE artifacts
               SET sha256 = ?, size_bytes = ?, revision = ?, dependency_manifest_hash = ?, deleted_on_disk = 0, updated_at = ?
               WHERE id = ? AND user_id = ?`
            )
            .run(read.sha256, read.sizeBytes, nextRev, depScan.manifestHash, now, artifact.id, params.userId);
          this.db.db
            .prepare(
              `INSERT INTO artifact_revisions (
                 id, artifact_id, user_id, chat_id, project_id, revision, parent_revision,
                 sha256, dependency_manifest_hash, size_bytes, blob_sha256, blob_available,
                 actor_kind, actor_id, operation_type, operation_summary, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'system', NULL, 'external_sync', 'External file change synchronized', ?)`
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
              depScan.manifestHash,
              read.sizeBytes,
              lease.sha256,
              now
            );
          for (const dep of depScan.deps) {
            this.db.db
              .prepare(
                `INSERT OR REPLACE INTO artifact_revision_deps (
                   artifact_id, revision, user_id, scope_kind, chat_id, project_id,
                   rel_path, status, sha256, blob_sha256, size_bytes, mime_type
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                artifact.id,
                nextRev,
                params.userId,
                artifact.scopeKind,
                artifact.chatId,
                artifact.projectId,
                dep.relPath,
                dep.status,
                dep.sha256,
                dep.blobSha256,
                dep.sizeBytes,
                dep.mimeType
              );
          }
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
        return true;
      } finally {
        for (const l of leases) l.release();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File disappeared on disk -> mark deleted_on_disk = 1
        this.db.db
          .prepare('UPDATE artifacts SET deleted_on_disk = 1, updated_at = ? WHERE id = ? AND user_id = ?')
          .run(now, artifact.id, params.userId);
      }
      return false;
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

    // Atomically mark batch restore item committed inside the exact same Stage T6 transaction (ARCH-04 / ARCH-07)
    if (journal.batchId) {
      if (journal.batchSeq !== null) {
        this.db.db
          .prepare(
            `UPDATE artifact_restore_batch_items
             SET status = 'committed', committed_revision = ?
             WHERE batch_id = ? AND seq = ?`
          )
          .run(artifact.revision, journal.batchId, journal.batchSeq);
      } else {
        this.db.db
          .prepare(
            `UPDATE artifact_restore_batch_items
             SET status = 'committed', committed_revision = ?
             WHERE batch_id = ? AND artifact_id = ?`
          )
          .run(artifact.revision, journal.batchId, journal.artifactId);
      }
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
    batchSeq?: number | null;
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
    const stagingIsolation = this.getStagingIsolation();

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
      if (params.batchId) {
        this.db.db.exec('BEGIN IMMEDIATE;');
        try {
          if (params.batchSeq !== undefined && params.batchSeq !== null) {
            this.db.db
              .prepare(
                `UPDATE artifact_restore_batch_items
                 SET status = 'committed', committed_revision = ?
                 WHERE batch_id = ? AND seq = ?`
              )
              .run(current.revision, params.batchId, params.batchSeq);
          } else {
            this.db.db
              .prepare(
                `UPDATE artifact_restore_batch_items
                 SET status = 'committed', committed_revision = ?
                 WHERE batch_id = ? AND artifact_id = ?`
              )
              .run(current.revision, params.batchId, current.id);
          }
          this.db.db.exec('COMMIT;');
        } catch (err) {
          this.db.db.exec('ROLLBACK;');
          throw err;
        }
      }
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

      // ---- T1: Persist artifact_commit_journal(state='prepared', stage_ino=NULL, staging_isolation_mode) (+ pending_create if create) ----
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
               batch_id, batch_seq, staging_isolation_mode,
               idempotency_scope_key, idempotency_key, request_fingerprint, diff_patch,
               state, audit_note, sync_event_seq, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, ?, ?)`
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
            params.batchSeq ?? null,
            stagingIsolation,
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
          if (stagingIsolation === 'non_isolated_same_uid') {
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
          if (stagingIsolation === 'non_isolated_same_uid') {
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

      // ---- T6: Single BEGIN IMMEDIATE transaction committing DB + revisions + deps + idempotency + outbox + batch item ----
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
        batchSeq: params.batchSeq ?? null,
        stagingIsolationMode: stagingIsolation,
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

  private readPdfMergeSources(
    userId: string, chatId: string | null | undefined, sourceIds: unknown
  ): Buffer[] {
    if (!chatId || !Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 10 ||
        sourceIds.some((id) => typeof id !== 'string' || !id.length)) {
      throw new ArtifactError('INVALID_PDF_SOURCES', 'Specify one to ten PDF artifacts from this chat.', 422);
    }
    let remaining = DOCUMENT_WORKER_MAX_INPUT_BYTES;
    return sourceIds.map((id) => {
      const artifact = this.db.getArtifact(userId, id);
      if (!artifact || artifact.chatId !== chatId || artifact.previewKind !== 'pdf') {
        throw new ArtifactError('NOT_FOUND', 'A source PDF was not found in this chat.', 404);
      }
      const source = this.readActiveArtifactBytes(artifact, remaining);
      if (!source) throw new ArtifactError('INVALID_PDF_SOURCE', 'A source PDF is missing or exceeds the merge limit.', 422);
      remaining -= source.length;
      return source;
    });
  }

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

    const adapter = this.registry.resolve(filename, detected.previewKind);
    const workerCreateFormat = isDocumentFormat(adapter.format) && adapter.format !== 'media' ? adapter.format : null;
    const createParams = params.createParams ?? {};
    const fileMeta = { filename, relPath, mimeType: detected.mimeType };
    const contentBuf = params.content ?? (!workerCreateFormat ? adapter.create?.(createParams, fileMeta) : undefined);
    if (!contentBuf && !workerCreateFormat) {
      throw unsupportedOperationError('create', 'unsupported_by_format', `Cannot create '${adapter.format}'.`);
    }

    const fingerprint = computeRequestFingerprint({
      actorKind: params.actorKind,
      actorId: params.actorId ?? null,
      operationType: 'create',
      target: { scopeKind: params.scopeKind, scopeId, relPath },
      operations: contentBuf
        ? { sha256: crypto.createHash('sha256').update(contentBuf).digest('hex') }
        : { filename, mimeType: detected.mimeType, createParams },
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

          const mergeSources = !contentBuf && workerCreateFormat === 'pdf' && createParams.sourceArtifactIds !== undefined
            ? this.readPdfMergeSources(params.userId, params.scopeKind === 'chat' ? params.chatId : null, createParams.sourceArtifactIds)
            : [];
          const buffer = workerCreateFormat && !contentBuf
            ? await this.documentWorker.run(workerCreateFormat, filename, undefined, { action: 'create', params: createParams }, mergeSources)
            : contentBuf!;
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
            newBuffer: buffer,
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
   * Serialized per-artifact/path via ArtifactLockManager (`ARCH-03` & Section 3.2) without ever restricting external ACP writes.
   */
  async ingestWorkspaceFile(params: {
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
  }): Promise<{ artifact: ArtifactRecord; created: boolean; changed: boolean }> {
    const pathLockKey = `path:${params.userId}:chat:${params.chatId}:${params.relPath}`;

    const runIngestLocked = async (
      lockedArtifactId: string | null
    ): Promise<{ artifact: ArtifactRecord; created: boolean; changed: boolean } | { retryWithArtifactId: string }> => {
      const existing = this.db.findArtifactByRelPath(params.userId, params.chatId, params.relPath);
      if (existing && lockedArtifactId !== existing.id) {
        return { retryWithArtifactId: existing.id };
      }

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
        }
        return { artifact: finalArt, created: !existing, changed: contentChanged };
      } finally {
        for (const l of leases) l.release();
      }
    };

    const initialExisting = this.db.findArtifactByRelPath(params.userId, params.chatId, params.relPath);
    let targetArtifactId = initialExisting?.id ?? null;
    let outcome: { artifact: ArtifactRecord; created: boolean; changed: boolean } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const lockKeys = targetArtifactId ? [`artifact:${targetArtifactId}`, pathLockKey] : [pathLockKey];
      const res = await this.lockManager.withLocks(lockKeys, () => runIngestLocked(targetArtifactId));
      if ('retryWithArtifactId' in res) {
        targetArtifactId = res.retryWithArtifactId;
        continue;
      }
      outcome = res;
      break;
    }
    if (!outcome) {
      throw new ArtifactError('ARTIFACT_LOCK_CONTENTION', 'ファイル取り込みの排他取得に失敗しました。', 409);
    }
    if (outcome.changed) {
      await this.drainDepPropagationQueue();
    }
    return outcome;
  }

  /**
   * Persist an inline ACP-generated binary/text asset into chat workspace strictly via ArtifactService + ArtifactLockManager.
   */
  async saveInlineGeneratedAsset(params: {
    userId: string;
    chatId: string;
    relPath: string;
    filename: string;
    mimeType: string;
    data: Buffer;
    messageId?: string | null;
    runId?: string | null;
  }): Promise<{ artifact: ArtifactRecord }> {
    const normalizedRel = normalizeRelPath(params.relPath);
    const existing = this.db.findArtifactByRelPath(params.userId, params.chatId, normalizedRel);
    const hash = crypto.createHash('sha256').update(params.data).digest('hex');
    if (existing && existing.sha256 === hash) {
      return { artifact: existing };
    }
    if (existing) {
      const updated = await this.replaceArtifactBytes({
        userId: params.userId,
        artifactId: existing.id,
        expectedRevision: existing.revision,
        newBuffer: params.data,
        actorKind: 'ai',
        actorId: null,
        operationType: 'workspace_sync',
        operationSummary: `Updated generated asset ${params.filename}`,
      });
      return { artifact: updated.artifact };
    }
    try {
      const created = await this.createArtifact({
        userId: params.userId,
        scopeKind: 'chat',
        chatId: params.chatId,
        relPath: normalizedRel,
        filename: params.filename,
        mimeType: params.mimeType,
        content: params.data,
        source: 'generated',
        actorKind: 'ai',
        actorId: null,
        messageId: params.messageId ?? null,
        runId: params.runId ?? null,
        operationSummary: `Generated ${params.filename}`,
      });
      return { artifact: created.artifact };
    } catch (err) {
      // If file already exists on disk (e.g. concurrent same-hash write), ingest it cleanly under ArtifactLockManager
      if (err instanceof ArtifactError && err.statusCode === 409) {
        const chat = this.db.getChat(params.userId, params.chatId);
        if (chat) {
          const ingested = await this.ingestWorkspaceFile({
            userId: params.userId,
            chatId: params.chatId,
            workspaceDir: chat.workspaceDir,
            relPath: normalizedRel,
            filename: params.filename,
            mimeType: params.mimeType,
            source: 'generated',
            messageId: params.messageId ?? null,
            runId: params.runId ?? null,
            emitEvent: false,
          });
          return { artifact: ingested.artifact };
        }
      }
      throw err;
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
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<ArtifactRecord> {
    await params.assertAuthorized?.();
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
      assertAuthorized: params.assertAuthorized,
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
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord; file: ProjectFileRecord }> {
    await params.assertAuthorized?.();
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
        assertAuthorized: params.assertAuthorized,
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
        assertAuthorized: params.assertAuthorized,
      });
      artifact = updated.artifact;
    }

    const file = this.db
      .listProjectFiles(params.userId, params.projectId)
      .find((f) => f.relPath === relPath)!;
    return { artifact, file };
  }

  private parseDeleteJournalPayload(journal: ArtifactCommitJournalRow): DeleteJournalPayload | null {
    if (!journal.operationPayloadJson) return null;
    try {
      const parsed = JSON.parse(journal.operationPayloadJson) as Record<string, unknown>;
      if (
        parsed.kind === 'delete_project_file' ||
        parsed.kind === 'delete_project' ||
        parsed.kind === 'delete_sync_file' ||
        parsed.kind === 'delete_chat'
      ) {
        return parsed as DeleteJournalPayload;
      }
      return null;
    } catch {
      return null;
    }
  }

  private captureFileTargetIdentityNoFollow(rootDir: string, relPath: string): DeleteFileTargetIdentity {
    if (!fs.existsSync(rootDir)) {
      return {
        existedAtT1: false,
        dev: null,
        ino: null,
        sizeBytes: null,
        sha256: null,
        mtimeNs: null,
        ctimeNs: null,
      };
    }
    let opened: ReturnType<typeof openContainedRegularFileNoFollow>;
    try {
      opened = openContainedRegularFileNoFollow(rootDir, relPath, { allowHardlinks: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          existedAtT1: false,
          dev: null,
          ino: null,
          sizeBytes: null,
          sha256: null,
          mtimeNs: null,
          ctimeNs: null,
        };
      }
      throw err;
    }
    try {
      const { sha256 } = sha256Fd(opened.fd);
      return {
        existedAtT1: true,
        dev: opened.stat.dev.toString(),
        ino: opened.stat.ino.toString(),
        sizeBytes: Number(opened.stat.size),
        sha256,
        mtimeNs: opened.stat.mtimeNs.toString(),
        ctimeNs: opened.stat.ctimeNs.toString(),
      };
    } finally {
      fs.closeSync(opened.fd);
    }
  }

  private captureSubtreeSnapshotNoFollow(parentRootDir: string, relSubtreePath: string | null): DeleteSubtreeSnapshot {
    if (!relSubtreePath || relSubtreePath.startsWith('..') || path.isAbsolute(relSubtreePath)) {
      return {
        existedAtT1: false,
        rootDev: null,
        rootIno: null,
        rootMtimeNs: null,
        rootCtimeNs: null,
        captureComplete: false,
        entries: [],
      };
    }
    if (!fs.existsSync(parentRootDir)) {
      return {
        existedAtT1: false,
        rootDev: null,
        rootIno: null,
        rootMtimeNs: null,
        rootCtimeNs: null,
        captureComplete: true,
        entries: [],
      };
    }

    const normalized = normalizeRelPath(relSubtreePath);
    const segments = normalized.split('/');
    const targetName = segments.pop()!;
    const parentRel = segments.join('/');

    let parentFd: number;
    try {
      ({ dirFd: parentFd } = ensureContainedDirectoryNoFollow(parentRootDir, parentRel, { createMissing: false }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          existedAtT1: false,
          rootDev: null,
          rootIno: null,
          rootMtimeNs: null,
          rootCtimeNs: null,
          captureComplete: true,
          entries: [],
        };
      }
      return {
        existedAtT1: true,
        rootDev: null,
        rootIno: null,
        rootMtimeNs: null,
        rootCtimeNs: null,
        captureComplete: false,
        entries: [],
      };
    }

    const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    try {
      const targetPath = `/proc/self/fd/${parentFd}/${targetName}`;
      let rootLst: fs.BigIntStats;
      try {
        rootLst = fs.lstatSync(targetPath, { bigint: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return {
            existedAtT1: false,
            rootDev: null,
            rootIno: null,
            rootMtimeNs: null,
            rootCtimeNs: null,
            captureComplete: true,
            entries: [],
          };
        }
        return {
          existedAtT1: true,
          rootDev: null,
          rootIno: null,
          rootMtimeNs: null,
          rootCtimeNs: null,
          captureComplete: false,
          entries: [],
        };
      }

      if (rootLst.isSymbolicLink() || !rootLst.isDirectory()) {
        return {
          existedAtT1: true,
          rootDev: null,
          rootIno: null,
          rootMtimeNs: null,
          rootCtimeNs: null,
          captureComplete: false,
          entries: [],
        };
      }

      let rootDirFd: number;
      try {
        rootDirFd = fs.openSync(targetPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      } catch {
        return {
          existedAtT1: true,
          rootDev: null,
          rootIno: null,
          rootMtimeNs: null,
          rootCtimeNs: null,
          captureComplete: false,
          entries: [],
        };
      }

      const entries: DeleteSubtreeEntryIdentity[] = [];
      let captureComplete = true;
      let totalHashedBytes = 0;

      try {
        const rootSt = fs.fstatSync(rootDirFd, { bigint: true });
        const walkDir = (dirFd: number, relPrefix: string) => {
          if (!captureComplete) return;
          const dirProc = `/proc/self/fd/${dirFd}`;
          let dirents: fs.Dirent[];
          try {
            dirents = fs.readdirSync(dirProc, { withFileTypes: true });
          } catch {
            captureComplete = false;
            return;
          }
          for (const entry of dirents) {
            if (entries.length >= MAX_SUBTREE_SNAPSHOT_ENTRIES) {
              captureComplete = false;
              return;
            }
            const childPath = `${dirProc}/${entry.name}`;
            const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            let lst: fs.BigIntStats;
            try {
              lst = fs.lstatSync(childPath, { bigint: true });
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
              captureComplete = false;
              return;
            }
            if (lst.isSymbolicLink() || (!lst.isDirectory() && !lst.isFile())) {
              entries.push({
                relPath: childRel,
                kind: 'other',
                dev: lst.dev.toString(),
                ino: lst.ino.toString(),
                mtimeNs: lst.mtimeNs.toString(),
                ctimeNs: lst.ctimeNs.toString(),
              });
              continue;
            }
            if (lst.isDirectory()) {
              let childFd: number;
              try {
                childFd = fs.openSync(childPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
              } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
                captureComplete = false;
                return;
              }
              try {
                const st = fs.fstatSync(childFd, { bigint: true });
                entries.push({
                  relPath: childRel,
                  kind: 'dir',
                  dev: st.dev.toString(),
                  ino: st.ino.toString(),
                });
                walkDir(childFd, childRel);
              } finally {
                try {
                  fs.closeSync(childFd);
                } catch {
                  // ignore
                }
              }
              continue;
            }
            // Regular file
            let fileFd: number;
            try {
              fileFd = fs.openSync(childPath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
              captureComplete = false;
              return;
            }
            try {
              const st = fs.fstatSync(fileFd, { bigint: true });
              if (!st.isFile()) {
                captureComplete = false;
                return;
              }
              const sizeBytes = Number(st.size);
              let sha256: string | null = null;
              if (sizeBytes <= MAX_SUBTREE_HASH_FILE_BYTES && totalHashedBytes + sizeBytes <= MAX_SUBTREE_HASH_TOTAL_BYTES) {
                sha256 = sha256Fd(fileFd).sha256;
                totalHashedBytes += sizeBytes;
              }
              entries.push({
                relPath: childRel,
                kind: 'file',
                dev: st.dev.toString(),
                ino: st.ino.toString(),
                sizeBytes,
                sha256,
                mtimeNs: st.mtimeNs.toString(),
                ctimeNs: st.ctimeNs.toString(),
              });
            } finally {
              try {
                fs.closeSync(fileFd);
              } catch {
                // ignore
              }
            }
          }
        };

        walkDir(rootDirFd, '');
        return {
          existedAtT1: true,
          rootDev: rootSt.dev.toString(),
          rootIno: rootSt.ino.toString(),
          rootMtimeNs: rootSt.mtimeNs.toString(),
          rootCtimeNs: rootSt.ctimeNs.toString(),
          captureComplete,
          entries,
        };
      } finally {
        try {
          fs.closeSync(rootDirFd);
        } catch {
          // ignore
        }
      }
    } finally {
      try {
        fs.closeSync(parentFd);
      } catch {
        // ignore
      }
    }
  }

  private inspectSingleFileDeleteTarget(
    rootDir: string,
    relPath: string,
    targetIdentity: DeleteFileTargetIdentity | undefined,
    journalState: ArtifactCommitJournalRow['state']
  ): DeleteTargetInspection {
    const absentAtT1 = targetIdentity ? !targetIdentity.existedAtT1 : undefined;
    if (!fs.existsSync(rootDir)) {
      return { status: 'deleted', detail: 'root_dir_absent', absentAtT1 };
    }

    let opened: ReturnType<typeof openContainedRegularFileNoFollow>;
    try {
      opened = openContainedRegularFileNoFollow(rootDir, relPath, { allowHardlinks: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { status: 'deleted', detail: 'target_absent', absentAtT1 };
      }
      return { status: 'indeterminate', detail: `target_unreadable_or_non_regular:${code ?? 'containment'}`, absentAtT1 };
    }

    let liveDev: string;
    let liveIno: string;
    let liveSize: number;
    let liveSha256: string;
    let liveMtimeNs: string;
    let liveCtimeNs: string;
    try {
      const { sha256 } = sha256Fd(opened.fd);
      liveDev = opened.stat.dev.toString();
      liveIno = opened.stat.ino.toString();
      liveSize = Number(opened.stat.size);
      liveSha256 = sha256;
      liveMtimeNs = opened.stat.mtimeNs.toString();
      liveCtimeNs = opened.stat.ctimeNs.toString();
    } catch (err) {
      return { status: 'indeterminate', detail: `target_read_error:${(err as NodeJS.ErrnoException).code ?? 'error'}`, absentAtT1 };
    } finally {
      fs.closeSync(opened.fd);
    }

    if (!targetIdentity) {
      return { status: 'indeterminate', detail: 'missing_t1_file_identity' };
    }
    if (!targetIdentity.existedAtT1) {
      return { status: 'externally_recreated', detail: 'absent_at_t1_now_exists', absentAtT1: true };
    }

    const exactMatch =
      liveDev === targetIdentity.dev &&
      liveIno === targetIdentity.ino &&
      liveSize === targetIdentity.sizeBytes &&
      liveSha256 === targetIdentity.sha256 &&
      liveMtimeNs === targetIdentity.mtimeNs &&
      liveCtimeNs === targetIdentity.ctimeNs;

    if (exactMatch) {
      return { status: 'intact', detail: 'exact_t1_file_identity_match', absentAtT1: false };
    }

    if (liveDev !== targetIdentity.dev || liveIno !== targetIdentity.ino) {
      return { status: 'externally_recreated', detail: 'file_dev_ino_changed', absentAtT1: false };
    }

    // Same dev+ino, but content/size/timestamps changed:
    // If T5 ('file_replaced') already confirmed T4 unlinked the original, this reused-inode file is provably a recreation.
    // Otherwise ('replacing'/'prepared'), it is ambiguous between an in-place edit before unlink vs unlink + inode-reused recreate.
    if (journalState === 'file_replaced') {
      return { status: 'externally_recreated', detail: 'post_t5_reused_ino_changed', absentAtT1: false };
    }
    return { status: 'indeterminate', detail: 'same_ino_content_or_timestamp_changed', absentAtT1: false };
  }

  private inspectSubtreeDeleteTarget(
    parentRootDir: string,
    relSubtreePath: string | null,
    snapshot: DeleteSubtreeSnapshot | undefined,
    journalState: ArtifactCommitJournalRow['state']
  ): DeleteTargetInspection {
    const absentAtT1 = snapshot ? !snapshot.existedAtT1 : undefined;
    if (!relSubtreePath || relSubtreePath.startsWith('..') || path.isAbsolute(relSubtreePath)) {
      return { status: 'indeterminate', detail: 'invalid_subtree_rel', absentAtT1 };
    }
    if (!fs.existsSync(parentRootDir)) {
      return { status: 'deleted', detail: 'parent_root_absent', absentAtT1 };
    }

    const normalized = normalizeRelPath(relSubtreePath);
    const segments = normalized.split('/');
    const targetName = segments.pop()!;
    const parentRel = segments.join('/');

    let parentFd: number;
    try {
      ({ dirFd: parentFd } = ensureContainedDirectoryNoFollow(parentRootDir, parentRel, { createMissing: false }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'deleted', detail: 'parent_dir_absent', absentAtT1 };
      }
      return { status: 'indeterminate', detail: 'parent_dir_inaccessible', absentAtT1 };
    }

    try {
      const targetPath = `/proc/self/fd/${parentFd}/${targetName}`;
      let rootLst: fs.BigIntStats;
      try {
        rootLst = fs.lstatSync(targetPath, { bigint: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { status: 'deleted', detail: 'subtree_root_absent', absentAtT1 };
        }
        return { status: 'indeterminate', detail: 'subtree_root_stat_error', absentAtT1 };
      }
      if (rootLst.isSymbolicLink() || !rootLst.isDirectory()) {
        return { status: 'indeterminate', detail: 'subtree_root_not_directory', absentAtT1 };
      }
    } finally {
      try {
        fs.closeSync(parentFd);
      } catch {
        // ignore
      }
    }

    if (!snapshot || !snapshot.captureComplete) {
      return { status: 'indeterminate', detail: 'missing_or_incomplete_t1_subtree_snapshot', absentAtT1 };
    }
    if (!snapshot.existedAtT1) {
      return { status: 'externally_recreated', detail: 'subtree_absent_at_t1_now_exists', absentAtT1: true };
    }

    const live = this.captureSubtreeSnapshotNoFollow(parentRootDir, relSubtreePath);
    if (!live.existedAtT1) {
      return { status: 'deleted', detail: 'subtree_removed_during_scan', absentAtT1: false };
    }
    if (!live.captureComplete) {
      return { status: 'indeterminate', detail: 'live_subtree_scan_incomplete', absentAtT1: false };
    }

    if (live.rootDev !== snapshot.rootDev || live.rootIno !== snapshot.rootIno) {
      return { status: 'externally_recreated', detail: 'subtree_root_dev_ino_changed', absentAtT1: false };
    }

    const t1Map = new Map<string, DeleteSubtreeEntryIdentity>();
    for (const e of snapshot.entries) t1Map.set(e.relPath, e);
    const liveMap = new Map<string, DeleteSubtreeEntryIdentity>();
    for (const e of live.entries) liveMap.set(e.relPath, e);

    let matchedT1 = 0;
    let mismatchedT1 = 0;
    let unexpectedLive = 0;

    for (const [rel, liveE] of liveMap.entries()) {
      const t1E = t1Map.get(rel);
      if (!t1E) {
        unexpectedLive += 1;
        continue;
      }
      if (liveE.kind !== t1E.kind || liveE.dev !== t1E.dev || liveE.ino !== t1E.ino) {
        mismatchedT1 += 1;
        continue;
      }
      if (t1E.kind === 'file') {
        const hashMatches = t1E.sha256 == null || liveE.sha256 === t1E.sha256;
        if (
          liveE.sizeBytes !== t1E.sizeBytes ||
          liveE.mtimeNs !== t1E.mtimeNs ||
          liveE.ctimeNs !== t1E.ctimeNs ||
          !hashMatches
        ) {
          mismatchedT1 += 1;
          continue;
        }
      } else if (t1E.kind === 'other') {
        if (liveE.mtimeNs !== t1E.mtimeNs || liveE.ctimeNs !== t1E.ctimeNs) {
          mismatchedT1 += 1;
          continue;
        }
      }
      matchedT1 += 1;
    }

    const missingT1 = t1Map.size - (matchedT1 + mismatchedT1);

    if (unexpectedLive > 0 || mismatchedT1 > 0) {
      if (matchedT1 === 0) {
        return {
          status: 'externally_recreated',
          detail: `subtree_external_entries(unexpected=${unexpectedLive},mismatched=${mismatchedT1})`,
          absentAtT1: false,
        };
      }
      return {
        status: 'indeterminate',
        detail: `subtree_mixed_entries(matched=${matchedT1},missing=${missingT1},unexpected=${unexpectedLive},mismatched=${mismatchedT1})`,
        absentAtT1: false,
      };
    }

    // Zero unexpected entries and zero mismatched entries
    if (t1Map.size === 0) {
      if (live.rootMtimeNs === snapshot.rootMtimeNs && live.rootCtimeNs === snapshot.rootCtimeNs) {
        return { status: 'intact', detail: 'empty_subtree_root_untouched', absentAtT1: false };
      }
      if (journalState === 'file_replaced') {
        return { status: 'externally_recreated', detail: 'post_t5_empty_subtree_recreated_reused_ino', absentAtT1: false };
      }
      return { status: 'indeterminate', detail: 'empty_subtree_timestamps_changed', absentAtT1: false };
    }

    if (missingT1 === 0) {
      return { status: 'intact', detail: `all_t1_entries_intact(${matchedT1})`, absentAtT1: false };
    }

    if (journalState === 'file_replaced') {
      if (liveMap.size === 0) {
        return { status: 'externally_recreated', detail: 'post_t5_empty_dir_recreated_reused_ino', absentAtT1: false };
      }
      return { status: 'indeterminate', detail: `post_t5_t1_entries_still_present(${matchedT1})`, absentAtT1: false };
    }

    return {
      status: 'partially_deleted',
      detail: `subtree_partial_delete(missing=${missingT1},remaining=${matchedT1})`,
      absentAtT1: false,
    };
  }

  private inspectDeleteTarget(journal: ArtifactCommitJournalRow): DeleteTargetInspection {
    const payload = this.parseDeleteJournalPayload(journal);
    if (!payload) {
      return { status: 'indeterminate', detail: 'missing_or_invalid_delete_payload' };
    }
    if (payload.kind === 'delete_project_file') {
      return this.inspectSingleFileDeleteTarget(payload.storageDir, payload.relPath, payload.targetIdentity, journal.state);
    }
    if (payload.kind === 'delete_sync_file') {
      return this.inspectSingleFileDeleteTarget(payload.workspaceDir, payload.relPath, payload.targetIdentity, journal.state);
    }
    if (payload.kind === 'delete_project') {
      return this.inspectSubtreeDeleteTarget(
        this.config.projectsRoot,
        payload.projectSubtreeRel,
        payload.subtreeSnapshot,
        journal.state
      );
    }
    if (payload.kind === 'delete_chat') {
      return this.inspectSubtreeDeleteTarget(
        this.config.workspacesRoot,
        payload.chatSubtreeRel,
        payload.subtreeSnapshot,
        journal.state
      );
    }
    return { status: 'indeterminate', detail: 'unknown_delete_kind' };
  }

  /**
   * Completes a verified mid-way subtree deletion during crash recovery.
   * NEVER uses recursive deletion: every remaining file/entry/directory is individually verified
   * against its T1 snapshot identity (`dev`, `ino`, `sizeBytes`, `sha256`, `mtimeNs`, `ctimeNs`)
   * before unlinking or non-recursive `rmdirSync`. Any mismatch or unexpected entry aborts immediately.
   */
  private performVerifiedPartialDeleteCleanup(journal: ArtifactCommitJournalRow): { ok: true } | { ok: false; reason: string } {
    const payload = this.parseDeleteJournalPayload(journal);
    if (!payload || (payload.kind !== 'delete_project' && payload.kind !== 'delete_chat')) {
      return { ok: false, reason: 'not_subtree_delete' };
    }
    const parentRootDir = payload.kind === 'delete_project' ? this.config.projectsRoot : this.config.workspacesRoot;
    const relSubtreePath = payload.kind === 'delete_project' ? payload.projectSubtreeRel : payload.chatSubtreeRel;
    const snapshot = payload.subtreeSnapshot;

    if (!relSubtreePath || relSubtreePath.startsWith('..') || path.isAbsolute(relSubtreePath)) {
      return { ok: false, reason: 'invalid_subtree_rel' };
    }
    if (!snapshot || !snapshot.captureComplete || !snapshot.existedAtT1 || !snapshot.rootDev || !snapshot.rootIno) {
      return { ok: false, reason: 'incomplete_t1_snapshot' };
    }

    const normalized = normalizeRelPath(relSubtreePath);
    const segments = normalized.split('/');
    const targetName = segments.pop()!;
    const parentRel = segments.join('/');

    let parentFd: number;
    let parentRootReal: string;
    try {
      const opened = ensureContainedDirectoryNoFollow(parentRootDir, parentRel, { createMissing: false });
      parentFd = opened.dirFd;
      parentRootReal = opened.rootReal;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
      return { ok: false, reason: 'parent_dir_inaccessible' };
    }

    try {
      const rootTargetPath = `/proc/self/fd/${parentFd}/${targetName}`;
      let rootLst: fs.BigIntStats;
      try {
        rootLst = fs.lstatSync(rootTargetPath, { bigint: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
        return { ok: false, reason: 'subtree_root_stat_error' };
      }
      if (
        rootLst.isSymbolicLink() ||
        !rootLst.isDirectory() ||
        rootLst.dev.toString() !== snapshot.rootDev ||
        rootLst.ino.toString() !== snapshot.rootIno
      ) {
        return { ok: false, reason: 'subtree_root_identity_mismatch' };
      }

      const subtreeRootAbs = path.join(parentRootReal, ...segments, targetName);
      const depthOf = (rel: string) => rel.split('/').length;

      // 1. Verify and unlink remaining T1 non-directory entries (deepest first)
      const nonDirs = snapshot.entries
        .filter((e) => e.kind !== 'dir')
        .sort((a, b) => depthOf(b.relPath) - depthOf(a.relPath));

      for (const entry of nonDirs) {
        if (entry.kind === 'file') {
          let openedFile: ReturnType<typeof openContainedRegularFileNoFollow>;
          try {
            openedFile = openContainedRegularFileNoFollow(subtreeRootAbs, entry.relPath, { allowHardlinks: true });
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            return { ok: false, reason: `file_open_failed:${entry.relPath}` };
          }
          let matches = false;
          try {
            const st = openedFile.stat;
            const hashMatches = entry.sha256 == null || sha256Fd(openedFile.fd).sha256 === entry.sha256;
            matches =
              st.dev.toString() === entry.dev &&
              st.ino.toString() === entry.ino &&
              Number(st.size) === entry.sizeBytes &&
              st.mtimeNs.toString() === entry.mtimeNs &&
              st.ctimeNs.toString() === entry.ctimeNs &&
              hashMatches;
          } finally {
            fs.closeSync(openedFile.fd);
          }
          if (!matches) {
            return { ok: false, reason: `file_identity_mismatch:${entry.relPath}` };
          }
          unlinkContainedRegularFileNoFollow(subtreeRootAbs, entry.relPath);
        } else {
          const entrySegs = normalizeRelPath(entry.relPath).split('/');
          const leaf = entrySegs.pop()!;
          const entryParentRel = entrySegs.join('/');
          let entryParentFd: number;
          try {
            ({ dirFd: entryParentFd } = ensureContainedDirectoryNoFollow(subtreeRootAbs, entryParentRel, { createMissing: false }));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            return { ok: false, reason: `entry_parent_inaccessible:${entry.relPath}` };
          }
          try {
            const leafPath = `/proc/self/fd/${entryParentFd}/${leaf}`;
            let lst: fs.BigIntStats;
            try {
              lst = fs.lstatSync(leafPath, { bigint: true });
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
              return { ok: false, reason: `entry_stat_failed:${entry.relPath}` };
            }
            if (
              lst.isDirectory() ||
              lst.dev.toString() !== entry.dev ||
              lst.ino.toString() !== entry.ino ||
              lst.mtimeNs.toString() !== entry.mtimeNs ||
              lst.ctimeNs.toString() !== entry.ctimeNs
            ) {
              return { ok: false, reason: `entry_identity_mismatch:${entry.relPath}` };
            }
            try {
              fs.unlinkSync(leafPath);
              fs.fsyncSync(entryParentFd);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                return { ok: false, reason: `entry_unlink_failed:${entry.relPath}` };
              }
            }
          } finally {
            try {
              fs.closeSync(entryParentFd);
            } catch {
              // ignore
            }
          }
        }
      }

      // 2. Verify and rmdir (non-recursive!) remaining T1 subdirectories (deepest first)
      const dirs = snapshot.entries
        .filter((e) => e.kind === 'dir')
        .sort((a, b) => depthOf(b.relPath) - depthOf(a.relPath));

      for (const entry of dirs) {
        const entrySegs = normalizeRelPath(entry.relPath).split('/');
        const leaf = entrySegs.pop()!;
        const entryParentRel = entrySegs.join('/');
        let entryParentFd: number;
        try {
          ({ dirFd: entryParentFd } = ensureContainedDirectoryNoFollow(subtreeRootAbs, entryParentRel, { createMissing: false }));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          return { ok: false, reason: `dir_parent_inaccessible:${entry.relPath}` };
        }
        try {
          const dirPath = `/proc/self/fd/${entryParentFd}/${leaf}`;
          let lst: fs.BigIntStats;
          try {
            lst = fs.lstatSync(dirPath, { bigint: true });
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            return { ok: false, reason: `dir_stat_failed:${entry.relPath}` };
          }
          if (
            lst.isSymbolicLink() ||
            !lst.isDirectory() ||
            lst.dev.toString() !== entry.dev ||
            lst.ino.toString() !== entry.ino
          ) {
            return { ok: false, reason: `dir_identity_mismatch:${entry.relPath}` };
          }
          try {
            fs.rmdirSync(dirPath);
            fs.fsyncSync(entryParentFd);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') continue;
            return { ok: false, reason: `dir_rmdir_failed:${code ?? 'error'}:${entry.relPath}` };
          }
        } finally {
          try {
            fs.closeSync(entryParentFd);
          } catch {
            // ignore
          }
        }
      }

      // 3. Re-verify subtree root identity and non-recursively rmdir it (fails if any unexpected file exists)
      try {
        const finalLst = fs.lstatSync(rootTargetPath, { bigint: true });
        if (
          finalLst.isSymbolicLink() ||
          !finalLst.isDirectory() ||
          finalLst.dev.toString() !== snapshot.rootDev ||
          finalLst.ino.toString() !== snapshot.rootIno
        ) {
          return { ok: false, reason: 'subtree_root_changed_before_rmdir' };
        }
        fs.rmdirSync(rootTargetPath);
        fs.fsyncSync(parentFd);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          return { ok: false, reason: `subtree_root_rmdir_failed:${code ?? 'error'}` };
        }
      }
      return { ok: true };
    } finally {
      try {
        fs.closeSync(parentFd);
      } catch {
        // ignore
      }
    }
  }

  private performDeleteFsCleanup(journal: ArtifactCommitJournalRow): void {
    const payload = this.parseDeleteJournalPayload(journal);
    if (!payload) return;
    if (payload.kind === 'delete_project_file') {
      if (payload.targetIdentity && !payload.targetIdentity.existedAtT1) return;
      unlinkContainedRegularFileNoFollow(payload.storageDir, payload.relPath);
      return;
    }
    if (payload.kind === 'delete_sync_file') {
      if (payload.targetIdentity && !payload.targetIdentity.existedAtT1) return;
      unlinkContainedRegularFileNoFollow(payload.workspaceDir, payload.relPath);
      return;
    }
    if (payload.kind === 'delete_project') {
      if (payload.subtreeSnapshot && !payload.subtreeSnapshot.existedAtT1) return;
      if (fs.existsSync(payload.storageDir)) {
        for (const rel of payload.fileRelPaths) {
          unlinkContainedRegularFileNoFollow(payload.storageDir, rel);
        }
      }
      if (
        payload.projectSubtreeRel &&
        !payload.projectSubtreeRel.startsWith('..') &&
        !path.isAbsolute(payload.projectSubtreeRel)
      ) {
        removeContainedSubtreeNoFollow(this.config.projectsRoot, payload.projectSubtreeRel);
      }
      return;
    }
    if (payload.kind === 'delete_chat') {
      if (payload.subtreeSnapshot && !payload.subtreeSnapshot.existedAtT1) return;
      if (
        payload.chatSubtreeRel &&
        !payload.chatSubtreeRel.startsWith('..') &&
        !path.isAbsolute(payload.chatSubtreeRel)
      ) {
        removeContainedSubtreeNoFollow(this.config.workspacesRoot, payload.chatSubtreeRel);
      }
    }
  }

  /**
   * Shared Stage T6 transactional finalization for journaled deletions (normal commit & crash recovery roll-forward).
   */
  private finalizeDeleteStageT6InTx(journal: ArtifactCommitJournalRow): { envelopes: SyncEventEnvelope[] } {
    const payload = this.parseDeleteJournalPayload(journal);
    const now = Date.now();
    const envelopes: SyncEventEnvelope[] = [];

    if (payload?.kind === 'delete_project_file' && journal.projectId) {
      this.db.db
        .prepare('DELETE FROM project_files WHERE id = ? AND user_id = ?')
        .run(payload.fileId, journal.userId);
      const artId = payload.artifactId;
      if (artId) {
        this.db.db
          .prepare("UPDATE artifacts SET lifecycle_state = 'deleted', deleted_on_disk = 1, updated_at = ? WHERE id = ? AND user_id = ?")
          .run(now, artId, journal.userId);
        this.db.db
          .prepare(
            `INSERT INTO artifact_dep_propagation_queue (
               id, user_id, scope_kind, chat_id, project_id, changed_rel_path,
               source_artifact_id, source_revision, batch_id, exclude_artifact_ids_json, state, created_at, updated_at
             ) VALUES (?, ?, 'project', NULL, ?, ?, ?, 0, NULL, '[]', 'pending', ?, ?)`
          )
          .run(crypto.randomUUID(), journal.userId, journal.projectId, payload.relPath, artId, now, now);
        envelopes.push(
          this.db.insertSyncEventInTx({
            userId: journal.userId,
            eventId: crypto.randomUUID(),
            type: 'artifact.deleted',
            projectId: journal.projectId,
            payload: { artifactId: artId, relPath: payload.relPath, scopeKind: 'project' },
            createdAt: now,
          })
        );
      }
      const liveProj = this.db.getProject(journal.userId, journal.projectId);
      if (liveProj) {
        this.db.db
          .prepare('UPDATE projects SET context_version = context_version + 1, updated_at = ? WHERE id = ? AND user_id = ?')
          .run(now, journal.projectId, journal.userId);
        const latestProj = this.db.getProject(journal.userId, journal.projectId)!;
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
    } else if (payload?.kind === 'delete_project') {
      for (const art of payload.artifacts) {
        this.db.db
          .prepare("UPDATE artifacts SET lifecycle_state = 'deleted', deleted_on_disk = 1, updated_at = ? WHERE id = ? AND user_id = ?")
          .run(now, art.id, journal.userId);
        envelopes.push(
          this.db.insertSyncEventInTx({
            userId: journal.userId,
            eventId: crypto.randomUUID(),
            type: 'artifact.deleted',
            projectId: payload.projectId,
            payload: { artifactId: art.id, relPath: art.relPath, scopeKind: 'project' },
            createdAt: now,
          })
        );
      }
      // Detach source_artifact_id & source_base_revision on any chat copies before ON DELETE CASCADE
      // removes project artifacts, preserving CHECK(source_base_revision IS NULL OR source_artifact_id IS NOT NULL).
      this.db.db
        .prepare(
          `UPDATE artifacts
           SET source_artifact_id = NULL, source_base_revision = NULL, updated_at = ?
           WHERE user_id = ?
             AND source_artifact_id IN (
               SELECT id FROM artifacts WHERE project_id = ? AND user_id = ?
             )`
        )
        .run(now, journal.userId, payload.projectId, journal.userId);
      this.db.deleteProject(journal.userId, payload.projectId);
      envelopes.push(
        this.db.insertSyncEventInTx({
          userId: journal.userId,
          eventId: crypto.randomUUID(),
          type: 'project.deleted',
          projectId: payload.projectId,
          payload: { projectId: payload.projectId },
          createdAt: now,
        })
      );
    } else if (payload?.kind === 'delete_sync_file') {
      const liveArt =
        (payload.artifactId ? this.db.getArtifact(journal.userId, payload.artifactId) : null) ??
        this.db.findArtifactByRelPath(journal.userId, payload.chatId, payload.relPath);
      if (liveArt) {
        this.db.db
          .prepare("UPDATE artifacts SET lifecycle_state = 'deleted', deleted_on_disk = 1, updated_at = ? WHERE id = ? AND user_id = ?")
          .run(now, liveArt.id, journal.userId);
        this.db.db
          .prepare(
            `INSERT INTO artifact_dep_propagation_queue (
               id, user_id, scope_kind, chat_id, project_id, changed_rel_path,
               source_artifact_id, source_revision, batch_id, exclude_artifact_ids_json, state, created_at, updated_at
             ) VALUES (?, ?, 'chat', ?, NULL, ?, ?, 0, NULL, '[]', 'pending', ?, ?)`
          )
          .run(crypto.randomUUID(), journal.userId, payload.chatId, payload.relPath, liveArt.id, now, now);
        envelopes.push(
          this.db.insertSyncEventInTx({
            userId: journal.userId,
            eventId: crypto.randomUUID(),
            type: 'artifact.deleted',
            chatId: payload.chatId,
            payload: { artifactId: liveArt.id, relPath: payload.relPath, scopeKind: 'chat' },
            createdAt: now,
          })
        );
      }
    } else if (payload?.kind === 'delete_chat') {
      for (const art of payload.artifacts) {
        envelopes.push(
          this.db.insertSyncEventInTx({
            userId: journal.userId,
            eventId: crypto.randomUUID(),
            type: 'artifact.deleted',
            chatId: payload.chatId,
            payload: { artifactId: art.id, relPath: art.relPath, scopeKind: 'chat' },
            createdAt: now,
          })
        );
      }
      this.db.db
        .prepare(
          `UPDATE artifacts
           SET source_artifact_id = NULL, source_base_revision = NULL, updated_at = ?
           WHERE user_id = ?
             AND source_artifact_id IN (
               SELECT id FROM artifacts WHERE chat_id = ? AND user_id = ?
             )`
        )
        .run(now, journal.userId, payload.chatId, journal.userId);
      this.db.deleteChat(journal.userId, payload.chatId);
      envelopes.push(
        this.db.insertSyncEventInTx({
          userId: journal.userId,
          eventId: crypto.randomUUID(),
          type: 'chat.deleted',
          chatId: payload.chatId,
          payload: { chatId: payload.chatId },
          createdAt: now,
        })
      );
    }

    const firstSeq = envelopes.length > 0 ? envelopes[0].seq : null;
    const seqAudit = JSON.stringify({ syncEventSeqs: envelopes.map((e) => e.seq) });
    this.db.db
      .prepare(
        `UPDATE artifact_commit_journal
         SET state = 'db_committed', sync_event_seq = ?, audit_note = ?, updated_at = ?
         WHERE commit_id = ?`
      )
      .run(firstSeq, seqAudit, now, journal.commitId);

    return { envelopes };
  }

  /**
   * Executes a crash-recoverable deletion through the existing `artifact_commit_journal` T1 -> T3 -> T4 -> T5 -> T6 -> T7 pipeline.
   */
  private async executeJournaledDelete(params: {
    userId: string;
    scopeKind: ArtifactScopeKind;
    chatId: string | null;
    projectId: string | null;
    artifactId: string;
    relPath: string;
    operationSummary: string;
    payload: NonNullable<ReturnType<ArtifactService['parseDeleteJournalPayload']>>;
  }): Promise<{ envelopes: SyncEventEnvelope[] }> {
    const commitId = crypto.randomUUID();
    const now = Date.now();
    const stagingIsolation = this.getStagingIsolation();
    const payloadJson = JSON.stringify(params.payload);
    const faultCtx = {
      commitId,
      artifactId: params.artifactId,
      isCreate: false,
      privateStagePath: '',
      finalTargetPath: params.relPath,
    };

    const expectedPrevSha256 =
      params.payload.kind === 'delete_project_file' || params.payload.kind === 'delete_sync_file'
        ? params.payload.targetIdentity?.sha256 ?? null
        : null;
    const expectedPrevIno =
      params.payload.kind === 'delete_project_file' || params.payload.kind === 'delete_sync_file'
        ? params.payload.targetIdentity?.ino ?? null
        : params.payload.subtreeSnapshot?.rootIno ?? null;

    const journalObj: ArtifactCommitJournalRow = {
      commitId,
      artifactId: params.artifactId,
      userId: params.userId,
      chatId: params.chatId,
      projectId: params.projectId,
      scopeKind: params.scopeKind,
      relPath: params.relPath,
      isCreate: false,
      targetRevision: 0,
      parentRevision: null,
      expectedPrevSha256,
      expectedPrevIno,
      newSha256: '',
      newDependencyManifestHash: null,
      newDeps: [],
      newSizeBytes: 0,
      prevBlobSha256: null,
      newBlobSha256: '',
      privateStagePath: '',
      stageIno: null,
      actorKind: 'user',
      actorId: params.userId,
      operationType: params.payload.kind,
      operationSummary: params.operationSummary,
      operationPayloadJson: payloadJson,
      batchId: null,
      batchSeq: null,
      stagingIsolationMode: stagingIsolation,
      idempotencyScopeKey: null,
      idempotencyKey: null,
      requestFingerprint: null,
      diffPatch: null,
      state: 'prepared',
      auditNote: null,
      syncEventSeq: null,
      createdAt: now,
      updatedAt: now,
    };

    let journalInserted = false;
    try {
      await this.commitFaultHook?.('before_T1', faultCtx);
      // T1: Persist delete intent + target identity snapshot in artifact_commit_journal BEFORE any filesystem unlink
      this.db.db
        .prepare(
          `INSERT INTO artifact_commit_journal (
             commit_id, artifact_id, user_id, chat_id, project_id, scope_kind, rel_path,
             is_create, target_revision, parent_revision, expected_prev_sha256, expected_prev_ino,
             new_sha256, new_dependency_manifest_hash, new_deps_json, new_size_bytes,
             prev_blob_sha256, new_blob_sha256, private_stage_path, stage_ino,
             actor_kind, actor_id, operation_type, operation_summary, operation_payload_json,
             batch_id, batch_seq, staging_isolation_mode, idempotency_scope_key, idempotency_key,
             request_fingerprint, diff_patch, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, '', NULL, '[]', 0, NULL, '', '', NULL,
                     'user', ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, 'prepared', ?, ?)`
        )
        .run(
          commitId,
          params.artifactId,
          params.userId,
          params.chatId,
          params.projectId,
          params.scopeKind,
          params.relPath,
          expectedPrevSha256,
          expectedPrevIno,
          params.userId,
          params.payload.kind,
          params.operationSummary,
          payloadJson,
          stagingIsolation,
          now,
          now
        );
      journalInserted = true;
      await this.commitFaultHook?.('after_T1', faultCtx);

      await this.commitFaultHook?.('before_T3', faultCtx);
      // T3: Transition to 'replacing' immediately before FS deletion
      this.db.db
        .prepare("UPDATE artifact_commit_journal SET state = 'replacing', updated_at = ? WHERE commit_id = ?")
        .run(Date.now(), commitId);
      journalObj.state = 'replacing';
      await this.commitFaultHook?.('after_T3', faultCtx);

      await this.commitFaultHook?.('before_T4', faultCtx);
      // T4: Strict O_NOFOLLOW filesystem unlink / subtree removal (tolerate ONLY ENOENT)
      this.performDeleteFsCleanup(journalObj);
      await this.commitFaultHook?.('after_T4', faultCtx);

      await this.commitFaultHook?.('before_T5', faultCtx);
      // T5: Persist state = 'file_replaced' confirming FS removal succeeded
      this.db.db
        .prepare("UPDATE artifact_commit_journal SET state = 'file_replaced', updated_at = ? WHERE commit_id = ?")
        .run(Date.now(), commitId);
      journalObj.state = 'file_replaced';
      await this.commitFaultHook?.('after_T5', faultCtx);

      await this.commitFaultHook?.('before_T6', faultCtx);
      // T6: Single BEGIN IMMEDIATE transaction committing DB deletion + dep queue + durable outbox events
      let envelopes: SyncEventEnvelope[] = [];
      this.db.db.exec('BEGIN IMMEDIATE;');
      try {
        const res = this.finalizeDeleteStageT6InTx(journalObj);
        envelopes = res.envelopes;
        this.db.db.exec('COMMIT;');
      } catch (err) {
        this.db.db.exec('ROLLBACK;');
        throw err;
      }
      await this.commitFaultHook?.('after_T6', faultCtx);

      await this.commitFaultHook?.('before_T7', faultCtx);
      // T7: Broadcast persisted outbox events and remove completed journal row
      for (const env of envelopes) {
        this.hub.broadcastPersistedEvent(env);
      }
      this.db.db.prepare('DELETE FROM artifact_commit_journal WHERE commit_id = ?').run(commitId);
      await this.commitFaultHook?.('after_T7', faultCtx);

      return { envelopes };
    } catch (err) {
      // If a real non-fault-injected FS error (e.g. EACCES / PathContainmentError) failed BEFORE target removal,
      // abort the journal cleanly so DB and FS remain consistent and startup recovery does not delete untouched data.
      if (journalInserted && !this.commitFaultHook) {
        const row = this.db.db
          .prepare('SELECT state FROM artifact_commit_journal WHERE commit_id = ?')
          .get(commitId) as { state: string } | undefined;
        if (
          row &&
          (row.state === 'prepared' ||
            (row.state === 'replacing' && this.inspectDeleteTarget(journalObj).status === 'intact'))
        ) {
          this.db.db
            .prepare("UPDATE artifact_commit_journal SET state = 'aborted', audit_note = ?, updated_at = ? WHERE commit_id = ?")
            .run(`delete_fs_error:${err instanceof Error ? err.message.slice(0, 120) : 'error'}`, Date.now(), commitId);
        }
      }
      throw err;
    }
  }

  async deleteProjectFile(params: {
    userId: string;
    projectId: string;
    fileId: string;
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ deleted: ProjectFileRecord; project: ReturnType<AppDatabase['getProject']> & { files: ProjectFileRecord[] } }> {
    await params.assertAuthorized?.();
    const project = this.db.getProject(params.userId, params.projectId);
    if (!project) {
      throw new ArtifactError('NOT_FOUND', 'プロジェクトが見つかりません。', 404);
    }
    const existingPf = this.db.getProjectFileById(params.userId, params.projectId, params.fileId);
    if (!existingPf) {
      throw new ArtifactError('NOT_FOUND', 'ファイルが見つかりません。', 404);
    }

    const pathLockKey = `path:${params.userId}:project:${params.projectId}:${existingPf.relPath}`;
    const lockKeys = existingPf.artifactId ? [`artifact:${existingPf.artifactId}`, pathLockKey] : [pathLockKey];

    await this.lockManager.withLocks(lockKeys, async () => {
      await params.assertAuthorized?.();
      const liveProj = this.db.getProject(params.userId, params.projectId);
      const livePf = this.db.getProjectFileById(params.userId, params.projectId, params.fileId);
      if (!liveProj || !livePf) {
        throw new ArtifactError('NOT_FOUND', 'ファイルが見つかりません。', 404);
      }

      const targetIdentity = this.captureFileTargetIdentityNoFollow(liveProj.storageDir, livePf.relPath);
      await this.executeJournaledDelete({
        userId: params.userId,
        scopeKind: 'project',
        chatId: null,
        projectId: params.projectId,
        artifactId: livePf.artifactId ?? livePf.id,
        relPath: livePf.relPath,
        operationSummary: `Delete project file ${livePf.relPath}`,
        payload: {
          kind: 'delete_project_file',
          fileId: livePf.id,
          storageDir: liveProj.storageDir,
          relPath: livePf.relPath,
          artifactId: livePf.artifactId ?? null,
          targetIdentity,
        },
      });
    });

    await this.drainDepPropagationQueue();

    const latest = this.db.getProject(params.userId, params.projectId)!;
    return {
      deleted: existingPf,
      project: { ...latest, files: this.db.listProjectFiles(params.userId, params.projectId) },
    };
  }

  /**
   * Unified gateway for deleting an entire project, its project artifacts, storage subtree, and durable notifications (`ARCH-01`, `ARCH-03`, `SEC-02`).
   */
  async deleteProject(params: {
    userId: string;
    projectId: string;
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ affectedChatIds: string[] }> {
    await params.assertAuthorized?.();
    const existing = this.db.getProject(params.userId, params.projectId);
    if (!existing) {
      throw new ArtifactError('NOT_FOUND', 'プロジェクトが見つかりません。', 404);
    }

    const projectArtifacts = this.db.listArtifactsForProject(params.userId, params.projectId);
    const projectFiles = this.db.listProjectFiles(params.userId, params.projectId);
    const lockKeys = [
      `project:${params.projectId}`,
      ...projectArtifacts.map((a) => `artifact:${a.id}`),
      ...projectFiles.map((f) => `path:${params.userId}:project:${params.projectId}:${f.relPath}`),
    ];

    let affectedChatIds: string[] = [];

    await this.lockManager.withLocks(lockKeys, async () => {
      await params.assertAuthorized?.();
      const liveProj = this.db.getProject(params.userId, params.projectId);
      if (!liveProj) {
        throw new ArtifactError('NOT_FOUND', 'プロジェクトが見つかりません。', 404);
      }
      affectedChatIds = this.db.listChatIdsForProject(params.userId, params.projectId);
      const liveArtifacts = this.db.listArtifactsForProject(params.userId, params.projectId);
      const liveFiles = this.db.listProjectFiles(params.userId, params.projectId);

      const projDir = path.dirname(liveProj.storageDir);
      const relProjSubtree = path.relative(this.config.projectsRoot, projDir);
      const safeSubtreeRel =
        relProjSubtree && !relProjSubtree.startsWith('..') && !path.isAbsolute(relProjSubtree)
          ? relProjSubtree
          : null;

      const subtreeSnapshot = this.captureSubtreeSnapshotNoFollow(this.config.projectsRoot, safeSubtreeRel);
      await this.executeJournaledDelete({
        userId: params.userId,
        scopeKind: 'project',
        chatId: null,
        projectId: params.projectId,
        artifactId: `project:${params.projectId}`,
        relPath: safeSubtreeRel ?? params.projectId,
        operationSummary: `Delete project ${params.projectId}`,
        payload: {
          kind: 'delete_project',
          projectId: params.projectId,
          storageDir: liveProj.storageDir,
          projectSubtreeRel: safeSubtreeRel,
          fileRelPaths: liveFiles.map((f) => f.relPath),
          artifacts: liveArtifacts.map((a) => ({ id: a.id, relPath: a.relPath })),
          subtreeSnapshot,
        },
      });
    });

    return { affectedChatIds };
  }

  /**
   * Unified gateway for deleting a chat, its artifacts, workspace subtree, and durable notifications (`ARCH-01`, `SEC-02`).
   */
  async deleteChat(params: {
    userId: string;
    chatId: string;
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<void> {
    await params.assertAuthorized?.();
    const existing = this.db.getChat(params.userId, params.chatId);
    if (!existing) {
      throw new ArtifactError('NOT_FOUND', 'チャットが見つかりません。', 404);
    }

    const chatArtifacts = this.db.listArtifactsForChat(params.userId, params.chatId);
    const lockKeys = [
      `chat:${params.chatId}`,
      ...chatArtifacts.map((a) => `artifact:${a.id}`),
    ];

    await this.lockManager.withLocks(lockKeys, async () => {
      await params.assertAuthorized?.();
      const liveChat = this.db.getChat(params.userId, params.chatId);
      if (!liveChat) {
        throw new ArtifactError('NOT_FOUND', 'チャットが見つかりません。', 404);
      }
      const liveArtifacts = this.db.listArtifactsForChat(params.userId, params.chatId);
      const relChatSubtree = path.relative(this.config.workspacesRoot, liveChat.workspaceDir);
      const safeSubtreeRel =
        relChatSubtree && !relChatSubtree.startsWith('..') && !path.isAbsolute(relChatSubtree)
          ? relChatSubtree
          : null;

      const subtreeSnapshot = this.captureSubtreeSnapshotNoFollow(this.config.workspacesRoot, safeSubtreeRel);
      await this.executeJournaledDelete({
        userId: params.userId,
        scopeKind: 'chat',
        chatId: params.chatId,
        projectId: null,
        artifactId: `chat:${params.chatId}`,
        relPath: safeSubtreeRel ?? params.chatId,
        operationSummary: `Delete chat ${params.chatId}`,
        payload: {
          kind: 'delete_chat',
          chatId: params.chatId,
          workspaceDir: liveChat.workspaceDir,
          chatSubtreeRel: safeSubtreeRel,
          artifacts: liveArtifacts.map((a) => ({ id: a.id, relPath: a.relPath })),
          subtreeSnapshot,
        },
      });
    });
  }

  async copyArtifactToProject(params: {
    userId: string;
    artifactId: string;
    projectId: string;
    targetFilename?: string;
    srcAbsPathOverride?: string;
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord; file: ProjectFileRecord }> {
    await params.assertAuthorized?.();
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
      assertAuthorized: params.assertAuthorized,
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
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord }> {
    await params.assertAuthorized?.();
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
        assertAuthorized: params.assertAuthorized,
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
      assertAuthorized: params.assertAuthorized,
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
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<string[]> {
    await params.assertAuthorized?.();
    const project = this.db.getProject(params.userId, params.projectId);
    const chat = this.db.getChat(params.userId, params.chatId);
    if (!project || !chat) {
      throw new ArtifactError('NOT_FOUND', 'プロジェクトまたはチャットが見つかりません。', 404);
    }

    const projectFiles = this.db.listProjectFiles(params.userId, params.projectId);
    const expectedRels = new Set(projectFiles.map((f) => normalizeRelPath(`.project-context/${f.relPath}`)));

    // Clean removed files inside .project-context using O_NOFOLLOW enumeration + unlink, ArtifactLockManager, dep propagation, and SyncHub events
    const diskContextFiles = listContainedFilesNoFollow(chat.workspaceDir, '.project-context');
    const dbContextArtifacts = this.db
      .listArtifactsForChat(params.userId, params.chatId)
      .filter((a) => a.relPath.startsWith('.project-context/'));

    const obsoleteRels = new Set<string>();
    for (const rel of diskContextFiles) {
      const normalized = normalizeRelPath(rel);
      if (!expectedRels.has(normalized)) obsoleteRels.add(normalized);
    }
    for (const art of dbContextArtifacts) {
      const normalized = normalizeRelPath(art.relPath);
      if (!expectedRels.has(normalized)) obsoleteRels.add(normalized);
    }

    let deletedAny = false;
    for (const wsRel of obsoleteRels) {
      const oldArt = this.db.findArtifactByRelPath(params.userId, params.chatId, wsRel);
      const pathLockKey = `path:${params.userId}:chat:${params.chatId}:${wsRel}`;
      const lockKeys = oldArt ? [`artifact:${oldArt.id}`, pathLockKey] : [pathLockKey];

      await this.lockManager.withLocks(lockKeys, async () => {
        await params.assertAuthorized?.();
        const liveArt = this.db.findArtifactByRelPath(params.userId, params.chatId, wsRel);
        const targetIdentity = this.captureFileTargetIdentityNoFollow(chat.workspaceDir, wsRel);
        const { envelopes } = await this.executeJournaledDelete({
          userId: params.userId,
          scopeKind: 'chat',
          chatId: params.chatId,
          projectId: null,
          artifactId: liveArt?.id ?? `sync:${params.chatId}:${wsRel}`,
          relPath: wsRel,
          operationSummary: `Remove obsolete synced project file ${wsRel}`,
          payload: {
            kind: 'delete_sync_file',
            chatId: params.chatId,
            workspaceDir: chat.workspaceDir,
            relPath: wsRel,
            artifactId: liveArt?.id ?? null,
            targetIdentity,
          },
        });
        if (envelopes.length > 0) deletedAny = true;
      });
    }

    if (deletedAny) {
      await this.drainDepPropagationQueue();
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
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ projectArtifact: ArtifactRecord; workingCopy: ArtifactRecord }> {
    await params.assertAuthorized?.();
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
      assertAuthorized: params.assertAuthorized,
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
    batchSeq?: number | null;
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
      await params.assertAuthorized?.();
      const art = this.db.getArtifact(params.userId, params.artifactId);
      if (!art) throw new ArtifactError('NOT_FOUND', '対象の成果物が見つからないか権限がありません。', 404);
      if (art.scopeKind === 'chat' && (!art.chatId || !this.db.getChat(params.userId, art.chatId))) {
        throw new ArtifactError('NOT_FOUND', '対象チャットが見つからないか権限がありません。', 404);
      }
      if (art.scopeKind === 'project' && (!art.projectId || !this.db.getProject(params.userId, art.projectId))) {
        throw new ArtifactError('NOT_FOUND', '対象プロジェクトが見つからないか権限がありません。', 404);
      }
      if (params.actorKind === 'ai' && art.scopeKind === 'project') {
        throw new ArtifactError('FORBIDDEN', 'AI/内蔵MCPからプロジェクト原本への書き込みは禁止されています。', 403);
      }
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
        batchSeq: params.batchSeq,
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
      await params.assertAuthorized?.();
      const art = this.db.getArtifact(params.userId, params.artifactId);
      if (!art) throw new ArtifactError('NOT_FOUND', '成果物が見つからないか権限がありません。', 404);
      if (art.scopeKind === 'chat' && (!art.chatId || !this.db.getChat(params.userId, art.chatId))) {
        throw new ArtifactError('NOT_FOUND', '対象チャットが見つからないか権限がありません。', 404);
      }
      if (art.scopeKind === 'project' && (!art.projectId || !this.db.getProject(params.userId, art.projectId))) {
        throw new ArtifactError('NOT_FOUND', '対象プロジェクトが見つからないか権限がありません。', 404);
      }
      if (params.actorKind === 'ai' && art.scopeKind === 'project') {
        throw new ArtifactError('FORBIDDEN', 'AI/内蔵MCPからプロジェクト原本への書き込みは禁止されています。', 403);
      }
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

          const adapter = this.registry.resolve(current.filename, current.previewKind);
          const maxBytes = isDocumentFormat(adapter.format) ? DOCUMENT_WORKER_MAX_INPUT_BYTES : undefined;
          const prevRead = readContainedRegularFileNoFollowStable(rootDir, current.relPath, { maxBytes });
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

          if (isDocumentFormat(adapter.format)) {
            const supported = DOCUMENT_ACTIONS[adapter.format];
            const unsupported = params.operations.find(({ op }) => !supported.includes(op) || !op.includes('.') || op.endsWith('.get_structure'));
            if (unsupported) {
              throw unsupportedOperationError(unsupported.op, 'unsupported_by_format', `Cannot apply '${unsupported.op}' to '${adapter.format}'.`);
            }
          }
          const editResult = isDocumentFormat(adapter.format)
            ? {
                buffer: await this.documentWorker.run(adapter.format, current.filename, prevRead.buffer, {
                  action: 'edit',
                  operations: params.operations,
                }),
                summary: 'Updated document',
              }
            : adapter.applyOperations(prevRead.buffer, params.operations, current);

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

  async getStructure(userId: string, artifactId: string): Promise<Record<string, unknown>> {
    const artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    const buf = this.readActiveArtifactBytes(artifact, DOCUMENT_WORKER_MAX_INPUT_BYTES);
    if (!buf) throw new ArtifactError('FILE_MISSING', 'ファイル実体が見つかりません。', 404);
    const adapter = this.registry.resolve(artifact.filename, artifact.previewKind);
    const format = adapter.format;
    const structure = this.documentWorker.available && isDocumentFormat(format)
      ? JSON.parse((await this.documentWorker.run(format, artifact.filename, buf, { action: 'structure' })).toString('utf8'))
      : adapter.getStructure(buf, artifact);
    return {
      artifactId: artifact.id,
      revision: artifact.revision,
      sha256: artifact.sha256,
      ...structure,
    };
  }

  async readRange(userId: string, artifactId: string, range: Record<string, unknown>): Promise<Record<string, unknown>> {
    const artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    const buf = this.readActiveArtifactBytes(artifact, DOCUMENT_WORKER_MAX_INPUT_BYTES);
    if (!buf) throw new ArtifactError('FILE_MISSING', 'ファイル実体が見つかりません。', 404);
    const adapter = this.registry.resolve(artifact.filename, artifact.previewKind);
    const data = isDocumentFormat(adapter.format) && ['xlsx', 'docx', 'pptx', 'pdf'].includes(adapter.format)
      ? JSON.parse((await this.documentWorker.run(adapter.format, artifact.filename, buf, { action: 'range', range })).toString('utf8'))
      : adapter.readRange(buf, range, artifact);
    return { artifactId: artifact.id, revision: artifact.revision, ...data };
  }

  async renderPng(userId: string, artifactId: string, options: { pageIndex?: number; timeSeconds?: number } = {}): Promise<Buffer> {
    const artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', 'Artifact not found.', 404);
    const format = this.registry.resolve(artifact.filename, artifact.previewKind).format;
    const source = this.readActiveArtifactBytes(artifact, DOCUMENT_WORKER_MAX_INPUT_BYTES);
    if (!source) throw new ArtifactError('FILE_MISSING', 'Artifact bytes not found.', 404);
    const png = artifact.mimeType === 'image/png' && !this.documentWorker.available
      ? source
      : isDocumentFormat(format) || isWebRenderFormat(format) || format === 'svg'
        ? await this.documentWorker.run(format, artifact.filename, source, { action: 'render', ...options })
        : null;
    if (!png) {
      throw unsupportedOperationError('render_png', 'unsupported_by_format', 'PNG rendering is unavailable for this format.');
    }
    if (png.length < 24 || png.length > 16 * 1024 * 1024 ||
      !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      png.toString('ascii', 12, 16) !== 'IHDR' ||
      png.readUInt32BE(16) < 1 || png.readUInt32BE(16) > 8192 ||
      png.readUInt32BE(20) < 1 || png.readUInt32BE(20) > 8192) {
      throw new ArtifactError('INVALID_RENDER_IMAGE', 'Invalid or oversized PNG.', 422);
    }
    return png;
  }

  async verifyArtifact(userId: string, artifactId: string): Promise<AdapterVerifyResult> {
    const artifact = this.db.getArtifact(userId, artifactId);
    if (!artifact) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    const buf = this.readActiveArtifactBytes(artifact, DOCUMENT_WORKER_MAX_INPUT_BYTES);
    if (!buf) throw new ArtifactError('FILE_MISSING', 'ファイル実体が見つかりません。', 404);
    const adapter = this.registry.resolve(artifact.filename, artifact.previewKind);
    const format = adapter.format;
    if (this.documentWorker.available && isDocumentFormat(format)) {
      try {
        return JSON.parse((await this.documentWorker.run(format, artifact.filename, buf, { action: 'verify' })).toString('utf8'));
      } catch (error) {
        if (!(error instanceof ArtifactError) || error.code !== 'DOCUMENT_WORKER_REJECTED') throw error;
        return { ok: false, issues: [{ severity: 'error', code: error.code, message: error.message }] };
      }
    }
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
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord; exported: AdapterExportResult }> {
    await params.assertAuthorized?.();
    const src = this.db.getArtifact(params.userId, params.artifactId);
    if (!src) throw new ArtifactError('NOT_FOUND', '成果物が見つかりません。', 404);
    if (params.actorKind === 'ai' && src.scopeKind === 'project') {
      throw new ArtifactError('FORBIDDEN', 'AI/内蔵MCPからプロジェクト原本スコープへのエクスポートは禁止されています。', 403);
    }
    const buf = this.readActiveArtifactBytes(src, DOCUMENT_WORKER_MAX_INPUT_BYTES);
    if (!buf) throw new ArtifactError('FILE_MISSING', 'ファイル実体が見つかりません。', 404);
    const adapter = this.registry.resolve(src.filename, src.previewKind);
    let exported: AdapterExportResult;
    if (adapter.exportAs) {
      exported = adapter.exportAs(buf, params.targetFormat, src);
    } else if (
      (['docx', 'pptx', 'xlsx'].some((format) => format === adapter.format) && params.targetFormat === 'pdf' &&
        isDocumentFormat(adapter.format)) ||
      (adapter.format === 'pdf' && ['png', 'txt'].includes(params.targetFormat)) ||
      (adapter.format === 'image' && ['png', 'jpg', 'jpeg', 'webp'].includes(params.targetFormat))
    ) {
      const filename = `${path.parse(src.filename).name}.${params.targetFormat}`;
      exported = {
        filename,
        mimeType: detectMimeAndPreviewKind(filename, null).mimeType,
        buffer: await this.documentWorker.run(adapter.format, src.filename, buf, {
          action: 'export', targetFormat: params.targetFormat,
        }),
      };
    } else {
      throw unsupportedOperationError(
        `export:${params.targetFormat}`, 'unsupported_by_format',
        `Cannot export '${adapter.format}' as '${params.targetFormat}'.`
      );
    }
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
      assertAuthorized: params.assertAuthorized,
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
    batchSeq?: number | null;
    suppressDependencyPropagation?: boolean;
    alreadyLocked?: boolean;
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord; dependencyDiff: Array<{ relPath: string; targetSha256: string | null; currentSha256: string | null }> }> {
    await params.assertAuthorized?.();
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
      batchSeq: params.batchSeq ?? null,
      suppressDependencyPropagation: params.suppressDependencyPropagation,
      idempotencyKey: params.idempotencyKey,
      alreadyLocked: params.alreadyLocked,
      assertAuthorized: params.assertAuthorized,
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
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<ArtifactRestoreBatchRecord> {
    await params.assertAuthorized?.();
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
        restoreSingleArtifactLocked: (p) =>
          this.restoreRevision({ ...p, assertAuthorized: params.assertAuthorized }),
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
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord; undoState: UndoStateSummary }> {
    await params.assertAuthorized?.();
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
      assertAuthorized: params.assertAuthorized,
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
    assertAuthorized?: () => void | Promise<void>;
  }): Promise<{ artifact: ArtifactRecord; undoState: UndoStateSummary }> {
    await params.assertAuthorized?.();
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
      assertAuthorized: params.assertAuthorized,
    });
    return {
      artifact: res.artifact,
      undoState: this.getUndoState(params.userId, artifact.id, params.actorKind, params.actorId),
    };
  }
}
