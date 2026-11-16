import React, { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { AgyLoginFlowState, AgyProfile, UserPreferences, WebUser } from '../types';
import {
  ensurePushSubscribed,
  getActivePushSubscription,
  isAppleMobileBrowser,
  isNotificationSupported,
  isPushSupported,
  isStandalonePwa,
  showBrowserNotification,
  unsubscribePushOnDevice,
} from '../utils/notifications';
import { AgyOnboarding } from './AgyOnboarding';
import { CloseIcon } from './Icons';
import { ToggleSwitch } from './ToggleSwitch';

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
  const [notifBusy, setNotifBusy] = useState(false);
  const [deviceSubscribed, setDeviceSubscribed] = useState<boolean>(false);
  const [subCount, setSubCount] = useState<number>(0);
  const [notifStatusMsg, setNotifStatusMsg] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [adminMsg, setAdminMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getActivePushSubscription().catch(() => null),
      api.getNotificationConfig().catch(() => null),
    ]).then(([sub, cfg]) => {
      if (!active) return;
      setDeviceSubscribed(Boolean(sub));
      if (cfg) setSubCount(cfg.subscriptionCount);
    });
    return () => {
      active = false;
    };
  }, []);

  const handlePrefChange = async (
    patch: Partial<Pick<UserPreferences, 'theme' | 'autoApproveSafeReads' | 'notifyOnResponse'>>
  ) => {
    setError(null);
    try {
      const res = await api.updatePreferences(patch);
      onUpdatePreferences(res.preferences);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '設定更新に失敗しました。');
    }
  };

  const handleToggleNotification = async (next: boolean) => {
    setError(null);
    setNotifStatusMsg(null);

    if (!next) {
      setNotifBusy(true);
      try {
        const res = await api.updatePreferences({ notifyOnResponse: false });
        onUpdatePreferences(res.preferences);
        await unsubscribePushOnDevice();
        setDeviceSubscribed(false);
        const cfg = await api.getNotificationConfig().catch(() => null);
        if (cfg) setSubCount(cfg.subscriptionCount);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '通知設定の更新に失敗しました。');
      } finally {
        setNotifBusy(false);
      }
      return;
    }

    if (!isNotificationSupported()) {
      if (isAppleMobileBrowser() && !isStandalonePwa()) {
        setError(
          'iPhone/iPadで通知を受け取るには、Safariの共有ボタンから「ホーム画面に追加」し、ホーム画面のアイコンから開いた状態でオンにしてください。'
        );
      } else {
        setError(
          'この環境では通知APIが利用できません。HTTPS（Tailscale Serve）または localhost でアクセスしてください。'
        );
      }
      return;
    }

    if (Notification.permission === 'denied') {
      setError(
        'ブラウザ側で通知がブロックされています。ブラウザまたはOSのサイト設定から通知を「許可」に変更してください。'
      );
      return;
    }

    if (Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setError('通知が許可されなかったため、オンにできませんでした。');
        return;
      }
    }

    setNotifBusy(true);
    try {
      const res = await api.updatePreferences({ notifyOnResponse: true });
      onUpdatePreferences(res.preferences);

      const pushRes = await ensurePushSubscribed();
      setDeviceSubscribed(pushRes.subscribed);
      if (typeof pushRes.subscriptionCount === 'number') {
        setSubCount(pushRes.subscriptionCount);
      }
      if (pushRes.subscribed) {
        setNotifStatusMsg('通知を有効にしました（バックグラウンドでもWeb Pushを受信できます）。');
      } else {
        setNotifStatusMsg('通知を有効にしました（アプリ・ブラウザ開いている間の応答完了を通知します）。');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '通知設定の更新に失敗しました。');
    } finally {
      setNotifBusy(false);
    }
  };

  const handleEnablePushOnThisDevice = async () => {
    setError(null);
    setNotifStatusMsg(null);
    if (!isNotificationSupported()) {
      if (isAppleMobileBrowser() && !isStandalonePwa()) {
        setError('iPhone/iPadでは「ホーム画面に追加」したPWAから有効化してください。');
      } else {
        setError('このブラウザでは通知がサポートされていません。');
      }
      return;
    }
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setError('通知が許可されませんでした。');
        return;
      }
    } else if (Notification.permission === 'denied') {
      setError('ブラウザ側で通知がブロックされています。サイト設定から許可してください。');
      return;
    }

    setNotifBusy(true);
    try {
      const pushRes = await ensurePushSubscribed();
      setDeviceSubscribed(pushRes.subscribed);
      if (typeof pushRes.subscriptionCount === 'number') {
        setSubCount(pushRes.subscriptionCount);
      }
      setNotifStatusMsg(
        pushRes.subscribed
          ? 'この端末をWeb Push通知に登録しました。'
          : 'この端末での通知を有効にしました。'
      );
    } finally {
      setNotifBusy(false);
    }
  };

  const handleTestNotification = async () => {
    setError(null);
    setNotifStatusMsg(null);
    setNotifBusy(true);
    try {
      if (isNotificationSupported() && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      if (isNotificationSupported() && Notification.permission === 'granted' && isPushSupported() && !deviceSubscribed) {
        const pushRes = await ensurePushSubscribed();
        setDeviceSubscribed(pushRes.subscribed);
        if (typeof pushRes.subscriptionCount === 'number') setSubCount(pushRes.subscriptionCount);
      }

      const res = await api.sendTestPush();
      if (res.sent > 0) {
        setNotifStatusMsg(`テスト通知を送信しました（配信先 ${res.sent}台）。`);
      } else if (isNotificationSupported() && Notification.permission === 'granted') {
        const shown = await showBrowserNotification({
          title: 'Antigravity Chat',
          body: 'テスト通知：応答が完了するとこのように通知が届きます。',
          tag: `test-${Date.now()}`,
        });
        if (shown) {
          setNotifStatusMsg('ローカルテスト通知を表示しました。');
        } else if (res.lastError) {
          setError(`テスト通知の送信に失敗しました: ${res.lastError}`);
        } else {
          setError('通知の配信先が見つかりませんでした。いったんオフにしてオンにし直してください。');
        }
      } else if (res.lastError) {
        setError(`テスト通知の送信に失敗しました: ${res.lastError}`);
      } else {
        setError('通知権限が許可されていません。');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'テスト通知の送信に失敗しました。');
    } finally {
      setNotifBusy(false);
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

  const needsDeviceActivation =
    preferences.notifyOnResponse &&
    (!isNotificationSupported() || Notification.permission !== 'granted' || (isPushSupported() && !deviceSubscribed));

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
            <h4>通知</h4>
            <ToggleSwitch
              checked={preferences.notifyOnResponse}
              disabled={notifBusy}
              label="応答が終了したら通知する"
              description="AIの回答生成が完了（またはエラー終了）したときにお知らせします。iPhoneは「ホーム画面に追加」でロック画面通知にも対応します。"
              onChange={(next) => void handleToggleNotification(next)}
            />

            {preferences.notifyOnResponse && (
              <div className="notif-meta-row">
                <span className="muted-xs">
                  {deviceSubscribed
                    ? `この端末はPush受信有効（登録端末: ${Math.max(1, subCount)}台）`
                    : isNotificationSupported() && Notification.permission === 'granted'
                      ? 'この端末のブラウザ通知が有効です'
                      : 'この端末での通知許可が未完了です'}
                </span>
                <div className="row-actions">
                  {needsDeviceActivation && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => void handleEnablePushOnThisDevice()}
                      disabled={notifBusy}
                    >
                      この端末で許可
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    onClick={() => void handleTestNotification()}
                    disabled={notifBusy}
                  >
                    テスト通知
                  </button>
                </div>
              </div>
            )}

            {notifStatusMsg && <div className="success-box">{notifStatusMsg}</div>}
          </section>

          <section className="settings-section">
            <h4>ツール実行の承認</h4>
            <ToggleSwitch
              checked={preferences.autoApproveSafeReads}
              label="ワークスペース内の読み取り専用ツールを自動許可"
              description="ファイル書き込み・削除・コマンド実行などの変更系操作は引き続き明示承認を求めます。"
              onChange={(next) => void handlePrefChange({ autoApproveSafeReads: next })}
            />
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
