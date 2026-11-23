/**
 * Layout mode & mobile normal-screen zoom guard.
 *
 * Responsibilities:
 * 1. Distinguish PC browser zoom from actual window resizing so PC browser zoom
 *    (Ctrl+Wheel / Ctrl +/-) never switches the desktop UI into mobile UI, while
 *    actual window resizing still adapts responsively.
 * 2. On mobile touch devices (iPhone Safari & standalone PWA), prevent pinch-zoom
 *    on the normal UI (chat, header, sidebar, composer, settings) while preserving
 *    single-finger scrolling, text selection, copy, long-press, typing, and
 *    file-viewer content zoom inside `[data-viewer-zoom-surface="true"]`.
 */

export type LayoutMode = 'desktop' | 'mobile';

export interface LayoutModeSnapshot {
  mode: LayoutMode;
  compact: boolean;
  short: boolean;
  browserZoomFactor: number;
  isTouchMobile: boolean;
  effectiveWidth: number;
  effectiveHeight: number;
}

const STANDARD_OS_DPRS = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
const VIEWER_ZOOM_SURFACE_SELECTOR = '[data-viewer-zoom-surface="true"]';

function nearestStandardDpr(value: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const candidate of STANDARD_OS_DPRS) {
    const d = Math.abs(candidate - value);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best !== null && bestDist <= 0.14 ? best : null;
}

export function detectTouchMobileDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  const coarseNoHover = window.matchMedia('(pointer: coarse) and (hover: none)').matches;
  if (coarseNoHover) return true;
  const coarseOnly = window.matchMedia('(pointer: coarse)').matches;
  const minScreen = Math.min(window.screen?.width || 9999, window.screen?.height || 9999);
  return coarseOnly && navigator.maxTouchPoints > 0 && minScreen <= 500;
}

function inferInitialBaseDpr(isTouchMobile: boolean): number {
  const dpr = window.devicePixelRatio || 1;
  if (isTouchMobile) return dpr;
  const iw = window.innerWidth;
  const ow = window.outerWidth;
  // If the user reloaded a PC tab while already browser-zoomed, outerWidth stays in
  // unzoomed OS pixels while innerWidth shrinks and dpr scales up proportionally.
  if (ow > 0 && iw > 0 && ow > iw * 1.08) {
    const outerRatio = ow / iw;
    const candidateBase = dpr / outerRatio;
    const snapped = nearestStandardDpr(candidateBase);
    if (snapped !== null) {
      return snapped;
    }
  }
  return dpr;
}

let installed = false;
let currentBaseDpr = 1;
let prevInnerWidth = 0;
let prevDpr = 1;

export function computeLayoutModeSnapshot(): LayoutModeSnapshot {
  const isTouchMobile = detectTouchMobileDevice();
  const iw = Math.max(1, window.innerWidth || 1280);
  const ih = Math.max(1, window.innerHeight || 720);
  const dpr = window.devicePixelRatio || 1;

  if (isTouchMobile) {
    return {
      mode: 'mobile',
      compact: iw <= 560,
      short: ih <= 560 || iw <= 480,
      browserZoomFactor: 1,
      isTouchMobile: true,
      effectiveWidth: iw,
      effectiveHeight: ih,
    };
  }

  // Detect monitor DPI switch (DPR changed significantly without inverse innerWidth change)
  if (
    prevInnerWidth > 0 &&
    Math.abs(dpr - prevDpr) > 0.2 &&
    Math.abs(iw - prevInnerWidth) <= 24
  ) {
    currentBaseDpr = dpr;
  }
  prevInnerWidth = iw;
  prevDpr = dpr;

  const zoomFromDpr = currentBaseDpr > 0 ? dpr / currentBaseDpr : 1;
  const clampedZoom = Math.max(0.5, Math.min(5, zoomFromDpr));

  // When zoomed in (> 1.05x), recover the unzoomed window width/height so browser zoom
  // does not collapse the desktop layout into mobile breakpoints.
  const scaleForLayout = clampedZoom > 1.04 ? clampedZoom : 1;
  const effectiveWidth = Math.round(iw * scaleForLayout);
  const effectiveHeight = Math.round(ih * scaleForLayout);

  return {
    mode: effectiveWidth <= 860 ? 'mobile' : 'desktop',
    compact: effectiveWidth <= 560,
    short: effectiveHeight <= 560 || effectiveWidth <= 480,
    browserZoomFactor: Math.round(clampedZoom * 100) / 100,
    isTouchMobile: false,
    effectiveWidth,
    effectiveHeight,
  };
}

export function applyLayoutModeToDocument(snapshot?: LayoutModeSnapshot): LayoutModeSnapshot {
  const next = snapshot ?? computeLayoutModeSnapshot();
  const root = document.documentElement;
  root.dataset.layoutMode = next.mode;
  root.dataset.deviceClass = next.isTouchMobile ? 'mobile-touch' : 'desktop';

  if (next.compact) {
    root.dataset.layoutCompact = 'true';
  } else {
    delete root.dataset.layoutCompact;
  }

  if (next.short) {
    root.dataset.layoutShort = 'true';
  } else {
    delete root.dataset.layoutShort;
  }

  if (!next.isTouchMobile && next.browserZoomFactor > 1.04) {
    root.dataset.browserZoomed = 'true';
    root.style.setProperty('--browser-zoom-factor', String(next.browserZoomFactor));
  } else {
    delete root.dataset.browserZoomed;
    root.style.removeProperty('--browser-zoom-factor');
  }

  return next;
}

function isInsideViewerZoomSurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(VIEWER_ZOOM_SURFACE_SELECTOR));
}

function applyMobileViewportMeta(): void {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.setAttribute(
    'content',
    'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
  );
}

/**
 * Initializes responsive layout mode tracking and mobile-only normal-screen pinch guard.
 * Safe to call once before React mounts so there is no layout flash.
 */
export function initLayoutModeAndMobileZoomGuard(): void {
  if (typeof window === 'undefined' || installed) return;
  installed = true;

  const isTouchMobile = detectTouchMobileDevice();
  currentBaseDpr = inferInitialBaseDpr(isTouchMobile);
  prevInnerWidth = window.innerWidth || 0;
  prevDpr = window.devicePixelRatio || 1;

  applyLayoutModeToDocument();

  let rafId: number | null = null;
  const scheduleSync = () => {
    if (rafId !== null) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      applyLayoutModeToDocument();
    });
  };

  window.addEventListener('resize', scheduleSync, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleSync, { passive: true });

  // Also observe DPR media query changes (browser zoom on some engines updates DPR cleanly)
  const watchDprChange = () => {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onDprChange = () => {
      scheduleSync();
      watchDprChange();
    };
    mq.addEventListener('change', onDprChange, { once: true });
  };
  if (typeof window.matchMedia === 'function') {
    watchDprChange();
  }

  // Mobile-only normal-screen pinch-zoom guard (iPhone Safari + Standalone PWA).
  // Never runs on PC so PC Ctrl+Wheel / Ctrl +/- browser zoom is completely untouched.
  if (isTouchMobile) {
    applyMobileViewportMeta();

    const preventNonViewerPinchTouch = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      if (isInsideViewerZoomSurface(e.target)) return;
      e.preventDefault();
    };

    const preventNonViewerGesture = (e: Event) => {
      if (isInsideViewerZoomSurface(e.target)) return;
      e.preventDefault();
    };

    document.addEventListener('touchstart', preventNonViewerPinchTouch, { passive: false });
    document.addEventListener('touchmove', preventNonViewerPinchTouch, { passive: false });
    document.addEventListener('gesturestart', preventNonViewerGesture, { passive: false });
    document.addEventListener('gesturechange', preventNonViewerGesture, { passive: false });
    document.addEventListener('gestureend', preventNonViewerGesture, { passive: false });
  }
}
