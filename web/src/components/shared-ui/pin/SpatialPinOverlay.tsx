import React, { useEffect, useRef, useState } from 'react';

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface NormalizedArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpatialPinOverlayProps {
  /** Active spatial selection mode: single point ('pin') or rectangle ('region'). */
  mode: 'pin' | 'region';
  /** Accessible label describing the target surface (e.g. "ページ 1の範囲"). */
  ariaLabel: string;
  /** Optional external highlight area (normalized 0..1) for re-display / jump targets. */
  highlightedArea?: NormalizedArea | null;
  /** Called when the user completes a pin click/tap or rectangle drag/keyboard commit. */
  onCommit: (area: NormalizedArea) => void;
  /** Optional className appended to the overlay container. */
  className?: string;
  /** Optional reset key that clears local draft selection when page/slide/revision changes. */
  resetKey?: string | number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Shared spatial pin & rectangle region overlay (`pin` / `region`).
 *
 * Positions all geometry in normalized 0..1 percentage coordinates relative to
 * its parent stage so highlights and pointer/touch coordinates automatically
 * track zoom and pan in `UnifiedViewerZoomShell` and `PdfCanvasViewer`.
 *
 * Supports mouse pointer, touch drag, and keyboard navigation (Arrow keys,
 * Shift+Arrow for 5% steps, Enter/Space to set/commit, Escape to cancel).
 */
export const SpatialPinOverlay: React.FC<SpatialPinOverlayProps> = ({
  mode,
  ariaLabel,
  highlightedArea,
  onCommit,
  className = '',
  resetKey,
}) => {
  const startRef = useRef<NormalizedPoint | null>(null);
  const [selection, setSelection] = useState<{ start: NormalizedPoint; end: NormalizedPoint } | null>(null);

  useEffect(() => {
    startRef.current = null;
    setSelection(null);
  }, [mode, resetKey]);

  const toNormalized = (event: React.PointerEvent<HTMLElement>): NormalizedPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0.5, y: 0.5 };
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const commit = (from: NormalizedPoint, to: NormalizedPoint) => {
    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    const width = Math.abs(from.x - to.x);
    const height = Math.abs(from.y - to.y);
    if (mode === 'region' && (width < 0.002 || height < 0.002)) return;
    setSelection({ start: from, end: to });
    onCommit(mode === 'pin' ? { x: to.x, y: to.y, width: 0, height: 0 } : { x, y, width, height });
  };

  const activeBox: NormalizedArea | null = selection
    ? {
        x: Math.min(selection.start.x, selection.end.x),
        y: Math.min(selection.start.y, selection.end.y),
        width: Math.abs(selection.start.x - selection.end.x),
        height: Math.abs(selection.start.y - selection.end.y),
      }
    : highlightedArea ?? null;

  return (
    <div
      className={`shared-pin-overlay pdf-location-overlay ${mode === 'pin' ? 'is-pin' : 'is-region'} ${className}`.trim()}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      data-pin-overlay-mode={mode}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        const pt = toNormalized(event);
        startRef.current = pt;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic pointer events in tests may not have an active pointerId.
        }
        setSelection({ start: pt, end: pt });
      }}
      onPointerMove={(event) => {
        if (!startRef.current || mode !== 'region') return;
        event.stopPropagation();
        setSelection({ start: startRef.current, end: toNormalized(event) });
      }}
      onPointerUp={(event) => {
        if (!startRef.current) return;
        event.stopPropagation();
        const from = startRef.current;
        const to = toNormalized(event);
        startRef.current = null;
        if (mode === 'pin') commit(to, to);
        else commit(from, to);
      }}
      onPointerCancel={() => {
        startRef.current = null;
        setSelection(null);
      }}
      onKeyDown={(event) => {
        const current = selection?.end ?? { x: 0.5, y: 0.5 };
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          startRef.current = null;
          setSelection(null);
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          if (mode === 'pin') {
            commit(current, current);
          } else if (startRef.current) {
            commit(startRef.current, current);
            startRef.current = null;
          } else {
            startRef.current = current;
            setSelection({ start: current, end: current });
          }
          return;
        }
        const step = event.shiftKey ? 0.05 : 0.01;
        const delta: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const offset = delta[event.key];
        if (!offset) return;
        event.preventDefault();
        event.stopPropagation();
        const end = { x: clamp01(current.x + offset[0]), y: clamp01(current.y + offset[1]) };
        setSelection({ start: startRef.current ?? end, end });
      }}
    >
      {activeBox && (
        <span
          aria-hidden="true"
          className={`shared-pin-mark pdf-location-mark ${activeBox.width === 0 && activeBox.height === 0 ? 'is-point' : 'is-rect'}`}
          style={{
            left: `${activeBox.x * 100}%`,
            top: `${activeBox.y * 100}%`,
            width: `${activeBox.width * 100}%`,
            height: `${activeBox.height * 100}%`,
          }}
        />
      )}
    </div>
  );
};
