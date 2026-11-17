import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getChatBrainHostDir } from '../src/acp/env-isolation.js';
import {
  captureBrainSnapshot,
  InternalPathStreamRewriter,
  syncNewBrainFilesToWorkspace,
  rewriteInternalPathsToWorkspace,
} from '../src/files/link-resolver.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stream-links-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  const brain = path.join(getChatBrainHostDir(profile, workspace), 'session-1');
  fs.mkdirSync(brain, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(brain, 'miffy.jpg'), 'image bytes');
  return { profile, workspace };
}

describe('streamed generated file links', () => {
  it('rewrites paths at every split position, including file URI prefixes and brain directories', () => {
    const { profile, workspace } = fixture();
    for (const reference of [
      '/home/sandbox/.gemini/antigravity-cli/brain/session-1/miffy.jpg',
      'file:///home/sandbox/.gemini/antigravity-cli/brain/session-1/miffy.jpg',
      'file:///home/sandbox/.gemini/antigravity-cli/brain/session-1/%6Diffy.jpg',
    ]) {
      const text = `画像: ![Miffy](${reference}) 保存先: [miffy.jpg](${reference})`;
      const expected = rewriteInternalPathsToWorkspace(text, profile, workspace);
      expect(expected).toContain('/workspace/generated/miffy.jpg');
      expect(expected).not.toContain('.gemini');
      for (let split = 1; split < text.length; split++) {
        const stream = new InternalPathStreamRewriter(profile, workspace);
        const actual = stream.write(text.slice(0, split)) + stream.write(text.slice(split)) + stream.write('', true);
        expect(actual, `split ${split} in ${reference}`).toBe(expected);
      }
      const stream = new InternalPathStreamRewriter(profile, workspace);
      expect([...text].map(char => stream.write(char)).join('') + stream.write('', true)).toBe(expected);
    }
    expect(fs.readFileSync(path.join(workspace, 'generated/miffy.jpg'), 'utf8')).toBe('image bytes');
  });

  it('holds incomplete paths, flushes a final bare link once, and keeps independent streams separate', () => {
    const { profile, workspace } = fixture();
    const content = new InternalPathStreamRewriter(profile, workspace);
    const thoughts = new InternalPathStreamRewriter(profile, workspace);
    expect(content.write('生成しました。file:///home/sandbox/.gemini/antigravity-cli')).toBe('生成しました。');
    expect(thoughts.write('確認しました。')).toBe('確認しました。');
    expect(content.write('/brain/session-1/miffy.jpg')).toBe('');
    expect(content.write('', true)).toBe('file:///workspace/generated/miffy.jpg');
    expect(content.write('', true)).toBe('');
    expect(content.write('次の返答です。')).toBe('次の返答です。');
    expect(content.write('通常の本文')).toBe('通常の本文');
  });

  it('imports changed brain files once and retries when an import fails', () => {
    const { profile, workspace } = fixture();
    const source = path.join(getChatBrainHostDir(profile, workspace), 'session-1', 'miffy.jpg');
    const snapshot = captureBrainSnapshot(profile, workspace);
    fs.writeFileSync(source, 'new image bytes');
    // A non-directory generated path makes the initial import fail.
    fs.writeFileSync(path.join(workspace, 'generated'), 'blocked');
    expect(syncNewBrainFilesToWorkspace({ profileDir: profile, workspaceDir: workspace, snapshot })).toEqual([]);
    fs.unlinkSync(path.join(workspace, 'generated'));
    const imported = syncNewBrainFilesToWorkspace({ profileDir: profile, workspaceDir: workspace, snapshot });
    expect(imported.map(file => file.workspaceRelPath)).toEqual(['generated/miffy.jpg']);
    expect(syncNewBrainFilesToWorkspace({ profileDir: profile, workspaceDir: workspace, snapshot })).toEqual([]);
    fs.writeFileSync(source, 'updated image bytes');
    const changed = syncNewBrainFilesToWorkspace({ profileDir: profile, workspaceDir: workspace, snapshot });
    expect(changed).toHaveLength(1);
    expect(changed[0].workspaceRelPath).toMatch(/^generated\/miffy-[a-f0-9]{8}\.jpg$/);
    expect(fs.readFileSync(changed[0].workspaceAbsPath, 'utf8')).toBe('updated image bytes');
  });

  it('serves a file listed in generated through the screenshot link without requiring the brain source', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const { client: bob } = await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');
    const createChat = async () => (await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST', '/api/chats', { title: 'Generated file link' }
    )).data.chat;
    const chat = await createChat();
    const otherChat = await createChat();
    const filename = 'miffy_bunny_1794929588212.jpg';
    const generated = path.join(chat.workspaceDir, 'generated');
    const reference = `file:///workspace/generated//brain/d9343c9e-f0ac-4a7b-9735-3da9e0881e8f/${filename}`;
    fs.mkdirSync(generated, { recursive: true });
    fs.writeFileSync(path.join(generated, filename), 'existing image bytes');
    const workspace = await alice.request<{ files: Array<{ relPath: string }> }>('GET', `/api/chats/${chat.id}/workspace`);
    expect(workspace.data.files.map(f => f.relPath)).toContain(`generated/${filename}`);

    const resolve = (ref: string, chatId = chat.id) => alice.request<{
      artifact: { id: string; relPath: string }; previewUrl: string; downloadUrl: string;
    }>('POST', `/api/chats/${chatId}/resolve-link`, { reference: ref });
    const recovered = await resolve(reference);
    expect(recovered.status).toBe(200);
    expect(recovered.data.artifact.relPath).toBe(`generated/${filename}`);
    const canonical = await resolve(`generated/${filename}`);
    expect(canonical.data.artifact.id).toBe(recovered.data.artifact.id);
    expect((await resolve(recovered.data.artifact.id)).data.artifact.id).toBe(recovered.data.artifact.id);
    for (const url of [recovered.data.previewUrl, recovered.data.downloadUrl]) {
      const response = await fetch(`${srv.baseUrl}${url}`, { headers: { Cookie: alice.cookieHeader } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('existing image bytes');
    }
    expect((await resolve(reference, otherChat.id)).status).toBe(404);
    expect((await bob.request('POST', `/api/chats/${chat.id}/resolve-link`, { reference })).status).toBe(404);
    for (const invalid of [
      reference.replace(filename, 'missing.jpg'),
      'file:///etc/passwd',
      'file:///workspace/generated//brain/../secret.jpg',
      'file:///workspace/generated//brain/session/../../secret.jpg',
    ]) expect((await resolve(invalid)).status).toBe(404);

    // Never guess between the original name and a collision copy imported from another source.
    fs.writeFileSync(path.join(generated, 'miffy_bunny_1794929588212-1234abcd.jpg'), 'other image');
    expect((await resolve(reference)).status).toBe(404);
    expect((await resolve(`generated/${filename}`)).status).toBe(200);
    // If the referenced nested file really exists, its exact path wins over recovery.
    const nested = path.join(generated, 'brain', 'd9343c9e-f0ac-4a7b-9735-3da9e0881e8f', filename);
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, 'nested image');
    const exact = await resolve(reference);
    expect(exact.status).toBe(200);
    expect(exact.data.artifact.relPath).toBe(`generated/brain/d9343c9e-f0ac-4a7b-9735-3da9e0881e8f/${filename}`);
  });

  it('keeps every streamed Markdown reference resolvable and delta offsets contiguous', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();
    cleanups.push(() => alice.closeWs());
    const chat = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Stream links' })).data.chat;
    const turn = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chat.id}/messages`, { text: '[BRAIN_IMAGE]' });
    await alice.waitForFrame(f => f.kind === 'event' &&
      (f.event as { type: string; runId: string }).type === 'run.finished' &&
      (f.event as { runId: string }).runId === turn.data.run.id);
    const detail = await alice.request<{ messages: Array<{ role: string; contentText: string }> }>('GET', `/api/chats/${chat.id}`);
    const text = detail.data.messages.find(m => m.role === 'assistant')!.contentText;
    let streamed = '';
    for (const frame of alice.wsFrames) {
      const event = frame.event as { type: string; runId: string; payload: { field: string; chunk: string; offset: number } } | undefined;
      if (event?.type !== 'run.delta' || event.runId !== turn.data.run.id || event.payload.field !== 'content') continue;
      expect(event.payload.offset).toBe(streamed.length);
      streamed += event.payload.chunk;
    }
    expect(streamed).toBe(text);
    expect(text).not.toMatch(/\.gemini|generated\/\//);
    const references = [...text.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
    expect(references.length).toBeGreaterThanOrEqual(2);
    const original = srv.ctx.db.listArtifactsForChat(userId, chat.id).find(a => a.filename === 'mock-brain-art.jpg')!;
    expect(original.messageId).toBeTruthy();
    const workspaceDir = srv.ctx.db.getChat(userId, chat.id)!.workspaceDir;
    fs.appendFileSync(path.join(workspaceDir, original.relPath), 'updated bytes');
    for (const reference of [...references, original.id]) {
      const resolved = await alice.request('POST', `/api/chats/${chat.id}/resolve-link`, { reference });
      expect(resolved.status, reference).toBe(200);
    }
    const refreshed = srv.ctx.db.getArtifact(userId, original.id)!;
    expect(refreshed.sha256).not.toBe(original.sha256);
    expect(refreshed.messageId).toBe(original.messageId);
    expect(refreshed.runId).toBe(original.runId);
  });
});
