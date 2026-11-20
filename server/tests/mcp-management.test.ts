import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestServer,
  registerAndBindAgy,
  TestApiClient,
} from './helpers/test-harness.js';

type StartedTestServer = Awaited<ReturnType<typeof createTestServer>>;

const servers: StartedTestServer[] = [];
const httpServers: http.Server[] = [];

afterEach(async () => {
  while (httpServers.length > 0) {
    const s = httpServers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (servers.length > 0) {
    const s = servers.pop()!;
    await s.cleanup();
  }
});

async function runInspectPrompt(client: TestApiClient, chatId: string): Promise<Array<Record<string, unknown>>> {
  const sendRes = await client.request<{ run: { id: string } }>(
    'POST',
    `/api/chats/${chatId}/messages`,
    { text: '[MCP_INSPECT]' }
  );
  expect(sendRes.status).toBe(202);

  await client.waitForFrame(
    (f) => f.kind === 'event' && (f.event as { type?: string })?.type === 'run.finished',
    8000,
    false
  );

  const detail = await client.request<{
    messages: Array<{ role: string; contentText: string }>;
  }>('GET', `/api/chats/${chatId}`);
  expect(detail.status).toBe(200);
  const assistantMessages = detail.data.messages.filter((m) => m.role === 'assistant');
  const lastText = assistantMessages[assistantMessages.length - 1]?.contentText ?? '';
  const idx = lastText.indexOf('MCP_SERVERS:');
  expect(idx).toBeGreaterThanOrEqual(0);
  return JSON.parse(lastText.slice(idx + 'MCP_SERVERS:'.length)) as Array<Record<string, unknown>>;
}

describe('Admin-Only MCP Server Management, Scope Isolation, and Remote OAuth 2.1', () => {
  it('enforces admin-only RBAC, masks secrets, and isolates shared vs profile MCP servers over native ACP', async () => {
    const srv = await createTestServer();
    servers.push(srv);

    // First registered user is admin, second is regular user
    const { client: admin } = await registerAndBindAgy(srv.baseUrl, 'mcpadmin', 'user:admin-a');
    const { client: regular } = await registerAndBindAgy(srv.baseUrl, 'mcpuser', 'user:regular-b');

    const adminMe = await admin.request<{ user: { role: string } }>('GET', '/api/auth/me');
    const regularMe = await regular.request<{ user: { role: string } }>('GET', '/api/auth/me');
    expect(adminMe.data.user.role).toBe('admin');
    expect(regularMe.data.user.role).toBe('user');

    await admin.connectWs({ clientId: 'admin-ws' });
    await regular.connectWs({ clientId: 'user-ws' });

    // Non-admin must be blocked with 403 on all MCP endpoints
    expect((await regular.request('GET', '/api/mcp/servers')).status).toBe(403);
    expect(
      (
        await regular.request('POST', '/api/mcp/servers', {
          name: 'blocked',
          scope: 'shared',
          transport: 'http',
          url: 'https://example.com/mcp',
        })
      ).status
    ).toBe(403);
    expect(
      (
        await regular.request('POST', '/api/mcp/import', {
          scope: 'shared',
          rawJson: '{"mcpServers":{}}',
        })
      ).status
    ).toBe(403);

    // Admin creates shared local (stdio) MCP
    const createStdio = await admin.request<{ server: Record<string, unknown> }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'shared-local',
        description: 'Shared stdio tool',
        scope: 'shared',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'console.log("ok")'],
        env: [{ name: 'API_SECRET', value: 'super-secret-env-1234' }],
      }
    );
    expect(createStdio.status).toBe(201);
    const stdioEnv = createStdio.data.server.env as Array<{ name: string; maskedValue: string }>;
    expect(stdioEnv).toEqual([{ name: 'API_SECRET', maskedValue: '••••1234', hasValue: true }]);
    expect(JSON.stringify(createStdio.data)).not.toContain('super-secret-env-1234');

    // Admin tests stdio executable resolution
    const testStdio = await admin.request<{ result: { ok: boolean; resolvedCommand?: string } }>(
      'POST',
      `/api/mcp/servers/${createStdio.data.server.id}/test`,
      {}
    );
    expect(testStdio.status).toBe(200);
    expect(testStdio.data.result.ok).toBe(true);
    expect(testStdio.data.result.resolvedCommand).toBeTruthy();

    // Admin creates shared remote HTTP MCP with API key
    const createSharedHttp = await admin.request<{ server: { id: string } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'shared-api',
        scope: 'shared',
        transport: 'http',
        url: 'https://93.184.216.34/mcp',
        authType: 'api_key',
        headers: [{ name: 'X-API-Key', value: 'shared-key-9876' }],
      }
    );
    expect(createSharedHttp.status).toBe(201);

    // Admin creates shared remote SSE MCP with Bearer token
    const createSharedSse = await admin.request<{ server: { id: string } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'shared-sse',
        scope: 'shared',
        transport: 'sse',
        url: 'https://93.184.216.34/sse',
        authType: 'bearer',
        headers: [{ name: 'Authorization', value: 'Bearer shared-bearer-token' }],
      }
    );
    expect(createSharedSse.status).toBe(201);

    // Admin creates profile-only MCP
    const createProfileOnly = await admin.request<{ server: { id: string } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'admin-private',
        scope: 'profile',
        transport: 'http',
        url: 'https://93.184.216.35/mcp',
        authType: 'headers',
        headers: [{ name: 'X-Admin-Token', value: 'admin-secret-token' }],
      }
    );
    expect(createProfileOnly.status).toBe(201);

    // Admin creates profile-scoped override with same name "shared-api"
    const createOverride = await admin.request<{ server: { id: string } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'shared-api',
        scope: 'profile',
        transport: 'http',
        url: 'https://93.184.216.36/mcp',
        authType: 'api_key',
        headers: [{ name: 'X-API-Key', value: 'admin-override-key' }],
      }
    );
    expect(createOverride.status).toBe(201);

    // PATCH with keepExisting preserves encrypted secret without returning plaintext
    const patchKeep = await admin.request<{ server: Record<string, unknown> }>(
      'PATCH',
      `/api/mcp/servers/${createSharedHttp.data.server.id}`,
      {
        description: 'Updated description',
        headers: [{ name: 'X-API-Key', keepExisting: true }],
      }
    );
    expect(patchKeep.status).toBe(200);
    expect(JSON.stringify(patchKeep.data)).not.toContain('shared-key-9876');

    // Non-admin still cannot update or delete admin's MCP server
    expect(
      (await regular.request('DELETE', `/api/mcp/servers/${createSharedHttp.data.server.id}`)).status
    ).toBe(403);

    // Inspect MCP servers delivered natively over ACP to regular user
    const userChat = await regular.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'User MCP Chat',
    });
    expect(userChat.status).toBe(201);
    const userMcp = await runInspectPrompt(regular, userChat.data.chat.id);
    const userNames = userMcp.map((m) => m.name).sort();
    expect(userNames).toEqual(['shared-api', 'shared-local', 'shared-sse']);

    const userSharedApi = userMcp.find((m) => m.name === 'shared-api') as {
      type: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    expect(userSharedApi.type).toBe('http');
    expect(userSharedApi.url).toBe('https://93.184.216.34/mcp');
    expect(userSharedApi.headers).toEqual([{ name: 'X-API-Key', value: 'shared-key-9876' }]);

    const userSharedLocal = userMcp.find((m) => m.name === 'shared-local') as {
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    };
    expect(userSharedLocal.command).toContain('node');
    expect(userSharedLocal.env).toEqual([{ name: 'API_SECRET', value: 'super-secret-env-1234' }]);

    // Inspect MCP servers delivered natively over ACP to admin
    const adminChat = await admin.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Admin MCP Chat',
    });
    expect(adminChat.status).toBe(201);
    const adminMcp = await runInspectPrompt(admin, adminChat.data.chat.id);
    const adminNames = adminMcp.map((m) => m.name).sort();
    expect(adminNames).toEqual(['admin-private', 'shared-api', 'shared-local', 'shared-sse']);

    // Profile-scoped override wins for admin
    const adminSharedApi = adminMcp.find((m) => m.name === 'shared-api') as { url: string };
    expect(adminSharedApi.url).toBe('https://93.184.216.36/mcp');

    // SSRF protection: reject loopback, private, and link-local/metadata URLs by default
    for (const blockedUrl of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8080/mcp',
      'http://localhost:3000/mcp',
      'http://localhost./mcp',
      'http://10.0.0.1/mcp',
      'http://[::1]/mcp',
    ]) {
      const ssrfRes = await admin.request('POST', '/api/mcp/servers', {
        name: 'ssrf-test',
        scope: 'profile',
        transport: 'http',
        url: blockedUrl,
      });
      expect(ssrfRes.status).toBe(400);
    }

    // X-Forwarded-Host header must not override callbackUrl host
    const listWithSpoofedHost = await admin.request<{ callbackUrl: string }>(
      'GET',
      '/api/mcp/servers',
      undefined,
      { headers: { 'x-forwarded-host': 'evil.example.com' } }
    );
    expect(listWithSpoofedHost.status).toBe(200);
    expect(listWithSpoofedHost.data.callbackUrl).not.toContain('evil.example.com');

    // JSON import skips invalid names instead of aborting valid entries
    const importRes = await admin.request<{ imported: Array<{ name: string; transport: string }>; skipped: string[] }>(
      'POST',
      '/api/mcp/import',
      {
        scope: 'profile',
        rawJson: JSON.stringify({
          mcpServers: {
            'bad name!': {
              serverUrl: 'https://invalid-name.example.com/mcp',
            },
            'imported-remote': {
              serverUrl: 'https://imported.example.com/mcp',
              headers: { Authorization: 'Bearer imported-tok' },
            },
            'imported-stdio': {
              command: 'node',
              args: ['--version'],
            },
          },
        }),
      }
    );
    expect(importRes.status).toBe(201);
    expect(importRes.data.imported.map((s) => s.name).sort()).toEqual([
      'imported-remote',
      'imported-stdio',
    ]);
    expect(importRes.data.skipped).toContain('bad name!');

    admin.closeWs();
    regular.closeWs();
  });

  it('completes full Remote MCP OAuth 2.1 flow (RFC 9728 + RFC 8414 + DCR + PKCE + refresh) and injects Bearer token into ACP', async () => {
    const srv = await createTestServer({ allowPrivateMcpUrls: true });
    servers.push(srv);

    const { client: admin } = await registerAndBindAgy(srv.baseUrl, 'oauthadmin', 'user:oauth-a');
    const { client: regular } = await registerAndBindAgy(srv.baseUrl, 'oauthuser', 'user:oauth-b');
    await admin.connectWs({ clientId: 'oauth-admin-ws' });

    // Local mock OAuth 2.1 + Remote Streamable HTTP MCP server
    let issuedCodeChallenge = '';
    let currentAccessToken = 'oauth-access-token-v1';
    const currentRefreshToken = 'oauth-refresh-token-v1';
    let tokenRefreshCount = 0;

    let mockBaseUrl = '';
    const mockServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', mockBaseUrl);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const rawBody = Buffer.concat(chunks).toString('utf8');

      if (reqUrl.pathname === '/.well-known/oauth-protected-resource') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            resource: `${mockBaseUrl}/mcp`,
            authorization_servers: [mockBaseUrl],
            scopes_supported: ['mcp:read', 'mcp:write'],
          })
        );
        return;
      }

      if (reqUrl.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: mockBaseUrl,
            authorization_endpoint: `${mockBaseUrl}/authorize`,
            token_endpoint: `${mockBaseUrl}/token`,
            registration_endpoint: `${mockBaseUrl}/register`,
            code_challenge_methods_supported: ['S256'],
          })
        );
        return;
      }

      if (reqUrl.pathname === '/register' && req.method === 'POST') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            client_id: 'dcr-client-123',
            token_endpoint_auth_method: 'none',
          })
        );
        return;
      }

      if (reqUrl.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(rawBody);
        const grantType = form.get('grant_type');
        if (grantType === 'authorization_code') {
          const verifier = form.get('code_verifier') ?? '';
          const computedChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
          if (computedChallenge !== issuedCodeChallenge) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE mismatch' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: currentAccessToken,
              refresh_token: currentRefreshToken,
              token_type: 'Bearer',
              expires_in: 3600,
              scope: 'mcp:read mcp:write',
            })
          );
          return;
        }
        if (grantType === 'refresh_token' && form.get('refresh_token') === currentRefreshToken) {
          tokenRefreshCount += 1;
          currentAccessToken = `oauth-access-token-v${tokenRefreshCount + 1}`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: currentAccessToken,
              refresh_token: currentRefreshToken,
              token_type: 'Bearer',
              expires_in: 3600,
            })
          );
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
        return;
      }

      if (reqUrl.pathname === '/mcp' && req.method === 'POST') {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${currentAccessToken}`) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${mockBaseUrl}/.well-known/oauth-protected-resource"`,
          });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-03-26',
              serverInfo: { name: 'mock-oauth-mcp', version: '2.0.0' },
              capabilities: {},
            },
          })
        );
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    httpServers.push(mockServer);
    const addr = mockServer.address() as { port: number };
    mockBaseUrl = `http://127.0.0.1:${addr.port}`;

    // Admin adds remote OAuth MCP with ONLY url (no manual clientId/endpoints)
    const created = await admin.request<{ server: { id: string; oauth: { status: string } } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'remote-oauth',
        scope: 'shared',
        transport: 'http',
        url: `${mockBaseUrl}/mcp`,
        authType: 'oauth',
      }
    );
    expect(created.status).toBe(201);
    const serverId = created.data.server.id;
    expect(created.data.server.oauth.status).toBe('disconnected');

    // Connection test before auth detects 401 & discovers OAuth endpoints
    const preTest = await admin.request<{
      result: { ok: boolean; status: string; discoveredOAuth?: { authorizationUrl?: string } };
    }>('POST', `/api/mcp/servers/${serverId}/test`, {});
    expect(preTest.status).toBe(200);
    expect(preTest.data.result.ok).toBe(false);
    expect(preTest.data.result.status).toBe('oauth_required');
    expect(preTest.data.result.discoveredOAuth?.authorizationUrl).toBe(`${mockBaseUrl}/authorize`);

    // Start OAuth flow (performs discovery + RFC 7591 DCR + PKCE)
    const startRes = await admin.request<{ authorizationUrl: string; state: string }>(
      'POST',
      `/api/mcp/servers/${serverId}/oauth/start`,
      {}
    );
    expect(startRes.status).toBe(200);
    const authUrl = new URL(startRes.data.authorizationUrl);
    expect(authUrl.origin + authUrl.pathname).toBe(`${mockBaseUrl}/authorize`);
    expect(authUrl.searchParams.get('client_id')).toBe('dcr-client-123');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    issuedCodeChallenge = authUrl.searchParams.get('code_challenge') ?? '';
    expect(issuedCodeChallenge.length).toBeGreaterThan(20);

    // Non-admin cannot hijack callback
    const hijackRes = await regular.request(
      'GET',
      `/api/mcp/oauth/callback?code=auth-code-1&state=${encodeURIComponent(startRes.data.state)}`
    );
    expect(hijackRes.status).toBe(403);

    // Admin completes OAuth callback
    const cbRes = await admin.request<string>(
      'GET',
      `/api/mcp/oauth/callback?code=auth-code-1&state=${encodeURIComponent(startRes.data.state)}`
    );
    expect(cbRes.status).toBe(200);
    expect(cbRes.data).toContain('agy-mcp-oauth-complete');

    // Connection test now succeeds with serverInfo
    const postTest = await admin.request<{
      result: { ok: boolean; status: string; serverInfo?: { name?: string } };
    }>('POST', `/api/mcp/servers/${serverId}/test`, {});
    expect(postTest.status).toBe(200);
    expect(postTest.data.result.ok).toBe(true);
    expect(postTest.data.result.serverInfo?.name).toBe('mock-oauth-mcp');

    // ACP session receives Authorization: Bearer oauth-access-token-v1
    const chatRes = await admin.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'OAuth MCP Chat',
    });
    const mcpList = await runInspectPrompt(admin, chatRes.data.chat.id);
    const oauthServer = mcpList.find((m) => m.name === 'remote-oauth') as {
      type: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    expect(oauthServer).toBeTruthy();
    expect(oauthServer.type).toBe('http');
    expect(oauthServer.headers).toEqual([
      { name: 'Authorization', value: 'Bearer oauth-access-token-v1' },
    ]);

    // Force token expiry and verify automatic refresh on next session
    const storedRow = srv.ctx.db.getMcpServerById(serverId)!;
    const { encryptSmallSecret } = await import('../src/auth/password.js');
    srv.ctx.db.updateMcpServer(serverId, {
      encryptedOauthTokensJson: encryptSmallSecret(
        JSON.stringify({
          accessToken: 'oauth-access-token-v1',
          refreshToken: currentRefreshToken,
          tokenType: 'Bearer',
          expiresAt: Date.now() - 5000,
        }),
        srv.ctx.config.sessionSecret
      ),
    });
    await srv.ctx.acp.stopIdleWorkersForAllUsers();

    const chatRes2 = await admin.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'OAuth Refreshed Chat',
    });
    const mcpList2 = await runInspectPrompt(admin, chatRes2.data.chat.id);
    const refreshedServer = mcpList2.find((m) => m.name === 'remote-oauth') as {
      headers: Array<{ name: string; value: string }>;
    };
    expect(tokenRefreshCount).toBe(1);
    expect(refreshedServer.headers).toEqual([
      { name: 'Authorization', value: 'Bearer oauth-access-token-v2' },
    ]);

    // Disconnect clears tokens
    const discRes = await admin.request<{ server: { oauth: { status: string } } }>(
      'POST',
      `/api/mcp/servers/${serverId}/oauth/disconnect`,
      {}
    );
    expect(discRes.status).toBe(200);
    expect(discRes.data.server.oauth.status).toBe('disconnected');

    admin.closeWs();
  });
});
