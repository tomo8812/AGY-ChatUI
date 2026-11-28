import React from 'react';

/**
 * Extracts a concise, user-facing reason only when a known, meaningful message
 * is present. Suppresses empty strings or internal stack-like noise (§2.5).
 */
export function formatConciseErrorReason(error: unknown): string | undefined {
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 240 || /\n\s*at\s+/.test(trimmed)) return undefined;
  return trimmed;
}

export interface TargetInspectionErrorBannerProps {
  /** Concise, accurate error reason (omitted or fallback when unknown). */
  message: string;
  /** Optional retry handler that keeps the existing preview intact. */
  onRetry?: () => void;
  /** Optional dismiss / re-select handler. */
  onDismiss?: () => void;
}

/**
 * Common error banner when target inspection fails while the viewer preview
 * itself remains usable (§2.5). Never treats incomplete target data as confirmed.
 */
export const TargetInspectionErrorBanner: React.FC<TargetInspectionErrorBannerProps> = ({
  message,
  onRetry,
  onDismiss,
}) => (
  <div className="error-box shared-pin-error" role="alert">
    <span>{formatConciseErrorReason(message) ?? '対象を識別できませんでした。対象を選び直すか再試行してください。'}</span>
    <span className="shared-pin-error-actions">
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-xs" onClick={onRetry}>
          再試行
        </button>
      )}
      {onDismiss && (
        <button type="button" className="btn btn-ghost btn-xs" onClick={onDismiss}>
          閉じる
        </button>
      )}
    </span>
  </div>
);

export interface PreviewUnavailableFallbackProps {
  /** File name shown for context. */
  filename: string;
  /** Direct download URL for the artifact. */
  downloadUrl: string;
  /** Known concise reason why preview/rendering failed (omit if unknown). */
  reason?: string | null;
  /** Optional retry handler. */
  onRetry?: () => void;
}

/**
 * Common preview-unavailable presentation with download action (§2.5).
 * Used uniformly across formats for corrupted, encrypted, unsupported, or
 * resource-exceeding files without inventing format-specific workarounds.
 */
export const PreviewUnavailableFallback: React.FC<PreviewUnavailableFallbackProps> = ({
  filename,
  downloadUrl,
  reason,
  onRetry,
}) => {
  const conciseReason = formatConciseErrorReason(reason);
  return (
    <div className="shared-preview-unavailable" role="alert">
      <p className="shared-preview-unavailable-title">プレビューを表示できません</p>
      {conciseReason && <p className="shared-preview-unavailable-reason">{conciseReason}</p>}
      <div className="shared-preview-unavailable-actions">
        <a className="btn btn-primary btn-sm" href={downloadUrl} download={filename}>
          ダウンロード
        </a>
        {onRetry && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
            再試行
          </button>
        )}
      </div>
    </div>
  );
};
