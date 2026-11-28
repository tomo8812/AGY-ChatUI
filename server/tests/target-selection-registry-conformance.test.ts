import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEPRECATED_SELECTOR_KINDS,
  TARGET_SELECTOR_REGISTRY,
  getRegisteredSelectorsForFormat,
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
});
