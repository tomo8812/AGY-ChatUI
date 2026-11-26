import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { detectMimeAndPreviewKind } from '../files/workspace.js';
import type {
  AgyAuthMethod,
  AgyAuthStatus,
  AgyProfile,
  ArtifactLifecycleState,
  ArtifactRecord,
  ArtifactScopeKind,
  AttachmentRef,
  ChatRecord,
  ElicitationContentValue,
  ElicitationFormSchema,
  McpAuthType,
  McpOAuthStatus,
  McpScope,
  McpTransport,
  MessageActivity,
  MessageRecord,
  PendingElicitationRecord,
  PendingPermissionRecord,
  PermissionOptionItem,
  PreviewKind,
  ProjectFileRecord,
  ProjectRecord,
  PushSubscriptionRecord,
  QuotaBucket,
  QuotaSnapshotRecord,
  RunRecord,
  SessionMessageItem,
  SyncEventEnvelope,
  ToolCallItem,
  UserPreferences,
  UserRole,
  WebUser,
} from '../types.js';

export interface StoredUserRow extends WebUser {
  passwordHash: string;
}

export interface StoredMcpServerRow {
  id: string;
  name: string;
  description: string;
  scope: McpScope;
  ownerUserId: string | null;
  projectId: string | null;
  chatId: string | null;
  transport: McpTransport;
  enabled: boolean;
  allowedToolsJson: string;
  disabledToolsJson: string;
  alwaysAllowToolsJson: string;
  discoveredToolsJson: string;
  command: string | null;
  argsJson: string;
  encryptedEnvJson: string | null;
  url: string | null;
  authType: McpAuthType;
  encryptedHeadersJson: string | null;
  oauthConfigJson: string | null;
  encryptedOauthClientSecret: string | null;
  encryptedOauthTokensJson: string | null;
  oauthStatus: McpOAuthStatus;
  oauthError: string | null;
  oauthUpdatedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export class AppDatabase {
  public readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_agent TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id);

      CREATE TABLE IF NOT EXISTS agy_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile_dir TEXT NOT NULL UNIQUE,
        auth_status TEXT NOT NULL DEFAULT 'unauthenticated',
        auth_method TEXT,
        account_label TEXT,
        encrypted_api_key TEXT,
        last_verified_at INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        theme TEXT NOT NULL DEFAULT 'system',
        notify_on_response INTEGER NOT NULL DEFAULT 0,
        haptic_feedback INTEGER NOT NULL DEFAULT 1,
        default_model_id TEXT,
        default_effort_value TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        context_version INTEGER NOT NULL DEFAULT 1,
        storage_dir TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS project_files (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (project_id, rel_path)
      );
      CREATE INDEX IF NOT EXISTS idx_project_files_proj ON project_files(project_id, user_id);

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        acp_session_id TEXT,
        model_id TEXT,
        effort_value TEXT,
        project_context_version INTEGER NOT NULL DEFAULT 0,
        context_used INTEGER,
        context_size INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_message_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chats_user_msg ON chats(user_id, last_message_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_message_id TEXT,
        role TEXT NOT NULL,
        content_text TEXT NOT NULL DEFAULT '',
        thoughts_text TEXT NOT NULL DEFAULT '',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        session_messages_json TEXT NOT NULL DEFAULT '[]',
        activity_json TEXT NOT NULL DEFAULT '[]',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'completed',
        run_id TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (chat_id, client_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        queue_position INTEGER NOT NULL DEFAULT 0,
        model_id TEXT,
        effort_value TEXT,
        stop_reason TEXT,
        error_message TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_chat_created ON runs(chat_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_active_user_chat ON runs(user_id, chat_id, created_at) WHERE status IN ('queued', 'running', 'awaiting_permission');

      CREATE TABLE IF NOT EXISTS pending_permissions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tool_call_json TEXT NOT NULL,
        options_json TEXT NOT NULL,
        always_allow_rule TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        selected_option_id TEXT,
        resolved_by_client_id TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_perms_chat_status ON pending_permissions(chat_id, status);

      CREATE TABLE IF NOT EXISTS pending_elicitations (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tool_call_id TEXT,
        external_elicitation_id TEXT,
        mode TEXT NOT NULL,
        message TEXT NOT NULL,
        requested_schema_json TEXT,
        url TEXT,
        url_completed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        selected_action TEXT,
        response_content_json TEXT,
        resolved_by_client_id TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_elicit_chat_status ON pending_elicitations(chat_id, status);
      CREATE INDEX IF NOT EXISTS idx_elicit_external_id ON pending_elicitations(external_elicitation_id);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_kind TEXT NOT NULL DEFAULT 'chat',
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        message_id TEXT,
        run_id TEXT,
        rel_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        preview_kind TEXT NOT NULL,
        diff_patch TEXT,
        lifecycle_state TEXT NOT NULL DEFAULT 'active',
        deleted_on_disk INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        dependency_manifest_hash TEXT,
        source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        source_base_revision INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (scope_kind = 'chat' AND chat_id IS NOT NULL AND project_id IS NULL)
          OR (scope_kind = 'project' AND project_id IS NOT NULL AND chat_id IS NULL)
        ),
        CHECK (source_base_revision IS NULL OR source_artifact_id IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_chat ON artifacts(chat_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS artifact_revisions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        parent_revision INTEGER,
        sha256 TEXT NOT NULL,
        dependency_manifest_hash TEXT,
        size_bytes INTEGER NOT NULL,
        blob_sha256 TEXT,
        blob_available INTEGER NOT NULL DEFAULT 1,
        actor_kind TEXT NOT NULL,
        actor_id TEXT,
        operation_type TEXT NOT NULL,
        operation_summary TEXT NOT NULL DEFAULT '',
        operation_payload_json TEXT,
        batch_id TEXT,
        diff_patch TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (artifact_id, revision)
      );

      CREATE TABLE IF NOT EXISTS artifact_revision_deps (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_kind TEXT NOT NULL,
        chat_id TEXT,
        project_id TEXT,
        rel_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'present',
        sha256 TEXT,
        blob_sha256 TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        PRIMARY KEY (artifact_id, revision, rel_path)
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_rev_deps_scope_path
        ON artifact_revision_deps(user_id, scope_kind, COALESCE(chat_id, ''), COALESCE(project_id, ''), rel_path);

      CREATE TABLE IF NOT EXISTS artifact_idempotency (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        server_boot_id TEXT NOT NULL,
        commit_id TEXT,
        actor_kind TEXT NOT NULL,
        actor_id TEXT,
        request_fingerprint TEXT NOT NULL,
        artifact_id TEXT,
        committed_revision INTEGER,
        no_op INTEGER NOT NULL DEFAULT 0,
        response_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, scope_key, idempotency_key)
      );

      -- Intentionally NO foreign key CASCADE on artifact_id so audit/recovery survives pending_create cleanup
      CREATE TABLE IF NOT EXISTS artifact_commit_journal (
        commit_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        chat_id TEXT,
        project_id TEXT,
        scope_kind TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        is_create INTEGER NOT NULL DEFAULT 0,
        target_revision INTEGER NOT NULL,
        parent_revision INTEGER,
        expected_prev_sha256 TEXT,
        expected_prev_ino TEXT,
        new_sha256 TEXT NOT NULL,
        new_dependency_manifest_hash TEXT,
        new_deps_json TEXT,
        new_size_bytes INTEGER NOT NULL,
        prev_blob_sha256 TEXT,
        new_blob_sha256 TEXT NOT NULL,
        private_stage_path TEXT NOT NULL,
        stage_ino TEXT,
        actor_kind TEXT NOT NULL,
        actor_id TEXT,
        operation_type TEXT NOT NULL,
        operation_summary TEXT NOT NULL,
        operation_payload_json TEXT,
        batch_id TEXT,
        batch_seq INTEGER,
        staging_isolation_mode TEXT,
        idempotency_scope_key TEXT,
        idempotency_key TEXT,
        request_fingerprint TEXT,
        diff_patch TEXT,
        state TEXT NOT NULL,
        audit_note TEXT,
        sync_event_seq INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifact_dep_propagation_queue (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        chat_id TEXT,
        project_id TEXT,
        changed_rel_path TEXT NOT NULL,
        source_artifact_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        batch_id TEXT,
        exclude_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifact_restore_batches (
        batch_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        chat_id TEXT,
        project_id TEXT,
        parent_artifact_id TEXT NOT NULL,
        shared_policy TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifact_restore_batch_items (
        batch_id TEXT NOT NULL REFERENCES artifact_restore_batches(batch_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        artifact_id TEXT NOT NULL,
        target_revision INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        committed_revision INTEGER,
        error_code TEXT,
        PRIMARY KEY (batch_id, seq)
      );

      CREATE TABLE IF NOT EXISTS ai_edit_request_batches (
        batch_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        sent_message_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_edit_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        target_kind TEXT NOT NULL,
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
        rich_block_id TEXT,
        base_revision INTEGER NOT NULL,
        format TEXT NOT NULL,
        container_ref_json TEXT NOT NULL DEFAULT '{}',
        selector_json TEXT NOT NULL,
        range_json TEXT,
        content_coords_json TEXT,
        selected_content_snapshot TEXT NOT NULL DEFAULT '',
        surrounding_context TEXT,
        region_image_blob_sha256 TEXT,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        view_state_snapshot_json TEXT,
        batch_id TEXT REFERENCES ai_edit_request_batches(batch_id) ON DELETE SET NULL,
        sent_message_id TEXT,
        applied_revision INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rich_blocks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        confirmed_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        tentative_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        run_id TEXT,
        tool_call_id TEXT,
        binding_state TEXT NOT NULL DEFAULT 'unattached',
        created_seq INTEGER NOT NULL DEFAULT 0,
        schema_version INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL DEFAULT '',
        document_json TEXT NOT NULL,
        ui_state_snapshot_json TEXT,
        referenced_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (binding_state = 'confirmed_by_tool_call' AND confirmed_message_id IS NOT NULL AND tool_call_id IS NOT NULL)
          OR (binding_state != 'confirmed_by_tool_call' AND confirmed_message_id IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_rich_blocks_chat_confirmed_msg ON rich_blocks(chat_id, confirmed_message_id, created_seq);

      CREATE TABLE IF NOT EXISTS rich_block_revisions (
        id TEXT PRIMARY KEY,
        rich_block_id TEXT NOT NULL REFERENCES rich_blocks(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT,
        operation_summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE (rich_block_id, revision)
      );

      CREATE TABLE IF NOT EXISTS quota_snapshots (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        buckets_json TEXT NOT NULL DEFAULT '[]',
        raw_summary TEXT,
        error_message TEXT,
        fetched_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_seq INTEGER NOT NULL DEFAULT 0,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        chat_id TEXT,
        project_id TEXT,
        run_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sync_events_user_seq ON sync_events(user_id, seq);

      CREATE TABLE IF NOT EXISTS builtin_mcp_settings (
        scope_key TEXT PRIMARY KEY,
        enabled INTEGER CHECK (enabled IN (0, 1)),
        disabled_tools_json TEXT
      );
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL,
        owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        transport TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        allowed_tools_json TEXT NOT NULL DEFAULT '[]',
        disabled_tools_json TEXT NOT NULL DEFAULT '[]',
        always_allow_tools_json TEXT NOT NULL DEFAULT '[]',
        discovered_tools_json TEXT NOT NULL DEFAULT '[]',
        command TEXT,
        args_json TEXT NOT NULL DEFAULT '[]',
        encrypted_env_json TEXT,
        url TEXT,
        auth_type TEXT NOT NULL DEFAULT 'none',
        encrypted_headers_json TEXT,
        oauth_config_json TEXT,
        encrypted_oauth_client_secret TEXT,
        encrypted_oauth_tokens_json TEXT,
        oauth_status TEXT NOT NULL DEFAULT 'disconnected',
        oauth_error TEXT,
        oauth_updated_at INTEGER,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope_owner ON mcp_servers(scope, owner_user_id);
    `);

    // Safe additive column migrations for existing databases
    const prefCols = this.db.prepare('PRAGMA table_info(user_preferences)').all() as Array<{ name: string }>;
    if (!prefCols.some((col) => col.name === 'notify_on_response')) {
      this.db.exec('ALTER TABLE user_preferences ADD COLUMN notify_on_response INTEGER NOT NULL DEFAULT 0;');
    }
    if (!prefCols.some((col) => col.name === 'haptic_feedback')) {
      this.db.exec('ALTER TABLE user_preferences ADD COLUMN haptic_feedback INTEGER NOT NULL DEFAULT 1;');
    }
    const chatCols = this.db.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>;
    if (!chatCols.some((col) => col.name === 'context_used')) {
      this.db.exec('ALTER TABLE chats ADD COLUMN context_used INTEGER;');
    }
    if (!chatCols.some((col) => col.name === 'context_size')) {
      this.db.exec('ALTER TABLE chats ADD COLUMN context_size INTEGER;');
    }
    const msgCols = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (!msgCols.some((col) => col.name === 'activity_json')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN activity_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!msgCols.some((col) => col.name === 'session_messages_json')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN session_messages_json TEXT NOT NULL DEFAULT '[]';");
    }
    const permCols = this.db.prepare('PRAGMA table_info(pending_permissions)').all() as Array<{ name: string }>;
    if (!permCols.some((col) => col.name === 'always_allow_rule')) {
      this.db.exec('ALTER TABLE pending_permissions ADD COLUMN always_allow_rule TEXT;');
    }
    const mcpCols = this.db.prepare('PRAGMA table_info(mcp_servers)').all() as Array<{ name: string }>;
    if (!mcpCols.some((col) => col.name === 'allowed_tools_json')) {
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN allowed_tools_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!mcpCols.some((col) => col.name === 'disabled_tools_json')) {
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN disabled_tools_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!mcpCols.some((col) => col.name === 'always_allow_tools_json')) {
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN always_allow_tools_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!mcpCols.some((col) => col.name === 'discovered_tools_json')) {
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN discovered_tools_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!mcpCols.some((col) => col.name === 'project_id')) {
      this.db.exec('ALTER TABLE mcp_servers ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;');
    }
    if (!mcpCols.some((col) => col.name === 'chat_id')) {
      this.db.exec('ALTER TABLE mcp_servers ADD COLUMN chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE;');
    }
    this.db.exec(`
      DROP INDEX IF EXISTS idx_mcp_servers_unique_scope_name;
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_project ON mcp_servers(project_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_chat ON mcp_servers(chat_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_unique_scope_target_name
        ON mcp_servers(scope, COALESCE(owner_user_id, ''), COALESCE(project_id, ''), COALESCE(chat_id, ''), name);
    `);
    const elicitCols = this.db.prepare('PRAGMA table_info(pending_elicitations)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    if (!elicitCols.some((col) => col.name === 'url_completed')) {
      this.db.exec('ALTER TABLE pending_elicitations ADD COLUMN url_completed INTEGER NOT NULL DEFAULT 0;');
    }
    const elicitRunCol = elicitCols.find((col) => col.name === 'run_id');
    if (elicitRunCol && Number(elicitRunCol.notnull) === 1) {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE pending_elicitations_new (
          id TEXT PRIMARY KEY,
          run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
          chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tool_call_id TEXT,
          external_elicitation_id TEXT,
          mode TEXT NOT NULL,
          message TEXT NOT NULL,
          requested_schema_json TEXT,
          url TEXT,
          url_completed INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          selected_action TEXT,
          response_content_json TEXT,
          resolved_by_client_id TEXT,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER
        );
        INSERT INTO pending_elicitations_new (
          id, run_id, chat_id, user_id, tool_call_id, external_elicitation_id, mode, message,
          requested_schema_json, url, url_completed, status, selected_action,
          response_content_json, resolved_by_client_id, created_at, resolved_at
        )
        SELECT
          id, run_id, chat_id, user_id, tool_call_id, external_elicitation_id, mode, message,
          requested_schema_json, url, COALESCE(url_completed, 0), status, selected_action,
          response_content_json, resolved_by_client_id, created_at, resolved_at
        FROM pending_elicitations;
        DROP TABLE pending_elicitations;
        ALTER TABLE pending_elicitations_new RENAME TO pending_elicitations;
        PRAGMA foreign_keys = ON;
      `);
    }

    // Add messages.rich_block_ids_json if absent
    const msgColsPost = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (!msgColsPost.some((col) => col.name === 'rich_block_ids_json')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN rich_block_ids_json TEXT NOT NULL DEFAULT '[]';");
    }

    // Migrate legacy artifacts table (which had chat_id NOT NULL and lacked scope_kind/lifecycle_state/revision)
    const artCols = this.db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>;
    if (!artCols.some((col) => col.name === 'scope_kind')) {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN;
        CREATE TABLE artifacts_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          scope_kind TEXT NOT NULL DEFAULT 'chat',
          chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          message_id TEXT,
          run_id TEXT,
          rel_path TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          source TEXT NOT NULL,
          preview_kind TEXT NOT NULL,
          diff_patch TEXT,
          lifecycle_state TEXT NOT NULL DEFAULT 'active',
          deleted_on_disk INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 1,
          dependency_manifest_hash TEXT,
          source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          source_base_revision INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (
            (scope_kind = 'chat' AND chat_id IS NOT NULL AND project_id IS NULL)
            OR (scope_kind = 'project' AND project_id IS NOT NULL AND chat_id IS NULL)
          ),
          CHECK (source_base_revision IS NULL OR source_artifact_id IS NOT NULL)
        );
        INSERT INTO artifacts_new (
          id, user_id, scope_kind, chat_id, project_id, message_id, run_id, rel_path, filename,
          mime_type, size_bytes, sha256, source, preview_kind, diff_patch,
          lifecycle_state, deleted_on_disk, revision, dependency_manifest_hash,
          source_artifact_id, source_base_revision, created_at, updated_at
        )
        SELECT
          id, user_id, 'chat', chat_id, NULL, message_id, run_id, rel_path, filename,
          mime_type, size_bytes, sha256, source, preview_kind, diff_patch,
          'active', 0, 1, NULL,
          NULL, NULL, created_at, updated_at
        FROM artifacts;
        DROP TABLE artifacts;
        ALTER TABLE artifacts_new RENAME TO artifacts;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    }

    // Ensure partial unique indexes and lookup indexes on unified artifacts table
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_chat ON artifacts(chat_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_chat_rel_active
        ON artifacts(chat_id, rel_path) WHERE scope_kind = 'chat' AND lifecycle_state != 'deleted';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_project_rel_active
        ON artifacts(project_id, rel_path) WHERE scope_kind = 'project' AND lifecycle_state != 'deleted';
    `);

    // Add project_files.artifact_id and backfill 1:1 unified project artifacts
    const pfCols = this.db.prepare('PRAGMA table_info(project_files)').all() as Array<{ name: string }>;
    if (!pfCols.some((col) => col.name === 'artifact_id')) {
      this.db.exec('ALTER TABLE project_files ADD COLUMN artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE;');
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_files_artifact_id
        ON project_files(artifact_id) WHERE artifact_id IS NOT NULL;
    `);
    const unlinkedProjectFiles = this.db
      .prepare('SELECT * FROM project_files WHERE artifact_id IS NULL')
      .all() as Array<Record<string, unknown>>;
    if (unlinkedProjectFiles.length > 0) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        for (const pf of unlinkedProjectFiles) {
          const projectId = String(pf.project_id);
          const userId = String(pf.user_id);
          const relPath = String(pf.rel_path);
          const filename = String(pf.filename);
          const mimeType = String(pf.mime_type);
          const sizeBytes = Number(pf.size_bytes);
          const sha256 = String(pf.sha256);
          const createdAt = Number(pf.created_at);
          const existingArt = this.db
            .prepare(
              `SELECT id FROM artifacts
               WHERE scope_kind = 'project' AND project_id = ? AND rel_path = ? AND lifecycle_state != 'deleted'`
            )
            .get(projectId, relPath) as { id: string } | undefined;
          let artifactId = existingArt?.id;
          if (!artifactId) {
            artifactId = crypto.randomUUID();
            const { previewKind } = detectMimeAndPreviewKind(filename, mimeType);
            this.db
              .prepare(
                `INSERT INTO artifacts (
                   id, user_id, scope_kind, chat_id, project_id, message_id, run_id,
                   rel_path, filename, mime_type, size_bytes, sha256, source, preview_kind,
                   diff_patch, lifecycle_state, deleted_on_disk, revision, dependency_manifest_hash,
                   source_artifact_id, source_base_revision, created_at, updated_at
                 ) VALUES (?, ?, 'project', NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, 'project_upload', ?, NULL, 'active', 0, 1, NULL, NULL, NULL, ?, ?)`
              )
              .run(
                artifactId,
                userId,
                projectId,
                relPath,
                filename,
                mimeType,
                sizeBytes,
                sha256,
                previewKind,
                createdAt,
                createdAt
              );
          }
          this.db
            .prepare('UPDATE project_files SET artifact_id = ? WHERE id = ?')
            .run(artifactId, String(pf.id));
        }
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }
    }

    // Add sync_events.user_seq if absent and backfill monotonically per user
    const syncCols = this.db.prepare('PRAGMA table_info(sync_events)').all() as Array<{ name: string }>;
    if (!syncCols.some((col) => col.name === 'user_seq')) {
      this.db.exec('ALTER TABLE sync_events ADD COLUMN user_seq INTEGER NOT NULL DEFAULT 0;');
    }
    const needsBackfill = this.db
      .prepare('SELECT 1 FROM sync_events WHERE user_seq = 0 LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    if (needsBackfill) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        const users = this.db
          .prepare('SELECT DISTINCT user_id FROM sync_events WHERE user_seq = 0')
          .all() as Array<{ user_id: string }>;
        for (const { user_id: uid } of users) {
          const rows = this.db
            .prepare('SELECT seq FROM sync_events WHERE user_id = ? ORDER BY seq ASC')
            .all(uid) as Array<{ seq: number }>;
          let counter = 0;
          const upd = this.db.prepare('UPDATE sync_events SET user_seq = ? WHERE seq = ?');
          for (const row of rows) {
            counter += 1;
            upd.run(counter, row.seq);
          }
        }
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_events_user_user_seq
        ON sync_events(user_id, user_seq) WHERE user_seq > 0;
    `);

    const journalCols = this.db.prepare('PRAGMA table_info(artifact_commit_journal)').all() as Array<{ name: string }>;
    if (!journalCols.some((col) => col.name === 'batch_seq')) {
      this.db.exec('ALTER TABLE artifact_commit_journal ADD COLUMN batch_seq INTEGER;');
    }
    if (!journalCols.some((col) => col.name === 'staging_isolation_mode')) {
      this.db.exec('ALTER TABLE artifact_commit_journal ADD COLUMN staging_isolation_mode TEXT;');
    }
    const requestCols = this.db.prepare('PRAGMA table_info(ai_edit_requests)').all();
    if (!requestCols.some(col => col.name === 'sort_order')) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE ai_edit_requests ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id, chat_id ORDER BY created_at, id) AS position
          FROM ai_edit_requests
        )
        UPDATE ai_edit_requests SET sort_order = (SELECT position FROM ranked WHERE ranked.id = ai_edit_requests.id);
        COMMIT;
      `);
    }

  }

  recoverInterruptedRuns(): void {
    const now = Date.now();
    this.db.exec('BEGIN;');
    try {
      this.db
        .prepare(
          `UPDATE runs
           SET status = 'error',
               stop_reason = 'server_restart',
               error_message = COALESCE(error_message, 'サーバー再起動のため処理が中断されました。続きを送信して再開できます。'),
               finished_at = COALESCE(finished_at, ?)
           WHERE status IN ('queued', 'running', 'awaiting_permission')`
        )
        .run(now);
      this.db
        .prepare(
          `UPDATE messages
           SET status = 'error',
               error_message = COALESCE(error_message, 'サーバー再起動のため生成が中断されました。'),
               updated_at = ?
           WHERE status IN ('queued', 'streaming')`
        )
        .run(now);
      this.db
        .prepare(
          `UPDATE pending_permissions
           SET status = 'cancelled',
               resolved_at = COALESCE(resolved_at, ?)
           WHERE status = 'pending'`
        )
        .run(now);
      this.db
        .prepare(
          `UPDATE pending_elicitations
           SET status = 'cancelled',
               selected_action = COALESCE(selected_action, 'cancel'),
               resolved_at = COALESCE(resolved_at, ?)
           WHERE status = 'pending'`
        )
        .run(now);
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  // ---- Users & Sessions ----

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number };
    return Number(row.cnt);
  }

  createUser(params: {
    id: string;
    username: string;
    displayName: string;
    passwordHash: string;
    role: UserRole;
    profileDir: string;
  }): WebUser {
    const now = Date.now();
    this.db.exec('BEGIN;');
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(params.id, params.username, params.displayName, params.passwordHash, params.role, now, now);

      this.db
        .prepare(
          `INSERT INTO agy_profiles (user_id, profile_dir, auth_status, updated_at)
           VALUES (?, ?, 'unauthenticated', ?)`
        )
        .run(params.id, params.profileDir, now);

      this.db
        .prepare(
          `INSERT INTO user_preferences (user_id, theme, notify_on_response, updated_at)
           VALUES (?, 'system', 0, ?)`
        )
        .run(params.id, now);
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return {
      id: params.id,
      username: params.username,
      displayName: params.displayName,
      role: params.role,
      createdAt: now,
      updatedAt: now,
    };
  }

  findUserByUsername(username: string): StoredUserRow | null {
    const row = this.db
      .prepare('SELECT id, username, display_name, password_hash, role, created_at, updated_at FROM users WHERE username = ?')
      .get(username) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      username: String(row.username),
      displayName: String(row.display_name),
      passwordHash: String(row.password_hash),
      role: row.role as UserRole,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  findUserById(userId: string): WebUser | null {
    const row = this.db
      .prepare('SELECT id, username, display_name, role, created_at, updated_at FROM users WHERE id = ?')
      .get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      username: String(row.username),
      displayName: String(row.display_name),
      role: row.role as UserRole,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  createWebSession(params: {
    sessionIdHash: string;
    userId: string;
    userAgent: string;
    expiresAt: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO web_sessions (id, user_id, user_agent, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(params.sessionIdHash, params.userId, params.userAgent, now, params.expiresAt, now);
  }

  getSessionUser(sessionIdHash: string): { user: WebUser; expiresAt: number } | null {
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.created_at, u.updated_at, s.expires_at
         FROM web_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ?`
      )
      .get(sessionIdHash, now) as Record<string, unknown> | undefined;
    if (!row) return null;

    this.db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?').run(now, sessionIdHash);
    return {
      user: {
        id: String(row.id),
        username: String(row.username),
        displayName: String(row.display_name),
        role: row.role as UserRole,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      },
      expiresAt: Number(row.expires_at),
    };
  }

  deleteWebSession(sessionIdHash: string): void {
    this.db.prepare('DELETE FROM web_sessions WHERE id = ?').run(sessionIdHash);
  }

  deleteAllUserSessions(userId: string): void {
    this.db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(userId);
  }

  // ---- Agy Profiles (1:1 per user) ----

  listAgyProfileDirs(): string[] {
    const rows = this.db.prepare('SELECT profile_dir FROM agy_profiles').all() as { profile_dir: string }[];
    return rows.map((row) => row.profile_dir);
  }

  listAgyProfiles(): Array<{ userId: string; profileDir: string }> {
    const rows = this.db.prepare('SELECT user_id, profile_dir FROM agy_profiles').all() as Array<{
      user_id: string;
      profile_dir: string;
    }>;
    return rows.map((row) => ({ userId: String(row.user_id), profileDir: String(row.profile_dir) }));
  }

  withAgyProfileSettingsWrite(write: () => void): void {
    // Use the shared database to serialize ChatUI writers across processes.
    // SQLite releases the lock even if a server process exits mid-save.
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      write();
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  getAgyProfile(userId: string): AgyProfile | null {
    const row = this.db
      .prepare(
        `SELECT user_id, profile_dir, auth_status, auth_method, account_label, last_verified_at, last_error, updated_at
         FROM agy_profiles WHERE user_id = ?`
      )
      .get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      userId: String(row.user_id),
      profileDir: String(row.profile_dir),
      authStatus: row.auth_status as AgyAuthStatus,
      authMethod: (row.auth_method as AgyAuthMethod) ?? null,
      accountLabel: row.account_label ? String(row.account_label) : null,
      lastVerifiedAt: row.last_verified_at !== null ? Number(row.last_verified_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      updatedAt: Number(row.updated_at),
    };
  }

  getAgyEncryptedApiKey(userId: string): string | null {
    const row = this.db
      .prepare('SELECT encrypted_api_key FROM agy_profiles WHERE user_id = ?')
      .get(userId) as { encrypted_api_key: string | null } | undefined;
    return row?.encrypted_api_key ?? null;
  }

  updateAgyProfile(
    userId: string,
    patch: {
      authStatus?: AgyAuthStatus;
      authMethod?: AgyAuthMethod;
      accountLabel?: string | null;
      encryptedApiKey?: string | null;
      lastVerifiedAt?: number | null;
      lastError?: string | null;
    }
  ): AgyProfile {
    const now = Date.now();
    const existing = this.getAgyProfile(userId);
    if (!existing) throw new Error(`Agy profile not found for user ${userId}`);
    const nextEncryptedKey =
      patch.encryptedApiKey !== undefined ? patch.encryptedApiKey : this.getAgyEncryptedApiKey(userId);

    this.db
      .prepare(
        `UPDATE agy_profiles
         SET auth_status = ?, auth_method = ?, account_label = ?, encrypted_api_key = ?,
             last_verified_at = ?, last_error = ?, updated_at = ?
         WHERE user_id = ?`
      )
      .run(
        patch.authStatus ?? existing.authStatus,
        patch.authMethod !== undefined ? patch.authMethod : existing.authMethod,
        patch.accountLabel !== undefined ? patch.accountLabel : existing.accountLabel,
        nextEncryptedKey,
        patch.lastVerifiedAt !== undefined ? patch.lastVerifiedAt : existing.lastVerifiedAt,
        patch.lastError !== undefined ? patch.lastError : existing.lastError,
        now,
        userId
      );
    return this.getAgyProfile(userId)!;
  }

  // ---- User Preferences ----

  getPreferences(userId: string): UserPreferences {
    const row = this.db
      .prepare(
        `SELECT user_id, theme, notify_on_response, haptic_feedback, default_model_id, default_effort_value, updated_at
         FROM user_preferences WHERE user_id = ?`
      )
      .get(userId) as Record<string, unknown> | undefined;
    if (!row) {
      const now = Date.now();
      return {
        userId,
        theme: 'system',
        notifyOnResponse: false,
        hapticFeedback: true,
        defaultModelId: null,
        defaultEffortValue: null,
        updatedAt: now,
      };
    }
    return {
      userId: String(row.user_id),
      theme: row.theme as 'system' | 'light' | 'dark',
      notifyOnResponse: Number(row.notify_on_response) === 1,
      hapticFeedback: row.haptic_feedback === undefined || row.haptic_feedback === null ? true : Number(row.haptic_feedback) === 1,
      defaultModelId: row.default_model_id ? String(row.default_model_id) : null,
      defaultEffortValue: row.default_effort_value ? String(row.default_effort_value) : null,
      updatedAt: Number(row.updated_at),
    };
  }

  updatePreferences(
    userId: string,
    patch: Partial<
      Pick<
        UserPreferences,
        'theme' | 'notifyOnResponse' | 'hapticFeedback' | 'defaultModelId' | 'defaultEffortValue'
      >
    >
  ): UserPreferences {
    const cur = this.getPreferences(userId);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO user_preferences (user_id, theme, notify_on_response, haptic_feedback, default_model_id, default_effort_value, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           theme = excluded.theme,
           notify_on_response = excluded.notify_on_response,
           haptic_feedback = excluded.haptic_feedback,
           default_model_id = excluded.default_model_id,
           default_effort_value = excluded.default_effort_value,
           updated_at = excluded.updated_at`
      )
      .run(
        userId,
        patch.theme ?? cur.theme,
        (patch.notifyOnResponse ?? cur.notifyOnResponse) ? 1 : 0,
        (patch.hapticFeedback ?? cur.hapticFeedback) ? 1 : 0,
        patch.defaultModelId !== undefined ? patch.defaultModelId : cur.defaultModelId,
        patch.defaultEffortValue !== undefined ? patch.defaultEffortValue : cur.defaultEffortValue,
        now
      );
    return this.getPreferences(userId);
  }

  // ---- Projects & Project Files ----

  listProjects(userId: string): ProjectRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, name, description, instructions, context_version, storage_dir, created_at, updated_at
         FROM projects WHERE user_id = ? ORDER BY updated_at DESC`
      )
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapProject(r));
  }

  getProject(userId: string, projectId: string): ProjectRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id, name, description, instructions, context_version, storage_dir, created_at, updated_at
         FROM projects WHERE id = ? AND user_id = ?`
      )
      .get(projectId, userId) as Record<string, unknown> | undefined;
    return row ? this.mapProject(row) : null;
  }

  createProject(params: {
    id: string;
    userId: string;
    name: string;
    description: string;
    instructions: string;
    storageDir: string;
  }): ProjectRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, description, instructions, context_version, storage_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(params.id, params.userId, params.name, params.description, params.instructions, params.storageDir, now, now);
    return this.getProject(params.userId, params.id)!;
  }

  updateProject(
    userId: string,
    projectId: string,
    patch: { name?: string; description?: string; instructions?: string; bumpContextVersion?: boolean }
  ): ProjectRecord | null {
    const existing = this.getProject(userId, projectId);
    if (!existing) return null;
    const now = Date.now();
    const nextVersion = patch.bumpContextVersion ? existing.contextVersion + 1 : existing.contextVersion;
    this.db
      .prepare(
        `UPDATE projects
         SET name = ?, description = ?, instructions = ?, context_version = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`
      )
      .run(
        patch.name ?? existing.name,
        patch.description ?? existing.description,
        patch.instructions ?? existing.instructions,
        nextVersion,
        now,
        projectId,
        userId
      );
    return this.getProject(userId, projectId);
  }

  listChatIdsForProject(userId: string, projectId: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM chats WHERE user_id = ? AND project_id = ?')
      .all(userId, projectId) as Array<{ id: string }>;
    return rows.map((r) => String(r.id));
  }

  deleteProject(userId: string, projectId: string): boolean {
    const info = this.db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(projectId, userId);
    return Number(info.changes) > 0;
  }

  listProjectFiles(userId: string, projectId: string): ProjectFileRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, user_id, artifact_id, rel_path, filename, mime_type, size_bytes, sha256, created_at
         FROM project_files WHERE project_id = ? AND user_id = ? ORDER BY created_at ASC`
      )
      .all(projectId, userId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      userId: String(r.user_id),
      artifactId: r.artifact_id ? String(r.artifact_id) : null,
      relPath: String(r.rel_path),
      filename: String(r.filename),
      mimeType: String(r.mime_type),
      sizeBytes: Number(r.size_bytes),
      sha256: String(r.sha256),
      createdAt: Number(r.created_at),
    }));
  }

  getProjectFileById(userId: string, projectId: string, fileId: string): ProjectFileRecord | null {
    const r = this.db
      .prepare(
        `SELECT id, project_id, user_id, artifact_id, rel_path, filename, mime_type, size_bytes, sha256, created_at
         FROM project_files WHERE id = ? AND project_id = ? AND user_id = ?`
      )
      .get(fileId, projectId, userId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      userId: String(r.user_id),
      artifactId: r.artifact_id ? String(r.artifact_id) : null,
      relPath: String(r.rel_path),
      filename: String(r.filename),
      mimeType: String(r.mime_type),
      sizeBytes: Number(r.size_bytes),
      sha256: String(r.sha256),
      createdAt: Number(r.created_at),
    };
  }

  upsertProjectFileInTx(file: ProjectFileRecord, now: number): void {
    this.db
      .prepare(
        `INSERT INTO project_files (id, project_id, user_id, artifact_id, rel_path, filename, mime_type, size_bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, rel_path) DO UPDATE SET
           artifact_id = COALESCE(excluded.artifact_id, project_files.artifact_id),
           filename = excluded.filename,
           mime_type = excluded.mime_type,
           size_bytes = excluded.size_bytes,
           sha256 = excluded.sha256,
           created_at = excluded.created_at`
      )
      .run(
        file.id,
        file.projectId,
        file.userId,
        file.artifactId ?? null,
        file.relPath,
        file.filename,
        file.mimeType,
        file.sizeBytes,
        file.sha256,
        file.createdAt
      );
    this.db
      .prepare('UPDATE projects SET context_version = context_version + 1, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(now, file.projectId, file.userId);
  }

  upsertProjectFile(file: ProjectFileRecord): { file: ProjectFileRecord; contextVersion: number } {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.upsertProjectFileInTx(file, now);
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
    const proj = this.getProject(file.userId, file.projectId)!;
    const files = this.listProjectFiles(file.userId, file.projectId);
    const saved = files.find((f) => f.relPath === file.relPath)!;
    return { file: saved, contextVersion: proj.contextVersion };
  }

  deleteProjectFile(userId: string, projectId: string, fileId: string): { deleted: ProjectFileRecord | null; contextVersion: number | null } {
    const existing = this.getProjectFileById(userId, projectId, fileId);
    if (!existing) return { deleted: null, contextVersion: null };
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('DELETE FROM project_files WHERE id = ? AND user_id = ?').run(fileId, userId);
      if (existing.artifactId) {
        this.db
          .prepare("UPDATE artifacts SET lifecycle_state = 'deleted', deleted_on_disk = 1, updated_at = ? WHERE id = ? AND user_id = ?")
          .run(now, existing.artifactId, userId);
      }
      this.db
        .prepare('UPDATE projects SET context_version = context_version + 1, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(now, projectId, userId);
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
    const proj = this.getProject(userId, projectId);
    return {
      deleted: existing,
      contextVersion: proj?.contextVersion ?? null,
    };
  }

  private mapProject(r: Record<string, unknown>): ProjectRecord {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      name: String(r.name),
      description: String(r.description),
      instructions: String(r.instructions),
      contextVersion: Number(r.context_version),
      storageDir: String(r.storage_dir),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  // ---- Chats ----

  listChats(userId: string, opts: { search?: string; projectId?: string | null } = {}): ChatRecord[] {
    if (opts.search && opts.search.trim()) {
      const q = `%${opts.search.trim()}%`;
      const rows = this.db
        .prepare(
          `SELECT DISTINCT c.*
           FROM chats c
           INNER JOIN messages m ON m.chat_id = c.id AND m.user_id = c.user_id
           WHERE c.user_id = ? AND (c.title LIKE ? OR m.content_text LIKE ?)
           ORDER BY c.last_message_at DESC, c.created_at DESC`
        )
        .all(userId, q, q) as Array<Record<string, unknown>>;
      return rows.map((r) => this.mapChat(r));
    }
    if (opts.projectId) {
      const rows = this.db
        .prepare(
          `SELECT c.*
           FROM chats c
           WHERE c.user_id = ? AND c.project_id = ?
             AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.user_id = c.user_id)
           ORDER BY c.last_message_at DESC, c.created_at DESC`
        )
        .all(userId, opts.projectId) as Array<Record<string, unknown>>;
      return rows.map((r) => this.mapChat(r));
    }
    const rows = this.db
      .prepare(
        `SELECT c.*
         FROM chats c
         WHERE c.user_id = ?
           AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.user_id = c.user_id)
         ORDER BY c.last_message_at DESC, c.created_at DESC`
      )
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapChat(r));
  }

  getChat(userId: string, chatId: string): ChatRecord | null {
    const row = this.db
      .prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?')
      .get(chatId, userId) as Record<string, unknown> | undefined;
    return row ? this.mapChat(row) : null;
  }

  createChat(params: {
    id: string;
    userId: string;
    projectId: string | null;
    title: string;
    workspaceDir: string;
    modelId: string | null;
    effortValue: string | null;
    projectContextVersion: number;
  }): ChatRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO chats (
           id, user_id, project_id, title, workspace_dir, acp_session_id,
           model_id, effort_value, project_context_version, created_at, updated_at, last_message_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.id,
        params.userId,
        params.projectId,
        params.title,
        params.workspaceDir,
        params.modelId,
        params.effortValue,
        params.projectContextVersion,
        now,
        now,
        now
      );
    return this.getChat(params.userId, params.id)!;
  }

  updateChat(
    userId: string,
    chatId: string,
    patch: {
      title?: string;
      projectId?: string | null;
      acpSessionId?: string | null;
      modelId?: string | null;
      effortValue?: string | null;
      projectContextVersion?: number;
      contextUsed?: number | null;
      contextSize?: number | null;
      lastMessageAt?: number;
    }
  ): ChatRecord | null {
    const existing = this.getChat(userId, chatId);
    if (!existing) return null;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE chats
         SET title = ?, project_id = ?, acp_session_id = ?, model_id = ?, effort_value = ?,
             project_context_version = ?, context_used = ?, context_size = ?, updated_at = ?, last_message_at = ?
         WHERE id = ? AND user_id = ?`
      )
      .run(
        patch.title ?? existing.title,
        patch.projectId !== undefined ? patch.projectId : existing.projectId,
        patch.acpSessionId !== undefined ? patch.acpSessionId : existing.acpSessionId,
        patch.modelId !== undefined ? patch.modelId : existing.modelId,
        patch.effortValue !== undefined ? patch.effortValue : existing.effortValue,
        patch.projectContextVersion ?? existing.projectContextVersion,
        patch.contextUsed !== undefined ? patch.contextUsed : (existing.contextUsed ?? null),
        patch.contextSize !== undefined ? patch.contextSize : (existing.contextSize ?? null),
        now,
        patch.lastMessageAt ?? existing.lastMessageAt,
        chatId,
        userId
      );
    return this.getChat(userId, chatId);
  }

  deleteChat(userId: string, chatId: string): boolean {
    const info = this.db.prepare('DELETE FROM chats WHERE id = ? AND user_id = ?').run(chatId, userId);
    return Number(info.changes) > 0;
  }

  private mapChat(r: Record<string, unknown>): ChatRecord {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      projectId: r.project_id ? String(r.project_id) : null,
      title: String(r.title),
      workspaceDir: String(r.workspace_dir),
      acpSessionId: r.acp_session_id ? String(r.acp_session_id) : null,
      modelId: r.model_id ? String(r.model_id) : null,
      effortValue: r.effort_value ? String(r.effort_value) : null,
      projectContextVersion: Number(r.project_context_version),
      contextUsed: r.context_used !== null && r.context_used !== undefined ? Number(r.context_used) : null,
      contextSize: r.context_size !== null && r.context_size !== undefined ? Number(r.context_size) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      lastMessageAt: Number(r.last_message_at),
    };
  }

  // ---- Messages ----

  listMessages(userId: string, chatId: string): MessageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? AND user_id = ? ORDER BY created_at ASC')
      .all(chatId, userId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMessage(r));
  }

  getMessage(userId: string, messageId: string): MessageRecord | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?')
      .get(messageId, userId) as Record<string, unknown> | undefined;
    return row ? this.mapMessage(row) : null;
  }

  findMessageByClientId(userId: string, chatId: string, clientMessageId: string): MessageRecord | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? AND user_id = ? AND client_message_id = ?')
      .get(chatId, userId, clientMessageId) as Record<string, unknown> | undefined;
    return row ? this.mapMessage(row) : null;
  }

  createMessage(params: {
    id: string;
    chatId: string;
    userId: string;
    clientMessageId?: string | null;
    role: 'user' | 'assistant' | 'system';
    contentText?: string;
    thoughtsText?: string;
    toolCalls?: ToolCallItem[];
    sessionMessages?: SessionMessageItem[];
    attachments?: AttachmentRef[];
    artifactIds?: string[];
    status: 'queued' | 'streaming' | 'completed' | 'cancelled' | 'error';
    runId?: string | null;
    createdAt?: number;
  }): MessageRecord {
    const now = params.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO messages (
           id, chat_id, user_id, client_message_id, role, content_text, thoughts_text,
           tool_calls_json, session_messages_json, attachments_json, artifact_refs_json, status, run_id, error_message, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        params.id,
        params.chatId,
        params.userId,
        params.clientMessageId ?? null,
        params.role,
        params.contentText ?? '',
        params.thoughtsText ?? '',
        JSON.stringify(params.toolCalls ?? []),
        JSON.stringify(params.sessionMessages ?? []),
        JSON.stringify(params.attachments ?? []),
        JSON.stringify(params.artifactIds ?? []),
        params.status,
        params.runId ?? null,
        now,
        now
      );
    return this.getMessage(params.userId, params.id)!;
  }

  updateMessage(
    userId: string,
    messageId: string,
    patch: {
      contentText?: string;
      thoughtsText?: string;
      toolCalls?: ToolCallItem[];
      activity?: MessageActivity[];
      sessionMessages?: SessionMessageItem[];
      artifactIds?: string[];
      status?: 'queued' | 'streaming' | 'completed' | 'cancelled' | 'error';
      runId?: string | null;
      errorMessage?: string | null;
    }
  ): MessageRecord | null {
    const cur = this.getMessage(userId, messageId);
    if (!cur) return null;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE messages
         SET content_text = ?, thoughts_text = ?, tool_calls_json = ?, activity_json = ?, session_messages_json = ?, artifact_refs_json = ?,
             status = ?, run_id = ?, error_message = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`
      )
      .run(
        patch.contentText ?? cur.contentText,
        patch.thoughtsText ?? cur.thoughtsText,
        JSON.stringify(patch.toolCalls ?? cur.toolCalls),
        JSON.stringify(patch.activity ?? cur.activity ?? []),
        JSON.stringify(patch.sessionMessages ?? cur.sessionMessages ?? []),
        JSON.stringify(patch.artifactIds ?? cur.artifactIds),
        patch.status ?? cur.status,
        patch.runId !== undefined ? patch.runId : cur.runId,
        patch.errorMessage !== undefined ? patch.errorMessage : cur.errorMessage,
        now,
        messageId,
        userId
      );
    return this.getMessage(userId, messageId);
  }

  deleteMessagesFrom(userId: string, chatId: string, fromCreatedAt: number): void {
    this.db
      .prepare('DELETE FROM messages WHERE chat_id = ? AND user_id = ? AND created_at >= ?')
      .run(chatId, userId, fromCreatedAt);
  }

  private mapMessage(r: Record<string, unknown>): MessageRecord {
    const rawSessionMessages = r.session_messages_json ? String(r.session_messages_json) : '[]';
    const rawRichBlockIds = r.rich_block_ids_json ? String(r.rich_block_ids_json) : '[]';
    return {
      id: String(r.id),
      chatId: String(r.chat_id),
      userId: String(r.user_id),
      clientMessageId: r.client_message_id ? String(r.client_message_id) : null,
      role: r.role as 'user' | 'assistant' | 'system',
      contentText: String(r.content_text),
      thoughtsText: String(r.thoughts_text),
      toolCalls: JSON.parse(String(r.tool_calls_json)) as ToolCallItem[],
      activity: JSON.parse(String(r.activity_json)) as MessageActivity[],
      sessionMessages: JSON.parse(rawSessionMessages) as SessionMessageItem[],
      attachments: JSON.parse(String(r.attachments_json)) as AttachmentRef[],
      artifactIds: JSON.parse(String(r.artifact_refs_json)) as string[],
      richBlockIds: JSON.parse(rawRichBlockIds) as string[],
      status: r.status as MessageRecord['status'],
      runId: r.run_id ? String(r.run_id) : null,
      errorMessage: r.error_message ? String(r.error_message) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  syncConfirmedRichBlocksForMessageInTx(userId: string, messageId: string, now: number): void {
    const ids = this.db.prepare(`
      SELECT id FROM rich_blocks
      WHERE user_id = ? AND confirmed_message_id = ? AND binding_state = 'confirmed_by_tool_call'
      ORDER BY created_seq
    `).all(userId, messageId) as Array<{ id: string }>;
    this.db.prepare('UPDATE messages SET rich_block_ids_json = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(JSON.stringify(ids.map(({ id }) => id)), now, messageId, userId);
  }

  // ---- Runs & Permissions ----

  createRun(params: {
    id: string;
    chatId: string;
    userId: string;
    userMessageId: string;
    assistantMessageId: string;
    status: RunRecord['status'];
    queuePosition: number;
    modelId: string | null;
    effortValue: string | null;
  }): RunRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO runs (
           id, chat_id, user_id, user_message_id, assistant_message_id, status, queue_position,
           model_id, effort_value, stop_reason, error_message, started_at, finished_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`
      )
      .run(
        params.id,
        params.chatId,
        params.userId,
        params.userMessageId,
        params.assistantMessageId,
        params.status,
        params.queuePosition,
        params.modelId,
        params.effortValue,
        now
      );
    return this.getRun(params.userId, params.id)!;
  }

  getRun(userId: string, runId: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?').get(runId, userId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRun(row) : null;
  }

  getActiveRunForChat(userId: string, chatId: string): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE chat_id = ? AND user_id = ? AND status IN ('queued', 'running', 'awaiting_permission')
         ORDER BY CASE WHEN status IN ('running', 'awaiting_permission') THEN 0 ELSE 1 END ASC, created_at ASC, id ASC LIMIT 1`
      )
      .get(chatId, userId) as Record<string, unknown> | undefined;
    return row ? this.mapRun(row) : null;
  }

  updateRun(
    userId: string,
    runId: string,
    patch: {
      status?: RunRecord['status'];
      queuePosition?: number;
      stopReason?: string | null;
      errorMessage?: string | null;
      startedAt?: number | null;
      finishedAt?: number | null;
    }
  ): RunRecord | null {
    const cur = this.getRun(userId, runId);
    if (!cur) return null;
    const isTerminal =
      cur.status === 'completed' || cur.status === 'cancelled' || cur.status === 'error';
    const nextStatus =
      isTerminal &&
      patch.status &&
      (patch.status === 'queued' || patch.status === 'running' || patch.status === 'awaiting_permission')
        ? cur.status
        : (patch.status ?? cur.status);
    this.db
      .prepare(
        `UPDATE runs
         SET status = ?, queue_position = ?, stop_reason = ?, error_message = ?, started_at = ?, finished_at = ?
         WHERE id = ? AND user_id = ?`
      )
      .run(
        nextStatus,
        patch.queuePosition ?? cur.queuePosition,
        patch.stopReason !== undefined ? patch.stopReason : cur.stopReason,
        patch.errorMessage !== undefined ? patch.errorMessage : cur.errorMessage,
        patch.startedAt !== undefined ? patch.startedAt : cur.startedAt,
        patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt,
        runId,
        userId
      );
    return this.getRun(userId, runId);
  }

  private mapRun(r: Record<string, unknown>): RunRecord {
    return {
      id: String(r.id),
      chatId: String(r.chat_id),
      userId: String(r.user_id),
      userMessageId: String(r.user_message_id),
      assistantMessageId: String(r.assistant_message_id),
      status: r.status as RunRecord['status'],
      queuePosition: Number(r.queue_position),
      modelId: r.model_id ? String(r.model_id) : null,
      effortValue: r.effort_value ? String(r.effort_value) : null,
      stopReason: r.stop_reason ? String(r.stop_reason) : null,
      errorMessage: r.error_message ? String(r.error_message) : null,
      startedAt: r.started_at !== null ? Number(r.started_at) : null,
      finishedAt: r.finished_at !== null ? Number(r.finished_at) : null,
      createdAt: Number(r.created_at),
    };
  }

  createPendingPermission(params: {
    id: string;
    runId: string;
    chatId: string;
    userId: string;
    toolCall: ToolCallItem;
    options: PermissionOptionItem[];
    alwaysAllowRule?: string | null;
  }): PendingPermissionRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pending_permissions (id, run_id, chat_id, user_id, tool_call_json, options_json, always_allow_rule, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        params.id,
        params.runId,
        params.chatId,
        params.userId,
        JSON.stringify(params.toolCall),
        JSON.stringify(params.options),
        params.alwaysAllowRule ?? null,
        now
      );
    return this.getPermission(params.userId, params.id)!;
  }

  getPermission(userId: string, permissionId: string): PendingPermissionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM pending_permissions WHERE id = ? AND user_id = ?')
      .get(permissionId, userId) as Record<string, unknown> | undefined;
    return row ? this.mapPermission(row) : null;
  }

  listPendingPermissionsForChat(userId: string, chatId: string): PendingPermissionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM pending_permissions WHERE chat_id = ? AND user_id = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(chatId, userId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPermission(r));
  }

  resolvePermissionAtomically(params: {
    userId: string;
    permissionId: string;
    selectedOptionId: string | null;
    status: 'resolved' | 'cancelled';
    clientId?: string | null;
  }): PendingPermissionRecord | null {
    const now = Date.now();
    const info = this.db
      .prepare(
        `UPDATE pending_permissions
         SET status = ?, selected_option_id = ?, resolved_by_client_id = ?, resolved_at = ?
         WHERE id = ? AND user_id = ? AND status = 'pending'`
      )
      .run(params.status, params.selectedOptionId, params.clientId ?? null, now, params.permissionId, params.userId);
    if (Number(info.changes) === 0) return null;
    return this.getPermission(params.userId, params.permissionId);
  }

  private mapPermission(r: Record<string, unknown>): PendingPermissionRecord {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      chatId: String(r.chat_id),
      userId: String(r.user_id),
      toolCall: JSON.parse(String(r.tool_call_json)) as ToolCallItem,
      options: JSON.parse(String(r.options_json)) as PermissionOptionItem[],
      alwaysAllowRule: r.always_allow_rule ? String(r.always_allow_rule) : null,
      status: r.status as PendingPermissionRecord['status'],
      selectedOptionId: r.selected_option_id ? String(r.selected_option_id) : null,
      resolvedByClientId: r.resolved_by_client_id ? String(r.resolved_by_client_id) : null,
      createdAt: Number(r.created_at),
      resolvedAt: r.resolved_at !== null ? Number(r.resolved_at) : null,
    };
  }

  createPendingElicitation(params: {
    id: string;
    runId?: string | null;
    chatId: string;
    userId: string;
    toolCallId?: string | null;
    externalElicitationId?: string | null;
    mode: 'form' | 'url';
    message: string;
    requestedSchema?: ElicitationFormSchema | null;
    url?: string | null;
  }): PendingElicitationRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pending_elicitations (
           id, run_id, chat_id, user_id, tool_call_id, external_elicitation_id, mode, message,
           requested_schema_json, url, url_completed, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)`
      )
      .run(
        params.id,
        params.runId ?? null,
        params.chatId,
        params.userId,
        params.toolCallId ?? null,
        params.externalElicitationId ?? null,
        params.mode,
        params.message,
        params.requestedSchema ? JSON.stringify(params.requestedSchema) : null,
        params.url ?? null,
        now
      );
    return this.getElicitation(params.userId, params.id)!;
  }

  getElicitation(userId: string, elicitationId: string): PendingElicitationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM pending_elicitations WHERE id = ? AND user_id = ?')
      .get(elicitationId, userId) as Record<string, unknown> | undefined;
    return row ? this.mapElicitation(row) : null;
  }

  getPendingElicitationByExternalId(
    userId: string,
    chatId: string,
    externalElicitationId: string
  ): PendingElicitationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM pending_elicitations
         WHERE user_id = ? AND chat_id = ? AND external_elicitation_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(userId, chatId, externalElicitationId) as Record<string, unknown> | undefined;
    return row ? this.mapElicitation(row) : null;
  }

  markElicitationUrlCompleted(
    userId: string,
    chatId: string,
    externalElicitationId: string
  ): PendingElicitationRecord | null {
    const existing = this.getPendingElicitationByExternalId(userId, chatId, externalElicitationId);
    if (!existing) return null;
    this.db
      .prepare("UPDATE pending_elicitations SET url_completed = 1 WHERE id = ? AND user_id = ? AND status = 'pending'")
      .run(existing.id, userId);
    return this.getElicitation(userId, existing.id);
  }

  listPendingElicitationsForChat(userId: string, chatId: string): PendingElicitationRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM pending_elicitations WHERE chat_id = ? AND user_id = ? AND status = 'pending' ORDER BY created_at ASC"
      )
      .all(chatId, userId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapElicitation(r));
  }

  resolveElicitationAtomically(params: {
    userId: string;
    elicitationId: string;
    selectedAction: 'accept' | 'decline' | 'cancel';
    responseContent?: Record<string, ElicitationContentValue> | null;
    status: 'resolved' | 'cancelled';
    clientId?: string | null;
  }): PendingElicitationRecord | null {
    const now = Date.now();
    const info = this.db
      .prepare(
        `UPDATE pending_elicitations
         SET status = ?, selected_action = ?, response_content_json = ?, resolved_by_client_id = ?, resolved_at = ?
         WHERE id = ? AND user_id = ? AND status = 'pending'`
      )
      .run(
        params.status,
        params.selectedAction,
        params.responseContent ? JSON.stringify(params.responseContent) : null,
        params.clientId ?? null,
        now,
        params.elicitationId,
        params.userId
      );
    if (Number(info.changes) === 0) return null;
    return this.getElicitation(params.userId, params.elicitationId);
  }

  private mapElicitation(r: Record<string, unknown>): PendingElicitationRecord {
    return {
      id: String(r.id),
      runId: r.run_id ? String(r.run_id) : null,
      chatId: String(r.chat_id),
      userId: String(r.user_id),
      toolCallId: r.tool_call_id ? String(r.tool_call_id) : null,
      externalElicitationId: r.external_elicitation_id ? String(r.external_elicitation_id) : null,
      mode: (String(r.mode) === 'url' ? 'url' : 'form') as PendingElicitationRecord['mode'],
      message: String(r.message),
      requestedSchema: r.requested_schema_json
        ? (JSON.parse(String(r.requested_schema_json)) as ElicitationFormSchema)
        : null,
      url: r.url ? String(r.url) : null,
      urlCompleted: Boolean(r.url_completed),
      status: r.status as PendingElicitationRecord['status'],
      selectedAction: (r.selected_action ? String(r.selected_action) : null) as PendingElicitationRecord['selectedAction'],
      responseContent: r.response_content_json
        ? (JSON.parse(String(r.response_content_json)) as Record<string, ElicitationContentValue>)
        : null,
      resolvedByClientId: r.resolved_by_client_id ? String(r.resolved_by_client_id) : null,
      createdAt: Number(r.created_at),
      resolvedAt: r.resolved_at !== null ? Number(r.resolved_at) : null,
    };
  }

  // ---- Artifacts ----

  upsertArtifact(params: {
    id: string;
    userId: string;
    scopeKind?: ArtifactScopeKind;
    chatId: string | null;
    projectId?: string | null;
    messageId: string | null;
    runId: string | null;
    relPath: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    source: ArtifactRecord['source'];
    previewKind: PreviewKind;
    diffPatch: string | null;
    revision?: number;
    dependencyManifestHash?: string | null;
    sourceArtifactId?: string | null;
    sourceBaseRevision?: number | null;
    minUpdatedAt?: number;
  }): ArtifactRecord {
    const scopeKind: ArtifactScopeKind = params.scopeKind ?? (params.projectId ? 'project' : 'chat');
    const chatId = scopeKind === 'chat' ? params.chatId : null;
    const projectId = scopeKind === 'project' ? (params.projectId ?? null) : null;
    const now = Math.max(Date.now(), Math.ceil(params.minUpdatedAt ?? 0));

    const existing =
      scopeKind === 'chat' && chatId
        ? this.findArtifactByRelPath(params.userId, chatId, params.relPath)
        : scopeKind === 'project' && projectId
          ? this.findProjectArtifactByRelPath(params.userId, projectId, params.relPath)
          : null;

    if (existing) {
      this.db
        .prepare(
          `UPDATE artifacts
           SET message_id = COALESCE(?, message_id),
               run_id = COALESCE(?, run_id),
               filename = ?,
               mime_type = ?,
               size_bytes = ?,
               sha256 = ?,
               source = ?,
               preview_kind = ?,
               diff_patch = COALESCE(?, diff_patch),
               lifecycle_state = 'active',
               deleted_on_disk = 0,
               revision = COALESCE(?, revision),
               dependency_manifest_hash = COALESCE(?, dependency_manifest_hash),
               source_artifact_id = COALESCE(?, source_artifact_id),
               source_base_revision = COALESCE(?, source_base_revision),
               updated_at = ?
           WHERE id = ? AND user_id = ?`
        )
        .run(
          params.messageId,
          params.runId,
          params.filename,
          params.mimeType,
          params.sizeBytes,
          params.sha256,
          params.source,
          params.previewKind,
          params.diffPatch,
          params.revision ?? null,
          params.dependencyManifestHash ?? null,
          params.sourceArtifactId ?? null,
          params.sourceBaseRevision ?? null,
          now,
          existing.id,
          params.userId
        );
      return this.getArtifact(params.userId, existing.id)!;
    }

    this.db
      .prepare(
        `INSERT INTO artifacts (
           id, user_id, scope_kind, chat_id, project_id, message_id, run_id,
           rel_path, filename, mime_type, size_bytes, sha256, source, preview_kind,
           diff_patch, lifecycle_state, deleted_on_disk, revision, dependency_manifest_hash,
           source_artifact_id, source_base_revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.id,
        params.userId,
        scopeKind,
        chatId,
        projectId,
        params.messageId,
        params.runId,
        params.relPath,
        params.filename,
        params.mimeType,
        params.sizeBytes,
        params.sha256,
        params.source,
        params.previewKind,
        params.diffPatch,
        params.revision ?? 1,
        params.dependencyManifestHash ?? null,
        params.sourceArtifactId ?? null,
        params.sourceBaseRevision ?? null,
        now,
        now
      );
    return this.getArtifact(params.userId, params.id)!;
  }

  /** Public lookup: strictly returns lifecycle_state = 'active' artifacts only. */
  getArtifact(userId: string, artifactId: string): ArtifactRecord | null {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE id = ? AND user_id = ? AND lifecycle_state = 'active'")
      .get(artifactId, userId) as Record<string, unknown> | undefined;
    return row ? this.mapArtifact(row) : null;
  }

  /** Internal lookup for commit/recovery paths that need to inspect pending_create or deleted rows. */
  getArtifactInternal(artifactId: string): ArtifactRecord | null {
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE id = ?')
      .get(artifactId) as Record<string, unknown> | undefined;
    return row ? this.mapArtifact(row) : null;
  }

  findArtifactByRelPath(userId: string, chatId: string, relPath: string): ArtifactRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM artifacts WHERE scope_kind = 'chat' AND chat_id = ? AND user_id = ? AND rel_path = ? AND lifecycle_state = 'active'"
      )
      .get(chatId, userId, relPath) as Record<string, unknown> | undefined;
    return row ? this.mapArtifact(row) : null;
  }

  findProjectArtifactByRelPath(userId: string, projectId: string, relPath: string): ArtifactRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM artifacts WHERE scope_kind = 'project' AND project_id = ? AND user_id = ? AND rel_path = ? AND lifecycle_state = 'active'"
      )
      .get(projectId, userId, relPath) as Record<string, unknown> | undefined;
    return row ? this.mapArtifact(row) : null;
  }

  listArtifactsForChat(userId: string, chatId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM artifacts WHERE scope_kind = 'chat' AND chat_id = ? AND user_id = ? AND lifecycle_state = 'active' ORDER BY updated_at DESC, created_at DESC"
      )
      .all(chatId, userId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapArtifact(r));
  }

  listArtifactsForProject(userId: string, projectId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM artifacts WHERE scope_kind = 'project' AND project_id = ? AND user_id = ? AND lifecycle_state = 'active' ORDER BY updated_at DESC, created_at DESC"
      )
      .all(projectId, userId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapArtifact(r));
  }

  mapArtifactRow(r: Record<string, unknown>): ArtifactRecord {
    return this.mapArtifact(r);
  }

  private mapArtifact(r: Record<string, unknown>): ArtifactRecord {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      scopeKind: (r.scope_kind === 'project' ? 'project' : 'chat') as ArtifactScopeKind,
      chatId: r.chat_id ? String(r.chat_id) : null,
      projectId: r.project_id ? String(r.project_id) : null,
      messageId: r.message_id ? String(r.message_id) : null,
      runId: r.run_id ? String(r.run_id) : null,
      relPath: String(r.rel_path),
      filename: String(r.filename),
      mimeType: String(r.mime_type),
      sizeBytes: Number(r.size_bytes),
      sha256: String(r.sha256),
      source: r.source as ArtifactRecord['source'],
      previewKind: r.preview_kind as PreviewKind,
      diffPatch: r.diff_patch ? String(r.diff_patch) : null,
      lifecycleState: (r.lifecycle_state ? String(r.lifecycle_state) : 'active') as ArtifactLifecycleState,
      deletedOnDisk: Boolean(r.deleted_on_disk),
      revision: r.revision !== undefined && r.revision !== null ? Number(r.revision) : 1,
      dependencyManifestHash: r.dependency_manifest_hash ? String(r.dependency_manifest_hash) : null,
      sourceArtifactId: r.source_artifact_id ? String(r.source_artifact_id) : null,
      sourceBaseRevision: r.source_base_revision !== undefined && r.source_base_revision !== null
        ? Number(r.source_base_revision)
        : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  // ---- Quota ----

  getQuotaSnapshot(userId: string): QuotaSnapshotRecord | null {
    const row = this.db
      .prepare('SELECT * FROM quota_snapshots WHERE user_id = ?')
      .get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      userId: String(row.user_id),
      status: row.status as QuotaSnapshotRecord['status'],
      buckets: JSON.parse(String(row.buckets_json)) as QuotaBucket[],
      rawSummary: row.raw_summary ? String(row.raw_summary) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      fetchedAt: Number(row.fetched_at),
    };
  }

  saveQuotaSnapshot(snap: QuotaSnapshotRecord): QuotaSnapshotRecord {
    this.db
      .prepare(
        `INSERT INTO quota_snapshots (user_id, status, buckets_json, raw_summary, error_message, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           status = excluded.status,
           buckets_json = excluded.buckets_json,
           raw_summary = excluded.raw_summary,
           error_message = excluded.error_message,
           fetched_at = excluded.fetched_at`
      )
      .run(
        snap.userId,
        snap.status,
        JSON.stringify(snap.buckets),
        snap.rawSummary,
        snap.errorMessage,
        snap.fetchedAt
      );
    return snap;
  }

  // ---- App Key-Value Metadata (e.g. persisted VAPID keypair) ----

  getAppValue(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? String(row.value) : null;
  }

  setAppValue(key: string, value: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO app_kv (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(key, value, now);
  }

  // ---- Push Subscriptions ----

  upsertPushSubscription(params: {
    id: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string;
  }): PushSubscriptionRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent,
           updated_at = excluded.updated_at`
      )
      .run(
        params.id,
        params.userId,
        params.endpoint,
        params.p256dh,
        params.auth,
        params.userAgent,
        now,
        now
      );

    const row = this.db
      .prepare('SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
      .get(params.endpoint, params.userId) as Record<string, unknown>;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      endpoint: String(row.endpoint),
      p256dh: String(row.p256dh),
      auth: String(row.auth),
      userAgent: String(row.user_agent),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  listPushSubscriptions(userId: string): PushSubscriptionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      endpoint: String(row.endpoint),
      p256dh: String(row.p256dh),
      auth: String(row.auth),
      userAgent: String(row.user_agent),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  countPushSubscriptions(userId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM push_subscriptions WHERE user_id = ?')
      .get(userId) as { cnt: number };
    return Number(row.cnt);
  }

  hasPushSubscription(userId: string, endpoint: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM push_subscriptions WHERE user_id = ? AND endpoint = ? LIMIT 1')
      .get(userId, endpoint) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  }

  deletePushSubscriptionByEndpoint(userId: string, endpoint: string): boolean {
    const info = this.db
      .prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .run(userId, endpoint);
    return Number(info.changes) > 0;
  }

  deletePushSubscriptionById(id: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  }

  deleteAllPushSubscriptionsForUser(userId: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
  }

  // ---- Sync Events ----

  insertSyncEventInTx(params: {
    userId: string;
    eventId: string;
    type: string;
    chatId?: string | null;
    projectId?: string | null;
    runId?: string | null;
    payload: unknown;
    createdAt?: number;
  }): SyncEventEnvelope {
    const now = params.createdAt ?? Date.now();
    const maxRow = this.db
      .prepare('SELECT COALESCE(MAX(user_seq), 0) AS max_user_seq FROM sync_events WHERE user_id = ?')
      .get(params.userId) as { max_user_seq: number };
    const userSeq = Number(maxRow.max_user_seq) + 1;

    const res = this.db
      .prepare(
        `INSERT INTO sync_events (user_id, user_seq, event_id, event_type, chat_id, project_id, run_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.userId,
        userSeq,
        params.eventId,
        params.type,
        params.chatId ?? null,
        params.projectId ?? null,
        params.runId ?? null,
        JSON.stringify(params.payload),
        now
      );

    // Prune older events for this user beyond the most recent 2000 rows to bound disk usage
    const seq = Number(res.lastInsertRowid);
    if (userSeq % 100 === 0) {
      this.db
        .prepare(
          `DELETE FROM sync_events
           WHERE user_id = ? AND user_seq < COALESCE(
             (SELECT user_seq FROM sync_events WHERE user_id = ? ORDER BY user_seq DESC LIMIT 1 OFFSET 2000),
             0
           )`
        )
        .run(params.userId, params.userId);
    }

    return {
      seq,
      userSeq,
      eventId: params.eventId,
      userId: params.userId,
      type: params.type,
      chatId: params.chatId ?? null,
      projectId: params.projectId ?? null,
      runId: params.runId ?? null,
      payload: params.payload,
      createdAt: now,
    };
  }

  appendSyncEvent(params: {
    userId: string;
    eventId: string;
    type: string;
    chatId?: string | null;
    projectId?: string | null;
    runId?: string | null;
    payload: unknown;
  }): SyncEventEnvelope {
    if (this.db.isTransaction) {
      return this.insertSyncEventInTx(params);
    }
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const envelope = this.insertSyncEventInTx(params);
      this.db.exec('COMMIT;');
      return envelope;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  getLatestSyncSeq(userId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM sync_events WHERE user_id = ?')
      .get(userId) as { max_seq: number };
    return Number(row.max_seq);
  }

  getLatestUserSyncSeq(userId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(user_seq), 0) AS max_user_seq FROM sync_events WHERE user_id = ?')
      .get(userId) as { max_user_seq: number };
    return Number(row.max_user_seq);
  }

  private mapSyncEventRow(r: Record<string, unknown>): SyncEventEnvelope {
    return {
      seq: Number(r.seq),
      userSeq: Number(r.user_seq ?? 0),
      eventId: String(r.event_id),
      userId: String(r.user_id),
      type: String(r.event_type),
      chatId: r.chat_id ? String(r.chat_id) : null,
      projectId: r.project_id ? String(r.project_id) : null,
      runId: r.run_id ? String(r.run_id) : null,
      payload: JSON.parse(String(r.payload_json)),
      createdAt: Number(r.created_at),
    };
  }

  getSyncEventsSince(userId: string, sinceSeq: number, limit = 500): {
    events: SyncEventEnvelope[];
    truncated: boolean;
    latestSeq: number;
    latestUserSeq: number;
  } {
    const latestSeq = this.getLatestSyncSeq(userId);
    const latestUserSeq = this.getLatestUserSyncSeq(userId);
    const minAvailableRow = this.db
      .prepare('SELECT MIN(seq) AS min_seq FROM sync_events WHERE user_id = ?')
      .get(userId) as { min_seq: number | null };
    const minSeq = minAvailableRow.min_seq !== null ? Number(minAvailableRow.min_seq) : 0;

    if (sinceSeq > 0 && minSeq > 0 && sinceSeq + 1 < minSeq) {
      return { events: [], truncated: true, latestSeq, latestUserSeq };
    }

    const rows = this.db
      .prepare('SELECT * FROM sync_events WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(userId, sinceSeq, limit + 1) as Array<Record<string, unknown>>;

    const truncated = rows.length > limit;
    const slice = rows.slice(0, limit);
    return {
      events: slice.map((r) => this.mapSyncEventRow(r)),
      truncated,
      latestSeq,
      latestUserSeq,
    };
  }

  getSyncEventsSinceUserSeq(userId: string, sinceUserSeq: number, limit = 500): {
    events: SyncEventEnvelope[];
    truncated: boolean;
    latestSeq: number;
    latestUserSeq: number;
  } {
    const latestSeq = this.getLatestSyncSeq(userId);
    const latestUserSeq = this.getLatestUserSyncSeq(userId);
    const minAvailableRow = this.db
      .prepare('SELECT MIN(user_seq) AS min_user_seq FROM sync_events WHERE user_id = ? AND user_seq > 0')
      .get(userId) as { min_user_seq: number | null };
    const minUserSeq = minAvailableRow.min_user_seq !== null ? Number(minAvailableRow.min_user_seq) : 0;

    if (sinceUserSeq > 0 && minUserSeq > 0 && sinceUserSeq + 1 < minUserSeq) {
      return { events: [], truncated: true, latestSeq, latestUserSeq };
    }

    const rows = this.db
      .prepare('SELECT * FROM sync_events WHERE user_id = ? AND user_seq > ? ORDER BY user_seq ASC LIMIT ?')
      .all(userId, sinceUserSeq, limit + 1) as Array<Record<string, unknown>>;

    const truncated = rows.length > limit;
    const slice = rows.slice(0, limit);
    return {
      events: slice.map((r) => this.mapSyncEventRow(r)),
      truncated,
      latestSeq,
      latestUserSeq,
    };
  }

  /**
   * Single read transaction returning consistent snapshotUserSeq and entity state for full WS resync.
   */
  getSyncSnapshot(userId: string, activeChatId?: string) {
    this.db.exec('BEGIN;');
    try {
      const snapshotUserSeq = this.getLatestUserSyncSeq(userId);
      const latestSeq = this.getLatestSyncSeq(userId);
      const projects = this.listProjects(userId).map((p) => ({
        ...p,
        files: this.listProjectFiles(userId, p.id),
      }));
      // Select one active run per chat in a single query. Keep the exact
      // running/permission-before-queued ordering of getActiveRunForChat.
      const activeRunRows = this.db.prepare(
        `SELECT * FROM (
           SELECT runs.*, ROW_NUMBER() OVER (
             PARTITION BY chat_id ORDER BY
             CASE WHEN status IN ('running', 'awaiting_permission') THEN 0 ELSE 1 END,
             created_at, id
           ) AS active_rank
           FROM runs WHERE user_id = ? AND status IN ('queued', 'running', 'awaiting_permission')
         ) WHERE active_rank = 1`
      ).all(userId) as Array<Record<string, unknown>>;
      const activeRuns = new Map(activeRunRows.map(row => [String(row.chat_id), this.mapRun(row)]));
      const chats = this.listChats(userId).map(chat => ({
        ...chat, activeRun: activeRuns.get(chat.id) ?? null,
      }));
      const activeChat = activeChatId ? this.getChat(userId, activeChatId) : null;
      const activeChatDetail = activeChat ? {
        chat: activeChat,
        messages: this.listMessages(userId, activeChat.id),
        artifacts: this.listArtifactsForChat(userId, activeChat.id),
        pendingPermissions: this.listPendingPermissionsForChat(userId, activeChat.id),
        pendingElicitations: this.listPendingElicitationsForChat(userId, activeChat.id),
        activeRun: activeRuns.get(activeChat.id) ?? null,
        project: activeChat.projectId ? this.getProject(userId, activeChat.projectId) : null,
      } : null;
      const agyProfile = this.getAgyProfile(userId);
      const preferences = this.getPreferences(userId);
      const artRows = this.db
        .prepare("SELECT * FROM artifacts WHERE user_id = ? AND lifecycle_state = 'active' ORDER BY updated_at DESC")
        .all(userId) as Array<Record<string, unknown>>;
      const artifacts = artRows.map((r) => this.mapArtifact(r));
      this.db.exec('COMMIT;');
      return { snapshotUserSeq, latestSeq, projects, chats, artifacts, activeChatDetail, agyProfile, preferences };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  // ---- MCP Servers ----

  private mapMcpServerRow(row: Record<string, unknown>): StoredMcpServerRow {
    const scope: McpScope =
      row.scope === 'profile' || row.scope === 'project' || row.scope === 'chat'
        ? row.scope
        : 'shared';
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      scope,
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
      projectId: row.project_id ? String(row.project_id) : null,
      chatId: row.chat_id ? String(row.chat_id) : null,
      transport:
        row.transport === 'http' || row.transport === 'sse' || row.transport === 'stdio'
          ? row.transport
          : 'stdio',
      enabled: Number(row.enabled) === 1,
      allowedToolsJson: String(row.allowed_tools_json ?? '[]'),
      disabledToolsJson: String(row.disabled_tools_json ?? '[]'),
      alwaysAllowToolsJson: String(row.always_allow_tools_json ?? '[]'),
      discoveredToolsJson: String(row.discovered_tools_json ?? '[]'),
      command: row.command ? String(row.command) : null,
      argsJson: String(row.args_json ?? '[]'),
      encryptedEnvJson: row.encrypted_env_json ? String(row.encrypted_env_json) : null,
      url: row.url ? String(row.url) : null,
      authType:
        row.auth_type === 'bearer' ||
        row.auth_type === 'api_key' ||
        row.auth_type === 'headers' ||
        row.auth_type === 'oauth'
          ? row.auth_type
          : 'none',
      encryptedHeadersJson: row.encrypted_headers_json ? String(row.encrypted_headers_json) : null,
      oauthConfigJson: row.oauth_config_json ? String(row.oauth_config_json) : null,
      encryptedOauthClientSecret: row.encrypted_oauth_client_secret
        ? String(row.encrypted_oauth_client_secret)
        : null,
      encryptedOauthTokensJson: row.encrypted_oauth_tokens_json
        ? String(row.encrypted_oauth_tokens_json)
        : null,
      oauthStatus:
        row.oauth_status === 'connected' ||
        row.oauth_status === 'expired' ||
        row.oauth_status === 'error'
          ? row.oauth_status
          : 'disconnected',
      oauthError: row.oauth_error ? String(row.oauth_error) : null,
      oauthUpdatedAt: row.oauth_updated_at !== null && row.oauth_updated_at !== undefined
        ? Number(row.oauth_updated_at)
        : null,
      createdBy: String(row.created_by),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  listAdminUserIds(): string[] {
    const rows = this.db
      .prepare("SELECT id FROM users WHERE role = 'admin'")
      .all() as Array<{ id: string }>;
    return rows.map((r) => String(r.id));
  }

  listMcpServersForAdmin(
    adminUserId: string,
    filter?: { projectId?: string | null; chatId?: string | null }
  ): StoredMcpServerRow[] {
    if (filter?.projectId) {
      const rows = this.db
        .prepare(
          `SELECT * FROM mcp_servers
           WHERE scope = 'project' AND owner_user_id = ? AND project_id = ?
           ORDER BY name ASC`
        )
        .all(adminUserId, filter.projectId) as Array<Record<string, unknown>>;
      return rows.map((r) => this.mapMcpServerRow(r));
    }
    if (filter?.chatId) {
      const rows = this.db
        .prepare(
          `SELECT * FROM mcp_servers
           WHERE scope = 'chat' AND owner_user_id = ? AND chat_id = ?
           ORDER BY name ASC`
        )
        .all(adminUserId, filter.chatId) as Array<Record<string, unknown>>;
      return rows.map((r) => this.mapMcpServerRow(r));
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM mcp_servers
         WHERE scope = 'shared' OR (scope = 'profile' AND owner_user_id = ?)
         ORDER BY CASE WHEN scope = 'shared' THEN 0 ELSE 1 END, name ASC`
      )
      .all(adminUserId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMcpServerRow(r));
  }

  getBuiltinMcpSettings(scopeKey: string): { enabled: boolean | null; disabledTools: string[] | null } {
    const row = this.db.prepare(
      'SELECT enabled, disabled_tools_json FROM builtin_mcp_settings WHERE scope_key = ?'
    ).get(scopeKey) as { enabled: number | null; disabled_tools_json: string | null } | undefined;
    return {
      enabled: row?.enabled == null ? null : Boolean(row.enabled),
      disabledTools: row?.disabled_tools_json == null ? null : JSON.parse(row.disabled_tools_json),
    };
  }

  setBuiltinMcpSettings(scopeKey: string, settings: { enabled: boolean | null; disabledTools: string[] | null }): void {
    this.db.prepare(`
      INSERT INTO builtin_mcp_settings (scope_key, enabled, disabled_tools_json) VALUES (?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET enabled = excluded.enabled, disabled_tools_json = excluded.disabled_tools_json
    `).run(
      scopeKey,
      settings.enabled === null ? null : Number(settings.enabled),
      settings.disabledTools === null ? null : JSON.stringify(settings.disabledTools)
    );
  }

  listEffectiveMcpServersForUser(
    userId: string,
    context?: { projectId?: string | null; chatId?: string | null }
  ): StoredMcpServerRow[] {
    const projectId = context?.projectId ?? null;
    const chatId = context?.chatId ?? null;
    const clauses: string[] = [
      `scope = 'shared'`,
      `(scope = 'profile' AND owner_user_id = ?)`,
    ];
    const params: Array<string> = [userId];
    if (projectId) {
      clauses.push(`(scope = 'project' AND owner_user_id = ? AND project_id = ?)`);
      params.push(userId, projectId);
    }
    if (chatId) {
      clauses.push(`(scope = 'chat' AND owner_user_id = ? AND chat_id = ?)`);
      params.push(userId, chatId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM mcp_servers
         WHERE enabled = 1 AND (${clauses.join(' OR ')})
         ORDER BY CASE scope
           WHEN 'shared' THEN 0
           WHEN 'profile' THEN 1
           WHEN 'project' THEN 2
           WHEN 'chat' THEN 3
           ELSE 4
         END, name ASC`
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMcpServerRow(r));
  }

  getMcpServerById(id: string): StoredMcpServerRow | null {
    const row = this.db
      .prepare('SELECT * FROM mcp_servers WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapMcpServerRow(row) : null;
  }

  findMcpServerByScopeAndName(
    scope: McpScope,
    ownerUserId: string | null,
    name: string,
    projectId: string | null = null,
    chatId: string | null = null
  ): StoredMcpServerRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM mcp_servers
         WHERE scope = ?
           AND COALESCE(owner_user_id, '') = COALESCE(?, '')
           AND COALESCE(project_id, '') = COALESCE(?, '')
           AND COALESCE(chat_id, '') = COALESCE(?, '')
           AND name = ?`
      )
      .get(scope, ownerUserId ?? '', projectId ?? '', chatId ?? '', name) as Record<string, unknown> | undefined;
    return row ? this.mapMcpServerRow(row) : null;
  }

  createMcpServer(input: {
    id: string;
    name: string;
    description: string;
    scope: McpScope;
    ownerUserId: string | null;
    projectId?: string | null;
    chatId?: string | null;
    transport: McpTransport;
    enabled: boolean;
    allowedToolsJson?: string;
    disabledToolsJson?: string;
    alwaysAllowToolsJson?: string;
    discoveredToolsJson?: string;
    command: string | null;
    argsJson: string;
    encryptedEnvJson: string | null;
    url: string | null;
    authType: McpAuthType;
    encryptedHeadersJson: string | null;
    oauthConfigJson: string | null;
    encryptedOauthClientSecret: string | null;
    encryptedOauthTokensJson: string | null;
    oauthStatus: McpOAuthStatus;
    oauthError: string | null;
    oauthUpdatedAt: number | null;
    createdBy: string;
  }): StoredMcpServerRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mcp_servers (
          id, name, description, scope, owner_user_id, project_id, chat_id, transport, enabled,
          allowed_tools_json, disabled_tools_json, always_allow_tools_json, discovered_tools_json,
          command, args_json, encrypted_env_json,
          url, auth_type, encrypted_headers_json,
          oauth_config_json, encrypted_oauth_client_secret, encrypted_oauth_tokens_json,
          oauth_status, oauth_error, oauth_updated_at,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.name,
        input.description,
        input.scope,
        input.ownerUserId,
        input.projectId ?? null,
        input.chatId ?? null,
        input.transport,
        input.enabled ? 1 : 0,
        input.allowedToolsJson ?? '[]',
        input.disabledToolsJson ?? '[]',
        input.alwaysAllowToolsJson ?? '[]',
        input.discoveredToolsJson ?? '[]',
        input.command,
        input.argsJson,
        input.encryptedEnvJson,
        input.url,
        input.authType,
        input.encryptedHeadersJson,
        input.oauthConfigJson,
        input.encryptedOauthClientSecret,
        input.encryptedOauthTokensJson,
        input.oauthStatus,
        input.oauthError,
        input.oauthUpdatedAt,
        input.createdBy,
        now,
        now
      );
    return this.getMcpServerById(input.id)!;
  }

  updateMcpServer(
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      scope: McpScope;
      ownerUserId: string | null;
      projectId: string | null;
      chatId: string | null;
      transport: McpTransport;
      enabled: boolean;
      allowedToolsJson: string;
      disabledToolsJson: string;
      alwaysAllowToolsJson: string;
      discoveredToolsJson: string;
      command: string | null;
      argsJson: string;
      encryptedEnvJson: string | null;
      url: string | null;
      authType: McpAuthType;
      encryptedHeadersJson: string | null;
      oauthConfigJson: string | null;
      encryptedOauthClientSecret: string | null;
      encryptedOauthTokensJson: string | null;
      oauthStatus: McpOAuthStatus;
      oauthError: string | null;
      oauthUpdatedAt: number | null;
    }>
  ): StoredMcpServerRow | null {
    const existing = this.getMcpServerById(id);
    if (!existing) return null;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE mcp_servers SET
          name = ?,
          description = ?,
          scope = ?,
          owner_user_id = ?,
          project_id = ?,
          chat_id = ?,
          transport = ?,
          enabled = ?,
          allowed_tools_json = ?,
          disabled_tools_json = ?,
          always_allow_tools_json = ?,
          discovered_tools_json = ?,
          command = ?,
          args_json = ?,
          encrypted_env_json = ?,
          url = ?,
          auth_type = ?,
          encrypted_headers_json = ?,
          oauth_config_json = ?,
          encrypted_oauth_client_secret = ?,
          encrypted_oauth_tokens_json = ?,
          oauth_status = ?,
          oauth_error = ?,
          oauth_updated_at = ?,
          updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.name !== undefined ? patch.name : existing.name,
        patch.description !== undefined ? patch.description : existing.description,
        patch.scope !== undefined ? patch.scope : existing.scope,
        patch.ownerUserId !== undefined ? patch.ownerUserId : existing.ownerUserId,
        patch.projectId !== undefined ? patch.projectId : existing.projectId,
        patch.chatId !== undefined ? patch.chatId : existing.chatId,
        patch.transport !== undefined ? patch.transport : existing.transport,
        (patch.enabled !== undefined ? patch.enabled : existing.enabled) ? 1 : 0,
        patch.allowedToolsJson !== undefined ? patch.allowedToolsJson : existing.allowedToolsJson,
        patch.disabledToolsJson !== undefined ? patch.disabledToolsJson : existing.disabledToolsJson,
        patch.alwaysAllowToolsJson !== undefined ? patch.alwaysAllowToolsJson : existing.alwaysAllowToolsJson,
        patch.discoveredToolsJson !== undefined ? patch.discoveredToolsJson : existing.discoveredToolsJson,
        patch.command !== undefined ? patch.command : existing.command,
        patch.argsJson !== undefined ? patch.argsJson : existing.argsJson,
        patch.encryptedEnvJson !== undefined ? patch.encryptedEnvJson : existing.encryptedEnvJson,
        patch.url !== undefined ? patch.url : existing.url,
        patch.authType !== undefined ? patch.authType : existing.authType,
        patch.encryptedHeadersJson !== undefined ? patch.encryptedHeadersJson : existing.encryptedHeadersJson,
        patch.oauthConfigJson !== undefined ? patch.oauthConfigJson : existing.oauthConfigJson,
        patch.encryptedOauthClientSecret !== undefined
          ? patch.encryptedOauthClientSecret
          : existing.encryptedOauthClientSecret,
        patch.encryptedOauthTokensJson !== undefined
          ? patch.encryptedOauthTokensJson
          : existing.encryptedOauthTokensJson,
        patch.oauthStatus !== undefined ? patch.oauthStatus : existing.oauthStatus,
        patch.oauthError !== undefined ? patch.oauthError : existing.oauthError,
        patch.oauthUpdatedAt !== undefined ? patch.oauthUpdatedAt : existing.oauthUpdatedAt,
        now,
        id
      );
    return this.getMcpServerById(id);
  }

  deleteMcpServer(id: string): boolean {
    const res = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }
}
