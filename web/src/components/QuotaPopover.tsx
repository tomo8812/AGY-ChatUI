import React from 'react';
import type { AgyProfile, QuotaSnapshotRecord } from '../types';
import { CloseIcon, RefreshIcon } from './Icons';

interface QuotaPopoverProps {
  profile: AgyProfile | null;
  quota: QuotaSnapshotRecord | null;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

export const QuotaPopover: React.FC<QuotaPopoverProps> = ({
  profile,
  quota,
  refreshing,
  onRefresh,
  onClose,
}) => {
  const formatReset = (iso: string | null) => {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      return d.toLocaleString('ja-JP', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="popover-panel" role="dialog" aria-label="利用枠とアカウント状態">
      <div className="popover-head">
        <div>
          <div className="popover-title">Antigravity 利用枠</div>
          <div className="muted-xs">
            紐付け中: {profile?.accountLabel || 'Google Antigravity'} ({profile?.authMethod || '未設定'})
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
          <div className="quota-list">
            {quota.buckets.map((b) => {
              const pct = b.remainingPercent;
              return (
                <div key={b.model} className="quota-item">
                  <div className="quota-item-head">
                    <span className="quota-model">{b.model}</span>
                    <span className={b.status === 'limited' ? 'quota-pct danger' : 'quota-pct'}>
                      残 {b.remainingLabel}
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
                  {b.resetAt && (
                    <div className="muted-xs">リセット目安: {formatReset(b.resetAt)}</div>
                  )}
                </div>
              );
            })}
            {quota.buckets.length === 0 && quota.rawSummary && (
              <pre className="quota-raw-summary">{quota.rawSummary}</pre>
            )}
          </div>
        )}
        {quota && quota.fetchedAt > 0 && (
          <div className="muted-xs popover-foot">
            最終更新: {new Date(quota.fetchedAt).toLocaleTimeString('ja-JP')}
          </div>
        )}
      </div>
    </div>
  );
};
