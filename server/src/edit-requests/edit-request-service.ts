import crypto from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import type { SyncHub } from '../sync/hub.js';
import { detectArtifactFormat } from '../artifacts/adapters/registry.js';
import type { ArtifactService } from '../artifacts/artifact-service.js';
import { ArtifactError, unsupportedOperationError } from '../artifacts/errors.js';
import type { TargetResolutionResult, TargetSelector } from '../artifacts/types.js';
import { selectorMatchesFormat, targetSelectorSchema } from '../artifacts/target-selector-schema.js';
import type { RichContentService } from '../rich/rich-content-service.js';
import { RichExprError } from '../rich/rich-expr-evaluator.js';
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
  sortOrder: number;
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
  targetRevision: number | null;
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

interface TargetDetails {
  range?: Record<string, unknown> | null;
  contentCoords?: Record<string, unknown> | null;
  selectedContentSnapshot?: string;
  surroundingContext?: string | null;
  viewStateSnapshot?: Record<string, unknown> | null;
}

type TargetReference = Pick<AiEditRequestRecord, 'userId' | 'chatId' | 'targetKind' | 'artifactId' | 'richBlockId' | 'format'>;
type AnchoredTarget = TargetReference & Pick<AiEditRequestRecord, 'baseRevision' | 'selector'> &
  Partial<Pick<AiEditRequestRecord, 'viewStateSnapshot'>>;

function readRichViewSnapshot(snapshot: Record<string, unknown> | null | undefined) {
  if (snapshot && (snapshot.theme === 'dark' || snapshot.theme === 'light') &&
      snapshot.state && typeof snapshot.state === 'object' && !Array.isArray(snapshot.state)) {
    return { theme: snapshot.theme as 'light' | 'dark', state: snapshot.state as Record<string, unknown> };
  }
  return { theme: 'light' as const, state: snapshot ?? {} };
}

function selectorIsValid(target: AnchoredTarget): boolean {
  return targetSelectorSchema.safeParse(target.selector).success &&
    target.selector.baseRevision === target.baseRevision &&
    selectorMatchesFormat(target.selector, target.format) &&
    (target.targetKind === 'artifact' ? target.artifactId !== null :
      target.richBlockId !== null && target.richBlockId === target.selector.blockId);
}

function targetConflict(): ArtifactError {
  return new ArtifactError('TARGET_CONTENT_DRIFT', '対象が変更されました。最新の版で対象を選び直してください。', 409);
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
    // Older clients could persist a selector without its content fingerprint.
    const legacyRows = this.db.db.prepare(`SELECT * FROM ai_edit_requests
      WHERE status IN ('draft', 'sent', 'stale')`).all();
    for (const row of legacyRows) {
      const request = this.mapRow(row);
      if (!selectorIsValid(request)) {
        this.persistRevalidation(request, { status: 'needs_review', reason: 'invalid_target_selector' });
      }
    }
    // Automatically re-validate open edit requests whenever an artifact is updated
    this.artifactService.onArtifactUpdated((artifact) => {
      if (artifact.scopeKind === 'chat' && artifact.chatId) {
        void this.revalidateForArtifact(artifact.userId, artifact.id, artifact.revision).catch(() => {});
      }
    });
    this.richContentService.onTargetChanged(block => {
      this.revalidateForRichBlock(block.userId, block.chatId, block.id);
    });
  }

  private assertChatOwner(userId: string, chatId: string): void {
    const chat = this.db.getChat(userId, chatId);
    if (!chat) {
      throw new ArtifactError('NOT_FOUND', 'チャットが見つからないか権限がありません。', 404);
    }
  }

  private currentRevision(target: TargetReference): number | undefined {
    if (target.targetKind === 'artifact' && target.artifactId) {
      const artifact = this.db.getArtifact(target.userId, target.artifactId);
      if (artifact?.scopeKind === 'chat' && !artifact.deletedOnDisk && artifact.chatId === target.chatId) return artifact.revision;
    } else if (target.richBlockId) {
      return this.richContentService.getBlock(target.userId, target.chatId, target.richBlockId)?.revision;
    }
    return undefined;
  }

  private async verifyAnchor(target: AnchoredTarget, details: TargetDetails): Promise<TargetDetails & { selector: TargetSelector }> {
    if (!selectorIsValid(target)) throw new ArtifactError('INVALID_INPUT', '対象指定が無効です。', 400);
    if (this.currentRevision(target) !== target.baseRevision) throw targetConflict();
    const savedState = target.richBlockId
      ? this.richContentService.getBlock(target.userId, target.chatId, target.richBlockId)?.uiStateSnapshot
      : null;
    const viewStateSnapshot = target.richBlockId ? readRichViewSnapshot(details.viewStateSnapshot ?? savedState) : null;
    const result = await this.resolveRequestTarget({ ...target, viewStateSnapshot });
    if (result.status !== 'resolved') throw targetConflict();
    const positions = [['startLine', 'startLine'], ['blockIndex', 'resolvedBlockIndex']] as const;
    for (const [selectorField, resolvedField] of positions) {
      if (target.selector[selectorField] !== undefined && result.resolvedRange?.[resolvedField] !== undefined &&
          target.selector[selectorField] !== result.resolvedRange[resolvedField]) throw targetConflict();
    }
    const selector = target.selector.kind === 'rich_table_cell' && result.resolvedRange
      ? { ...target.selector, expectedRowHash: result.resolvedRange.rowHash, expectedRowOrderHash: result.resolvedRange.rowOrderHash }
      : target.selector;
    return {
      ...details,
      selector,
      viewStateSnapshot,
      selectedContentSnapshot: (result.resolvedSnippet ?? details.selectedContentSnapshot)?.slice(0, 50_000),
      surroundingContext: (result.surroundingContext ?? details.surroundingContext)?.slice(0, 20_000),
      range: result.resolvedRange ?? null,
      contentCoords: result.resolvedCoords ?? null,
    };
  }

  private assertCurrentRequest(expected: AiEditRequestRecord): void {
    const current = this.getRequest(expected.userId, expected.chatId, expected.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new ArtifactError('EDIT_REQUEST_CHANGED', '編集依頼が変更されました。', 409);
    }
  }

  private requireStatus(request: AiEditRequestRecord, ...allowed: EditRequestStatus[]): void {
    if (!allowed.includes(request.status)) {
      throw new ArtifactError('EDIT_REQUEST_INVALID_STATUS', '現在の状態ではこの操作を実行できません。', 409);
    }
  }

  async createRequest(params: TargetDetails & {
    userId: string;
    chatId: string;
    targetKind: 'artifact' | 'rich_block';
    artifactId?: string | null;
    richBlockId?: string | null;
    baseRevision?: number;
    selector: Record<string, unknown>;
    instruction: string;
  }): Promise<AiEditRequestRecord> {
    this.assertChatOwner(params.userId, params.chatId);
    const instruction = params.instruction.trim();
    if (!instruction) {
      throw new ArtifactError('INVALID_INPUT', '修正指示を入力してください。', 400);
    }

    let format = 'rich_block';
    const baseRevision = params.baseRevision ?? params.selector.baseRevision;
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
    } else if (params.targetKind === 'rich_block') {
      if (!params.richBlockId) {
        throw new ArtifactError('INVALID_INPUT', 'richBlockId が必要です。', 400);
      }
      const block = this.richContentService.getBlock(params.userId, params.chatId, params.richBlockId);
      if (!block) {
        throw new ArtifactError('NOT_FOUND', '対象リッチブロックがこのチャットに見つかりません。', 404);
      }
      richBlockId = block.id;
    } else {
      throw new ArtifactError('INVALID_INPUT', '対象の種別が無効です。', 400);
    }

    const parsedSelector = targetSelectorSchema.safeParse({ baseRevision, ...params.selector });
    if (!parsedSelector.success || typeof baseRevision !== 'number') {
      throw new ArtifactError('INVALID_INPUT', '対象指定または対象の版が無効です。', 400);
    }
    const selector = parsedSelector.data;
    const target = { ...params, artifactId, richBlockId, format, baseRevision, selector };
    const version = this.currentRevision(target);
    const details = await this.verifyAnchor(target, params);

    const id = crypto.randomUUID();
    const now = Date.now();
    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      if (this.currentRevision(target) !== version) throw targetConflict();
      const sortOrder = this.nextSortOrder(params.userId, params.chatId);
      this.db.db
        .prepare(
          `INSERT INTO ai_edit_requests (
             id, user_id, chat_id, target_kind, artifact_id, rich_block_id, base_revision, format,
             container_ref_json, selector_json, range_json, content_coords_json,
             selected_content_snapshot, surrounding_context, region_image_blob_sha256,
             instruction, status, view_state_snapshot_json, batch_id, sent_message_id, applied_revision,
             created_at, updated_at, sort_order
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, NULL, ?, ?, ?)`
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
          JSON.stringify(details.selector),
          details.range ? JSON.stringify(details.range) : null,
          details.contentCoords ? JSON.stringify(details.contentCoords) : null,
          details.selectedContentSnapshot ?? '',
          details.surroundingContext ?? null,
          null,
          instruction,
          details.viewStateSnapshot ? JSON.stringify(details.viewStateSnapshot) : null,
          now,
          now,
          sortOrder
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
      .prepare(`SELECT * FROM ai_edit_requests WHERE ${clauses.join(' AND ')} ORDER BY sort_order, created_at, id`)
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async updateRequest(params: TargetDetails & {
    userId: string;
    chatId: string;
    requestId: string;
    instruction?: string;
    selector?: TargetSelector;
  }): Promise<AiEditRequestRecord> {
    const existing = this.getRequest(params.userId, params.chatId, params.requestId);
    if (!existing) throw new ArtifactError('NOT_FOUND', '編集依頼が見つかりません。', 404);
    this.requireStatus(existing, 'draft');
    const instruction = params.instruction?.trim() ?? existing.instruction;
    if (!instruction) throw new ArtifactError('INVALID_INPUT', '修正指示を入力してください。', 400);
    if (params.selector) {
      const selector = { baseRevision: existing.baseRevision, ...params.selector };
      return this.writeAnchor(existing, { ...existing, selector }, params, instruction);
    }
    if (!selectorIsValid(existing)) throw targetConflict();
    const version = this.currentRevision(existing);
    if ((await this.resolveRequestTarget(existing)).status !== 'resolved') throw targetConflict();
    return this.updateAndPublish(existing, () => {
      this.assertCurrentRequest(existing);
      if (this.currentRevision(existing) !== version) throw targetConflict();
      this.db.db.prepare('UPDATE ai_edit_requests SET instruction = ?, updated_at = ? WHERE id = ?')
        .run(instruction, Date.now(), existing.id);
    });
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

  private nextSortOrder(userId: string, chatId: string): number {
    const row = this.db.db.prepare('SELECT MAX(sort_order) AS current FROM ai_edit_requests WHERE user_id = ? AND chat_id = ?')
      .get(userId, chatId);
    return Number(row?.current ?? 0) + 1;
  }

  reorderDrafts(userId: string, chatId: string, orderedIds: string[]): AiEditRequestRecord[] {
    this.assertChatOwner(userId, chatId);
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new ArtifactError('INVALID_INPUT', '同一の編集依頼を複数回指定できません。', 400);
    }
    const now = Date.now();
    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      const drafts = this.listRequests(userId, chatId, { status: 'draft' });
      const selected = new Set(orderedIds);
      const slots = drafts.filter(request => selected.has(request.id));
      if (slots.length !== orderedIds.length || slots.some(request =>
        request.artifactId !== slots[0].artifactId || request.richBlockId !== slots[0].richBlockId)) {
        throw new ArtifactError('EDIT_REQUEST_INVALID_ORDER', '同じ対象の未送信依頼を指定してください。', 409);
      }
      if (slots.some((slot, index) => slot.id !== orderedIds[index])) {
        const update = this.db.db.prepare('UPDATE ai_edit_requests SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ? AND chat_id = ?');
        orderedIds.forEach((id, index) => update.run(slots[index].sortOrder, now, id, userId, chatId));
        envelope = this.db.insertSyncEventInTx({
          userId, eventId: crypto.randomUUID(), type: 'edit_request.reordered', chatId,
          payload: { requests: orderedIds.map(id => this.getRequest(userId, chatId, id)!) }, createdAt: now,
        });
      }
      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }
    if (envelope) this.hub.broadcastPersistedEvent(envelope);
    return this.listRequests(userId, chatId, { status: 'draft' });
  }

  async sendBatch(params: {
    userId: string;
    chatId: string;
    requestIds: string[];
    sentMessageId?: string | null;
    submit?: {
      clientMessageId: string;
      enqueue: (text: string, persist: (messageId: string) => ReturnType<AppDatabase['insertSyncEventInTx']>) => void;
    };
  }): Promise<{ batchId: string; requests: AiEditRequestRecord[] }> {
    this.assertChatOwner(params.userId, params.chatId);
    if (!params.requestIds.length || new Set(params.requestIds).size !== params.requestIds.length) {
      throw new ArtifactError('INVALID_INPUT', '送信対象の依頼を重複せずに指定してください。', 400);
    }
    const replay = () => {
      if (!params.submit) return null;
      const message = this.db.findMessageByClientId(params.userId, params.chatId, params.submit.clientMessageId);
      if (!message) return null;
      const batch = this.db.db.prepare('SELECT batch_id FROM ai_edit_request_batches WHERE user_id = ? AND chat_id = ? AND sent_message_id = ?')
        .get(params.userId, params.chatId, message.id);
      const requests = batch ? this.listRequests(params.userId, params.chatId).filter(request => request.batchId === batch.batch_id) : [];
      if (!batch || requests.length !== params.requestIds.length ||
          requests.some(request => !params.requestIds.includes(request.id))) {
        throw new ArtifactError('EDIT_REQUEST_CHANGED', '送信済みの編集依頼と一致しません。', 409);
      }
      return { batchId: String(batch.batch_id), requests };
    };
    const prior = replay();
    if (prior) return prior;
    const checked: Array<{ request: AiEditRequestRecord; version: number | undefined }> = [];
    for (const id of params.requestIds) {
      const request = this.getRequest(params.userId, params.chatId, id);
      if (!request) throw new ArtifactError('NOT_FOUND', `編集依頼 '${id}' が見つかりません。`, 404);
      if (request.status !== 'draft') {
        const existingBatch = replay();
        if (existingBatch) return existingBatch;
        this.requireStatus(request, 'draft');
      }
      const revision = this.currentRevision(request);
      const version = this.currentRevision(request);
      const resolution = await this.resolveRequestTarget(request);
      if (resolution.status !== 'resolved') {
        this.persistRevalidation(request, resolution, revision);
        throw targetConflict();
      }
      checked.push({ request, version });
    }

    if (checked.some(({ request }) => request.artifactId !== checked[0].request.artifactId ||
        request.richBlockId !== checked[0].request.richBlockId)) {
      throw new ArtifactError('INVALID_INPUT', '同じ対象の編集依頼を指定してください。', 400);
    }
    const batchId = crypto.randomUUID();
    const now = Date.now();
    const updated: AiEditRequestRecord[] = [];
    const completedWhileChecking = replay();
    if (completedWhileChecking) return completedWhileChecking;
    const persist = (sentMessageId: string | null) => {
      this.db.db
        .prepare('INSERT INTO ai_edit_request_batches (batch_id, user_id, chat_id, sent_message_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(batchId, params.userId, params.chatId, sentMessageId, now);

      for (const { request, version } of checked) {
        this.assertCurrentRequest(request);
        this.requireStatus(request, 'draft');
        if (this.currentRevision(request) !== version) throw targetConflict();
        const reqId = request.id;
        this.db.db
          .prepare(
            `UPDATE ai_edit_requests
             SET status = 'sent', batch_id = ?, sent_message_id = ?, updated_at = ?
             WHERE id = ? AND user_id = ? AND chat_id = ?`
          )
          .run(batchId, sentMessageId, now, reqId, params.userId, params.chatId);
        updated.push(this.getRequest(params.userId, params.chatId, reqId)!);
      }

      return this.db.insertSyncEventInTx({
        userId: params.userId,
        eventId: crypto.randomUUID(),
        type: 'edit_request.batch_sent',
        chatId: params.chatId,
        payload: { batchId, requests: updated },
        createdAt: now,
      });
    };

    if (params.submit) {
      const text = '次の対象指定の編集依頼を適用してください。\n' +
        checked.map(({ request }) => `${request.id}\n${request.instruction}`).join('\n\n');
      params.submit.enqueue(text, persist);
    } else {
      this.db.db.exec('BEGIN IMMEDIATE;');
      let envelope;
      try {
        envelope = persist(params.sentMessageId ?? null);
        this.db.db.exec('COMMIT;');
      } catch (error) {
        this.db.db.exec('ROLLBACK;');
        throw error;
      }
      this.hub.broadcastPersistedEvent(envelope);
    }
    return { batchId, requests: updated };
  }

  /**
   * Re-resolves a single edit request against the latest target content.
   */
  async resolveRequestTarget(
    req: AnchoredTarget & { selectedContentSnapshot?: string },
    snippetHint = req.selectedContentSnapshot,
  ): Promise<TargetResolutionResult> {
    if (!selectorIsValid(req)) return { status: 'needs_review', reason: 'invalid_target_selector' };
    if (req.targetKind === 'rich_block') return this.resolveRichRequestTarget(req);
    const revision = this.currentRevision(req);
    if (revision === undefined || !req.artifactId) return { status: 'stale', reason: 'target_deleted' };
    return this.artifactService.resolveTargetOnArtifact(req.userId, req.artifactId, req.selector, req.baseRevision, snippetHint);
  }

  private resolveRichRequestTarget(req: AnchoredTarget): TargetResolutionResult {
    if (!selectorIsValid(req) || !req.richBlockId) return { status: 'needs_review', reason: 'invalid_target_selector' };
    const block = this.richContentService.getBlock(req.userId, req.chatId, req.richBlockId);
    if (!block) return { status: 'stale', reason: 'rich_block_deleted' };
    if (req.baseRevision > block.revision || (block.revision !== req.baseRevision && !this.db.db.prepare(
      'SELECT 1 FROM rich_block_revisions WHERE rich_block_id = ? AND user_id = ? AND chat_id = ? AND revision = ?'
    ).get(block.id, req.userId, req.chatId, req.baseRevision))) {
      return { status: 'needs_review', reason: 'invalid_base_revision' };
    }
    try {
      return resolveRichBlockTarget(block, req.selector, readRichViewSnapshot(req.viewStateSnapshot),
        this.richContentService.getAuthorizedArtifactIds(req.userId, req.chatId));
    } catch (error) {
      if (error instanceof RichExprError) return { status: 'needs_review', reason: 'rich_target_evaluation_failed' };
      throw error;
    }
  }

  private agentBaseRevision(request: AiEditRequestRecord): number | null {
    const row = this.db.db.prepare('SELECT agent_base_revision FROM ai_edit_requests WHERE id = ?').get(request.id);
    return typeof row?.agent_base_revision === 'number' ? row.agent_base_revision : null;
  }

  private hasAgentLineage(request: AiEditRequestRecord, revision: number): boolean {
    const base = this.agentBaseRevision(request);
    if (base === null || revision <= base) return false;
    const query = request.artifactId
      ? `SELECT actor_kind, actor_id, parent_revision, revision,
           json_extract(operation_payload_json, '$.editRequestIds') AS request_ids
         FROM artifact_revisions WHERE user_id = ? AND chat_id = ? AND artifact_id = ? AND revision > ? AND revision <= ?
         ORDER BY revision`
      : `SELECT actor_kind, actor_id, revision - 1 AS parent_revision, revision, edit_request_ids_json AS request_ids
         FROM rich_block_revisions WHERE user_id = ? AND chat_id = ? AND rich_block_id = ? AND revision > ? AND revision <= ?
         ORDER BY revision`;
    const rows = this.db.db.prepare(query).all(request.userId, request.chatId,
      request.artifactId ?? request.richBlockId, base, revision);
    return rows.length === revision - base && rows.every((row, i) =>
      row.actor_kind === 'ai' && row.actor_id === request.userId &&
      row.parent_revision === base + i && row.revision === base + i + 1 &&
      typeof row.request_ids === 'string' && this.revisionIncludesRequest(row.request_ids, request.id));
  }

  private revisionIncludesRequest(json: string, requestId: string): boolean {
    try {
      const ids: unknown = JSON.parse(json);
      return Array.isArray(ids) && ids.includes(requestId);
    } catch {
      return false;
    }
  }

  assertAgentMutation(params: {
    userId: string; chatId: string; targetId: string; targetKind: TargetReference['targetKind'];
    expectedRevision: number; editRequestIds?: string[];
  }): void {
    for (const id of params.editRequestIds ?? []) {
      const request = this.getRequest(params.userId, params.chatId, id);
      if (!request?.batchId || request.status !== 'sent' || request.targetKind !== params.targetKind ||
          (request.artifactId ?? request.richBlockId) !== params.targetId ||
          this.currentRevision(request) !== params.expectedRevision ||
          (this.agentBaseRevision(request) !== params.expectedRevision && !this.hasAgentLineage(request, params.expectedRevision))) {
        throw targetConflict();
      }
    }
  }

  /**
   * Returns strictly separated `userInstruction` and `untrustedTargetContent` for AI/MCP consumption (`PIN-05`).
   */
  async getForAgent(userId: string, chatId: string, requestId: string): Promise<AgentEditRequestPayload> {
    const req = this.getRequest(userId, chatId, requestId);
    if (!req?.batchId) throw new ArtifactError('NOT_FOUND', '送信済みの編集依頼が見つかりません。', 404);
    const revision = this.currentRevision(req);
    const inProgress = req.status === 'sent' && revision !== undefined && this.hasAgentLineage(req, revision) &&
      (!req.artifactId || this.artifactService.matchesCurrentArtifactFile(userId, req.artifactId, revision));
    let reResolution: TargetResolutionResult = inProgress
      ? { status: 'resolved', reason: 'request_edit_in_progress' }
      : req.status === 'applied_unverified' || req.status === 'resolved'
        ? this.appliedTargetResolution(req, revision)
        : await this.resolveRequestTarget(req);
    this.assertCurrentRequest(req);
    if (this.currentRevision(req) !== revision) throw targetConflict();
    let status = req.status;
    if (req.status === 'sent' && !inProgress && reResolution.status === 'resolved') {
      this.db.db.prepare('UPDATE ai_edit_requests SET agent_base_revision = ? WHERE id = ? AND status = ?')
        .run(revision ?? null, req.id, 'sent');
    } else if (req.status !== 'resolved' && !inProgress && reResolution.status !== 'resolved') {
      status = this.persistRevalidation(req, reResolution, revision)?.status ?? req.status;
    }
    if ((status === 'needs_review' || status === 'stale') && reResolution.status === 'resolved') {
      reResolution = { status, reason: 'target_reconfirmation_required' };
    }
    let regionImagePngBase64: string | undefined;
    if (status === 'sent' && !inProgress && req.artifactId && revision !== undefined && reResolution.status === 'resolved') {
      let png: Buffer | null = null;
      try {
        png = await this.artifactService.renderTargetRegion(userId, req.artifactId, revision, req.selector, reResolution);
      } catch (error) {
        if (!(error instanceof ArtifactError) ||
            !['RESOURCE_BUSY', 'DOCUMENT_WORKER_REJECTED', 'DOC_WORKER_INPUT_TOO_LARGE', 'INVALID_RENDER_IMAGE'].includes(error.code)) throw error;
      }
      this.assertCurrentRequest(req);
      if (this.currentRevision(req) !== revision) throw targetConflict();
      if (png && !this.artifactService.matchesCurrentArtifactFile(userId, req.artifactId, revision)) throw targetConflict();
      if (png) regionImagePngBase64 = png.toString('base64');
    }
    return {
      id: req.id,
      targetKind: req.targetKind,
      artifactId: req.artifactId,
      richBlockId: req.richBlockId,
      format: req.format,
      baseRevision: req.baseRevision,
      targetRevision: revision ?? null,
      status,
      userInstruction: req.instruction,
      untrustedTargetContent: {
        selectedContentSnapshot: reResolution.resolvedSnippet?.slice(0, 50_000) ?? req.selectedContentSnapshot,
        surroundingContext: reResolution.surroundingContext?.slice(0, 20_000) ?? req.surroundingContext,
      },
      selector: req.selector,
      range: reResolution.resolvedRange ?? null,
      contentCoords: reResolution.resolvedCoords ?? null,
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
    if ((existing.status === 'applied_unverified' || existing.status === 'resolved') &&
        existing.appliedRevision === params.appliedRevision) return existing;
    return this.updateAndPublish(existing, () => {
      this.assertCurrentRequest(existing);
      if (existing.status !== 'sent') {
        throw new ArtifactError('EDIT_REQUEST_NOT_SENT', '送信済みの編集依頼だけが適用を記録できます。', 409);
      }
      if (!Number.isSafeInteger(params.appliedRevision) || params.appliedRevision < existing.baseRevision ||
          params.appliedRevision !== this.currentRevision(existing) ||
          !this.hasAgentLineage(existing, params.appliedRevision) ||
          (existing.artifactId && !this.artifactService.matchesCurrentArtifactFile(existing.userId, existing.artifactId, params.appliedRevision))) {
        throw targetConflict();
      }
      this.db.db.prepare(`UPDATE ai_edit_requests
        SET status = 'applied_unverified', applied_revision = ?, updated_at = ? WHERE id = ?`)
        .run(params.appliedRevision, Date.now(), existing.id);
    });
  }

  private appliedTargetResolution(request: AiEditRequestRecord, revision = this.currentRevision(request)): TargetResolutionResult {
    if (request.status === 'resolved' || revision === request.appliedRevision) return { status: 'resolved' };
    return revision === undefined ? { status: 'stale', reason: 'target_deleted' }
      : { status: 'needs_review', reason: 'revision_changed_after_application' };
  }

  /** User-only confirmation transitioning to `resolved` (`PIN-06`). */
  resolveByUser(userId: string, chatId: string, requestId: string): AiEditRequestRecord {
    const existing = this.getRequest(userId, chatId, requestId);
    if (!existing) throw new ArtifactError('NOT_FOUND', '編集依頼が見つかりません。', 404);
    return this.updateAndPublish(existing, () => {
      this.assertCurrentRequest(existing);
      this.requireStatus(existing, 'applied_unverified');
      if (this.currentRevision(existing) !== existing.appliedRevision) throw targetConflict();
      this.db.db.prepare("UPDATE ai_edit_requests SET status = 'resolved', updated_at = ? WHERE id = ?")
        .run(Date.now(), existing.id);
    });
  }

  async reconfirmByUser(params: TargetDetails & {
    userId: string;
    chatId: string;
    requestId: string;
    newBaseRevision: number;
    newSelector: TargetSelector;
  }): Promise<AiEditRequestRecord> {
    const existing = this.getRequest(params.userId, params.chatId, params.requestId);
    if (!existing) throw new ArtifactError('NOT_FOUND', '編集依頼が見つかりません。', 404);
    this.requireStatus(existing, 'needs_review', 'stale');
    const selector = { baseRevision: params.newBaseRevision, ...params.newSelector };
    return this.writeAnchor(existing, { ...existing, baseRevision: params.newBaseRevision, selector }, params, existing.instruction);
  }

  private async writeAnchor(existing: AiEditRequestRecord, target: AnchoredTarget, input: TargetDetails, instruction: string) {
    const version = this.currentRevision(target);
    const details = await this.verifyAnchor(target, input);
    return this.updateAndPublish(existing, () => {
      this.assertCurrentRequest(existing);
      if (this.currentRevision(target) !== version) throw targetConflict();
      this.db.db.prepare(`UPDATE ai_edit_requests SET
        base_revision = ?, selector_json = ?, range_json = ?, content_coords_json = ?,
        selected_content_snapshot = ?, surrounding_context = ?, region_image_blob_sha256 = ?,
        view_state_snapshot_json = ?, instruction = ?, status = 'draft', batch_id = NULL,
        sent_message_id = NULL, applied_revision = NULL, agent_base_revision = NULL, updated_at = ? WHERE id = ?`).run(
        target.baseRevision, JSON.stringify(details.selector),
        details.range ? JSON.stringify(details.range) : null,
        details.contentCoords ? JSON.stringify(details.contentCoords) : null,
        details.selectedContentSnapshot ?? '', details.surroundingContext ?? null, null,
        details.viewStateSnapshot ? JSON.stringify(details.viewStateSnapshot) : null,
        instruction, Date.now(), existing.id,
      );
    });
  }

  private updateAndPublish(request: AiEditRequestRecord, update: () => void, resolution?: TargetResolutionResult) {
    let refreshed: AiEditRequestRecord;
    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      update();
      refreshed = this.getRequest(request.userId, request.chatId, request.id)!;
      envelope = this.db.insertSyncEventInTx({
        userId: request.userId,
        eventId: crypto.randomUUID(),
        type: 'edit_request.updated',
        chatId: request.chatId,
        payload: { editRequest: refreshed, ...(resolution ? { reResolution: resolution } : {}) },
        createdAt: refreshed.updatedAt,
      });
      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }
    this.hub.broadcastPersistedEvent(envelope);
    return refreshed;
  }

  private persistRevalidation(request: AiEditRequestRecord, resolution: TargetResolutionResult, revision = this.currentRevision(request)) {
    if (resolution.status === 'resolved' || request.status === resolution.status ||
        (request.status === 'sent' && revision !== undefined &&
          !['revision_content_changed', 'artifact_file_missing', 'file_changed_during_resolution'].includes(resolution.reason ?? '') &&
          this.hasAgentLineage(request, revision))) return null;
    try {
      return this.updateAndPublish(request, () => {
        this.assertCurrentRequest(request);
        if (this.currentRevision(request) !== revision) throw targetConflict();
        this.db.db.prepare('UPDATE ai_edit_requests SET status = ?, updated_at = ? WHERE id = ?')
          .run(resolution.status, Date.now(), request.id);
      }, resolution);
    } catch (error) {
      if (error instanceof ArtifactError && ['EDIT_REQUEST_CHANGED', 'TARGET_CONTENT_DRIFT'].includes(error.code)) return null;
      throw error;
    }
  }

  async revalidateForArtifact(userId: string, artifactId: string, revision: number): Promise<AiEditRequestRecord[]> {
    const rows = this.db.db.prepare(`SELECT * FROM ai_edit_requests
      WHERE user_id = ? AND target_kind = 'artifact' AND artifact_id = ?
        AND status IN ('draft', 'sent', 'needs_review', 'applied_unverified')`).all(userId, artifactId);
    const updated: AiEditRequestRecord[] = [];
    for (const row of rows) {
      const request = this.mapRow(row);
      if (this.currentRevision(request) !== revision) break;
      let resolution;
      try {
        resolution = request.status === 'applied_unverified'
          ? this.appliedTargetResolution(request, revision) : await this.resolveRequestTarget(request);
      } catch {
        continue; // Resource contention is not evidence that the target changed.
      }
      const refreshed = this.persistRevalidation(request, resolution, revision);
      if (refreshed) updated.push(refreshed);
    }
    return updated;
  }

  revalidateForRichBlock(userId: string, chatId: string, richBlockId: string): AiEditRequestRecord[] {
    const rows = this.db.db.prepare(`SELECT * FROM ai_edit_requests
      WHERE user_id = ? AND chat_id = ? AND target_kind = 'rich_block' AND rich_block_id = ?
        AND status IN ('draft', 'sent', 'needs_review', 'applied_unverified')`).all(userId, chatId, richBlockId);
    const updated: AiEditRequestRecord[] = [];
    for (const row of rows) {
      const request = this.mapRow(row);
      const resolution = request.status === 'applied_unverified'
        ? this.appliedTargetResolution(request) : this.resolveRichRequestTarget(request);
      const refreshed = this.persistRevalidation(request, resolution);
      if (refreshed) updated.push(refreshed);
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
      sortOrder: Number(r.sort_order),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
}
