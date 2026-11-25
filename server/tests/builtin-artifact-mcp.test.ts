import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { deriveAgyPermissionRule } from '../src/acp/client-manager.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

it('uses the native ACP HTTP transport and attaches only a completed rich_create receipt', async () => {
  const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'richmcp', 'user:richmcp');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Rich MCP' });
    await client.connectWs({ clientId: 'rich-mcp-test' });
    const response = await client.request('POST', `/api/chats/${chat.id}/messages`, { text: '[MCP_RICH_CREATE]' });
    expect(response.status).toBe(202);
    await client.waitForFrame((frame) => frame.kind === 'event' && frame.event?.type === 'run.finished', 8000, false);
    const blocks = srv.ctx.richContentService.listBlocksForChat(userId, chat.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].bindingState).toBe('confirmed_by_tool_call');
    expect(srv.ctx.db.getMessage(userId, blocks[0].confirmedMessageId!)?.richBlockIds).toEqual([blocks[0].id]);
  } finally {
    await srv.cleanup();
  }
});

it('does not promote a provisional binding when the turn finishes without a tool receipt', async () => {
  const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'unattached', 'user:unattached');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Provisional block' });
    await client.connectWs({ clientId: 'unattached-mcp-test' });
    const response = await client.request('POST', `/api/chats/${chat.id}/messages`, { text: '[MCP_RICH_UNATTACHED]' });
    expect(response.status).toBe(202);
    await client.waitForFrame((frame) => frame.kind === 'event' && frame.event?.type === 'run.finished', 8000, false);
    const blocks = srv.ctx.richContentService.listBlocksForChat(userId, chat.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].bindingState).toBe('tentative_sole_turn');
    expect(blocks[0].confirmedMessageId).toBeNull();
    const messages = srv.ctx.db.listMessages(userId, chat.id);
    expect(messages.find((message) => message.role === 'assistant')?.richBlockIds).toEqual([]);
  } finally {
    await srv.cleanup();
  }
});

it('enforces loopback headers, token revocation and boundaries over HTTP', async () => {
  const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'mcpowner', 'user:mcpowner');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Current chat' });
    const { data: { chat: other } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Other chat' });
    const { artifact } = await srv.ctx.artifactService.createArtifact({
      userId, scopeKind: 'chat', chatId: other.id, relPath: 'other.md', content: Buffer.from('secret'), actorKind: 'user',
    });
    const binding = await srv.ctx.mcpService.bindBuiltinArtifactServer({
      userId, chatId: chat.id, tentativeTurn: () => null,
    }, [
      { type: 'http', name: 'agy_artifact', url: 'https://example.com/mcp', headers: [] },
      { type: 'http', name: 'agy_artifact_builtin', url: 'https://example.com/mcp', headers: [] },
    ]);
    expect(binding?.server.name).toBe('agy_artifact_builtin_2');
    const restoreCall = { toolCallId: 'call', name: 'mcp__agy_artifact_builtin_2__artifact_restore_bundle', title: 'Restore', status: 'pending' };
    const restoreRule = () => deriveAgyPermissionRule({ toolCall: restoreCall, knownMcpServers: [binding!.permissionTarget()] });
    expect(restoreRule()).toBe('mcp(agy_artifact_builtin_2/artifact_restore_bundle)');
    expect(deriveAgyPermissionRule({
      toolCall: { ...restoreCall, name: 'mcp__agy_artifact__artifact_restore_bundle' },
      knownMcpServers: [binding!.permissionTarget()],
    })).toBeNull();
    srv.ctx.db.setBuiltinMcpSettings(`chat:${chat.id}`, { enabled: true, disabledTools: ['artifact_restore_bundle'] });
    expect(restoreRule()).toBeNull();
    srv.ctx.db.setBuiltinMcpSettings(`chat:${chat.id}`, { enabled: true, disabledTools: [] });

    const { url, headers } = binding!.server;
    const auth = Object.fromEntries(headers.map(({ name, value }) => [name, value]));
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { ...auth, Origin: 'null' } })).status).toBe(403);
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth } }));
    try {
      const denied = await mcp.callTool({ name: 'artifact_history', arguments: { artifactId: artifact.id } });
      expect(denied.isError).toBe(true);
      const settings = await client.request('PUT', '/api/mcp/builtin-artifact', {
        scope: 'chat', id: chat.id, enabled: true, disabledTools: ['artifact_list'],
      });
      expect(settings.status).toBe(200);
      expect((await mcp.listTools()).tools.some(({ name }) => name === 'artifact_list')).toBe(false);
      const blocked = await mcp.callTool({ name: 'artifact_list', arguments: {} });
      expect(blocked.isError).toBe(true);
      try {
        srv.ctx.artifactService.commitFaultHook = (stage) => {
          if (stage === 'after_T2') {
            srv.ctx.db.setBuiltinMcpSettings(`chat:${chat.id}`, { enabled: true, disabledTools: ['artifact_create'] });
          }
        };
        const write = await mcp.callTool({ name: 'artifact_create', arguments: {
          relPath: 'denied.md', content: 'Rejected before placement', idempotencyKey: 'policy-change',
        } });
        expect(write.isError).toBe(true);
        expect(srv.ctx.db.findArtifactByRelPath(userId, chat.id, 'denied.md')).toBeNull();
      } finally {
        srv.ctx.artifactService.commitFaultHook = undefined;
      }
      binding!.revoke();
      expect((await fetch(url, { method: 'POST', headers: auth })).status).toBe(401);
    } finally {
      await mcp.close();
    }
  } finally {
    await srv.cleanup();
  }
});

it.each([
  ['CHILD', 'confirmed_by_tool_call'],
  ['UNTRACKED', 'tentative_sole_turn'],
] as const)('uses ACP child-session provenance for %s notifications', async (mode, bindingState) => {
  const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'richchild', 'user:richchild');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Child session' });
    await client.connectWs({ clientId: 'child-mcp-test' });
    const { data: { run } } = await client.request<{ run: { id: string } }>(
      'POST', `/api/chats/${chat.id}/messages`, { text: `[MCP_RICH_${mode}]` }
    );
    await client.waitForFrame((frame) => frame.kind === 'event' &&
      frame.event?.type === 'run.finished' && frame.event.runId === run.id, 8000, false);
    const blocks = srv.ctx.richContentService.listBlocksForChat(userId, chat.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].bindingState).toBe(bindingState);
  } finally {
    await srv.cleanup();
  }
});

it('binds a delayed completion to the turn that owns its tool call during a subsequent turn', async () => {
  const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'richdelay', 'user:richdelay');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Delayed receipt' });
    await client.connectWs({ clientId: 'delayed-mcp-test' });
    const send = async (text: string) => {
      const { data: { run } } = await client.request<{ run: { id: string } }>(
        'POST', `/api/chats/${chat.id}/messages`, { text }
      );
      await client.waitForFrame((frame) => frame.kind === 'event' && frame.event?.type === 'run.finished' &&
        frame.event.runId === run.id, 8000, false);
      return run.id;
    };
    const firstRun = await send('[MCP_RICH_DEFER]');
    expect(srv.ctx.richContentService.listBlocksForChat(userId, chat.id)[0]?.confirmedMessageId).toBeNull();
    const secondRun = await send('[MCP_RICH_FLUSH]');
    const assistantMessages = srv.ctx.db.listMessages(userId, chat.id).filter(({ role }) => role === 'assistant');
    const block = srv.ctx.richContentService.listBlocksForChat(userId, chat.id)[0];
    expect(block.confirmedMessageId).toBe(assistantMessages.find(({ runId }) => runId === firstRun)?.id);
    expect(block.runId).toBe(firstRun);
    expect(assistantMessages.find(({ runId }) => runId === secondRun)?.richBlockIds).toEqual([]);
  } finally {
    await srv.cleanup();
  }
});

it('keeps a created block provisional when the turn is cancelled before the ACP completion', async () => {
  const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'richcancel', 'user:richcancel');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Cancelled receipt' });
    await client.connectWs({ clientId: 'cancelled-mcp-test' });
    const { data: { run } } = await client.request<{ run: { id: string } }>(
      'POST', `/api/chats/${chat.id}/messages`, { text: '[MCP_RICH_CANCEL_WAIT]' }
    );
    await client.waitForFrame((frame) => frame.kind === 'event' && frame.event?.type === 'rich_block.created', 8000, false);
    const cancelled = await client.request('POST', `/api/chats/${chat.id}/runs/${run.id}/cancel`);
    expect(cancelled.status).toBe(200);
    const block = srv.ctx.richContentService.listBlocksForChat(userId, chat.id)[0];
    expect(block.confirmedMessageId).toBeNull();
    expect(srv.ctx.db.listMessages(userId, chat.id).find(({ role }) => role === 'assistant')?.richBlockIds).toEqual([]);
  } finally {
    await srv.cleanup();
  }
});

it.each(['load', 'resume'] as const)('restores the MCP connection via session/%s and reads a past block without rebinding it', async (method) => {
  vi.stubEnv('MOCK_ACP_RESTORE_METHOD', method);
  const srv = await createTestServer({ installDocRuntime: '0' });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'restoretest', 'user:restoretest');
    const newChat = async (title: string) => (
      await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title })
    ).data.chat.id;
    const first = await newChat('First');
    const second = await newChat('Second');
    await client.connectWs({ clientId: 'before-reconnect' });
    const start = async (chatId: string, text: string) => {
      const response = await client.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, { text });
      expect(response.status).toBe(202);
      return response.data.run.id;
    };
    const finished = (runId: string) => client.waitForFrame(
      (frame) => frame.kind === 'event' && frame.event?.type === 'run.finished' && frame.event.runId === runId,
      12_000, false
    );
    const runs = await Promise.all([
      start(first, '[MCP_RICH_CREATE]'),
      start(second, '[MCP_RICH_CREATE]'),
    ]);
    await Promise.all(runs.map(finished));
    const [firstBlock] = srv.ctx.richContentService.listBlocksForChat(userId, first);
    const [secondBlock] = srv.ctx.richContentService.listBlocksForChat(userId, second);
    expect(firstBlock.runId).toBe(runs[0]);
    expect(secondBlock.runId).toBe(runs[1]);
    expect(firstBlock.id).not.toBe(secondBlock.id);
    const previousSession = srv.ctx.db.getChat(userId, first)?.acpSessionId;
    client.closeWs();
    await srv.ctx.acp.stopIdleWorkersForChats(userId, [first]);
    await client.connectWs({ clientId: 'after-reconnect' });

    const reference = `[MCP_RICH_REFERENCE:${firstBlock.id}]`;
    const reopened = await start(first, reference);
    await finished(reopened);
    expect(srv.ctx.db.getChat(userId, first)?.acpSessionId).toBe(previousSession);
    const reply = srv.ctx.db.listMessages(userId, first).find(({ role, runId }) => role === 'assistant' && runId === reopened);
    expect(reply?.contentText).toContain(`${method}: agy-rich://${firstBlock.id}`);
    expect(reply?.richBlockIds).toEqual([]);
    expect(srv.ctx.richContentService.getBlock(userId, first, firstBlock.id)?.confirmedMessageId).toBe(firstBlock.confirmedMessageId);

    const denied = await start(second, reference);
    await finished(denied);
    expect(srv.ctx.db.listMessages(userId, second).find(({ role, runId }) => role === 'assistant' && runId === denied)?.contentText)
      .toContain('Rich reference denied');
  } finally {
    await srv.cleanup();
    vi.unstubAllEnvs();
  }
}, 35_000);

it('exports CSV to valid OOXML XLSX and renders real Markdown HTML in Base ChatUI without external workers', async () => {
  const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'purejs', 'user:purejs');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Pure-JS Exports' });

    // 1. CSV -> XLSX in Base ChatUI + UTF-8/quote/column verify
    const { artifact: csvArt } = await srv.ctx.artifactService.createArtifact({
      userId, scopeKind: 'chat', chatId: chat.id, relPath: 'sales.csv',
      content: Buffer.from('Region,Amount,Code\nEast,1200,00123\nWest,950,=SUM(A1)\n', 'utf8'),
      actorKind: 'user',
    });
    const csvVerify = await srv.ctx.artifactService.verifyArtifact(userId, csvArt.id);
    expect(csvVerify.ok).toBe(true);
    expect(csvVerify.checks?.map((c) => c.id)).toEqual(expect.arrayContaining(['csv_encoding', 'csv_quotes', 'csv_column_consistency']));

    const { artifact: xlsxArt, exported: xlsxExp } = await srv.ctx.artifactService.exportArtifact({
      userId, artifactId: csvArt.id, targetFormat: 'xlsx', actorKind: 'user',
    });
    expect(xlsxArt.filename).toBe('sales.xlsx');
    // ZIP magic bytes PK\x03\x04 and OOXML parts
    expect(xlsxExp.buffer.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(xlsxExp.buffer.includes(Buffer.from('xl/worksheets/sheet1.xml'))).toBe(true);

    // 2. Markdown -> real rendered HTML (not <pre>) + heading/anchor verification
    const mdSource = [
      '# Release Notes',
      '',
      '### Skipped Level',
      '',
      'See **bold**, `code`, [valid](#release-notes), and [broken](#no-such-anchor).',
      '',
      '| Key | Val |',
      '| --- | ---: |',
      '| A | 10 |',
      '',
      '- [x] Done task',
      '',
    ].join('\n');
    const { artifact: mdArt } = await srv.ctx.artifactService.createArtifact({
      userId, scopeKind: 'chat', chatId: chat.id, relPath: 'notes.md',
      content: Buffer.from(mdSource, 'utf8'),
      actorKind: 'user',
    });
    const mdVerify = await srv.ctx.artifactService.verifyArtifact(userId, mdArt.id);
    expect(mdVerify.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['MD_HEADING_LEVEL_SKIP', 'MD_BROKEN_ANCHOR_LINK']));
    const { exported: htmlExp } = await srv.ctx.artifactService.exportArtifact({
      userId, artifactId: mdArt.id, targetFormat: 'html', actorKind: 'user',
    });
    const html = htmlExp.buffer.toString('utf8');
    expect(html).toContain('<h1 id="release-notes">Release Notes</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<table><thead><tr><th>Key</th><th style="text-align:right">Val</th></tr></thead>');
    expect(html).toContain('type="checkbox" disabled checked');
    expect(html).not.toContain('<pre># Release Notes');

    // 3. Mermaid static syntax verification with exact line numbers in Base ChatUI
    const { artifact: mmdArt } = await srv.ctx.artifactService.createArtifact({
      userId, scopeKind: 'chat', chatId: chat.id, relPath: 'bad.mmd',
      content: Buffer.from('flowchart TD\n  subgraph Box\n    A[Start] -->\n', 'utf8'),
      actorKind: 'user',
    });
    const mmdVerify = await srv.ctx.artifactService.verifyArtifact(userId, mmdArt.id);
    expect(mmdVerify.ok).toBe(false);
    expect(mmdVerify.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MERMAID_MALFORMED_EDGE', location: 'line:3' }),
      expect.objectContaining({ code: 'MERMAID_UNBALANCED_SUBGRAPH', location: 'line:2' }),
    ]));
  } finally {
    await srv.cleanup();
  }
});

it('supports Full Runtime Mermaid SVG export, parser syntax line errors, CSV PNG + region render, and Markdown PDF/DOCX via MCP when runtime is installed', async () => {
  const runtimeDir = process.env.AGY_TEST_FULL_RUNTIME_DIR;
  if (!runtimeDir) return;
  const srv = await createTestServer({
    docRuntimeDir: runtimeDir,
    installDocRuntime: 'full',
    allowUnsandboxedDocWorkers: true,
    sandboxMode: 'off',
  });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'fullrt', 'user:fullrt');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Full Runtime MCP' });
    const binding = await srv.ctx.mcpService.bindBuiltinArtifactServer({ userId, chatId: chat.id, tentativeTurn: () => null }, []);
    const auth = Object.fromEntries(binding!.server.headers.map(({ name, value }) => [name, value]));
    const mcp = new Client({ name: 'full-rt-test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(binding!.server.url), { requestInit: { headers: auth } }));
    try {
      // 1. Mermaid SVG export + valid/invalid syntax verification with real mermaid.parse()
      const { artifact: goodMmd } = await srv.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId: chat.id, relPath: 'arch.mmd',
        content: Buffer.from('flowchart LR\n  A[Client] --> B[Server]\n', 'utf8'), actorKind: 'user',
      });
      const goodCheck = await srv.ctx.artifactService.verifyArtifact(userId, goodMmd.id);
      expect(goodCheck.ok).toBe(true);
      expect(goodCheck.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'mermaid_parser_syntax', status: 'passed' })]));

      const { exported: svgExp } = await srv.ctx.artifactService.exportArtifact({
        userId, artifactId: goodMmd.id, targetFormat: 'svg', actorKind: 'ai',
      });
      expect(svgExp.buffer.toString('utf8')).toContain('<svg');

      const { artifact: badMmd } = await srv.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId: chat.id, relPath: 'broken.mmd',
        content: Buffer.from('flowchart LR\n  A[Client] --> B[Server]\n  C ---===>>> D\n', 'utf8'), actorKind: 'user',
      });
      const badCheck = await srv.ctx.artifactService.verifyArtifact(userId, badMmd.id);
      expect(badCheck.ok).toBe(false);
      expect(badCheck.issues[0]?.code).toBe('MERMAID_SYNTAX_ERROR');
      expect(badCheck.issues[0]?.location).toMatch(/^line:\d+$/);

      // 2. artifact_render with region via MCP on Mermaid & CSV/TSV
      const fullRes = await mcp.callTool({ name: 'artifact_render', arguments: { artifactId: goodMmd.id } });
      const cropRes = await mcp.callTool({
        name: 'artifact_render',
        arguments: { artifactId: goodMmd.id, region: { x: 0, y: 0, width: 0.5, height: 0.5, unit: 'norm' } },
      });
      expect(fullRes.isError).toBeFalsy();
      expect(cropRes.isError).toBeFalsy();
      const fullImg = (fullRes.content as Array<{ type: string; data?: string }>).find((c) => c.type === 'image')!;
      const cropImg = (cropRes.content as Array<{ type: string; data?: string }>).find((c) => c.type === 'image')!;
      const fullBuf = Buffer.from(fullImg.data!, 'base64');
      const cropBuf = Buffer.from(cropImg.data!, 'base64');
      expect(cropBuf.readUInt32BE(16)).toBeLessThan(fullBuf.readUInt32BE(16));
      expect(cropBuf.readUInt32BE(20)).toBeLessThan(fullBuf.readUInt32BE(20));

      // 3. CSV/TSV -> table PNG via MCP artifact_render with region + CSV -> XLSX verified by Python worker
      const { artifact: csvArt } = await srv.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId: chat.id, relPath: 'grid.tsv',
        content: Buffer.from('ColA\tColB\n10\tAlpha\n20\tBeta\n', 'utf8'), actorKind: 'user',
      });
      const csvPngRes = await mcp.callTool({
        name: 'artifact_render',
        arguments: { artifactId: csvArt.id, region: { x: 0, y: 0, width: 0.6, height: 0.6, unit: 'norm' } },
      });
      expect(csvPngRes.isError).toBeFalsy();
      const { artifact: exportedXlsx } = await srv.ctx.artifactService.exportArtifact({
        userId, artifactId: csvArt.id, targetFormat: 'xlsx', actorKind: 'ai',
      });
      const xlsxVerify = await srv.ctx.artifactService.verifyArtifact(userId, exportedXlsx.id);
      expect(xlsxVerify.ok).toBe(true);

      // 4. Markdown -> PDF and DOCX via MCP artifact_export
      const { artifact: mdArt } = await srv.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId: chat.id, relPath: 'spec.md',
        content: Buffer.from('# Spec\n\nRendered via Full Runtime.\n', 'utf8'), actorKind: 'user',
      });
      const pdfExpRes = await mcp.callTool({
        name: 'artifact_export',
        arguments: { artifactId: mdArt.id, targetFormat: 'pdf', idempotencyKey: 'md-pdf-1' },
      });
      const docxExpRes = await mcp.callTool({
        name: 'artifact_export',
        arguments: { artifactId: mdArt.id, targetFormat: 'docx', idempotencyKey: 'md-docx-1' },
      });
      expect(pdfExpRes.isError).toBeFalsy();
      expect(docxExpRes.isError).toBeFalsy();

      // 5. PDF rev 1 -> rev 2 overlay + differential verification via ArtifactService
      const { artifact: pdfArt } = await srv.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId: chat.id, relPath: 'brief.pdf',
        createParams: { pages: ['Original executive summary'] }, actorKind: 'ai',
      });
      await srv.ctx.artifactService.editArtifact({
        userId, artifactId: pdfArt.id, expectedRevision: 1, actorKind: 'ai',
        operations: [
          { op: 'pdf.add_overlay', pageIndex: 0, kind: 'stamp', rect: [300, 700, 500, 760], text: 'REVIEWED' },
        ],
      });
      const pdfVerify = await srv.ctx.artifactService.verifyArtifact(userId, pdfArt.id);
      expect(pdfVerify.ok).toBe(true);
      expect(pdfVerify.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'pdf_structure', status: 'passed' }),
        expect.objectContaining({ id: 'pdf_diff', status: 'passed' }),
      ]));
    } finally {
      await mcp.close();
      binding?.revoke();
    }
  } finally {
    await srv.cleanup();
  }
}, 60_000);

