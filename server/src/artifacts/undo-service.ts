import type { AppDatabase } from '../db/database.js';
import { ArtifactError } from './errors.js';
import { evaluateSemanticNonInterference } from './merge-policy.js';
import type { ActorKind, ArtifactFormat, ArtifactRevisionRecord } from './types.js';

export interface UndoStateSummary {
  undoable: boolean;
  redoable: boolean;
  undoTargetRevision: number | null;
  redoTargetRevision: number | null;
  reason?: 'no_actor_edits' | 'history_pruned' | 'semantic_conflict';
}

interface StoredOpPayload {
  semanticScope?: {
    regionKeys?: string[];
    hasDynamicOrCrossSheetFormulas?: boolean;
    structuralChange?: boolean;
  };
  undoOfRevision?: number;
  redoOfRevision?: number;
  preRevision?: number;
  targetBlobSha256?: string;
}

function parseOpPayload(raw: unknown): StoredOpPayload | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as StoredOpPayload;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as StoredOpPayload;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Reconstructs per-actor Undo/Redo stacks strictly from persisted `artifact_revisions` (`ARCH-14`).
 * Verifies blob availability (reporting `history_pruned` when GC pruned prior snapshots) and
 * checks semantic non-interference across intermediate revisions by other actors (`409 UNDO_SEMANTIC_CONFLICT`).
 */
export class ArtifactUndoService {
  constructor(private readonly db: AppDatabase) {}

  listRevisionsAsc(userId: string, artifactId: string): ArtifactRevisionRecord[] {
    const rows = this.db.db
      .prepare(
        `SELECT * FROM artifact_revisions
         WHERE artifact_id = ? AND user_id = ?
         ORDER BY revision ASC`
      )
      .all(artifactId, userId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      artifactId: String(r.artifact_id),
      userId: String(r.user_id),
      chatId: r.chat_id ? String(r.chat_id) : null,
      projectId: r.project_id ? String(r.project_id) : null,
      revision: Number(r.revision),
      parentRevision: r.parent_revision !== null && r.parent_revision !== undefined ? Number(r.parent_revision) : null,
      sha256: String(r.sha256),
      dependencyManifestHash: r.dependency_manifest_hash ? String(r.dependency_manifest_hash) : null,
      sizeBytes: Number(r.size_bytes),
      blobSha256: r.blob_sha256 ? String(r.blob_sha256) : null,
      blobAvailable: Boolean(r.blob_available) && Boolean(r.blob_sha256),
      previewable: Boolean(r.blob_available) && Boolean(r.blob_sha256),
      restorable: Boolean(r.blob_available) && Boolean(r.blob_sha256),
      actorKind: String(r.actor_kind) as ActorKind,
      actorId: r.actor_id ? String(r.actor_id) : null,
      operationType: String(r.operation_type),
      operationSummary: String(r.operation_summary ?? ''),
      operationPayload: parseOpPayload(r.operation_payload_json) as Record<string, unknown> | null,
      batchId: r.batch_id ? String(r.batch_id) : null,
      diffPatch: r.diff_patch ? String(r.diff_patch) : null,
      createdAt: Number(r.created_at),
    }));
  }

  private isSameActor(rev: ArtifactRevisionRecord, actorKind: ActorKind, actorId: string | null): boolean {
    return rev.actorKind === actorKind && (rev.actorId ?? null) === (actorId ?? null);
  }

  /**
   * Computes current Undo/Redo stack state for a specific actor.
   */
  getUndoState(params: {
    userId: string;
    artifactId: string;
    format: ArtifactFormat;
    actorKind: ActorKind;
    actorId: string | null;
  }): UndoStateSummary {
    const revs = this.listRevisionsAsc(params.userId, params.artifactId);
    const byRev = new Map(revs.map((r) => [r.revision, r]));

    // Track undo/redo stack for this actor across revision history
    const undoStack: ArtifactRevisionRecord[] = [];
    const redoStack: ArtifactRevisionRecord[] = [];

    for (const r of revs) {
      if (!this.isSameActor(r, params.actorKind, params.actorId)) continue;
      if (r.operationType === 'undo') {
        const popped = undoStack.pop();
        if (popped) redoStack.push(popped);
      } else if (r.operationType === 'redo') {
        const popped = redoStack.pop();
        if (popped) undoStack.push(popped);
      } else if (r.operationType !== 'create' && r.operationType !== 'legacy_baseline' && r.operationType !== 'dependency_sync') {
        undoStack.push(r);
        redoStack.length = 0; // new edit clears redo stack
      }
    }

    const topUndo = undoStack.at(-1) ?? null;
    const topRedo = redoStack.at(-1) ?? null;

    if (!topUndo) {
      return {
        undoable: false,
        redoable: Boolean(topRedo && topRedo.blobAvailable),
        undoTargetRevision: null,
        redoTargetRevision: topRedo && topRedo.blobAvailable ? topRedo.revision : null,
        reason: 'no_actor_edits',
      };
    }

    const parentRevNum = topUndo.parentRevision;
    const parentRev = parentRevNum !== null ? byRev.get(parentRevNum) : undefined;
    if (!parentRev || !parentRev.blobAvailable || !parentRev.blobSha256) {
      return {
        undoable: false,
        redoable: Boolean(topRedo && topRedo.blobAvailable),
        undoTargetRevision: null,
        redoTargetRevision: topRedo && topRedo.blobAvailable ? topRedo.revision : null,
        reason: 'history_pruned',
      };
    }

    // Check semantic non-interference against any revisions AFTER topUndo
    const conflict = this.checkIntermediateConflict(revs, topUndo, params.format);
    if (conflict) {
      return {
        undoable: false,
        redoable: Boolean(topRedo && topRedo.blobAvailable),
        undoTargetRevision: parentRev.revision,
        redoTargetRevision: topRedo && topRedo.blobAvailable ? topRedo.revision : null,
        reason: 'semantic_conflict',
      };
    }

    return {
      undoable: true,
      redoable: Boolean(topRedo && topRedo.blobAvailable),
      undoTargetRevision: parentRev.revision,
      redoTargetRevision: topRedo && topRedo.blobAvailable ? topRedo.revision : null,
    };
  }

  private checkIntermediateConflict(
    revsAsc: ArtifactRevisionRecord[],
    targetEditRev: ArtifactRevisionRecord,
    format: ArtifactFormat
  ): string | null {
    const after = revsAsc.filter((r) => r.revision > targetEditRev.revision);
    if (after.length === 0) return null;

    const editPayload = parseOpPayload(targetEditRev.operationPayload);
    for (const inter of after) {
      if (inter.operationType === 'dependency_sync') continue;
      // Another actor or subsequent change intervened
      const interPayload = parseOpPayload(inter.operationPayload);
      const decision = evaluateSemanticNonInterference(
        {
          format,
          regionKeys: editPayload?.semanticScope?.regionKeys,
          hasDynamicOrCrossSheetFormulas: editPayload?.semanticScope?.hasDynamicOrCrossSheetFormulas,
          structuralChange: editPayload?.semanticScope?.structuralChange,
        },
        {
          format,
          regionKeys: interPayload?.semanticScope?.regionKeys,
          hasDynamicOrCrossSheetFormulas: interPayload?.semanticScope?.hasDynamicOrCrossSheetFormulas,
          structuralChange: interPayload?.semanticScope?.structuralChange,
        }
      );
      if (!decision.mergeable) {
        return `Revision ${inter.revision} (${inter.actorKind}:${inter.operationType}) conflicts: ${decision.reason}`;
      }
    }
    return null;
  }

  planUndo(params: {
    userId: string;
    artifactId: string;
    format: ArtifactFormat;
    actorKind: ActorKind;
    actorId: string | null;
  }): { restoreFromRevision: number; restoreBlobSha256: string; undoneRevision: number } {
    const revs = this.listRevisionsAsc(params.userId, params.artifactId);
    const byRev = new Map(revs.map((r) => [r.revision, r]));
    const undoStack: ArtifactRevisionRecord[] = [];
    const redoStack: ArtifactRevisionRecord[] = [];

    for (const r of revs) {
      if (!this.isSameActor(r, params.actorKind, params.actorId)) continue;
      if (r.operationType === 'undo') {
        const popped = undoStack.pop();
        if (popped) redoStack.push(popped);
      } else if (r.operationType === 'redo') {
        const popped = redoStack.pop();
        if (popped) undoStack.push(popped);
      } else if (r.operationType !== 'create' && r.operationType !== 'legacy_baseline' && r.operationType !== 'dependency_sync') {
        undoStack.push(r);
        redoStack.length = 0;
      }
    }

    const topUndo = undoStack.at(-1);
    if (!topUndo) {
      throw new ArtifactError('UNDO_UNAVAILABLE', '元に戻せる操作がありません。', 422, { reason: 'no_actor_edits' });
    }

    const parentRev = topUndo.parentRevision !== null ? byRev.get(topUndo.parentRevision) : undefined;
    if (!parentRev || !parentRev.blobAvailable || !parentRev.blobSha256) {
      throw new ArtifactError(
        'UNDO_HISTORY_PRUNED',
        '履歴の整理によりこの操作以前のスナップショットが利用できません。',
        422,
        { reason: 'history_pruned', undoable: false }
      );
    }

    const conflict = this.checkIntermediateConflict(revs, topUndo, params.format);
    if (conflict) {
      throw new ArtifactError(
        'UNDO_SEMANTIC_CONFLICT',
        '他の更新（AI編集など）と競合するため、安全に元に戻せません。バージョン履歴から明示復元してください。',
        409,
        { reason: conflict, undoneRevision: topUndo.revision }
      );
    }

    return {
      restoreFromRevision: parentRev.revision,
      restoreBlobSha256: parentRev.blobSha256,
      undoneRevision: topUndo.revision,
    };
  }

  planRedo(params: {
    userId: string;
    artifactId: string;
    format: ArtifactFormat;
    actorKind: ActorKind;
    actorId: string | null;
  }): { restoreFromRevision: number; restoreBlobSha256: string } {
    const revs = this.listRevisionsAsc(params.userId, params.artifactId);
    const undoStack: ArtifactRevisionRecord[] = [];
    const redoStack: ArtifactRevisionRecord[] = [];

    for (const r of revs) {
      if (!this.isSameActor(r, params.actorKind, params.actorId)) continue;
      if (r.operationType === 'undo') {
        const popped = undoStack.pop();
        if (popped) redoStack.push(popped);
      } else if (r.operationType === 'redo') {
        const popped = redoStack.pop();
        if (popped) undoStack.push(popped);
      } else if (r.operationType !== 'create' && r.operationType !== 'legacy_baseline' && r.operationType !== 'dependency_sync') {
        undoStack.push(r);
        redoStack.length = 0;
      }
    }

    const topRedo = redoStack.at(-1);
    if (!topRedo) {
      throw new ArtifactError('REDO_UNAVAILABLE', 'やり直せる操作がありません。', 422, { reason: 'no_actor_edits' });
    }
    if (!topRedo.blobAvailable || !topRedo.blobSha256) {
      throw new ArtifactError(
        'REDO_HISTORY_PRUNED',
        '履歴の整理によりやり直し対象のスナップショットが利用できません。',
        422,
        { reason: 'history_pruned', redoable: false }
      );
    }

    // Also protect any intervening other-actor edit after the last undo
    const lastUndo = [...revs].reverse().find((r) => this.isSameActor(r, params.actorKind, params.actorId) && r.operationType === 'undo');
    if (lastUndo) {
      const conflict = this.checkIntermediateConflict(revs, lastUndo, params.format);
      if (conflict) {
        throw new ArtifactError(
          'UNDO_SEMANTIC_CONFLICT',
          '他の更新と競合するためやり直せません。バージョン履歴から明示復元してください。',
          409,
          { reason: conflict }
        );
      }
    }

    return {
      restoreFromRevision: topRedo.revision,
      restoreBlobSha256: topRedo.blobSha256,
    };
  }
}
