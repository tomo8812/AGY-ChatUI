import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEPRECATED_SELECTOR_KINDS,
  TARGET_SELECTOR_REGISTRY,
  extractSupportedSelectorKinds,
  getRegisteredSelectorsForFormat,
  getRegisteredUiModesForFormat,
} from '../../shared/target-selection-registry.js';
import { FormatAdapterRegistry } from '../src/artifacts/adapters/registry.js';
import { readPptxSlideTargets, readPptxTargets } from '../src/artifacts/adapters/ooxml-target.js';
import { targetSelectorSchema } from '../src/artifacts/target-selector-schema.js';
import { computeTargetInspectionBudget } from '../src/artifacts/resource-governor.js';
import { strToU8, zipSync } from 'fflate';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

function buildMinimalPptx(slideText: string): Buffer {
  const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
  return Buffer.from(zipSync(Object.fromEntries(Object.entries({
    'ppt/presentation.xml': `<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${r}/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${slideText}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  }).map(([name, xml]) => [name, strToU8(xml)]))));
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

describe('Target Selection Registry & Revised §5.2 / §4.2 Conformance', () => {
  it('keeps artifact_capabilities and rich_capabilities in exact parity with TARGET_SELECTOR_REGISTRY', async () => {
    const srv = await createTestServer({ installDocRuntime: 'off', sandboxMode: 'off', allowUnsandboxedDocWorkers: false });
    cleanups.push(srv.cleanup);
    const registry = new FormatAdapterRegistry();

    const cases: Array<{ filename: string; previewKind: 'pptx' | 'docx' | 'table' | 'pdf' | 'image' | 'svg' | 'html' | 'markdown' | 'code' | 'diff' | 'mermaid' | 'video' | 'audio' | 'binary'; format: string }> = [
      { filename: 'deck.pptx', previewKind: 'pptx', format: 'pptx' },
      { filename: 'doc.docx', previewKind: 'docx', format: 'docx' },
      { filename: 'sheet.xlsx', previewKind: 'table', format: 'xlsx' },
      { filename: 'data.csv', previewKind: 'table', format: 'csv' },
      { filename: 'report.pdf', previewKind: 'pdf', format: 'pdf' },
      { filename: 'photo.png', previewKind: 'image', format: 'image' },
      { filename: 'icon.svg', previewKind: 'svg', format: 'svg' },
      { filename: 'page.html', previewKind: 'html', format: 'html' },
      { filename: 'readme.md', previewKind: 'markdown', format: 'markdown' },
      { filename: 'app.ts', previewKind: 'code', format: 'code' },
      { filename: 'change.diff', previewKind: 'diff', format: 'diff' },
      { filename: 'flow.mmd', previewKind: 'mermaid', format: 'mermaid' },
      { filename: 'clip.mp4', previewKind: 'video', format: 'media' },
      { filename: 'voice.wav', previewKind: 'audio', format: 'media' },
      { filename: 'blob.bin', previewKind: 'binary', format: 'binary' },
    ];

    for (const c of cases) {
      const caps = registry.buildCapabilitiesResponse({
        filename: c.filename,
        previewKind: c.previewKind,
        runtimeProfile: 'base_chatui',
        sandboxIsolation: 'sandbox_required_blocked',
        stagingIsolation: 'non_isolated_same_uid',
      });
      const expected = getRegisteredSelectorsForFormat(c.format, { filename: c.filename, previewKind: c.previewKind });
      const advertised = caps.operations
        .filter((op) => op.operation.startsWith('target_pin:'))
        .map((op) => op.operation.slice('target_pin:'.length));

      expect(advertised).toEqual(expected.map((e) => e.kind));
      expect(caps.targetPinSupported).toBe(expected.length > 0);
      for (const kind of DEPRECATED_SELECTOR_KINDS) {
        expect(advertised).not.toContain(kind);
      }
      const targetPinOp = caps.operations.find((op) => op.operation === 'target_pin');
      if (expected.length > 0) {
        expect(targetPinOp?.availability).toBe('supported');
        expect(targetPinOp?.notes ?? '').not.toMatch(/32 MiB|PR3B/i);
      }
    }

    const richCaps = srv.ctx.richContentService.getCapabilities();
    expect(richCaps.targetSelectors).toEqual(
      getRegisteredSelectorsForFormat('rich_block').map((entry) => entry.kind),
    );
    expect(richCaps.targetSelectors).not.toContain('rich_svg_element');
    expect(TARGET_SELECTOR_REGISTRY).toHaveLength(29);
  });

  it('rejects all abolished selector kinds for new requests while preserving saved history and allowing reconfirmation', async () => {
    const srv = await createTestServer({ installDocRuntime: 'off', sandboxMode: 'off', allowUnsandboxedDocWorkers: false });
    cleanups.push(srv.cleanup);
    const { ctx } = srv;
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'selector-user', 'user:selector@gmail.com');
    const chatId = (await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Selector lifecycle' })).data.chat.id;

    // 1. All abolished kinds are rejected by targetSelectorSchema
    for (const kind of DEPRECATED_SELECTOR_KINDS) {
      expect(targetSelectorSchema.safeParse({ kind, baseRevision: 1 }).success).toBe(false);
    }

    // 2. Create a Markdown artifact and verify abolished md_heading is rejected on createRequest
    const mdContent = Buffer.from('# Title\n\nBody paragraph line\n');
    const { artifact } = await ctx.artifactService.createArtifact({
      userId,
      chatId,
      scopeKind: 'chat',
      relPath: 'notes.md',
      content: mdContent,
      actorKind: 'user',
    });

    await expect(ctx.editRequestService.createRequest({
      userId,
      chatId,
      targetKind: 'artifact',
      artifactId: artifact.id,
      instruction: 'Edit heading',
      selector: {
        kind: 'md_heading',
        baseRevision: 1,
        headingSlug: 'title',
        headingLevel: 1,
        expectedHeadingHash: sha('# Title'),
        occurrenceIndex: 0,
      },
    })).rejects.toMatchObject({ statusCode: 400 });

    // 3. Simulate a persisted historical edit request with an abolished selector kind
    const legacyId = crypto.randomUUID();
    const now = Date.now();
    ctx.db.db.prepare(`
      INSERT INTO ai_edit_requests (
        id, user_id, chat_id, target_kind, artifact_id, rich_block_id, format,
        base_revision, selector_json, instruction, selected_content_snapshot,
        status, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, 'artifact', ?, NULL, 'markdown', 1, ?, ?, ?, 'draft', 1, ?, ?)
    `).run(
      legacyId,
      userId,
      chatId,
      artifact.id,
      JSON.stringify({
        kind: 'md_heading',
        baseRevision: 1,
        headingSlug: 'title',
        headingLevel: 1,
        expectedHeadingHash: sha('# Title'),
        occurrenceIndex: 0,
      }),
      'Legacy heading edit',
      '# Title',
      now,
      now,
    );

    // Saved request MUST remain visible in history
    const listed = ctx.editRequestService.listRequests(userId, chatId, { artifactId: artifact.id });
    expect(listed.some((r) => r.id === legacyId)).toBe(true);

    // Resolution MUST prompt re-selection with deprecated_selector_kind
    const saved = listed.find((r) => r.id === legacyId)!;
    const resolution = await ctx.editRequestService.resolveRequestTarget(saved);
    expect(resolution).toEqual({ status: 'needs_review', reason: 'deprecated_selector_kind' });

    // Reconfirming with a registered md_text_range selector succeeds and updates the request
    const reconfirmed = await ctx.editRequestService.reconfirmByUser({
      userId,
      chatId,
      requestId: legacyId,
      newBaseRevision: 1,
      newSelector: {
        kind: 'md_text_range',
        startLine: 1,
        endLine: 1,
        expectedSnippetHash: sha('# Title'),
        contextBeforeHash: sha(''),
        contextAfterHash: sha('\nBody paragraph line'),
        occurrenceIndex: 0,
      },
    });
    expect(reconfirmed.selector.kind).toBe('md_text_range');
    expect(reconfirmed.status).toBe('draft');
  });

  it('supports pptx_region with expectedSlideHash, validates slide bounds, and detects slide content drift', async () => {
    const srv = await createTestServer({ installDocRuntime: 'off', sandboxMode: 'off', allowUnsandboxedDocWorkers: false });
    cleanups.push(srv.cleanup);
    const { ctx } = srv;
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'pptx-user', 'user:pptx@gmail.com');
    const chatId = (await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'PPTX region' })).data.chat.id;

    const pptxV1 = buildMinimalPptx('Quarterly Review');
    const { slides, slideSize } = readPptxTargets(pptxV1);
    const slide1 = slides[0];
    const meta1 = readPptxSlideTargets(pptxV1, slide1.part);

    const { artifact } = await ctx.artifactService.createArtifact({
      userId,
      chatId,
      scopeKind: 'chat',
      relPath: 'deck.pptx',
      content: pptxV1,
      actorKind: 'user',
    });

    const regionSelector = targetSelectorSchema.parse({
      kind: 'pptx_region',
      baseRevision: 1,
      slideId: slide1.id,
      rectPt: [40, 40, 200, 80],
      expectedSlideHash: meta1.slideHash,
    });

    const req = await ctx.editRequestService.createRequest({
      userId,
      chatId,
      targetKind: 'artifact',
      artifactId: artifact.id,
      selector: regionSelector,
      instruction: 'Adjust title area spacing',
    });
    expect(req.selector.kind).toBe('pptx_region');

    // Out-of-bounds rectangle is rejected during resolution
    const outOfBounds = await ctx.artifactService.resolveTargetOnArtifact(userId, artifact.id, {
      ...regionSelector,
      rectPt: [slideSize!.widthPt - 10, 40, 50, 50],
    });
    expect(outOfBounds).toMatchObject({ status: 'needs_review', reason: 'slide_region_out_of_bounds' });

    // Changing slide content invalidates pptx_region -> needs_review
    const pptxV2 = buildMinimalPptx('Annual Summary');
    const adapter = new FormatAdapterRegistry().resolve('deck.pptx', 'pptx');
    const afterDrift = adapter.resolveTarget(pptxV2, regionSelector, {
      filename: 'deck.pptx',
      relPath: 'deck.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    expect(afterDrift.status).toBe('needs_review');
  });

  it('scales dynamic target inspection budget for 12GB hosts and protects low-RAM hosts', () => {
    // 12GB RAM host with ~9GB available easily accommodates a 64 MiB document
    const largeBudget = computeTargetInspectionBudget({
      inputBytes: 64 * 1024 * 1024,
      isDocumentOrMedia: true,
      memAvailableMb: 9_000,
    });
    expect(largeBudget.rssLimitMb).toBeGreaterThan(640);
    expect(largeBudget.maxOldSpaceMb).toBeGreaterThan(256);
    expect(largeBudget.timeoutMs).toBe(60_000);

    // Low-RAM host (<500MB available) rejects heavy target inspection cleanly with 503 RESOURCE_BUSY
    expect(() => computeTargetInspectionBudget({
      inputBytes: 64 * 1024 * 1024,
      isDocumentOrMedia: true,
      memAvailableMb: 350,
    })).toThrow(/メモリが不足/);
  });

  it('derives UI selection modes exclusively from TARGET_SELECTOR_REGISTRY intersected with artifact_capabilities', () => {
    const registry = new FormatAdapterRegistry();
    const cases: Array<{
      format: string;
      filename: string;
      previewKind: 'pptx' | 'docx' | 'table' | 'pdf' | 'markdown' | 'code';
      expectedModeIds: string[];
      dropSelectorKind?: string;
      expectedAfterDrop?: string[];
    }> = [
      {
        format: 'pptx',
        filename: 'deck.pptx',
        previewKind: 'pptx',
        expectedModeIds: ['element', 'slide', 'pin', 'region'],
        dropSelectorKind: 'pptx_region',
        expectedAfterDrop: ['element', 'slide', 'pin'],
      },
      {
        format: 'pdf',
        filename: 'doc.pdf',
        previewKind: 'pdf',
        expectedModeIds: ['page', 'pin', 'region'],
        dropSelectorKind: 'pdf_region',
        expectedAfterDrop: ['page', 'pin'],
      },
      {
        format: 'docx',
        filename: 'doc.docx',
        previewKind: 'docx',
        expectedModeIds: ['element'],
        dropSelectorKind: 'docx_paragraph',
        expectedAfterDrop: [],
      },
      {
        format: 'xlsx',
        filename: 'sheet.xlsx',
        previewKind: 'table',
        expectedModeIds: ['range', 'row', 'col', 'sheet'],
        dropSelectorKind: 'xlsx_sheet',
        expectedAfterDrop: ['range', 'row', 'col'],
      },
      {
        format: 'csv',
        filename: 'data.csv',
        previewKind: 'table',
        expectedModeIds: ['range', 'row', 'col'],
        dropSelectorKind: 'csv_row_col',
        expectedAfterDrop: ['range'],
      },
      {
        format: 'markdown',
        filename: 'notes.md',
        previewKind: 'markdown',
        expectedModeIds: ['line_range'],
      },
      {
        format: 'code',
        filename: 'app.ts',
        previewKind: 'code',
        expectedModeIds: ['line_range', 'char_range'],
        dropSelectorKind: 'code_char_range',
        expectedAfterDrop: ['line_range'],
      },
    ];

    for (const c of cases) {
      const caps = registry.buildCapabilitiesResponse({
        filename: c.filename,
        previewKind: c.previewKind,
        runtimeProfile: 'base_chatui',
        sandboxIsolation: 'sandbox_required_blocked',
        stagingIsolation: 'non_isolated_same_uid',
      });
      const advertisedKinds = extractSupportedSelectorKinds(caps.operations);
      const modes = getRegisteredUiModesForFormat(c.format, {
        filename: c.filename,
        previewKind: c.previewKind,
        allowedSelectorKinds: advertisedKinds,
      });
      expect(modes.map((m) => m.id)).toEqual(c.expectedModeIds);

      if (c.dropSelectorKind && c.expectedAfterDrop) {
        const filteredOps = caps.operations.filter((op) => op.operation !== `target_pin:${c.dropSelectorKind}`);
        const filteredKinds = extractSupportedSelectorKinds(filteredOps);
        const filteredModes = getRegisteredUiModesForFormat(c.format, {
          filename: c.filename,
          previewKind: c.previewKind,
          allowedSelectorKinds: filteredKinds,
        });
        expect(filteredModes.map((m) => m.id)).toEqual(c.expectedAfterDrop);
      }
    }
  });

  it('enforces single-source registry, shared DOCX element control, and unified error fallbacks across PR3A UI modules', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

    const pdfModule = read('web/src/components/ArtifactWorkspace/modules/PdfModule.tsx');
    const pptxModule = read('web/src/components/ArtifactWorkspace/modules/PptxModule.tsx');
    const docxModule = read('web/src/components/ArtifactWorkspace/modules/DocxModule.tsx');
    const gridModule = read('web/src/components/ArtifactWorkspace/modules/GridModule.tsx');
    const sourceModule = read('web/src/components/ArtifactWorkspace/modules/SourceModule.tsx');
    const gridControl = read('web/src/components/shared-ui/pin/GridTargetControl.tsx');
    const textControl = read('web/src/components/shared-ui/pin/TextRangeTargetControl.tsx');
    const workspaceShell = read('web/src/components/ArtifactWorkspace/WorkspaceShell.tsx');

    // No duplicate UI allowlists or hardcoded mode tables
    expect(pdfModule).not.toContain('PDF_PIN_OPTIONS');
    expect(pptxModule).not.toContain('PPTX_PIN_OPTIONS');
    expect(gridModule).not.toContain('allowSheet');
    expect(gridControl).not.toContain('allowSheet');
    expect(sourceModule).not.toContain('allowCharRange');
    expect(textControl).not.toContain('allowCharRange');

    // All PR3A modules derive modes from the shared registry hook
    for (const src of [pdfModule, pptxModule, docxModule, gridModule, sourceModule]) {
      expect(src).toContain('useRegisteredPinModes');
    }

    // DOCX reuses shared ElementTargetControl & PinModeToolbar (same element control as PPTX)
    expect(docxModule).toContain('ElementTargetControl');
    expect(docxModule).toContain('PinModeToolbar');
    expect(pptxModule).toContain('ElementTargetControl');

    // Unified PreviewUnavailableFallback & TargetInspectionErrorBanner across PR3A modules & shell
    expect(workspaceShell).toContain('PreviewUnavailableFallback');
    for (const src of [pptxModule, docxModule, gridModule, sourceModule]) {
      expect(src).toContain('PreviewUnavailableFallback');
      expect(src).toContain('TargetInspectionErrorBanner');
    }
    expect(pdfModule).toContain('TargetInspectionErrorBanner');

    // All PR3A modules use registry-driven inspectTarget
    for (const src of [pdfModule, pptxModule, docxModule, gridModule, sourceModule]) {
      expect(src).toContain('inspectTarget');
    }

    // Finding 02: code_char_range jump uses selectCharRange (distinct from selectLines)
    const sourceEditor = read('web/src/components/shared-ui/editor/SourceEditor.tsx');
    expect(sourceEditor).toContain('selectCharRange');
    expect(sourceModule).toContain('selectCharRange');
    expect(sourceModule).toContain("jumpTarget?.selector.kind==='code_char_range'");

    // Finding 04: SpatialPinOverlay clears stale local selection when highlightedArea changes
    const spatialOverlay = read('web/src/components/shared-ui/pin/SpatialPinOverlay.tsx');
    expect(spatialOverlay).toContain('highlightKey');
    expect(spatialOverlay).toContain('if (!startRef.current)');
  });

  it('binds every registered artifact selector kind to an inspection contract and adapter resolver', () => {
    const registry = new FormatAdapterRegistry();
    for (const entry of TARGET_SELECTOR_REGISTRY) {
      expect(entry.inspection).toBeDefined();
      expect(entry.inspection.channel).toBeTruthy();
      if (entry.format === 'rich_block') continue;
      const binding = registry.getRegisteredTargetBinding(entry.kind);
      expect(binding, `Missing target binding for ${entry.kind}`).not.toBeNull();
      expect(binding!.hasResolver, `Missing target resolver for ${entry.kind}`).toBe(true);
      expect(binding!.inspection).toEqual(entry.inspection);
    }
  });

  it('supports CSV cell-range target selection exceeding 512 KiB via streaming hashOnly without truncation failure', async () => {
    const srv = await createTestServer({ installDocRuntime: 'off', sandboxMode: 'off', allowUnsandboxedDocWorkers: false });
    cleanups.push(srv.cleanup);
    const { ctx } = srv;
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'csv-large-user', 'user:csvlarge@gmail.com');
    const chatId = (await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Large CSV range' })).data.chat.id;

    // Build a ~720 KiB CSV (600 rows x 2 cols, well above the 512 KiB display response cap)
    const lines = ['id,payload'];
    for (let i = 1; i < 600; i++) {
      lines.push(`row-${i},${'x'.repeat(1200)}-${i}`);
    }
    const csvBytes = Buffer.from(lines.join('\n'), 'utf8');
    expect(csvBytes.length).toBeGreaterThan(700 * 1024);

    const { artifact } = await ctx.artifactService.createArtifact({
      userId,
      chatId,
      scopeKind: 'chat',
      relPath: 'large.csv',
      content: csvBytes,
      actorKind: 'user',
    });

    // Request cell-range target metadata spanning all 600 rows (> 512 KiB)
    const meta = await ctx.artifactService.readRange(userId, artifact.id, {
      targetMetadata: true,
      startRow: 0,
      endRow: 599,
      startCol: 0,
      endCol: 1,
    }) as {
      target: {
        startRow: number;
        endRow: number;
        startCol: number;
        endCol: number;
        expectedRowCount: number;
        expectedColCount: number;
        expectedHeaderHash: string;
        expectedRangeValuesHash: string;
      } | null;
      snippet: string;
    };

    expect(meta.target).not.toBeNull();
    expect(meta.target!.expectedRowCount).toBe(600);
    expect(meta.target!.expectedColCount).toBe(2);
    expect(meta.target!.expectedHeaderHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.target!.expectedRangeValuesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.snippet.length).toBeGreaterThan(0);
    expect(meta.snippet.length).toBeLessThanOrEqual(50_000);

    // Re-resolution against the full >700 KiB CSV must resolve cleanly
    const resolution = await ctx.artifactService.resolveTargetOnArtifact(userId, artifact.id, {
      kind: 'csv_range',
      baseRevision: 1,
      startRow: meta.target!.startRow,
      endRow: meta.target!.endRow,
      startCol: meta.target!.startCol,
      endCol: meta.target!.endCol,
      expectedRowCount: meta.target!.expectedRowCount,
      expectedColCount: meta.target!.expectedColCount,
      expectedHeaderHash: meta.target!.expectedHeaderHash,
      expectedRangeValuesHash: meta.target!.expectedRangeValuesHash,
    });
    expect(resolution.status).toBe('resolved');
  });
});
