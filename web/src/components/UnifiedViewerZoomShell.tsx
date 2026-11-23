import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  clampZoomScale,
  VIEWER_DEFAULT_SCALE,
  VIEWER_MAX_SCALE,
  VIEWER_MIN_SCALE,
  VIEWER_ZOOM_STEP_FACTOR,
} from '../utils/contentZoom';
import { useUnifiedViewerZoom } from '../hooks/useUnifiedViewerZoom';

export interface UnifiedViewerZoomShellProps {
  resetKey: string;
  /** Optional extra class on the scroll container */
  scrollClassName?: string;
  /** Whether the child fills the viewport height (e.g. HTML sandbox iframe) */
  fillViewportHeight?: boolean;
  /** Optional left-side toolbar controls */
  toolbarLeft?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Unified zoom shell for all document, code, diff, table, markdown, docx, mermaid,
 * and HTML viewers. Uses the exact same 3-phase GPU-preview zoom engine as PDF/Image
 * viewers so every file format has identical gesture feel, focal-point anchoring,
 * pan support, and "画面に合わせる" reset.
 */
export const UnifiedViewerZoomShell: React.FC<UnifiedViewerZoomShellProps> = ({
  resetKey,
  scrollClassName,
  fillViewportHeight = false,
  toolbarLeft,
  children,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [scaleBadgeEl, setScaleBadgeEl] = useState<HTMLSpanElement | null>(null);

  const [scale, setScale] = useState<number>(VIEWER_DEFAULT_SCALE);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [contentSize, setContentSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const setScrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);

  const setStageContainerRef = useCallback((el: HTMLDivElement | null) => {
    stageRef.current = el;
    setStageEl(el);
  }, []);

  useEffect(() => {
    setScale(VIEWER_DEFAULT_SCALE);
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [resetKey]);

  // Observe scroll viewport dimensions
  useEffect(() => {
    if (!scrollEl) return;
    const measure = () => {
      const nextW = Math.max(0, Math.floor(scrollEl.clientWidth));
      const nextH = Math.max(0, Math.floor(scrollEl.clientHeight));
      setContainerSize((prev) =>
        prev.width === nextW && prev.height === nextH ? prev : { width: nextW, height: nextH }
      );
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(scrollEl);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [scrollEl]);

  // Observe unscaled inner content layout dimensions (offsetWidth/offsetHeight ignore CSS transform)
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const measure = () => {
      const nextW = Math.max(0, Math.ceil(inner.offsetWidth));
      const nextH = Math.max(0, Math.ceil(inner.offsetHeight));
      setContentSize((prev) =>
        prev.width === nextW && prev.height === nextH ? prev : { width: nextW, height: nextH }
      );
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(inner);
      return () => ro.disconnect();
    }
  }, [resetKey]);

  const handleCommitScale = useCallback((nextScale: number) => {
    setScale(clampZoomScale(nextScale, VIEWER_MIN_SCALE, VIEWER_MAX_SCALE));
  }, []);

  const isDefault = Math.abs(scale - VIEWER_DEFAULT_SCALE) < 0.005;
  const isZoomedIn = scale > VIEWER_DEFAULT_SCALE + 0.01;

  const { isPanning, commitDiscreteScale, cancelActiveGesture } = useUnifiedViewerZoom({
    scrollEl,
    stageEl,
    scaleBadgeEl,
    committedScale: scale,
    minScale: VIEWER_MIN_SCALE,
    maxScale: VIEWER_MAX_SCALE,
    enableDragPan: isZoomedIn,
    onCommitScale: handleCommitScale,
    resetKey,
  });

  const applyStepZoom = useCallback(
    (factor: number) => {
      commitDiscreteScale((cur) => clampZoomScale(cur * factor, VIEWER_MIN_SCALE, VIEWER_MAX_SCALE));
    },
    [commitDiscreteScale]
  );

  const handleResetFit = useCallback(() => {
    cancelActiveGesture();
    setScale(VIEWER_DEFAULT_SCALE);
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [cancelActiveGesture]);

  const baseW = contentSize.width > 0 ? contentSize.width : Math.max(0, containerSize.width);
  const baseH =
    contentSize.height > 0
      ? contentSize.height
      : fillViewportHeight
        ? Math.max(320, containerSize.height)
        : 0;

  const sizerStyle: React.CSSProperties =
    !isDefault && baseW > 0 && baseH > 0
      ? {
          width: `${Math.ceil(baseW * scale)}px`,
          height: `${Math.ceil(baseH * scale)}px`,
          minWidth: '100%',
          minHeight: fillViewportHeight ? '100%' : undefined,
        }
      : {
          width: '100%',
          minHeight: '100%',
          height: fillViewportHeight ? '100%' : undefined,
        };

  const innerStyle: React.CSSProperties = {
    width: !isDefault && containerSize.width > 0 ? `${containerSize.width}px` : '100%',
    height: fillViewportHeight ? (containerSize.height > 0 ? `${containerSize.height}px` : '100%') : undefined,
    minHeight: fillViewportHeight ? '100%' : undefined,
    transform: isDefault ? undefined : `scale(${scale})`,
    transformOrigin: '0 0',
  };

  return (
    <div className="viewer-zoom-wrap">
      <div className="viewer-toolbar pdf-viewer-toolbar viewer-zoom-toolbar">
        {toolbarLeft}
        <div className="pdf-toolbar-group pdf-zoom-group">
          <button
            type="button"
            className={`btn btn-secondary btn-xs ${isDefault ? 'active' : ''}`}
            onClick={handleResetFit}
            title="画面サイズに合わせて表示"
          >
            画面に合わせる
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-xs pdf-zoom-step-btn"
            aria-label="縮小"
            onClick={() => applyStepZoom(1 / VIEWER_ZOOM_STEP_FACTOR)}
          >
            −
          </button>
          <span ref={setScaleBadgeEl} className="muted-xs pdf-scale-indicator">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-xs pdf-zoom-step-btn"
            aria-label="拡大"
            onClick={() => applyStepZoom(VIEWER_ZOOM_STEP_FACTOR)}
          >
            ＋
          </button>
        </div>
      </div>
      <div
        ref={setScrollContainerRef}
        className={`viewer-zoom-scroll content-zoom-surface${scrollClassName ? ` ${scrollClassName}` : ''}${isZoomedIn ? ' is-pannable' : ''}${isPanning ? ' is-panning' : ''}`}
        data-viewer-zoom-surface="true"
        data-zoom-scale={Math.round(scale * 100)}
        data-fit-mode={isDefault ? 'auto' : 'manual'}
      >
        <div ref={setStageContainerRef} className="viewer-zoom-stage" style={sizerStyle}>
          <div ref={innerRef} className="viewer-zoom-content-inner" style={innerStyle}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};
