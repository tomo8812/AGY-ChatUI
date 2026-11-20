import React, { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { AgyLoginFlowState, AgyProfile, WebUser } from '../types';
import { CheckIcon, CloseIcon, CopyIcon, ExternalLinkIcon } from './Icons';

interface AgyOnboardingProps {
  user: WebUser;
  profile: AgyProfile | null;
  loginFlow: AgyLoginFlowState | null;
  agyMode: 'real' | 'mock';
  isModal?: boolean;
  onClose?: () => void;
  onUpdated: (payload: { profile: AgyProfile; loginFlow?: AgyLoginFlowState | null }) => void;
  onLogout?: () => void;
}

export const AgyOnboarding: React.FC<AgyOnboardingProps> = ({
  user,
  profile,
  loginFlow,
  agyMode,
  isModal = false,
  onClose,
  onUpdated,
  onLogout,
}) => {
  const [tab, setTab] = useState<'oauth' | 'apikey'>('oauth');
  const [accountLabel, setAccountLabel] = useState(profile?.accountLabel ?? '');
  const [authCode, setAuthCode] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeUrl = loginFlow?.authUrl ?? null;
  const flowStatus = loginFlow?.status ?? 'idle';
  const awaitingCode =
    flowStatus === 'awaiting_url' || flowStatus === 'awaiting_code' || flowStatus === 'verifying';

  const handleStartOAuth = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api.startAgyLogin(accountLabel.trim() || null);
      onUpdated({ profile: res.profile, loginFlow: res.loginFlow });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '認証開始に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authCode.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.submitAgyCode(authCode.trim());
      onUpdated({ profile: res.profile, loginFlow: res.loginFlow });
      if (res.profile.authStatus === 'authenticated') {
        setAuthCode('');
        onClose?.();
      } else if (res.loginFlow.error) {
        setError(res.loginFlow.error);
      } else if (res.loginFlow.status === 'failed') {
        setError('認証に失敗しました。コードを確認してやり直してください。');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '認証コード送信に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelOAuth = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.cancelAgyLogin();
      onUpdated({ profile: res.profile, loginFlow: res.loginFlow });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '認証のキャンセルに失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyUrl = async () => {
    if (!activeUrl) return;
    await navigator.clipboard.writeText(activeUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 1800);
  };

  const handleSubmitApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.setAgyApiKey(apiKey.trim(), accountLabel.trim() || 'Gemini API Key');
      onUpdated({ profile: res.profile });
      setApiKey('');
      onClose?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'APIキー認証に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <div className={isModal ? 'agy-panel modal-inner' : 'auth-card agy-onboarding-card'}>
      <div className="agy-header">
        <div>
          <span className="pill-badge">Webユーザー: {user.displayName}</span>
          <h2>Antigravity に接続</h2>
          <p className="muted-sm">
            チャットを始めるには、Google アカウントまたは Gemini API キーで認証してください。
          </p>
        </div>
        {isModal && onClose ? (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
            <CloseIcon size={18} />
          </button>
        ) : (
          onLogout && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
              ログアウト
            </button>
          )
        )}
      </div>

      <div className="segmented-tabs" role="tablist" aria-label="Antigravity 認証方式">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'oauth'}
          className={tab === 'oauth' ? 'seg-btn active' : 'seg-btn'}
          onClick={() => {
            setTab('oauth');
            setError(null);
          }}
        >
          Google アカウント
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'apikey'}
          className={tab === 'apikey' ? 'seg-btn active' : 'seg-btn'}
          onClick={() => {
            setTab('apikey');
            setError(null);
          }}
        >
          Gemini API Key
        </button>
      </div>

      {tab === 'oauth' ? (
        <div className="stack-gap">
          <label className="field">
            <span>アカウント識別メモ（任意・ヘッダー表示用）</span>
            <input
              type="text"
              value={accountLabel}
              onChange={(e) => setAccountLabel(e.target.value)}
              placeholder="例: メインGoogle / サブアカウント"
            />
          </label>

          {!awaitingCode || !activeUrl ? (
            <div className="step-card">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleStartOAuth}
                disabled={busy}
              >
                {busy ? 'リンクを発行中…' : 'Google 認証リンクを発行'}
              </button>
            </div>
          ) : (
            <div className="stack-gap">
              <div className="step-card">
                <div className="step-title">手順 1: ブラウザでログインしてコードを取得</div>
                <p className="muted-sm">
                  Google にログインし、表示された認証コードをコピーしてください。
                </p>
                <div className="url-box">
                  <a
                    href={activeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="url-link"
                  >
                    <span>Google 認証ページを開く</span>
                    <ExternalLinkIcon size={14} />
                  </a>
                  <div className="row-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={handleCopyUrl}>
                      {copiedUrl ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                      <span>{copiedUrl ? 'コピー完了' : 'URLをコピー'}</span>
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={handleStartOAuth} disabled={busy}>
                      再発行
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={handleCancelOAuth} disabled={busy}>
                      キャンセル
                    </button>
                  </div>
                </div>
              </div>

              <form onSubmit={handleSubmitCode} className="step-card">
                <div className="step-title">手順 2: 取得した認証コードを貼り付け</div>
                {agyMode === 'mock' && (
                  <p className="muted-sm">
                    テスト用モックモードでは任意の文字列（例: <code>user:alice@gmail.com</code>）で認証成功、<code>invalid</code> でエラーを検証できます。
                  </p>
                )}
                <div className="code-paste-row">
                  <input
                    type="text"
                    value={authCode}
                    onChange={(e) => setAuthCode(e.target.value)}
                    placeholder="4/0A... のような認証コードを貼り付け"
                    aria-label="認証コード"
                    required
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={busy || flowStatus === 'verifying' || !authCode.trim()}
                  >
                    {busy || flowStatus === 'verifying' ? '検証中...' : '認証を完了する'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {(loginFlow?.outputLines?.length ?? 0) > 0 && (
            <div className="disclosure">
              <button type="button" className="disclosure-btn" onClick={() => setShowLogs((v) => !v)}>
                {showLogs ? '▼ CLIログを隠す' : `▶ CLI出力ログ (${loginFlow!.outputLines.length}行)`}
              </button>
              {showLogs && (
                <pre className="cli-log-box">{loginFlow!.outputLines.join('\n')}</pre>
              )}
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmitApiKey} className="stack-gap">
          <label className="field">
            <span>アカウント識別メモ（任意）</span>
            <input
              type="text"
              value={accountLabel}
              onChange={(e) => setAccountLabel(e.target.value)}
              placeholder="例: Gemini API Key (個人)"
            />
          </label>
          <label className="field">
            <span>GEMINI_API_KEY</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIza..."
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !apiKey.trim()}>
            {busy ? '接続検証中...' : 'APIキーで認証'}
          </button>
        </form>
      )}

      {(error || (tab === 'oauth' && profile?.lastError)) && (
        <div className="error-box" role="alert">
          {error || profile?.lastError}
        </div>
      )}
    </div>
  );

  if (isModal) return content;

  return <div className="auth-shell">{content}</div>;
};
