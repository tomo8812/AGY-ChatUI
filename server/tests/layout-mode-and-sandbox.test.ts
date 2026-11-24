import { describe, expect, it } from 'vitest';
import {
  createInitialLayoutTrackerState,
  resolveLayoutMode,
  type LayoutModeInput,
} from '../../web/src/utils/layoutMode.js';
import { computeStepZoomScale } from '../../web/src/utils/contentZoom.js';
import { injectSandboxZoomBridge } from '../src/routes/file-routes.js';

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
    expect(state.baseDpr).toBe(1); // Must NOT immediately overwrite baseDpr!

    // Tick 2: innerWidth shrinks to 853 (1280 / 1.5)
    const tick2 = resolveLayoutMode({ ...initial, dpr: 1.5, innerWidth: 853, innerHeight: 480 }, state);
    expect(tick2.mode).toBe('desktop');
    expect(tick2.effectiveWidth).toBeGreaterThanOrEqual(1275);
    expect(state.pendingMonitorDpr).toBeNull();
  });

  it('recovers desktop layout on cold reload while already browser-zoomed on 1x and 2x displays', () => {
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

    // Move window to 2x Retina monitor at 100% zoom (innerWidth & outerWidth stay 1280)
    resolveLayoutMode({ ...initial, dpr: 2, innerWidth: 1280, outerWidth: 1280 }, state);
    // Settled follow-up check confirms innerWidth stayed 1280
    const settled = resolveLayoutMode(
      { ...initial, dpr: 2, innerWidth: 1280, outerWidth: 1280, isSettledCheck: true },
      state
    );
    expect(state.baseDpr).toBe(2);
    expect(settled.mode).toBe('desktop');

    // Now actually resize window down to 700px on the 2x monitor
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

    // Zoom to 150% AND shrink unzoomed window to 1000px (CSS width 667px) -> stays desktop
    const wideResized = resolveLayoutMode(
      { ...initial, dpr: 1.5, innerWidth: 667, outerWidth: 1000 },
      state
    );
    expect(wideResized.mode).toBe('desktop');
    expect(wideResized.effectiveWidth).toBeGreaterThanOrEqual(995);

    // Zoom at 150% AND shrink unzoomed window to 700px (CSS width 467px) -> switches to mobile
    const narrowResized = resolveLayoutMode(
      { ...initial, dpr: 1.5, innerWidth: 467, outerWidth: 700 },
      state
    );
    expect(narrowResized.mode).toBe('mobile');
    expect(narrowResized.effectiveWidth).toBeLessThanOrEqual(710);
  });
});

describe('Unified Viewer Step Zoom & Sandbox HTML Bridge', () => {
  it('applies identical multiplicative step factor across all scales including small auto-fit scales', () => {
    expect(computeStepZoomScale(1.0, 'in', 0.25, 4.0)).toBe(1.25);
    expect(computeStepZoomScale(1.0, 'out', 0.25, 4.0)).toBe(0.8);
    expect(computeStepZoomScale(0.4, 'in', 0.25, 4.0)).toBe(0.5);
    expect(computeStepZoomScale(3.8, 'in', 0.25, 4.0)).toBe(4.0);
    expect(computeStepZoomScale(0.26, 'out', 0.25, 4.0)).toBe(0.25);
  });

  it('injects sandbox zoom bridge cleanly into HTML documents', () => {
    const withBody = injectSandboxZoomBridge('<html><body><h1>Hi</h1></body></html>');
    expect(withBody).toContain('agy-sandbox-zoom');
    expect(withBody).toMatch(/<\/script><\/body><\/html>$/);

    const fragment = injectSandboxZoomBridge('<div>Fragment</div>');
    expect(fragment).toContain('agy-sandbox-zoom');
    expect(fragment.startsWith('<div>Fragment</div>')).toBe(true);
  });
});
