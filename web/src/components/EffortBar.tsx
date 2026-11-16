import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AcpSelectOption } from '../types';
import { CheckIcon, ChevronIcon } from './Icons';

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
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
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
  const hasEffortOptions = safeOptions.length > 0;

  useEffect(() => {
    if (pendingValue !== null && value === pendingValue) {
      setPendingValue(null);
    }
  }, [value, pendingValue]);

  useEffect(() => {
    if (pendingModelId !== null && selectedModelId === pendingModelId) {
      setPendingModelId(null);
    }
  }, [selectedModelId, pendingModelId]);

  // If options changed after a model switch and pendingValue is no longer valid, clear it
  useEffect(() => {
    if (pendingValue !== null && safeOptions.length > 0 && !safeOptions.some((o) => o.value === pendingValue)) {
      setPendingValue(null);
    }
  }, [safeOptions, pendingValue]);

  const effectiveModelId = pendingModelId ?? selectedModelId;
  const selectedModelOpt =
    safeModelOptions.find((o) => o.value === effectiveModelId) ?? safeModelOptions[0];
  const modelDisplayName = selectedModelOpt?.name ?? effectiveModelId;

  const effectiveValue = pendingValue ?? value;
  const foundIndex = safeOptions.findIndex((o) => o.value === effectiveValue);
  const committedIndex = foundIndex >= 0 ? foundIndex : 0;
  const maxIndex = Math.max(1, safeOptions.length - 1);

  const previewIndex =
    dragRatio !== null && safeOptions.length > 1
      ? Math.max(0, Math.min(safeOptions.length - 1, Math.round(dragRatio * maxIndex)))
      : committedIndex;

  const previewOption = safeOptions[previewIndex] ?? safeOptions[0];
  const previewLabel = hasEffortOptions
    ? formatEffortLabel(previewOption, previewOption?.value ?? effectiveValue)
    : '';
  const committedLabel = hasEffortOptions
    ? formatEffortLabel(safeOptions[committedIndex], effectiveValue)
    : '';

  const triggerText = [modelDisplayName, committedLabel].filter(Boolean).join(' ');
  const headerText = [modelDisplayName, previewLabel].filter(Boolean).join(' ');

  const ratio =
    dragRatio !== null
      ? dragRatio
      : safeOptions.length <= 1
        ? 1
        : committedIndex / maxIndex;

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
      setView(hasEffortOptions ? 'effort' : 'model');
      activePointerIdRef.current = null;
      isThumbDragRef.current = false;
      dragHasMovedRef.current = false;
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (view === 'model' && hasEffortOptions) {
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
  }, [open, view, hasEffortOptions, isDesktop, updatePcPosition]);

  if (!hasEffortOptions && safeModelOptions.length === 0) return null;

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
    isThumbDragRef.current = isHitOnThumb(e.clientX, e.clientY);

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
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
      commitIndex(nearestIdx);
      setDragRatio(null);
    } else {
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
  const trackEndDiameter = thumbDiameter + 6;

  const renderSlider = () => {
    if (!hasEffortOptions) return null;
    return (
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
  };

  const renderModelList = () => (
    <div className="effort-model-list" role="listbox" aria-label="モデルを選択">
      {safeModelOptions.map((opt) => {
        const isSelected = opt.value === effectiveModelId;
        return (
          <button
            key={opt.value}
            type="button"
            role="option"
            aria-selected={isSelected}
            className={`effort-model-item ${isSelected ? 'selected' : ''}`}
            onClick={() => {
              if (opt.value !== effectiveModelId) {
                setPendingModelId(opt.value);
                onChangeModel?.(opt.value);
              }
              setView('effort');
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

  const activeView = view === 'model' || !hasEffortOptions ? 'model' : 'effort';

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
                aria-label={activeView === 'model' ? 'モデル選択' : '推論レベル (Effort)'}
                onClick={(e) => e.stopPropagation()}
              >
                {activeView === 'effort' ? (
                  <div key="effort" className="effort-pc-content effort-view-anim">
                    <button
                      type="button"
                      className={`effort-level-switch-btn ${canSwitchModel ? 'clickable' : ''}`}
                      onClick={() => {
                        if (canSwitchModel) setView('model');
                      }}
                      disabled={!canSwitchModel}
                      title={canSwitchModel ? 'クリックしてモデルを切替' : undefined}
                    >
                      <span className="effort-level-text">{headerText}</span>
                      {canSwitchModel && <ChevronIcon size={13} dir="right" className="effort-level-chevron" />}
                    </button>
                    {renderSlider()}
                  </div>
                ) : (
                  <div key="model" className="effort-pc-model-content effort-view-anim">
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
                aria-label={activeView === 'model' ? 'モデル選択' : '推論レベル (Effort)'}
                onClick={(e) => e.stopPropagation()}
              >
                {activeView === 'effort' ? (
                  <div key="effort" className="effort-mobile-effort-view effort-view-anim">
                    <button
                      type="button"
                      className={`effort-overlay-label-row effort-level-switch-btn ${canSwitchModel ? 'clickable' : ''}`}
                      onClick={() => {
                        if (canSwitchModel) setView('model');
                      }}
                      disabled={!canSwitchModel}
                    >
                      <span className="effort-overlay-label">{headerText}</span>
                      {canSwitchModel && <ChevronIcon size={15} dir="right" className="effort-level-chevron" />}
                    </button>

                    {renderSlider()}

                    {previewOption?.description && (
                      <div className="effort-overlay-desc">{previewOption.description}</div>
                    )}
                  </div>
                ) : (
                  <div key="model" className="effort-mobile-model-card effort-view-anim">
                    {hasEffortOptions && (
                      <div className="effort-mobile-model-head">
                        <button
                          type="button"
                          className="effort-mobile-back-btn"
                          onClick={() => setView('effort')}
                        >
                          <ChevronIcon size={14} dir="left" />
                          <span>{headerText}</span>
                        </button>
                      </div>
                    )}
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
          if (!disabled) {
            setView(hasEffortOptions ? 'effort' : 'model');
            setOpen((v) => !v);
          }
        }}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={triggerText}
      >
        <span className="effort-trigger-label">{triggerText}</span>
        <ChevronIcon size={12} dir={open ? 'up' : 'down'} className="effort-level-chevron" />
      </button>

      {overlayNode}
    </>
  );
});
