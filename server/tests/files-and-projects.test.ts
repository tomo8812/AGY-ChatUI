import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

describe('Workspaces, Project Isolation, Artifacts, Path Containment & Sandbox', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('copies project files cleanly with copy-on-write isolation and explicit sync-project', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs({ clientId: 'alice-ws' });

    const projRes = await alice.request<{ project: { id: string; contextVersion: number; storageDir: string } }>(
      'POST',
      '/api/projects',
      {
        name: 'Research Project',
        instructions: 'INSTRUCTIONS_V1',
      }
    );
    const projectId = projRes.data.project.id;

    // Upload a reference file to the project
    const fd = new FormData();
    fd.append('files', new Blob(['Spec Content V1\n'], { type: 'text/plain' }), 'spec.txt');
    const upRes = await alice.request<{ project: { contextVersion: number } }>(
      'POST',
      `/api/projects/${projectId}/files`,
      fd
    );
    expect(upRes.status).toBe(201);

    const chat1 = await alice.request<{ chat: { id: string; workspaceDir: string; projectContextVersion: number } }>(
      'POST',
      '/api/chats',
      { title: 'Chat 1', projectId }
    );
    const chat2 = await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST',
      '/api/chats',
      { title: 'Chat 2', projectId }
    );

    // Send prompt checking context in Chat 1
    await alice.request('POST', `/api/chats/${chat1.data.chat.id}/messages`, {
      text: 'Confirm context [CONTEXT_CHECK]',
    });
    const done1 = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; chatId?: string }).type === 'run.finished' &&
        (f.event as { chatId?: string }).chatId === chat1.data.chat.id
    );
    const msg1 = ((done1.event as { payload: { message: { contentText: string } } }).payload.message).contentText;
    expect(msg1).toContain('INSTRUCTIONS_V1');
    expect(msg1).toContain('Spec Content V1');

    // Simulate mutating `.project-context/spec.txt` inside Chat 1 workspace -> must NOT affect Project original or Chat 2!
    fs.writeFileSync(path.join(chat1.data.chat.workspaceDir, '.project-context', 'spec.txt'), 'MUTATED IN CHAT 1');
    expect(fs.readFileSync(path.join(projRes.data.project.storageDir, 'spec.txt'), 'utf8')).toBe('Spec Content V1\n');
    expect(
      fs.readFileSync(path.join(chat2.data.chat.workspaceDir, '.project-context', 'spec.txt'), 'utf8')
    ).toBe('Spec Content V1\n');

    // Update project instructions to V2 & upload v2 doc -> contextVersion bumps
    const updatedProj = await alice.request<{ project: { contextVersion: number } }>(
      'PATCH',
      `/api/projects/${projectId}`,
      { instructions: 'INSTRUCTIONS_V2' }
    );
    expect(updatedProj.data.project.contextVersion).toBeGreaterThan(chat1.data.chat.projectContextVersion);

    const fd2 = new FormData();
    fd2.append('files', new Blob(['Extra Doc V2\n'], { type: 'text/plain' }), 'notes-v2.txt');
    await alice.request('POST', `/api/projects/${projectId}/files`, fd2);

    // Explicitly synchronize Chat 1
    const synced = await alice.request<{ chat: { projectContextVersion: number } }>(
      'POST',
      `/api/chats/${chat1.data.chat.id}/sync-project`
    );
    expect(synced.status).toBe(200);
    expect(synced.data.chat.projectContextVersion).toBeGreaterThan(chat1.data.chat.projectContextVersion);

    // Next turn in Chat 1 picks up INSTRUCTIONS_V2, notes-v2.txt, AND preserves previous turn via transcript bridge
    await alice.request('POST', `/api/chats/${chat1.data.chat.id}/messages`, {
      text: 'Verify after sync [CONTEXT_CHECK]',
    });
    const done2 = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; chatId?: string }).type === 'run.finished' &&
        (f.event as { payload: { message: { contentText: string } } }).payload.message.contentText.includes(
          'Verify after sync'
        ),
      8000,
      true
    );
    const msg2 = ((done2.event as { payload: { message: { contentText: string } } }).payload.message).contentText;
    expect(msg2).toContain('INSTRUCTIONS_V2');
    expect(msg2).toContain('Extra Doc V2');

    alice.closeWs();
  });

  it('blocks path traversal & symlink escape while supporting artifacts, diff patches, Range streaming, and CSP HTML sandbox', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'Artifacts Chat',
    });
    const chatId = chatRes.data.chat.id;

    // Create symlink inside workspace pointing outside workspace (`/etc/hosts`)
    const symlinkPath = path.join(chatRes.data.chat.workspaceDir, 'escape-link.txt');
    fs.symlinkSync('/etc/hosts', symlinkPath);

    // Traversal and symlink escape attempts MUST return 404 from resolve-link
    expect((await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: '../../etc/passwd' })).status).toBe(404);
    expect((await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: '/etc/passwd' })).status).toBe(404);
    expect((await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: 'escape-link.txt' })).status).toBe(404);

    // Generate real artifacts in workspace via [ARTIFACT]
    await alice.request('POST', `/api/chats/${chatId}/messages`, { text: 'Build deliverables [ARTIFACT]' });
    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const resolvedMd = await alice.request<{ artifact: { id: string; diffPatch: string | null } }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: './summary.md#L1' }
    );
    expect(resolvedMd.status).toBe(200);
    expect(resolvedMd.data.artifact.diffPatch).toContain('+# Summary Report');

    // HTTP Byte Range test on generated metrics.csv
    const resolvedCsv = await alice.request<{ artifact: { id: string } }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: 'metrics.csv' }
    );
    const rangeRes = await alice.request<string>(
      'GET',
      `/api/files/${resolvedCsv.data.artifact.id}/content`,
      undefined,
      { headers: { Range: 'bytes=0-11' } }
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toMatch(/^bytes 0-11\/\d+$/);
    expect(rangeRes.data).toBe('metric,value');

    // Sandbox HTML endpoint enforces strict CSP
    const resolvedHtml = await alice.request<{ artifact: { id: string } }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: 'widget.html' }
    );
    const sandboxRes = await alice.request<string>(
      'GET',
      `/api/files/${resolvedHtml.data.artifact.id}/sandbox`
    );
    expect(sandboxRes.status).toBe(200);
    expect(sandboxRes.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(sandboxRes.data).toContain('Isolated Preview');

    alice.closeWs();
  });
});
