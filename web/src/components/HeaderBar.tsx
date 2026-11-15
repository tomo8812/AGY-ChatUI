import React, { useState } from 'react';
import type { WsConnectionStatus } from '../api/ws';
import type {
  AgyProfile,
  ChatRecord,
  ParsedSessionOptions,
  QuotaSnapshotRecord,
} from '../types';
import { FolderIcon, GaugeIcon, MenuIcon } from './Icons';
import { QuotaPopover } from './QuotaPopover';

interface HeaderBarProps {
  activeChat: ChatRecord | null;
  sessionOptions: ParsedSessionOptions | null;
  agyProfile: AgyProfile | null;
  quota: QuotaSnapshotRecord | null;
  quotaRefreshing: boolean;
  wsStatus: WsConnectionStatus;
  contextUsage: { used: number; size: number } | null;
  workspaceCount: number;
  workspaceOpen: boolean;
  onOpenSidebar: () => void;
  onChangeModel: (modelId: string) => void;
  onChangeEffort: (effortValue: string) => void;
  onRefreshQuota: () => void;
  onToggleWorkspace: () => void;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({
  activeChat,
  sessionOptions,
  agyProfile,
  quota,
  quotaRefreshing,
  wsStatus,
  contextUsage,
  workspaceCount,
  workspaceOpen,
  onOpenSidebar,
  onChangeModel,
  onChangeEffort,
  onRefreshQuota,
  onToggleWorkspace,
}) => {
  const [quotaOpen, setQuotaOpen] = useState(false);

  const modelOption = sessionOptions?.configOptions.find(
    (c) => c.id === sessionOptions.modelOptionId
  );
  const effortOption = sessionOptions?.configOptions.find(
    (c) => c.id === sessionOptions.effortOptionId
  );

  const currentModelValue =
    activeChat?.modelId || modelOption?.currentValue || modelOption?.options[0]?.value || '';
  const currentEffortValue =
    activeChat?.effortValue || effortOption?.currentValue || effortOption?.options[0]?.value || '';

  const primaryBucket =
    quota?.status === 'ok' && quota.buckets.length > 0
      ? quota.buckets.find((b) => currentModelValue && b.model.includes(currentModelValue)) ?? quota.buckets[0]
      : null;

  const quotaPillText =
    quota?.status === 'ok'
      ? primaryBucket
        ? `残 ${primaryBucket.remainingLabel}`
        : '確認済'
      : '利用枠';

  return (
    <header className="header-bar">
      <div className="header-left">
        <button
          type="button"
          className="icon-btn mobile-only"
          onClick={onOpenSidebar}
          aria-label="メニューを開く"
        >
          <MenuIcon size={20} />
        </button>

        {activeChat && modelOption && modelOption.options.length > 0 ? (
          <div className="model-controls">
            <select
              aria-label="モデル選択"
              className="header-select"
              value={currentModelValue}
              onChange={(e) => onChangeModel(e.target.value)}
            >
              {modelOption.options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.name}
                </option>
              ))}
            </select>

            {effortOption && effortOption.options.length > 0 && (
              <select
                aria-label="推論レベル (Effort)"
                className="header-select effort-select"
                value={currentEffortValue}
                onChange={(e) => onChangeEffort(e.target.value)}
              >
                {effortOption.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : (
          <div className="header-title-fallback">
            {activeChat ? activeChat.title : 'Antigravity Chat'}
          </div>
        )}
      </div>

      <div className="header-right">
        {wsStatus !== 'connected' && (
          <span className="sync-badge warn" title="リアルタイム同期再接続中">
            {wsStatus === 'reconnecting' ? '同期再接続中...' : '接続中...'}
          </span>
        )}

        {contextUsage && contextUsage.size > 0 && (
          <span className="context-pill hide-xs" title="現在の会話コンテキスト使用量">
            {Math.round((contextUsage.used / contextUsage.size) * 100)}% ctx
          </span>
        )}

        <div className="quota-anchor">
          <button
            type="button"
            className={`pill-btn ${quotaOpen ? 'active' : ''}`}
            onClick={() => setQuotaOpen((o) => !o)}
            title="アカウント別の利用枠を確認"
          >
            <GaugeIcon size={14} />
            <span>{quotaPillText}</span>
          </button>

          {quotaOpen && (
            <QuotaPopover
              profile={agyProfile}
              quota={quota}
              refreshing={quotaRefreshing}
              onRefresh={onRefreshQuota}
              onClose={() => setQuotaOpen(false)}
            />
          )}
        </div>

        {activeChat && (
          <button
            type="button"
            className={`pill-btn ${workspaceOpen ? 'active' : ''}`}
            onClick={onToggleWorkspace}
            title="作業ディレクトリ・生成ファイルを表示"
          >
            <FolderIcon size={14} />
            <span className="hide-xs">ファイル</span>
            {workspaceCount > 0 && <span className="count-tag">{workspaceCount}</span>}
          </button>
        )}
      </div>
    </header>
  );
};
