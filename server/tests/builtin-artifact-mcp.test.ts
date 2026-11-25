import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';
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
      binding!.revoke();
      expect((await fetch(url, { method: 'POST', headers: auth })).status).toBe(401);
    } finally {
      await mcp.close();
    }
  } finally {
    await srv.cleanup();
  }
});
