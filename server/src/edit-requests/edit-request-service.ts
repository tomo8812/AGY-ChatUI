import crypto from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import type { SyncHub } from '../sync/hub.js';
import { detectArtifactFormat } from '../artifacts/adapters/registry.js';
import type { ArtifactService } from '../artifacts/artifact-service.js';
import { ArtifactError, unsupportedOperationError } from '../artifacts/errors.js';
import type { TargetResolutionResult, TargetSelector } from '../artifacts/types.js';
import type { RichContentService } from '../rich/rich-content-service.js';
import { resolveRichBlockTarget } from './target-resolver.js';

export type EditRequestStatus =
  | 'draft'
  | 'sent'
  | 'applied_unverified'
  | 'needs_review'
  | 'stale'
  | 'resolved';

export interface AiEditRequestRecord {
  id: string;
  userId: string;
  chatId: string;
  targetKind: 'artifact' | 'rich_block';
  artifactId: string | null;
  richBlockId: string | null;
  baseRevision: number;
  format: string;
  containerRef: Record<string, unknown>;
  selector: TargetSelector;
  range: Record<string, unknown> | null;
  contentCoords: Record<string, unknown> | null;
  selectedContentSnapshot: string;
  surroundingContext: string | null;
  regionImageBlobSha256: string | null;
  instruction: string;
  status: EditRequestStatus;
  viewStateSnapshot: Record<string, unknown> | null;
  batchId: string | null;
  sentMessageId: string | null;
  appliedRevision: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentEditRequestPayload {
  id: string;
  targetKind: 'artifact' | 'rich_block';
  artifactId: string | null;
  richBlockId: string | null;
  format: string;
  baseRevision: number;
  status: EditRequestStatus;
  /** Strictly separated user instruction (never mixed with untrusted document text) */
  userInstruction: string;
  /** Strictly separated untrusted content excerpt from the target artifact / rich block */
  untrustedTargetContent: {
    selectedContentSnapshot: string;
    surroundingContext: string | null;
  };
  selector: TargetSelector;
  range: Record<string, unknown> | null;
  contentCoords: Record<string, unknown> | null;
  reResolution: TargetResolutionResult;
  regionImagePngBase64?: string;
}

/**
 * Manages target-pinned AI edit requests (`ai_edit_requests`, `ai_edit_request_batches`) strictly separated
 * from original document comments (`PIN-01`..`PIN-06`).
 */
export class EditRequestService {
  constructor(
    private readonly db: AppDatabase,
    private readonly hub: SyncHub,
    private readonly artifactService: ArtifactService,
    private readonly richContentService: RichContentService
  ) {
    // Automatically re-validate open edit requests whenever an artifact is updated
    this.artifactService.onArtifactUpdated((artifact) => {
      if (artifact.scopeKind === 'chat' && artifact.chatId) {
        void this.revalidateForArtifact(artifact.userId, artifact.id, artifact.revision).catch(() => {});
      }
    });
  }

  private assertChatOwner(userId: string, chatId: string): void {
    const chat = this.db.getChat(userId, chatId);
    if (!chat) {
      throw new ArtifactError('NOT_FOUND', 'チャットが見つからないか権限がありません。', 404);
    }
  }

  createRequest(params: {
    userId: string;
    chatId: string;
    targetKind: 'artifact' | 'rich_block';
    artifactId?: string | null;
    richBlockId?: string | null;
    baseRevision?: number;
    selector: TargetSelector;
    range?: Record<string, unknown> | null;
    contentCoords?: Record<string, unknown> | null;
    selectedContentSnapshot?: string;
    surroundingContext?: string | null;
    regionImagePngBuffer?: Buffer | null;
    instruction: string;
    viewStateSnapshot?: Record<string, unknown> | null;
  }): AiEditRequestRecord {
    this.assertChatOwner(params.userId, params.chatId);
    const instruction = params.instruction.trim();
    if (!instruction) {
      throw new ArtifactError('INVALID_INPUT', '修正指示を入力してください。', 400);
    }

    let format = 'rich_block';
    let baseRevision = params.baseRevision ?? 1;
    let artifactId: string | null = null;
    let richBlockId: string | null = null;

    if (params.targetKind === 'artifact') {
      if (!params.artifactId) {
        throw new ArtifactError('INVALID_INPUT', 'artifactId が必要です。', 400);
      }
      const art = this.db.getArtifact(params.userId, params.artifactId);
      if (!art || art.scopeKind !== 'chat' || art.chatId !== params.chatId) {
        throw new ArtifactError('NOT_FOUND', '対象成果物がこのチャットに見つかりません。', 404);
      }
      format = detectArtifactFormat(art.filename, art.previewKind);
      const adapter = this.artifactService.registry.resolve(art.filename, art.previewKind);
      if (!adapter.targetPinSupported) {
        throw unsupportedOperationError(
          'target_pin',
          'unsupported_by_format',
          `形式 '${format}' は対象指定 AI 編集依頼に対応していません。`
        );
      }
      artifactId = art.id;
      baseRevision = params.baseRevision ?? art.revision;
    } else {
      if (!params.richBlockId) {
        throw new ArtifactError('INVALID_INPUT', 'richBlockId が必要です。', 400);
      }
      const block = this.richContentService.getBlock(params.userId, params.chatId, params.richBlockId);
      if (!block) {
        throw new ArtifactError('NOT_FOUND', '対象リッチブロックがこのチャットに見つかりません。', 404);
      }
      richBlockId = block.id;
      baseRevision = params.baseRevision ?? block.revision;
    }

    let regionBlobSha: string | null = null;
    let lease: ReturnType<ArtifactService['blobManager']['putBlobWithLease']> | null = null;
    if (params.regionImagePngBuffer && params.regionImagePngBuffer.length > 0) {
      lease = this.artifactService.blobManager.putBlobWithLease(params.userId, params.regionImagePngBuffer);
      regionBlobSha = lease.sha256;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      let envelope;
      this.db.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.db
          .prepare(
            `INSERT INTO ai_edit_requests (
               id, user_id, chat_id, target_kind, artifact_id, rich_block_id, base_revision, format,
               container_ref_json, selector_json, range_json, content_coords_json,
               selected_content_snapshot, surrounding_context, region_image_blob_sha256,
               instruction, status, view_state_snapshot_json, batch_id, sent_message_id, applied_revision,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, NULL, ?, ?)`
          )
          .run(
            id,
            params.userId,
            params.chatId,
            params.targetKind,
            artifactId,
            richBlockId,
            baseRevision,
            format,
            JSON.stringify({ ...params.selector, baseRevision }),
            params.range ? JSON.stringify(params.range) : null,
            params.contentCoords ? JSON.stringify(params.contentCoords) : null,
            params.selectedContentSnapshot ?? '',
            params.surroundingContext ?? null,
            regionBlobSha,
            instruction,
            params.viewStateSnapshot ? JSON.stringify(params.viewStateSnapshot) : null,
            now,
            now
          );

        const created = this.getRequest(params.userId, params.chatId, id)!;
        envelope = this.db.insertSyncEventInTx({
          userId: params.userId,
          eventId: crypto.randomUUID(),
          type: 'edit_request.created',
          chatId: params.chatId,
          payload: { editRequest: created },
          createdAt: now,
        });
        this.db.db.exec('COMMIT;');
      } catch (err) {
        this.db.db.exec('ROLLBACK;');
        throw err;
      }

      this.hub.broadcastPersistedEvent(envelope);
      return this.getRequest(params.userId, params.chatId, id)!;
    } finally {
      lease?.release();
    }
  }

  getRequest(userId: string, chatId: string, requestId: string): AiEditRequestRecord | null {
    const row = this.db.db
      .prepare('SELECT * FROM ai_edit_requests WHERE id = ? AND user_id = ? AND chat_id = ?')
      .get(requestId, userId, chatId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  listRequests(
    userId: string,
    chatId: string,
    filter: { artifactId?: string; richBlockId?: string; status?: EditRequestStatus } = {}
  ): AiEditRequestRecord[] {
    this.assertChatOwner(userId, chatId);
    const clauses = ['user_id = ?', 'chat_id = ?'];
    const args: Array<string | number> = [userId, chatId];
    if (filter.artifactId) {
      clauses.push('artifact_id = ?');
      args.push(filter.artifactId);
    }
    if (filter.richBlockId) {
      clauses.push('rich_block_id = ?');
      args.push(filter.richBlockId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      args.push(filter.status);
    }
    const rows = this.db.db
      .prepare(`SELECT * FROM ai_edit_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`)
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  updateRequest(params: {
    userId: string;
    chatId: string;
    requestId: string;
    instruction?: string;
    selector?: TargetSelector;
  }): AiEditRequestRecord {
    const existing = this.getRequest(params.userId, params.chatId, params.requestId);
    if (!existing) throw new ArtifactError('NOT_FOUND', '編集依頼が見つかりません。', 404);
    const now = Date.now();
    const nextInstruction = params.instruction !== undefined ? params.instruction.trim() : existing.instruction;
    if (!nextInstruction) throw new ArtifactError('INVALID_INPUT', '修正指示を入力してください。', 400);
    const nextSelector = params.selector ?? existing.selector;

    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.db
        .prepare('UPDATE ai_edit_requests SET instruction = ?, selector_json = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(nextInstruction, JSON.stringify(nextSelector), now, existing.id, params.userId);
      const updated = this.getRequest(params.userId, params.chatId, existing.id)!;
      envelope = this.db.insertSyncEventInTx({
        userId: params.userId,
        eventId: crypto.randomUUID(),
        type: 'edit_request.updated',
        chatId: params.chatId,
        payload: { editRequest: updated },
        createdAt: now,
      });
      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }
    this.hub.broadcastPersistedEvent(envelope);
    return this.getRequest(params.userId, params.chatId, existing.id)!;
  }

  deleteRequest(userId: string, chatId: string, requestId: string): boolean {
    const existing = this.getRequest(userId, chatId, requestId);
    if (!existing) return false;
    const now = Date.now();
    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.db.prepare('DELETE FROM ai_edit_requests WHERE id = ? AND user_id = ? AND chat_id = ?').run(requestId, userId, chatId);
      envelope = this.db.insertSyncEventInTx({
        userId,
        eventId: crypto.randomUUID(),
        type: 'edit_request.deleted',
        chatId,
        payload: { requestId },
        createdAt: now,
      });
      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }
    this.hub.broadcastPersistedEvent(envelope);
    return true;
  }

  reorderDrafts(userId: string, chatId: string, orderedIds: string[]): AiEditRequestRecord[] {
    this.assertChatOwner(userId, chatId);
    const baseTime = Date.now();
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      orderedIds.forEach((id, idx) => {
        this.db.db
          .prepare("UPDATE ai_edit_requests SET created_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND chat_id = ? AND status = 'draft'")
          .run(baseTime + idx, baseTime, id, userId, chatId);
      });
      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }
    return this.listRequests(userId, chatId, { status: 'draft' });
  }

  sendBatch(params: {
    userId: string;
    chatId: string;
    requestIds: string[];
    sentMessageId?: string | null;
  }): { batchId: string; requests: AiEditRequestRecord[] } {
    this.assertChatOwner(params.userId, params.chatId);
    if (params.requestIds.length === 0) {
      throw new ArtifactError('INVALID_INPUT', '送信対象の依頼が指定されていません。', 400);
    }

    const batchId = crypto.randomUUID();
    const now = Date.now();
    const updated: AiEditRequestRecord[] = [];
    let envelope;

    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.db
        .prepare('INSERT INTO ai_edit_request_batches (batch_id, user_id, chat_id, sent_message_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(batchId, params.userId, params.chatId, params.sentMessageId ?? null, now);

      for (const reqId of params.requestIds) {
        const req = this.getRequest(params.userId, params.chatId, reqId);
        if (!req) {
          throw new ArtifactError('NOT_FOUND', `編集依頼 '${reqId}' が見つかりません。`, 404);
        }
        this.db.db
          .prepare(
            `UPDATE ai_edit_requests
             SET status = 'sent', batch_id = ?, sent_message_id = ?, updated_at = ?
             WHERE id = ? AND user_id = ? AND chat_id = ?`
          )
          .run(batchId, params.sentMessageId ?? null, now, reqId, params.userId, params.chatId);
        updated.push(this.getRequest(params.userId, params.chatId, reqId)!);
      }

      envelope = this.db.insertSyncEventInTx({
        userId: params.userId,
        eventId: crypto.randomUUID(),
        type: 'edit_request.batch_sent',
        chatId: params.chatId,
        payload: { batchId, requests: updated },
        createdAt: now,
      });
      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }

    this.hub.broadcastPersistedEvent(envelope);
    return { batchId, requests: updated };
  }

  /**
   * Re-resolves a single edit request against the latest target content.
   */
  async resolveRequestTarget(req: AiEditRequestRecord): Promise<TargetResolutionResult> {
    if (req.targetKind === 'artifact' && req.artifactId) {
      return this.artifactService.resolveTargetOnArtifact(req.userId, req.artifactId, req.selector, req.baseRevision, req.selectedContentSnapshot);
    }
    if (req.targetKind === 'rich_block' && req.richBlockId) {
      const block = this.richContentService.getBlock(req.userId, req.chatId, req.richBlockId);
      if (!block) return { status: 'stale', reason: 'rich_block_deleted' };
      return resolveRichBlockTarget(block, req.selector);
    }
    return { status: 'stale', reason: 'missing_target_reference' };
  }

  /**
   * Returns strictly separated `userInstruction` and `untrustedTargetContent` for AI/MCP consumption (`PIN-05`).
   */
  async getForAgent(userId: string, chatId: string, requestId: string): Promise<AgentEditRequestPayload> {
    const req = this.getRequest(userId, chatId, requestId);
    if (!req) throw new ArtifactError('NOT_FOUND', '編集依頼が見つかりません。', 404);
    const reResolution = await this.resolveRequestTarget(req);
    let regionImagePngBase64: string | undefined;
    if (req.regionImageBlobSha256) {
      const buf = this.artifactService.blobManager.readBlob(userId, req.regionImageBlobSha256);
      if (buf) regionImagePngBase64 = buf.toString('base64');
    }
    return {
      id: req.id,
      targetKind: req.targetKind,
      artifactId: req.artifactId,
      richBlockId: req.richBlockId,
      format: req.format,
      baseRevision: req.baseRevision,
      status: req.status,
      userInstruction: req.instruction,
      untrustedTargetContent: {
        selectedContentSnapshot: req.selectedContentSnapshot,
        surroundingContext: req.surroundingContext,
      },
      selector: req.selector,
      range: req.range,
      contentCoords: req.contentCoords,
      reResolution,
      ...(regionImagePngBase64 ? { regionImagePngBase64 } : {}),
    };
  }

  /**
   * AI/MCP completion marker (`PIN-06`): strictly transitions ONLY to `applied_unverified`.
   * Automatic transition to `resolved` is strictly prohibited.
   */
  markAppliedByAgent(params: {
    userId: string;
    chatId: string;
    requestId: string;
    appliedRevision: number;
  }): AiEditRequestRecord {
    const existing = this.getRequest(params.userId, params.chatId, params.requestId);
    if (!existing) throw new ArtifactError('NOT_FOUND', '編集依頼が見つかりません。', 404);
    const now = Date.now();
    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.db
        .prepare(
          `UPDATE ai_edit_requests
           SET status = 'applied_unverified', applied_revision = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND chat_id = ?`
        )
        .run(params.appliedRevision, now, existing.id, params.userId, params.chatId);
      const updated = this.getRequest(params.userId, params.chatId, existing.id)!;
      envelope = this.db.insertSyncEventInTx({
        userId: params.userId,
        eventId: crypto.randomUUID(),
        type: 'edit_request.updated',
        chatId: params.chatId,
        payload: { editRequest: updated },
        createdAt: now,
      });
      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }
    this.hub.broadcastPersistedEvent(envelope);
    return this.getRequest(params.userId, params.chatId, existing.id)!;
  }

  /** User-only confirmation transitioning to `resolved` (`PIN-06`). */
  resolveByUser(userId: string, chatId: string, requestId: string): AiEditRequestRecord {
    const existing = this.getRequest(userId, chatId, requestId);
    if (!existing) throw new ArtifactError('NOT_FOUND', '編集依頼が見つかりません。', 404);
    const now = Date.now();
    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.db
        .prepare("UPDATE ai_edit_requests SET status = 'resolved', updated_at = ? WHERE id = ? AND user_id = ? AND chat_id = ?")
        .run(now, existing.id, userId, chatId);
      const updated = this.getRequest(userId, chatId, existing.id)!;
      envelope = this.db.insertSyncEventInTx({
        userId,
        eventId: crypto.randomUUID(),
        type: 'edit_request.updated',
        chatId,
        payload: { editRequest: updated },
        createdAt: now,
      });
      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }
    this.hub.broadcastPersistedEvent(envelope);
    return this.getRequest(userId, chatId, existing.id)!;
  }

  /** User re-confirms a `needs_review` request by re-anchoring its baseRevision and selector. */
  reconfirmByUser(params: {
    userId: string;
    chatId: string;
    requestId: string;
    newBaseRevision: number;
    newSelector?: TargetSelector;
  }): AiEditRequestRecord {
    const existing = this.getRequest(params.userId, params.chatId, params.requestId);
    if (!existing) throw new ArtifactError('NOT_FOUND', '編集依頼が見つかりません。', 404);
    const now = Date.now();
    const nextSelector = params.newSelector ?? { ...existing.selector, baseRevision: params.newBaseRevision };
    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.db
        .prepare(
          `UPDATE ai_edit_requests
           SET base_revision = ?, selector_json = ?, status = 'draft', updated_at = ?
           WHERE id = ? AND user_id = ? AND chat_id = ?`
        )
        .run(params.newBaseRevision, JSON.stringify(nextSelector), now, existing.id, params.userId, params.chatId);
      const updated = this.getRequest(params.userId, params.chatId, existing.id)!;
      envelope = this.db.insertSyncEventInTx({
        userId: params.userId,
        eventId: crypto.randomUUID(),
        type: 'edit_request.updated',
        chatId: params.chatId,
        payload: { editRequest: updated },
        createdAt: now,
      });
      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }
    this.hub.broadcastPersistedEvent(envelope);
    return this.getRequest(params.userId, params.chatId, existing.id)!;
  }

  async revalidateForArtifact(userId: string, artifactId: string, revision: number): Promise<AiEditRequestRecord[]> {
    const rows = this.db.db
      .prepare(
        `SELECT * FROM ai_edit_requests
         WHERE user_id = ? AND target_kind = 'artifact' AND artifact_id = ?
           AND status IN ('draft', 'sent', 'needs_review')`
      )
      .all(userId, artifactId) as Array<Record<string, unknown>>;

    const updated: AiEditRequestRecord[] = [];
    for (const r of rows) {
      const req = this.mapRow(r);
      if (this.db.getArtifact(userId, artifactId)?.revision !== revision) break;
      let res;
      try {
        res = await this.resolveRequestTarget(req);
      } catch {
        continue; // Resource contention is not evidence that the target changed.
      }
      if (this.db.getArtifact(userId, artifactId)?.revision !== revision) break;
      const current = this.getRequest(userId, req.chatId, req.id);
      if (!current || current.updatedAt !== req.updatedAt || current.status !== req.status ||
          current.baseRevision !== req.baseRevision || JSON.stringify(current.selector) !== JSON.stringify(req.selector)) continue;
      if (res.status === 'needs_review' || res.status === 'stale') {
        if (req.status !== res.status) {
          const now = Date.now();
          this.db.db
            .prepare('UPDATE ai_edit_requests SET status = ?, updated_at = ? WHERE id = ?')
            .run(res.status, now, req.id);
          const refreshed = this.getRequest(req.userId, req.chatId, req.id)!;
          this.hub.emitDurable({
            userId: req.userId,
            type: 'edit_request.updated',
            chatId: req.chatId,
            payload: { editRequest: refreshed, reResolution: res },
          });
          updated.push(refreshed);
        }
      }
    }
    return updated;
  }

  revalidateForRichBlock(userId: string, chatId: string, richBlockId: string): AiEditRequestRecord[] {
    const rows = this.db.db
      .prepare(
        `SELECT * FROM ai_edit_requests
         WHERE user_id = ? AND chat_id = ? AND target_kind = 'rich_block' AND rich_block_id = ?
           AND status IN ('draft', 'sent', 'needs_review')`
      )
      .all(userId, chatId, richBlockId) as Array<Record<string, unknown>>;

    const updated: AiEditRequestRecord[] = [];
    for (const r of rows) {
      const req = this.mapRow(r);
      const block = this.richContentService.getBlock(userId, chatId, richBlockId);
      const res = block ? resolveRichBlockTarget(block, req.selector) : { status: 'stale', reason: 'rich_block_deleted' };
      if (res.status === 'needs_review' || res.status === 'stale') {
        if (req.status !== res.status) {
          const now = Date.now();
          this.db.db
            .prepare('UPDATE ai_edit_requests SET status = ?, updated_at = ? WHERE id = ?')
            .run(res.status, now, req.id);
          const refreshed = this.getRequest(req.userId, req.chatId, req.id)!;
          this.hub.emitDurable({
            userId: req.userId,
            type: 'edit_request.updated',
            chatId: req.chatId,
            payload: { editRequest: refreshed, reResolution: res },
          });
          updated.push(refreshed);
        }
      }
    }
    return updated;
  }

  private mapRow(r: Record<string, unknown>): AiEditRequestRecord {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      chatId: String(r.chat_id),
      targetKind: String(r.target_kind) as 'artifact' | 'rich_block',
      artifactId: r.artifact_id ? String(r.artifact_id) : null,
      richBlockId: r.rich_block_id ? String(r.rich_block_id) : null,
      baseRevision: Number(r.base_revision),
      format: String(r.format),
      containerRef: JSON.parse(String(r.container_ref_json ?? '{}')) as Record<string, unknown>,
      selector: JSON.parse(String(r.selector_json)) as TargetSelector,
      range: r.range_json ? (JSON.parse(String(r.range_json)) as Record<string, unknown>) : null,
      contentCoords: r.content_coords_json ? (JSON.parse(String(r.content_coords_json)) as Record<string, unknown>) : null,
      selectedContentSnapshot: String(r.selected_content_snapshot ?? ''),
      surroundingContext: r.surrounding_context ? String(r.surrounding_context) : null,
      regionImageBlobSha256: r.region_image_blob_sha256 ? String(r.region_image_blob_sha256) : null,
      instruction: String(r.instruction),
      status: String(r.status) as EditRequestStatus,
      viewStateSnapshot: r.view_state_snapshot_json
        ? (JSON.parse(String(r.view_state_snapshot_json)) as Record<string, unknown>)
        : null,
      batchId: r.batch_id ? String(r.batch_id) : null,
      sentMessageId: r.sent_message_id ? String(r.sent_message_id) : null,
      appliedRevision:
        r.applied_revision !== null && r.applied_revision !== undefined ? Number(r.applied_revision) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
}
