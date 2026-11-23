import { expect, test } from '@playwright/test';
import { FIXTURE_ARTIFACTS, installMockApi } from './fixtures/mockApi';

test.describe('PDF & Viewer Zoom Performance Verification', () => {
  test('120-page PDF continuous zoom avoids per-frame layout thrash and canvas redraws', async ({
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
        frameIntervals: [] as number[],
        recording: false,
        lastFrameTs: 0,
      };
      (window as unknown as Record<string, unknown>).__zoomPerfStats = stats;

      const origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
        if (stats.recording) stats.drawImageCalls += 1;
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
            if (stats.recording) stats.canvasResizeCalls += 1;
            return origSet.call(this, v);
          },
        });
      }

      if (typeof window.createImageBitmap === 'function') {
        const origCreate = window.createImageBitmap.bind(window);
        window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
          if (stats.recording) stats.createImageBitmapCalls += 1;
          return origCreate(...args);
        }) as typeof createImageBitmap;
      }

      const tick = (ts: number) => {
        if (stats.recording) {
          if (stats.lastFrameTs > 0) {
            stats.frameIntervals.push(ts - stats.lastFrameTs);
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
      stats.frameIntervals = [];
      stats.lastFrameTs = 0;
      stats.recording = true;

      const list = document.querySelector('.pdf-pages-list');
      if (list) {
        const mo = new MutationObserver((records) => {
          if (!stats.recording) return;
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

    // 20-step continuous zoom gesture (~16ms interval)
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

    const duringGesture = await page.evaluate(() => {
      const stats = (window as unknown as Record<string, any>).__zoomPerfStats;
      const intervals = [...stats.frameIntervals].sort((a, b) => a - b);
      const p95 = intervals.length ? intervals[Math.floor(intervals.length * 0.95)] : 0;
      const max = intervals.length ? intervals[intervals.length - 1] : 0;
      const avg = intervals.length ? intervals.reduce((s, v) => s + v, 0) / intervals.length : 0;
      return {
        drawImageCalls: stats.drawImageCalls,
        canvasResizeCalls: stats.canvasResizeCalls,
        createImageBitmapCalls: stats.createImageBitmapCalls,
        slotStyleMutations: stats.slotStyleMutations,
        listDomMutations: stats.listDomMutations,
        frameCount: intervals.length,
        avgFrameMs: Number(avg.toFixed(2)),
        p95FrameMs: Number(p95.toFixed(2)),
        maxFrameMs: Number(max.toFixed(2)),
      };
    });

    // Wait for gesture end commit + high-res render of visible pages only
    await page.waitForTimeout(450);

    const afterSettle = await page.evaluate(() => {
      const stats = (window as unknown as Record<string, any>).__zoomPerfStats;
      stats.recording = false;
      (window as unknown as Record<string, any>).__perfMo?.disconnect();
      return {
        drawImageCalls: stats.drawImageCalls,
        canvasResizeCalls: stats.canvasResizeCalls,
        createImageBitmapCalls: stats.createImageBitmapCalls,
        slotStyleMutations: stats.slotStyleMutations,
        listDomMutations: stats.listDomMutations,
      };
    });

    // Strict architectural assertions:
    // 1. Zero per-page inline style mutations during AND after zoom
    expect(duringGesture.slotStyleMutations, 'Zero .pdf-page-slot style mutations during gesture').toBe(0);
    expect(afterSettle.slotStyleMutations, 'Zero .pdf-page-slot style mutations after settle').toBe(0);
    // 2. Zero Canvas draws / reallocations / ImageBitmap allocations during continuous gesture
    expect(duringGesture.drawImageCalls, 'Zero Canvas drawImage calls during gesture').toBe(0);
    expect(duringGesture.canvasResizeCalls, 'Zero Canvas resizes during gesture').toBe(0);
    expect(duringGesture.createImageBitmapCalls, 'Zero createImageBitmap calls during gesture').toBe(0);
    // 3. Only visible + immediate neighbor pages render after gesture settles (never all 120)
    expect(afterSettle.drawImageCalls, 'At least visible page renders after settle').toBeGreaterThanOrEqual(1);
    expect(afterSettle.drawImageCalls, 'Only visible + neighbor pages render after settle').toBeLessThanOrEqual(6);

    // Repeated long-PDF scroll + zoom stress test across distant pages (25 -> 60 -> 100)
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
  });
});
