import React from 'react';
import type { AgyProfile, QuotaBucket, QuotaSnapshotRecord } from '../types';
import { CloseIcon, RefreshIcon } from './Icons';

interface QuotaPopoverProps {
  profile: AgyProfile | null;
  quota: QuotaSnapshotRecord | null;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

function inferGroup(b: QuotaBucket): string {
  if (b.group && b.group.trim()) return b.group.trim();
  const sep = b.model.indexOf(' · ');
  if (sep > 0) return b.model.slice(0, sep).trim();
  return b.model;
}

function formatWindowTitle(b: QuotaBucket, groupName: string): string {
  const raw = b.windowLabel?.trim() || b.model;
  const lower = raw.toLowerCase();
  if (/five\s*hour|5\s*h|5時間/.test(lower)) return '5時間枠';
  if (/weekly|週間/.test(lower)) return '週間枠';
  let cleaned = raw;
  if (cleaned.toLowerCase().startsWith(groupName.toLowerCase())) {
    cleaned = cleaned.slice(groupName.length).trim();
  }
  const sep = cleaned.indexOf(' · ');
  if (sep >= 0) cleaned = cleaned.slice(sep + 3).trim();
  return cleaned.replace(/\s*limit\s*remaining$/i, '').replace(/\s*remaining$/i, '').trim() || raw;
}

function windowSortRank(b: QuotaBucket): number {
  const raw = `${b.windowLabel ?? ''} ${b.model}`.toLowerCase();
  if (/five\s*hour|5\s*h|5時間/.test(raw)) return 0;
  if (/weekly|週間/.test(raw)) return 1;
  return 2;
}

function formatReset(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const dateStr = d.toLocaleString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const diffMs = d.getTime() - Date.now();
    if (diffMs <= 0) return `${dateStr}`;
    const totalHours = Math.floor(diffMs / 3_600_000);
    if (totalHours < 24) {
      const mins = Math.floor((diffMs % 3_600_000) / 60_000);
      return `${dateStr}（あと${totalHours}時間${mins}分）`;
    }
    const days = Math.floor(totalHours / 24);
    const remHours = totalHours % 24;
    return `${dateStr}（あと${days}日${remHours}時間）`;
  } catch {
    return iso;
  }
}

export const QuotaPopover: React.FC<QuotaPopoverProps> = ({
  profile,
  quota,
  refreshing,
  onRefresh,
  onClose,
}) => {
  const grouped = React.useMemo(() => {
    if (!quota || quota.buckets.length === 0) return [];
    const groups = new Map<string, QuotaBucket[]>();
    for (const b of quota.buckets) {
      const g = inferGroup(b);
      const list = groups.get(g) ?? [];
      list.push(b);
      groups.set(g, list);
    }
    return Array.from(groups.entries()).map(([name, items]) => ({
      name,
      items: [...items].sort((a, b) => windowSortRank(a) - windowSortRank(b)),
    }));
  }, [quota]);

  return (
    <div className="popover-panel" role="dialog" aria-label="利用枠とアカウント状態">
      <div className="popover-head">
        <div>
          <div className="popover-title">Antigravity 利用枠</div>
          <div className="muted-xs">
            {profile?.accountLabel || 'Google Antigravity'} ({profile?.authMethod || '未設定'})
          </div>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            onClick={onRefresh}
            disabled={refreshing}
            title="公式CLIで最新状態を取得"
          >
            <RefreshIcon size={13} className={refreshing ? 'spin' : ''} />
            <span>{refreshing ? '取得中' : '更新'}</span>
          </button>
          <button type="button" className="icon-btn-sm" onClick={onClose} aria-label="閉じる">
            <CloseIcon size={15} />
          </button>
        </div>
      </div>

      <div className="popover-body">
        {!quota || quota.status !== 'ok' ? (
          <div className="quota-unavailable">
            <div className="quota-status-tag">取得不可</div>
            <p className="muted-sm">
              {quota?.errorMessage || '「更新」を押すと公式CLI (`agy -p /usage`) から最新の利用枠を確認します。'}
            </p>
          </div>
        ) : (
          <div className="quota-groups">
            {grouped.map((grp) => (
              <div key={grp.name} className="quota-group-card">
                <div className="quota-group-title">{grp.name}</div>
                <div className="quota-group-bars">
                  {grp.items.map((b, idx) => {
                    const pct = b.remainingPercent;
                    const winTitle = formatWindowTitle(b, grp.name);
                    const resetStr = formatReset(b.resetAt);
                    return (
                      <div key={`${b.model}-${idx}`} className="quota-bar-row">
                        <div className="quota-item-head">
                          <span className="quota-window-label" title={b.windowLabel || b.model}>
                            {winTitle}
                          </span>
                          <span className={b.status === 'limited' ? 'quota-pct danger' : 'quota-pct'}>
                            {b.remainingLabel}
                          </span>
                        </div>
                        {pct !== null && (
                          <div className="quota-bar-track">
                            <div
                              className={`quota-bar-fill ${pct <= 15 ? 'low' : pct <= 40 ? 'mid' : 'high'}`}
                              style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                            />
                          </div>
                        )}
                        {resetStr && (
                          <div className="muted-xs quota-reset-line">リセット: {resetStr}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {grouped.length === 0 && quota.rawSummary && (
              <pre className="quota-raw-summary">{quota.rawSummary}</pre>
            )}
          </div>
        )}
        {quota && quota.fetchedAt > 0 && (
          <div className="muted-xs popover-foot">
            最終更新: {new Date(quota.fetchedAt).toLocaleTimeString('ja-JP')}（低頻度自動更新対応）
          </div>
        )}
      </div>
    </div>
  );
};
