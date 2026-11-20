import crypto from 'node:crypto';
import type { McpCapabilities, McpServer } from '@agentclientprotocol/sdk';
import { resolveHostExecutable } from '../acp/env-isolation.js';
import { decryptSmallSecret, encryptSmallSecret } from '../auth/password.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase, StoredMcpServerRow } from '../db/database.js';
import type { SyncHub } from '../sync/hub.js';
import type {
  McpAuthType,
  McpOAuthConfig,
  McpOAuthStatus,
  McpOAuthSummary,
  McpScope,
  McpSecretEntrySummary,
  McpServerRecord,
  McpTestResult,
  McpTransport,
} from '../types.js';

export class McpValidationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'McpValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface SecretKeyValueInput {
  name: string;
  value?: string;
  keepExisting?: boolean;
}

export interface McpOAuthConfigInput {
  clientId?: string | null;
  clientSecret?: string | null;
  clearClientSecret?: boolean;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  registrationUrl?: string | null;
  scopes?: string | null;
  resource?: string | null;
  extraAuthParams?: Record<string, string> | null;
}

export interface CreateMcpServerInput {
  name: string;
  description?: string;
  scope: McpScope;
  transport: McpTransport;
  enabled?: boolean;
  command?: string | null;
  args?: string[];
  env?: SecretKeyValueInput[];
  url?: string | null;
  authType?: McpAuthType;
  headers?: SecretKeyValueInput[];
  oauthConfig?: McpOAuthConfigInput | null;
}

export interface UpdateMcpServerInput {
  name?: string;
  description?: string;
  scope?: McpScope;
  transport?: McpTransport;
  enabled?: boolean;
  command?: string | null;
  args?: string[];
  env?: SecretKeyValueInput[];
  url?: string | null;
  authType?: McpAuthType;
  headers?: SecretKeyValueInput[];
  oauthConfig?: McpOAuthConfigInput | null;
}

interface StoredOAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string | null;
  expiresAt?: number | null;
  scope?: string | null;
}

interface DiscoveredOAuthMetadata {
  authorizationUrl: string | null;
  tokenUrl: string | null;
  registrationUrl: string | null;
  scopes: string[];
  resource: string | null;
}

interface PendingOAuthFlow {
  state: string;
  serverId: string;
  adminUserId: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string | null;
  resource: string | null;
  createdAt: number;
  expiresAt: number;
}

const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const OAUTH_REFRESH_SKEW_MS = 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 10_000;

export function validateMcpName(raw: string): string {
  const name = raw.trim();
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    throw new McpValidationError(
      'INVALID_MCP_NAME',
      'MCPサーバー名は半角英数字で始まり、半角英数字・ドット・ハイフン・アンダースコア（1〜64文字）で指定してください。'
    );
  }
  return name;
}

export function validateRemoteUrl(raw: string, fieldLabel = 'URL'): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new McpValidationError('INVALID_URL', `${fieldLabel}を入力してください。`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new McpValidationError('INVALID_URL', `${fieldLabel}の形式が正しくありません。`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new McpValidationError(
      'INVALID_URL',
      `${fieldLabel}は http:// または https:// で始まる URL を指定してください。`
    );
  }
  return parsed.toString();
}

function assertNoControlChars(value: string, label: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new McpValidationError('INVALID_INPUT', `${label}に改行や制御文字は使用できません。`);
  }
}

export function maskSecretValue(value: string): string {
  if (!value) return '';
  if (value.length >= 10) {
    return `••••${value.slice(-4)}`;
  }
  return '••••••••';
}

function parseJsonObject<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}

function parseArgsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function extractResourceMetadataUrlFromWwwAuthenticate(headerVal: string | null): string | null {
  if (!headerVal) return null;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(headerVal);
  if (match && match[1]) return match[1].trim();
  const unquoted = /resource_metadata\s*=\s*([^\s,]+)/i.exec(headerVal);
  return unquoted?.[1]?.trim() ?? null;
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DISCOVERY_TIMEOUT_MS
): Promise<{ status: number; headers: Headers; json: Record<string, unknown> | null; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      // non-JSON response
    }
    return { status: res.status, headers: res.headers, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export class McpService {
  private readonly pendingOAuthFlows = new Map<string, PendingOAuthFlow>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: SyncHub
  ) {}

  private decryptRecord(encrypted: string | null): Record<string, string> {
    if (!encrypted) return {};
    try {
      const plain = decryptSmallSecret(encrypted, this.config.sessionSecret);
      const parsed = JSON.parse(plain);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') out[k] = v;
        }
        return out;
      }
      return {};
    } catch {
      return {};
    }
  }

  private encryptRecord(record: Record<string, string>): string | null {
    const entries = Object.entries(record);
    if (entries.length === 0) return null;
    return encryptSmallSecret(JSON.stringify(record), this.config.sessionSecret);
  }

  private decryptTokens(encrypted: string | null): StoredOAuthTokens | null {
    if (!encrypted) return null;
    try {
      const plain = decryptSmallSecret(encrypted, this.config.sessionSecret);
      const parsed = JSON.parse(plain) as StoredOAuthTokens;
      if (parsed && typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private encryptTokens(tokens: StoredOAuthTokens | null): string | null {
    if (!tokens || !tokens.accessToken) return null;
    return encryptSmallSecret(JSON.stringify(tokens), this.config.sessionSecret);
  }

  private decryptClientSecret(encrypted: string | null): string | null {
    if (!encrypted) return null;
    try {
      const val = decryptSmallSecret(encrypted, this.config.sessionSecret);
      return val.length > 0 ? val : null;
    } catch {
      return null;
    }
  }

  private mergeSecretEntries(
    inputs: SecretKeyValueInput[] | undefined,
    existing: Record<string, string>,
    kindLabel: string
  ): Record<string, string> {
    if (!inputs) return { ...existing };
    const out: Record<string, string> = {};
    for (const item of inputs) {
      const name = item.name.trim();
      if (!name) continue;
      assertNoControlChars(name, `${kindLabel}名`);
      if (item.keepExisting) {
        if (Object.prototype.hasOwnProperty.call(existing, name)) {
          out[name] = existing[name];
        }
        continue;
      }
      const val = item.value ?? '';
      assertNoControlChars(val, `${kindLabel}値 (${name})`);
      out[name] = val;
    }
    return out;
  }

  private normalizeOAuthConfig(
    input: McpOAuthConfigInput | null | undefined,
    existing: McpOAuthConfig | null
  ): McpOAuthConfig | null {
    if (input === null) return null;
    if (input === undefined) return existing;

    const merged: McpOAuthConfig = {
      clientId: input.clientId !== undefined ? (input.clientId?.trim() || null) : (existing?.clientId ?? null),
      authorizationUrl:
        input.authorizationUrl !== undefined
          ? (input.authorizationUrl?.trim() ? validateRemoteUrl(input.authorizationUrl, 'Authorization URL') : null)
          : (existing?.authorizationUrl ?? null),
      tokenUrl:
        input.tokenUrl !== undefined
          ? (input.tokenUrl?.trim() ? validateRemoteUrl(input.tokenUrl, 'Token URL') : null)
          : (existing?.tokenUrl ?? null),
      registrationUrl:
        input.registrationUrl !== undefined
          ? (input.registrationUrl?.trim() ? validateRemoteUrl(input.registrationUrl, 'Registration URL') : null)
          : (existing?.registrationUrl ?? null),
      scopes: input.scopes !== undefined ? (input.scopes?.trim() || null) : (existing?.scopes ?? null),
      resource:
        input.resource !== undefined
          ? (input.resource?.trim() ? validateRemoteUrl(input.resource, 'Resource URL') : null)
          : (existing?.resource ?? null),
      extraAuthParams:
        input.extraAuthParams !== undefined
          ? this.sanitizeExtraAuthParams(input.extraAuthParams)
          : (existing?.extraAuthParams ?? null),
    };

    return merged;
  }

  private sanitizeExtraAuthParams(raw: Record<string, string> | null | undefined): Record<string, string> | null {
    if (!raw) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const key = k.trim();
      const val = typeof v === 'string' ? v.trim() : '';
      if (!key || !val) continue;
      assertNoControlChars(key, 'OAuthパラメータ名');
      assertNoControlChars(val, 'OAuthパラメータ値');
      out[key] = val;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  private toPublicRecord(row: StoredMcpServerRow): McpServerRecord {
    const envMap = this.decryptRecord(row.encryptedEnvJson);
    const headerMap = this.decryptRecord(row.encryptedHeadersJson);
    const envSummary: McpSecretEntrySummary[] = Object.entries(envMap).map(([name, value]) => ({
      name,
      maskedValue: maskSecretValue(value),
      hasValue: value.length > 0,
    }));
    const headerSummary: McpSecretEntrySummary[] = Object.entries(headerMap).map(([name, value]) => ({
      name,
      maskedValue: maskSecretValue(value),
      hasValue: value.length > 0,
    }));

    let oauth: McpOAuthSummary | null = null;
    if (row.authType === 'oauth') {
      const cfg = parseJsonObject<McpOAuthConfig>(row.oauthConfigJson);
      const tokens = this.decryptTokens(row.encryptedOauthTokensJson);
      let status: McpOAuthStatus = row.oauthStatus;
      if (status === 'connected' && tokens?.expiresAt && tokens.expiresAt <= Date.now() && !tokens.refreshToken) {
        status = 'expired';
      }
      oauth = {
        status,
        clientId: cfg?.clientId ?? null,
        hasClientSecret: Boolean(row.encryptedOauthClientSecret),
        authorizationUrl: cfg?.authorizationUrl ?? null,
        tokenUrl: cfg?.tokenUrl ?? null,
        registrationUrl: cfg?.registrationUrl ?? null,
        scopes: cfg?.scopes ?? null,
        resource: cfg?.resource ?? null,
        extraAuthParams: cfg?.extraAuthParams ?? {},
        expiresAt: tokens?.expiresAt ?? null,
        hasRefreshToken: Boolean(tokens?.refreshToken),
        error: row.oauthError,
        updatedAt: row.oauthUpdatedAt,
      };
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scope: row.scope,
      ownerUserId: row.ownerUserId,
      transport: row.transport,
      enabled: row.enabled,
      command: row.command,
      args: parseArgsJson(row.argsJson),
      env: envSummary,
      url: row.url,
      authType: row.authType,
      headers: headerSummary,
      oauth,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private emitUpdated(scope: McpScope, ownerUserId: string | null, serverId: string): void {
    const targetAdminIds =
      scope === 'shared'
        ? this.db.listAdminUserIds()
        : ownerUserId
          ? [ownerUserId]
          : this.db.listAdminUserIds();

    for (const userId of targetAdminIds) {
      this.hub.emitDurable({
        userId,
        type: 'mcp.updated',
        payload: { serverId, scope },
      });
    }
  }

  private assertAdminCanAccessRow(adminUserId: string, row: StoredMcpServerRow): void {
    if (row.scope === 'profile' && row.ownerUserId !== adminUserId) {
      throw new McpValidationError('FORBIDDEN', '他の管理者の個人プロファイル専用MCPにはアクセスできません。', 403);
    }
  }

  listServersForAdmin(adminUserId: string): McpServerRecord[] {
    return this.db.listMcpServersForAdmin(adminUserId).map((row) => this.toPublicRecord(row));
  }

  getServerForAdmin(adminUserId: string, serverId: string): McpServerRecord {
    const row = this.db.getMcpServerById(serverId);
    if (!row) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, row);
    return this.toPublicRecord(row);
  }

  createServer(adminUserId: string, input: CreateMcpServerInput): McpServerRecord {
    const name = validateMcpName(input.name);
    const scope: McpScope = input.scope === 'profile' ? 'profile' : 'shared';
    const ownerUserId = scope === 'profile' ? adminUserId : null;
    const transport: McpTransport = input.transport;
    const description = (input.description ?? '').trim().slice(0, 500);
    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : true;

    const existingDup = this.db.findMcpServerByScopeAndName(scope, ownerUserId, name);
    if (existingDup) {
      throw new McpValidationError(
        'MCP_NAME_EXISTS',
        `同じスコープに "${name}" というMCPサーバーが既に存在します。`,
        409
      );
    }

    let command: string | null = null;
    let args: string[] = [];
    let encryptedEnvJson: string | null = null;
    let url: string | null = null;
    let authType: McpAuthType = 'none';
    let encryptedHeadersJson: string | null = null;
    let oauthConfigJson: string | null = null;
    let encryptedOauthClientSecret: string | null = null;

    if (transport === 'stdio') {
      const cmd = (input.command ?? '').trim();
      if (!cmd) {
        throw new McpValidationError('COMMAND_REQUIRED', 'ローカルMCPには実行コマンドを指定してください。');
      }
      assertNoControlChars(cmd, 'コマンド');
      command = cmd;
      args = (input.args ?? []).map((a) => String(a));
      for (const a of args) assertNoControlChars(a, 'コマンド引数');
      const envMap = this.mergeSecretEntries(input.env, {}, '環境変数');
      encryptedEnvJson = this.encryptRecord(envMap);
      authType = 'none';
    } else {
      url = validateRemoteUrl(input.url ?? '', 'リモートMCP URL');
      authType = input.authType ?? 'none';
      const headerMap = this.mergeSecretEntries(input.headers, {}, 'HTTPヘッダー');
      encryptedHeadersJson = this.encryptRecord(headerMap);

      if (authType === 'oauth') {
        const oauthCfg = this.normalizeOAuthConfig(input.oauthConfig, null);
        oauthConfigJson = oauthCfg ? JSON.stringify(oauthCfg) : null;
        const secret = input.oauthConfig?.clientSecret?.trim();
        if (secret) {
          encryptedOauthClientSecret = encryptSmallSecret(secret, this.config.sessionSecret);
        }
      }
    }

    const row = this.db.createMcpServer({
      id: crypto.randomUUID(),
      name,
      description,
      scope,
      ownerUserId,
      transport,
      enabled,
      command,
      argsJson: JSON.stringify(args),
      encryptedEnvJson,
      url,
      authType,
      encryptedHeadersJson,
      oauthConfigJson,
      encryptedOauthClientSecret,
      encryptedOauthTokensJson: null,
      oauthStatus: 'disconnected',
      oauthError: null,
      oauthUpdatedAt: null,
      createdBy: adminUserId,
    });

    this.emitUpdated(row.scope, row.ownerUserId, row.id);
    return this.toPublicRecord(row);
  }

  updateServer(adminUserId: string, serverId: string, input: UpdateMcpServerInput): McpServerRecord {
    const existing = this.db.getMcpServerById(serverId);
    if (!existing) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, existing);

    const nextName = input.name !== undefined ? validateMcpName(input.name) : existing.name;
    const nextScope: McpScope = input.scope !== undefined ? input.scope : existing.scope;
    const nextOwnerUserId = nextScope === 'profile' ? adminUserId : null;
    const nextTransport: McpTransport = input.transport !== undefined ? input.transport : existing.transport;
    const nextDescription =
      input.description !== undefined ? input.description.trim().slice(0, 500) : existing.description;
    const nextEnabled = input.enabled !== undefined ? Boolean(input.enabled) : existing.enabled;

    if (
      nextName !== existing.name ||
      nextScope !== existing.scope ||
      nextOwnerUserId !== existing.ownerUserId
    ) {
      const dup = this.db.findMcpServerByScopeAndName(nextScope, nextOwnerUserId, nextName);
      if (dup && dup.id !== existing.id) {
        throw new McpValidationError(
          'MCP_NAME_EXISTS',
          `同じスコープに "${nextName}" というMCPサーバーが既に存在します。`,
          409
        );
      }
    }

    let nextCommand = existing.command;
    let nextArgsJson = existing.argsJson;
    let nextEncryptedEnvJson = existing.encryptedEnvJson;
    let nextUrl = existing.url;
    let nextAuthType: McpAuthType = existing.authType;
    let nextEncryptedHeadersJson = existing.encryptedHeadersJson;
    let nextOAuthConfigJson = existing.oauthConfigJson;
    let nextEncryptedClientSecret = existing.encryptedOauthClientSecret;
    let nextEncryptedTokensJson = existing.encryptedOauthTokensJson;
    let nextOAuthStatus: McpOAuthStatus = existing.oauthStatus;
    let nextOAuthError = existing.oauthError;

    if (nextTransport === 'stdio') {
      const cmd = input.command !== undefined ? (input.command ?? '').trim() : (existing.command ?? '').trim();
      if (!cmd) {
        throw new McpValidationError('COMMAND_REQUIRED', 'ローカルMCPには実行コマンドを指定してください。');
      }
      assertNoControlChars(cmd, 'コマンド');
      nextCommand = cmd;
      if (input.args !== undefined) {
        const args = input.args.map((a) => String(a));
        for (const a of args) assertNoControlChars(a, 'コマンド引数');
        nextArgsJson = JSON.stringify(args);
      }
      if (input.env !== undefined) {
        const existingEnv = this.decryptRecord(existing.encryptedEnvJson);
        const mergedEnv = this.mergeSecretEntries(input.env, existingEnv, '環境変数');
        nextEncryptedEnvJson = this.encryptRecord(mergedEnv);
      }
      nextUrl = null;
      nextAuthType = 'none';
      nextEncryptedHeadersJson = null;
      nextOAuthConfigJson = null;
      nextEncryptedClientSecret = null;
      nextEncryptedTokensJson = null;
      nextOAuthStatus = 'disconnected';
      nextOAuthError = null;
    } else {
      const rawUrl = input.url !== undefined ? (input.url ?? '') : (existing.url ?? '');
      nextUrl = validateRemoteUrl(rawUrl, 'リモートMCP URL');
      nextAuthType = input.authType !== undefined ? input.authType : existing.authType;
      nextCommand = null;
      nextArgsJson = '[]';
      nextEncryptedEnvJson = null;

      if (input.headers !== undefined) {
        const existingHeaders = this.decryptRecord(existing.encryptedHeadersJson);
        const mergedHeaders = this.mergeSecretEntries(input.headers, existingHeaders, 'HTTPヘッダー');
        nextEncryptedHeadersJson = this.encryptRecord(mergedHeaders);
      }

      if (nextAuthType === 'oauth') {
        const existingCfg = parseJsonObject<McpOAuthConfig>(existing.oauthConfigJson);
        const mergedCfg = this.normalizeOAuthConfig(input.oauthConfig, existingCfg);
        nextOAuthConfigJson = mergedCfg ? JSON.stringify(mergedCfg) : null;

        if (input.oauthConfig?.clearClientSecret) {
          nextEncryptedClientSecret = null;
        } else if (typeof input.oauthConfig?.clientSecret === 'string' && input.oauthConfig.clientSecret.trim()) {
          nextEncryptedClientSecret = encryptSmallSecret(
            input.oauthConfig.clientSecret.trim(),
            this.config.sessionSecret
          );
        }

        // If URL changed, invalidate previous OAuth tokens because they belong to the old resource
        if (nextUrl !== existing.url) {
          nextEncryptedTokensJson = null;
          nextOAuthStatus = 'disconnected';
          nextOAuthError = null;
        }
      } else {
        nextOAuthConfigJson = null;
        nextEncryptedClientSecret = null;
        nextEncryptedTokensJson = null;
        nextOAuthStatus = 'disconnected';
        nextOAuthError = null;
      }
    }

    const updated = this.db.updateMcpServer(existing.id, {
      name: nextName,
      description: nextDescription,
      scope: nextScope,
      ownerUserId: nextOwnerUserId,
      transport: nextTransport,
      enabled: nextEnabled,
      command: nextCommand,
      argsJson: nextArgsJson,
      encryptedEnvJson: nextEncryptedEnvJson,
      url: nextUrl,
      authType: nextAuthType,
      encryptedHeadersJson: nextEncryptedHeadersJson,
      oauthConfigJson: nextOAuthConfigJson,
      encryptedOauthClientSecret: nextEncryptedClientSecret,
      encryptedOauthTokensJson: nextEncryptedTokensJson,
      oauthStatus: nextOAuthStatus,
      oauthError: nextOAuthError,
    });

    if (!updated) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }

    this.emitUpdated(updated.scope, updated.ownerUserId, updated.id);
    if (existing.scope !== updated.scope) {
      this.emitUpdated(existing.scope, existing.ownerUserId, updated.id);
    }
    return this.toPublicRecord(updated);
  }

  deleteServer(adminUserId: string, serverId: string): { deleted: boolean; scope: McpScope; ownerUserId: string | null } {
    const existing = this.db.getMcpServerById(serverId);
    if (!existing) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, existing);
    const deleted = this.db.deleteMcpServer(existing.id);
    if (deleted) {
      this.emitUpdated(existing.scope, existing.ownerUserId, existing.id);
    }
    return { deleted, scope: existing.scope, ownerUserId: existing.ownerUserId };
  }

  /**
   * Imports one or more MCP servers from standard Claude / Cursor / Antigravity / VS Code JSON.
   */
  importFromJson(
    adminUserId: string,
    params: { scope: McpScope; rawJson: string; overwrite?: boolean }
  ): { imported: McpServerRecord[]; skipped: string[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(params.rawJson);
    } catch {
      throw new McpValidationError('INVALID_JSON', 'JSONの構文が正しくありません。');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new McpValidationError('INVALID_JSON', 'JSONオブジェクト形式で入力してください。');
    }

    const root = parsed as Record<string, unknown>;
    let serverMap: Record<string, unknown>;
    if (root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)) {
      serverMap = root.mcpServers as Record<string, unknown>;
    } else if (root.servers && typeof root.servers === 'object' && !Array.isArray(root.servers)) {
      serverMap = root.servers as Record<string, unknown>;
    } else {
      serverMap = root;
    }

    const entries = Object.entries(serverMap);
    if (entries.length === 0) {
      throw new McpValidationError('EMPTY_IMPORT', 'インポート可能なMCPサーバー定義が見つかりませんでした。');
    }

    const imported: McpServerRecord[] = [];
    const skipped: string[] = [];
    const ownerUserId = params.scope === 'profile' ? adminUserId : null;

    for (const [rawName, rawCfg] of entries) {
      if (!rawCfg || typeof rawCfg !== 'object' || Array.isArray(rawCfg)) {
        skipped.push(rawName);
        continue;
      }
      const cfg = rawCfg as Record<string, unknown>;
      const name = validateMcpName(rawName);

      const remoteUrlRaw =
        (typeof cfg.serverUrl === 'string' && cfg.serverUrl.trim()) ||
        (typeof cfg.url === 'string' && cfg.url.trim()) ||
        (typeof cfg.httpUrl === 'string' && cfg.httpUrl.trim()) ||
        null;
      const commandRaw = typeof cfg.command === 'string' && cfg.command.trim() ? cfg.command.trim() : null;

      if (!remoteUrlRaw && !commandRaw) {
        skipped.push(rawName);
        continue;
      }

      const rawType = typeof cfg.type === 'string' ? cfg.type.toLowerCase() : typeof cfg.transport === 'string' ? cfg.transport.toLowerCase() : '';
      let transport: McpTransport;
      if (commandRaw && rawType !== 'http' && rawType !== 'sse') {
        transport = 'stdio';
      } else if (rawType === 'sse' || (remoteUrlRaw && /\/sse\/?(?:\?|$)/i.test(remoteUrlRaw))) {
        transport = 'sse';
      } else {
        transport = 'http';
      }

      const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [];
      const envEntries: SecretKeyValueInput[] = [];
      if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
        for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
          if (typeof v === 'string') envEntries.push({ name: k, value: v });
        }
      }

      const headerEntries: SecretKeyValueInput[] = [];
      if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
        for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
          if (typeof v === 'string') headerEntries.push({ name: k, value: v });
        }
      }

      let authType: McpAuthType = 'none';
      let oauthConfig: McpOAuthConfigInput | null = null;
      if (transport !== 'stdio') {
        if (cfg.oauth && typeof cfg.oauth === 'object' && !Array.isArray(cfg.oauth)) {
          const o = cfg.oauth as Record<string, unknown>;
          authType = 'oauth';
          oauthConfig = {
            clientId: typeof o.clientId === 'string' ? o.clientId : typeof o.client_id === 'string' ? o.client_id : null,
            clientSecret:
              typeof o.clientSecret === 'string' ? o.clientSecret : typeof o.client_secret === 'string' ? o.client_secret : null,
            authorizationUrl:
              typeof o.authorizationUrl === 'string'
                ? o.authorizationUrl
                : typeof o.authorization_url === 'string'
                  ? o.authorization_url
                  : null,
            tokenUrl:
              typeof o.tokenUrl === 'string' ? o.tokenUrl : typeof o.token_url === 'string' ? o.token_url : null,
            scopes:
              typeof o.scopes === 'string'
                ? o.scopes
                : Array.isArray(o.scopes)
                  ? o.scopes.filter((s): s is string => typeof s === 'string').join(' ')
                  : null,
          };
        } else if (headerEntries.length > 0) {
          const authHeader = headerEntries.find((h) => h.name.toLowerCase() === 'authorization');
          if (authHeader && /^bearer\s+/i.test(authHeader.value ?? '')) {
            authType = 'bearer';
          } else if (headerEntries.length === 1 && /api[-_]?key/i.test(headerEntries[0].name)) {
            authType = 'api_key';
          } else {
            authType = 'headers';
          }
        }
      }

      const existing = this.db.findMcpServerByScopeAndName(params.scope, ownerUserId, name);
      if (existing) {
        if (!params.overwrite) {
          skipped.push(name);
          continue;
        }
        const updated = this.updateServer(adminUserId, existing.id, {
          description: typeof cfg.description === 'string' ? cfg.description : existing.description,
          transport,
          enabled: typeof cfg.disabled === 'boolean' ? !cfg.disabled : true,
          command: commandRaw,
          args,
          env: envEntries,
          url: remoteUrlRaw,
          authType,
          headers: headerEntries,
          oauthConfig,
        });
        imported.push(updated);
      } else {
        const created = this.createServer(adminUserId, {
          name,
          description: typeof cfg.description === 'string' ? cfg.description : '',
          scope: params.scope,
          transport,
          enabled: typeof cfg.disabled === 'boolean' ? !cfg.disabled : true,
          command: commandRaw,
          args,
          env: envEntries,
          url: remoteUrlRaw,
          authType,
          headers: headerEntries,
          oauthConfig,
        });
        imported.push(created);
      }
    }

    if (imported.length === 0 && skipped.length > 0) {
      throw new McpValidationError(
        'NOTHING_IMPORTED',
        `インポートされたサーバーがありませんでした（スキップ: ${skipped.join(', ')}）。既存の同名サーバーを上書きする場合は「上書き」を有効にしてください。`
      );
    }

    return { imported, skipped };
  }

  // ---- OAuth 2.0 / 2.1 Discovery, DCR, PKCE Flow & Refresh ----

  async discoverOAuthMetadata(mcpUrl: string): Promise<DiscoveredOAuthMetadata> {
    const parsedUrl = new URL(mcpUrl);
    const origin = parsedUrl.origin;
    const pathSuffix = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname.replace(/\/+$/, '');

    let resourceMetadataUrl: string | null = null;

    // 1) Probe MCP URL for WWW-Authenticate resource_metadata header (RFC 9728)
    try {
      const probe = await fetchJsonWithTimeout(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'antigravity-chat-ui', version: this.config.appVersion },
          },
        }),
      });
      if (probe.status === 401) {
        resourceMetadataUrl = extractResourceMetadataUrlFromWwwAuthenticate(
          probe.headers.get('www-authenticate')
        );
      }
    } catch {
      // Fall through to well-known probes
    }

    const prmCandidates: string[] = [];
    if (resourceMetadataUrl) {
      try {
        prmCandidates.push(new URL(resourceMetadataUrl, mcpUrl).toString());
      } catch {
        // ignore invalid URL
      }
    }
    if (pathSuffix) {
      prmCandidates.push(`${origin}/.well-known/oauth-protected-resource${pathSuffix}`);
    }
    prmCandidates.push(`${origin}/.well-known/oauth-protected-resource`);

    let authServerIssuer: string | null = null;
    let scopes: string[] = [];
    let resource: string | null = mcpUrl;

    for (const candidate of prmCandidates) {
      try {
        const res = await fetchJsonWithTimeout(candidate, { method: 'GET', headers: { Accept: 'application/json' } });
        if (res.status >= 200 && res.status < 300 && res.json) {
          const servers = res.json.authorization_servers;
          if (Array.isArray(servers) && typeof servers[0] === 'string' && servers[0].trim()) {
            authServerIssuer = servers[0].trim();
          }
          if (Array.isArray(res.json.scopes_supported)) {
            scopes = res.json.scopes_supported.filter((s): s is string => typeof s === 'string');
          }
          if (typeof res.json.resource === 'string' && res.json.resource.trim()) {
            resource = res.json.resource.trim();
          }
          if (authServerIssuer) break;
        }
      } catch {
        // try next candidate
      }
    }

    const issuerBase = (authServerIssuer ?? origin).replace(/\/+$/, '');
    const issuerUrl = new URL(issuerBase);
    const issuerPath = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/+$/, '');
    const asCandidates = [
      ...(issuerPath
        ? [
            `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
            `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
            `${issuerBase}/.well-known/openid-configuration`,
          ]
        : [
            `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
            `${issuerUrl.origin}/.well-known/openid-configuration`,
          ]),
    ];

    let authorizationUrl: string | null = null;
    let tokenUrl: string | null = null;
    let registrationUrl: string | null = null;

    for (const candidate of asCandidates) {
      try {
        const res = await fetchJsonWithTimeout(candidate, { method: 'GET', headers: { Accept: 'application/json' } });
        if (res.status >= 200 && res.status < 300 && res.json) {
          if (typeof res.json.authorization_endpoint === 'string') {
            authorizationUrl = res.json.authorization_endpoint;
          }
          if (typeof res.json.token_endpoint === 'string') {
            tokenUrl = res.json.token_endpoint;
          }
          if (typeof res.json.registration_endpoint === 'string') {
            registrationUrl = res.json.registration_endpoint;
          }
          if (scopes.length === 0 && Array.isArray(res.json.scopes_supported)) {
            scopes = res.json.scopes_supported.filter((s): s is string => typeof s === 'string');
          }
          if (authorizationUrl && tokenUrl) break;
        }
      } catch {
        // try next candidate
      }
    }

    return {
      authorizationUrl,
      tokenUrl,
      registrationUrl,
      scopes,
      resource,
    };
  }

  private pruneExpiredOAuthFlows(): void {
    const now = Date.now();
    for (const [state, flow] of this.pendingOAuthFlows.entries()) {
      if (flow.expiresAt <= now) {
        this.pendingOAuthFlows.delete(state);
      }
    }
  }

  async startOAuthFlow(
    adminUserId: string,
    serverId: string,
    origin: string
  ): Promise<{ authorizationUrl: string; redirectUri: string; state: string }> {
    this.pruneExpiredOAuthFlows();
    const row = this.db.getMcpServerById(serverId);
    if (!row) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, row);
    if (row.transport === 'stdio' || !row.url) {
      throw new McpValidationError('OAUTH_UNSUPPORTED', 'OAuth認証はリモートMCPサーバーのみ利用できます。');
    }
    if (row.authType !== 'oauth') {
      throw new McpValidationError('OAUTH_NOT_ENABLED', '認証方式を OAuth に設定してから認証を開始してください。');
    }

    const redirectUri = `${origin.replace(/\/+$/, '')}/api/mcp/oauth/callback`;
    const existingCfg = parseJsonObject<McpOAuthConfig>(row.oauthConfigJson) ?? {};
    let authorizationUrl = existingCfg.authorizationUrl ?? null;
    let tokenUrl = existingCfg.tokenUrl ?? null;
    let registrationUrl = existingCfg.registrationUrl ?? null;
    let scopes = existingCfg.scopes ?? null;
    let resource = existingCfg.resource ?? row.url;
    let clientId = existingCfg.clientId ?? null;
    let clientSecret = this.decryptClientSecret(row.encryptedOauthClientSecret);

    if (!authorizationUrl || !tokenUrl || (!clientId && !registrationUrl)) {
      const discovered = await this.discoverOAuthMetadata(row.url);
      authorizationUrl = authorizationUrl || discovered.authorizationUrl;
      tokenUrl = tokenUrl || discovered.tokenUrl;
      registrationUrl = registrationUrl || discovered.registrationUrl;
      if (!scopes && discovered.scopes.length > 0) {
        scopes = discovered.scopes.join(' ');
      }
      if (!existingCfg.resource && discovered.resource) {
        resource = discovered.resource;
      }
    }

    if (!authorizationUrl || !tokenUrl) {
      throw new McpValidationError(
        'OAUTH_DISCOVERY_FAILED',
        'OAuthエンドポイントを自動検出できませんでした。詳細設定で Authorization URL と Token URL を手動入力してください。'
      );
    }

    // Dynamic Client Registration (RFC 7591) when clientId is not configured
    if (!clientId && registrationUrl) {
      const dcrRes = await fetchJsonWithTimeout(registrationUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'AGY-ChatUI',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });
      if (dcrRes.status < 200 || dcrRes.status >= 300 || !dcrRes.json || typeof dcrRes.json.client_id !== 'string') {
        throw new McpValidationError(
          'OAUTH_DCR_FAILED',
          `動的クライアント登録（DCR）に失敗しました (HTTP ${dcrRes.status})。詳細設定で Client ID を手動入力してください。`
        );
      }
      clientId = dcrRes.json.client_id;
      if (typeof dcrRes.json.client_secret === 'string' && dcrRes.json.client_secret.trim()) {
        clientSecret = dcrRes.json.client_secret.trim();
      }
    }

    if (!clientId) {
      throw new McpValidationError(
        'OAUTH_CLIENT_ID_REQUIRED',
        'このMCPサーバーは動的クライアント登録に対応していないため、詳細設定で Client ID を入力してください。'
      );
    }

    // Persist discovered/registered endpoints and clientId
    const updatedCfg: McpOAuthConfig = {
      ...existingCfg,
      clientId,
      authorizationUrl,
      tokenUrl,
      registrationUrl,
      scopes,
      resource,
    };
    this.db.updateMcpServer(row.id, {
      oauthConfigJson: JSON.stringify(updatedCfg),
      encryptedOauthClientSecret: clientSecret
        ? encryptSmallSecret(clientSecret, this.config.sessionSecret)
        : row.encryptedOauthClientSecret,
      oauthError: null,
    });

    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('base64url');

    const now = Date.now();
    this.pendingOAuthFlows.set(state, {
      state,
      serverId: row.id,
      adminUserId,
      codeVerifier,
      redirectUri,
      tokenUrl,
      clientId,
      clientSecret,
      resource,
      createdAt: now,
      expiresAt: now + OAUTH_FLOW_TTL_MS,
    });

    const authUrl = new URL(authorizationUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (scopes) {
      authUrl.searchParams.set('scope', scopes);
    }
    if (resource) {
      authUrl.searchParams.set('resource', resource);
    }
    if (existingCfg.extraAuthParams) {
      for (const [k, v] of Object.entries(existingCfg.extraAuthParams)) {
        authUrl.searchParams.set(k, v);
      }
    }

    return {
      authorizationUrl: authUrl.toString(),
      redirectUri,
      state,
    };
  }

  async completeOAuthCallback(
    adminUserId: string,
    params: { code?: string; state?: string; error?: string; errorDescription?: string }
  ): Promise<{ server: McpServerRecord }> {
    this.pruneExpiredOAuthFlows();
    const state = params.state?.trim() ?? '';
    if (!state) {
      throw new McpValidationError('OAUTH_INVALID_STATE', 'OAuth state パラメータが不足しています。');
    }
    const flow = this.pendingOAuthFlows.get(state);
    if (!flow) {
      throw new McpValidationError('OAUTH_STATE_EXPIRED', 'OAuth 認証セッションが見つからないか期限切れです。もう一度開始してください。');
    }
    if (flow.adminUserId !== adminUserId) {
      throw new McpValidationError('FORBIDDEN', 'このOAuth認証セッションを完了する権限がありません。', 403);
    }
    this.pendingOAuthFlows.delete(state);

    const row = this.db.getMcpServerById(flow.serverId);
    if (!row) {
      throw new McpValidationError('MCP_NOT_FOUND', '対象のMCPサーバーが見つかりません。', 404);
    }

    if (params.error) {
      const msg = params.errorDescription ? `${params.error}: ${params.errorDescription}` : params.error;
      this.db.updateMcpServer(row.id, {
        oauthStatus: 'error',
        oauthError: msg,
        oauthUpdatedAt: Date.now(),
      });
      this.emitUpdated(row.scope, row.ownerUserId, row.id);
      throw new McpValidationError('OAUTH_PROVIDER_ERROR', `OAuth認証が拒否されました: ${msg}`);
    }

    const code = params.code?.trim() ?? '';
    if (!code) {
      throw new McpValidationError('OAUTH_CODE_MISSING', '認可コードが返却されませんでした。');
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', flow.redirectUri);
    body.set('client_id', flow.clientId);
    body.set('code_verifier', flow.codeVerifier);
    if (flow.clientSecret) {
      body.set('client_secret', flow.clientSecret);
    }
    if (flow.resource) {
      body.set('resource', flow.resource);
    }

    const tokenHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    const tokenRes = await fetchJsonWithTimeout(flow.tokenUrl, {
      method: 'POST',
      headers: tokenHeaders,
      body: body.toString(),
    });

    if (tokenRes.status < 200 || tokenRes.status >= 300 || !tokenRes.json || typeof tokenRes.json.access_token !== 'string') {
      const detail =
        (tokenRes.json && typeof tokenRes.json.error_description === 'string' && tokenRes.json.error_description) ||
        (tokenRes.json && typeof tokenRes.json.error === 'string' && tokenRes.json.error) ||
        `HTTP ${tokenRes.status}`;
      this.db.updateMcpServer(row.id, {
        oauthStatus: 'error',
        oauthError: `トークン取得に失敗しました: ${detail}`,
        oauthUpdatedAt: Date.now(),
      });
      this.emitUpdated(row.scope, row.ownerUserId, row.id);
      throw new McpValidationError('OAUTH_TOKEN_EXCHANGE_FAILED', `OAuthトークン取得に失敗しました: ${detail}`);
    }

    const expiresInRaw = Number(tokenRes.json.expires_in);
    const expiresAt = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? Date.now() + expiresInRaw * 1000 : null;
    const tokens: StoredOAuthTokens = {
      accessToken: tokenRes.json.access_token,
      refreshToken: typeof tokenRes.json.refresh_token === 'string' ? tokenRes.json.refresh_token : null,
      tokenType: typeof tokenRes.json.token_type === 'string' ? tokenRes.json.token_type : 'Bearer',
      expiresAt,
      scope: typeof tokenRes.json.scope === 'string' ? tokenRes.json.scope : null,
    };

    const updated = this.db.updateMcpServer(row.id, {
      encryptedOauthTokensJson: this.encryptTokens(tokens),
      oauthStatus: 'connected',
      oauthError: null,
      oauthUpdatedAt: Date.now(),
    });

    if (!updated) {
      throw new McpValidationError('MCP_NOT_FOUND', '対象のMCPサーバーが見つかりません。', 404);
    }

    this.emitUpdated(updated.scope, updated.ownerUserId, updated.id);
    return { server: this.toPublicRecord(updated) };
  }

  disconnectOAuth(adminUserId: string, serverId: string): McpServerRecord {
    const existing = this.db.getMcpServerById(serverId);
    if (!existing) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, existing);

    const updated = this.db.updateMcpServer(existing.id, {
      encryptedOauthTokensJson: null,
      oauthStatus: 'disconnected',
      oauthError: null,
      oauthUpdatedAt: Date.now(),
    })!;

    this.emitUpdated(updated.scope, updated.ownerUserId, updated.id);
    return this.toPublicRecord(updated);
  }

  private async ensureFreshOAuthAccessToken(row: StoredMcpServerRow): Promise<string | null> {
    const tokens = this.decryptTokens(row.encryptedOauthTokensJson);
    if (!tokens) return null;

    const isExpiring = Boolean(tokens.expiresAt && tokens.expiresAt <= Date.now() + OAUTH_REFRESH_SKEW_MS);
    if (!isExpiring) {
      return tokens.accessToken;
    }

    const cfg = parseJsonObject<McpOAuthConfig>(row.oauthConfigJson);
    if (!tokens.refreshToken || !cfg?.tokenUrl || !cfg?.clientId) {
      this.db.updateMcpServer(row.id, {
        oauthStatus: 'expired',
        oauthError: 'OAuthアクセストークンの有効期限が切れました。再認証してください。',
        oauthUpdatedAt: Date.now(),
      });
      return null;
    }

    try {
      const body = new URLSearchParams();
      body.set('grant_type', 'refresh_token');
      body.set('refresh_token', tokens.refreshToken);
      body.set('client_id', cfg.clientId);
      const clientSecret = this.decryptClientSecret(row.encryptedOauthClientSecret);
      if (clientSecret) {
        body.set('client_secret', clientSecret);
      }
      if (cfg.resource) {
        body.set('resource', cfg.resource);
      }

      const res = await fetchJsonWithTimeout(cfg.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });

      if (res.status < 200 || res.status >= 300 || !res.json || typeof res.json.access_token !== 'string') {
        const detail =
          (res.json && typeof res.json.error_description === 'string' && res.json.error_description) ||
          (res.json && typeof res.json.error === 'string' && res.json.error) ||
          `HTTP ${res.status}`;
        this.db.updateMcpServer(row.id, {
          oauthStatus: 'expired',
          oauthError: `トークン更新に失敗しました: ${detail}`,
          oauthUpdatedAt: Date.now(),
        });
        return null;
      }

      const expiresInRaw = Number(res.json.expires_in);
      const nextTokens: StoredOAuthTokens = {
        accessToken: res.json.access_token,
        refreshToken:
          typeof res.json.refresh_token === 'string' && res.json.refresh_token
            ? res.json.refresh_token
            : tokens.refreshToken,
        tokenType: typeof res.json.token_type === 'string' ? res.json.token_type : tokens.tokenType ?? 'Bearer',
        expiresAt: Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? Date.now() + expiresInRaw * 1000 : null,
        scope: typeof res.json.scope === 'string' ? res.json.scope : tokens.scope ?? null,
      };

      this.db.updateMcpServer(row.id, {
        encryptedOauthTokensJson: this.encryptTokens(nextTokens),
        oauthStatus: 'connected',
        oauthError: null,
        oauthUpdatedAt: Date.now(),
      });
      return nextTokens.accessToken;
    } catch (err) {
      this.db.updateMcpServer(row.id, {
        oauthStatus: 'error',
        oauthError: err instanceof Error ? err.message : 'トークン更新に失敗しました。',
        oauthUpdatedAt: Date.now(),
      });
      return null;
    }
  }

  // ---- Connection Test ----

  async testServer(adminUserId: string, serverId: string): Promise<McpTestResult> {
    const row = this.db.getMcpServerById(serverId);
    if (!row) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, row);

    if (row.transport === 'stdio') {
      const cmd = row.command ?? '';
      const resolved = resolveHostExecutable(cmd);
      if (!resolved) {
        return {
          ok: false,
          status: 'error',
          message: `実行コマンド "${cmd}" がサーバーの PATH 上に見つかりません。絶対パスまたはインストール状態を確認してください。`,
          resolvedCommand: null,
        };
      }
      return {
        ok: true,
        status: 'connected',
        message: `実行コマンドを確認しました (${resolved})`,
        resolvedCommand: resolved,
      };
    }

    if (!row.url) {
      return { ok: false, status: 'error', message: 'URLが設定されていません。' };
    }

    const headers: Record<string, string> = {
      ...this.decryptRecord(row.encryptedHeadersJson),
    };

    if (row.authType === 'oauth') {
      const token = await this.ensureFreshOAuthAccessToken(row);
      if (token) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'authorization') delete headers[key];
        }
        headers.Authorization = `Bearer ${token}`;
      }
    }

    try {
      if (row.transport === 'sse') {
        const res = await fetchJsonWithTimeout(row.url, {
          method: 'GET',
          headers: { Accept: 'text/event-stream', ...headers },
        });
        if (res.status === 401) {
          const discovered = await this.discoverOAuthMetadata(row.url);
          return {
            ok: false,
            status: 'oauth_required',
            message: '認証が必要です (HTTP 401)。OAuth認証または認証ヘッダーを設定してください。',
            discoveredOAuth: {
              authorizationUrl: discovered.authorizationUrl,
              tokenUrl: discovered.tokenUrl,
              registrationUrl: discovered.registrationUrl,
              scopes: discovered.scopes,
            },
          };
        }
        if (res.status >= 200 && res.status < 300) {
          return {
            ok: true,
            status: 'connected',
            message: `SSEエンドポイントへの接続を確認しました (HTTP ${res.status})`,
          };
        }
        return {
          ok: false,
          status: 'error',
          message: `リモートMCPサーバーからエラーが返されました (HTTP ${res.status})`,
        };
      }

      // Streamable HTTP MCP initialize probe
      const res = await fetchJsonWithTimeout(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'antigravity-chat-ui', version: this.config.appVersion },
          },
        }),
      });

      if (res.status === 401) {
        const discovered = await this.discoverOAuthMetadata(row.url);
        return {
          ok: false,
          status: 'oauth_required',
          message: '認証が必要です (HTTP 401)。OAuth認証またはAPIキー/トークンを設定してください。',
          discoveredOAuth: {
            authorizationUrl: discovered.authorizationUrl,
            tokenUrl: discovered.tokenUrl,
            registrationUrl: discovered.registrationUrl,
            scopes: discovered.scopes,
          },
        };
      }

      if (res.status >= 200 && res.status < 300) {
        const resultObj =
          res.json && typeof res.json.result === 'object' && res.json.result !== null
            ? (res.json.result as Record<string, unknown>)
            : null;
        const serverInfoObj =
          resultObj && typeof resultObj.serverInfo === 'object' && resultObj.serverInfo !== null
            ? (resultObj.serverInfo as Record<string, unknown>)
            : null;
        const serverInfo = serverInfoObj
          ? {
              name: typeof serverInfoObj.name === 'string' ? serverInfoObj.name : undefined,
              version: typeof serverInfoObj.version === 'string' ? serverInfoObj.version : undefined,
            }
          : undefined;
        return {
          ok: true,
          status: 'connected',
          message: serverInfo?.name
            ? `接続成功: ${serverInfo.name}${serverInfo.version ? ` v${serverInfo.version}` : ''}`
            : `リモートMCPサーバーへの接続を確認しました (HTTP ${res.status})`,
          serverInfo,
        };
      }

      return {
        ok: false,
        status: 'error',
        message: `リモートMCPサーバーからエラーが返されました (HTTP ${res.status})`,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        message: `接続に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ---- ACP Native mcpServers Resolution ----

  /**
   * Resolves all enabled MCP servers applicable to `userId` into native ACP `McpServer[]`
   * entries. Profile-scoped servers override shared servers with the same name.
   * Respects `agentCapabilities.mcpCapabilities` so unsupported remote transports are not sent.
   */
  async resolveAcpMcpServersForUser(
    userId: string,
    capabilities?: McpCapabilities | null
  ): Promise<McpServer[]> {
    const rows = this.db.listEffectiveMcpServersForUser(userId);
    if (rows.length === 0) return [];

    // Deduplicate by name: rows are ordered shared-first, profile-second, so profile overrides shared.
    const byName = new Map<string, StoredMcpServerRow>();
    for (const row of rows) {
      byName.set(row.name, row);
    }

    const supportsHttp = Boolean(capabilities?.http);
    const supportsSse = Boolean(capabilities?.sse);
    const out: McpServer[] = [];

    for (const row of byName.values()) {
      if (row.transport === 'stdio') {
        if (!row.command) continue;
        const resolvedCmd = resolveHostExecutable(row.command) ?? row.command;
        const args = parseArgsJson(row.argsJson);
        const envMap = this.decryptRecord(row.encryptedEnvJson);
        const env = Object.entries(envMap).map(([name, value]) => ({ name, value }));
        out.push({
          name: row.name,
          command: resolvedCmd,
          args,
          env,
        });
        continue;
      }

      if (!row.url) continue;
      if (row.transport === 'http' && !supportsHttp) continue;
      if (row.transport === 'sse' && !supportsSse) continue;

      const headerMap = this.decryptRecord(row.encryptedHeadersJson);

      if (row.authType === 'oauth') {
        const accessToken = await this.ensureFreshOAuthAccessToken(row);
        if (!accessToken) {
          // Skip unauthenticated/expired OAuth server rather than failing ACP session creation
          continue;
        }
        for (const key of Object.keys(headerMap)) {
          if (key.toLowerCase() === 'authorization') delete headerMap[key];
        }
        headerMap.Authorization = `Bearer ${accessToken}`;
      }

      const headers = Object.entries(headerMap).map(([name, value]) => ({ name, value }));

      if (row.transport === 'http') {
        out.push({
          type: 'http',
          name: row.name,
          url: row.url,
          headers,
        });
      } else {
        out.push({
          type: 'sse',
          name: row.name,
          url: row.url,
          headers,
        });
      }
    }

    return out;
  }
}
