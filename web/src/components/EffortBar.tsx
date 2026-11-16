import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AcpSelectOption } from '../types';
import { CheckIcon, ChevronIcon, EffortDialIcon } from './Icons';

interface EffortBarProps {
  options: AcpSelectOption[];
  value: string;
  modelOptions?: AcpSelectOption[];
  selectedModelId?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onChangeModel?: (modelId: string) => void;
}

const EFFORT_LABELS_JA: Record<string, string> = {
  none: 'オフ',
  off: 'オフ',
  minimal: '最小',
  min: '最小',
  low: '低',
  medium: '中',
  med: '中',
  high: '高',
  max: '最大',
  maximum: '最大',
  xhigh: '最高',
};

export function formatEffortLabel(opt: AcpSelectOption | undefined, fallbackValue: string): string {
  if (!opt) {
    return EFFORT_LABELS_JA[fallbackValue.toLowerCase()] ?? fallbackValue;
  }
  const byValue = EFFORT_LABELS_JA[opt.value.trim().toLowerCase()];
  if (byValue) return byValue;
  const byName = EFFORT_LABELS_JA[opt.name.trim().toLowerCase()];
  if (byName) return byName;
  return opt.name;
}

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth > 860 : true
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 861px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isDesktop;
}

export const EffortBar: React.FC<EffortBarProps> = React.memo(({
  options,
  value,
  modelOptions = [],
  selectedModelId = '',
  disabled = false,
  onChange,
  onChangeModel,
}) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'model'>('effort');
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [pcAnchorStyle, setPcAnchorStyle] = useState<React.CSSProperties>({});

  const isDesktop = useIsDesktop();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const isThumbDragRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragHasMovedRef = useRef(false);

  const safeOptions = options ?? [];
  const safeModelOptions = modelOptions ?? [];
  const canSwitchModel = safeModelOptions.length > 0 && Boolean(onChangeModel);

  // Clear optimistic pendingValue once prop `value` catches up
  useEffect(() => {
    if (pendingValue !== null && value === pendingValue) {
      setPendingValue(null);
    }
  }, [value, pendingValue]);

  const effectiveValue = pendingValue ?? value;
  const foundIndex = safeOptions.findIndex((o) => o.value === effectiveValue);
  const committedIndex = foundIndex >= 0 ? foundIndex : 0;
  const maxIndex = Math.max(1, safeOptions.length - 1);

  const previewIndex =
    dragRatio !== null && safeOptions.length > 1
      ? Math.max(0, Math.min(safeOptions.length - 1, Math.round(dragRatio * maxIndex)))
      : committedIndex;

  const previewOption = safeOptions[previewIndex] ?? safeOptions[0];
  const previewLabel = formatEffortLabel(previewOption, previewOption?.value ?? effectiveValue);
  const committedLabel = formatEffortLabel(safeOptions[committedIndex], effectiveValue);

  const ratio =
    dragRatio !== null
      ? dragRatio
      : safeOptions.length <= 1
        ? 1
        : committedIndex / maxIndex;

  const iconRatio = (() => {
    if (safeOptions.length > 1) return ratio;
    const singleVal = safeOptions[0]?.value.trim().toLowerCase() ?? '';
    if (singleVal === 'none' || singleVal === 'off' || singleVal === 'minimal' || singleVal === 'min' || singleVal === 'low') {
      return 0;
    }
    if (singleVal === 'medium' || singleVal === 'med') return 0.5;
    if (singleVal === 'high' || singleVal === 'max' || singleVal === 'maximum' || singleVal === 'xhigh') {
      return 1;
    }
    return 0.5;
  })();

  const updatePcPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    const right = Math.max(12, window.innerWidth - rect.right);
    const bottom = Math.max(12, window.innerHeight - rect.top + 10);
    setPcAnchorStyle({
      right: `${Math.round(right)}px`,
      bottom: `${Math.round(bottom)}px`,
    });
  }, []);

  useLayoutEffect(() => {
    if (open && isDesktop) {
      updatePcPosition();
    }
  }, [open, isDesktop, view, updatePcPosition]);

  useEffect(() => {
    if (!open) {
      setDragRatio(null);
      setView('effort');
      activePointerIdRef.current = null;
      isThumbDragRef.current = false;
      dragHasMovedRef.current = false;
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (view === 'model') {
          setView('effort');
        } else {
          setOpen(false);
        }
      } else if (e.key === 'Enter' && view === 'effort') {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onResize = () => {
      if (isDesktop) updatePcPosition();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open, view, isDesktop, updatePcPosition]);

  if (safeOptions.length === 0) return null;

  const getThumbPad = (): number => {
    const thumbEl = thumbRef.current;
    if (thumbEl) {
      const thumbW = thumbEl.getBoundingClientRect().width;
      if (thumbW > 0) return thumbW / 2 + 3;
    }
    return isDesktop ? 21 : 25;
  };

  const computeRatioFromClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || safeOptions.length <= 1) return 1;
    const rect = el.getBoundingClientRect();
    const thumbPad = getThumbPad();
    const usable = Math.max(1, rect.width - thumbPad * 2);
    const raw = (clientX - (rect.left + thumbPad)) / usable;
    return Math.max(0, Math.min(1, raw));
  };

  const isHitOnThumb = (clientX: number, clientY: number): boolean => {
    const thumbEl = thumbRef.current;
    if (!thumbEl) return false;
    const rect = thumbEl.getBoundingClientRect();
    // Generous hit margin around the circular thumb (6px)
    const pad = 6;
    return (
      clientX >= rect.left - pad &&
      clientX <= rect.right + pad &&
      clientY >= rect.top - pad &&
      clientY <= rect.bottom + pad
    );
  };

  const commitIndex = (idx: number) => {
    if (safeOptions.length <= 1) return;
    const clamped = Math.max(0, Math.min(safeOptions.length - 1, idx));
    const target = safeOptions[clamped];
    if (target && target.value !== effectiveValue) {
      setPendingValue(target.value);
      onChange(target.value);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || safeOptions.length <= 1) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();

    activePointerIdRef.current = e.pointerId;
    dragStartXRef.current = e.clientX;
    dragHasMovedRef.current = false;

    const hitThumb = isHitOnThumb(e.clientX, e.clientY);
    isThumbDragRef.current = hitThumb;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    // IMPORTANT: Do NOT set dragRatio on pointerDown!
    // Only follow pointer movement if the circular thumb was pressed and dragged.
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    if (!isThumbDragRef.current) return;

    if (!dragHasMovedRef.current && Math.abs(e.clientX - dragStartXRef.current) < 3) {
      return;
    }
    dragHasMovedRef.current = true;
    const nextRatio = computeRatioFromClientX(e.clientX);
    setDragRatio(nextRatio);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore if already released
    }

    const wasThumbDrag = isThumbDragRef.current && dragHasMovedRef.current;
    isThumbDragRef.current = false;
    dragHasMovedRef.current = false;

    if (wasThumbDrag) {
      const finalRatio = computeRatioFromClientX(e.clientX);
      const nearestIdx = Math.round(finalRatio * maxIndex);
      // Update pendingValue BEFORE clearing dragRatio so CSS animates smoothly
      // from finalRatio directly to nearestIdx without snapping back to old value
      commitIndex(nearestIdx);
      setDragRatio(null);
    } else {
      // Track slot click (or stationary thumb tap): animate smoothly to clicked level
      const clickRatio = computeRatioFromClientX(e.clientX);
      const targetIdx = Math.round(clickRatio * maxIndex);
      setDragRatio(null);
      commitIndex(targetIdx);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    isThumbDragRef.current = false;
    dragHasMovedRef.current = false;
    setDragRatio(null);
  };

  const thumbDiameter = isDesktop ? 36 : 44;
  const trackEndDiameter = thumbDiameter + 6; // 3px inset on each side

  const renderSlider = () => (
    <div className={`effort-pill-shell ${isDesktop ? 'is-compact' : ''}`}>
      <div
        ref={trackRef}
        className={`effort-pill-track ${dragRatio !== null ? 'is-dragging' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <div
          className="effort-pill-fill"
          style={{
            width: `calc(${trackEndDiameter}px + ${ratio} * (100% - ${trackEndDiameter}px))`,
          }}
        />

        <div className="effort-pill-dots" aria-hidden="true">
          {safeOptions.map((opt, idx) => {
            const dotRatio = safeOptions.length <= 1 ? 1 : idx / maxIndex;
            const isCovered = dotRatio <= ratio + 0.001;
            return (
              <span
                key={opt.value}
                className={`effort-pill-dot ${isCovered ? 'covered' : ''}`}
                style={{
                  left: `calc(${trackEndDiameter / 2}px + ${dotRatio} * (100% - ${trackEndDiameter}px))`,
                }}
              />
            );
          })}
        </div>

        <div
          ref={thumbRef}
          className="effort-pill-thumb"
          aria-hidden="true"
          style={{
            left: `calc(3px + ${ratio} * (100% - ${trackEndDiameter}px))`,
          }}
        />

        <input
          type="range"
          className="effort-pill-sr-range"
          aria-label="推論レベル (Effort)"
          aria-valuetext={previewLabel}
          min={0}
          max={Math.max(0, safeOptions.length - 1)}
          step={1}
          value={previewIndex}
          disabled={disabled || safeOptions.length <= 1}
          onChange={(e) => {
            const nextIdx = Number.parseInt(e.target.value, 10);
            commitIndex(nextIdx);
          }}
        />
      </div>
    </div>
  );

  const renderModelList = () => (
    <div className="effort-model-list" role="listbox" aria-label="モデルを選択">
      {safeModelOptions.map((opt) => {
        const isSelected = opt.value === selectedModelId;
        return (
          <button
            key={opt.value}
            type="button"
            role="option"
            aria-selected={isSelected}
            className={`effort-model-item ${isSelected ? 'selected' : ''}`}
            onClick={() => {
              if (opt.value !== selectedModelId) {
                onChangeModel?.(opt.value);
              }
              setOpen(false);
            }}
          >
            <span className="effort-model-name truncate">{opt.name}</span>
            <span className="effort-model-check" aria-hidden="true">
              {isSelected ? <CheckIcon size={15} /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );

  const overlayNode =
    open && typeof document !== 'undefined'
      ? createPortal(
          isDesktop ? (
            <div
              className="effort-pc-backdrop"
              role="presentation"
              onClick={() => setOpen(false)}
            >
              <div
                className="effort-pc-popover"
                style={pcAnchorStyle}
                role="dialog"
                aria-modal="true"
                aria-label={view === 'model' ? 'モデル選択' : '推論レベル (Effort)'}
                onClick={(e) => e.stopPropagation()}
              >
                {view === 'effort' ? (
                  <div className="effort-pc-content">
                    <button
                      type="button"
                      className={`effort-level-switch-btn ${canSwitchModel ? 'clickable' : ''}`}
                      onClick={() => {
                        if (canSwitchModel) setView('model');
                      }}
                      disabled={!canSwitchModel}
                      title={canSwitchModel ? 'クリックしてモデルを切替' : undefined}
                    >
                      <span className="effort-dial-fixed">
                        <EffortDialIcon size={17} ratio={iconRatio} animated={dragRatio === null} />
                      </span>
                      <span className="effort-level-text">{previewLabel}</span>
                      {canSwitchModel && <ChevronIcon size={13} dir="right" className="effort-level-chevron" />}
                    </button>
                    {renderSlider()}
                  </div>
                ) : (
                  <div className="effort-pc-model-content">
                    {renderModelList()}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              className="effort-overlay-backdrop"
              role="presentation"
              onClick={(e) => {
                if (e.target === e.currentTarget) setOpen(false);
              }}
            >
              <div
                className="effort-overlay-stage"
                role="dialog"
                aria-modal="true"
                aria-label={view === 'model' ? 'モデル選択' : '推論レベル (Effort)'}
                onClick={(e) => e.stopPropagation()}
              >
                {view === 'effort' ? (
                  <>
                    <button
                      type="button"
                      className={`effort-overlay-label-row effort-level-switch-btn ${canSwitchModel ? 'clickable' : ''}`}
                      onClick={() => {
                        if (canSwitchModel) setView('model');
                      }}
                      disabled={!canSwitchModel}
                    >
                      <span className="effort-dial-fixed">
                        <EffortDialIcon size={21} ratio={iconRatio} animated={dragRatio === null} />
                      </span>
                      <span className="effort-overlay-label">{previewLabel}</span>
                      {canSwitchModel && <ChevronIcon size={15} dir="right" className="effort-level-chevron" />}
                    </button>

                    {renderSlider()}

                    {previewOption?.description && (
                      <div className="effort-overlay-desc">{previewOption.description}</div>
                    )}
                  </>
                ) : (
                  <div className="effort-mobile-model-card">
                    <div className="effort-mobile-model-head">
                      <button
                        type="button"
                        className="effort-mobile-back-btn"
                        onClick={() => setView('effort')}
                      >
                        <ChevronIcon size={14} dir="left" />
                        <span>思考量 ({previewLabel})</span>
                      </button>
                    </div>
                    {renderModelList()}
                  </div>
                )}
              </div>
            </div>
          ),
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`effort-trigger-btn ${open ? 'active' : ''}`}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`推論レベル: ${committedLabel}`}
      >
        <span className="effort-dial-fixed">
          <EffortDialIcon size={17} ratio={iconRatio} animated={dragRatio === null} />
        </span>
        <span className="effort-trigger-label">{committedLabel}</span>
      </button>

      {overlayNode}
    </>
  );
});
