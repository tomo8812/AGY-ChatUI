import { describe, expect, it } from 'vitest';
import {
  createInitialLayoutTrackerState,
  resolveLayoutMode,
  type LayoutModeInput,
} from '../../web/src/utils/layoutMode.js';
import { computeStepZoomScale } from '../../web/src/utils/contentZoom.js';
import {
  commitPdfBitmapToCanvas,
  computeBoundedPdfDpr,
  isPdfRenderCancelledError,
  MAX_PDF_CANVAS_DIM,
  MAX_PDF_CANVAS_PIXELS,
  MAX_PDF_PAGE_RENDER_ATTEMPTS,
  MAX_TOTAL_PDF_CANVAS_PIXELS,
  PdfRenderJobTracker,
  selectPdfCanvasesToRelease,
} from '../../web/src/utils/pdfRenderBudget.js';
import { injectSandboxZoomBridge } from '../src/files/sandbox-bridge.js';

describe('Layout Mode DPR/Zoom Heuristic & Edge Cases', () => {
  it('does not misclassify a staggered DPR-first browser zoom event as a monitor DPI switch', () => {
    const initial: LayoutModeInput = {
      innerWidth: 1280,
      innerHeight: 720,
      outerWidth: 1280,
      screenAvailWidth: 1920,
      dpr: 1,
      isTouchMobile: false,
    };
    const state = createInitialLayoutTrackerState(initial);
    expect(resolveLayoutMode(initial, state).mode).toBe('desktop');

    // Tick 1: DPR updates to 1.5 before innerWidth shrinks
    const tick1 = resolveLayoutMode({ ...initial, dpr: 1.5, innerWidth: 1280 }, state);
    expect(tick1.mode).toBe('desktop');
    expect(state.baseDpr).toBe(1);

    // Tick 2: innerWidth shrinks to 853 (1280 / 1.5)
    const tick2 = resolveLayoutMode({ ...initial, dpr: 1.5, innerWidth: 853, innerHeight: 480 }, state);
    expect(tick2.mode).toBe('desktop');
    expect(tick2.effectiveWidth).toBeGreaterThanOrEqual(1275);
    expect(state.pendingMonitorDpr).toBeNull();
  });

  it('recovers layout on cold reload while already zoomed in OR zoomed out on 1x and 2x displays', () => {
    // 1x display reloaded at 150% zoom
    const reloaded1x: LayoutModeInput = {
      innerWidth: 853,
      innerHeight: 480,
      outerWidth: 1280,
      screenAvailWidth: 1920,
      dpr: 1.5,
      isTouchMobile: false,
    };
    const state1x = createInitialLayoutTrackerState(reloaded1x);
    expect(state1x.baseDpr).toBe(1);
    expect(resolveLayoutMode(reloaded1x, state1x).mode).toBe('desktop');

    // 2x Retina display reloaded at 150% zoom (dpr = 3.0)
    const reloaded2x: LayoutModeInput = {
      innerWidth: 853,
      innerHeight: 480,
      outerWidth: 1280,
      screenAvailWidth: 1920,
      dpr: 3.0,
      isTouchMobile: false,
    };
    const state2x = createInitialLayoutTrackerState(reloaded2x);
    expect(state2x.baseDpr).toBe(2);
    expect(resolveLayoutMode(reloaded2x, state2x).mode).toBe('desktop');

    // Narrow 800px PC window reloaded while zoomed OUT to 80% (innerWidth=1000, dpr=0.8)
    const reloadedZoomOut: LayoutModeInput = {
      innerWidth: 1000,
      innerHeight: 900,
      outerWidth: 800,
      screenAvailWidth: 1920,
      dpr: 0.8,
      isTouchMobile: false,
    };
    const stateZoomOut = createInitialLayoutTrackerState(reloadedZoomOut);
    expect(stateZoomOut.baseDpr).toBe(1);
    const snapZoomOut = resolveLayoutMode(reloadedZoomOut, stateZoomOut);
    expect(snapZoomOut.effectiveWidth).toBe(800);
    expect(snapZoomOut.mode).toBe('mobile');
  });

  it('prevents browser zoom-out (80%, 67%) from flipping a narrow PC window from mobile to desktop', () => {
    const narrowStart: LayoutModeInput = {
      innerWidth: 800,
      innerHeight: 720,
      outerWidth: 800,
      screenAvailWidth: 1920,
      dpr: 1,
      isTouchMobile: false,
    };
    const state = createInitialLayoutTrackerState(narrowStart);
    expect(resolveLayoutMode(narrowStart, state).mode).toBe('mobile');

    // Zoom out to 80%: innerWidth grows to 1000, dpr drops to 0.8
    const z80 = resolveLayoutMode({ ...narrowStart, innerWidth: 1000, innerHeight: 900, dpr: 0.8 }, state);
    expect(z80.effectiveWidth).toBe(800);
    expect(z80.mode).toBe('mobile');

    // Zoom out to 67%: innerWidth grows to 1194, dpr drops to 0.67
    const z67 = resolveLayoutMode({ ...narrowStart, innerWidth: 1194, innerHeight: 1075, dpr: 0.67 }, state);
    expect(z67.effectiveWidth).toBeGreaterThanOrEqual(795);
    expect(z67.effectiveWidth).toBeLessThanOrEqual(805);
    expect(z67.mode).toBe('mobile');

    // Return to 100%
    const z100 = resolveLayoutMode({ ...narrowStart, innerWidth: 800, innerHeight: 720, dpr: 1 }, state);
    expect(z100.mode).toBe('mobile');
  });

  it('recalibrates baseDpr after a settled monitor DPI switch (1x -> 2x) so window resize remains responsive', () => {
    const initial: LayoutModeInput = {
      innerWidth: 1280,
      innerHeight: 720,
      outerWidth: 1280,
      screenAvailWidth: 1920,
      dpr: 1,
      isTouchMobile: false,
    };
    const state = createInitialLayoutTrackerState(initial);
    resolveLayoutMode(initial, state);

    resolveLayoutMode({ ...initial, dpr: 2, innerWidth: 1280, outerWidth: 1280 }, state);
    const settled = resolveLayoutMode(
      { ...initial, dpr: 2, innerWidth: 1280, outerWidth: 1280, isSettledCheck: true },
      state
    );
    expect(state.baseDpr).toBe(2);
    expect(settled.mode).toBe('desktop');

    const resized = resolveLayoutMode(
      { ...initial, dpr: 2, innerWidth: 700, outerWidth: 700, isSettledCheck: false },
      state
    );
    expect(resized.mode).toBe('mobile');
  });

  it('handles overlapping 150% browser zoom and actual window resizing accurately', () => {
    const initial: LayoutModeInput = {
      innerWidth: 1280,
      innerHeight: 720,
      outerWidth: 1280,
      screenAvailWidth: 1920,
      dpr: 1,
      isTouchMobile: false,
    };
    const state = createInitialLayoutTrackerState(initial);
    resolveLayoutMode(initial, state);

    const wideResized = resolveLayoutMode(
      { ...initial, dpr: 1.5, innerWidth: 667, outerWidth: 1000 },
      state
    );
    expect(wideResized.mode).toBe('desktop');
    expect(wideResized.effectiveWidth).toBeGreaterThanOrEqual(995);

    const narrowResized = resolveLayoutMode(
      { ...initial, dpr: 1.5, innerWidth: 467, outerWidth: 700 },
      state
    );
    expect(narrowResized.mode).toBe('mobile');
    expect(narrowResized.effectiveWidth).toBeLessThanOrEqual(710);
  });
});

describe('Unified Viewer Step Zoom & Token-Aware Sandbox HTML Bridge', () => {
  it('applies identical multiplicative step factor across all scales including small auto-fit scales', () => {
    expect(computeStepZoomScale(1.0, 'in', 0.2, 5.0)).toBe(1.25);
    expect(computeStepZoomScale(1.0, 'out', 0.2, 5.0)).toBe(0.8);
    expect(computeStepZoomScale(0.4, 'in', 0.2, 5.0)).toBe(0.5);
    expect(computeStepZoomScale(4.8, 'in', 0.2, 5.0)).toBe(5.0);
    expect(computeStepZoomScale(0.21, 'out', 0.2, 5.0)).toBe(0.2);
  });

  it('injects sandbox zoom bridge strictly before real closing body/html without breaking JS strings, comments, textarea, or attributes', () => {
    const tricky = [
      '<!doctype html><html><body data-tpl="</body>">',
      '<!-- comment with </body> and </html> -->',
      '<textarea>literal </body> inside textarea</textarea>',
      '<script>const fragment = "</body></html>"; console.log(fragment);</script>',
      '<p>ok</p>',
      '</body></html>',
    ].join('');

    const injected = injectSandboxZoomBridge(tricky);
    // Original script literal, comment, textarea, and attribute must remain completely intact
    expect(injected).toContain('const fragment = "</body></html>";');
    expect(injected).toContain('<!-- comment with </body> and </html> -->');
    expect(injected).toContain('<textarea>literal </body> inside textarea</textarea>');
    expect(injected).toContain('data-tpl="</body>"');
    // Bridge must be inserted right before the REAL final </body></html>
    expect(injected).toMatch(/<p>ok<\/p><script>\(function\(\)\{.*agy-sandbox-zoom.*<\/script><\/body><\/html>$/);

    // Plain HTML fragment without body/html tags appends bridge safely
    const fragment = injectSandboxZoomBridge('<div>Fragment</div>');
    expect(fragment.startsWith('<div>Fragment</div><script>')).toBe(true);
    expect(fragment).toContain('agy-sandbox-zoom');
  });
});

describe('PDF Canvas Memory Budget, Bitmap Ownership, Error Tracking & Job Race Safety', () => {
  it('enforces dimension and pixel caps in computeBoundedPdfDpr even for extreme dimensions', () => {
    const dprGiant = computeBoundedPdfDpr(8000, 8000, 2);
    expect(Math.floor(8000 * dprGiant)).toBeLessThanOrEqual(MAX_PDF_CANVAS_DIM);
    expect(Math.floor(8000 * dprGiant) * Math.floor(8000 * dprGiant)).toBeLessThanOrEqual(MAX_PDF_CANVAS_PIXELS);
  });

  it('enforces total backing-pixel budget even when numPages <= 20 while preserving visible & active pages', () => {
    // 10 pages, each 6,000,000 px (= 60M px total > 24M px budget)
    const live = Array.from({ length: 10 }, (_, idx) => ({
      pageNum: idx + 1,
      pixels: 6_000_000,
    }));
    const visible = new Set<number>([5, 6]);
    const released = selectPdfCanvasesToRelease(live, visible, 5, 10, MAX_TOTAL_PDF_CANVAS_PIXELS);

    // Visible/active pages must never be released
    expect(released).not.toContain(5);
    expect(released).not.toContain(6);
    // Remaining pixels across kept pages must be <= MAX_TOTAL_PDF_CANVAS_PIXELS (4 pages = 24M px)
    const releasedSet = new Set(released);
    const remainingPixels = live
      .filter((e) => !releasedSet.has(e.pageNum))
      .reduce((sum, e) => sum + e.pixels, 0);
    expect(remainingPixels).toBeLessThanOrEqual(MAX_TOTAL_PDF_CANVAS_PIXELS);
    // Furthest pages (1, 10, 2, 9...) released first
    expect(released).toContain(1);
    expect(released).toContain(10);
  });

  it('releases unadopted oversized bitmaps and reports draw failure when 2D context is null', () => {
    let closedCount = 0;
    const makeFakeBitmap = () => ({
      width: 2400,
      height: 2400,
      close: () => {
        closedCount += 1;
      },
    });

    // Case 1: Oversized bitmap rejected by cache (adoptedByCache = false), valid canvas -> drew=true AND bitmap closed
    let drawn = false;
    const okCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        setTransform: () => {},
        clearRect: () => {},
        drawImage: () => {
          drawn = true;
        },
      }),
    } as unknown as HTMLCanvasElement;

    const r1 = commitPdfBitmapToCanvas(
      okCanvas,
      { bitmap: makeFakeBitmap() as unknown as ImageBitmap, cssWidth: 1200, cssHeight: 1200 },
      false
    );
    expect(r1.drew).toBe(true);
    expect(r1.releasedUnadoptedBitmap).toBe(true);
    expect(drawn).toBe(true);
    expect(closedCount).toBe(1);

    // Case 2: getContext('2d') returns null -> drew=false AND unadopted bitmap STILL closed
    const brokenCanvas = {
      width: 0,
      height: 0,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;

    const r2 = commitPdfBitmapToCanvas(
      brokenCanvas,
      { bitmap: makeFakeBitmap() as unknown as ImageBitmap, cssWidth: 1200, cssHeight: 1200 },
      false
    );
    expect(r2.drew).toBe(false);
    expect(r2.releasedUnadoptedBitmap).toBe(true);
    expect(closedCount).toBe(2);
  });

  it('prevents out-of-order cancelled job finally() from clobbering a re-enqueued job with the same page & key', () => {
    const tracker = new PdfRenderJobTracker();
    let job1Canceled = false;
    let job2Canceled = false;

    const job1 = tracker.startJob(5, 'doc@p5@s100@d100', () => {
      job1Canceled = true;
    });
    expect(tracker.runningCount).toBe(1);

    // Cancel job1 (simulating page briefly scrolling offscreen while getPage() is still pending)
    job1.cancel();
    expect(job1Canceled).toBe(true);
    // job1 is still winding down in background, so runningCount still reflects it!
    expect(tracker.runningCount).toBe(1);
    expect(tracker.hasActive(5)).toBe(false);

    // Page re-enters viewport with the EXACT SAME key -> job2 starts
    const job2 = tracker.startJob(5, 'doc@p5@s100@d100', () => {
      job2Canceled = true;
    });
    expect(tracker.runningCount).toBe(2);
    expect(tracker.getActive(5)).toBe(job2);

    // Old job1 finally finishes AFTER job2 started: must NOT delete job2 from activeByPage!
    tracker.finishJob(job1);
    expect(job2Canceled).toBe(false);
    expect(tracker.getActive(5)).toBe(job2);
    expect(tracker.runningCount).toBe(1);

    tracker.finishJob(job2);
    expect(tracker.hasActive(5)).toBe(false);
    expect(tracker.runningCount).toBe(0);
  });

  it('caps permanent render errors without infinite retries and classifies cancellations separately', () => {
    const tracker = new PdfRenderJobTracker();
    expect(isPdfRenderCancelledError({ name: 'RenderingCancelledException' })).toBe(true);
    expect(isPdfRenderCancelledError(new Error('Corrupt PDF stream'))).toBe(false);

    const key = 'doc@p3@s100@d100';
    for (let i = 0; i < MAX_PDF_PAGE_RENDER_ATTEMPTS; i += 1) {
      expect(tracker.hasExceededFailures(key)).toBe(false);
      tracker.recordFailure(key);
    }
    expect(tracker.hasExceededFailures(key)).toBe(true);
    expect(tracker.failedKeyCount).toBe(1);

    // Other pages remain unaffected
    expect(tracker.hasExceededFailures('doc@p4@s100@d100')).toBe(false);

    // Explicit user retry clears failure state
    tracker.clearAllFailures();
    expect(tracker.hasExceededFailures(key)).toBe(false);
    expect(tracker.failedKeyCount).toBe(0);
  });
});
