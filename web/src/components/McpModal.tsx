import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api/client';
import type {
  McpAuthType,
  McpScope,
  McpServerRecord,
  McpTestResult,
  McpTransport,
} from '../types';
import { CloseIcon, PlusIcon, TrashIcon } from './Icons';
import { ToggleSwitch } from './ToggleSwitch';

interface McpModalProps {
  onClose: () => void;
}

interface EditableKeyValue {
  id: string;
  name: string;
  value: string;
  keepExisting: boolean;
  maskedValue?: string;
}

const SCOPE_LABELS: Record<McpScope, string> = {
  shared: '全プロファイル共有',
  profile: '自プロファイルのみ',
};

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  http: 'リモート (HTTP)',
  sse: 'リモート (SSE)',
  stdio: 'ローカル (stdio)',
};

const AUTH_LABELS: Record<McpAuthType, string> = {
  oauth: 'OAuth 2.0 / 2.1',
  bearer: 'Bearer トークン',
  api_key: 'API キー',
  headers: 'カスタムヘッダー',
  none: '認証なし',
};

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function formatOAuthBadge(server: McpServerRecord): { label: string; tone: 'ok' | 'warn' | 'err' | 'muted' } {
  if (server.transport === 'stdio') {
    return { label: 'stdio', tone: 'muted' };
  }
  if (server.authType === 'oauth') {
    const st = server.oauth?.status ?? 'disconnected';
    if (st === 'connected') return { label: 'OAuth 接続済', tone: 'ok' };
    if (st === 'expired') return { label: 'OAuth 期限切れ', tone: 'warn' };
    if (st === 'error') return { label: 'OAuth エラー', tone: 'err' };
    return { label: 'OAuth 未認証', tone: 'warn' };
  }
  if (server.authType === 'bearer') return { label: 'Bearer', tone: 'ok' };
  if (server.authType === 'api_key') return { label: 'APIキー', tone: 'ok' };
  if (server.authType === 'headers') return { label: 'ヘッダー', tone: 'ok' };
  return { label: '認証なし', tone: 'muted' };
}

export const McpModal: React.FC<McpModalProps> = ({ onClose }) => {
  const [scopeTab, setScopeTab] = useState<McpScope>('shared');
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [callbackUrl, setCallbackUrl] = useState<string>(
    `${window.location.origin}/api/mcp/oauth/callback`
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  const [mobileShowEditor, setMobileShowEditor] = useState(false);
  const [editorMode, setEditorMode] = useState<'idle' | 'new' | 'edit' | 'import'>('idle');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<McpScope>('shared');
  const [transport, setTransport] = useState<McpTransport>('http');
  const [enabled, setEnabled] = useState(true);

  // Local (stdio)
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envRows, setEnvRows] = useState<EditableKeyValue[]>([]);

  // Remote (http / sse)
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<McpAuthType>('oauth');
  const [bearerToken, setBearerToken] = useState('');
  const [keepExistingBearer, setKeepExistingBearer] = useState(false);
  const [existingBearerMask, setExistingBearerMask] = useState('');
  const [apiKeyHeaderName, setApiKeyHeaderName] = useState('X-API-Key');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [keepExistingApiKey, setKeepExistingApiKey] = useState(false);
  const [existingApiKeyMask, setExistingApiKeyMask] = useState('');
  const [headerRows, setHeaderRows] = useState<EditableKeyValue[]>([]);

  // OAuth advanced settings
  const [showOAuthAdvanced, setShowOAuthAdvanced] = useState(false);
  const [oauthClientId, setOAuthClientId] = useState('');
  const [oauthClientSecret, setOAuthClientSecret] = useState('');
  const [clearClientSecret, setClearClientSecret] = useState(false);
  const [oauthAuthUrl, setOAuthAuthUrl] = useState('');
  const [oauthTokenUrl, setOAuthTokenUrl] = useState('');
  const [oauthScopes, setOAuthScopes] = useState('');
  const [oauthExtraParamsText, setOAuthExtraParamsText] = useState('');

  // JSON import state
  const [importJsonText, setImportJsonText] = useState('');
  const [importScope, setImportScope] = useState<McpScope>('shared');
  const [importOverwrite, setImportOverwrite] = useState(false);

  const loadServers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listMcpServers();
      setServers(res.servers);
      if (res.callbackUrl) setCallbackUrl(res.callbackUrl);
      return res.servers;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'MCPサーバー一覧の読込に失敗しました。');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const populateFormFromServer = useCallback((srv: McpServerRecord) => {
    setSelectedId(srv.id);
    setEditorMode('edit');
    setName(srv.name);
    setDescription(srv.description);
    setScope(srv.scope);
    setTransport(srv.transport);
    setEnabled(srv.enabled);
    setCommand(srv.command ?? '');
    setArgsText(srv.args.join('\n'));
    setEnvRows(
      srv.env.map((e) => ({
        id: uid(),
        name: e.name,
        value: '',
        keepExisting: e.hasValue,
        maskedValue: e.maskedValue,
      }))
    );
    setUrl(srv.url ?? '');
    setAuthType(srv.authType);

    // Populate bearer / api_key / headers cleanly
    const authHeader = srv.headers.find((h) => h.name.toLowerCase() === 'authorization');
    if (srv.authType === 'bearer' && authHeader) {
      setKeepExistingBearer(authHeader.hasValue);
      setExistingBearerMask(authHeader.maskedValue);
      setBearerToken('');
      setHeaderRows(
        srv.headers
          .filter((h) => h.name.toLowerCase() !== 'authorization')
          .map((h) => ({
            id: uid(),
            name: h.name,
            value: '',
            keepExisting: h.hasValue,
            maskedValue: h.maskedValue,
          }))
      );
      setApiKeyHeaderName('X-API-Key');
      setApiKeyValue('');
      setKeepExistingApiKey(false);
      setExistingApiKeyMask('');
    } else if (srv.authType === 'api_key' && srv.headers.length > 0) {
      const primary = srv.headers[0];
      setApiKeyHeaderName(primary.name);
      setKeepExistingApiKey(primary.hasValue);
      setExistingApiKeyMask(primary.maskedValue);
      setApiKeyValue('');
      setHeaderRows(
        srv.headers.slice(1).map((h) => ({
          id: uid(),
          name: h.name,
          value: '',
          keepExisting: h.hasValue,
          maskedValue: h.maskedValue,
        }))
      );
      setBearerToken('');
      setKeepExistingBearer(false);
      setExistingBearerMask('');
    } else {
      setBearerToken('');
      setKeepExistingBearer(false);
      setExistingBearerMask('');
      setApiKeyHeaderName('X-API-Key');
      setApiKeyValue('');
      setKeepExistingApiKey(false);
      setExistingApiKeyMask('');
      setHeaderRows(
        srv.headers.map((h) => ({
          id: uid(),
          name: h.name,
          value: '',
          keepExisting: h.hasValue,
          maskedValue: h.maskedValue,
        }))
      );
    }

    setOAuthClientId(srv.oauth?.clientId ?? '');
    setOAuthClientSecret('');
    setClearClientSecret(false);
    setOAuthAuthUrl(srv.oauth?.authorizationUrl ?? '');
    setOAuthTokenUrl(srv.oauth?.tokenUrl ?? '');
    setOAuthScopes(srv.oauth?.scopes ?? '');
    const extraPairs = Object.entries(srv.oauth?.extraAuthParams ?? {}).map(([k, v]) => `${k}=${v}`);
    setOAuthExtraParamsText(extraPairs.join('\n'));
    setShowOAuthAdvanced(Boolean(srv.oauth?.clientId || srv.oauth?.authorizationUrl || srv.oauth?.scopes));
    setTestResult(null);
    setError(null);
    setStatusNote(null);
    setMobileShowEditor(true);
  }, []);

  // Listen for OAuth popup completion
  useEffect(() => {
    const onMessage = (evt: MessageEvent) => {
      if (evt.origin !== window.location.origin) return;
      const data = evt.data as {
        type?: string;
        ok?: boolean;
        serverId?: string;
        message?: string;
      } | null;
      if (!data || data.type !== 'agy-mcp-oauth-complete') return;

      void loadServers().then((updatedList) => {
        if (updatedList && data.serverId) {
          const hit = updatedList.find((s) => s.id === data.serverId);
          if (hit && selectedId === hit.id) {
            populateFormFromServer(hit);
          }
        }
        if (data.ok) {
          setStatusNote(data.message || 'OAuth認証が完了しました。');
          setError(null);
        } else {
          setError(data.message || 'OAuth認証に失敗しました。');
        }
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadServers, populateFormFromServer, selectedId]);

  const filteredServers = useMemo(
    () => servers.filter((s) => s.scope === scopeTab),
    [servers, scopeTab]
  );

  const selectedServer = useMemo(
    () => (selectedId ? servers.find((s) => s.id === selectedId) ?? null : null),
    [servers, selectedId]
  );

  const openNewForm = (initialTransport: McpTransport = 'http') => {
    setSelectedId(null);
    setEditorMode('new');
    setName('');
    setDescription('');
    setScope(scopeTab);
    setTransport(initialTransport);
    setEnabled(true);
    setCommand('');
    setArgsText('');
    setEnvRows([]);
    setUrl('');
    setAuthType(initialTransport === 'stdio' ? 'none' : 'oauth');
    setBearerToken('');
    setKeepExistingBearer(false);
    setExistingBearerMask('');
    setApiKeyHeaderName('X-API-Key');
    setApiKeyValue('');
    setKeepExistingApiKey(false);
    setExistingApiKeyMask('');
    setHeaderRows([]);
    setShowOAuthAdvanced(false);
    setOAuthClientId('');
    setOAuthClientSecret('');
    setClearClientSecret(false);
    setOAuthAuthUrl('');
    setOAuthTokenUrl('');
    setOAuthScopes('');
    setOAuthExtraParamsText('');
    setTestResult(null);
    setError(null);
    setStatusNote(null);
    setMobileShowEditor(true);
  };

  const openImportForm = () => {
    setSelectedId(null);
    setEditorMode('import');
    setImportScope(scopeTab);
    setImportJsonText('');
    setImportOverwrite(false);
    setError(null);
    setStatusNote(null);
    setTestResult(null);
    setMobileShowEditor(true);
  };

  const buildHeadersPayload = (): Array<{ name: string; value?: string; keepExisting?: boolean }> => {
    const out: Array<{ name: string; value?: string; keepExisting?: boolean }> = [];
    if (authType === 'bearer') {
      if (bearerToken.trim()) {
        const val = bearerToken.trim();
        out.push({
          name: 'Authorization',
          value: /^bearer\s+/i.test(val) ? val : `Bearer ${val}`,
        });
      } else if (keepExistingBearer) {
        out.push({ name: 'Authorization', keepExisting: true });
      }
    } else if (authType === 'api_key') {
      const hName = apiKeyHeaderName.trim() || 'X-API-Key';
      if (apiKeyValue.trim()) {
        out.push({ name: hName, value: apiKeyValue.trim() });
      } else if (keepExistingApiKey) {
        out.push({ name: hName, keepExisting: true });
      }
    }
    for (const row of headerRows) {
      const k = row.name.trim();
      if (!k) continue;
      if (row.keepExisting && !row.value) {
        out.push({ name: k, keepExisting: true });
      } else {
        out.push({ name: k, value: row.value });
      }
    }
    return out;
  };

  const parseExtraParams = (): Record<string, string> | null => {
    const out: Record<string, string> = {};
    for (const line of oauthExtraParamsText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (k && v) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatusNote(null);

    try {
      const args = argsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const env = envRows
        .filter((r) => r.name.trim().length > 0)
        .map((r) =>
          r.keepExisting && !r.value
            ? { name: r.name.trim(), keepExisting: true }
            : { name: r.name.trim(), value: r.value }
        );

      const headers = transport === 'stdio' ? undefined : buildHeadersPayload();
      const oauthConfig =
        transport !== 'stdio' && authType === 'oauth'
          ? {
              clientId: oauthClientId.trim() || null,
              ...(clearClientSecret
                ? { clearClientSecret: true }
                : oauthClientSecret.trim()
                  ? { clientSecret: oauthClientSecret.trim() }
                  : {}),
              authorizationUrl: oauthAuthUrl.trim() || null,
              tokenUrl: oauthTokenUrl.trim() || null,
              scopes: oauthScopes.trim() || null,
              extraAuthParams: parseExtraParams(),
            }
          : null;

      let saved: McpServerRecord;
      if (editorMode === 'new') {
        const res = await api.createMcpServer({
          name: name.trim(),
          description: description.trim(),
          scope,
          transport,
          enabled,
          command: transport === 'stdio' ? command.trim() : null,
          args: transport === 'stdio' ? args : [],
          env: transport === 'stdio' ? env : [],
          url: transport === 'stdio' ? null : url.trim(),
          authType: transport === 'stdio' ? 'none' : authType,
          headers,
          oauthConfig,
        });
        saved = res.server;
      } else if (selectedId) {
        const res = await api.updateMcpServer(selectedId, {
          name: name.trim(),
          description: description.trim(),
          scope,
          transport,
          enabled,
          command: transport === 'stdio' ? command.trim() : null,
          args: transport === 'stdio' ? args : [],
          env: transport === 'stdio' ? env : [],
          url: transport === 'stdio' ? null : url.trim(),
          authType: transport === 'stdio' ? 'none' : authType,
          headers,
          oauthConfig,
        });
        saved = res.server;
      } else {
        return;
      }

      setScopeTab(saved.scope);
      await loadServers();
      populateFormFromServer(saved);
      setStatusNote(
        saved.authType === 'oauth' && saved.oauth?.status !== 'connected'
          ? '保存しました。「OAuth 認証を開始」から認証を完了してください。'
          : 'MCPサーバーを保存しました。次のチャットターンから反映されます。'
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleEnabled = async (srv: McpServerRecord, next: boolean) => {
    setError(null);
    setStatusNote(null);
    try {
      const res = await api.updateMcpServer(srv.id, { enabled: next });
      await loadServers();
      if (selectedId === srv.id) {
        setEnabled(res.server.enabled);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '有効状態の更新に失敗しました。');
    }
  };

  const handleDelete = async () => {
    if (!selectedServer) return;
    if (!window.confirm(`MCPサーバー「${selectedServer.name}」を削除しますか？`)) return;
    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      await api.deleteMcpServer(selectedServer.id);
      setSelectedId(null);
      setEditorMode('idle');
      setMobileShowEditor(false);
      await loadServers();
      setStatusNote(`「${selectedServer.name}」を削除しました。`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '削除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    if (!selectedServer) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await api.testMcpServer(selectedServer.id);
      setTestResult(res.result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '接続テストに失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleStartOAuth = async () => {
    if (!selectedServer) return;
    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      const res = await api.startMcpOAuth(selectedServer.id);
      const popup = window.open(
        res.authorizationUrl,
        'agy_mcp_oauth',
        'width=620,height=760,noopener=false'
      );
      if (!popup) {
        setStatusNote('ポップアップがブロックされました。新しいタブで認証URLを開いてください。');
        window.open(res.authorizationUrl, '_blank');
      } else {
        setStatusNote('認証ウィンドウを開きました。ブラウザでログイン・許可を完了してください。');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'OAuth認証の開始に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnectOAuth = async () => {
    if (!selectedServer) return;
    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      const res = await api.disconnectMcpOAuth(selectedServer.id);
      await loadServers();
      populateFormFromServer(res.server);
      setStatusNote('OAuthトークンを削除しました。');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'OAuth切断に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleImportJson = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      const res = await api.importMcpJson({
        scope: importScope,
        rawJson: importJsonText,
        overwrite: importOverwrite,
      });
      setScopeTab(importScope);
      await loadServers();
      if (res.imported.length > 0) {
        populateFormFromServer(res.imported[0]);
      } else {
        setEditorMode('idle');
      }
      const skippedMsg = res.skipped.length > 0 ? `（スキップ: ${res.skipped.join(', ')}）` : '';
      setStatusNote(`${res.imported.length} 件のMCPサーバーをインポートしました${skippedMsg}。`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'JSONインポートに失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const copyCallbackUrl = async () => {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setStatusNote('コールバックURLをコピーしました。');
    } catch {
      setStatusNote(callbackUrl);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-xl skills-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>MCP サーバー管理（管理者専用）</h3>
            <p className="muted-xs" style={{ marginTop: 2 }}>
              リモート（OAuth / APIキー / Bearer / ヘッダー）およびローカル（stdio）MCPをネイティブACP経由で接続します
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="skills-scope-tabs" role="tablist">
          {(['shared', 'profile'] as McpScope[]).map((sc) => {
            const count = servers.filter((s) => s.scope === sc).length;
            return (
              <button
                key={sc}
                type="button"
                role="tab"
                aria-selected={scopeTab === sc}
                className={`skills-scope-tab ${scopeTab === sc ? 'active' : ''}`}
                onClick={() => {
                  setScopeTab(sc);
                  setMobileShowEditor(false);
                }}
              >
                <span>{SCOPE_LABELS[sc]}</span>
                <span className="skills-tab-count">{count}</span>
              </button>
            );
          })}
        </div>

        <div className={`skills-body ${mobileShowEditor ? 'mobile-editor' : ''}`}>
          {/* Left pane: Server list */}
          <div className="skills-list-pane">
            <div className="skills-list-toolbar">
              <button
                type="button"
                className="btn btn-primary btn-xs"
                onClick={() => openNewForm('http')}
              >
                <PlusIcon size={13} /> 新規追加
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={openImportForm}
              >
                JSON取込
              </button>
            </div>

            <div className="muted-xs" style={{ padding: '0 12px 8px' }}>
              {scopeTab === 'shared'
                ? '全ユーザーのチャットセッションに自動で接続されます（認証情報はサーバー側で暗号化管理）。'
                : '管理者であるご自身のプロファイルのチャットセッションにのみ接続されます。'}
            </div>

            {loading ? (
              <div className="muted-xs" style={{ padding: 16 }}>読み込み中...</div>
            ) : filteredServers.length === 0 ? (
              <div className="skills-empty-list">
                <p className="muted-xs">このスコープにMCPサーバーはまだありません。</p>
                <div className="row-actions" style={{ justifyContent: 'center', marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    onClick={() => openNewForm('http')}
                  >
                    リモートMCPを追加
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    onClick={() => openNewForm('stdio')}
                  >
                    ローカルMCPを追加
                  </button>
                </div>
              </div>
            ) : (
              <div className="skills-list">
                {filteredServers.map((srv) => {
                  const badge = formatOAuthBadge(srv);
                  return (
                    <div
                      key={srv.id}
                      className={`skill-list-item ${selectedId === srv.id && editorMode === 'edit' ? 'selected' : ''} ${!srv.enabled ? 'disabled' : ''}`}
                      onClick={() => populateFormFromServer(srv)}
                    >
                      <div className="skill-list-main">
                        <div className="skill-list-title">
                          <strong>{srv.name}</strong>
                          <span className="mcp-badge mcp-badge-transport">{srv.transport.toUpperCase()}</span>
                          <span className={`mcp-badge mcp-badge-${badge.tone}`}>{badge.label}</span>
                        </div>
                        <div className="muted-xs skill-list-desc">
                          {srv.description || (srv.transport === 'stdio' ? srv.command : srv.url) || ''}
                        </div>
                      </div>
                      <div
                        className="skill-list-toggle"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ToggleSwitch
                          checked={srv.enabled}
                          label=""
                          onChange={(next) => void handleToggleEnabled(srv, next)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right pane: Editor / Import / Idle */}
          <div className="skills-editor-pane">
            {mobileShowEditor && (
              <button
                type="button"
                className="btn btn-secondary btn-xs mobile-back-btn"
                onClick={() => setMobileShowEditor(false)}
              >
                ← 一覧へ戻る
              </button>
            )}

            {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
            {statusNote && <div className="success-box" style={{ marginBottom: 12 }}>{statusNote}</div>}

            {editorMode === 'idle' && (
              <div className="skills-editor-idle">
                <h4>MCP サーバーを選択または追加</h4>
                <p className="muted-xs">
                  「全プロファイル共有」に追加したMCPは全ユーザーへ、「自プロファイルのみ」に追加したMCPは管理者自身のみへ適用されます。
                  認証シークレットやOAuthトークンは暗号化して保存され、他ユーザーのホームディレクトリには書き込まれません。
                </p>
                <div className="row-actions" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => openNewForm('http')}
                  >
                    <PlusIcon size={14} /> リモートMCPを追加
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => openNewForm('stdio')}
                  >
                    <PlusIcon size={14} /> ローカルMCPを追加
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={openImportForm}
                  >
                    標準JSONからインポート
                  </button>
                </div>
              </div>
            )}

            {editorMode === 'import' && (
              <form onSubmit={handleImportJson} className="mcp-form">
                <h4>標準 MCP JSON からインポート</h4>
                <p className="muted-xs">
                  Claude Desktop / Cursor / Antigravity / VS Code などの <code>mcpServers</code> JSON をそのまま貼り付けて登録できます（リモート <code>url</code> / <code>serverUrl</code> およびローカル <code>command</code> 両対応）。
                </p>

                <div className="form-group">
                  <label>登録先スコープ</label>
                  <select
                    value={importScope}
                    onChange={(e) => setImportScope(e.target.value as McpScope)}
                  >
                    <option value="shared">全プロファイル共有（他プロファイルにも適用）</option>
                    <option value="profile">自プロファイルのみ（管理者専用）</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>MCP 設定 JSON</label>
                  <textarea
                    rows={11}
                    value={importJsonText}
                    onChange={(e) => setImportJsonText(e.target.value)}
                    placeholder={`{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"],\n      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }\n    },\n    "linear": {\n      "url": "https://mcp.linear.app/mcp"\n    }\n  }\n}`}
                    required
                  />
                </div>

                <ToggleSwitch
                  checked={importOverwrite}
                  label="同じスコープに同名のサーバーがある場合は上書きする"
                  onChange={setImportOverwrite}
                />

                <div className="row-actions" style={{ marginTop: 14 }}>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                    インポート実行
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setEditorMode('idle')}
                  >
                    キャンセル
                  </button>
                </div>
              </form>
            )}

            {(editorMode === 'new' || editorMode === 'edit') && (
              <form onSubmit={handleSave} className="mcp-form">
                <div className="mcp-form-header">
                  <h4>{editorMode === 'new' ? '新規 MCP サーバー' : `編集: ${selectedServer?.name ?? name}`}</h4>
                  {editorMode === 'edit' && selectedServer && (
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        onClick={() => void handleTest()}
                        disabled={busy}
                      >
                        接続テスト
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger-outline btn-xs"
                        onClick={() => void handleDelete()}
                        disabled={busy}
                      >
                        <TrashIcon size={13} /> 削除
                      </button>
                    </div>
                  )}
                </div>

                {testResult && (
                  <div className={testResult.ok ? 'success-box' : 'error-box'} style={{ marginBottom: 12 }}>
                    <div>{testResult.message}</div>
                    {testResult.discoveredOAuth?.authorizationUrl && (
                      <div className="muted-xs" style={{ marginTop: 4 }}>
                        OAuth エンドポイント検出済: {testResult.discoveredOAuth.authorizationUrl}
                      </div>
                    )}
                  </div>
                )}

                <div className="mcp-grid-2">
                  <div className="form-group">
                    <label>サーバー名（英数字・._-）</label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="例: github, linear, google-drive"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>適用スコープ</label>
                    <select value={scope} onChange={(e) => setScope(e.target.value as McpScope)}>
                      <option value="shared">全プロファイル共有（他プロファイルにも持つ）</option>
                      <option value="profile">自プロファイルのみ</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label>説明（任意）</label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="用途メモ（例: 社内Notion検索、GitHub Issue管理）"
                  />
                </div>

                <div className="mcp-grid-2">
                  <div className="form-group">
                    <label>接続方式（トランスポート）</label>
                    <select
                      value={transport}
                      onChange={(e) => {
                        const next = e.target.value as McpTransport;
                        setTransport(next);
                        if (next === 'stdio') setAuthType('none');
                        else if (authType === 'none' && editorMode === 'new') setAuthType('oauth');
                      }}
                    >
                      <option value="http">{TRANSPORT_LABELS.http}</option>
                      <option value="sse">{TRANSPORT_LABELS.sse}</option>
                      <option value="stdio">{TRANSPORT_LABELS.stdio}</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ justifyContent: 'flex-end' }}>
                    <ToggleSwitch checked={enabled} label="有効にする" onChange={setEnabled} />
                  </div>
                </div>

                {transport === 'stdio' ? (
                  <>
                    <div className="form-group">
                      <label>実行コマンド</label>
                      <input
                        type="text"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="例: npx, uvx, node, python3, /usr/local/bin/my-mcp"
                        required
                      />
                    </div>

                    <div className="form-group">
                      <label>引数（1行につき1引数）</label>
                      <textarea
                        rows={4}
                        value={argsText}
                        onChange={(e) => setArgsText(e.target.value)}
                        placeholder={`-y\n@modelcontextprotocol/server-filesystem\n/workspace`}
                      />
                    </div>

                    <div className="form-group">
                      <div className="mcp-kv-header">
                        <label>環境変数（暗号化保存）</label>
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          onClick={() =>
                            setEnvRows((prev) => [
                              ...prev,
                              { id: uid(), name: '', value: '', keepExisting: false },
                            ])
                          }
                        >
                          + 環境変数を追加
                        </button>
                      </div>
                      {envRows.map((row) => (
                        <div key={row.id} className="mcp-kv-row">
                          <input
                            type="text"
                            placeholder="KEY"
                            value={row.name}
                            onChange={(e) =>
                              setEnvRows((prev) =>
                                prev.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r))
                              )
                            }
                          />
                          <input
                            type="password"
                            placeholder={
                              row.keepExisting && row.maskedValue
                                ? `保存済 (${row.maskedValue}) — 変更時のみ入力`
                                : 'VALUE'
                            }
                            value={row.value}
                            onChange={(e) =>
                              setEnvRows((prev) =>
                                prev.map((r) =>
                                  r.id === row.id
                                    ? { ...r, value: e.target.value, keepExisting: e.target.value.length === 0 && Boolean(r.maskedValue) }
                                    : r
                                )
                              )
                            }
                          />
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label="削除"
                            onClick={() => setEnvRows((prev) => prev.filter((r) => r.id !== row.id))}
                          >
                            <TrashIcon size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="form-group">
                      <label>リモート MCP URL</label>
                      <input
                        type="url"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder={
                          transport === 'sse'
                            ? 'https://example.com/sse'
                            : 'https://mcp.example.com/mcp'
                        }
                        required
                      />
                    </div>

                    <div className="form-group">
                      <label>認証方式</label>
                      <select
                        value={authType}
                        onChange={(e) => setAuthType(e.target.value as McpAuthType)}
                      >
                        <option value="oauth">{AUTH_LABELS.oauth}</option>
                        <option value="bearer">{AUTH_LABELS.bearer}</option>
                        <option value="api_key">{AUTH_LABELS.api_key}</option>
                        <option value="headers">{AUTH_LABELS.headers}</option>
                        <option value="none">{AUTH_LABELS.none}</option>
                      </select>
                    </div>

                    {authType === 'bearer' && (
                      <div className="form-group">
                        <label>Bearer トークン</label>
                        <input
                          type="password"
                          value={bearerToken}
                          onChange={(e) => {
                            setBearerToken(e.target.value);
                            if (e.target.value) setKeepExistingBearer(false);
                          }}
                          placeholder={
                            keepExistingBearer && existingBearerMask
                              ? `保存済 (${existingBearerMask}) — 変更時のみ入力`
                              : 'トークンを入力（Bearer 接頭辞は自動付与）'
                          }
                        />
                      </div>
                    )}

                    {authType === 'api_key' && (
                      <div className="mcp-grid-2">
                        <div className="form-group">
                          <label>APIキー ヘッダー名</label>
                          <input
                            type="text"
                            value={apiKeyHeaderName}
                            onChange={(e) => setApiKeyHeaderName(e.target.value)}
                            placeholder="X-API-Key"
                          />
                        </div>
                        <div className="form-group">
                          <label>APIキー値</label>
                          <input
                            type="password"
                            value={apiKeyValue}
                            onChange={(e) => {
                              setApiKeyValue(e.target.value);
                              if (e.target.value) setKeepExistingApiKey(false);
                            }}
                            placeholder={
                              keepExistingApiKey && existingApiKeyMask
                                ? `保存済 (${existingApiKeyMask}) — 変更時のみ入力`
                                : 'APIキーを入力'
                            }
                          />
                        </div>
                      </div>
                    )}

                    {authType === 'oauth' && (
                      <div className="mcp-oauth-box">
                        <div className="mcp-oauth-status-row">
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>
                              OAuth 接続状態:{' '}
                              {selectedServer?.oauth?.status === 'connected'
                                ? '接続済み'
                                : selectedServer?.oauth?.status === 'expired'
                                  ? '有効期限切れ（再認証が必要）'
                                  : selectedServer?.oauth?.status === 'error'
                                    ? 'エラー'
                                    : '未認証'}
                            </div>
                            {selectedServer?.oauth?.expiresAt && (
                              <div className="muted-xs">
                                有効期限: {new Date(selectedServer.oauth.expiresAt).toLocaleString()}
                                {selectedServer.oauth.hasRefreshToken ? '（自動リフレッシュ対応）' : ''}
                              </div>
                            )}
                            {selectedServer?.oauth?.error && (
                              <div className="muted-xs" style={{ color: '#f87171', marginTop: 2 }}>
                                {selectedServer.oauth.error}
                              </div>
                            )}
                          </div>
                          {editorMode === 'edit' && selectedServer ? (
                            <div className="row-actions">
                              <button
                                type="button"
                                className="btn btn-primary btn-xs"
                                onClick={() => void handleStartOAuth()}
                                disabled={busy}
                              >
                                {selectedServer.oauth?.status === 'connected' ? '再認証' : 'OAuth 認証を開始'}
                              </button>
                              {selectedServer.oauth?.status === 'connected' && (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-xs"
                                  onClick={() => void handleDisconnectOAuth()}
                                  disabled={busy}
                                >
                                  切断
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="muted-xs">保存後に「OAuth 認証を開始」できます</span>
                          )}
                        </div>

                        <div className="mcp-callback-row">
                          <span className="muted-xs">コールバック URL (Redirect URI):</span>
                          <div className="mcp-callback-copy">
                            <code>{callbackUrl}</code>
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs"
                              onClick={() => void copyCallbackUrl()}
                            >
                              コピー
                            </button>
                          </div>
                        </div>

                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          style={{ marginTop: 8 }}
                          onClick={() => setShowOAuthAdvanced((v) => !v)}
                        >
                          {showOAuthAdvanced ? '▲ 詳細OAuth設定を隠す' : '▼ 詳細OAuth設定（手動Client ID/Secret等）'}
                        </button>

                        {showOAuthAdvanced && (
                          <div className="mcp-oauth-advanced">
                            <p className="muted-xs" style={{ margin: '0 0 8px' }}>
                              RFC 9728 / 動的クライアント登録（DCR）対応サーバーでは空欄のままで自動構成されます。Google Workspace・GitHub・Slackなど事前登録が必要なサービスでは Client ID / Secret を入力してください。
                            </p>
                            <div className="mcp-grid-2">
                              <div className="form-group">
                                <label>Client ID（任意）</label>
                                <input
                                  type="text"
                                  value={oauthClientId}
                                  onChange={(e) => setOAuthClientId(e.target.value)}
                                  placeholder="自動登録または手動入力"
                                />
                              </div>
                              <div className="form-group">
                                <label>Client Secret（任意）</label>
                                <input
                                  type="password"
                                  value={oauthClientSecret}
                                  onChange={(e) => {
                                    setOAuthClientSecret(e.target.value);
                                    if (e.target.value) setClearClientSecret(false);
                                  }}
                                  placeholder={
                                    selectedServer?.oauth?.hasClientSecret && !clearClientSecret
                                      ? '保存済 — 変更時のみ入力'
                                      : '必要な場合のみ入力'
                                  }
                                />
                              </div>
                            </div>
                            <div className="mcp-grid-2">
                              <div className="form-group">
                                <label>Authorization URL（任意）</label>
                                <input
                                  type="url"
                                  value={oauthAuthUrl}
                                  onChange={(e) => setOAuthAuthUrl(e.target.value)}
                                  placeholder="空欄で自動検出"
                                />
                              </div>
                              <div className="form-group">
                                <label>Token URL（任意）</label>
                                <input
                                  type="url"
                                  value={oauthTokenUrl}
                                  onChange={(e) => setOAuthTokenUrl(e.target.value)}
                                  placeholder="空欄で自動検出"
                                />
                              </div>
                            </div>
                            <div className="form-group">
                              <label>Scopes（スペース区切り・任意）</label>
                              <input
                                type="text"
                                value={oauthScopes}
                                onChange={(e) => setOAuthScopes(e.target.value)}
                                placeholder="例: read write offline_access"
                              />
                            </div>
                            <div className="form-group">
                              <label>追加認可パラメータ（1行に key=value・任意）</label>
                              <textarea
                                rows={2}
                                value={oauthExtraParamsText}
                                onChange={(e) => setOAuthExtraParamsText(e.target.value)}
                                placeholder={`access_type=offline\nprompt=consent`}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {(authType === 'headers' || authType === 'bearer' || authType === 'api_key' || authType === 'oauth') && (
                      <div className="form-group">
                        <div className="mcp-kv-header">
                          <label>
                            {authType === 'headers' ? 'HTTP ヘッダー（暗号化保存）' : '追加 HTTP ヘッダー（任意）'}
                          </label>
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            onClick={() =>
                              setHeaderRows((prev) => [
                                ...prev,
                                { id: uid(), name: '', value: '', keepExisting: false },
                              ])
                            }
                          >
                            + ヘッダーを追加
                          </button>
                        </div>
                        {headerRows.map((row) => (
                          <div key={row.id} className="mcp-kv-row">
                            <input
                              type="text"
                              placeholder="Header-Name"
                              value={row.name}
                              onChange={(e) =>
                                setHeaderRows((prev) =>
                                  prev.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r))
                                )
                              }
                            />
                            <input
                              type="password"
                              placeholder={
                                row.keepExisting && row.maskedValue
                                  ? `保存済 (${row.maskedValue}) — 変更時のみ入力`
                                  : 'Header Value'
                              }
                              value={row.value}
                              onChange={(e) =>
                                setHeaderRows((prev) =>
                                  prev.map((r) =>
                                    r.id === row.id
                                      ? { ...r, value: e.target.value, keepExisting: e.target.value.length === 0 && Boolean(r.maskedValue) }
                                      : r
                                  )
                                )
                              }
                            />
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label="削除"
                              onClick={() => setHeaderRows((prev) => prev.filter((r) => r.id !== row.id))}
                            >
                              <TrashIcon size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                <div className="row-actions" style={{ marginTop: 14 }}>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                    {editorMode === 'new' ? 'MCPサーバーを追加' : '変更を保存'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setEditorMode('idle');
                      setMobileShowEditor(false);
                    }}
                  >
                    キャンセル
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
