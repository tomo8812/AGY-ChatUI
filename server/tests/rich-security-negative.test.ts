import { afterEach, describe, expect, it } from 'vitest';
import type { RichDocumentV1 } from '../../shared/rich-schema.js';
import { evaluateRichExpr } from '../src/rich/rich-expr-evaluator.js';
import { validateRichDocument } from '../src/rich/rich-validator.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

function makeValidDoc(overrides: Partial<RichDocumentV1> = {}): RichDocumentV1 {
  return {
    schemaVersion: 1,
    title: 'Interactive Simulation',
    sources: [
      { id: 'src-a', name: 'Source A', url: 'https://example.com/a', fetchedAt: '2026-11-24T00:00:00Z', asOf: '2026-11-23' },
      { id: 'src-b', name: 'Source B', fetchedAt: '2026-11-24T01:00:00Z', asOf: '2026-11-24', valueStatus: 'preliminary' },
    ],
    state: {
      rate: 5,
      principal: 1000,
      items: [
        { id: 'i1', label: 'Alpha', val: 10 },
        { id: 'i2', label: 'Beta', val: 20 },
      ],
    },
    computed: {
      interest: 'round($state.principal * ($state.rate / 100), 2)',
      total: '$state.principal + $computed.interest',
    },
    root: {
      id: 'root',
      type: 'stack',
      direction: 'col',
      children: [
        {
          id: 'slider-rate',
          type: 'slider',
          bind: 'rate',
          label: 'Rate (%)',
          min: 0,
          max: 20,
          step: 0.5,
          onChange: [{ type: 'set_state', key: 'rate', valueExpr: '$state.rate' }],
        },
        {
          id: 'kpi-total',
          type: 'kpi_card',
          label: 'Total',
          value: { expr: '$computed.total' },
          sourceId: 'src-a',
        },
        {
          id: 'kpi-missing',
          type: 'kpi_card',
          label: 'Unavailable Metric',
          value: null,
          missingReason: 'Market closed',
          sourceId: 'src-b',
        },
        {
          id: 'svg-vis',
          type: 'svg_scene',
          viewBox: '0 0 200 100',
          interactiveRole: 'interactive',
          elements: [
            {
              tag: 'rect',
              id: 'bar',
              attrs: {
                x: 10,
                y: 10,
                width: { expr: 'clamp($state.rate * 8, 10, 180)' },
                height: 30,
                fill: 'var(--accent)',
              },
            },
          ],
        },
        {
          id: 'btn-reset',
          type: 'button',
          label: 'Reset',
          onClick: [{ type: 'reset_state', keys: ['rate'] }],
        },
      ],
    },
    ...overrides,
  };
}

describe('Lightweight Rich UI Core Security & Negative Self-Tests (NEG-06..NEG-09, SEC-06..SEC-09, ACP-01)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('evaluates Pure-TS AST expressions safely and blocks prototype traversal', () => {
    expect(
      evaluateRichExpr('round(clamp(sum($state.nums) / count($state.nums), 0, 100), 1)', {
        state: { nums: [10, 20, null, 30] },
        computed: {},
      })
    ).toBe(20);

    expect(() =>
      evaluateRichExpr('$state.__proto__', { state: {}, computed: {} })
    ).toThrow(/forbidden/i);

    expect(() =>
      evaluateRichExpr('$state.constructor', { state: {}, computed: {} })
    ).toThrow(/forbidden/i);

    expect(() =>
      evaluateRichExpr('eval("1+1")', { state: {}, computed: {} })
    ).toThrow(/not permitted/i);

    // Locale-aware formatting respects ctx.locale instead of hard-coding en-US
    expect(
      evaluateRichExpr('formatNumber(1234.5, 2)', { state: {}, computed: {}, locale: 'de-DE' })
    ).toBe(new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.5));
    expect(
      evaluateRichExpr('formatCurrency(1500, "EUR")', { state: {}, computed: {}, locale: 'de-DE' })
    ).toBe(new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(1500));
  });

  it('NEG-06: rejects static and post-evaluation dangerous SVG, markdown/mermaid/media external images, and side-effect actions in onChange', () => {
    // 1. Static dangerous SVG tag (<script> / <foreignObject>)
    const badSvgTag = makeValidDoc({
      root: {
        id: 'r',
        type: 'svg_scene',
        viewBox: '0 0 100 100',
        elements: [{ tag: 'script' as never, textContent: 'alert(1)' }],
      },
    });
    expect(validateRichDocument(badSvgTag).valid).toBe(false);

    // 2. Post-evaluation dynamic SVG external url() via concat()
    const postEvalSvg = makeValidDoc({
      state: { host: 'evil.example' },
      computed: {},
      root: {
        id: 'r',
        type: 'svg_scene',
        viewBox: '0 0 100 100',
        elements: [
          {
            tag: 'rect',
            attrs: {
              x: 0,
              y: 0,
              width: 50,
              height: 50,
              fill: { expr: 'concat("url(http://", $state.host, "/track.png)")' },
            },
          },
        ],
      },
    });
    const svgRes = validateRichDocument(postEvalSvg);
    expect(svgRes.valid).toBe(false);
    expect(svgRes.primaryErrorCode).toBe('RICH_POST_EVAL_UNSAFE_SVG');

    // 3. Post-evaluation Markdown external image URL via concat()
    const postEvalMd = makeValidDoc({
      state: { imgUrl: 'https://evil.example/pixel.png' },
      computed: {},
      root: {
        id: 'r',
        type: 'markdown',
        content: { expr: 'concat("Hello ![tracker](", $state.imgUrl, ")")' },
      },
    });
    const mdRes = validateRichDocument(postEvalMd);
    expect(mdRes.valid).toBe(false);
    expect(mdRes.primaryErrorCode).toBe('RICH_POST_EVAL_UNSAFE_MARKDOWN');

    // 4. Mermaid attempting to weaken security or load external url()
    const badMermaid = makeValidDoc({
      computed: {},
      root: {
        id: 'r',
        type: 'mermaid',
        code: '%%{init:{"securityLevel":"loose"}}%%\ngraph TD\n  A-->B',
      },
    });
    expect(validateRichDocument(badMermaid).valid).toBe(false);

    // 5. media_asset referencing external URL (static & post-eval)
    const badMedia = makeValidDoc({
      state: { url: 'https://evil.example/photo.jpg' },
      computed: {},
      root: {
        id: 'r',
        type: 'media_asset',
        sourceKind: 'artifact',
        artifactId: { expr: '$state.url' },
        alt: 'external',
      },
    });
    const mediaRes = validateRichDocument(badMedia);
    expect(mediaRes.valid).toBe(false);
    expect(mediaRes.primaryErrorCode).toBe('RICH_POST_EVAL_FORBIDDEN_MEDIA');

    // 6. RichSideEffectAction injected inside slider.onChange or svg.onClick
    const sideEffectInOnChange = makeValidDoc({
      computed: {},
      root: {
        id: 'r',
        type: 'slider',
        bind: 'rate',
        min: 0,
        max: 10,
        onChange: [{ type: 'submit_to_chat', textExpr: '"pwned"' } as never],
      },
    });
    const seRes = validateRichDocument(sideEffectInOnChange);
    expect(seRes.valid).toBe(false);
    expect(seRes.primaryErrorCode).toBe('RICH_FORBIDDEN_SIDE_EFFECT');

    const sideEffectInSvgClick = makeValidDoc({
      computed: {},
      root: {
        id: 'r',
        type: 'svg_scene',
        viewBox: '0 0 100 100',
        elements: [
          {
            tag: 'rect',
            attrs: { x: 0, y: 0, width: 10, height: 10 },
            onClick: [{ type: 'open_external_url', urlExpr: '"https://evil.example"' } as never],
          },
        ],
      },
    });
    expect(validateRichDocument(sideEffectInSvgClick).primaryErrorCode).toBe('RICH_FORBIDDEN_SIDE_EFFECT');
  });

  it('NEG-07: rejects decorative/non-functional controls lacking bind or action', () => {
    const emptyButton = makeValidDoc({
      computed: {},
      root: {
        id: 'btn',
        type: 'button',
        label: 'Fake Button',
        onClick: [] as never,
      },
    });
    expect(validateRichDocument(emptyButton).primaryErrorCode).toBe('RICH_NONFUNCTIONAL_CONTROL');

    const unboundSlider = makeValidDoc({
      computed: {},
      root: {
        id: 's',
        type: 'slider',
        bind: '' as never,
        min: 0,
        max: 10,
      },
    });
    expect(validateRichDocument(unboundSlider).primaryErrorCode).toBe('RICH_NONFUNCTIONAL_CONTROL');
  });

  it('NEG-08: rejects circular computed references (400 RICH_COMPUTED_CYCLE), >2000 expanded nodes, and >20000 AST steps', () => {
    // 1. Computed cycle
    const cyclic = makeValidDoc({
      computed: {
        a: '$computed.b + 1',
        b: '$computed.a + 1',
      },
    });
    const cycRes = validateRichDocument(cyclic);
    expect(cycRes.valid).toBe(false);
    expect(cycRes.statusCode).toBe(400);
    expect(cycRes.primaryErrorCode).toBe('RICH_COMPUTED_CYCLE');

    // 2. Expanded node limit (> 2000 via repeat)
    const manyItems = Array.from({ length: 2100 }, (_, i) => i);
    const expandedBomb = makeValidDoc({
      state: { rows: manyItems },
      computed: {},
      root: {
        id: 'r',
        type: 'stack',
        direction: 'col',
        children: [
          {
            id: 'rep',
            type: 'text',
            repeat: { itemsExpr: '$state.rows', as: 'x' },
            content: 'hi',
          },
        ],
      },
    });
    const expRes = validateRichDocument(expandedBomb);
    expect(expRes.valid).toBe(false);
    expect(expRes.primaryErrorCode).toBe('RICH_EXPANDED_NODE_LIMIT_EXCEEDED');

    // 3. Cumulative AST step limit (> 20,000)
    const stepItems = Array.from({ length: 1500 }, (_, i) => ({ v: i }));
    const stepBomb = makeValidDoc({
      state: { rows: stepItems },
      computed: {
        s1: 'sum(pluck($state.rows, "v"))',
        s2: 'sum(pluck($state.rows, "v"))',
        s3: 'sum(pluck($state.rows, "v"))',
        s4: 'sum(pluck($state.rows, "v"))',
        s5: 'sum(pluck($state.rows, "v"))',
        s6: 'sum(pluck($state.rows, "v"))',
        s7: 'sum(pluck($state.rows, "v"))',
        s8: 'sum(pluck($state.rows, "v"))',
        s9: 'sum(pluck($state.rows, "v"))',
        s10: 'sum(pluck($state.rows, "v"))',
      },
      root: { id: 't', type: 'text', content: { expr: 'concat($computed.s1, $computed.s10)' } },
    });
    const stepRes = validateRichDocument(stepBomb);
    expect(stepRes.valid).toBe(false);
    expect(stepRes.primaryErrorCode).toBe('RICH_STEP_LIMIT_EXCEEDED');

    // 4. Popover/tooltip without trigger is handled cleanly without crashing evalNodePost
    const popoverMissingTrigger = makeValidDoc({
      root: {
        id: 'pop-1',
        type: 'popover',
        content: [{ id: 'pop-txt', type: 'text', content: 'details' }],
      } as unknown as RichDocumentV1['root'],
    });
    const popRes = validateRichDocument(popoverMissingTrigger);
    expect(popRes.primaryErrorCode).not.toBe('RICH_EVAL_ERROR');
  });

  it('NEG-09 & ACP-01: enforces strict cross-chat/cross-user scope isolation, 2-layer binding invariant, and explicit ArtifactService save in Base ChatUI', async () => {
    const srv = await createTestServer({ sandboxMode: 'off', installDocRuntime: '0' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId: aliceId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const { client: bob } = await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');

    const chat1 = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Chat 1' })).data.chat.id;
    const chat2 = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Chat 2' })).data.chat.id;
    const bobChat = (await bob.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Bob Chat' })).data.chat.id;

    // Verify Pure-JS capabilities work in Base ChatUI without bwrap
    const capRes = await alice.request<{ runtimeMode: string; requiresBwrap: boolean }>('GET', '/api/rich/capabilities');
    expect(capRes.status).toBe(200);
    expect(capRes.data.runtimeMode).toBe('pure_js');
    expect(capRes.data.requiresBwrap).toBe(false);

    // Create assistant message in chat1 to test 2-layer binding invariant
    const assistantMsg = srv.ctx.db.createMessage({
      id: 'msg-assist-1',
      chatId: chat1,
      userId: aliceId,
      role: 'assistant',
      contentText: 'Answer',
      status: 'streaming',
    });

    // 1. Create block with tentativeMessageId -> MUST remain tentative_sole_turn, confirmedMessageId=null, NOT in message.richBlockIds!
    const created = srv.ctx.richContentService.createBlock({
      userId: aliceId,
      chatId: chat1,
      document: makeValidDoc(),
      tentativeMessageId: assistantMsg.id,
      actorKind: 'ai',
    });
    expect(created.block.bindingState).toBe('tentative_sole_turn');
    expect(created.block.confirmedMessageId).toBeNull();
    expect(created.block.tentativeMessageId).toBe(assistantMsg.id);
    expect(created.referenceUrl).toBe(`agy-rich://${created.block.id}`);
    expect(srv.ctx.db.getMessage(aliceId, assistantMsg.id)!.richBlockIds).toEqual([]);

    // 2. Cross-chat and cross-user access to block MUST be rejected (NEG-09 / SEC-09)
    const crossChat = await alice.request('GET', `/api/chats/${chat2}/rich-blocks/${created.block.id}`);
    expect(crossChat.status).toBe(404);
    const crossUser = await bob.request('GET', `/api/chats/${bobChat}/rich-blocks/${created.block.id}`);
    expect(crossUser.status).toBe(404);
    const ownChat = await alice.request<{ block: { id: string } }>('GET', `/api/chats/${chat1}/rich-blocks/${created.block.id}`);
    expect(ownChat.status).toBe(200);
    expect(ownChat.data.block.id).toBe(created.block.id);

    // 3. Only explicit ACP tool_call_update confirmation promotes to confirmed_by_tool_call and updates messages.rich_block_ids_json
    const confirmed = srv.ctx.richContentService.confirmBlockBinding({
      userId: aliceId,
      chatId: chat1,
      blockId: created.block.id,
      messageId: assistantMsg.id,
      toolCallId: 'tc-rich-create-1',
    });
    expect(confirmed?.bindingState).toBe('confirmed_by_tool_call');
    expect(confirmed?.confirmedMessageId).toBe(assistantMsg.id);
    expect(srv.ctx.db.getMessage(aliceId, assistantMsg.id)!.richBlockIds).toEqual([created.block.id]);

    // 4. Optimistic locking on PATCH + explicit save-as-artifact through ArtifactService
    const conflictPatch = await alice.request('PATCH', `/api/chats/${chat1}/rich-blocks/${created.block.id}`, {
      expectedRevision: 99,
      patchState: { rate: 8 },
    });
    expect(conflictPatch.status).toBe(409);

    const okPatch = await alice.request<{ block: { revision: number } }>('PATCH', `/api/chats/${chat1}/rich-blocks/${created.block.id}`, {
      expectedRevision: 1,
      patchState: { rate: 8 },
    });
    expect(okPatch.status).toBe(200);
    expect(okPatch.data.block.revision).toBe(2);

    const savedArt = await alice.request<{ artifact: { id: string; relPath: string; revision: number } }>(
      'POST',
      `/api/chats/${chat1}/rich-blocks/${created.block.id}/save-as-artifact`,
      { filename: 'simulation.json', format: 'json' }
    );
    expect(savedArt.status).toBe(201);
    expect(savedArt.data.artifact.relPath).toBe('simulation.json');
    expect(savedArt.data.artifact.revision).toBe(1);
  });
});
