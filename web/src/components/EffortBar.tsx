import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AcpSelectOption } from '../types';
import { EffortDialIcon } from './Icons';

interface EffortBarProps {
  options: AcpSelectOption[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
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

export const EffortBar: React.FC<EffortBarProps> = ({
  options,
  value,
  disabled = false,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const suppressBackdropClickRef = useRef(false);

  const safeOptions = options ?? [];
  const foundIndex = safeOptions.findIndex((o) => o.value === value);
  const committedIndex = foundIndex >= 0 ? foundIndex : 0;
  const maxIndex = Math.max(1, safeOptions.length - 1);

  const previewIndex =
    dragRatio !== null && safeOptions.length > 1
      ? Math.max(0, Math.min(safeOptions.length - 1, Math.round(dragRatio * maxIndex)))
      : committedIndex;

  const previewOption = safeOptions[previewIndex] ?? safeOptions[0];
  const previewLabel = formatEffortLabel(previewOption, previewOption?.value ?? value);
  const committedLabel = formatEffortLabel(safeOptions[committedIndex], value);

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

  useEffect(() => {
    if (!open) {
      setDragRatio(null);
      activePointerIdRef.current = null;
      suppressBackdropClickRef.current = false;
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (safeOptions.length === 0) return null;

  const computeRatioFromClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || safeOptions.length <= 1) return 1;
    const rect = el.getBoundingClientRect();
    const thumbPad = 25; // half of 50px track end diameter (3px inset + 22px thumb radius)
    const usable = Math.max(1, rect.width - thumbPad * 2);
    const raw = (clientX - (rect.left + thumbPad)) / usable;
    return Math.max(0, Math.min(1, raw));
  };

  const commitRatio = (nextRatio: number) => {
    if (safeOptions.length <= 1) return;
    const idx = Math.max(0, Math.min(safeOptions.length - 1, Math.round(nextRatio * maxIndex)));
    const target = safeOptions[idx];
    if (target && target.value !== safeOptions[committedIndex]?.value) {
      onChange(target.value);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || safeOptions.length <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    suppressBackdropClickRef.current = true;
    activePointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    const nextRatio = computeRatioFromClientX(e.clientX);
    setDragRatio(nextRatio);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
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
    const finalRatio = computeRatioFromClientX(e.clientX);
    setDragRatio(null);
    commitRatio(finalRatio);
    window.setTimeout(() => {
      suppressBackdropClickRef.current = false;
    }, 0);
  };

  const overlayNode =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="effort-overlay-backdrop"
            role="presentation"
            onClick={(e) => {
              if (suppressBackdropClickRef.current) return;
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div
              className="effort-overlay-stage"
              role="dialog"
              aria-modal="true"
              aria-label="推論レベル (Effort)"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="effort-overlay-label-row">
                <EffortDialIcon size={21} ratio={iconRatio} animated={dragRatio === null} />
                <span className="effort-overlay-label">{previewLabel}</span>
              </div>

              <div className="effort-pill-shell">
                <div
                  ref={trackRef}
                  className={`effort-pill-track ${dragRatio !== null ? 'is-dragging' : ''}`}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                >
                  <div
                    className="effort-pill-fill"
                    style={{
                      width: `calc(50px + ${ratio} * (100% - 50px))`,
                    }}
                  />

                  <div className="effort-pill-dots" aria-hidden="true">
                    {options.map((opt, idx) => {
                      const dotRatio = options.length <= 1 ? 1 : idx / maxIndex;
                      const isCovered = dotRatio <= ratio + 0.001;
                      return (
                        <span
                          key={opt.value}
                          className={`effort-pill-dot ${isCovered ? 'covered' : ''}`}
                          style={{
                            left: `calc(25px + ${dotRatio} * (100% - 50px))`,
                          }}
                        />
                      );
                    })}
                  </div>

                  <div
                    className="effort-pill-thumb"
                    aria-hidden="true"
                    style={{
                      left: `calc(3px + ${ratio} * (100% - 50px))`,
                    }}
                  />

                  <input
                    type="range"
                    className="effort-pill-sr-range"
                    aria-label="推論レベル (Effort)"
                    aria-valuetext={previewLabel}
                    min={0}
                    max={Math.max(0, options.length - 1)}
                    step={1}
                    value={previewIndex}
                    disabled={disabled || options.length <= 1}
                    onChange={(e) => {
                      const nextIdx = Number.parseInt(e.target.value, 10);
                      const target = options[nextIdx];
                      if (target) onChange(target.value);
                    }}
                  />
                </div>
              </div>

              {previewOption?.description && (
                <div className="effort-overlay-desc">{previewOption.description}</div>
              )}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
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
        <EffortDialIcon size={17} ratio={iconRatio} animated={dragRatio === null} />
        <span className="effort-trigger-label">{committedLabel}</span>
      </button>

      {overlayNode}
    </>
  );
};
