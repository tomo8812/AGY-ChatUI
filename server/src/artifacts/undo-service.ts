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
    kind?: string;
  };
  undoOfRevision?: number;
  redoOfRevision?: number;
  operationReplayVersion?: number;
}

export interface ActorHistoryParams {
  userId: string;
  artifactId: string;
  format: ArtifactFormat;
  actorKind: ActorKind;
  actorId: string | null;
}

type Direction = 'undo' | 'redo';
type HistoryPlan = { target: ArtifactRevisionRecord; parent: ArtifactRevisionRecord; current: ArtifactRevisionRecord; direct: boolean };
type HistoryResult = { plan: HistoryPlan } | { reason: 'no_actor_edits' | 'history_pruned' | 'semantic_conflict'; revision?: number };

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

  private history(params: ActorHistoryParams) {
    const revisions = this.listRevisionsAsc(params.userId, params.artifactId);
    const byRevision = new Map(revisions.map(revision => [revision.revision, revision]));
    const undo: ArtifactRevisionRecord[] = [];
    const redo: ArtifactRevisionRecord[] = [];
    const transitions: Array<{ revision: ArtifactRevisionRecord; original: ArtifactRevisionRecord; active: boolean }> = [];
    const uncertain: ArtifactRevisionRecord[] = [];

    for (const revision of revisions) {
      const { operationType } = revision;
      const owned = this.isSameActor(revision, params.actorKind, params.actorId);
      if (['create', 'legacy_baseline', 'dependency_sync'].includes(operationType)) continue;
      if (operationType !== 'undo' && operationType !== 'redo') {
        transitions.push({ revision, original: revision, active: true });
        if (owned) {
          undo.push(revision);
          redo.length = 0;
        }
        continue;
      }
      const payload = parseOpPayload(revision.operationPayload);
      const stack = operationType === 'undo' ? undo : redo;
      const originalNumber = operationType === 'undo' ? payload?.undoOfRevision : payload?.redoOfRevision;
      const original = originalNumber === undefined ? undefined : byRevision.get(originalNumber);
      const validLink = original && original.revision < revision.revision &&
        !['undo', 'redo', 'create', 'legacy_baseline', 'dependency_sync'].includes(original.operationType) &&
        this.isSameActor(original, revision.actorKind, revision.actorId);
      if (!validLink || payload?.operationReplayVersion !== 1) uncertain.push(revision);
      if (!validLink || (owned && stack.at(-1) !== original)) continue;
      transitions.push({ revision, original, active: operationType === 'redo' });
      if (owned) {
        stack.pop();
        (operationType === 'undo' ? redo : undo).push(original);
      }
    }
    return { revisions, byRevision, undo, redo, transitions, uncertain };
  }

  private inspect(params: ActorHistoryParams, history: ReturnType<ArtifactUndoService['history']>, direction: Direction): HistoryResult {
    const target = history[direction].at(-1);
    if (!target) {
      return { reason: history.uncertain.some(revision => this.isSameActor(revision, params.actorKind, params.actorId))
        ? 'history_pruned' : 'no_actor_edits' };
    }
    const parent = target.parentRevision === null ? undefined : history.byRevision.get(target.parentRevision);
    const current = history.revisions.at(-1)!;
    if (!parent?.blobAvailable || !target.blobAvailable || !current.blobAvailable) return { reason: 'history_pruned' };
    const expected = direction === 'undo' ? target : parent;
    const direct = expected.sha256 === current.sha256 && expected.dependencyManifestHash === current.dependencyManifestHash;
    const before = new Map<number, boolean>();
    const after = new Map<number, ArtifactRevisionRecord>();
    for (const { revision, original, active } of history.transitions) {
      if (revision.revision <= target.revision) before.set(original.revision, active);
      else {
        if (active === (before.get(original.revision) ?? false)) after.delete(original.revision);
        else after.set(original.revision, original);
      }
    }
    after.delete(target.revision);
    const scope = (revision: ArtifactRevisionRecord) => {
      const stored = parseOpPayload(revision.operationPayload)?.semanticScope;
      return { ...stored, format: params.format, structuralChange: stored?.structuralChange || stored?.kind === 'structural' };
    };
    if (history.uncertain.some(revision => revision.revision > target.revision) ||
        [...after.values()].some(revision => !evaluateSemanticNonInterference(scope(target), scope(revision)).mergeable) ||
        (!direct && (params.format !== 'csv' || current.dependencyManifestHash !== expected.dependencyManifestHash))) {
      return { reason: 'semantic_conflict', revision: target.revision };
    }
    return { plan: { target, parent, current, direct } };
  }

  getUndoState(params: ActorHistoryParams): UndoStateSummary {
    const history = this.history(params);
    const undo = this.inspect(params, history, 'undo');
    const redo = this.inspect(params, history, 'redo');
    return {
      undoable: 'plan' in undo,
      redoable: 'plan' in redo,
      undoTargetRevision: 'plan' in undo ? undo.plan.parent.revision : null,
      redoTargetRevision: 'plan' in redo ? redo.plan.target.revision : null,
      ...('reason' in undo ? { reason: undo.reason === 'no_actor_edits' && 'reason' in redo &&
        redo.reason !== 'no_actor_edits' ? redo.reason : undo.reason } : {}),
    };
  }

  plan(params: ActorHistoryParams, direction: Direction): HistoryPlan {
    const result = this.inspect(params, this.history(params), direction);
    if ('plan' in result) return result.plan;
    if (result.reason === 'semantic_conflict') {
      throw new ArtifactError('UNDO_SEMANTIC_CONFLICT', '他の更新と競合するため、この操作を安全に変更できません。', 409);
    }
    const prefix = direction === 'undo' ? 'UNDO' : 'REDO';
    if (result.reason === 'history_pruned') {
      throw new ArtifactError(prefix + '_HISTORY_PRUNED', '履歴スナップショットが利用できません。', 422, { reason: result.reason });
    }
    throw new ArtifactError(prefix + '_UNAVAILABLE', '対象の操作がありません。', 422, { reason: result.reason });
  }
}
