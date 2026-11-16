import React, { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { AgyLoginFlowState, AgyProfile, UserPreferences, WebUser } from '../types';
import { ShieldIcon } from './Icons';

interface AuthScreenProps {
  userCount: number;
  allowPublicSignup: boolean;
  agyMode: 'real' | 'mock';
  onAuthenticated: (payload: {
    user: WebUser;
    agyProfile: AgyProfile;
    preferences: UserPreferences;
    loginFlow: AgyLoginFlowState;
  }) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  userCount,
  allowPublicSignup,
  agyMode,
  onAuthenticated,
}) => {
  const isInitialSetup = userCount === 0;
  const [mode, setMode] = useState<'login' | 'register'>(isInitialSetup ? 'register' : 'login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === 'register'
          ? await api.register({
              username: username.trim(),
              displayName: displayName.trim() || undefined,
              password,
            })
          : await api.login({ username: username.trim(), password });
      onAuthenticated(res);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('通信エラーが発生しました。');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <div>
            <h1>Antigravity Chat</h1>
            <p className="muted-sm">Self-Hosted AI Workspace</p>
          </div>
        </div>

        <div className="info-banner">
          <ShieldIcon size={16} />
          <div>
            {isInitialSetup ? (
              <span>
                最初のサーバー管理者アカウントを作成します。ログイン後、あなた専用の Antigravity アカウントを紐付けます。
              </span>
            ) : (
              <span>
                Webアカウントごとに独立した Antigravity 認証領域とワークスペースがサーバー上に作成されます。
              </span>
            )}
          </div>
        </div>

        {!isInitialSetup && allowPublicSignup && (
          <div className="segmented-tabs">
            <button
              type="button"
              className={mode === 'login' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => {
                setMode('login');
                setError(null);
              }}
            >
              ログイン
            </button>
            <button
              type="button"
              className={mode === 'register' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => {
                setMode('register');
                setError(null);
              }}
            >
              新規アカウント登録
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="stack-form">
          <label className="field">
            <span>ユーザー名（英数字・記号 _ . -）</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="例: tomo"
              autoComplete="username"
              autoCapitalize="none"
              required
              minLength={2}
            />
          </label>

          {mode === 'register' && (
            <label className="field">
              <span>表示名（任意）</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="例: Tomo"
                autoComplete="name"
              />
            </label>
          )}

          <label className="field">
            <span>パスワード{mode === 'register' ? '（6文字以上）' : ''}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'register' ? 6 : 1}
            />
          </label>

          {error && <div className="error-box">{error}</div>}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy
              ? '処理中...'
              : isInitialSetup
                ? '管理者アカウントを作成して次へ'
                : mode === 'register'
                  ? 'アカウントを作成して次へ'
                  : 'ログイン'}
          </button>
        </form>

        <div className="auth-footnote">
          <span>バックエンドモード: {agyMode === 'mock' ? 'ACP Mock' : 'Official Antigravity CLI'}</span>
        </div>
      </div>
    </div>
  );
};
