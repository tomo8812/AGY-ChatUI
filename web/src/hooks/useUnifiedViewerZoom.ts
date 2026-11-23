import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  captureRelativeFocalPoint,
  clampZoomScale,
  computeFocalScrollDelta,
  computePinchScale,
  computeTouchPinchGeometry,
  computeWheelZoomScale,
  type RelativeFocalPoint,
} from '../utils/contentZoom';

export interface UseUnifiedViewerZoomOptions {
  /** Scroll container element (.viewer-zoom-scroll) */
  scrollEl: HTMLElement | null;
  /** Visual stage element (.viewer-zoom-stage) that receives GPU preview transforms */
  stageEl: HTMLElement | null;
  /** Optional scale readout element updated directly via DOM during gestures (0 React renders) */
  scaleBadgeEl?: HTMLElement | null;
  /** Committed scale currently rendered in React */
  committedScale: number;
  /** Minimum allowed scale */
  minScale: number;
  /** Maximum allowed scale */
  maxScale: number;
  /** Whether PC mouse drag-to-pan is enabled when overflowing */
  enableDragPan?: boolean;
  /** Wheel sensitivity multiplier (default 0.0025) */
  wheelSensitivity?: number;
  /** Delay (ms) after the last wheel event before committing high-res layout/render */
  wheelCommitDelayMs?: number;
  /** Called ONCE when a gesture ends (or on discrete step/reset) to commit the final scale */
  onCommitScale: (nextScale: number) => void;
  /** Optional callback when a gesture starts (e.g. cancel smooth scroll locks) */
  onGestureStart?: () => void;
  /** Optional key that resets any in-flight gesture state (e.g. file/artifact change) */
  resetKey?: string;
}

export interface UseUnifiedViewerZoomResult {
  isPanning: boolean;
  /** Capture a focal point and commit a discrete scale change immediately (e.g. +/- buttons or double-click) */
  commitDiscreteScale: (
    nextScaleOrUpdater: number | ((currentScale: number) => number),
    clientX?: number,
    clientY?: number
  ) => void;
  /** Cancel any in-flight preview gesture and clear transforms immediately (e.g. before resetToFit) */
  cancelActiveGesture: () => void;
}

interface ActiveGestureState {
  baseScale: number;
  liveScale: number;
  scrollRectLeft: number;
  scrollRectTop: number;
  startStageWidth: number;
  startStageHeight: number;
  startPointerX: number;
  startPointerY: number;
  curPointerX: number;
  curPointerY: number;
  focalStageX: number;
  focalStageY: number;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('button, a, input, select, textarea, label, [role="button"]'));
}

/**
 * Unified, 3-phase (start -> GPU preview update -> commit) zoom & pan engine
 * shared by all file viewers (PDF, PPTX, Image, SVG, DOCX, Markdown, Code, Diff,
 * CSV/Excel, Mermaid, HTML).
 *
 * During continuous pinch or Ctrl+Wheel gestures:
 * - Zero React state updates / zero component re-renders
 * - Zero layout recalculations / zero DOM style mutations on child items
 * - Pure GPU `translate3d + scale` anchored cleanly at the pointer/pinch midpoint
 *
 * When the gesture ends:
 * - Commits the final scale once to React
 * - Clears the GPU preview transform and applies exact focal-point scroll correction
 *   synchronously in `useLayoutEffect` before paint (zero jump / zero flicker).
 */
export function useUnifiedViewerZoom({
  scrollEl,
  stageEl,
  scaleBadgeEl = null,
  committedScale,
  minScale,
  maxScale,
  enableDragPan = true,
  wheelSensitivity = 0.0025,
  wheelCommitDelayMs = 140,
  onCommitScale,
  onGestureStart,
  resetKey,
}: UseUnifiedViewerZoomOptions): UseUnifiedViewerZoomResult {
  const [isPanning, setIsPanning] = useState(false);

  const pendingFocalRef = useRef<RelativeFocalPoint | null>(null);
  const gestureRef = useRef<ActiveGestureState | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const wheelCommitTimerRef = useRef<number | null>(null);

  const latestRef = useRef({
    scrollEl,
    stageEl,
    scaleBadgeEl,
    committedScale,
    minScale,
    maxScale,
    wheelSensitivity,
    wheelCommitDelayMs,
    onCommitScale,
    onGestureStart,
  });
  latestRef.current = {
    scrollEl,
    stageEl,
    scaleBadgeEl,
    committedScale,
    minScale,
    maxScale,
    wheelSensitivity,
    wheelCommitDelayMs,
    onCommitScale,
    onGestureStart,
  };

  const clearPreviewTransform = useCallback(() => {
    const { scrollEl: sc, stageEl: st, scaleBadgeEl: badge, committedScale: curScale } = latestRef.current;
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (wheelCommitTimerRef.current !== null) {
      window.clearTimeout(wheelCommitTimerRef.current);
      wheelCommitTimerRef.current = null;
    }
    if (st) {
      st.style.transform = '';
      st.style.willChange = '';
    }
    if (sc) {
      delete sc.dataset.zoomInteracting;
      sc.dataset.zoomScale = String(Math.round(curScale * 100));
    }
    if (badge) {
      badge.textContent = `${Math.round(curScale * 100)}%`;
    }
  }, []);

  const cancelActiveGesture = useCallback(() => {
    gestureRef.current = null;
    pendingFocalRef.current = null;
    clearPreviewTransform();
  }, [clearPreviewTransform]);

  // Reset gesture state cleanly when switching files/views
  useEffect(() => {
    cancelActiveGesture();
  }, [resetKey, cancelActiveGesture]);

  // After React commits the new `committedScale`, clear the preview transform and
  // restore the exact focal-point scroll position synchronously before browser paint.
  useLayoutEffect(() => {
    const st = stageEl;
    const sc = scrollEl;
    if (st) {
      st.style.transform = '';
      st.style.willChange = '';
    }
    if (sc) {
      delete sc.dataset.zoomInteracting;
      sc.dataset.zoomScale = String(Math.round(committedScale * 100));
    }
    if (scaleBadgeEl) {
      scaleBadgeEl.textContent = `${Math.round(committedScale * 100)}%`;
    }

    const focal = pendingFocalRef.current;
    if (!focal || !sc || !st) return;
    pendingFocalRef.current = null;

    const { deltaX, deltaY } = computeFocalScrollDelta(st.getBoundingClientRect(), focal);
    if (Math.abs(deltaX) > 0.5) {
      sc.scrollLeft = Math.max(0, sc.scrollLeft + deltaX);
    }
    if (Math.abs(deltaY) > 0.5) {
      sc.scrollTop = Math.max(0, sc.scrollTop + deltaY);
    }
  }, [committedScale, scrollEl, stageEl, scaleBadgeEl]);

  const commitDiscreteScale = useCallback(
    (
      nextScaleOrUpdater: number | ((currentScale: number) => number),
      clientX?: number,
      clientY?: number
    ) => {
      const {
        scrollEl: sc,
        stageEl: st,
        committedScale: curCommitted,
        minScale: minS,
        maxScale: maxS,
        onCommitScale: commit,
      } = latestRef.current;
      const baseScale = gestureRef.current?.liveScale ?? curCommitted;
      if (gestureRef.current) {
        gestureRef.current = null;
        clearPreviewTransform();
      }
      const rawNext =
        typeof nextScaleOrUpdater === 'function' ? nextScaleOrUpdater(baseScale) : nextScaleOrUpdater;
      const nextScale = clampZoomScale(rawNext, minS, maxS);
      if (sc && st) {
        const scRect = sc.getBoundingClientRect();
        const cx = clientX ?? scRect.left + scRect.width / 2;
        const cy = clientY ?? scRect.top + scRect.height / 2;
        pendingFocalRef.current = captureRelativeFocalPoint(st.getBoundingClientRect(), cx, cy);
      }
      commit(nextScale);
    },
    [clearPreviewTransform]
  );

  // Gesture event listeners (Wheel Ctrl/Meta + Touch 2-finger pinch + Safari gesture*)
  useEffect(() => {
    if (!scrollEl) return;

    let pinchStartDistance = 0;
    let pinchStartScale = 1;
    let pinchActive = false;

    const beginGesture = (clientX: number, clientY: number): ActiveGestureState | null => {
      const { scrollEl: sc, stageEl: st, committedScale: curScale, onGestureStart: notifyStart } = latestRef.current;
      if (!sc || !st) return null;

      notifyStart?.();

      const scRect = sc.getBoundingClientRect();
      const stRect = st.getBoundingClientRect();
      const startStageWidth = Math.max(1, stRect.width);
      const startStageHeight = Math.max(1, stRect.height);
      const startPointerX = clientX - scRect.left;
      const startPointerY = clientY - scRect.top;
      const stageOriginX = stRect.left - scRect.left + sc.scrollLeft;
      const stageOriginY = stRect.top - scRect.top + sc.scrollTop;
      const focalStageX = sc.scrollLeft + startPointerX - stageOriginX;
      const focalStageY = sc.scrollTop + startPointerY - stageOriginY;

      sc.dataset.zoomInteracting = 'true';
      st.style.transformOrigin = '0 0';
      st.style.willChange = 'transform';

      const g: ActiveGestureState = {
        baseScale: curScale,
        liveScale: curScale,
        scrollRectLeft: scRect.left,
        scrollRectTop: scRect.top,
        startStageWidth,
        startStageHeight,
        startPointerX,
        startPointerY,
        curPointerX: startPointerX,
        curPointerY: startPointerY,
        focalStageX,
        focalStageY,
      };
      gestureRef.current = g;
      return g;
    };

    const schedulePreviewFrame = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = window.requestAnimationFrame(() => {
        rafIdRef.current = null;
        const g = gestureRef.current;
        const { scrollEl: sc, stageEl: st, scaleBadgeEl: badge } = latestRef.current;
        if (!g || !sc || !st) return;

        const ratio = g.liveScale / Math.max(0.0001, g.baseScale);
        const tx = g.curPointerX - g.startPointerX + g.focalStageX * (1 - ratio);
        const ty = g.curPointerY - g.startPointerY + g.focalStageY * (1 - ratio);

        st.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${ratio.toFixed(5)})`;

        const pct = Math.round(g.liveScale * 100);
        sc.dataset.zoomScale = String(pct);
        if (badge) {
          badge.textContent = `${pct}%`;
        }
      });
    };

    const finishGesture = () => {
      if (wheelCommitTimerRef.current !== null) {
        window.clearTimeout(wheelCommitTimerRef.current);
        wheelCommitTimerRef.current = null;
      }
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }

      const g = gestureRef.current;
      gestureRef.current = null;
      if (!g) return;

      const { committedScale: curCommitted, onCommitScale: commit } = latestRef.current;
      const finalScale = g.liveScale;

      if (Math.abs(finalScale - curCommitted) < 0.0005) {
        clearPreviewTransform();
        return;
      }

      pendingFocalRef.current = {
        relX: g.focalStageX / g.startStageWidth,
        relY: g.focalStageY / g.startStageHeight,
        clientX: g.scrollRectLeft + g.curPointerX,
        clientY: g.scrollRectTop + g.curPointerY,
      };

      // Single React state commit at gesture end
      commit(finalScale);
    };

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();

      const { minScale: minS, maxScale: maxS, wheelSensitivity: sens, wheelCommitDelayMs: delay } = latestRef.current;

      let g = gestureRef.current;
      if (!g) {
        g = beginGesture(e.clientX, e.clientY);
        if (!g) return;
      }

      const nextScale = computeWheelZoomScale(g.liveScale, e.deltaY, e.deltaMode, minS, maxS, sens);
      if (Math.abs(nextScale - g.liveScale) >= 0.0002) {
        g.liveScale = nextScale;
        g.curPointerX = e.clientX - g.scrollRectLeft;
        g.curPointerY = e.clientY - g.scrollRectTop;
        schedulePreviewFrame();
      }

      if (wheelCommitTimerRef.current !== null) {
        window.clearTimeout(wheelCommitTimerRef.current);
      }
      wheelCommitTimerRef.current = window.setTimeout(finishGesture, delay);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        e.stopPropagation();
        const geom = computeTouchPinchGeometry(e.touches[0], e.touches[1]);
        if (geom.distance > 4) {
          pinchActive = true;
          pinchStartDistance = geom.distance;
          const g = gestureRef.current ?? beginGesture(geom.centerX, geom.centerY);
          pinchStartScale = g ? g.liveScale : latestRef.current.committedScale;
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      e.stopPropagation();

      const geom = computeTouchPinchGeometry(e.touches[0], e.touches[1]);
      if (!pinchActive || pinchStartDistance <= 4) {
        pinchActive = true;
        pinchStartDistance = Math.max(geom.distance, 1);
        const g = gestureRef.current ?? beginGesture(geom.centerX, geom.centerY);
        pinchStartScale = g ? g.liveScale : latestRef.current.committedScale;
        return;
      }

      const g = gestureRef.current;
      if (!g) return;

      const { minScale: minS, maxScale: maxS } = latestRef.current;
      const nextScale = computePinchScale(pinchStartScale, pinchStartDistance, geom.distance, minS, maxS);
      g.liveScale = nextScale;
      g.curPointerX = geom.centerX - g.scrollRectLeft;
      g.curPointerY = geom.centerY - g.scrollRectTop;
      schedulePreviewFrame();
    };

    const endPinch = (e: TouchEvent) => {
      if (pinchActive && e.touches.length < 2) {
        pinchActive = false;
        pinchStartDistance = 0;
        finishGesture();
      }
    };

    const handleSafariGesture = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    scrollEl.addEventListener('wheel', handleWheel, { passive: false });
    scrollEl.addEventListener('touchstart', handleTouchStart, { passive: false });
    scrollEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    scrollEl.addEventListener('touchend', endPinch, { passive: true });
    scrollEl.addEventListener('touchcancel', endPinch, { passive: true });
    scrollEl.addEventListener('gesturestart', handleSafariGesture, { passive: false });
    scrollEl.addEventListener('gesturechange', handleSafariGesture, { passive: false });
    scrollEl.addEventListener('gestureend', handleSafariGesture, { passive: false });

    return () => {
      scrollEl.removeEventListener('wheel', handleWheel);
      scrollEl.removeEventListener('touchstart', handleTouchStart);
      scrollEl.removeEventListener('touchmove', handleTouchMove);
      scrollEl.removeEventListener('touchend', endPinch);
      scrollEl.removeEventListener('touchcancel', endPinch);
      scrollEl.removeEventListener('gesturestart', handleSafariGesture);
      scrollEl.removeEventListener('gesturechange', handleSafariGesture);
      scrollEl.removeEventListener('gestureend', handleSafariGesture);
      cancelActiveGesture();
    };
  }, [scrollEl, clearPreviewTransform, cancelActiveGesture]);

  // PC Mouse drag-to-pan when content overflows the scroll container
  useEffect(() => {
    if (!scrollEl || !enableDragPan) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (isInteractiveTarget(e.target)) return;
      const canPanX = scrollEl.scrollWidth > scrollEl.clientWidth + 1;
      const canPanY = scrollEl.scrollHeight > scrollEl.clientHeight + 1;
      if (!canPanX && !canPanY) return;

      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startScrollLeft = scrollEl.scrollLeft;
      startScrollTop = scrollEl.scrollTop;
      setIsPanning(true);
      latestRef.current.onGestureStart?.();
      e.preventDefault();
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      scrollEl.scrollLeft = startScrollLeft - dx;
      scrollEl.scrollTop = startScrollTop - dy;
    };

    const handleMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      setIsPanning(false);
    };

    scrollEl.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleMouseUp);

    return () => {
      scrollEl.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleMouseUp);
    };
  }, [scrollEl, enableDragPan]);

  return {
    isPanning,
    commitDiscreteScale,
    cancelActiveGesture,
  };
}
