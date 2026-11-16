import React, { useEffect, useRef, useState } from 'react';
import type { WsConnectionStatus } from '../api/ws';
import type {
  AgyProfile,
  ChatRecord,
  QuotaBucket,
  QuotaSnapshotRecord,
} from '../types';
import { ComposeIcon, FolderIcon, GaugeIcon, MenuIcon } from './Icons';
import { QuotaPopover } from './QuotaPopover';

interface HeaderBarProps {
  activeChat: ChatRecord | null;
  selectedModelId: string;
  agyProfile: AgyProfile | null;
  quota: QuotaSnapshotRecord | null;
  quotaRefreshing: boolean;
  wsStatus: WsConnectionStatus;
  contextUsage: { used: number; size: number } | null;
  workspaceCount: number;
  workspaceOpen: boolean;
  onOpenSidebar: () => void;
  onNewChat: () => void;
  onRefreshQuota: () => void;
  onOpenQuotaPopover?: () => void;
  onToggleWorkspace: () => void;
}

function pickSummaryBucket(quota: QuotaSnapshotRecord | null, modelId: string): QuotaBucket | null {
  if (!quota || quota.status !== 'ok' || quota.buckets.length === 0) return null;

  const lowerModel = modelId.toLowerCase();
  const candidates = quota.buckets.filter((b) => {
    const label = `${b.group ?? ''} ${b.model}`.toLowerCase();
    if (lowerModel.includes('argon')) return label.includes('argon');
    if (lowerModel.includes('claude') || lowerModel.includes('gpt') || lowerModel.includes('openai')) {
      return label.includes('claude') || label.includes('gpt');
    }
    if (lowerModel.includes('gemini')) {
      return label.includes('gemini') && !label.includes('argon');
    }
    return false;
  });

  const pool = candidates.length > 0 ? candidates : quota.buckets;
  return pool.reduce<QuotaBucket | null>((best, cur) => {
    if (!best) return cur;
    const bestPct = best.remainingPercent ?? 101;
    const curPct = cur.remainingPercent ?? 101;
    return curPct < bestPct ? cur : best;
  }, null);
}

export const HeaderBar: React.FC<HeaderBarProps> = React.memo(({
  activeChat,
  selectedModelId,
  agyProfile,
  quota,
  quotaRefreshing,
  wsStatus,
  contextUsage,
  workspaceCount,
  workspaceOpen,
  onOpenSidebar,
  onNewChat,
  onRefreshQuota,
  onOpenQuotaPopover,
  onToggleWorkspace,
}) => {
  const [quotaOpen, setQuotaOpen] = useState(false);
  const quotaAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!quotaOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (quotaAnchorRef.current && !quotaAnchorRef.current.contains(e.target as Node)) {
        setQuotaOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setQuotaOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [quotaOpen]);

  const primaryBucket = pickSummaryBucket(quota, selectedModelId);
  const primaryPct = primaryBucket?.remainingPercent ?? null;

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
          className="circle-icon-btn mobile-only"
          onClick={onOpenSidebar}
          aria-label="メニューを開く"
        >
          <MenuIcon size={18} />
        </button>

        <div className="header-title-fallback truncate hide-xs">
          {activeChat ? activeChat.title : 'Antigravity'}
        </div>
      </div>

      <div className="header-center">
        {wsStatus !== 'connected' && (
          <span className="sync-badge warn" title="リアルタイム同期再接続中">
            {wsStatus === 'reconnecting' ? '再接続中...' : '接続中...'}
          </span>
        )}

        <div className="quota-anchor" ref={quotaAnchorRef}>
          <button
            type="button"
            className={`pill-btn ${quotaOpen ? 'active' : ''}`}
            onClick={() => {
              setQuotaOpen((prev) => {
                const next = !prev;
                if (next) onOpenQuotaPopover?.();
                return next;
              });
            }}
            aria-expanded={quotaOpen}
            title="アカウント別の利用枠を確認"
          >
            <GaugeIcon size={14} />
            <span>{quotaPillText}</span>
            {primaryPct !== null && (
              <span className="pill-mini-bar" aria-hidden="true">
                <span
                  className={`pill-mini-fill ${primaryPct <= 15 ? 'low' : primaryPct <= 40 ? 'mid' : 'high'}`}
                  style={{ width: `${Math.max(0, Math.min(100, primaryPct))}%` }}
                />
              </span>
            )}
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
      </div>

      <div className="header-right">
        {contextUsage && contextUsage.size > 0 && (
          <span className="context-pill hide-xs" title="現在の会話コンテキスト使用量">
            {Math.round((contextUsage.used / contextUsage.size) * 100)}% ctx
          </span>
        )}

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

        <button
          type="button"
          className="circle-icon-btn"
          onClick={onNewChat}
          aria-label="新しいチャット"
          title="新しいチャットを開始"
        >
          <ComposeIcon size={17} />
        </button>
      </div>
    </header>
  );
});
