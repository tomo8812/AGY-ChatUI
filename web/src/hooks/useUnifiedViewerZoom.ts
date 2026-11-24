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

export interface ZoomAnchorAdapter<TAnchor = unknown> {
  /** Capture a viewer-specific focal anchor (e.g. PDF pageNum + page-local normalized coords) */
  capture: (clientX: number, clientY: number) => TAnchor | null;
  /** Synchronously adjust scroll offsets after layout commit so the captured anchor stays at (clientX, clientY) */
  restore: (anchor: TAnchor, clientX: number, clientY: number) => void;
}

export type DragPanMode = 'direct' | 'modifier-or-surface';

export interface UseUnifiedViewerZoomOptions<TAnchor = unknown> {
  /** Scroll container element */
  scrollEl: HTMLElement | null;
  /** Visual stage element that receives GPU preview transforms during gestures */
  stageEl: HTMLElement | null;
  /** Optional element whose rect represents the true scaled content bounds for focal anchoring (defaults to stageEl) */
  anchorEl?: HTMLElement | null;
  /** Optional viewer-specific anchor adapter (e.g. PDF page-level focal anchoring) */
  anchorAdapter?: ZoomAnchorAdapter<TAnchor>;
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
  /**
   * 'direct': left-click drag pans immediately on non-interactive targets (PDF, Image, SVG).
   * 'modifier-or-surface': preserves native text selection on text elements while allowing
   * drag-pan via Space+drag, Alt+drag, middle-click drag, or dragging non-text surfaces.
   */
  dragPanMode?: DragPanMode;
  /** Wheel sensitivity multiplier (default 0.0025) */
  wheelSensitivity?: number;
  /** Delay (ms) after the last wheel event before committing high-res layout/render */
  wheelCommitDelayMs?: number;
  /** Called ONCE when a gesture ends (or on discrete step) to commit the final scale */
  onCommitScale: (nextScale: number) => void;
  /** Optional callback when a zoom gesture starts */
  onGestureStart?: () => void;
  /** Optional callback when a zoom gesture finishes or is cancelled */
  onGestureEnd?: () => void;
  /** Optional callback when a mouse drag-to-pan starts (does not pause rendering) */
  onPanStart?: () => void;
  /** Optional key that resets any in-flight gesture state (e.g. file/artifact change) */
  resetKey?: string;
}

export interface UseUnifiedViewerZoomResult {
  isPanning: boolean;
  isSpacePanReady: boolean;
  /** Capture a focal point and commit a discrete scale change immediately (e.g. +/- buttons or double-click) */
  commitDiscreteScale: (
    nextScaleOrUpdater: number | ((currentScale: number) => number),
    clientX?: number,
    clientY?: number
  ) => void;
  /** Cancel any in-flight preview gesture and clear transforms immediately (e.g. before resetToFit) */
  cancelActiveGesture: () => void;
  /** Feed a wheel zoom event forwarded from a sandboxed iframe into the same 3-phase zoom engine */
  handleExternalWheel: (deltaY: number, deltaMode: number, clientX: number, clientY: number) => void;
  /** Feed a pinch gesture event forwarded from a sandboxed iframe into the same 3-phase zoom engine */
  handleExternalPinch: (
    kind: 'start' | 'move' | 'end',
    distance?: number,
    clientX?: number,
    clientY?: number
  ) => void;
}

interface ActiveGestureState<TAnchor = unknown> {
  baseScale: number;
  liveScale: number;
  scrollRectLeft: number;
  scrollRectTop: number;
  startAnchorWidth: number;
  startAnchorHeight: number;
  startPointerX: number;
  startPointerY: number;
  curPointerX: number;
  curPointerY: number;
  /** Focal point relative to stageEl's un-transformed top-left (for GPU translate3d+scale preview) */
  focalStageX: number;
  focalStageY: number;
  /** Focal point relative to anchorEl's un-transformed top-left (for fallback relative anchoring) */
  focalAnchorX: number;
  focalAnchorY: number;
  /** Optional custom anchor captured at gesture start (e.g. PDF pageNum + page-local normalized coords) */
  customAnchor: TAnchor | null;
}

type PendingFocalAnchor<TAnchor = unknown> =
  | { kind: 'custom'; anchor: TAnchor; clientX: number; clientY: number }
  | { kind: 'relative'; focal: RelativeFocalPoint };

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('button, a, input, select, textarea, label, [role="button"]'));
}

function isEditableFocusedElement(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable;
}

function isNonTextPanSurface(
  target: EventTarget | null,
  scrollEl: HTMLElement,
  stageEl: HTMLElement | null
): boolean {
  if (!(target instanceof Element)) return false;
  if (target === scrollEl || target === stageEl) return true;
  if (target.closest('img, canvas, svg')) return true;
  return false;
}

/**
 * Unified, 3-phase (start -> GPU preview update -> commit) zoom & pan engine
 * shared by all file viewers (PDF, PPTX, Image, SVG, DOCX, Markdown, Code, Diff,
 * CSV/Excel, Mermaid, HTML).
 */
export function useUnifiedViewerZoom<TAnchor = unknown>({
  scrollEl,
  stageEl,
  anchorEl = null,
  anchorAdapter,
  scaleBadgeEl = null,
  committedScale,
  minScale,
  maxScale,
  enableDragPan = true,
  dragPanMode = 'direct',
  wheelSensitivity = 0.0025,
  wheelCommitDelayMs = 140,
  onCommitScale,
  onGestureStart,
  onGestureEnd,
  onPanStart,
  resetKey,
}: UseUnifiedViewerZoomOptions<TAnchor>): UseUnifiedViewerZoomResult {
  const [isPanning, setIsPanning] = useState(false);
  const [isSpacePanReady, setIsSpacePanReady] = useState(false);

  const pendingAnchorRef = useRef<PendingFocalAnchor<TAnchor> | null>(null);
  const gestureRef = useRef<ActiveGestureState<TAnchor> | null>(null);
  const gestureActiveFlagRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const wheelCommitTimerRef = useRef<number | null>(null);
  const spacePressedRef = useRef(false);

  const latestRef = useRef({
    scrollEl,
    stageEl,
    anchorEl,
    anchorAdapter,
    scaleBadgeEl,
    committedScale,
    minScale,
    maxScale,
    wheelSensitivity,
    wheelCommitDelayMs,
    onCommitScale,
    onGestureStart,
    onGestureEnd,
    onPanStart,
  });
  latestRef.current = {
    scrollEl,
    stageEl,
    anchorEl,
    anchorAdapter,
    scaleBadgeEl,
    committedScale,
    minScale,
    maxScale,
    wheelSensitivity,
    wheelCommitDelayMs,
    onCommitScale,
    onGestureStart,
    onGestureEnd,
    onPanStart,
  };

  const clearTimersAndPreview = useCallback(() => {
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

  const notifyGestureEndedIfActive = useCallback(() => {
    if (gestureActiveFlagRef.current) {
      gestureActiveFlagRef.current = false;
      latestRef.current.onGestureEnd?.();
    }
  }, []);

  const cancelActiveGesture = useCallback(() => {
    gestureRef.current = null;
    pendingAnchorRef.current = null;
    clearTimersAndPreview();
    notifyGestureEndedIfActive();
  }, [clearTimersAndPreview, notifyGestureEndedIfActive]);

  // Reset gesture state cleanly when switching files/views
  useEffect(() => {
    cancelActiveGesture();
  }, [resetKey, cancelActiveGesture]);

  // Cancel any in-flight gesture if the scroll container resizes mid-gesture
  useEffect(() => {
    if (!scrollEl || typeof ResizeObserver === 'undefined') return;
    let lastW = Math.round(scrollEl.clientWidth);
    let lastH = Math.round(scrollEl.clientHeight);
    const ro = new ResizeObserver(() => {
      const nextW = Math.round(scrollEl.clientWidth);
      const nextH = Math.round(scrollEl.clientHeight);
      if (Math.abs(nextW - lastW) > 1 || Math.abs(nextH - lastH) > 1) {
        lastW = nextW;
        lastH = nextH;
        if (gestureRef.current) {
          cancelActiveGesture();
        }
      }
    });
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollEl, cancelActiveGesture]);

  // After React commits `committedScale`, clear preview transform, abort any stale
  // in-flight gesture (e.g. external scale change), and synchronously restore the exact focal anchor.
  useLayoutEffect(() => {
    if (gestureRef.current) {
      gestureRef.current = null;
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (wheelCommitTimerRef.current !== null) {
        window.clearTimeout(wheelCommitTimerRef.current);
        wheelCommitTimerRef.current = null;
      }
    }

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

    const pending = pendingAnchorRef.current;
    if (pending && sc) {
      pendingAnchorRef.current = null;
      if (pending.kind === 'custom') {
        latestRef.current.anchorAdapter?.restore(pending.anchor, pending.clientX, pending.clientY);
      } else {
        const targetEl = anchorEl ?? st;
        if (targetEl) {
          const { deltaX, deltaY } = computeFocalScrollDelta(targetEl.getBoundingClientRect(), pending.focal);
          if (Math.abs(deltaX) > 0.5) {
            sc.scrollLeft = Math.max(0, sc.scrollLeft + deltaX);
          }
          if (Math.abs(deltaY) > 0.5) {
            sc.scrollTop = Math.max(0, sc.scrollTop + deltaY);
          }
        }
      }
    }

    notifyGestureEndedIfActive();
  }, [committedScale, scrollEl, stageEl, anchorEl, scaleBadgeEl, notifyGestureEndedIfActive]);

  const commitDiscreteScale = useCallback(
    (
      nextScaleOrUpdater: number | ((currentScale: number) => number),
      clientX?: number,
      clientY?: number
    ) => {
      const {
        scrollEl: sc,
        stageEl: st,
        anchorEl: aEl,
        anchorAdapter: adapter,
        committedScale: curCommitted,
        minScale: minS,
        maxScale: maxS,
        onCommitScale: commit,
      } = latestRef.current;

      const hadGesture = gestureRef.current !== null;
      const baseScale = gestureRef.current?.liveScale ?? curCommitted;
      if (hadGesture) {
        gestureRef.current = null;
        clearTimersAndPreview();
      }

      const rawNext =
        typeof nextScaleOrUpdater === 'function' ? nextScaleOrUpdater(baseScale) : nextScaleOrUpdater;
      const nextScale = clampZoomScale(rawNext, minS, maxS);

      // No-op guard: never leave a stale pendingAnchorRef when React will skip re-render
      if (Math.abs(nextScale - curCommitted) < 0.0005) {
        pendingAnchorRef.current = null;
        if (hadGesture) {
          notifyGestureEndedIfActive();
        }
        return;
      }

      if (sc && st) {
        const scRect = sc.getBoundingClientRect();
        const cx = clientX ?? scRect.left + scRect.width / 2;
        const cy = clientY ?? scRect.top + scRect.height / 2;
        if (adapter) {
          const captured = adapter.capture(cx, cy);
          pendingAnchorRef.current = captured !== null ? { kind: 'custom', anchor: captured, clientX: cx, clientY: cy } : null;
        } else {
          const targetEl = aEl ?? st;
          const focal = captureRelativeFocalPoint(targetEl.getBoundingClientRect(), cx, cy);
          pendingAnchorRef.current = focal ? { kind: 'relative', focal } : null;
        }
      } else {
        pendingAnchorRef.current = null;
      }

      commit(nextScale);
    },
    [clearTimersAndPreview, notifyGestureEndedIfActive]
  );

  const externalHandlersRef = useRef<{
    wheel: (deltaY: number, deltaMode: number, clientX: number, clientY: number) => void;
    pinch: (kind: 'start' | 'move' | 'end', distance?: number, clientX?: number, clientY?: number) => void;
  }>({
    wheel: () => {},
    pinch: () => {},
  });

  // Gesture event listeners (Wheel Ctrl/Meta + Touch 2-finger pinch + Safari gesture*)
  useEffect(() => {
    if (!scrollEl) return;

    let pinchStartDistance = 0;
    let pinchStartScale = 1;
    let pinchActive = false;

    const beginGesture = (clientX: number, clientY: number): ActiveGestureState<TAnchor> | null => {
      const {
        scrollEl: sc,
        stageEl: st,
        anchorEl: aEl,
        anchorAdapter: adapter,
        committedScale: curScale,
        onGestureStart: notifyStart,
      } = latestRef.current;
      if (!sc || !st) return null;

      if (!gestureActiveFlagRef.current) {
        gestureActiveFlagRef.current = true;
        notifyStart?.();
      }

      const scRect = sc.getBoundingClientRect();
      const stRect = st.getBoundingClientRect();
      const targetAnchorEl = aEl ?? st;
      const anchorRect = targetAnchorEl === st ? stRect : targetAnchorEl.getBoundingClientRect();

      const startAnchorWidth = Math.max(1, anchorRect.width);
      const startAnchorHeight = Math.max(1, anchorRect.height);
      const startPointerX = clientX - scRect.left;
      const startPointerY = clientY - scRect.top;

      const stageOriginX = stRect.left - scRect.left + sc.scrollLeft;
      const stageOriginY = stRect.top - scRect.top + sc.scrollTop;
      const focalStageX = sc.scrollLeft + startPointerX - stageOriginX;
      const focalStageY = sc.scrollTop + startPointerY - stageOriginY;

      const anchorOriginX = anchorRect.left - scRect.left + sc.scrollLeft;
      const anchorOriginY = anchorRect.top - scRect.top + sc.scrollTop;
      const focalAnchorX = sc.scrollLeft + startPointerX - anchorOriginX;
      const focalAnchorY = sc.scrollTop + startPointerY - anchorOriginY;

      const customAnchor = adapter ? adapter.capture(clientX, clientY) : null;

      sc.dataset.zoomInteracting = 'true';
      st.style.transformOrigin = '0 0';
      st.style.willChange = 'transform';

      const g: ActiveGestureState<TAnchor> = {
        baseScale: curScale,
        liveScale: curScale,
        scrollRectLeft: scRect.left,
        scrollRectTop: scRect.top,
        startAnchorWidth,
        startAnchorHeight,
        startPointerX,
        startPointerY,
        curPointerX: startPointerX,
        curPointerY: startPointerY,
        focalStageX,
        focalStageY,
        focalAnchorX,
        focalAnchorY,
        customAnchor,
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
      if (!g) {
        notifyGestureEndedIfActive();
        return;
      }

      const { committedScale: curCommitted, onCommitScale: commit } = latestRef.current;
      const finalScale = g.liveScale;

      if (Math.abs(finalScale - curCommitted) < 0.0005) {
        pendingAnchorRef.current = null;
        clearTimersAndPreview();
        notifyGestureEndedIfActive();
        return;
      }

      const finalClientX = g.scrollRectLeft + g.curPointerX;
      const finalClientY = g.scrollRectTop + g.curPointerY;

      if (g.customAnchor !== null) {
        pendingAnchorRef.current = {
          kind: 'custom',
          anchor: g.customAnchor,
          clientX: finalClientX,
          clientY: finalClientY,
        };
      } else {
        pendingAnchorRef.current = {
          kind: 'relative',
          focal: {
            relX: g.focalAnchorX / g.startAnchorWidth,
            relY: g.focalAnchorY / g.startAnchorHeight,
            clientX: finalClientX,
            clientY: finalClientY,
          },
        };
      }

      // Single React state commit at gesture end (useLayoutEffect will clear preview,
      // restore focal scroll position, and call onGestureEnd)
      commit(finalScale);
    };

    const processWheelZoom = (deltaY: number, deltaMode: number, clientX: number, clientY: number) => {
      const { minScale: minS, maxScale: maxS, wheelSensitivity: sens, wheelCommitDelayMs: delay } = latestRef.current;

      let g = gestureRef.current;
      if (!g) {
        g = beginGesture(clientX, clientY);
        if (!g) return;
      }

      const nextScale = computeWheelZoomScale(g.liveScale, deltaY, deltaMode, minS, maxS, sens);
      if (Math.abs(nextScale - g.liveScale) >= 0.0002) {
        g.liveScale = nextScale;
        g.curPointerX = clientX - g.scrollRectLeft;
        g.curPointerY = clientY - g.scrollRectTop;
        schedulePreviewFrame();
      }

      if (wheelCommitTimerRef.current !== null) {
        window.clearTimeout(wheelCommitTimerRef.current);
      }
      wheelCommitTimerRef.current = window.setTimeout(finishGesture, delay);
    };

    const processPinch = (
      kind: 'start' | 'move' | 'end',
      distance = 0,
      centerX = 0,
      centerY = 0
    ) => {
      if (kind === 'end') {
        if (pinchActive) {
          pinchActive = false;
          pinchStartDistance = 0;
          finishGesture();
        }
        return;
      }
      if (kind === 'start' || !pinchActive || pinchStartDistance <= 4) {
        if (distance <= 4) return;
        pinchActive = true;
        pinchStartDistance = distance;
        const g = gestureRef.current ?? beginGesture(centerX, centerY);
        pinchStartScale = g ? g.liveScale : latestRef.current.committedScale;
        return;
      }
      const g = gestureRef.current;
      if (!g || distance <= 0) return;

      const { minScale: minS, maxScale: maxS } = latestRef.current;
      const nextScale = computePinchScale(pinchStartScale, pinchStartDistance, distance, minS, maxS);
      g.liveScale = nextScale;
      g.curPointerX = centerX - g.scrollRectLeft;
      g.curPointerY = centerY - g.scrollRectTop;
      schedulePreviewFrame();
    };

    externalHandlersRef.current = {
      wheel: processWheelZoom,
      pinch: processPinch,
    };

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      processWheelZoom(e.deltaY, e.deltaMode, e.clientX, e.clientY);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        e.stopPropagation();
        const geom = computeTouchPinchGeometry(e.touches[0], e.touches[1]);
        processPinch('start', geom.distance, geom.centerX, geom.centerY);
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      e.stopPropagation();
      const geom = computeTouchPinchGeometry(e.touches[0], e.touches[1]);
      processPinch('move', geom.distance, geom.centerX, geom.centerY);
    };

    const endPinch = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        processPinch('end');
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
      externalHandlersRef.current = { wheel: () => {}, pinch: () => {} };
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
  }, [scrollEl, clearTimersAndPreview, cancelActiveGesture, notifyGestureEndedIfActive]);

  const handleExternalWheel = useCallback(
    (deltaY: number, deltaMode: number, clientX: number, clientY: number) => {
      externalHandlersRef.current.wheel(deltaY, deltaMode, clientX, clientY);
    },
    []
  );

  const handleExternalPinch = useCallback(
    (kind: 'start' | 'move' | 'end', distance?: number, clientX?: number, clientY?: number) => {
      externalHandlersRef.current.pinch(kind, distance, clientX, clientY);
    },
    []
  );

  // Track Space key for grab-to-pan in text-selectable document viewers
  useEffect(() => {
    if (!scrollEl || !enableDragPan || dragPanMode !== 'modifier-or-surface') {
      spacePressedRef.current = false;
      setIsSpacePanReady(false);
      return;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !isEditableFocusedElement()) {
        spacePressedRef.current = true;
        setIsSpacePanReady(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spacePressedRef.current = false;
        setIsSpacePanReady(false);
      }
    };
    const onBlur = () => {
      spacePressedRef.current = false;
      setIsSpacePanReady(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      spacePressedRef.current = false;
      setIsSpacePanReady(false);
    };
  }, [scrollEl, enableDragPan, dragPanMode]);

  // PC Mouse drag-to-pan when content overflows the scroll container
  useEffect(() => {
    if (!scrollEl || !enableDragPan) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;

    const handleMouseDown = (e: MouseEvent) => {
      const isMiddle = e.button === 1;
      const isLeft = e.button === 0;
      if (!isLeft && !isMiddle) return;
      if (isInteractiveTarget(e.target)) return;

      const canPanX = scrollEl.scrollWidth > scrollEl.clientWidth + 1;
      const canPanY = scrollEl.scrollHeight > scrollEl.clientHeight + 1;
      if (!canPanX && !canPanY) return;

      if (dragPanMode === 'modifier-or-surface' && !isMiddle) {
        const hasModifier = spacePressedRef.current || e.altKey;
        const onPanSurface = isNonTextPanSurface(e.target, scrollEl, latestRef.current.stageEl);
        if (!hasModifier && !onPanSurface) {
          // Allow native browser text selection & copy inside zoomed documents
          return;
        }
      }

      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startScrollLeft = scrollEl.scrollLeft;
      startScrollTop = scrollEl.scrollTop;
      setIsPanning(true);
      latestRef.current.onPanStart?.();
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
  }, [scrollEl, enableDragPan, dragPanMode]);

  return {
    isPanning,
    isSpacePanReady,
    commitDiscreteScale,
    cancelActiveGesture,
    handleExternalWheel,
    handleExternalPinch,
  };
}
