import React, { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { AgyLoginFlowState, AgyProfile, UserPreferences, WebUser } from '../types';
import { AgyOnboarding } from './AgyOnboarding';
import { CloseIcon } from './Icons';

interface SettingsModalProps {
  user: WebUser;
  agyProfile: AgyProfile | null;
  loginFlow: AgyLoginFlowState | null;
  preferences: UserPreferences;
  agyMode: 'real' | 'mock';
  onClose: () => void;
  onUpdatePreferences: (prefs: UserPreferences) => void;
  onUpdateAgy: (payload: { profile: AgyProfile; loginFlow?: AgyLoginFlowState | null }) => void;
  onLogout: (allDevices: boolean) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  user,
  agyProfile,
  loginFlow,
  preferences,
  agyMode,
  onClose,
  onUpdatePreferences,
  onUpdateAgy,
  onLogout,
}) => {
  const [showReauth, setShowReauth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [adminMsg, setAdminMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePrefChange = async (
    patch: Partial<Pick<UserPreferences, 'theme' | 'autoApproveSafeReads'>>
  ) => {
    setError(null);
    try {
      const res = await api.updatePreferences(patch);
      onUpdatePreferences(res.preferences);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '設定更新に失敗しました。');
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('このWebアカウントに紐づく Antigravity 認証を解除しますか？（チャット履歴は保持されます）')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.disconnectAgy();
      onUpdateAgy({ profile: res.profile });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '解除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleAdminCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminMsg(null);
    setError(null);
    setBusy(true);
    try {
      const res = await api.register({ username: newUsername.trim(), password: newPassword });
      setAdminMsg(`ユーザー "${res.user.username}" を作成しました（初回ログイン時に各自のAntigravity認証が必要です）。`);
      setNewUsername('');
      setNewPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ユーザー作成に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  if (showReauth) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal-card modal-md" onClick={(e) => e.stopPropagation()}>
          <AgyOnboarding
            user={user}
            profile={agyProfile}
            loginFlow={loginFlow}
            agyMode={agyMode}
            isModal
            onClose={() => setShowReauth(false)}
            onUpdated={(payload) => onUpdateAgy(payload)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-md" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>設定</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="modal-body stack-gap">
          <section className="settings-section">
            <h4>Antigravity アカウント連携</h4>
            <div className="settings-kv">
              <div>
                <div className="kv-label">接続ステータス</div>
                <div className="kv-value">
                  <span
                    className={`status-dot ${agyProfile?.authStatus === 'authenticated' ? 'ok' : 'warn'}`}
                  />
                  <span>
                    {agyProfile?.authStatus === 'authenticated' ? '認証済み' : '未認証'}
                    {agyProfile?.accountLabel ? ` — ${agyProfile.accountLabel}` : ''}
                  </span>
                </div>
                {agyProfile?.authMethod && (
                  <div className="muted-xs">方式: {agyProfile.authMethod}</div>
                )}
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowReauth(true)}
                  disabled={busy}
                >
                  アカウント切替 / 再認証
                </button>
                <button
                  type="button"
                  className="btn btn-danger-outline btn-sm"
                  onClick={handleDisconnect}
                  disabled={busy}
                >
                  連携解除
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h4>外観テーマ</h4>
            <div className="segmented-tabs">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={preferences.theme === t ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => handlePrefChange({ theme: t })}
                >
                  {t === 'system' ? 'システム' : t === 'light' ? 'ライト' : 'ダーク'}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h4>ツール実行の承認</h4>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={preferences.autoApproveSafeReads}
                onChange={(e) => handlePrefChange({ autoApproveSafeReads: e.target.checked })}
              />
              <div>
                <div>ワークスペース内の読み取り専用ツールを自動許可</div>
                <div className="muted-xs">
                  ファイル書き込み・削除・コマンド実行などの変更系操作は引き続き明示承認を求めます。
                </div>
              </div>
            </label>
          </section>

          {user.role === 'admin' && (
            <section className="settings-section">
              <h4>ユーザー追加（管理者機能）</h4>
              <form onSubmit={handleAdminCreateUser} className="inline-admin-form">
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="新規ユーザー名"
                  minLength={2}
                  required
                />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="パスワード (6文字+)"
                  minLength={6}
                  required
                />
                <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>
                  追加
                </button>
              </form>
              {adminMsg && <div className="success-box">{adminMsg}</div>}
            </section>
          )}

          <section className="settings-section">
            <h4>Web セッション ({user.username})</h4>
            <div className="row-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onLogout(false)}>
                ログアウト
              </button>
              <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => onLogout(true)}>
                全端末からログアウト
              </button>
            </div>
          </section>

          {error && <div className="error-box">{error}</div>}
        </div>
      </div>
    </div>
  );
};
