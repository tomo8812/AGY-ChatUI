import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  clampZoomScale,
  computeStepZoomScale,
  VIEWER_DEFAULT_SCALE,
  VIEWER_MAX_SCALE,
  VIEWER_MIN_SCALE,
} from '../utils/contentZoom';
import { useUnifiedViewerZoom, type DragPanMode } from '../hooks/useUnifiedViewerZoom';

export interface UnifiedViewerZoomShellProps {
  resetKey: string;
  /** Optional extra class on the scroll container */
  scrollClassName?: string;
  /** Whether the child fills the viewport height (e.g. HTML sandbox iframe) */
  fillViewportHeight?: boolean;
  /** Optional left-side toolbar controls rendered inside the zoom toolbar (never zoomed) */
  toolbarLeft?: React.ReactNode;
  /** Optional app controls/banners rendered ABOVE the zoomable content surface (never zoomed) */
  controlsTop?: React.ReactNode;
  /** Optional app controls/pagination rendered BELOW the zoomable content surface (never zoomed) */
  controlsBottom?: React.ReactNode;
  /** Drag-pan interaction mode (default: 'modifier-or-surface' to preserve text selection) */
  dragPanMode?: DragPanMode;
  children: React.ReactNode;
}

interface IframeGestureBasis {
  left: number;
  top: number;
  scale: number;
}

/**
 * Unified zoom shell for all document, code, diff, table, markdown, docx, mermaid,
 * and HTML viewers. Keeps all viewer controls (toolbar, search, sheet tabs, pagination,
 * banners) strictly outside the zoomable content surface so only the file content scales.
 */
export const UnifiedViewerZoomShell: React.FC<UnifiedViewerZoomShellProps> = ({
  resetKey,
  scrollClassName,
  fillViewportHeight = false,
  toolbarLeft,
  controlsTop,
  controlsBottom,
  dragPanMode = 'modifier-or-surface',
  children,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const iframeGestureBasisRef = useRef<IframeGestureBasis | null>(null);

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [scaleBadgeEl, setScaleBadgeEl] = useState<HTMLSpanElement | null>(null);

  const [scale, setScale] = useState<number>(VIEWER_DEFAULT_SCALE);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

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
    iframeGestureBasisRef.current = null;
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
    iframeGestureBasisRef.current = null;
    setScale(clampZoomScale(nextScale, VIEWER_MIN_SCALE, VIEWER_MAX_SCALE));
  }, []);

  const handleGestureEnd = useCallback(() => {
    iframeGestureBasisRef.current = null;
  }, []);

  const isDefault = Math.abs(scale - VIEWER_DEFAULT_SCALE) < 0.005;
  const isZoomedIn = scale > VIEWER_DEFAULT_SCALE + 0.01;

  const {
    isPanning,
    isSpacePanReady,
    commitDiscreteScale,
    cancelActiveGesture,
    handleExternalWheel,
    handleExternalPinch,
  } = useUnifiedViewerZoom({
    scrollEl,
    stageEl,
    anchorEl: stageEl,
    scaleBadgeEl,
    committedScale: scale,
    minScale: VIEWER_MIN_SCALE,
    maxScale: VIEWER_MAX_SCALE,
    enableDragPan: isZoomedIn,
    dragPanMode,
    onCommitScale: handleCommitScale,
    onGestureEnd: handleGestureEnd,
    resetKey,
  });

  // Bridge zoom gestures from sandboxed HTML iframes (`sandbox="allow-scripts"`) into the same
  // unified 3-phase zoom engine without weakening the opaque-origin sandbox boundary.
  // Crucially, the iframe->viewport coordinate basis is frozen at gesture start using the
  // committed scale (excluding any live GPU preview transform) so multi-frame pinches never
  // feed the preview scale back into distance or focal-point calculations.
  useEffect(() => {
    if (!fillViewportHeight) return;

    const getOrFreezeBasis = (iframe: HTMLIFrameElement, forceCapture: boolean): IframeGestureBasis => {
      if (!forceCapture && iframeGestureBasisRef.current) {
        return iframeGestureBasisRef.current;
      }
      const rect = iframe.getBoundingClientRect();
      const basis: IframeGestureBasis = {
        left: rect.left,
        top: rect.top,
        scale: scaleRef.current,
      };
      iframeGestureBasisRef.current = basis;
      return basis;
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || data.type !== 'agy-sandbox-zoom') return;

      const iframe = innerRef.current?.querySelector('iframe.html-sandbox-frame') as HTMLIFrameElement | null;
      if (!iframe || !iframe.contentWindow || event.source !== iframe.contentWindow) return;

      if (data.kind === 'wheel') {
        const deltaY = Number(data.deltaY);
        const deltaMode = Number(data.deltaMode) || 0;
        const localX = Number(data.localX);
        const localY = Number(data.localY);
        if (!Number.isFinite(deltaY) || !Number.isFinite(localX) || !Number.isFinite(localY)) return;
        const isFreshGesture = scrollRef.current?.dataset.zoomInteracting !== 'true';
        const basis = getOrFreezeBasis(iframe, isFreshGesture);
        const clientX = basis.left + localX * basis.scale;
        const clientY = basis.top + localY * basis.scale;
        handleExternalWheel(deltaY, deltaMode, clientX, clientY);
        return;
      }

      if (data.kind === 'pinch-start' || data.kind === 'pinch-move') {
        const distance = Number(data.distance);
        const localX = Number(data.localX);
        const localY = Number(data.localY);
        if (!Number.isFinite(distance) || !Number.isFinite(localX) || !Number.isFinite(localY)) return;
        const isStart = data.kind === 'pinch-start';
        const basis = getOrFreezeBasis(iframe, isStart);
        const clientX = basis.left + localX * basis.scale;
        const clientY = basis.top + localY * basis.scale;
        handleExternalPinch(isStart ? 'start' : 'move', distance * basis.scale, clientX, clientY);
        return;
      }

      if (data.kind === 'pinch-end') {
        handleExternalPinch('end');
        iframeGestureBasisRef.current = null;
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      iframeGestureBasisRef.current = null;
    };
  }, [fillViewportHeight, handleExternalWheel, handleExternalPinch]);

  const applyStepZoom = useCallback(
    (direction: 'in' | 'out') => {
      commitDiscreteScale((cur) => computeStepZoomScale(cur, direction, VIEWER_MIN_SCALE, VIEWER_MAX_SCALE));
    },
    [commitDiscreteScale]
  );

  const handleResetFit = useCallback(() => {
    iframeGestureBasisRef.current = null;
    cancelActiveGesture();
    setScale(VIEWER_DEFAULT_SCALE);
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [cancelActiveGesture]);

  const baseW = containerSize.width > 0 ? containerSize.width : Math.max(0, contentSize.width);
  const baseH =
    contentSize.height > 0
      ? contentSize.height
      : fillViewportHeight
        ? Math.max(320, containerSize.height)
        : 0;

  // When scaled (especially scale < 1), give the stage exact scaled pixel dimensions with
  // overflow: hidden and NO minWidth: 100%, so:
  // 1. Untransformed inner layout boxes never leave phantom scroll range when shrunk.
  // 2. stage.getBoundingClientRect() matches the exact visual content rect for focal anchoring.
  const sizerStyle: React.CSSProperties =
    !isDefault && baseW > 0 && baseH > 0
      ? {
          width: `${Math.max(1, Math.ceil(baseW * scale))}px`,
          height: `${Math.max(1, Math.ceil(baseH * scale))}px`,
          overflow: 'hidden',
          margin: scale < 1 ? '0 auto' : undefined,
        }
      : {
          width: '100%',
          minHeight: '100%',
          height: fillViewportHeight ? '100%' : undefined,
        };

  const innerStyle: React.CSSProperties = {
    width: !isDefault && baseW > 0 ? `${baseW}px` : '100%',
    height: fillViewportHeight ? (containerSize.height > 0 ? `${containerSize.height}px` : '100%') : undefined,
    minHeight: fillViewportHeight ? '100%' : undefined,
    transform: isDefault ? undefined : `scale(${scale})`,
    transformOrigin: '0 0',
  };

  const showGrabCursor =
    isZoomedIn && (dragPanMode === 'direct' || isSpacePanReady);

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
            onClick={() => applyStepZoom('out')}
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
            onClick={() => applyStepZoom('in')}
          >
            ＋
          </button>
        </div>
      </div>
      {controlsTop && <div className="viewer-controls-top">{controlsTop}</div>}
      <div
        ref={setScrollContainerRef}
        className={`viewer-zoom-scroll content-zoom-surface${scrollClassName ? ` ${scrollClassName}` : ''}${showGrabCursor ? ' is-pannable' : ''}${isPanning ? ' is-panning' : ''}`}
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
      {controlsBottom && <div className="viewer-controls-bottom">{controlsBottom}</div>}
    </div>
  );
};
