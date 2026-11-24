/**
 * Layout mode & mobile normal-screen zoom guard.
 *
 * Responsibilities:
 * 1. Distinguish PC browser zoom from actual window resizing so PC browser zoom
 *    (Ctrl+Wheel / Ctrl +/-) never switches the desktop UI into mobile UI, while
 *    actual window resizing still adapts responsively — WITHOUT applying any
 *    zoom-specific UI style overrides or hiding elements.
 * 2. On mobile touch devices (iPhone Safari & standalone PWA), prevent pinch-zoom
 *    on the normal UI (chat, header, sidebar, composer, settings) while preserving
 *    single-finger scrolling, text selection, copy, long-press, typing, and
 *    file-viewer content zoom inside `[data-viewer-zoom-surface="true"]`.
 *
 * Known browser-API estimation limits:
 * - Standard web APIs do not expose an explicit `browserZoomLevel` property.
 * - Zoom estimation relies on `window.devicePixelRatio` relative to a tracked OS
 *   baseline DPR and cross-checked with `window.outerWidth / window.innerWidth`.
 * - Edge cases where browsers obscure `outerWidth` (e.g. privacy-hardened browsers
 *   or docked DevTools panels inflating `outerWidth - innerWidth` on a cold reload
 *   while already zoomed) cannot be distinguished with 100% certainty.
 */

export type LayoutMode = 'desktop' | 'mobile';

export interface LayoutModeInput {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  screenAvailWidth: number;
  dpr: number;
  isTouchMobile: boolean;
  /** True when invoked from a settled follow-up check (not the initial transient event) */
  isSettledCheck?: boolean;
}

export interface LayoutModeTrackerState {
  baseDpr: number;
  prevInnerWidth: number;
  prevDpr: number;
  pendingMonitorDpr: number | null;
}

export interface LayoutModeSnapshot {
  mode: LayoutMode;
  narrow: boolean;
  compact: boolean;
  short: boolean;
  browserZoomFactor: number;
  isTouchMobile: boolean;
  effectiveWidth: number;
  effectiveHeight: number;
}

const STANDARD_OS_DPRS = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
const VIEWER_ZOOM_SURFACE_SELECTOR = '[data-viewer-zoom-surface="true"]';

export function nearestStandardDpr(value: number): number | null {
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

export function createInitialLayoutTrackerState(input: LayoutModeInput): LayoutModeTrackerState {
  const dpr = input.dpr > 0 ? input.dpr : 1;
  let baseDpr = dpr;

  if (!input.isTouchMobile) {
    const iw = Math.max(1, input.innerWidth);
    const ow = input.outerWidth;
    const availW = input.screenAvailWidth > 0 ? input.screenAvailWidth : 10000;
    // On a cold reload while already browser-zoomed (in or out), outerWidth stays in
    // unzoomed OS pixels while innerWidth scales inversely and dpr scales proportionally.
    if (ow > 0 && ow <= availW + 64 && Math.abs(ow / iw - 1) > 0.08) {
      const outerRatio = ow / iw;
      const snapped = nearestStandardDpr(dpr / outerRatio);
      if (snapped !== null) {
        baseDpr = snapped;
      }
    }
  }

  return {
    baseDpr,
    prevInnerWidth: Math.max(1, input.innerWidth),
    prevDpr: dpr,
    pendingMonitorDpr: null,
  };
}

/**
 * Pure, deterministic layout mode resolver.
 * Mutates `state` in place to track DPR baseline across resize / zoom / monitor changes.
 */
export function resolveLayoutMode(
  input: LayoutModeInput,
  state: LayoutModeTrackerState
): LayoutModeSnapshot {
  const iw = Math.max(1, input.innerWidth || 1280);
  const ih = Math.max(1, input.innerHeight || 720);
  const dpr = input.dpr > 0 ? input.dpr : 1;

  if (input.isTouchMobile) {
    return {
      mode: 'mobile',
      narrow: iw <= 760,
      compact: iw <= 560,
      short: ih <= 560 || iw <= 480,
      browserZoomFactor: 1,
      isTouchMobile: true,
      effectiveWidth: iw,
      effectiveHeight: ih,
    };
  }

  const availW = input.screenAvailWidth > 0 ? input.screenAvailWidth : 10000;
  const hasUsableOuter = input.outerWidth > 0 && input.outerWidth <= availW + 64;
  const outerRatio = hasUsableOuter ? input.outerWidth / iw : null;

  // Guard against misclassifying a staggered browser-zoom event (where DPR updates
  // one tick before innerWidth) as a monitor DPI switch:
  // 1. Only stage `pendingMonitorDpr` when DPR jumps to a standard OS DPR while
  //    innerWidth stayed constant AND outerWidth does not indicate zoom (in or out).
  // 2. Only commit the recalibrated `baseDpr` on a settled follow-up check where
  //    innerWidth STILL did not change inversely.
  const dprChanged = Math.abs(dpr - state.prevDpr) > 0.15;
  const widthStable = Math.abs(iw - state.prevInnerWidth) <= 24;
  const outerIndicatesZoom = outerRatio !== null && Math.abs(outerRatio - 1) > 0.08;

  if (dprChanged && widthStable && !outerIndicatesZoom && nearestStandardDpr(dpr) !== null) {
    state.pendingMonitorDpr = dpr;
  } else if (!widthStable || outerIndicatesZoom) {
    state.pendingMonitorDpr = null;
  }

  if (
    input.isSettledCheck &&
    state.pendingMonitorDpr !== null &&
    Math.abs(dpr - state.pendingMonitorDpr) <= 0.05 &&
    widthStable &&
    !outerIndicatesZoom
  ) {
    state.baseDpr = dpr;
    state.pendingMonitorDpr = null;
  }

  // Cross-check with outerWidth/innerWidth if clearly zoomed (in or out)
  if (outerIndicatesZoom && outerRatio !== null) {
    const inferredBase = nearestStandardDpr(dpr / outerRatio);
    if (inferredBase !== null && Math.abs(dpr / state.baseDpr - outerRatio) > 0.2) {
      state.baseDpr = inferredBase;
    }
  }

  state.prevInnerWidth = iw;
  state.prevDpr = dpr;

  const zoomFromDpr = state.baseDpr > 0 ? dpr / state.baseDpr : 1;
  const clampedZoom = Math.max(0.25, Math.min(5, zoomFromDpr));

  // Recover unzoomed window dimensions for BOTH zoom-in (> 1.04x) and zoom-out (< 0.96x)
  // so neither zooming in nor zooming out switches PC UI mode unexpectedly.
  const scaleForLayout = Math.abs(clampedZoom - 1) > 0.04 ? clampedZoom : 1;
  const effectiveWidth = Math.round(iw * scaleForLayout);
  const effectiveHeight = Math.round(ih * scaleForLayout);

  return {
    mode: effectiveWidth <= 860 ? 'mobile' : 'desktop',
    narrow: effectiveWidth <= 760,
    compact: effectiveWidth <= 560,
    short: effectiveHeight <= 560 || effectiveWidth <= 480,
    browserZoomFactor: Math.round(clampedZoom * 100) / 100,
    isTouchMobile: false,
    effectiveWidth,
    effectiveHeight,
  };
}

let installed = false;
let trackerState: LayoutModeTrackerState = {
  baseDpr: 1,
  prevInnerWidth: 1280,
  prevDpr: 1,
  pendingMonitorDpr: null,
};

function readWindowLayoutInput(isSettledCheck = false): LayoutModeInput {
  return {
    innerWidth: Math.max(1, window.innerWidth || 1280),
    innerHeight: Math.max(1, window.innerHeight || 720),
    outerWidth: window.outerWidth || 0,
    screenAvailWidth: window.screen?.availWidth || 0,
    dpr: window.devicePixelRatio || 1,
    isTouchMobile: detectTouchMobileDevice(),
    isSettledCheck,
  };
}

export function computeLayoutModeSnapshot(isSettledCheck = false): LayoutModeSnapshot {
  return resolveLayoutMode(readWindowLayoutInput(isSettledCheck), trackerState);
}

export function applyLayoutModeToDocument(snapshot?: LayoutModeSnapshot): LayoutModeSnapshot {
  const next = snapshot ?? computeLayoutModeSnapshot(false);
  const root = document.documentElement;
  root.dataset.layoutMode = next.mode;
  root.dataset.deviceClass = next.isTouchMobile ? 'mobile-touch' : 'desktop';

  if (next.narrow) {
    root.dataset.layoutNarrow = 'true';
  } else {
    delete root.dataset.layoutNarrow;
  }

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

  // Never set zoom-specific CSS hooks (e.g. data-browser-zoomed) so PC browser zoom
  // never triggers custom UI changes or hides elements.
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

  const initialInput = readWindowLayoutInput(false);
  trackerState = createInitialLayoutTrackerState(initialInput);
  applyLayoutModeToDocument(resolveLayoutMode(initialInput, trackerState));

  let rafId: number | null = null;
  let settleTimer: number | null = null;

  const scheduleSync = () => {
    if (rafId !== null) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      applyLayoutModeToDocument(computeLayoutModeSnapshot(false));
      if (trackerState.pendingMonitorDpr !== null) {
        if (settleTimer !== null) window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          applyLayoutModeToDocument(computeLayoutModeSnapshot(true));
        }, 160);
      }
    });
  };

  window.addEventListener('resize', scheduleSync, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleSync, { passive: true });

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
  if (initialInput.isTouchMobile) {
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
