import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createTestServer, TestApiClient } from '../server/tests/helpers/test-harness.js';
import type { ArtifactRecord } from '../web/src/types';
import type { RichDocumentV1 } from '../shared/rich-schema';
import { buildSyntheticPdf, buildSyntheticPng } from './fixtures/syntheticAssets';
import { auditRegions, decodePng } from './helpers/visualAudit';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
const { zipSync, strToU8 } = serverRequire('fflate') as typeof import('../server/node_modules/fflate');

const BASE_HARNESS = 'http://127.0.0.1:4174/';
const SHA = 'b'.repeat(64);

const VIEWPORTS = [
  { width: 1280, height: 720, projects: ['pc-chromium'] },
  { width: 1440, height: 900, projects: ['pc-chromium'] },
  { width: 1920, height: 1080, projects: ['pc-chromium'] },
  { width: 375, height: 812, projects: ['pc-chromium', 'iphone-webkit'] },
  { width: 430, height: 932, projects: ['pc-chromium', 'iphone-webkit'] },
];

function buildMinimalXlsx(): Buffer {
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      ),
      '_rels/.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      'xl/workbook.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Apple</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>`,
      ),
    }),
  );
}

async function assertNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

test('Base ChatUI non-localhost HTTP (no crypto.subtle): PDF & CSV target pinning resolves via real server Pure-JS hashes', async ({ page }, info) => {
  test.skip(info.project.name !== 'pc-chromium');
  test.setTimeout(120_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  const server = await createTestServer({ installDocRuntime: 'off', sandboxMode: 'off', allowUnsandboxedDocWorkers: false });
  try {
    const client = new TestApiClient(server.baseUrl);
    const registered = await client.request<{ user: { id: string } }>('POST', '/api/auth/register', {
      username: 'http-compat',
      displayName: 'HTTP Compat',
      password: 'password123',
    });
    expect(registered.status).toBe(201);
    const userId = registered.data.user.id;
    const chatId = 'http-compat-chat';
    const workspaceDir = fs.mkdtempSync(path.join(server.dataRoot, 'http-ws-'));
    server.ctx.db.createChat({
      id: chatId,
      userId,
      projectId: null,
      title: 'HTTP Compat',
      workspaceDir,
      modelId: '',
      effortValue: '',
      projectContextVersion: 0,
    });

    const create = async (relPath: string, content: Buffer) =>
      (await server.ctx.artifactService.createArtifact({
        userId,
        scopeKind: 'chat',
        chatId,
        relPath,
        content,
        actorKind: 'user',
        actorId: userId,
      })).artifact;

    const pdfBytes = buildSyntheticPdf([
      { width: 595, height: 842, label: 'Quarterly Summary Page 1' },
      { width: 595, height: 842, label: 'Appendix Page 2' },
    ]);
    const pdfArt = await create('report.pdf', pdfBytes);
    const csvArt = await create('metrics.csv', Buffer.from('Metric,Value\nUsers,120\nRevenue,540\n'));
    const xlsxArt = await create('sales.xlsx', buildMinimalXlsx());

    // Verify Base ChatUI Pure-JS XLSX targetMetadata endpoint directly over HTTP
    const xlsxMetaRes = await client.request<{ target?: { expectedSheetStructHash?: string; expectedRangeValuesHash?: string } }>(
      'GET',
      `/api/files/${xlsxArt.id}/range?sheetId=1&rangeA1=A1:B2&targetMetadata=true`,
    );
    expect(xlsxMetaRes.status).toBe(200);
    expect(xlsxMetaRes.data.target?.expectedSheetStructHash).toMatch(/^[0-9a-f]{64}$/);
    expect(xlsxMetaRes.data.target?.expectedRangeValuesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(xlsxMetaRes.data.target?.expectedRangeValuesHash).not.toBe(xlsxArt.sha256);

    await page.route(
      (url) => url.origin === 'http://127.0.0.1:4174' && url.pathname.startsWith('/api/'),
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const response = await route.fetch({
          url: server.baseUrl + url.pathname + url.search,
          headers: {
            ...request.headers(),
            cookie: client.cookieHeader,
            'x-csrf-token': decodeURIComponent(client.csrfToken),
          },
          timeout: 60_000,
        });
        await route.fulfill({ response });
      },
    );

    const records: Record<string, ArtifactRecord> = { pdf: pdfArt, csv: csvArt };
    // Simulate non-localhost plain HTTP context where window.crypto.subtle is undefined!
    await page.addInitScript((recs) => {
      try {
        Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true });
      } catch {
        // fallback if non-configurable
      }
      const kind = new URLSearchParams(location.search).get('kind') ?? '';
      (window as Window & { __pr3aFixtureArtifact?: ArtifactRecord }).__pr3aFixtureArtifact = recs[kind];
    }, records);

    // 1. PDF target pinning without crypto.subtle
    await page.goto(BASE_HARNESS + '?kind=pdf');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => typeof window.crypto.subtle)).toBe('undefined');
    await page.getByRole('button', { name: '依頼', exact: true }).click();
    await page.getByRole('combobox', { name: 'PDF の選択方法' }).selectOption('region');
    const pdfRegionBtn = page.getByRole('button', { name: 'ページ 1の範囲', exact: true });
    await pdfRegionBtn.focus();
    await pdfRegionBtn.press('Enter');
    await pdfRegionBtn.press('ArrowRight');
    await pdfRegionBtn.press('ArrowDown');
    await pdfRegionBtn.press('Enter');
    await expect(page.locator('.workspace-selection')).toContainText('ページ 1');
    await expect(page.locator('.workspace-selection')).toContainText('領域');
    await page.getByRole('textbox', { name: '変更内容' }).fill('Verify heading region on page 1');
    await page.getByRole('button', { name: '依頼を追加' }).click();
    await expect(page.locator('.workspace-request-item')).toHaveCount(1);

    const pdfRequests = server.ctx.editRequestService.listRequests(userId, chatId, { artifactId: pdfArt.id });
    expect(pdfRequests).toHaveLength(1);
    expect(pdfRequests[0].selector.kind).toBe('pdf_region');
    const pdfSel = pdfRequests[0].selector as { expectedPageContentHash?: string; expectedRegionDigest?: string };
    expect(pdfSel.expectedPageContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pdfSel.expectedPageContentHash).not.toBe(pdfArt.sha256);
    expect(pdfSel.expectedRegionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(server.ctx.editRequestService.resolveRequestTarget(pdfRequests[0]).status).toBe('resolved');

    // 2. CSV target pinning with mandatory expectedRowCount/expectedColCount/expectedHeaderHash/expectedRangeValuesHash
    await page.goto(BASE_HARNESS + '?kind=csv');
    await page.getByRole('button', { name: '依頼', exact: true }).click();
    const grid = page.getByRole('grid', { name: '表データ' });
    await grid.getByRole('gridcell', { name: 'A2', exact: true }).click();
    await page.getByRole('button', { name: 'セルを対象にする' }).click();
    await expect(page.locator('.workspace-selection')).toContainText('A2');
    await page.getByRole('textbox', { name: '変更内容' }).fill('Update Users metric');
    await page.getByRole('button', { name: '依頼を追加' }).click();
    await expect(page.locator('.workspace-request-item')).toHaveCount(1);

    const csvRequests = server.ctx.editRequestService.listRequests(userId, chatId, { artifactId: csvArt.id });
    expect(csvRequests).toHaveLength(1);
    expect(csvRequests[0].selector).toMatchObject({
      kind: 'csv_range',
      expectedRowCount: 3,
      expectedColCount: 2,
    });
    const csvSel = csvRequests[0].selector as { expectedHeaderHash?: string; expectedRangeValuesHash?: string };
    expect(csvSel.expectedHeaderHash).toMatch(/^[0-9a-f]{64}$/);
    expect(csvSel.expectedRangeValuesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(server.ctx.editRequestService.resolveRequestTarget(csvRequests[0]).status).toBe('resolved');
    expect(consoleErrors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await server.cleanup();
  }
});

for (const vp of VIEWPORTS) {
  test(`PR 3A UI conformance (SourceEditor hljs, DOCX continuous canvas, PPTX full rail + 0-ghost, Rich partial sub) ${vp.width}x${vp.height}`, async ({ page }, info) => {
    test.skip(!vp.projects.includes(info.project.name));
    test.setTimeout(120_000);

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.setViewportSize({ width: vp.width, height: vp.height });

    // --- 1. SourceEditor multi-language syntax highlighting (Python + JSON, light & dark) ---
    const pyArtifact: ArtifactRecord = {
      id: 'fixture',
      userId: 'fixture-user',
      chatId: 'fixture-chat',
      messageId: null,
      runId: null,
      relPath: 'analysis.py',
      filename: 'analysis.py',
      previewKind: 'code',
      mimeType: 'text/x-python',
      sizeBytes: 120,
      sha256: SHA,
      revision: 1,
      source: 'generated',
      diffPatch: null,
      createdAt: 1,
      updatedAt: 1,
    };
    await page.route('**/api/files/fixture/**', async (route) => {
      const endpoint = new URL(route.request().url()).pathname.split('/').pop();
      if (endpoint === 'capabilities') {
        return route.fulfill({ json: { format: 'code', directEditUiSupported: true, targetPinSupported: true, operations: [{ operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' }] } });
      }
      if (endpoint === 'content') {
        return route.fulfill({
          body: 'def compute_total(items: list[int]) -> int:\n    # calculate sum\n    label = "total"\n    return sum(items) + 42\n',
          contentType: 'text/plain',
        });
      }
      return route.fulfill({ json: {} });
    });
    await page.route('**/api/chats/fixture-chat/edit-requests**', (r) => r.fulfill({ json: { requests: [] } }));
    await page.addInitScript((art) => {
      (window as Window & { __pr3aFixtureArtifact?: ArtifactRecord }).__pr3aFixtureArtifact = art;
    }, pyArtifact);
    await page.goto(BASE_HARNESS + '?kind=code');
    await page.getByRole('button', { name: '編集', exact: true }).click();
    await expect(page.locator('.cm-content .hljs-keyword').first()).toBeVisible();
    await expect(page.locator('.cm-content .hljs-string').first()).toBeVisible();
    await expect(page.locator('.cm-content .hljs-number').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`source-python-light-${vp.width}x${vp.height}.png`) });

    // Switch to dark theme and verify tokens remain rendered cleanly
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expect(page.locator('.cm-content .hljs-keyword').first()).toBeVisible();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

    // --- 2. DOCX continuous document canvas (130 blocks, no pagination buttons, chunk lazy-load + outline jump) ---
    await page.unrouteAll({ behavior: 'wait' });
    const docxArtifact: ArtifactRecord = {
      ...pyArtifact,
      relPath: 'manual.docx',
      filename: 'manual.docx',
      previewKind: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const allBlocks = Array.from({ length: 130 }, (_, i) => ({
      blockIndex: i,
      type: 'p',
      text: i === 0 ? 'Overview Heading' : i === 95 ? 'Appendix Section' : `Paragraph body line ${i + 1}`,
      style: i === 0 || i === 95 ? 'Heading1' : 'Normal',
      editableText: true,
    }));
    await page.route('**/api/files/fixture/**', async (route) => {
      const u = new URL(route.request().url());
      const endpoint = u.pathname.split('/').pop();
      if (endpoint === 'capabilities') {
        return route.fulfill({ json: { format: 'docx', directEditUiSupported: true, targetPinSupported: true, operations: [{ operation: 'docx.set_paragraph_text', availability: 'supported', scope: 'mcp_and_ui' }] } });
      }
      if (endpoint === 'structure') {
        return route.fulfill({
          json: {
            artifactId: 'fixture',
            revision: 1,
            sha256: SHA,
            headings: [
              { blockIndex: 0, level: 1, text: 'Overview Heading' },
              { blockIndex: 95, level: 1, text: 'Appendix Section' },
            ],
            blockCount: 130,
          },
        });
      }
      if (endpoint === 'range') {
        const start = Number(u.searchParams.get('start') ?? 0);
        const count = Number(u.searchParams.get('count') ?? 60);
        return route.fulfill({
          json: {
            artifactId: 'fixture',
            revision: 1,
            sha256: SHA,
            blocks: allBlocks.slice(start, start + count),
            headings: [
              { blockIndex: 0, level: 1, text: 'Overview Heading' },
              { blockIndex: 95, level: 1, text: 'Appendix Section' },
            ],
            blockCount: 130,
            hasMore: start + count < 130,
          },
        });
      }
      return route.fulfill({ json: {} });
    });
    await page.route('**/api/chats/fixture-chat/edit-requests**', (r) => r.fulfill({ json: { requests: [] } }));
    await page.addInitScript((art) => {
      (window as Window & { __pr3aFixtureArtifact?: ArtifactRecord }).__pr3aFixtureArtifact = art;
    }, docxArtifact);
    await page.goto(BASE_HARNESS + '?kind=docx');
    await expect(page.getByText('Overview Heading').first()).toBeVisible();
    // No 40-block pagination buttons
    await expect(page.getByRole('button', { name: '前の段落' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '次の段落' })).toHaveCount(0);
    // Jump directly to heading at block 95 across chunk boundary
    await page.getByRole('button', { name: '見出し一覧' }).click();
    await page.getByRole('button', { name: 'Appendix Section' }).click();
    await expect(page.locator('[data-word-block="95"]')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`docx-continuous-${vp.width}x${vp.height}.png`) });

    // --- 3. PPTX virtualized slide thumbnail rail (120 slides) + jump + 0-ghosting (move & remove) ---
    await page.unrouteAll({ behavior: 'wait' });
    const pptxArtifact: ArtifactRecord = {
      ...pyArtifact,
      relPath: 'deck.pptx',
      filename: 'deck.pptx',
      previewKind: 'pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const bgPng = buildSyntheticPng(640, 360);
    const slides = Array.from({ length: 120 }, (_, i) => ({ id: String(i + 1), part: `ppt/slides/slide${i + 1}.xml` }));
    await page.route('**/api/files/fixture/**', async (route) => {
      const u = new URL(route.request().url());
      const endpoint = u.pathname.split('/').pop();
      if (endpoint === 'capabilities') {
        return route.fulfill({
          json: {
            format: 'pptx',
            directEditUiSupported: true,
            targetPinSupported: true,
            operations: [
              { operation: 'pptx.set_shape_text', availability: 'supported', scope: 'mcp_and_ui' },
              { operation: 'pptx.set_shape_bounds', availability: 'supported', scope: 'mcp_and_ui' },
              { operation: 'pptx.remove_shape', availability: 'supported', scope: 'mcp_and_ui' },
              { operation: 'render_png', availability: 'supported', scope: 'mcp_and_ui' },
            ],
          },
        });
      }
      if (endpoint === 'structure') {
        return route.fulfill({
          json: { artifactId: 'fixture', revision: 1, sha256: SHA, slides, slideSize: { widthPt: 640, heightPt: 360 } },
        });
      }
      if (endpoint === 'range') {
        return route.fulfill({
          json: {
            artifactId: 'fixture',
            revision: 1,
            sha256: SHA,
            shapes: [
              {
                id: '10',
                type: 'sp',
                name: 'Title',
                text: 'Slide Title',
                zOrder: 1,
                basicGeometry: { kind: 'rect', fill: '#0284c7', stroke: '#0369a1', strokeWidthPt: 2 },
                transform: { geomBoundsPt: { x: 40, y: 24, width: 320, height: 60 } },
              },
              {
                id: '11',
                type: 'sp',
                name: 'RemovableBox',
                text: 'Delete Me',
                zOrder: 2,
                basicGeometry: { kind: 'rect', fill: '#dc2626', stroke: '#991b1b', strokeWidthPt: 2 },
                transform: { geomBoundsPt: { x: 400, y: 180, width: 160, height: 80 } },
              },
            ],
            slideSize: { widthPt: 640, heightPt: 360 },
          },
        });
      }
      if (endpoint === 'render' || endpoint === 'render-draft-sprite') {
        return route.fulfill({ body: bgPng, contentType: 'image/png', headers: { 'X-Artifact-Revision': '1', 'X-Artifact-Sha256': SHA } });
      }
      return route.fulfill({ json: {} });
    });
    await page.route('**/api/chats/fixture-chat/edit-requests**', (r) => r.fulfill({ json: { requests: [] } }));
    await page.addInitScript((art) => {
      (window as Window & { __pr3aFixtureArtifact?: ArtifactRecord }).__pr3aFixtureArtifact = art;
    }, pptxArtifact);
    await page.goto(BASE_HARNESS + '?kind=pptx');

    // Virtualized slide rail supports 120 slides while mounting only visible + overscan thumbnails!
    const navList = page.locator('.workspace-slide-nav-list');
    await expect(navList).toHaveAttribute('data-virtualized', 'true');
    await expect(navList).toHaveAttribute('data-total-slides', '120');
    const mountedCount = await page.locator('.workspace-slide-nav-item').count();
    expect(mountedCount).toBeGreaterThan(0);
    expect(mountedCount).toBeLessThan(35);

    // Jump directly to slide 105 (far beyond ±4) via slide-number jump control
    const jumpInput = page.getByLabel('スライド番号へ移動');
    await expect(jumpInput).toBeVisible();
    await jumpInput.fill('105');
    await jumpInput.press('Enter');
    await expect(page.locator('.workspace-slide-nav-item.active')).toContainText('105');

    // Return to slide 1 and verify layered Z-order + 0-ghosting on both move and removal
    await jumpInput.fill('1');
    await jumpInput.press('Enter');
    await page.getByRole('button', { name: '編集', exact: true }).click();
    const removableSvg = page.locator('svg[data-shape-id="11"]');
    await expect(removableSvg).toBeVisible();
    const stage = page.locator('.workspace-slide');
    const stageBox = await stage.boundingBox();
    const beforeMovePng = await stage.screenshot();

    // Move RemovableBox left by 40pt via Shift+ArrowLeft and confirm old right strip cleared with 0 ghosting
    const removableBtn = page.getByRole('button', { name: 'RemovableBox', exact: true });
    await removableBtn.click();
    for (let k = 0; k < 4; k++) await removableBtn.press('Shift+ArrowLeft');
    const afterMovePng = await stage.screenshot();
    if (stageBox && stageBox.width > 0 && stageBox.height > 0) {
      const sx = stageBox.width / 640;
      const sy = stageBox.height / 360;
      const moveAudit = auditRegions(
        decodePng(afterMovePng),
        decodePng(beforeMovePng),
        [
          { id: 'title', label: 'Title', rectPx: { x: 40 * sx, y: 24 * sy, width: 320 * sx, height: 60 * sy } },
          { id: 'vacatedRight', label: 'VacatedRight', rectPx: { x: 522 * sx, y: 180 * sy, width: 38 * sx, height: 80 * sy } },
        ],
      );
      expect(moveAudit.regions.find((r) => r.id === 'title')!.passed).toBe(true);
      expect(moveAudit.regions.find((r) => r.id === 'vacatedRight')!.metrics.mae).toBeGreaterThan(1.0);
    }

    const beforePng = await stage.screenshot();
    const cmdToggle = page.locator('.workspace-commandbar-toggle');
    if (await cmdToggle.isVisible()) {
      await cmdToggle.click();
    }
    await page.getByRole('combobox', { name: 'スライド編集操作' }).selectOption('pptx.remove_shape');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '適用', exact: true }).click();
    await expect(removableSvg).toHaveCount(0);
    await expect(page.locator('[data-shape-id="11"]')).toHaveCount(0);
    await expect(page.locator('.workspace-resize-handle')).toHaveCount(0);

    // Verify visually that the vacated bbox actually changed (no residual ghost of the red box!)
    const afterPng = await stage.screenshot();
    if (stageBox && stageBox.width > 0 && stageBox.height > 0) {
      const sx = stageBox.width / 640;
      const sy = stageBox.height / 360;
      const diffAudit = auditRegions(
        decodePng(afterPng),
        decodePng(beforePng),
        [
          { id: 'title', label: 'Title', rectPx: { x: 40 * sx, y: 24 * sy, width: 320 * sx, height: 60 * sy } },
          { id: 'removed', label: 'RemovableBox', rectPx: { x: 360 * sx, y: 180 * sy, width: 160 * sx, height: 80 * sy } },
        ],
      );
      // Title stayed visually identical while RemovableBox bbox genuinely cleared!
      const titleMetric = diffAudit.regions.find((r) => r.id === 'title')!;
      const removedMetric = diffAudit.regions.find((r) => r.id === 'removed')!;
      expect(titleMetric.passed).toBe(true);
      expect(removedMetric.metrics.mae).toBeGreaterThan(1.0);
    }
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`pptx-full-rail-${vp.width}x${vp.height}.png`) });

    // --- 3b. GridModule search revision/sheet change regression (stale search must NOT jump or leak error) ---
    await page.unrouteAll({ behavior: 'wait' });
    const xlsxArtifact: ArtifactRecord = {
      ...pyArtifact,
      relPath: 'book.xlsx',
      filename: 'book.xlsx',
      previewKind: 'table',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    let resolveDelayedSearch: (() => void) | null = null;
    await page.route('**/api/files/fixture/**', async (route) => {
      const u = new URL(route.request().url());
      const endpoint = u.pathname.split('/').pop();
      if (endpoint === 'capabilities') {
        return route.fulfill({ json: { format: 'xlsx', directEditUiSupported: true, targetPinSupported: true, operations: [{ operation: 'xlsx.set_cell', availability: 'supported', scope: 'mcp_and_ui' }] } });
      }
      if (endpoint === 'structure') {
        return route.fulfill({
          json: {
            artifactId: 'fixture',
            revision: 1,
            sha256: SHA,
            sheets: [
              { id: '1', name: 'Sheet1', part: 'xl/worksheets/sheet1.xml', rows: 10, cols: 5 },
              { id: '2', name: 'Sheet2', part: 'xl/worksheets/sheet2.xml', rows: 10, cols: 5 },
            ],
          },
        });
      }
      if (endpoint === 'range') {
        if (u.searchParams.has('gridSearch')) {
          await new Promise<void>((resolve) => { resolveDelayedSearch = resolve; setTimeout(resolve, 600); });
          return route.fulfill({ json: { artifactId: 'fixture', revision: 1, sha256: SHA, match: { row: 4, col: 2 } } });
        }
        return route.fulfill({
          json: {
            artifactId: 'fixture',
            revision: 1,
            sha256: SHA,
            cells: [{ address: 'A1', value: u.searchParams.get('sheetId') === '2' ? 'SecondSheet' : 'FirstSheet' }],
          },
        });
      }
      return route.fulfill({ json: {} });
    });
    await page.route('**/api/chats/fixture-chat/edit-requests**', (r) => r.fulfill({ json: { requests: [] } }));
    await page.addInitScript((art) => {
      (window as Window & { __pr3aFixtureArtifact?: ArtifactRecord }).__pr3aFixtureArtifact = art;
    }, xlsxArtifact);
    await page.goto(BASE_HARNESS + '?kind=xlsx');
    await expect(page.getByRole('gridcell', { name: 'A1', exact: true })).toHaveText('FirstSheet');
    await page.getByLabel('シート全体を検索').fill('Needle');
    await page.getByRole('button', { name: '次の一致', exact: true }).click();
    // Switch sheet while search is in-flight!
    await page.getByRole('button', { name: 'Sheet2', exact: true }).click();
    resolveDelayedSearch?.();
    await expect(page.getByRole('gridcell', { name: 'A1', exact: true })).toHaveText('SecondSheet');
    // Wait briefly for any late response to settle and verify no stale jump or error alert
    await page.waitForTimeout(150);
    await expect(page.locator('.workspace-cell-address')).toHaveText('A1');
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`grid-search-guard-${vp.width}x${vp.height}.png`) });

    // --- 4. Rich UI continuous slider partial subscription (0 DOM mutations on untouched heavy nodes) ---
    await page.unrouteAll({ behavior: 'wait' });
    const richDoc: RichDocumentV1 = {
      schemaVersion: 1,
      title: 'Partial Subscription Check',
      state: {
        threshold: 10,
        rows: Array.from({ length: 120 }, (_, i) => ({ name: `Item ${i + 1}`, val: i * 5 })),
        dots: Array.from({ length: 60 }, (_, i) => ({ x: 10 + (i % 15) * 12, y: 10 + Math.floor(i / 15) * 12 })),
      },
      computed: {
        fastVal: '$state.threshold * 10',
        heavyTotal: 'sum(pluck($state.rows, "val"))',
      },
      root: {
        id: 'root',
        type: 'stack',
        direction: 'col',
        children: [
          { id: 'slider', type: 'slider', bind: 'threshold', label: 'Threshold', min: 1, max: 50, step: 1 },
          { id: 'fast-kpi', type: 'kpi_card', label: 'Fast Metric', value: { expr: '$computed.fastVal' } },
          { id: 'heavy-kpi', type: 'kpi_card', label: 'Heavy Total', value: { expr: '$computed.heavyTotal' } },
          {
            id: 'heavy-svg',
            type: 'svg_scene',
            viewBox: '0 0 220 70',
            elements: [
              { tag: 'circle', repeat: { itemsExpr: '$state.dots', as: 'd' }, attrs: { cx: { expr: '$item.x' }, cy: { expr: '$item.y' }, r: 3, fill: '#397ac4' } },
            ],
          },
          {
            id: 'heavy-table',
            type: 'data_table',
            columns: [{ key: 'name', label: 'Name' }, { key: 'val', label: 'Val' }],
            rows: { expr: '$state.rows' },
          },
        ],
      },
    };
    await page.addInitScript((d) => {
      (window as Window & { __pr3aFixtureRichDocument?: RichDocumentV1 }).__pr3aFixtureRichDocument = d;
    }, richDoc);
    await page.goto(BASE_HARNESS + '?kind=rich');
    await expect(page.locator('[data-rich-node-id="heavy-svg"] svg circle')).toHaveCount(60);
    await expect(page.locator('[data-rich-node-id="heavy-table"] table')).toBeVisible();

    // Observe DOM mutations on untouched heavy KPI, SVG, and table during 20 continuous slider drags
    await page.evaluate(() => {
      const w = window as unknown as { __untouchedMutations: number };
      w.__untouchedMutations = 0;
      const obs = new MutationObserver((records) => { w.__untouchedMutations += records.length; });
      for (const id of ['heavy-kpi', 'heavy-svg', 'heavy-table']) {
        const el = document.querySelector(`[data-rich-node-id="${id}"]`);
        if (el) obs.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
      }
    });

    const slider = page.getByRole('slider');
    for (let v = 11; v <= 30; v++) {
      await slider.fill(String(v));
    }
    await expect(page.locator('[data-rich-node-id="fast-kpi"] .rich-kpi-value')).toContainText('300');
    const untouchedMutations = await page.evaluate(() => (window as unknown as { __untouchedMutations: number }).__untouchedMutations);
    expect(untouchedMutations).toBe(0);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`rich-partial-sub-${vp.width}x${vp.height}.png`) });
    expect(pageErrors).toEqual([]);
  });
}
