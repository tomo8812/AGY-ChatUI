import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_ARTIFACTS, FIXTURE_IDS, installMockApi } from './fixtures/mockApi';
import {
  assertNoLayoutViolations,
  assertUiChromeStable,
  dispatchCtrlWheel,
  dispatchTouchPinch,
  snapshotUiChrome,
} from './helpers/layoutAudit';

const PC_VIEWPORTS = [
  { name: 'PC-1280x720', width: 1280, height: 720 },
  { name: 'PC-1366x768', width: 1366, height: 768 },
  { name: 'PC-1440x900', width: 1440, height: 900 },
  { name: 'PC-1920x1080', width: 1920, height: 1080 },
  { name: 'PC-2560x1440', width: 2560, height: 1440 },
] as const;

const IPHONE_VIEWPORTS = [
  { name: 'iPhone-375x812', width: 375, height: 812 },
  { name: 'iPhone-390x844', width: 390, height: 844 },
  { name: 'iPhone-430x932', width: 430, height: 932 },
] as const;

const APP_CHROME_SELECTORS = ['.header-bar', '.sidebar', '.composer-dock'] as const;
const VIEWER_CHROME_SELECTORS = ['.modal-head', '.pdf-viewer-toolbar', '.viewer-footer'] as const;

async function openChatAndWaitReady(page: Page, isMobile: boolean): Promise<void> {
  await page.goto('/');
  await page.locator('.header-bar').waitFor({ state: 'visible' });
  const hasMessage = await page.locator('.md-body').first().isVisible().catch(() => false);
  if (!hasMessage) {
    if (isMobile) {
      await page.locator('button[aria-label="メニューを開く"]').click();
      await page.locator('.sidebar.open').waitFor({ state: 'visible' });
    }
    await page.locator('.sidebar .chat-item', { hasText: 'コンテンツ専用ズーム' }).first().click();
  }
  await page.locator('.md-body').first().waitFor({ state: 'visible' });
  await page.locator('.artifact-pill').first().waitFor({ state: 'visible' });
}

async function openArtifactByFilename(page: Page, filename: string): Promise<void> {
  const card = page.locator('.artifact-pill', { hasText: filename }).first();
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.locator('.modal-card.viewer-modal').waitFor({ state: 'visible' });
}

async function closeActiveModal(page: Page): Promise<void> {
  await page.locator('.modal-card .modal-head button[aria-label="閉じる"]').first().click();
  await page.locator('.modal-card').waitFor({ state: 'hidden' });
}

const ALL_TARGETS = [
  ...PC_VIEWPORTS.map((vp) => ({ ...vp, project: 'pc-chromium' as const, isIphone: false })),
  ...IPHONE_VIEWPORTS.map((vp) => ({ ...vp, project: 'iphone-webkit' as const, isIphone: true })),
];

test.describe('Mechanical UI Layout & Content-Only Zoom Audit', () => {
  for (const vp of ALL_TARGETS) {
    test(`${vp.name}: chat, viewers, content-only zoom, pan, and modals`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== vp.project, `Viewport ${vp.name} runs on ${vp.project}`);

      const isIphoneProject = vp.isIphone;
      const vpLabel = `${vp.name} (${testInfo.project.name})`;
      await installMockApi(page, { authenticated: true });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openChatAndWaitReady(page, isIphoneProject);

      // 1. Platform-specific normal-screen zoom policy
      const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
      if (isIphoneProject) {
        // Mobile (iPhone Safari / PWA): normal screen locks page pinch zoom
        expect(viewportMeta, `[${vpLabel}] mobile viewport meta must lock zoom`).toContain('user-scalable=no');
        expect(viewportMeta, `[${vpLabel}] mobile viewport meta must lock maximum-scale=1.0`).toContain(
          'maximum-scale=1.0'
        );
      } else {
        // PC: browser standard zoom is NEVER restricted
        expect(viewportMeta, `[${vpLabel}] PC viewport meta must not forbid user zoom`).not.toContain(
          'user-scalable=no'
        );
        expect(viewportMeta, `[${vpLabel}] PC viewport meta must not lock maximum-scale=1`).not.toMatch(
          /maximum-scale=1(\.0)?(\b|,)/
        );
      }

      // 2. Chat screen initial layout audit & absence of obsolete custom chat text zoom
      await assertNoLayoutViolations(page, { screen: 'chat-initial', viewport: vpLabel });
      await expect(page.locator('.chat-zoom-pill')).toHaveCount(0);

      // 3. Verify normal-screen zoom behavior (blocked on mobile, native pass-through on PC)
      const chromeBeforeNormalZoom = await snapshotUiChrome(page, APP_CHROME_SELECTORS);
      const fontSizeBefore = await page
        .locator('.md-body')
        .first()
        .evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));

      if (isIphoneProject) {
        // Two-finger pinch & Safari gesturestart on normal UI must be prevented
        const normalPinchResults = await page.evaluate(() => {
          const checkTarget = (selector: string) => {
            const target = document.querySelector(selector);
            if (!target) return { selector, found: false, pinchPrevented: false, gesturePrevented: false, singleTouchPrevented: false };
            const r = target.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;

            const makeTouch = (id: number, x: number, y: number) => {
              try {
                return new Touch({ identifier: id, target, clientX: x, clientY: y, pageX: x, pageY: y });
              } catch {
                return { identifier: id, target, clientX: x, clientY: y, pageX: x, pageY: y };
              }
            };

            const dispatchTouch = (type: string, touches: unknown[]) => {
              let ev: Event;
              try {
                ev = new TouchEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  touches: touches as Touch[],
                  targetTouches: touches as Touch[],
                  changedTouches: touches as Touch[],
                });
              } catch {
                ev = new Event(type, { bubbles: true, cancelable: true });
                Object.defineProperty(ev, 'touches', { value: touches });
                Object.defineProperty(ev, 'targetTouches', { value: touches });
                Object.defineProperty(ev, 'changedTouches', { value: touches });
              }
              target.dispatchEvent(ev);
              return ev.defaultPrevented;
            };

            const pinchPrevented = dispatchTouch('touchmove', [
              makeTouch(1, cx - 40, cy),
              makeTouch(2, cx + 40, cy),
            ]);
            const singleTouchPrevented = dispatchTouch('touchmove', [makeTouch(1, cx, cy + 12)]);
            const gestureEv = new Event('gesturestart', { bubbles: true, cancelable: true });
            target.dispatchEvent(gestureEv);
            return {
              selector,
              found: true,
              pinchPrevented,
              gesturePrevented: gestureEv.defaultPrevented,
              singleTouchPrevented,
            };
          };
          return [
            checkTarget('.messages-scroll'),
            checkTarget('.header-bar'),
            checkTarget('.composer-dock'),
          ];
        });

        for (const res of normalPinchResults) {
          expect(res.found, `[${vpLabel}] ${res.selector} must exist`).toBe(true);
          expect(res.pinchPrevented, `[${vpLabel}] 2-finger pinch on ${res.selector} must be prevented`).toBe(true);
          expect(res.gesturePrevented, `[${vpLabel}] gesturestart on ${res.selector} must be prevented`).toBe(true);
          expect(
            res.singleTouchPrevented,
            `[${vpLabel}] single-finger touch on ${res.selector} must NOT be prevented`
          ).toBe(false);
        }

        // Composer input must still accept normal text typing
        const composerInput = page.locator('.composer-box textarea').first();
        await composerInput.fill('テスト入力');
        await expect(composerInput).toHaveValue('テスト入力');
        await composerInput.fill('');
      } else {
        // PC: Ctrl+Wheel on BOTH header and chat messages must NOT be prevented (native browser zoom preserved)
        const wheelChecks = await page.evaluate(() => {
          return ['.header-bar', '.messages-scroll'].map((selector) => {
            const el = document.querySelector(selector);
            if (!el) return { selector, found: false, prevented: true };
            const ev = new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              ctrlKey: true,
              deltaY: -100,
            });
            el.dispatchEvent(ev);
            return { selector, found: true, prevented: ev.defaultPrevented };
          });
        });
        for (const wc of wheelChecks) {
          expect(wc.found, `[${vpLabel}] ${wc.selector} must exist`).toBe(true);
          expect(wc.prevented, `[${vpLabel}] Ctrl+Wheel on ${wc.selector} must not be blocked`).toBe(false);
        }
      }

      // Neither mobile pinch nor PC Ctrl+Wheel should trigger any custom chat text zoom
      const fontSizeAfter = await page
        .locator('.md-body')
        .first()
        .evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));
      expect(Math.abs(fontSizeAfter - fontSizeBefore)).toBeLessThanOrEqual(0.5);
      await expect(page.locator('.chat-zoom-pill')).toHaveCount(0);
      const chromeAfterNormalZoom = await snapshotUiChrome(page, APP_CHROME_SELECTORS);
      assertUiChromeStable(chromeBeforeNormalZoom, chromeAfterNormalZoom, `normal-screen ${vpLabel}`);

      // 4. Multi-page Mixed Portrait/Landscape 120-page PDF Viewer
      await openArtifactByFilename(page, FIXTURE_ARTIFACTS[0].filename);
      await page.locator('.pdf-page-slot[data-page-number="1"] canvas').waitFor({ state: 'visible' });
      await expect(page.locator('.pdf-page-indicator')).toContainText('1 / 120');

      await assertNoLayoutViolations(page, {
        screen: 'pdf-120p-autofit',
        viewport: vpLabel,
        expectModal: true,
        viewerKind: 'pdf',
        expectAutoFit: true,
      });

      const pdfChromeBefore = await snapshotUiChrome(page, VIEWER_CHROME_SELECTORS);
      const pdfSlot1WidthBefore = await page
        .locator('.pdf-page-slot[data-page-number="1"]')
        .evaluate((el) => el.getBoundingClientRect().width);

      // Zoom PDF content (Ctrl+Wheel on PC / two-finger pinch on iPhone) + step zoom
      if (isIphoneProject) {
        await dispatchTouchPinch(page, '.pdf-canvas-scroll', 45, 95);
      } else {
        await dispatchCtrlWheel(page, '.pdf-canvas-scroll', -120);
        await dispatchCtrlWheel(page, '.pdf-canvas-scroll', -120);
      }
      await page.locator('.pdf-zoom-group button[aria-label="拡大"]').click();

      await expect
        .poll(async () =>
          page
            .locator('.pdf-page-slot[data-page-number="1"]')
            .evaluate((el) => el.getBoundingClientRect().width)
        )
        .toBeGreaterThan(pdfSlot1WidthBefore * 1.25);

      const pdfChromeAfter = await snapshotUiChrome(page, VIEWER_CHROME_SELECTORS);
      assertUiChromeStable(pdfChromeBefore, pdfChromeAfter, `pdf-zoom ${vpLabel}`);
      await assertNoLayoutViolations(page, {
        screen: 'pdf-120p-zoomed',
        viewport: vpLabel,
        expectModal: true,
        viewerKind: 'pdf',
        expectAutoFit: false,
      });

      // Verify post-zoom scroll & drag-to-pan (PC mouse drag) + continuous multi-page scroll
      const pdfScroll = page.locator('.pdf-canvas-scroll');
      if (!isIphoneProject) {
        const box = await pdfScroll.boundingBox();
        expect(box).not.toBeNull();
        const beforeDrag = await pdfScroll.evaluate((el) => ({
          left: el.scrollLeft,
          top: el.scrollTop,
          maxX: el.scrollWidth - el.clientWidth,
          maxY: el.scrollHeight - el.clientHeight,
        }));
        expect(beforeDrag.maxY).toBeGreaterThan(20);
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x + box!.width / 2 - 60, box!.y + box!.height / 2 - 90, { steps: 5 });
        await page.mouse.up();
        const afterDrag = await pdfScroll.evaluate((el) => ({
          left: el.scrollLeft,
          top: el.scrollTop,
        }));
        expect(
          afterDrag.top !== beforeDrag.top || afterDrag.left !== beforeDrag.left,
          `[${vpLabel}] PDF drag-to-pan must move scroll offsets`
        ).toBe(true);
      }

      // Reset to auto-fit ("画面に合わせる") and verify continuous vertical page scrolling
      await page.locator('.pdf-zoom-group button', { hasText: '画面に合わせる' }).click();
      await expect(pdfScroll).toHaveAttribute('data-fit-mode', 'auto');
      await pdfScroll.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(page.locator('.pdf-page-indicator')).toContainText('1 / 120');
      await page.locator('.pdf-nav-group button', { hasText: '次' }).click();
      await expect(page.locator('.pdf-page-indicator')).toContainText('2 / 120');

      // Page 2 is landscape (842x595): verify no horizontal clipping
      const page2Fits = await page.evaluate(() => {
        const sc = document.querySelector('.pdf-canvas-scroll');
        const p2 = document.querySelector('.pdf-page-slot[data-page-number="2"]');
        if (!sc || !p2) return false;
        return p2.getBoundingClientRect().width <= sc.clientWidth + 2;
      });
      expect(page2Fits, `[${vpLabel}] Landscape page 2 must fit horizontally without clipping`).toBe(true);

      // Long-PDF performance check: scroll far down (page 25) so previously visited page 1 is offscreen,
      // then zoom continuously and verify only visible/nearby pages re-render (page 1 keeps its old renderedScale).
      const page1ScaleBeforeScrollZoom = await page
        .locator('.pdf-page-slot[data-page-number="1"]')
        .getAttribute('data-rendered-scale');
      expect(page1ScaleBeforeScrollZoom, `[${vpLabel}] Page 1 should have been painted initially`).toBeTruthy();

      await page.locator('.pdf-page-slot[data-page-number="25"]').scrollIntoViewIfNeeded();
      await expect
        .poll(async () =>
          page.locator('.pdf-page-slot[data-page-number="25"]').getAttribute('data-rendered-scale')
        )
        .toBeTruthy();

      const page25InitialScale = await page
        .locator('.pdf-page-slot[data-page-number="25"]')
        .getAttribute('data-rendered-scale');

      // Continuous zoom while viewing page 25
      if (isIphoneProject) {
        await dispatchTouchPinch(page, '.pdf-canvas-scroll', 45, 85);
      } else {
        await dispatchCtrlWheel(page, '.pdf-canvas-scroll', -120);
        await dispatchCtrlWheel(page, '.pdf-canvas-scroll', -120);
      }
      await page.locator('.pdf-zoom-group button[aria-label="拡大"]').click();

      // Page 25 (visible) MUST re-render at the new higher scale
      await expect
        .poll(async () => {
          const cur = await page
            .locator('.pdf-page-slot[data-page-number="25"]')
            .getAttribute('data-rendered-scale');
          return cur && page25InitialScale ? Number(cur) > Number(page25InitialScale) : false;
        })
        .toBe(true);

      // Page 1 (far offscreen, > 14 pages away) must be released (data-rendered-scale cleared)
      // and must NEVER have re-rendered at the new zoomed scale.
      const page1ScaleAfterScrollZoom = await page
        .locator('.pdf-page-slot[data-page-number="1"]')
        .getAttribute('data-rendered-scale');
      expect(
        page1ScaleAfterScrollZoom,
        `[${vpLabel}] Far-offscreen page 1 must be released and clear data-rendered-scale when viewing page 25`
      ).toBeNull();

      await closeActiveModal(page);

      // 5. PPTX 16:9 Landscape Viewer with long filename
      await openArtifactByFilename(page, FIXTURE_ARTIFACTS[1].filename);
      await page.locator('.pdf-page-slot[data-page-number="1"] canvas').waitFor({ state: 'visible' });
      await expect(page.locator('.pdf-page-indicator')).toContainText('1 / 10');
      await assertNoLayoutViolations(page, {
        screen: 'pptx-16x9-autofit',
        viewport: vpLabel,
        expectModal: true,
        viewerKind: 'pptx',
        expectAutoFit: true,
      });
      await closeActiveModal(page);

      // 6. High-Res PNG Image Viewer (1600x900): auto-fit, zoom, drag-pan, reset
      await openArtifactByFilename(page, FIXTURE_ARTIFACTS[2].filename);
      await page.locator('.media-zoom-img').waitFor({ state: 'visible' });
      await expect
        .poll(async () =>
          page.locator('.media-zoom-img').evaluate((el) => (el as HTMLImageElement).complete && el.getBoundingClientRect().width > 50)
        )
        .toBe(true);

      await assertNoLayoutViolations(page, {
        screen: 'image-1600x900-autofit',
        viewport: vpLabel,
        expectModal: true,
        viewerKind: 'image',
        expectAutoFit: true,
      });

      const imgChromeBefore = await snapshotUiChrome(page, VIEWER_CHROME_SELECTORS);
      const imgWidthBefore = await page
        .locator('.media-zoom-img')
        .evaluate((el) => el.getBoundingClientRect().width);

      if (isIphoneProject) {
        await dispatchTouchPinch(page, '.media-zoom-scroll', 40, 90);
      } else {
        await dispatchCtrlWheel(page, '.media-zoom-scroll', -120);
        await dispatchCtrlWheel(page, '.media-zoom-scroll', -120);
      }
      await page.locator('.media-zoom-toolbar button[aria-label="拡大"]').click();

      await expect
        .poll(async () => page.locator('.media-zoom-img').evaluate((el) => el.getBoundingClientRect().width))
        .toBeGreaterThan(imgWidthBefore * 1.3);

      const imgChromeAfter = await snapshotUiChrome(page, VIEWER_CHROME_SELECTORS);
      assertUiChromeStable(imgChromeBefore, imgChromeAfter, `image-zoom ${vpLabel}`);
      await assertNoLayoutViolations(page, {
        screen: 'image-1600x900-zoomed',
        viewport: vpLabel,
        expectModal: true,
        viewerKind: 'image',
        expectAutoFit: false,
      });

      if (!isIphoneProject) {
        const imgScroll = page.locator('.media-zoom-scroll');
        const box = await imgScroll.boundingBox();
        expect(box).not.toBeNull();
        await imgScroll.evaluate((el) => {
          el.scrollLeft = 0;
          el.scrollTop = 0;
        });
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x + box!.width / 2 - 80, box!.y + box!.height / 2 - 60, { steps: 5 });
        await page.mouse.up();
        const moved = await imgScroll.evaluate((el) => el.scrollLeft > 0 || el.scrollTop > 0);
        expect(moved, `[${vpLabel}] Image drag-to-pan must move scroll offsets`).toBe(true);
      }

      await page.locator('.media-zoom-toolbar button', { hasText: '画面に合わせる' }).click();
      await expect(page.locator('.media-zoom-scroll')).toHaveAttribute('data-fit-mode', 'auto');
      await closeActiveModal(page);

      // 7. SVG Vector Diagram Viewer (1200x800): auto-fit & zoom
      await openArtifactByFilename(page, FIXTURE_ARTIFACTS[3].filename);
      await page.locator('.media-zoom-img').waitFor({ state: 'visible' });
      await expect
        .poll(async () =>
          page.locator('.media-zoom-img').evaluate((el) => (el as HTMLImageElement).complete && el.getBoundingClientRect().width > 50)
        )
        .toBe(true);
      await assertNoLayoutViolations(page, {
        screen: 'svg-1200x800-autofit',
        viewport: vpLabel,
        expectModal: true,
        viewerKind: 'svg',
        expectAutoFit: true,
      });
      await closeActiveModal(page);

      // 8. Unified shell viewers: Markdown + Diff + Code (Source) + CSV Table + DOCX + HTML
      const UNIFIED_VIEWER_CHROME = [
        '.modal-head',
        '.viewer-zoom-toolbar',
        '.viewer-controls-top',
        '.viewer-controls-bottom',
        '.viewer-footer',
      ] as const;

      const verifyUnifiedShellViewerZoom = async (
        screenPrefix: string,
        contentSelector: string,
        insideIframe = false
      ) => {
        await page.locator(contentSelector).first().waitFor({ state: 'visible' });
        await assertNoLayoutViolations(page, {
          screen: `${screenPrefix}-initial`,
          viewport: vpLabel,
          expectModal: true,
        });

        const chromeBefore = await snapshotUiChrome(page, UNIFIED_VIEWER_CHROME);
        const widthBefore = await page
          .locator('.viewer-zoom-content-inner')
          .first()
          .evaluate((el) => el.getBoundingClientRect().width);

        if (insideIframe) {
          // Verify sandbox="allow-scripts" security boundary is preserved (no allow-same-origin)
          const sandboxAttr = await page.locator('iframe.html-sandbox-frame').getAttribute('sandbox');
          expect(sandboxAttr, `[${vpLabel}] HTML iframe must preserve sandbox="allow-scripts"`).toBe('allow-scripts');

          const frame = page.frameLocator('iframe.html-sandbox-frame');
          await frame.locator('h1').waitFor({ state: 'visible' });
          // Verify original JS with literal "</body></html>" string executed intact after bridge injection
          await expect(frame.locator('#status')).toHaveAttribute('data-js-ok', '14');

          if (isIphoneProject) {
            // Multi-frame pinch across rAF boundaries (span 40 -> 50 -> 60 -> 72 = exact 1.80x ratio)
            // Proves live GPU preview transform never feeds back into pinch distance calculation
            await frame.locator('body').evaluate(async (body) => {
              const r = body.getBoundingClientRect();
              const cx = r.left + Math.max(80, r.width / 2);
              const cy = r.top + Math.max(80, r.height / 2);
              const makeTouch = (id: number, x: number, y: number) => {
                try {
                  return new Touch({ identifier: id, target: body, clientX: x, clientY: y, pageX: x, pageY: y });
                } catch {
                  return { identifier: id, target: body, clientX: x, clientY: y, pageX: x, pageY: y };
                }
              };
              const send = (type: string, touches: unknown[]) => {
                let ev: Event;
                try {
                  ev = new TouchEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    touches: touches as Touch[],
                    targetTouches: touches as Touch[],
                    changedTouches: touches as Touch[],
                  });
                } catch {
                  ev = new Event(type, { bubbles: true, cancelable: true });
                  Object.defineProperty(ev, 'touches', { value: touches });
                  Object.defineProperty(ev, 'targetTouches', { value: touches });
                  Object.defineProperty(ev, 'changedTouches', { value: touches });
                }
                body.dispatchEvent(ev);
              };
              const nextFrames = () =>
                new Promise<void>((res) =>
                  window.requestAnimationFrame(() => window.requestAnimationFrame(() => res()))
                );

              send('touchstart', [makeTouch(1, cx - 40, cy), makeTouch(2, cx + 40, cy)]);
              await nextFrames();
              for (const span of [50, 60, 72]) {
                send('touchmove', [makeTouch(1, cx - span, cy), makeTouch(2, cx + span, cy)]);
                await nextFrames();
              }
              send('touchend', []);
            });
          } else {
            await frame.locator('body').evaluate((body) => {
              const r = body.getBoundingClientRect();
              const cx = r.left + Math.max(80, r.width / 2);
              const cy = r.top + Math.max(80, r.height / 2);
              for (let i = 0; i < 2; i += 1) {
                body.dispatchEvent(
                  new WheelEvent('wheel', {
                    bubbles: true,
                    cancelable: true,
                    ctrlKey: true,
                    deltaY: -120,
                    deltaMode: 0,
                    clientX: cx,
                    clientY: cy,
                  })
                );
              }
            });
          }
        } else if (isIphoneProject) {
          await dispatchTouchPinch(page, '.viewer-zoom-scroll', 40, 72);
        } else {
          await dispatchCtrlWheel(page, '.viewer-zoom-scroll', -120);
          await dispatchCtrlWheel(page, '.viewer-zoom-scroll', -120);
        }

        await expect
          .poll(async () =>
            Number(await page.locator('.viewer-zoom-scroll').getAttribute('data-zoom-scale'))
          )
          .toBeGreaterThan(115);

        if (insideIframe && isIphoneProject) {
          // Wait for gesture commit and verify scale matches 72/40 = 180% without runaway feedback
          await expect
            .poll(async () =>
              page.locator('.viewer-zoom-scroll').getAttribute('data-zoom-interacting')
            )
            .toBeNull();
          const finalScale = Number(await page.locator('.viewer-zoom-scroll').getAttribute('data-zoom-scale'));
          expect(finalScale, `[${vpLabel}] HTML iframe multi-frame pinch must stay near 180%`).toBeGreaterThanOrEqual(170);
          expect(finalScale, `[${vpLabel}] HTML iframe multi-frame pinch must not compound preview transform`).toBeLessThanOrEqual(190);
        }

        await expect
          .poll(async () =>
            page
              .locator('.viewer-zoom-content-inner')
              .first()
              .evaluate((el) => el.getBoundingClientRect().width)
          )
          .toBeGreaterThan(widthBefore * 1.15);

        const chromeAfter = await snapshotUiChrome(page, UNIFIED_VIEWER_CHROME);
        assertUiChromeStable(chromeBefore, chromeAfter, `${screenPrefix}-zoom ${vpLabel}`);
        await assertNoLayoutViolations(page, {
          screen: `${screenPrefix}-zoomed`,
          viewport: vpLabel,
          expectModal: true,
        });

        // Reset via "画面に合わせる"
        await page.locator('.viewer-zoom-toolbar button', { hasText: '画面に合わせる' }).click();
        await expect(page.locator('.viewer-zoom-scroll')).toHaveAttribute('data-zoom-scale', '100');
        await expect(page.locator('.viewer-zoom-scroll')).toHaveAttribute('data-fit-mode', 'auto');
      };

      // 8a. Markdown + Diff + Source (Code) with long filename and all header action buttons
      await openArtifactByFilename(page, FIXTURE_ARTIFACTS[4].filename);
      await verifyUnifiedShellViewerZoom('markdown-viewer', '.viewer-zoom-scroll .md-body');

      // Switch to Diff (DiffPatchView)
      await page.locator('.modal-head-actions button', { hasText: '差分 (Diff)' }).click();
      await verifyUnifiedShellViewerZoom('diff-viewer', '.viewer-zoom-scroll .diff-container');

      // Switch to Source (CodeViewer)
      await page.locator('.modal-head-actions button', { hasText: 'ソース' }).click();
      await verifyUnifiedShellViewerZoom('code-viewer', '.viewer-zoom-scroll .code-pre');
      await closeActiveModal(page);

      // 8b. CSV Table Viewer (TableViewer)
      await openArtifactByFilename(page, FIXTURE_ARTIFACTS[5].filename);
      await verifyUnifiedShellViewerZoom('table-viewer', '.viewer-zoom-scroll .viewer-table-scroll table');
      await closeActiveModal(page);

      // 8c. DOCX (real OOXML -> Mammoth HTML)
      const docxFixture = FIXTURE_ARTIFACTS.find((item) => item.id === FIXTURE_IDS.docxId);
      expect(docxFixture, `[${vpLabel}] DOCX test artifact must exist`).toBeDefined();
      await openArtifactByFilename(page, docxFixture!.filename);
      await expect(page.locator('.viewer-zoom-scroll .docx-preview p').first()).toContainText(
        'DOCX viewer zoom fixture'
      );
      await verifyUnifiedShellViewerZoom('docx-viewer', '.viewer-zoom-scroll .docx-preview p');
      await closeActiveModal(page);

      // 8d. HTML Sandbox Viewer (real Ctrl+Wheel / 2-finger pinch dispatched INSIDE sandboxed iframe)
      const htmlFixture = FIXTURE_ARTIFACTS.find((item) => item.id === FIXTURE_IDS.htmlId);
      expect(htmlFixture, `[${vpLabel}] HTML test artifact must exist`).toBeDefined();
      await openArtifactByFilename(page, htmlFixture!.filename);
      await verifyUnifiedShellViewerZoom('html-viewer', '.viewer-zoom-scroll .html-sandbox-frame', true);
      await closeActiveModal(page);

      // Verify closing viewers left the normal screen completely unaffected
      const chromeAfterViewersClosed = await snapshotUiChrome(page, APP_CHROME_SELECTORS);
      assertUiChromeStable(chromeBeforeNormalZoom, chromeAfterViewersClosed, `post-viewer-close ${vpLabel}`);

      // 9. Quota popover, Skills modal, MCP modal, Settings modal (on representative tightest & widest viewports)
      if (vp.width === 375 || vp.width === 1280 || vp.width === 1920) {
        // Quota popover
        await page.locator('.header-center .pill-btn').click();
        await page.locator('.popover-panel').waitFor({ state: 'visible' });
        await assertNoLayoutViolations(page, { screen: 'quota-popover', viewport: vpLabel });
        await page.locator('.header-center .pill-btn').click();

        // Mobile sidebar drawer on iPhone
        if (isIphoneProject) {
          await page.locator('button[aria-label="メニューを開く"]').click();
          await page.locator('.sidebar.open').waitFor({ state: 'visible' });
          await assertNoLayoutViolations(page, { screen: 'mobile-sidebar', viewport: vpLabel });
        }

        // Settings modal
        await page.locator('.sidebar .sidebar-avatar-btn').click();
        await page.locator('.modal-card').waitFor({ state: 'visible' });
        await assertNoLayoutViolations(page, {
          screen: 'settings-modal',
          viewport: vpLabel,
          expectModal: true,
        });
        await closeActiveModal(page);

        if (isIphoneProject && (await page.locator('.sidebar-backdrop').isVisible().catch(() => false))) {
          await page.locator('.sidebar-backdrop').click({ position: { x: 350, y: 20 } });
          await page.locator('.sidebar.open').waitFor({ state: 'hidden' });
        }

        // Chat Skills modal
        await page.locator('button[aria-label="このチャットのスキル"]').click();
        await page.locator('.modal-card').waitFor({ state: 'visible' });
        await assertNoLayoutViolations(page, {
          screen: 'skills-modal',
          viewport: vpLabel,
          expectModal: true,
        });
        await closeActiveModal(page);

        // Chat MCP modal
        await page.locator('button[aria-label="このチャットのMCP（管理者）"]').click();
        await page.locator('.modal-card').waitFor({ state: 'visible' });
        await assertNoLayoutViolations(page, {
          screen: 'mcp-modal',
          viewport: vpLabel,
          expectModal: true,
        });
        await closeActiveModal(page);
      }
    });
  }

  test('auth screen passes layout checks on narrowest iPhone and standard PC viewports', async ({
    page,
  }, testInfo) => {
    const isIphoneProject = testInfo.project.name === 'iphone-webkit';
    const vp = isIphoneProject ? { name: 'iPhone-375x812', width: 375, height: 812 } : { name: 'PC-1280x720', width: 1280, height: 720 };

    await installMockApi(page, { authenticated: false });
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/');
    await page.locator('form').first().waitFor({ state: 'visible' });

    await assertNoLayoutViolations(page, {
      screen: 'auth-screen',
      viewport: `${vp.name} (${testInfo.project.name})`,
    });
  });

  test('PC browser zoom keeps desktop UI stable while actual window resize remains responsive', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'pc-chromium', 'PC browser zoom test runs on pc-chromium');

    await installMockApi(page, { authenticated: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await openChatAndWaitReady(page, false);

    const cdp = await page.context().newCDPSession(page);

    // Baseline 100%: desktop mode with visible sidebar and hidden mobile hamburger
    await expect(page.locator('html')).toHaveAttribute('data-layout-mode', 'desktop');
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('button[aria-label="メニューを開く"]')).toBeHidden();

    // Simulate PC browser zoom at 125%, 150%, 175%, 200% on a 1280x720 window
    for (const zoom of [1.25, 1.5, 1.75, 2.0]) {
      const zoomedW = Math.round(1280 / zoom);
      const zoomedH = Math.round(720 / zoom);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: zoomedW,
        height: zoomedH,
        deviceScaleFactor: zoom,
        mobile: false,
      });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await expect(page.locator('html')).toHaveAttribute('data-layout-mode', 'desktop');
      // Must NOT apply custom zoom-triggered CSS attributes or hide normal UI elements
      expect(await page.locator('html').getAttribute('data-browser-zoomed')).toBeNull();

      // Sidebar must remain visible on the left; mobile hamburger must stay hidden
      const sidebarBox = await page.locator('.sidebar').boundingBox();
      expect(sidebarBox, `Sidebar must remain visible at ${zoom * 100}% PC browser zoom`).not.toBeNull();
      expect(sidebarBox!.x).toBeGreaterThanOrEqual(0);
      expect(sidebarBox!.width).toBeGreaterThanOrEqual(180);
      await expect(page.locator('button[aria-label="メニューを開く"]')).toBeHidden();

      // Zero layout violations (no button wrapping, overlap, clipping, or horizontal overflow)
      await assertNoLayoutViolations(page, {
        screen: `pc-browser-zoom-${Math.round(zoom * 100)}pct`,
        viewport: `PC-1280x720@${Math.round(zoom * 100)}% (${zoomedW}x${zoomedH})`,
      });
    }

    // Now simulate an ACTUAL window resize to narrow width (800x720 at 100% zoom, dpr=1)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 800,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect(page.locator('html')).toHaveAttribute('data-layout-mode', 'mobile');
    await expect(page.locator('button[aria-label="メニューを開く"]')).toBeVisible();

    // Browser ZOOM-OUT (80%, 67%) on that narrow 800px PC window must NOT flip mobile -> desktop
    for (const zoomOut of [0.8, 0.67]) {
      const zoomedW = Math.round(800 / zoomOut);
      const zoomedH = Math.round(720 / zoomOut);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: zoomedW,
        height: zoomedH,
        deviceScaleFactor: zoomOut,
        mobile: false,
      });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await expect(page.locator('html')).toHaveAttribute('data-layout-mode', 'mobile');
    }

    // Return to 100% on 800px narrow window -> remains mobile
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 800,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect(page.locator('html')).toHaveAttribute('data-layout-mode', 'mobile');

    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.detach();
  });

  test('document viewer shrink geometry (50%/20%), text selection + pan coexistence, and no-op boundary zoom', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'pc-chromium', 'Runs on pc-chromium');

    await installMockApi(page, { authenticated: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await openChatAndWaitReady(page, false);

    // Open Markdown/Code/Diff artifact
    await openArtifactByFilename(page, FIXTURE_ARTIFACTS[4].filename);
    await page.locator('.viewer-zoom-scroll .md-body').waitFor({ state: 'visible' });

    const scroll = page.locator('.viewer-zoom-scroll');
    const stage = page.locator('.viewer-zoom-stage');

    // 1. Shrink down to ~50% (3 clicks of −: 100 -> 80 -> 64 -> 51) and verify stage width & zero phantom overflow
    const zoomOutBtn = page.locator('.viewer-zoom-toolbar button[aria-label="縮小"]');
    const zoomInBtn = page.locator('.viewer-zoom-toolbar button[aria-label="拡大"]');
    for (let i = 0; i < 3; i += 1) {
      await zoomOutBtn.click();
    }
    const shrunk50 = await page.evaluate(() => {
      const sc = document.querySelector('.viewer-zoom-scroll') as HTMLElement;
      const st = document.querySelector('.viewer-zoom-stage') as HTMLElement;
      return {
        scale: Number(sc.dataset.zoomScale),
        clientW: sc.clientWidth,
        scrollW: sc.scrollWidth,
        stageW: st.getBoundingClientRect().width,
      };
    });
    expect(shrunk50.scale).toBeLessThanOrEqual(55);
    expect(shrunk50.stageW).toBeLessThanOrEqual(shrunk50.clientW * 0.58);
    expect(shrunk50.scrollW, 'Shrunk 50% view must have zero phantom horizontal scroll overflow').toBeLessThanOrEqual(
      shrunk50.clientW + 2
    );

    // Continue shrinking to min scale (20%)
    for (let i = 0; i < 6; i += 1) {
      await zoomOutBtn.click();
    }
    const shrunk20 = await page.evaluate(() => {
      const sc = document.querySelector('.viewer-zoom-scroll') as HTMLElement;
      const st = document.querySelector('.viewer-zoom-stage') as HTMLElement;
      return {
        scale: Number(sc.dataset.zoomScale),
        clientW: sc.clientWidth,
        scrollW: sc.scrollWidth,
        stageW: st.getBoundingClientRect().width,
      };
    });
    expect(shrunk20.scale).toBe(20);
    expect(shrunk20.stageW).toBeLessThanOrEqual(shrunk20.clientW * 0.25);
    expect(shrunk20.scrollW, 'Shrunk 20% view must have zero phantom horizontal scroll overflow').toBeLessThanOrEqual(
      shrunk20.clientW + 2
    );

    // Extra no-op clicks at min boundary must not throw or corrupt scroll/stage
    await zoomOutBtn.click();
    await zoomOutBtn.click();
    expect(await scroll.getAttribute('data-zoom-scale')).toBe('20');

    // Reset and zoom IN to ~200%
    await page.locator('.viewer-zoom-toolbar button', { hasText: '画面に合わせる' }).click();
    await expect(scroll).toHaveAttribute('data-zoom-scale', '100');
    for (let i = 0; i < 3; i += 1) {
      await zoomInBtn.click();
    }
    await expect.poll(async () => Number(await scroll.getAttribute('data-zoom-scale'))).toBeGreaterThanOrEqual(190);

    // 2. Verify native text selection is NOT blocked inside zoomed Markdown viewer
    const textMousedownPrevented = await page.evaluate(() => {
      const p = document.querySelector('.viewer-zoom-scroll .md-body p');
      if (!p) return true;
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
      p.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(textMousedownPrevented, 'Left mousedown on zoomed document text must allow native text selection').toBe(false);

    // Verify Alt+drag STILL pans the zoomed document cleanly
    const box = await scroll.boundingBox();
    expect(box).not.toBeNull();
    await scroll.evaluate((el) => {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    });
    await page.keyboard.down('Alt');
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 - 80, box!.y + box!.height / 2 - 80, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Alt');

    const pannedOffsets = await scroll.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
    expect(pannedOffsets.left > 0 || pannedOffsets.top > 0, 'Alt+drag must pan zoomed document').toBe(true);

    // Verify stage still has valid dimensions after max-boundary no-op clicks
    for (let i = 0; i < 8; i += 1) {
      await zoomInBtn.click();
    }
    await expect(scroll).toHaveAttribute('data-zoom-scale', '500');
    const stageWidthAtMax = await stage.evaluate((el) => el.getBoundingClientRect().width);
    expect(stageWidthAtMax).toBeGreaterThan(2000);
    await zoomInBtn.click(); // no-op at max
    expect(await scroll.getAttribute('data-zoom-scale')).toBe('500');

    await closeActiveModal(page);
  });
});
