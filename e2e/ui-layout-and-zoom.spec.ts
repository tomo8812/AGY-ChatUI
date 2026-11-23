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

      // 1. Accessibility policy: browser standard zoom is NOT globally disabled
      const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
      expect(viewportMeta, `[${vpLabel}] viewport meta must not forbid user zoom`).not.toContain(
        'user-scalable=no'
      );
      expect(viewportMeta, `[${vpLabel}] viewport meta must not lock maximum-scale=1`).not.toMatch(
        /maximum-scale=1(\.0)?(\b|,)/
      );

      // Ctrl+Wheel outside content containers (e.g. on .header-bar) must NOT be preventDefault-blocked
      const headerWheelPrevented = await page.evaluate(() => {
        const header = document.querySelector('.header-bar');
        if (!header) return false;
        const ev = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100,
        });
        header.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      expect(headerWheelPrevented, `[${vpLabel}] Ctrl+Wheel on header must not be blocked`).toBe(false);

      // 2. Chat screen initial layout audit
      await assertNoLayoutViolations(page, { screen: 'chat-initial', viewport: vpLabel });

      // 3. Chat body content-only text zoom
      const chromeBeforeChatZoom = await snapshotUiChrome(page, APP_CHROME_SELECTORS);
      const fontSizeBefore = await page
        .locator('.md-body')
        .first()
        .evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));

      if (isIphoneProject) {
        await dispatchTouchPinch(page, '.messages-scroll', 40, 72);
      } else {
        await dispatchCtrlWheel(page, '.messages-scroll', -120);
        await dispatchCtrlWheel(page, '.messages-scroll', -120);
      }

      await expect
        .poll(async () =>
          page
            .locator('.md-body')
            .first()
            .evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize))
        )
        .toBeGreaterThan(fontSizeBefore * 1.15);

      await page.locator('.chat-zoom-pill').waitFor({ state: 'visible' });
      const chromeAfterChatZoom = await snapshotUiChrome(page, APP_CHROME_SELECTORS);
      assertUiChromeStable(chromeBeforeChatZoom, chromeAfterChatZoom, `chat-zoom ${vpLabel}`);
      await assertNoLayoutViolations(page, { screen: 'chat-text-zoomed', viewport: vpLabel });

      // Reset chat text zoom via "画面に合わせる"
      await page.locator('.chat-zoom-pill button', { hasText: '画面に合わせる' }).click();
      await expect(page.locator('.chat-zoom-pill')).toBeHidden();
      const fontSizeReset = await page
        .locator('.md-body')
        .first()
        .evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));
      expect(Math.abs(fontSizeReset - fontSizeBefore)).toBeLessThanOrEqual(0.5);

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

      // Page 1 (far offscreen, previously visited) MUST NOT have re-rendered at the new scale
      const page1ScaleAfterScrollZoom = await page
        .locator('.pdf-page-slot[data-page-number="1"]')
        .getAttribute('data-rendered-scale');
      expect(
        page1ScaleAfterScrollZoom,
        `[${vpLabel}] Far-offscreen visited page 1 must not re-render when zooming at page 25`
      ).toBe(page1ScaleBeforeScrollZoom);

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

      // 8. Text-based viewers: Markdown + DiffPatchView + CodeViewer (Source) + TableViewer
      const TEXT_VIEWER_CHROME = ['.modal-head', '.text-zoom-toolbar', '.viewer-footer'] as const;

      const verifyTextViewerZoom = async (screenPrefix: string, contentSelector: string) => {
        await page.locator(contentSelector).first().waitFor({ state: 'visible' });
        await assertNoLayoutViolations(page, {
          screen: `${screenPrefix}-initial`,
          viewport: vpLabel,
          expectModal: true,
        });

        const chromeBefore = await snapshotUiChrome(page, TEXT_VIEWER_CHROME);
        const fontBefore = await page
          .locator(contentSelector)
          .first()
          .evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));

        if (isIphoneProject) {
          await dispatchTouchPinch(page, '.text-zoom-scroll', 40, 72);
        } else {
          await dispatchCtrlWheel(page, '.text-zoom-scroll', -120);
          await dispatchCtrlWheel(page, '.text-zoom-scroll', -120);
        }

        await expect
          .poll(async () =>
            page
              .locator(contentSelector)
              .first()
              .evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize))
          )
          .toBeGreaterThan(fontBefore * 1.15);

        const chromeAfter = await snapshotUiChrome(page, TEXT_VIEWER_CHROME);
        assertUiChromeStable(chromeBefore, chromeAfter, `${screenPrefix}-zoom ${vpLabel}`);
        await assertNoLayoutViolations(page, {
          screen: `${screenPrefix}-zoomed`,
          viewport: vpLabel,
          expectModal: true,
        });

        // Reset via "画面に合わせる"
        await page.locator('.text-zoom-toolbar button', { hasText: '画面に合わせる' }).click();
        await expect(page.locator('.text-zoom-scroll')).toHaveAttribute('data-text-zoom', '100');
      };

      // 8a. Markdown + Diff + Source (Code) with long filename and all header action buttons
      await openArtifactByFilename(page, FIXTURE_ARTIFACTS[4].filename);
      await verifyTextViewerZoom('markdown-viewer', '.text-zoom-scroll .md-body');

      // Switch to Diff (DiffPatchView)
      await page.locator('.modal-head-actions button', { hasText: '差分 (Diff)' }).click();
      await verifyTextViewerZoom('diff-viewer', '.text-zoom-scroll .diff-container');

      // Switch to Source (CodeViewer)
      await page.locator('.modal-head-actions button', { hasText: 'ソース' }).click();
      await verifyTextViewerZoom('code-viewer', '.text-zoom-scroll .code-pre');
      await closeActiveModal(page);

      // 8b. CSV Table Viewer (TableViewer)
      await openArtifactByFilename(page, FIXTURE_ARTIFACTS[5].filename);
      await verifyTextViewerZoom('table-viewer', '.text-zoom-scroll .viewer-table-scroll table');
      await closeActiveModal(page);

      // 8c. DOCX (real OOXML -> Mammoth HTML): scoped text zoom and stable viewer chrome
      const docxFixture = FIXTURE_ARTIFACTS.find((item) => item.id === FIXTURE_IDS.docxId);
      expect(docxFixture, `[${vpLabel}] DOCX test artifact must exist`).toBeDefined();
      await openArtifactByFilename(page, docxFixture!.filename);
      await expect(page.locator('.text-zoom-scroll .docx-preview p').first()).toContainText(
        'DOCX viewer zoom fixture'
      );
      await verifyTextViewerZoom('docx-viewer', '.text-zoom-scroll .docx-preview p');
      await closeActiveModal(page);

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
});
