export const VIEWER_MIN_SCALE = 0.2;
export const VIEWER_MAX_SCALE = 5.0;
export const VIEWER_DEFAULT_SCALE = 1.0;
export const VIEWER_AUTO_FIT_MIN_SCALE = 0.05;
export const VIEWER_AUTO_FIT_MAX_SCALE = 3.0;
export const VIEWER_ZOOM_STEP_FACTOR = 1.25;

// Legacy aliases kept for minimal churn in helper imports
export const MEDIA_MIN_SCALE = VIEWER_MIN_SCALE;
export const MEDIA_MAX_SCALE = VIEWER_MAX_SCALE;
export const MEDIA_AUTO_FIT_MIN_SCALE = VIEWER_AUTO_FIT_MIN_SCALE;
export const MEDIA_AUTO_FIT_MAX_SCALE = VIEWER_AUTO_FIT_MAX_SCALE;
export const MEDIA_ZOOM_STEP_FACTOR = VIEWER_ZOOM_STEP_FACTOR;

export interface Point2D {
  x: number;
  y: number;
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RelativeFocalPoint {
  relX: number;
  relY: number;
  clientX: number;
  clientY: number;
}

export function clampZoomScale(scale: number, min: number, max: number): number {
  if (!Number.isFinite(scale)) return min;
  const clamped = Math.min(max, Math.max(min, scale));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * Shared zoom-in / zoom-out step calculation used uniformly across ALL file viewers
 * (PDF, PPTX, Image, SVG, DOCX, Markdown, Code, Diff, CSV/Excel, Mermaid, HTML).
 */
export function computeStepZoomScale(
  currentScale: number,
  direction: 'in' | 'out',
  min: number,
  max: number,
  stepFactor = VIEWER_ZOOM_STEP_FACTOR
): number {
  const factor = direction === 'in' ? stepFactor : 1 / stepFactor;
  return clampZoomScale(currentScale * factor, min, max);
}

/**
 * Computes the next zoom scale from a wheel event (PC Ctrl+Wheel or trackpad pinch).
 * Trackpad pinch gestures emit wheel events with `ctrlKey: true` and small deltaY values,
 * while discrete mouse wheels emit larger deltaY steps or line-mode deltas.
 */
export function computeWheelZoomScale(
  currentScale: number,
  deltaY: number,
  deltaMode: number,
  min: number,
  max: number,
  sensitivity = 0.0025
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return clampZoomScale(currentScale, min, max);
  }
  let normalizedDelta = deltaY;
  if (deltaMode === 1) {
    normalizedDelta = deltaY * 16;
  } else if (deltaMode === 2) {
    normalizedDelta = deltaY * 100;
  }
  const boundedDelta = Math.max(-120, Math.min(120, normalizedDelta));
  const factor = Math.exp(-boundedDelta * sensitivity);
  return clampZoomScale(currentScale * factor, min, max);
}

/**
 * Computes the next zoom scale from a two-finger touch pinch distance ratio.
 */
export function computePinchScale(
  startScale: number,
  startDistance: number,
  currentDistance: number,
  min: number,
  max: number
): number {
  if (startDistance <= 0 || currentDistance <= 0) {
    return clampZoomScale(startScale, min, max);
  }
  const ratio = currentDistance / startDistance;
  return clampZoomScale(startScale * ratio, min, max);
}

export function computeTouchPinchGeometry(
  t1: { clientX: number; clientY: number },
  t2: { clientX: number; clientY: number }
): { distance: number; centerX: number; centerY: number } {
  const dx = t2.clientX - t1.clientX;
  const dy = t2.clientY - t1.clientY;
  return {
    distance: Math.hypot(dx, dy),
    centerX: (t1.clientX + t2.clientX) / 2,
    centerY: (t1.clientY + t2.clientY) / 2,
  };
}

/**
 * Captures the pointer/pinch focal point relative to the zoomable content's bounding rect.
 */
export function captureRelativeFocalPoint(
  contentRect: RectLike,
  clientX: number,
  clientY: number
): RelativeFocalPoint | null {
  if (contentRect.width <= 0 || contentRect.height <= 0) return null;
  return {
    relX: (clientX - contentRect.left) / contentRect.width,
    relY: (clientY - contentRect.top) / contentRect.height,
    clientX,
    clientY,
  };
}

/**
 * Computes scrollLeft / scrollTop delta needed after layout updates so that the
 * previously captured focal point stays directly under (clientX, clientY).
 */
export function computeFocalScrollDelta(
  afterContentRect: RectLike,
  focal: RelativeFocalPoint
): { deltaX: number; deltaY: number } {
  const targetClientX = afterContentRect.left + focal.relX * afterContentRect.width;
  const targetClientY = afterContentRect.top + focal.relY * afterContentRect.height;
  return {
    deltaX: targetClientX - focal.clientX,
    deltaY: targetClientY - focal.clientY,
  };
}

/**
 * Computes an auto-fit scale for images/SVGs so the entire media fits inside the
 * scroll viewport without horizontal or vertical clipping, while avoiding upscaling
 * tiny raster images beyond 100% by default (unless allowUpscale is true).
 */
export function computeMediaAutoFitScale(
  naturalSize: { width: number; height: number } | null,
  containerSize: { width: number; height: number },
  paddingPx = 24,
  allowUpscale = false
): number {
  if (!naturalSize || naturalSize.width <= 0 || naturalSize.height <= 0 || containerSize.width <= 0) {
    return 1.0;
  }
  const availW = Math.max(1, containerSize.width - paddingPx);
  const availH = Math.max(1, containerSize.height - paddingPx);
  const rawFit = Math.min(availW / naturalSize.width, availH / naturalSize.height);
  const maxFit = allowUpscale ? VIEWER_AUTO_FIT_MAX_SCALE : 1.0;
  const capped = Math.min(maxFit, Math.max(VIEWER_AUTO_FIT_MIN_SCALE, rawFit));
  return Math.max(VIEWER_AUTO_FIT_MIN_SCALE, Math.floor(capped * 100) / 100);
}
