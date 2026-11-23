import { useEffect, useRef, useState } from 'react';
import {
  captureRelativeFocalPoint,
  computePinchScale,
  computeTouchPinchGeometry,
  computeWheelZoomScale,
  type RelativeFocalPoint,
} from '../utils/contentZoom';

export interface UseContentZoomGesturesOptions {
  /** Scroll container element that receives wheel, touch pinch, and drag-pan events */
  scrollEl: HTMLElement | null;
  /** Zoomed content element whose bounding rect is used for focal-point anchoring */
  contentEl: HTMLElement | null;
  /** Current effective zoom scale */
  scale: number;
  /** Minimum allowed scale */
  minScale: number;
  /** Maximum allowed scale */
  maxScale: number;
  /** Whether mouse drag-to-pan is enabled when content overflows the scroll container */
  enableDragPan?: boolean;
  /** Wheel sensitivity multiplier (default 0.0025) */
  wheelSensitivity?: number;
  /** Called whenever a gesture computes a new scale with its focal point */
  onScaleChange: (nextScale: number, focal: RelativeFocalPoint | null) => void;
  /** Optional callback when a manual gesture starts (e.g. to cancel smooth scroll locks) */
  onGestureStart?: () => void;
}

export interface UseContentZoomGesturesResult {
  isPanning: boolean;
  isPinching: boolean;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('button, a, input, select, textarea, label, [role="button"]'));
}

/**
 * Attaches content-scoped zoom gestures (PC Ctrl+Wheel / trackpad pinch,
 * touch two-finger pinch, and optional mouse drag-to-pan) to a specific scroll container.
 *
 * Never attaches global document/window zoom blockers so native browser zoom
 * and accessibility zoom remain fully available outside content areas.
 */
export function useContentZoomGestures({
  scrollEl,
  contentEl,
  scale,
  minScale,
  maxScale,
  enableDragPan = false,
  wheelSensitivity = 0.0025,
  onScaleChange,
  onGestureStart,
}: UseContentZoomGesturesOptions): UseContentZoomGesturesResult {
  const [isPanning, setIsPanning] = useState(false);
  const [isPinching, setIsPinching] = useState(false);

  const stateRef = useRef({
    scale,
    minScale,
    maxScale,
    wheelSensitivity,
    contentEl,
    onScaleChange,
    onGestureStart,
  });
  stateRef.current = {
    scale,
    minScale,
    maxScale,
    wheelSensitivity,
    contentEl,
    onScaleChange,
    onGestureStart,
  };

  // Wheel (PC Ctrl+Wheel & trackpad pinch) + Touch 2-finger pinch + Safari gesture events
  useEffect(() => {
    if (!scrollEl) return;

    let pinchStartDistance = 0;
    let pinchStartScale = 1;
    let pinchActive = false;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();

      const {
        scale: curScale,
        minScale: curMin,
        maxScale: curMax,
        wheelSensitivity: sens,
        contentEl: targetContent,
        onScaleChange: applyScale,
        onGestureStart: notifyStart,
      } = stateRef.current;

      notifyStart?.();
      const nextScale = computeWheelZoomScale(curScale, e.deltaY, e.deltaMode, curMin, curMax, sens);
      if (Math.abs(nextScale - curScale) < 0.0005) return;

      const anchorEl = targetContent ?? scrollEl;
      const focal = captureRelativeFocalPoint(anchorEl.getBoundingClientRect(), e.clientX, e.clientY);
      applyScale(nextScale, focal);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const geom = computeTouchPinchGeometry(e.touches[0], e.touches[1]);
        if (geom.distance > 4) {
          pinchActive = true;
          pinchStartDistance = geom.distance;
          pinchStartScale = stateRef.current.scale;
          setIsPinching(true);
          stateRef.current.onGestureStart?.();
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
        pinchStartScale = stateRef.current.scale;
        setIsPinching(true);
        stateRef.current.onGestureStart?.();
        return;
      }

      const {
        scale: curScale,
        minScale: curMin,
        maxScale: curMax,
        contentEl: targetContent,
        onScaleChange: applyScale,
      } = stateRef.current;

      const nextScale = computePinchScale(pinchStartScale, pinchStartDistance, geom.distance, curMin, curMax);
      if (Math.abs(nextScale - curScale) < 0.002) return;

      const anchorEl = targetContent ?? scrollEl;
      const focal = captureRelativeFocalPoint(anchorEl.getBoundingClientRect(), geom.centerX, geom.centerY);
      applyScale(nextScale, focal);
    };

    const endPinch = (e: TouchEvent) => {
      if (pinchActive && e.touches.length < 2) {
        pinchActive = false;
        pinchStartDistance = 0;
        setIsPinching(false);
      }
    };

    // Safari / WebKit proprietary gesture events: prevent page-level zoom inside the content area
    const handleSafariGesture = (e: Event) => {
      e.preventDefault();
    };

    scrollEl.addEventListener('wheel', handleWheel, { passive: false });
    scrollEl.addEventListener('touchstart', handleTouchStart, { passive: true });
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
    };
  }, [scrollEl]);

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
      stateRef.current.onGestureStart?.();
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

  return { isPanning, isPinching };
}
