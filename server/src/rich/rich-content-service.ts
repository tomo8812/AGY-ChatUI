import crypto from 'node:crypto';
import type {
  RichBindingState,
  RichBlockRecord,
  RichDocumentV1,
  RichNode,
  RichStateValue,
} from '../../../shared/rich-schema.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { SyncHub } from '../sync/hub.js';
import type { ArtifactRecord } from '../types.js';
import { RICH_PERMITTED_FUNCTIONS } from './rich-expr-evaluator.js';
import {
  RICH_LIMITS,
  validateRichDocument,
  validateSafeFilename,
  type RichValidationResult,
} from './rich-validator.js';

export class RichContentError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'RichContentError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface RichArtifactSaveGateway {
  createArtifact(params: {
    userId: string;
    scopeKind: 'chat';
    chatId: string;
    relPath: string;
    content: Buffer;
    actorKind: 'user' | 'ai' | 'system';
    actorId?: string | null;
    idempotencyKey?: string;
    operationSummary?: string;
  }): Promise<{ artifact: ArtifactRecord; noOp?: boolean }>;
}

export class RichContentService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: SyncHub,
    private readonly artifactGateway?: RichArtifactSaveGateway
  ) {}

  getCapabilities() {
    return {
      schemaVersion: 1,
      runtimeMode: 'pure_js',
      requiresBwrap: false,
      limits: RICH_LIMITS,
      permittedFunctions: [...RICH_PERMITTED_FUNCTIONS],
      nodeTypes: {
        layout: [
          'stack',
          'grid',
          'columns',
          'container',
          'card',
          'divider',
          'spacer',
          'scroll_area',
          'carousel',
          'responsive_box',
        ],
        display: [
          'text',
          'caption',
          'note',
          'quote',
          'emphasis',
          'heading',
          'markdown',
          'icon',
          'badge',
          'status',
          'stat',
          'kpi_card',
          'progress',
          'list',
          'checklist',
          'steps',
          'timeline',
          'data_table',
          'source_attribution',
        ],
        diagram: ['mermaid', 'svg_scene', 'node_edge_diagram'],
        chart: ['chart'],
        control: [
          'button',
          'clickable',
          'selectable_card',
          'text_input',
          'textarea',
          'number_input',
          'slider',
          'checkbox',
          'toggle',
          'radio_group',
          'select',
          'segmented',
          'date_input',
          'tabs',
          'collapsible',
          'popover',
          'tooltip',
          'form',
        ],
        mediaDoc: ['editable_draft', 'code_block', 'diff_block', 'math_block', 'media_asset'],
      },
      stateActions: ['set_state', 'toggle_state', 'increment_state', 'reset_state'],
      sideEffectActions: [
        'copy_text',
        'open_external_url',
        'open_artifact',
        'save_to_artifact',
        'submit_to_chat',
        'start_pin_edit',
      ],
    };
  }

  private getAuthorizedArtifactIds(userId: string, chatId: string): Set<string> {
    const list = this.db.listArtifactsForChat(userId, chatId);
    return new Set(list.map((a) => a.id));
  }

  private assertChatOwner(userId: string, chatId: string): void {
    const chat = this.db.getChat(userId, chatId);
    if (!chat) {
      throw new RichContentError('NOT_FOUND', 'チャットが見つからないかアクセス権がありません。', 404);
    }
  }

  /**
   * Computes total persisted UTF-8 bytes across BOTH current `rich_blocks`
   * (`document_json` + `ui_state_snapshot_json`) AND all historical `rich_block_revisions` (`document_json`)
   * for the specified user (`PERF-05`).
   */
  getUserRichStorageBytes(userId: string): number {
    const blocksRow = this.db.db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(CAST(document_json AS BLOB)) + COALESCE(LENGTH(CAST(ui_state_snapshot_json AS BLOB)), 0)), 0) AS total
         FROM rich_blocks
         WHERE user_id = ?`
      )
      .get(userId) as { total: number };
    const revisionsRow = this.db.db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(CAST(document_json AS BLOB))), 0) AS total
         FROM rich_block_revisions
         WHERE user_id = ?`
      )
      .get(userId) as { total: number };
    return Number(blocksRow.total ?? 0) + Number(revisionsRow.total ?? 0);
  }

  private assertUserQuotaDelta(userId: string, deltaBytes: number): void {
    const maxBytes = this.config.richContentMaxMb * 1024 * 1024;
    const currentTotal = this.getUserRichStorageBytes(userId);
    if (currentTotal + Math.max(0, deltaBytes) > maxBytes) {
      throw new RichContentError(
        'RICH_QUOTA_EXCEEDED',
        `リッチコンテンツの保存容量上限（${this.config.richContentMaxMb}MB）を超過します。`,
        413,
        {
          currentBytes: currentTotal,
          deltaBytes: Math.max(0, deltaBytes),
          maxBytes,
        }
      );
    }
  }

  validateDocument(userId: string, chatId: string | null, document: unknown): RichValidationResult {
    let authorizedArtifactIds: Set<string> | undefined;
    if (chatId) {
      this.assertChatOwner(userId, chatId);
      authorizedArtifactIds = this.getAuthorizedArtifactIds(userId, chatId);
    }
    return validateRichDocument(document, { authorizedArtifactIds });
  }

  createBlock(params: {
    userId: string;
    chatId: string;
    document: unknown;
    title?: string;
    actorKind?: 'user' | 'ai' | 'system';
    actorId?: string | null;
    tentativeMessageId?: string | null;
    runId?: string | null;
    operationSummary?: string;
  }): { block: RichBlockRecord; referenceUrl: string; validation: RichValidationResult } {
    this.assertChatOwner(params.userId, params.chatId);
    const authorizedArtifactIds = this.getAuthorizedArtifactIds(params.userId, params.chatId);
    const validation = validateRichDocument(params.document, { authorizedArtifactIds });
    if (!validation.valid) {
      throw new RichContentError(
        validation.primaryErrorCode ?? 'RICH_VALIDATION_FAILED',
        validation.issues[0]?.message ?? 'Rich document validation failed.',
        validation.statusCode,
        { issues: validation.issues }
      );
    }

    const doc = params.document as RichDocumentV1;
    const docJson = JSON.stringify(doc);
    const sizeBytes = Buffer.byteLength(docJson, 'utf8');

    const id = crypto.randomUUID();
    const now = Date.now();
    const title =
      params.title?.trim() ||
      (typeof doc.title === 'string' ? doc.title.trim() : '') ||
      '';

    // Strict 2-layer binding invariant: confirmed_message_id is ALWAYS NULL on creation
    // and messages.rich_block_ids_json is NEVER modified here.
    let tentativeMessageId: string | null = null;
    let bindingState: RichBindingState = 'unattached';
    if (params.tentativeMessageId) {
      const msg = this.db.getMessage(params.userId, params.tentativeMessageId);
      if (msg && msg.chatId === params.chatId) {
        tentativeMessageId = msg.id;
        bindingState = 'tentative_sole_turn';
      }
    }

    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      // Creating a block persists both rich_blocks.document_json and revision 1 in rich_block_revisions.document_json.
      this.assertUserQuotaDelta(params.userId, sizeBytes * 2);

      const seqRow = this.db.db
        .prepare('SELECT COALESCE(MAX(created_seq), 0) AS max_seq FROM rich_blocks WHERE chat_id = ?')
        .get(params.chatId) as { max_seq: number };
      const createdSeq = Number(seqRow.max_seq) + 1;

      this.db.db
        .prepare(
          `INSERT INTO rich_blocks (
             id, user_id, chat_id, confirmed_message_id, tentative_message_id, run_id, tool_call_id,
             binding_state, created_seq, schema_version, revision, title, document_json,
             ui_state_snapshot_json, referenced_artifact_ids_json, size_bytes, created_at, updated_at
           ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.userId,
          params.chatId,
          tentativeMessageId,
          params.runId ?? null,
          bindingState,
          createdSeq,
          doc.schemaVersion,
          title,
          docJson,
          JSON.stringify(validation.referencedArtifactIds),
          sizeBytes,
          now,
          now
        );

      this.db.db
        .prepare(
          `INSERT INTO rich_block_revisions (
             id, rich_block_id, user_id, chat_id, revision, schema_version, document_json,
             actor_kind, actor_id, operation_summary, created_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          id,
          params.userId,
          params.chatId,
          doc.schemaVersion,
          docJson,
          params.actorKind ?? 'ai',
          params.actorId ?? null,
          params.operationSummary ?? 'create',
          now
        );

      const block = this.getBlockInternal(id)!;
      envelope = this.db.insertSyncEventInTx({
        userId: params.userId,
        eventId: crypto.randomUUID(),
        type: 'rich_block.created',
        chatId: params.chatId,
        runId: params.runId ?? null,
        payload: { block },
        createdAt: now,
      });

      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }

    const block = this.getBlock(params.userId, params.chatId, id)!;
    this.hub.broadcastPersistedEvent(envelope);
    return {
      block,
      referenceUrl: `agy-rich://${block.id}`,
      validation,
    };
  }

  /**
   * Sole permitted pathway to promote a rich block to confirmed_by_tool_call
   * and attach its blockId to messages.rich_block_ids_json (ACP tool_call_update).
   */
  confirmBlockBinding(params: {
    userId: string;
    chatId: string;
    blockId: string;
    messageId: string;
    runId?: string | null;
    toolCallId: string;
  }): RichBlockRecord | null {
    if (!params.messageId || !params.toolCallId) {
      throw new RichContentError('INVALID_BINDING', 'confirmed_by_tool_call requires both messageId and toolCallId.', 400);
    }
    const existing = this.getBlock(params.userId, params.chatId, params.blockId);
    if (!existing) return null;
    const msg = this.db.getMessage(params.userId, params.messageId);
    if (!msg || msg.chatId !== params.chatId) {
      throw new RichContentError('FORBIDDEN', 'Target message does not belong to this chat.', 403);
    }

    const now = Date.now();
    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.db
        .prepare(
          `UPDATE rich_blocks
           SET binding_state = 'confirmed_by_tool_call',
               confirmed_message_id = ?,
               run_id = COALESCE(?, run_id),
               tool_call_id = ?,
               updated_at = ?
           WHERE id = ? AND user_id = ? AND chat_id = ?`
        )
        .run(params.messageId, params.runId ?? null, params.toolCallId, now, params.blockId, params.userId, params.chatId);

      this.db.appendConfirmedRichBlockToMessageInTx(params.userId, params.messageId, params.blockId, now);

      const updated = this.getBlockInternal(params.blockId)!;
      envelope = this.db.insertSyncEventInTx({
        userId: params.userId,
        eventId: crypto.randomUUID(),
        type: 'rich_block.updated',
        chatId: params.chatId,
        runId: params.runId ?? null,
        payload: { block: updated },
        createdAt: now,
      });

      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }

    this.hub.broadcastPersistedEvent(envelope);
    return this.getBlock(params.userId, params.chatId, params.blockId);
  }

  /** Strict scope-enforced lookup: denies cross-user and cross-chat block references (SEC-09 / NEG-09). */
  getBlock(userId: string, chatId: string, blockId: string): RichBlockRecord | null {
    const row = this.db.db
      .prepare('SELECT * FROM rich_blocks WHERE id = ? AND user_id = ? AND chat_id = ?')
      .get(blockId, userId, chatId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  private getBlockInternal(blockId: string): RichBlockRecord | null {
    const row = this.db.db
      .prepare('SELECT * FROM rich_blocks WHERE id = ?')
      .get(blockId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  listBlocksForChat(userId: string, chatId: string): RichBlockRecord[] {
    this.assertChatOwner(userId, chatId);
    const rows = this.db.db
      .prepare('SELECT * FROM rich_blocks WHERE user_id = ? AND chat_id = ? ORDER BY created_seq ASC')
      .all(userId, chatId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  listRevisions(userId: string, chatId: string, blockId: string): Array<{
    id: string;
    revision: number;
    schemaVersion: number;
    actorKind: string;
    actorId: string | null;
    operationSummary: string;
    createdAt: number;
  }> {
    const block = this.getBlock(userId, chatId, blockId);
    if (!block) {
      throw new RichContentError('NOT_FOUND', 'リッチブロックが見つかりません。', 404);
    }
    const rows = this.db.db
      .prepare(
        `SELECT id, revision, schema_version, actor_kind, actor_id, operation_summary, created_at
         FROM rich_block_revisions
         WHERE rich_block_id = ? AND user_id = ? AND chat_id = ?
         ORDER BY revision DESC`
      )
      .all(blockId, userId, chatId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      revision: Number(r.revision),
      schemaVersion: Number(r.schema_version),
      actorKind: String(r.actor_kind),
      actorId: r.actor_id ? String(r.actor_id) : null,
      operationSummary: String(r.operation_summary ?? ''),
      createdAt: Number(r.created_at),
    }));
  }

  updateBlock(params: {
    userId: string;
    chatId: string;
    blockId: string;
    expectedRevision: number;
    document?: unknown;
    patchNodes?: Array<{ nodeId: string; replacement: RichNode }>;
    patchState?: Record<string, RichStateValue>;
    title?: string;
    actorKind?: 'user' | 'ai' | 'system';
    actorId?: string | null;
    operationSummary?: string;
  }): { block: RichBlockRecord; validation: RichValidationResult } {
    this.assertChatOwner(params.userId, params.chatId);
    const current = this.getBlock(params.userId, params.chatId, params.blockId);
    if (!current) {
      throw new RichContentError('NOT_FOUND', 'リッチブロックが見つからないか権限がありません。', 404);
    }
    if (current.revision !== params.expectedRevision) {
      throw new RichContentError(
        'RICH_BLOCK_CONFLICT',
        `リッチブロックの版が競合しています（期待: ${params.expectedRevision}, 現在: ${current.revision}）。`,
        409,
        { expectedRevision: params.expectedRevision, currentRevision: current.revision }
      );
    }

    let candidateDoc: unknown;
    if (params.document !== undefined) {
      candidateDoc = params.document;
    } else {
      const cloned: RichDocumentV1 = JSON.parse(JSON.stringify(current.document));
      if (params.patchState) {
        cloned.state = { ...(cloned.state ?? {}), ...params.patchState };
      }
      if (params.patchNodes && params.patchNodes.length > 0) {
        const replaceMap = new Map(params.patchNodes.map((p) => [p.nodeId, p.replacement]));
        const replacedIds = new Set<string>();
        const replaceNode = (node: RichNode): RichNode => {
          if (replaceMap.has(node.id)) {
            replacedIds.add(node.id);
            return replaceMap.get(node.id)!;
          }
          const copy = { ...node } as Record<string, unknown>;
          if (Array.isArray(copy.children)) {
            copy.children = (copy.children as RichNode[]).map(replaceNode);
          }
          if (node.type === 'card') {
            if (node.headerAction) copy.headerAction = replaceNode(node.headerAction);
            if (node.footer) copy.footer = replaceNode(node.footer);
          }
          if (node.type === 'tabs') {
            copy.items = node.items.map((it) => ({ ...it, content: it.content.map(replaceNode) }));
          }
          if (node.type === 'popover' || node.type === 'tooltip') {
            copy.trigger = replaceNode(node.trigger);
            if (Array.isArray(node.content)) {
              copy.content = node.content.map(replaceNode);
            }
          }
          return copy as unknown as RichNode;
        };
        cloned.root = replaceNode(cloned.root);
        for (const reqId of replaceMap.keys()) {
          if (!replacedIds.has(reqId)) {
            throw new RichContentError('RICH_NODE_NOT_FOUND', `Target node '${reqId}' not found.`, 404);
          }
        }
      }
      candidateDoc = cloned;
    }

    const authorizedArtifactIds = this.getAuthorizedArtifactIds(params.userId, params.chatId);
    const validation = validateRichDocument(candidateDoc, { authorizedArtifactIds });
    if (!validation.valid) {
      throw new RichContentError(
        validation.primaryErrorCode ?? 'RICH_VALIDATION_FAILED',
        validation.issues[0]?.message ?? 'Rich document validation failed.',
        validation.statusCode,
        { issues: validation.issues }
      );
    }

    const doc = candidateDoc as RichDocumentV1;
    const docJson = JSON.stringify(doc);
    const sizeBytes = Buffer.byteLength(docJson, 'utf8');

    const nextRevision = current.revision + 1;
    const now = Date.now();
    const title =
      params.title !== undefined
        ? params.title.trim()
        : typeof doc.title === 'string'
          ? doc.title.trim()
          : current.title;

    let envelope;
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      const liveRow = this.db.db
        .prepare(
          `SELECT revision, LENGTH(CAST(document_json AS BLOB)) AS doc_bytes
           FROM rich_blocks
           WHERE id = ? AND user_id = ? AND chat_id = ?`
        )
        .get(current.id, params.userId, params.chatId) as { revision: number; doc_bytes: number } | undefined;
      if (!liveRow) {
        throw new RichContentError('NOT_FOUND', 'リッチブロックが見つからないか権限がありません。', 404);
      }
      if (Number(liveRow.revision) !== params.expectedRevision) {
        throw new RichContentError('RICH_BLOCK_CONFLICT', 'Concurrent update conflict.', 409);
      }
      // Updating replaces rich_blocks.document_json (delta = sizeBytes - prevDocBytes)
      // AND appends a new immutable revision row in rich_block_revisions (+sizeBytes).
      const prevDocBytes = Number(liveRow.doc_bytes ?? 0);
      this.assertUserQuotaDelta(params.userId, sizeBytes - prevDocBytes + sizeBytes);

      const info = this.db.db
        .prepare(
          `UPDATE rich_blocks
           SET revision = ?,
               schema_version = ?,
               title = ?,
               document_json = ?,
               referenced_artifact_ids_json = ?,
               size_bytes = ?,
               updated_at = ?
           WHERE id = ? AND user_id = ? AND chat_id = ? AND revision = ?`
        )
        .run(
          nextRevision,
          doc.schemaVersion,
          title,
          docJson,
          JSON.stringify(validation.referencedArtifactIds),
          sizeBytes,
          now,
          current.id,
          params.userId,
          params.chatId,
          params.expectedRevision
        );

      if (Number(info.changes) !== 1) {
        throw new RichContentError('RICH_BLOCK_CONFLICT', 'Concurrent update conflict.', 409);
      }

      this.db.db
        .prepare(
          `INSERT INTO rich_block_revisions (
             id, rich_block_id, user_id, chat_id, revision, schema_version, document_json,
             actor_kind, actor_id, operation_summary, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          current.id,
          params.userId,
          params.chatId,
          nextRevision,
          doc.schemaVersion,
          docJson,
          params.actorKind ?? 'ai',
          params.actorId ?? null,
          params.operationSummary ?? 'update',
          now
        );

      const updated = this.getBlockInternal(current.id)!;
      envelope = this.db.insertSyncEventInTx({
        userId: params.userId,
        eventId: crypto.randomUUID(),
        type: 'rich_block.updated',
        chatId: params.chatId,
        runId: updated.runId,
        payload: { block: updated },
        createdAt: now,
      });

      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }

    const block = this.getBlock(params.userId, params.chatId, current.id)!;
    this.hub.broadcastPersistedEvent(envelope);
    return { block, validation };
  }

  updateUiStateSnapshot(
    userId: string,
    chatId: string,
    blockId: string,
    uiState: Record<string, RichStateValue>
  ): RichBlockRecord {
    const serialized = JSON.stringify(uiState);
    const newUiBytes = Buffer.byteLength(serialized, 'utf8');
    if (newUiBytes > RICH_LIMITS.maxStateBytes) {
      throw new RichContentError('RICH_STATE_TOO_LARGE', 'UI状態スナップショットが128KB上限を超えています。', 422);
    }
    const now = Date.now();
    this.db.db.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.db.db
        .prepare(
          `SELECT COALESCE(LENGTH(CAST(ui_state_snapshot_json AS BLOB)), 0) AS prev_ui_bytes
           FROM rich_blocks
           WHERE id = ? AND user_id = ? AND chat_id = ?`
        )
        .get(blockId, userId, chatId) as { prev_ui_bytes: number } | undefined;
      if (!row) {
        throw new RichContentError('NOT_FOUND', 'リッチブロックが見つかりません。', 404);
      }
      this.assertUserQuotaDelta(userId, newUiBytes - Number(row.prev_ui_bytes ?? 0));
      this.db.db
        .prepare('UPDATE rich_blocks SET ui_state_snapshot_json = ?, updated_at = ? WHERE id = ? AND user_id = ? AND chat_id = ?')
        .run(serialized, now, blockId, userId, chatId);
      this.db.db.exec('COMMIT;');
    } catch (err) {
      this.db.db.exec('ROLLBACK;');
      throw err;
    }
    return this.getBlock(userId, chatId, blockId)!;
  }

  async saveBlockAsArtifact(params: {
    userId: string;
    chatId: string;
    blockId: string;
    filename: string;
    format: 'svg' | 'md' | 'txt' | 'csv' | 'json' | 'code';
    content?: string;
    actorKind?: 'user' | 'ai' | 'system';
    actorId?: string | null;
    idempotencyKey?: string;
  }): Promise<{ artifact: ArtifactRecord; noOp?: boolean }> {
    if (!this.artifactGateway) {
      throw new RichContentError('ARTIFACT_GATEWAY_UNAVAILABLE', 'ArtifactService is not configured.', 500);
    }
    const block = this.getBlock(params.userId, params.chatId, params.blockId);
    if (!block) {
      throw new RichContentError('NOT_FOUND', 'リッチブロックが見つからないかアクセス権がありません。', 404);
    }
    if (!validateSafeFilename(params.filename)) {
      throw new RichContentError('INVALID_FILENAME', '保存ファイル名が不正です。', 400);
    }

    const contentStr =
      params.content !== undefined
        ? params.content
        : params.format === 'json'
          ? JSON.stringify(block.document, null, 2)
          : `# ${block.title || 'Rich Content'}\n\n\`\`\`json\n${JSON.stringify(block.document, null, 2)}\n\`\`\`\n`;

    return this.artifactGateway.createArtifact({
      userId: params.userId,
      scopeKind: 'chat',
      chatId: params.chatId,
      relPath: params.filename,
      content: Buffer.from(contentStr, 'utf8'),
      actorKind: params.actorKind ?? 'user',
      actorId: params.actorId ?? params.userId,
      idempotencyKey: params.idempotencyKey,
      operationSummary: `Save rich block ${block.id} as ${params.filename}`,
    });
  }

  private mapRow(r: Record<string, unknown>): RichBlockRecord {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      chatId: String(r.chat_id),
      confirmedMessageId: r.confirmed_message_id ? String(r.confirmed_message_id) : null,
      tentativeMessageId: r.tentative_message_id ? String(r.tentative_message_id) : null,
      runId: r.run_id ? String(r.run_id) : null,
      toolCallId: r.tool_call_id ? String(r.tool_call_id) : null,
      bindingState: String(r.binding_state) as RichBindingState,
      createdSeq: Number(r.created_seq),
      schemaVersion: Number(r.schema_version),
      revision: Number(r.revision),
      title: String(r.title ?? ''),
      document: JSON.parse(String(r.document_json)) as RichDocumentV1,
      uiStateSnapshot: r.ui_state_snapshot_json
        ? (JSON.parse(String(r.ui_state_snapshot_json)) as Record<string, RichStateValue>)
        : null,
      referencedArtifactIds: JSON.parse(String(r.referenced_artifact_ids_json ?? '[]')) as string[],
      sizeBytes: Number(r.size_bytes),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
}
