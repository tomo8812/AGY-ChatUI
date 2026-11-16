import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toHostWorkspacePath } from '../src/acp/client-manager.js';
import {
  buildAgyCommandSpec,
  buildIsolatedAgyEnv,
  clearSandboxProbeCache,
  getChatBrainHostDir,
  probeBwrapSandbox,
  SANDBOX_HOME_MOUNT,
  SANDBOX_WORKSPACE_MOUNT,
} from '../src/acp/env-isolation.js';
import { loadConfig } from '../src/config.js';
import { createTestServer, registerAndBindAgy, TestApiClient } from './helpers/test-harness.js';

function hasContiguousSlice(arr: string[], sub: string[]): boolean {
  for (let i = 0; i <= arr.length - sub.length; i++) {
    if (sub.every((v, idx) => arr[i + idx] === v)) return true;
  }
  return false;
}

describe('Draft Chat History Filtering & Workspace Sandbox', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    clearSandboxProbeCache();
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('excludes 0-message chats from listChats until first message is sent and returns promoted chat on send', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs({ clientId: 'alice-draft-test' });

    const projRes = await alice.request<{ project: { id: string } }>('POST', '/api/projects', {
      name: 'Alpha Project',
    });
    const projectId = projRes.data.project.id;

    // Creating several chats without sending any messages must NOT show up in GET /api/chats
    const empty1 = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Empty Default',
    });
    const empty2 = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      projectId,
    });
    expect(empty1.status).toBe(201);
    expect(empty2.status).toBe(201);

    expect((await alice.request<{ chats: unknown[] }>('GET', '/api/chats')).data.chats).toHaveLength(0);
    expect(
      (await alice.request<{ chats: unknown[] }>('GET', `/api/chats?projectId=${encodeURIComponent(projectId)}`))
        .data.chats
    ).toHaveLength(0);
    expect(
      (await alice.request<{ chats: unknown[] }>('GET', '/api/chats?search=Empty')).data.chats
    ).toHaveLength(0);

    // Direct GET on draft-backed chat still works before first message
    expect((await alice.request('GET', `/api/chats/${empty2.data.chat.id}`)).status).toBe(200);

    // Send first prompt -> response includes promoted chat with updated title and appears in listChats
    const sendRes = await alice.request<{
      chat: { id: string; title: string; projectId: string | null };
      run: { id: string };
      deduplicated: boolean;
    }>('POST', `/api/chats/${empty2.data.chat.id}/messages`, {
      text: 'Summarize Q4 launch checklist',
      clientMessageId: 'draft-promote-1',
    });
    expect(sendRes.status).toBe(202);
    expect(sendRes.data.deduplicated).toBe(false);
    expect(sendRes.data.chat.id).toBe(empty2.data.chat.id);
    expect(sendRes.data.chat.title).toBe('Summarize Q4 launch checklist');

    // Deduplicated retry also returns the chat object
    const dupRes = await alice.request<{
      chat: { id: string; title: string };
      deduplicated: boolean;
    }>('POST', `/api/chats/${empty2.data.chat.id}/messages`, {
      text: 'Summarize Q4 launch checklist',
      clientMessageId: 'draft-promote-1',
    });
    expect(dupRes.status).toBe(200);
    expect(dupRes.data.deduplicated).toBe(true);
    expect(dupRes.data.chat.id).toBe(empty2.data.chat.id);

    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const listedAll = await alice.request<{ chats: Array<{ id: string }> }>('GET', '/api/chats');
    expect(listedAll.data.chats.map((c) => c.id)).toEqual([empty2.data.chat.id]);

    const listedProj = await alice.request<{ chats: Array<{ id: string }> }>(
      'GET',
      `/api/chats?projectId=${encodeURIComponent(projectId)}`
    );
    expect(listedProj.data.chats.map((c) => c.id)).toEqual([empty2.data.chat.id]);

    const listedSearch = await alice.request<{ chats: Array<{ id: string }> }>(
      'GET',
      '/api/chats?search=checklist'
    );
    expect(listedSearch.data.chats.map((c) => c.id)).toEqual([empty2.data.chat.id]);

    alice.closeWs();
  });

  it('translates /workspace sandbox paths cleanly and blocks host escapes in link resolver', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST',
      '/api/chats',
      { title: 'Workspace Mapping Test' }
    );
    const chatId = chatRes.data.chat.id;
    const hostWs = chatRes.data.chat.workspaceDir;

    expect(toHostWorkspacePath(hostWs, '/workspace', '/workspace')).toBe(hostWs);
    expect(toHostWorkspacePath(hostWs, '/workspace', '/workspace/sub/file.ts')).toBe('sub/file.ts');
    expect(toHostWorkspacePath(hostWs, '/workspace', 'file:///workspace/summary.md')).toBe('summary.md');
    expect(toHostWorkspacePath(hostWs, '/workspace', 'nested/plain.txt')).toBe('nested/plain.txt');

    // Generate artifacts in workspace
    await alice.request('POST', `/api/chats/${chatId}/messages`, { text: 'Build deliverables [ARTIFACT]' });
    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const bySandboxPath = await alice.request<{ artifact: { filename: string } }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: '/workspace/summary.md' }
    );
    expect(bySandboxPath.status).toBe(200);
    expect(bySandboxPath.data.artifact.filename).toBe('summary.md');

    const bySandboxFileUri = await alice.request<{ artifact: { filename: string } }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: 'file:///workspace/metrics.csv#L1-L2' }
    );
    expect(bySandboxFileUri.status).toBe(200);
    expect(bySandboxFileUri.data.artifact.filename).toBe('metrics.csv');

    // Exact /workspace directory (not a file) and traversal must reject cleanly
    expect(
      (await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: '/workspace' })).status
    ).toBe(404);
    expect(
      (
        await alice.request('POST', `/api/chats/${chatId}/resolve-link`, {
          reference: '/workspace/../../etc/passwd',
        })
      ).status
    ).toBe(404);
    expect(
      (await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: 'file:///etc/hosts' }))
        .status
    ).toBe(404);

    alice.closeWs();
  });

  it('strips sensitive host env vars with strict allowlist and constructs whitelist bwrap rootfs', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bwrap-spec-'));
    cleanups.push(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    const profileDir = path.join(tmpRoot, 'profiles', 'u1', 'agy-home');
    const workspaceDir = path.join(tmpRoot, 'workspaces', 'u1', 'c1');
    fs.mkdirSync(workspaceDir, { recursive: true });

    const prevEnv: Record<string, string | undefined> = {
      SESSION_SECRET: process.env.SESSION_SECRET,
      GITHUB_READ_TOKEN: process.env.GITHUB_READ_TOKEN,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      RANDOM_SECRET_TOKEN: process.env.RANDOM_SECRET_TOKEN,
      LANG: process.env.LANG,
    };
    process.env.SESSION_SECRET = 'super-secret-session';
    process.env.GITHUB_READ_TOKEN = 'ghp_secret123';
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';
    process.env.RANDOM_SECRET_TOKEN = 'should-not-leak';
    process.env.LANG = 'C.UTF-8';
    cleanups.push(() => {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const isolatedEnv = buildIsolatedAgyEnv({
      profileDir,
      sandboxTmpDir: '/tmp',
    });
    expect(isolatedEnv.SESSION_SECRET).toBeUndefined();
    expect(isolatedEnv.GITHUB_READ_TOKEN).toBeUndefined();
    expect(isolatedEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(isolatedEnv.RANDOM_SECRET_TOKEN).toBeUndefined();
    expect(isolatedEnv.LANG).toBe('C.UTF-8');
    expect(isolatedEnv.USER).toBe('sandbox');
    expect(isolatedEnv.LOGNAME).toBe('sandbox');
    expect(isolatedEnv.HOME).toBe(profileDir);
    expect(isolatedEnv.TMPDIR).toBe('/tmp');
    expect(isolatedEnv.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');

    if (process.platform === 'linux') {
      // Simulate external agy binary installed outside /usr or /bin (e.g. ~/.local/bin/agy)
      const extBin = path.join(tmpRoot, 'custom-agy');
      fs.writeFileSync(extBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const cfg = loadConfig({
        agyMode: 'real',
        sandboxMode: 'strict',
        agyBin: extBin,
        bwrapBin: '/usr/bin/bwrap',
        dataRoot: tmpRoot,
      });
      const spec = buildAgyCommandSpec({
        config: cfg,
        subcommandArgs: ['acp'],
        profileDir,
        workspaceDir,
        enableSandboxBwrap: true,
      });

      expect(spec.sandboxed).toBe(true);
      expect(spec.sandboxWorkspaceRoot).toBe(SANDBOX_WORKSPACE_MOUNT);
      expect(spec.command).toBe('/usr/bin/bwrap');
      // Must NOT mount host root `/` or expose host profileDir path
      expect(hasContiguousSlice(spec.args, ['--ro-bind', '/', '/'])).toBe(false);
      expect(hasContiguousSlice(spec.args, ['--bind', profileDir, profileDir])).toBe(false);
      // Namespace isolation, cap drop, and workspace bind at /workspace
      expect(hasContiguousSlice(spec.args, ['--unshare-pid'])).toBe(true);
      expect(hasContiguousSlice(spec.args, ['--unshare-ipc'])).toBe(true);
      expect(hasContiguousSlice(spec.args, ['--unshare-uts'])).toBe(true);
      expect(hasContiguousSlice(spec.args, ['--cap-drop', 'ALL'])).toBe(true);
      expect(hasContiguousSlice(spec.args, ['--new-session'])).toBe(true);
      expect(hasContiguousSlice(spec.args, ['--die-with-parent'])).toBe(true);
      expect(hasContiguousSlice(spec.args, ['--dir', '/home'])).toBe(true);
      expect(hasContiguousSlice(spec.args, ['--dir', '/root'])).toBe(true);
      expect(hasContiguousSlice(spec.args, ['--bind', workspaceDir, '/workspace'])).toBe(true);
      expect(hasContiguousSlice(spec.args, ['--bind', profileDir, SANDBOX_HOME_MOUNT])).toBe(true);
      const chatBrainHostDir = getChatBrainHostDir(profileDir, workspaceDir);
      expect(
        hasContiguousSlice(spec.args, [
          '--bind',
          chatBrainHostDir,
          `${SANDBOX_HOME_MOUNT}/.gemini/antigravity-cli/brain`,
        ])
      ).toBe(true);
      expect(spec.env.HOME).toBe(SANDBOX_HOME_MOUNT);
      expect(hasContiguousSlice(spec.args, ['--chdir', '/workspace'])).toBe(true);
      expect(hasContiguousSlice(spec.args, ['--ro-bind', fs.realpathSync(extBin), '/opt/agy/agy'])).toBe(
        true
      );
      expect(spec.env.PATH?.startsWith('/opt/agy:')).toBe(true);
      expect(spec.args.slice(-3)).toEqual(['--', '/opt/agy/agy', 'acp']);

      // Synthetic /etc/passwd & /etc/group created cleanly
      const passwdIdx = spec.args.indexOf('/etc/passwd');
      expect(passwdIdx).toBeGreaterThan(0);
      const hostPasswd = spec.args[passwdIdx - 1];
      expect(fs.readFileSync(hostPasswd, 'utf8')).toContain(`:${SANDBOX_WORKSPACE_MOUNT}:/bin/bash`);
    }
  });

  it('auto-syncs subagent brain images into generated/ and waits for native Reactive Wakeup continuation', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST',
      '/api/chats',
      { title: 'Subagent Native Continuation' }
    );
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    // Native subagent brain image generation must sync to /workspace/generated/, mark isSubagent, and wait for Reactive Wakeup continuation
    await alice.request('POST', `/api/chats/${chatId}/messages`, {
      text: 'Generate cyber cat [SUBAGENT_IMAGE]',
    });
    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const detailAfterSubagent = await alice.request<{
      messages: Array<{
        role: string;
        contentText: string;
        toolCalls: Array<{
          title: string;
          status: string;
          isSubagent?: boolean;
          subagentLabel?: string;
        }>;
      }>;
      artifacts: Array<{ id: string; filename: string; relPath: string }>;
    }>('GET', `/api/chats/${chatId}`);

    const assistantMsgs = detailAfterSubagent.data.messages.filter((m) => m.role === 'assistant');
    const latestAssistant = assistantMsgs[assistantMsgs.length - 1];
    expect(latestAssistant).toBeTruthy();
    expect(latestAssistant.toolCalls).toHaveLength(1);
    expect(latestAssistant.toolCalls[0].isSubagent).toBe(true);
    expect(latestAssistant.toolCalls[0].status).toBe('completed');
    // Automatic continuation response and generated/ link should be present
    expect(latestAssistant.contentText).toContain('サブエージェントによる画像生成が完了しました');
    expect(latestAssistant.contentText).toContain('subagent-art.png');
    // File exists in workspace/generated/subagent-art.png and is registered as an artifact
    expect(fs.existsSync(path.join(workspaceDir, 'generated', 'subagent-art.png'))).toBe(true);
    expect(
      detailAfterSubagent.data.artifacts.some((a) => a.relPath === 'generated/subagent-art.png')
    ).toBe(true);

    alice.closeWs();
  });

  it('reports sandbox status cleanly via probeBwrapSandbox and authenticated bootstrap endpoints', async () => {
    const offCfg = loadConfig({ agyMode: 'real', sandboxMode: 'off' });
    const offStatus = probeBwrapSandbox(offCfg, false);
    expect(offStatus.active).toBe(false);
    expect(offStatus.mode).toBe('off');
    expect(offStatus.backend).toBe('none');

    const missingCfg = loadConfig({
      agyMode: 'real',
      sandboxMode: 'auto',
      bwrapBin: '/nonexistent/bwrap-binary-missing',
    });
    const missingStatus = probeBwrapSandbox(missingCfg, false);
    expect(missingStatus.active).toBe(false);
    expect(missingStatus.backend).toBe('none');
    expect(missingStatus.reason).toBeTruthy();

    // Authenticated bootstrap/login/me carry sandbox metadata; unauthenticated hides it
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const anon = new TestApiClient(srv.baseUrl);
    const anonBoot = await anon.request<{ authenticated: boolean; sandbox: unknown }>(
      'GET',
      '/api/auth/bootstrap'
    );
    expect(anonBoot.data.authenticated).toBe(false);
    expect(anonBoot.data.sandbox).toBeNull();

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const authBoot = await alice.request<{
      authenticated: boolean;
      sandbox: { mode: string; active: boolean; backend: string } | null;
    }>('GET', '/api/auth/bootstrap');
    expect(authBoot.data.authenticated).toBe(true);
    expect(authBoot.data.sandbox).toMatchObject({
      mode: 'auto',
      active: false,
      backend: 'mock',
    });

    const meRes = await alice.request<{ sandbox: { backend: string } | null }>('GET', '/api/auth/me');
    expect(meRes.data.sandbox?.backend).toBe('mock');
  });
});
