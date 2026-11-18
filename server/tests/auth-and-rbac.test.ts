import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensurePerChatHomeDir } from '../src/acp/env-isolation.js';
import { createApp } from '../src/app.js';
import { createTestServer, registerAndBindAgy, TestApiClient } from './helpers/test-harness.js';

describe('Web Auth, Mandatory Agy Code-Paste Binding, and Strict Multi-User RBAC', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it('initializes missing CLI settings and edits only the signed-in profile agent mode', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const alice = new TestApiClient(srv.baseUrl);
    const bob = new TestApiClient(srv.baseUrl);
    const register = (client: TestApiClient, username: string) =>
      client.request<{ agyProfile: { profileDir: string } }>('POST', '/api/auth/register', {
        username,
        password: 'password123',
      });
    const aliceRegistration = await register(alice, 'alice');
    const bobRegistration = await register(bob, 'bob');
    const aliceDir = aliceRegistration.data.agyProfile.profileDir;
    const bobDir = bobRegistration.data.agyProfile.profileDir;
    const settingsPath = (dir: string) => path.join(dir, '.gemini', 'antigravity-cli', 'settings.json');
    const readSettings = (dir: string) => JSON.parse(fs.readFileSync(settingsPath(dir), 'utf8'));
    expect(readSettings(aliceDir)).toEqual({ agentMode: 'auto' });
    expect(readSettings(bobDir)).toEqual({ agentMode: 'auto' });

    const route = '/api/agy/agent-mode';
    const anonymous = new TestApiClient(srv.baseUrl);
    expect((await anonymous.request('GET', route)).status).toBe(401);
    expect((await alice.request('PATCH', route, { agentMode: 'plan' }, { omitCsrf: true })).status).toBe(403);
    expect((await alice.request('PATCH', route, { agentMode: 'default' })).status).toBe(400);

    const existing = { enableTerminalSandbox: true, toolPermission: { deny: ['example'] } };
    fs.writeFileSync(settingsPath(aliceDir), JSON.stringify(existing));
    expect((await alice.request('GET', route)).data).toEqual({ agentMode: null });
    expect(readSettings(aliceDir)).toEqual(existing);
    const chatHome = ensurePerChatHomeDir(aliceDir, path.join(srv.ctx.config.workspacesRoot, 'test-chat'));

    expect((await alice.request('PATCH', route, { agentMode: '' })).data).toEqual({ agentMode: '' });
    expect(readSettings(aliceDir)).toEqual({ ...existing, agentMode: '' });
    expect(readSettings(chatHome)).toEqual({ ...existing, agentMode: '' });
    expect((await bob.request('GET', route)).data).toEqual({ agentMode: 'auto' });

    fs.rmSync(settingsPath(bobDir));
    const restarted = await createApp(srv.ctx.config);
    cleanups.push(restarted.shutdown);
    expect(readSettings(bobDir)).toEqual({ agentMode: 'auto' });
    expect(readSettings(aliceDir)).toEqual({ ...existing, agentMode: '' });
  });

  it('enforces Web auth, CSRF, mandatory initial Antigravity code-paste login, and API key disconnect/rebind', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const alice = new TestApiClient(srv.baseUrl);
    const boot0 = await alice.request<{ userCount: number; authenticated: boolean }>(
      'GET',
      '/api/auth/bootstrap'
    );
    expect(boot0.status).toBe(200);
    expect(boot0.data.userCount).toBe(0);
    expect(boot0.data.authenticated).toBe(false);

    // First user registers cleanly and becomes admin
    const reg = await alice.request<{ user: { id: string; role: string }; agyProfile: { authStatus: string } }>(
      'POST',
      '/api/auth/register',
      { username: 'alice', password: 'secret-password-1' }
    );
    expect(reg.status).toBe(201);
    expect(reg.data.user.role).toBe('admin');
    expect(reg.data.agyProfile.authStatus).toBe('unauthenticated');

    // Mutating request without CSRF token must be rejected
    const csrfBlocked = await alice.request('POST', '/api/projects', { name: 'Should Fail' }, { omitCsrf: true });
    expect(csrfBlocked.status).toBe(403);

    // Creating a chat before Antigravity auth must be rejected with 403 AGY_AUTH_REQUIRED
    const blockedChat = await alice.request<{ error: string }>('POST', '/api/chats', { title: 'Early' });
    expect(blockedChat.status).toBe(403);
    expect(blockedChat.data.error).toBe('AGY_AUTH_REQUIRED');

    // Connect WebSocket and initiate code-paste login
    await alice.connectWs({ clientId: 'alice-tab-1' });
    const started = await alice.request<{ loginFlow: { authUrl: string; status: string } }>(
      'POST',
      '/api/agy/login/start',
      { accountLabel: 'alice@gmail.com' }
    );
    expect(started.status).toBe(200);
    expect(started.data.loginFlow.authUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');

    // Submitting invalid code fails without authenticating
    const badCode = await alice.request<{ profile: { authStatus: string }; loginFlow: { status: string } }>(
      'POST',
      '/api/agy/login/code',
      { code: 'invalid' }
    );
    expect(badCode.status).toBe(200);
    expect(badCode.data.loginFlow.status).toBe('failed');
    expect(badCode.data.profile.authStatus).not.toBe('authenticated');

    // Re-issue and submit valid code -> PTY authenticates -> ACP initialize + session/new verifies
    await alice.request('POST', '/api/agy/login/start', { accountLabel: 'alice@gmail.com' });
    const goodCode = await alice.request<{
      profile: { authStatus: string; authMethod: string; accountLabel: string };
      loginFlow: { status: string };
    }>('POST', '/api/agy/login/code', { code: 'user:alice@gmail.com' });
    expect(goodCode.data.profile.authStatus).toBe('authenticated');
    expect(goodCode.data.profile.authMethod).toBe('oauth-personal');
    expect(goodCode.data.profile.accountLabel).toBe('alice@gmail.com');

    // WS received agy.auth_changed notification
    const authEvt = await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'agy.auth_changed'
    );
    expect(authEvt).toBeTruthy();

    // Now chat creation works cleanly!
    const createdChat = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Alice First Chat',
    });
    expect(createdChat.status).toBe(201);
    expect(createdChat.data.chat.id).toBeTruthy();

    // Disconnect Antigravity profile -> returns to unauthenticated & blocks new chat creation again
    const disconnected = await alice.request<{ profile: { authStatus: string } }>('POST', '/api/agy/disconnect');
    expect(disconnected.data.profile.authStatus).toBe('unauthenticated');
    const blockedAfterDisconnect = await alice.request('POST', '/api/chats', { title: 'After Disconnect' });
    expect(blockedAfterDisconnect.status).toBe(403);

    // Re-bind via optional Gemini API Key
    const apiKeyRes = await alice.request<{ profile: { authStatus: string; authMethod: string } }>(
      'POST',
      '/api/agy/api-key',
      { apiKey: 'AIzaSyMockGeminiKey123456', accountLabel: 'Alice API Key' }
    );
    expect(apiKeyRes.status).toBe(200);
    expect(apiKeyRes.data.profile.authStatus).toBe('authenticated');
    expect(apiKeyRes.data.profile.authMethod).toBe('gemini-api-key');

    alice.closeWs();
  });

  it('isolates chats, projects, artifacts, quotas, and WebSockets strictly across distinct users', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const { client: bob } = await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');

    await alice.connectWs({ clientId: 'alice-ws' });
    await bob.connectWs({ clientId: 'bob-ws' });

    const projA = await alice.request<{ project: { id: string } }>('POST', '/api/projects', {
      name: 'Alice Secret Project',
      instructions: 'Secret instructions',
    });
    const chatA = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Alice Private Chat',
      projectId: projA.data.project.id,
    });
    const sentA = await alice.request('POST', `/api/chats/${chatA.data.chat.id}/messages`, {
      text: 'Hello [ARTIFACT]',
    });
    expect(sentA.status).toBe(202);

    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const aliceDetail = await alice.request<{ artifacts: Array<{ id: string }> }>(
      'GET',
      `/api/chats/${chatA.data.chat.id}`
    );
    const aliceArtifactId = aliceDetail.data.artifacts[0].id;

    // Bob MUST NOT access Alice's chat, project, workspace, artifact, or resolve-link
    expect((await bob.request('GET', `/api/chats/${chatA.data.chat.id}`)).status).toBe(404);
    expect((await bob.request('PATCH', `/api/chats/${chatA.data.chat.id}`, { title: 'Hacked' })).status).toBe(404);
    expect((await bob.request('DELETE', `/api/chats/${chatA.data.chat.id}`)).status).toBe(404);
    expect((await bob.request('GET', `/api/projects/${projA.data.project.id}`)).status).toBe(404);
    expect((await bob.request('GET', `/api/chats/${chatA.data.chat.id}/workspace`)).status).toBe(404);
    expect((await bob.request('GET', `/api/files/${aliceArtifactId}`)).status).toBe(404);
    expect((await bob.request('GET', `/api/files/${aliceArtifactId}/content`)).status).toBe(404);
    expect(
      (
        await bob.request('POST', `/api/chats/${chatA.data.chat.id}/resolve-link`, {
          reference: 'summary.md',
        })
      ).status
    ).toBe(404);

    // Bob's WebSocket MUST NOT have received any of Alice's chat/message/artifact events
    const leaked = bob.wsFrames.find(
      (f) => f.kind === 'event' && (f.event as { chatId?: string }).chatId === chatA.data.chat.id
    );
    expect(leaked).toBeUndefined();

    // Per-account quota isolation check (`alice` -> 84%, `bob` -> 42% in mock profile)
    const qA = await alice.request<{ quota: { buckets: Array<{ remainingPercent: number }> } }>(
      'POST',
      '/api/quota/refresh'
    );
    const qB = await bob.request<{ quota: { buckets: Array<{ remainingPercent: number }> } }>(
      'POST',
      '/api/quota/refresh'
    );
    expect(qA.data.quota.buckets[0].remainingPercent).toBe(84);
    expect(qB.data.quota.buckets[0].remainingPercent).toBe(42);

    alice.closeWs();
    bob.closeWs();
  });
});
