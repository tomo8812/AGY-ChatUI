import type { ArtifactScopeKind, PreviewKind } from '../types.js';

export type ArtifactFormat =
  | 'pptx'
  | 'docx'
  | 'xlsx'
  | 'csv'
  | 'pdf'
  | 'image'
  | 'svg'
  | 'html'
  | 'markdown'
  | 'code'
  | 'diff'
  | 'mermaid'
  | 'media'
  | 'binary';

export type CapabilityAvailability =
  | 'supported'
  | 'partial'
  | 'disabled_by_resource_tier'
  | 'unsupported_by_format';

export interface OperationCapability {
  operation: string;
  availability: CapabilityAvailability;
  scope: 'mcp_and_ui' | 'mcp_only' | 'ui_view_only';
  notes?: string;
  remediation?: string;
}

export type RuntimeProfile = 'full_runtime' | 'compact_doc_runtime' | 'base_chatui';
export type SandboxIsolationKind = 'bwrap' | 'unsandboxed_explicit' | 'sandbox_required_blocked';
export type StagingIsolationKind = 'bwrap_mount_isolated' | 'non_isolated_same_uid';

export interface ArtifactCapabilitiesResponse {
  format: ArtifactFormat;
  previewKind: PreviewKind;
  runtimeProfile: RuntimeProfile;
  sandboxIsolation: SandboxIsolationKind;
  stagingIsolation: StagingIsolationKind;
  directEditUiSupported: boolean;
  targetPinSupported: boolean;
  operations: OperationCapability[];
}

export type ActorKind = 'user' | 'ai' | 'system';

export interface ArtifactRevisionRecord {
  id: string;
  artifactId: string;
  userId: string;
  chatId: string | null;
  projectId: string | null;
  revision: number;
  parentRevision: number | null;
  sha256: string;
  dependencyManifestHash: string | null;
  sizeBytes: number;
  blobSha256: string | null;
  blobAvailable: boolean;
  previewable: boolean;
  restorable: boolean;
  actorKind: ActorKind;
  actorId: string | null;
  operationType: string;
  operationSummary: string;
  operationPayload: Record<string, unknown> | null;
  batchId: string | null;
  diffPatch: string | null;
  createdAt: number;
}

export interface ArtifactDependencyEntry {
  relPath: string;
  status: 'present' | 'missing';
  sha256: string | null;
  blobSha256: string | null;
  sizeBytes: number;
  mimeType: string;
}

export type CommitJournalState =
  | 'prepared'
  | 'replacing'
  | 'file_replaced'
  | 'db_committed'
  | 'aborted'
  | 'ambiguous_quarantined';

export interface ArtifactCommitJournalRow {
  commitId: string;
  artifactId: string;
  userId: string;
  chatId: string | null;
  projectId: string | null;
  scopeKind: ArtifactScopeKind;
  relPath: string;
  isCreate: boolean;
  targetRevision: number;
  parentRevision: number | null;
  expectedPrevSha256: string | null;
  expectedPrevIno: string | null;
  newSha256: string;
  newDependencyManifestHash: string | null;
  newDeps: ArtifactDependencyEntry[];
  newSizeBytes: number;
  prevBlobSha256: string | null;
  newBlobSha256: string;
  privateStagePath: string;
  stageIno: string | null;
  actorKind: ActorKind;
  actorId: string | null;
  operationType: string;
  operationSummary: string;
  operationPayloadJson: string | null;
  batchId: string | null;
  idempotencyScopeKey: string | null;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
  diffPatch: string | null;
  state: CommitJournalState;
  auditNote: string | null;
  syncEventSeq: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactRestoreBatchRecord {
  batchId: string;
  userId: string;
  scopeKind: ArtifactScopeKind;
  chatId: string | null;
  projectId: string | null;
  parentArtifactId: string;
  sharedPolicy: 'overwrite_shared' | 'skip_shared';
  state: 'in_progress' | 'completed' | 'failed_partial';
  items: ArtifactRestoreBatchItemRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactRestoreBatchItemRecord {
  batchId: string;
  seq: number;
  artifactId: string;
  targetRevision: number;
  status: 'pending' | 'committed' | 'failed';
  committedRevision: number | null;
  errorCode: string | null;
}

export type TargetSelector = Record<string, unknown> & {
  kind: string;
  baseRevision?: number;
};

export interface TargetResolutionResult {
  status: 'resolved' | 'needs_review' | 'stale';
  reason?: string;
  resolvedSnippet?: string;
  surroundingContext?: string;
  resolvedRange?: Record<string, unknown>;
  resolvedCoords?: Record<string, unknown>;
  orderChanged?: boolean;
}

export interface AdapterOperation {
  op: string;
  [key: string]: unknown;
}

export interface AdapterEditResult {
  buffer: Buffer;
  summary: string;
  inverseOperation?: Record<string, unknown> | null;
  semanticScope?: {
    kind: string;
    regionKeys?: string[];
  };
}

export interface AdapterVerifyIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  location?: string;
}

export interface AdapterVerifyResult {
  ok: boolean;
  issues: AdapterVerifyIssue[];
  metrics?: Record<string, unknown>;
}

export interface AdapterExportResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export type CommitFaultStage =
  | 'before_T1'
  | 'after_T1'
  | 'before_T2'
  | 'after_T2'
  | 'before_T3'
  | 'after_T3'
  | 'before_T4'
  | 'after_T4'
  | 'before_T5'
  | 'after_T5'
  | 'before_T6'
  | 'after_T6'
  | 'before_T7'
  | 'after_T7';

export type CommitFaultHook = (
  stage: CommitFaultStage,
  ctx: {
    commitId: string;
    artifactId: string;
    isCreate: boolean;
    privateStagePath: string;
    finalTargetPath: string;
  }
) => void | Promise<void>;
