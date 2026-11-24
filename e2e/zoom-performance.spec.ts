import { expect, test } from '@playwright/test';
import { FIXTURE_ARTIFACTS, installMockApi } from './fixtures/mockApi';

/**
 * NOTE: These Playwright measurements evaluate synthetic wheel/scroll events on
 * headless Desktop Chromium (CI-safe regression bounds). They do NOT replace
 * real iPhone Safari / Standalone PWA hardware verification.
 */
test.describe('PDF & Viewer Zoom Performance Verification', () => {
  test('120-page PDF continuous zoom & commit-settle frame time and redraw regression check', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'pc-chromium', 'Performance instrumentation runs on pc-chromium');
    await installMockApi(page, { authenticated: true });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.addInitScript(() => {
      const stats = {
        drawImageCalls: 0,
        canvasResizeCalls: 0,
        createImageBitmapCalls: 0,
        slotStyleMutations: 0,
        listDomMutations: 0,
        phase: 'idle' as 'idle' | 'gesture' | 'commit',
        gestureFrames: [] as number[],
        commitFrames: [] as number[],
        gestureLongTasksMs: [] as number[],
        commitLongTasksMs: [] as number[],
        lastFrameTs: 0,
      };
      (window as unknown as Record<string, unknown>).__zoomPerfStats = stats;

      const origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
        if (stats.phase !== 'idle') stats.drawImageCalls += 1;
        return (origDrawImage as (...a: unknown[]) => unknown).apply(this, args);
      };

      const widthDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
      if (widthDesc && widthDesc.set) {
        const origSet = widthDesc.set;
        Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
          configurable: true,
          enumerable: widthDesc.enumerable,
          get: widthDesc.get,
          set(v: number) {
            if (stats.phase !== 'idle') stats.canvasResizeCalls += 1;
            return origSet.call(this, v);
          },
        });
      }

      if (typeof window.createImageBitmap === 'function') {
        const origCreate = window.createImageBitmap.bind(window);
        window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
          if (stats.phase !== 'idle') stats.createImageBitmapCalls += 1;
          return origCreate(...args);
        }) as typeof createImageBitmap;
      }

      if (typeof PerformanceObserver !== 'undefined') {
        try {
          const po = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (stats.phase === 'gesture') {
                stats.gestureLongTasksMs.push(entry.duration);
              } else if (stats.phase === 'commit') {
                stats.commitLongTasksMs.push(entry.duration);
              }
            }
          });
          po.observe({ entryTypes: ['longtask'] });
        } catch {
          // longtask observer optional
        }
      }

      const tick = (ts: number) => {
        if (stats.phase !== 'idle') {
          if (stats.lastFrameTs > 0) {
            const dt = ts - stats.lastFrameTs;
            if (stats.phase === 'gesture') {
              stats.gestureFrames.push(dt);
            } else if (stats.phase === 'commit') {
              stats.commitFrames.push(dt);
            }
          }
          stats.lastFrameTs = ts;
        } else {
          stats.lastFrameTs = 0;
        }
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    });

    await page.goto('/');
    await page.locator('.header-bar').waitFor({ state: 'visible' });
    const hasMessage = await page.locator('.md-body').first().isVisible().catch(() => false);
    if (!hasMessage) {
      await page.locator('.sidebar .chat-item', { hasText: 'コンテンツ専用ズーム' }).first().click();
    }
    await page.locator('.artifact-pill').first().waitFor({ state: 'visible' });
    await page.locator('.artifact-pill', { hasText: FIXTURE_ARTIFACTS[0].filename }).first().click();
    await page.locator('.pdf-page-slot[data-page-number="1"] canvas').waitFor({ state: 'visible' });
    await expect
      .poll(async () => page.locator('.pdf-page-slot[data-page-number="1"]').getAttribute('data-rendered-scale'))
      .toBeTruthy();
    // Wait for initial async pageSizes metadata load (page 2 is landscape 842x595) to settle before recording zoom
    await expect
      .poll(async () =>
        page
          .locator('.pdf-page-slot[data-page-number="2"]')
          .evaluate((el) => (el as HTMLElement).style.getPropertyValue('--page-w').trim())
      )
      .toBe('842px');

    await page.evaluate(() => {
      const stats = (window as unknown as Record<string, any>).__zoomPerfStats;
      stats.drawImageCalls = 0;
      stats.canvasResizeCalls = 0;
      stats.createImageBitmapCalls = 0;
      stats.slotStyleMutations = 0;
      stats.listDomMutations = 0;
      stats.gestureFrames = [];
      stats.commitFrames = [];
      stats.gestureLongTasksMs = [];
      stats.commitLongTasksMs = [];
      stats.lastFrameTs = 0;
      stats.phase = 'gesture';

      const list = document.querySelector('.pdf-pages-list');
      if (list) {
        const mo = new MutationObserver((records) => {
          if (stats.phase === 'idle') return;
          for (const rec of records) {
            stats.listDomMutations += 1;
            if (
              rec.type === 'attributes' &&
              rec.attributeName === 'style' &&
              rec.target instanceof Element &&
              rec.target.classList.contains('pdf-page-slot')
            ) {
              stats.slotStyleMutations += 1;
            }
          }
        });
        mo.observe(list, { attributes: true, subtree: true, attributeFilter: ['style', 'data-rendered-scale'] });
        (window as unknown as Record<string, any>).__perfMo = mo;
      }
    });

    // Phase 1: 20-step continuous zoom gesture (~16ms interval)
    for (let i = 0; i < 20; i += 1) {
      await page.evaluate(() => {
        const scroll = document.querySelector('.pdf-canvas-scroll');
        if (!scroll) return;
        const r = scroll.getBoundingClientRect();
        scroll.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: -24,
            deltaMode: 0,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          })
        );
      });
      await page.waitForTimeout(16);
    }

    // Snapshot gesture phase and transition to commit-settle phase
    const duringGesture = await page.evaluate(() => {
      const stats = (window as unknown as Record<string, any>).__zoomPerfStats;
      const summarizeFrames = (frames: number[]) => {
        const sorted = [...frames].sort((a, b) => a - b);
        const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
        const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
        const max = sorted.length ? sorted[sorted.length - 1] : 0;
        const over50ms = sorted.filter((v) => v > 50).length;
        return {
          frameCount: sorted.length,
          avgFrameMs: Number(avg.toFixed(2)),
          p95FrameMs: Number(p95.toFixed(2)),
          maxFrameMs: Number(max.toFixed(2)),
          over50ms,
        };
      };
      const snapshot = {
        drawImageCalls: stats.drawImageCalls,
        canvasResizeCalls: stats.canvasResizeCalls,
        createImageBitmapCalls: stats.createImageBitmapCalls,
        slotStyleMutations: stats.slotStyleMutations,
        listDomMutations: stats.listDomMutations,
        longTaskCount: stats.gestureLongTasksMs.length,
        maxLongTaskMs: stats.gestureLongTasksMs.length ? Math.max(...stats.gestureLongTasksMs) : 0,
        ...summarizeFrames(stats.gestureFrames),
      };
      stats.phase = 'commit';
      stats.lastFrameTs = 0;
      return snapshot;
    });

    // Phase 2: Wait for gesture-end commit, layout finalize, and high-res visible canvas render
    await page.waitForTimeout(450);

    const duringCommitSettle = await page.evaluate(() => {
      const stats = (window as unknown as Record<string, any>).__zoomPerfStats;
      stats.phase = 'idle';
      (window as unknown as Record<string, any>).__perfMo?.disconnect();
      const sorted = [...stats.commitFrames].sort((a: number, b: number) => a - b);
      const avg = sorted.length ? sorted.reduce((s: number, v: number) => s + v, 0) / sorted.length : 0;
      const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
      const max = sorted.length ? sorted[sorted.length - 1] : 0;
      return {
        drawImageCalls: stats.drawImageCalls,
        canvasResizeCalls: stats.canvasResizeCalls,
        createImageBitmapCalls: stats.createImageBitmapCalls,
        slotStyleMutations: stats.slotStyleMutations,
        listDomMutations: stats.listDomMutations,
        frameCount: sorted.length,
        avgFrameMs: Number(avg.toFixed(2)),
        p95FrameMs: Number(p95.toFixed(2)),
        maxFrameMs: Number(max.toFixed(2)),
        longTaskCount: stats.commitLongTasksMs.length,
        maxLongTaskMs: stats.commitLongTasksMs.length ? Math.max(...stats.commitLongTasksMs) : 0,
      };
    });

    console.log('ZOOM_PERF_METRICS', JSON.stringify({ duringGesture, duringCommitSettle }));

    // 1. Structural assertions: zero per-page style thrash and zero canvas draws during gesture
    expect(duringGesture.slotStyleMutations, 'Zero .pdf-page-slot style mutations during gesture').toBe(0);
    expect(duringCommitSettle.slotStyleMutations, 'Zero .pdf-page-slot style mutations after commit').toBe(0);
    expect(duringGesture.drawImageCalls, 'Zero Canvas drawImage calls during gesture').toBe(0);
    expect(duringGesture.canvasResizeCalls, 'Zero Canvas resizes during gesture').toBe(0);
    expect(duringGesture.createImageBitmapCalls, 'Zero createImageBitmap calls during gesture').toBe(0);

    // 2. Post-commit rendering stays bounded to visible + immediate neighbor pages
    expect(duringCommitSettle.drawImageCalls, 'Visible page renders after commit').toBeGreaterThanOrEqual(1);
    expect(duringCommitSettle.drawImageCalls, 'Only visible + neighbor pages render after commit').toBeLessThanOrEqual(6);

    // 3. CI-safe frame time regression bounds for BOTH gesture and commit-settle phases
    expect(duringGesture.frameCount, 'Gesture rAF samples collected').toBeGreaterThanOrEqual(10);
    expect(duringGesture.p95FrameMs, 'Gesture p95 frame interval must stay smooth (< 80ms in CI)').toBeLessThan(80);
    expect(duringGesture.maxFrameMs, 'Gesture max frame interval must avoid jank (< 150ms in CI)').toBeLessThan(150);
    expect(duringCommitSettle.frameCount, 'Commit-settle rAF samples collected').toBeGreaterThanOrEqual(10);
    expect(duringCommitSettle.p95FrameMs, 'Commit-settle p95 frame interval must stay smooth (< 100ms in CI)').toBeLessThan(100);
    expect(duringCommitSettle.maxFrameMs, 'Commit-settle max frame interval must avoid stall (< 220ms in CI)').toBeLessThan(220);

    // 4. Repeated long-PDF scroll + zoom stress test across distant pages (25 -> 60 -> 100)
    for (const targetPage of [25, 60, 100]) {
      const slot = page.locator(`.pdf-page-slot[data-page-number="${targetPage}"]`);
      await slot.scrollIntoViewIfNeeded();
      await expect
        .poll(async () => slot.getAttribute('data-rendered-scale'))
        .toBeTruthy();

      const scaleBefore = Number(await slot.getAttribute('data-rendered-scale'));
      await page.evaluate(() => {
        const scroll = document.querySelector('.pdf-canvas-scroll');
        if (!scroll) return;
        const r = scroll.getBoundingClientRect();
        for (let step = 0; step < 5; step += 1) {
          scroll.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              ctrlKey: true,
              deltaY: -18,
              deltaMode: 0,
              clientX: r.left + r.width / 2,
              clientY: r.top + r.height / 2,
            })
          );
        }
      });

      await expect
        .poll(async () => Number(await slot.getAttribute('data-rendered-scale')))
        .toBeGreaterThan(scaleBefore);
    }

    // Reset via "画面に合わせる"
    await page.locator('.pdf-zoom-group button', { hasText: '画面に合わせる' }).click();
    await expect(page.locator('.pdf-canvas-scroll')).toHaveAttribute('data-fit-mode', 'auto');

    // 5. Mixed Portrait/Landscape page-level focal accuracy on middle (p.60 landscape) & near-end (p.115 portrait)
    for (const targetPage of [60, 115]) {
      await page.locator('.pdf-zoom-group button', { hasText: '画面に合わせる' }).click();
      await expect(page.locator('.pdf-canvas-scroll')).toHaveAttribute('data-fit-mode', 'auto');

      const slot = page.locator(`.pdf-page-slot[data-page-number="${targetPage}"]`);
      await slot.scrollIntoViewIfNeeded();
      await expect.poll(async () => slot.getAttribute('data-rendered-scale')).toBeTruthy();

      // Record exact focal point (relY = 0.45 inside targetPage) BEFORE transitioning auto -> manual zoom-in
      const focalBefore = await page.evaluate((pNum) => {
        const el = document.querySelector(`.pdf-page-slot[data-page-number="${pNum}"]`) as HTMLElement;
        const r = el.getBoundingClientRect();
        const clientX = r.left + r.width * 0.5;
        const clientY = r.top + r.height * 0.45;
        return { clientX, clientY, relY: 0.45 };
      }, targetPage);

      // Dispatch Ctrl+Wheel zoom-in directly on that focal point
      await page.evaluate(({ clientX, clientY }) => {
        const scroll = document.querySelector('.pdf-canvas-scroll');
        if (!scroll) return;
        for (let i = 0; i < 6; i += 1) {
          scroll.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              ctrlKey: true,
              deltaY: -40,
              deltaMode: 0,
              clientX,
              clientY,
            })
          );
        }
      }, focalBefore);

      // Wait for gesture commit
      await expect
        .poll(async () => page.locator('.pdf-canvas-scroll').getAttribute('data-fit-mode'))
        .toBe('manual');
      await expect
        .poll(async () => page.locator('.pdf-canvas-scroll').getAttribute('data-zoom-interacting'))
        .toBeNull();

      // Verify targetPage is STILL pinned right under focalBefore.clientY (never jumped to another page!)
      const focalAfterZoomIn = await page.evaluate(
        ({ pNum, expectedClientY, relY }) => {
          const el = document.querySelector(`.pdf-page-slot[data-page-number="${pNum}"]`) as HTMLElement;
          const r = el.getBoundingClientRect();
          const actualPointY = r.top + r.height * relY;
          return {
            errorY: Math.abs(actualPointY - expectedClientY),
            indicator: document.querySelector('.pdf-page-indicator')?.textContent?.trim() ?? '',
          };
        },
        { pNum: targetPage, expectedClientY: focalBefore.clientY, relY: focalBefore.relY }
      );
      expect(
        focalAfterZoomIn.errorY,
        `Page ${targetPage} auto->manual zoom-in focal Y drift must stay < 24px`
      ).toBeLessThan(24);
      expect(focalAfterZoomIn.indicator).toContain(`${targetPage} / 120`);

      // Also verify zoom-out focal stability from the zoomed state
      await page.evaluate(({ clientX, clientY }) => {
        const scroll = document.querySelector('.pdf-canvas-scroll');
        if (!scroll) return;
        for (let i = 0; i < 4; i += 1) {
          scroll.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              ctrlKey: true,
              deltaY: 40,
              deltaMode: 0,
              clientX,
              clientY,
            })
          );
        }
      }, focalBefore);

      await page.waitForTimeout(240);
      const focalAfterZoomOut = await page.evaluate(
        ({ pNum, expectedClientY, relY }) => {
          const el = document.querySelector(`.pdf-page-slot[data-page-number="${pNum}"]`) as HTMLElement;
          const r = el.getBoundingClientRect();
          return Math.abs(r.top + r.height * relY - expectedClientY);
        },
        { pNum: targetPage, expectedClientY: focalBefore.clientY, relY: focalBefore.relY }
      );
      expect(
        focalAfterZoomOut,
        `Page ${targetPage} manual zoom-out focal Y drift must stay < 24px`
      ).toBeLessThan(24);
    }

    // 6. Verify total live PDF canvas backing pixels stay within budget and released canvases clear data-rendered-scale
    const canvasBudgetCheck = await page.evaluate(() => {
      const slots = Array.from(document.querySelectorAll('.pdf-page-slot')) as HTMLElement[];
      let totalPixels = 0;
      let staleRenderedAttrCount = 0;
      for (const slot of slots) {
        const canvas = slot.querySelector('canvas');
        const pixels = canvas ? canvas.width * canvas.height : 0;
        totalPixels += pixels;
        if (pixels === 0 && slot.dataset.renderedScale) {
          staleRenderedAttrCount += 1;
        }
      }
      return { totalPixels, staleRenderedAttrCount };
    });
    expect(
      canvasBudgetCheck.totalPixels,
      'Total live PDF canvas backing pixels must stay within 24M px memory budget'
    ).toBeLessThanOrEqual(24_000_000);
    expect(
      canvasBudgetCheck.staleRenderedAttrCount,
      'Released canvases must clear data-rendered-scale'
    ).toBe(0);
  });
});
