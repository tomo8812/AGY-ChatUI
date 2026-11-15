export type UserRole = 'admin' | 'user';

export type AgyAuthStatus = 'unauthenticated' | 'pending_login' | 'authenticated' | 'error';
export type AgyAuthMethod = 'oauth-personal' | 'gemini-api-key' | 'mock' | null;

export interface WebUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  createdAt: number;
  updatedAt: number;
}

export interface AgyProfile {
  userId: string;
  profileDir: string;
  authStatus: AgyAuthStatus;
  authMethod: AgyAuthMethod;
  accountLabel: string | null;
  lastVerifiedAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface AgyLoginFlowState {
  userId: string;
  status: 'idle' | 'starting' | 'awaiting_url' | 'awaiting_code' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
  authUrl: string | null;
  outputLines: string[];
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface AcpSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string | null;
  currentValue: string;
  options: AcpSelectOption[];
}

export interface ProjectRecord {
  id: string;
  userId: string;
  name: string;
  description: string;
  instructions: string;
  contextVersion: number;
  storageDir: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectFileRecord {
  id: string;
  projectId: string;
  userId: string;
  relPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
}

export interface ChatRecord {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  workspaceDir: string;
  acpSessionId: string | null;
  modelId: string | null;
  effortValue: string | null;
  projectContextVersion: number;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
}

export interface ToolCallItem {
  toolCallId: string;
  title: string;
  kind?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string; line?: number | null }>;
  contentText?: string;
}

export interface AttachmentRef {
  artifactId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  relPath: string;
  previewKind: PreviewKind;
}

export type PreviewKind =
  | 'code'
  | 'markdown'
  | 'image'
  | 'svg'
  | 'pdf'
  | 'table'
  | 'docx'
  | 'pptx'
  | 'html'
  | 'mermaid'
  | 'audio'
  | 'video'
  | 'diff'
  | 'binary';

export interface MessageRecord {
  id: string;
  chatId: string;
  userId: string;
  clientMessageId: string | null;
  role: 'user' | 'assistant' | 'system';
  contentText: string;
  thoughtsText: string;
  toolCalls: ToolCallItem[];
  attachments: AttachmentRef[];
  artifactIds: string[];
  status: 'queued' | 'streaming' | 'completed' | 'cancelled' | 'error';
  runId: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  chatId: string;
  userId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: 'queued' | 'running' | 'awaiting_permission' | 'completed' | 'cancelled' | 'error';
  queuePosition: number;
  modelId: string | null;
  effortValue: string | null;
  stopReason: string | null;
  errorMessage: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface PermissionOptionItem {
  optionId: string;
  name: string;
  kind: string;
}

export interface PendingPermissionRecord {
  id: string;
  runId: string;
  chatId: string;
  userId: string;
  toolCall: ToolCallItem;
  options: PermissionOptionItem[];
  status: 'pending' | 'resolved' | 'cancelled';
  selectedOptionId: string | null;
  resolvedByClientId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ArtifactRecord {
  id: string;
  userId: string;
  chatId: string;
  messageId: string | null;
  runId: string | null;
  relPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  source: 'attachment' | 'generated' | 'project_copy';
  previewKind: PreviewKind;
  diffPatch: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface QuotaBucket {
  model: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  remainingLabel: string;
  resetAt: string | null;
  status: 'ok' | 'limited' | 'unknown';
}

export interface QuotaSnapshotRecord {
  userId: string;
  status: 'ok' | 'unavailable' | 'error';
  buckets: QuotaBucket[];
  rawSummary: string | null;
  errorMessage: string | null;
  fetchedAt: number;
}

export interface UserPreferences {
  userId: string;
  theme: 'system' | 'light' | 'dark';
  autoApproveSafeReads: boolean;
  defaultModelId: string | null;
  defaultEffortValue: string | null;
  updatedAt: number;
}

export interface SyncEventEnvelope {
  seq: number;
  eventId: string;
  userId: string;
  type: string;
  chatId: string | null;
  projectId: string | null;
  runId: string | null;
  payload: unknown;
  createdAt: number;
}
