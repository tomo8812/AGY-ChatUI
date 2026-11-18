import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeClientLinkReference } from '../../web/src/utils/viewerCache';
import { afterEach, describe, expect, it } from 'vitest';
import { getChatBrainHostDir } from '../src/acp/env-isolation.js';
import { AppDatabase } from '../src/db/database.js';
import { normalizeLinkCandidatePath, resolveArtifactFile, resolveAuthorizedChatFileReference } from '../src/files/link-resolver.js';
import type { ArtifactRecord } from '../src/types.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('native and legacy file links', () => {
  it('preserves literal line-like filename suffixes in encoded file URIs', () => {
    for (const filename of ['report.pdf#L10', 'report.pdf:10']) {
      const source = `/home/sandbox/.gemini/brain/session/${filename}`;
      const uri = pathToFileURL(source).href;
      expect(normalizeLinkCandidatePath(uri)).toBe(source);
      expect(normalizeClientLinkReference(`${uri}#L42`)).toBe(source);
    }
  });

  it('resolves the current chat scratch and playground aliases and keeps their files isolated', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-links-'));
    const db = new AppDatabase(':memory:');
    cleanups.push(() => {
      db.close();
      fs.rmSync(temp, { recursive: true, force: true });
    });
    const profile = path.join(temp, 'profile');
    const userId = 'alice';
    db.createUser({ id: userId, username: 'alice', displayName: 'Alice', passwordHash: '', role: 'user', profileDir: profile });
    const createChat = (id: string) => {
      const workspaceDir = path.join(temp, 'workspaces', id);
      fs.mkdirSync(workspaceDir, { recursive: true });
      return db.createChat({
        id, userId, workspaceDir, title: id, projectId: null, projectContextVersion: 0, modelId: null, effortValue: null,
      });
    };
    const chat = createChat('chat');
    const other = createChat('other');
    const resolve = (chatId: string, reference: string) => resolveAuthorizedChatFileReference({ db, userId, chatId, reference });

    for (const kind of ['scratch', 'playground']) {
      const root = path.join(profile, `.chat-${kind}`, path.basename(chat.workspaceDir));
      const filename = '設計メモ #1.md';
      const file = path.join(root, filename);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(file, kind);
      const sandboxPath = `/home/sandbox/.gemini/antigravity/${kind}/`;
      const encoded = encodeURIComponent(filename);
      const first = resolve(chat.id, `file://${sandboxPath}${encoded}`)!.artifact;
      expect(first.relPath).toBe(`/home/sandbox/.gemini/${kind}/${filename}`);
      for (const reference of [file, `${sandboxPath}${encoded}`, `~/.gemini/jetski/${kind}/${filename}`]) {
        expect(resolve(chat.id, reference)?.artifact.id).toBe(first.id);
        expect(resolve(other.id, reference)).toBeNull();
      }
      const otherRoot = path.join(profile, `.chat-${kind}`, path.basename(other.workspaceDir));
      fs.symlinkSync(root, otherRoot);
      expect(resolve(other.id, `${sandboxPath}${encoded}`)).toBeNull();
      fs.symlinkSync(file, path.join(chat.workspaceDir, 'outside.md'));
      expect(resolve(chat.id, '/workspace/outside.md')).toBeNull();
      fs.unlinkSync(path.join(chat.workspaceDir, 'outside.md'));
      expect(resolveArtifactFile(db, chat, first)?.absPath).toBe(file);
    }
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

    const backup = path.join(generated, 'miffy_bunny_1794929588212-1234abcd.jpg');
    fs.copyFileSync(path.join(generated, filename), backup);
    const withIdenticalCopy = await resolve(reference);
    expect(withIdenticalCopy.status).toBe(200);
    expect(withIdenticalCopy.data.artifact.id).toBe(recovered.data.artifact.id);

    // A same-size copy with different bytes still makes the legacy name ambiguous.
    fs.writeFileSync(backup, 'different img bytes!');
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

  it('preserves uploaded filenames, MIME types and preview kinds when refreshing by ID or path', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const chat = (await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST', '/api/chats', { title: 'Attachment refresh' }
    )).data.chat;
    const form = new FormData();
    form.append('files', new Blob(['image bytes'], { type: 'image/png' }), 'illustration');
    const upload = await alice.request<{ attachments: Array<{ artifactId: string; relPath: string }> }>(
      'POST', `/api/chats/${chat.id}/attachments`, form
    );
    expect(upload.status).toBe(201);
    const attachment = upload.data.attachments[0];
    const original = srv.ctx.db.getArtifact(userId, attachment.artifactId)!;
    expect(original.filename).toBe('illustration');
    expect(original.mimeType).toBe('image/png');
    expect(original.previewKind).toBe('image');
    expect(original.relPath).toMatch(/^attachments\/\d+-illustration$/);
    for (const reference of [original.id, original.relPath]) {
      fs.appendFileSync(path.join(chat.workspaceDir, original.relPath), 'updated image bytes');
      const resolved = await alice.request<{ artifact: typeof original }>(
        'POST', `/api/chats/${chat.id}/resolve-link`, { reference }
      );
      expect(resolved.status).toBe(200);
      expect(resolved.data.artifact).toMatchObject({
        id: original.id, filename: original.filename, mimeType: original.mimeType,
        previewKind: original.previewKind, source: original.source,
      });
      expect(resolved.data.artifact.sha256).not.toBe(original.sha256);
    }
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
    const references = [...text.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
    expect(references).toHaveLength(2);
    expect(references[0]).toContain('/.gemini/antigravity-cli/brain/');
    expect(references[1]).toBe(`file://${references[0]}`);
    const resolve = (reference: string) => alice.request<{ artifact: ArtifactRecord; previewUrl: string }>(
      'POST', `/api/chats/${chat.id}/resolve-link`, { reference }
    );
    const first = await resolve(references[0]);
    expect(first.status).toBe(200);
    const original = first.data.artifact;
    expect((await resolve(references[1])).data.artifact.id).toBe(original.id);
    const workspaceDir = srv.ctx.db.getChat(userId, chat.id)!.workspaceDir;
    const profileDir = srv.ctx.db.getAgyProfile(userId)!.profileDir;
    const brainDir = getChatBrainHostDir(profileDir, workspaceDir);
    const nativePath = path.join(brainDir, original.relPath.split('/brain/')[1]);
    const before = fs.readFileSync(nativePath);
    const after = Buffer.concat([before, Buffer.from('updated bytes')]);
    fs.writeFileSync(nativePath, after);
    const content = await fetch(`${srv.baseUrl}${first.data.previewUrl}`, {
      headers: { Cookie: alice.cookieHeader },
    });
    expect(Buffer.from(await content.arrayBuffer())).toEqual(after);
    const refreshed = await resolve(original.id);
    expect(refreshed.data.artifact.sha256).not.toBe(original.sha256);
    expect(fs.existsSync(path.join(workspaceDir, 'generated'))).toBe(false);
  });
});
