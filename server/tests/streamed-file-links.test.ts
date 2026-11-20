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
      const filename = '.exports/設計メモ #1.md';
      const file = path.join(root, filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, kind);
      const sandboxPath = `/home/sandbox/.gemini/antigravity/${kind}/`;
      const encoded = filename.split('/').map(encodeURIComponent).join('/');
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

    const large = Buffer.concat([before, Buffer.alloc(512 * 1024)]);
    const mtime = new Date('2025-01-01T00:00:00Z');
    fs.writeFileSync(nativePath, large);
    fs.utimesSync(nativePath, mtime, mtime);
    const beforeOverwrite = await resolve(original.id);
    large[large.length - 1] = 1;
    fs.writeFileSync(nativePath, large);
    fs.utimesSync(nativePath, mtime, mtime);
    const afterOverwrite = await resolve(original.id);
    expect(afterOverwrite.data.previewUrl).not.toBe(beforeOverwrite.data.previewUrl);
    const latest = await fetch(`${srv.baseUrl}${afterOverwrite.data.previewUrl}`, {
      headers: { Cookie: alice.cookieHeader },
    });
    expect(Buffer.from(await latest.arrayBuffer())).toEqual(large);
    expect(fs.existsSync(path.join(workspaceDir, 'generated'))).toBe(false);
  });

  it('resolves non-sensitive user profile files while blocking secrets, other chats, and other profiles', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const { client: alice, userId: aliceId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const { client: bob, userId: bobId } = await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');

    const aliceChat = (await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST', '/api/chats', { title: 'Alice skills' }
    )).data.chat;
    const aliceOtherChat = (await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST', '/api/chats', { title: 'Alice other' }
    )).data.chat;
    const bobChat = (await bob.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST', '/api/chats', { title: 'Bob chat' }
    )).data.chat;

    const aliceProfile = srv.ctx.db.getAgyProfile(aliceId)!.profileDir;
    const bobProfile = srv.ctx.db.getAgyProfile(bobId)!.profileDir;

    // 1. Non-sensitive user profile files (skills, docs with "tokens"/"auth" in filename, global instructions, user notes)
    const skillFile = path.join(aliceProfile, '.gemini', 'config', 'skills', 'algorithmic-art', 'SKILL.md');
    const designTokensDoc = path.join(aliceProfile, '.gemini', 'config', 'skills', 'theme-factory', 'references', 'design-tokens.md');
    const authGuideDoc = path.join(aliceProfile, 'notes', 'auth-guide.md');
    const globalInstructions = path.join(aliceProfile, '.gemini', 'GEMINI.md');
    const userNote = path.join(aliceProfile, 'notes', 'memo.md');
    for (const [filePath, body] of [
      [skillFile, '# Algorithmic Art Skill'],
      [designTokensDoc, '# Design Tokens'],
      [authGuideDoc, '# Auth Architecture Guide'],
      [globalInstructions, '# Global Instructions'],
      [userNote, '# Personal Note'],
    ]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body);
    }

    const resolveAlice = (reference: string, chatId = aliceChat.id) => alice.request<{
      artifact: ArtifactRecord; previewUrl: string; downloadUrl: string;
    }>('POST', `/api/chats/${chatId}/resolve-link`, { reference });

    const fromFileUri = await resolveAlice('file:///home/sandbox/.gemini/config/skills/algorithmic-art/SKILL.md');
    expect(fromFileUri.status).toBe(200);
    expect(fromFileUri.data.artifact.relPath).toBe('/home/sandbox/.gemini/config/skills/algorithmic-art/SKILL.md');
    const contentRes = await fetch(`${srv.baseUrl}${fromFileUri.data.previewUrl}`, {
      headers: { Cookie: alice.cookieHeader },
    });
    expect(contentRes.status).toBe(200);
    expect(await contentRes.text()).toBe('# Algorithmic Art Skill');

    // Equivalent home-relative forms resolve to the same canonical artifact
    for (const ref of [
      '~/.gemini/config/skills/algorithmic-art/SKILL.md',
      '/home/sandbox/.gemini/config/skills/algorithmic-art/SKILL.md',
      skillFile,
    ]) {
      const res = await resolveAlice(ref);
      expect(res.status).toBe(200);
      expect(res.data.artifact.id).toBe(fromFileUri.data.artifact.id);
    }

    // Other non-sensitive profile files (including docs with "tokens"/"auth" in filename) also resolve
    for (const ref of [
      'file:///home/sandbox/.gemini/config/skills/theme-factory/references/design-tokens.md',
      'file:///home/sandbox/notes/auth-guide.md',
      'file:///home/sandbox/.gemini/GEMINI.md',
      'file:///home/sandbox/notes/memo.md',
    ]) {
      expect((await resolveAlice(ref)).status).toBe(200);
    }

    // 2. Cross-profile isolation: Bob cannot see Alice's skill file
    const bobSkill = path.join(bobProfile, '.gemini', 'config', 'skills', 'bob-only', 'SKILL.md');
    fs.mkdirSync(path.dirname(bobSkill), { recursive: true });
    fs.writeFileSync(bobSkill, '# Bob Only');
    expect((await bob.request('POST', `/api/chats/${bobChat.id}/resolve-link`, {
      reference: `file://${skillFile}`,
    })).status).toBe(404);
    expect((await resolveAlice(`file://${bobSkill}`)).status).toBe(404);

    // 3. Per-chat isolation: Alice's chat cannot read another chat's isolated dirs or host .gemini/brain
    const otherBrain = path.join(getChatBrainHostDir(aliceProfile, aliceOtherChat.workspaceDir), 'session', 'secret.md');
    const hostBrain = path.join(aliceProfile, '.gemini', 'brain', 'session', 'host.md');
    const otherChatHomeFile = path.join(
      aliceProfile, '.chat-homes', path.basename(aliceOtherChat.workspaceDir), 'private.md'
    );
    for (const [filePath, body] of [
      [otherBrain, 'other chat brain'],
      [hostBrain, 'host brain'],
      [otherChatHomeFile, 'other chat home'],
    ]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body);
    }
    for (const ref of [
      `file://${otherBrain}`,
      `file://${hostBrain}`,
      'file:///home/sandbox/.gemini/brain/session/host.md',
      `file://${otherChatHomeFile}`,
      `file:///home/sandbox/.chat-homes/${path.basename(aliceOtherChat.workspaceDir)}/private.md`,
    ]) {
      expect((await resolveAlice(ref)).status).toBe(404);
    }

    // 4. Dotfiles, .gemini credentials/internals, and raw key/env files must never be exposed
    const secretPaths = [
      '.mock-agy-auth.json',
      '.env',
      '.env.local',
      '.envrc',
      '.AWS/credentials',
      'notes/.aws/credentials',
      '.ssh/id_rsa',
      '.config/gcloud/credentials.db',
      '.local/share/keyrings/default.keyring',
      '.gemini/oauth_creds.json',
      '.gemini/google_accounts.json',
      '.gemini/antigravity-cli/settings.json',
      '.gemini/antigravity/mcp_config.json',
      '.gemini/antigravity/user_settings.pb',
      '.gemini/antigravity/code_tracker/trace.txt',
      '.gemini/config/skills/theme-factory/.env',
      'notes/private.pem',
      'notes/server.key',
      'notes/key.ppk',
      'notes/id_rsa',
      'notes/production.env',
      'notes/app.env.local',
    ];
    for (const rel of secretPaths) {
      const full = path.join(aliceProfile, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'top-secret');
      expect((await resolveAlice(`file:///home/sandbox/${rel}`)).status).toBe(404);
      expect((await resolveAlice(`~/${rel}`)).status).toBe(404);
    }

    // 5. Symlink escapes (to secrets or to another user's profile) are blocked after realpath resolution
    const symlinkToSecret = path.join(aliceProfile, 'notes', 'harmless-alias.md');
    fs.symlinkSync(path.join(aliceProfile, '.gemini', 'oauth_creds.json'), symlinkToSecret);
    expect((await resolveAlice('file:///home/sandbox/notes/harmless-alias.md')).status).toBe(404);

    const symlinkToBob = path.join(aliceProfile, 'notes', 'bob-alias.md');
    fs.symlinkSync(bobSkill, symlinkToBob);
    expect((await resolveAlice('file:///home/sandbox/notes/bob-alias.md')).status).toBe(404);

    // 6. Per-chat home prefix resolves files from this chat's chatHome (and its symlinks into shared profile)
    const aliceChatHome = path.join(aliceProfile, '.chat-homes', path.basename(aliceChat.workspaceDir));
    const chatOnlyFile = path.join(aliceChatHome, 'notes', 'chat-only.md');
    const shadowedMemo = path.join(aliceChatHome, 'notes', 'memo.md');
    fs.mkdirSync(path.dirname(chatOnlyFile), { recursive: true });
    fs.writeFileSync(chatOnlyFile, '# Chat Home Only');
    fs.writeFileSync(shadowedMemo, '# Chat Home Shadowed Memo');
    const chatHomeGeminiConfig = path.join(aliceChatHome, '.gemini', 'config');
    if (!fs.existsSync(chatHomeGeminiConfig)) {
      fs.mkdirSync(path.dirname(chatHomeGeminiConfig), { recursive: true });
      fs.symlinkSync(path.join(aliceProfile, '.gemini', 'config'), chatHomeGeminiConfig);
    }

    const chatOnlyRes = await resolveAlice(`file://${chatOnlyFile}`);
    expect(chatOnlyRes.status).toBe(200);
    const chatOnlyBody = await fetch(`${srv.baseUrl}${chatOnlyRes.data.previewUrl}`, {
      headers: { Cookie: alice.cookieHeader },
    });
    expect(chatOnlyBody.status).toBe(200);
    expect(await chatOnlyBody.text()).toBe('# Chat Home Only');
    expect((await resolveAlice('file:///home/sandbox/notes/chat-only.md', aliceOtherChat.id)).status).toBe(404);

    const homeMemoRes = await resolveAlice(`file://${userNote}`);
    expect(homeMemoRes.status).toBe(200);
    const shadowedRes = await resolveAlice(`file://${shadowedMemo}`);
    expect(shadowedRes.status).toBe(200);
    expect(shadowedRes.data.artifact.id).not.toBe(homeMemoRes.data.artifact.id);
    const homeMemoBody = await fetch(`${srv.baseUrl}${homeMemoRes.data.previewUrl}`, {
      headers: { Cookie: alice.cookieHeader },
    });
    expect(await homeMemoBody.text()).toBe('# Personal Note');
    const shadowedBody = await fetch(`${srv.baseUrl}${shadowedRes.data.previewUrl}`, {
      headers: { Cookie: alice.cookieHeader },
    });
    expect(await shadowedBody.text()).toBe('# Chat Home Shadowed Memo');
    const tildeShadowedRes = await resolveAlice('~/notes/memo.md');
    expect(tildeShadowedRes.status).toBe(200);
    expect(tildeShadowedRes.data.artifact.id).toBe(shadowedRes.data.artifact.id);

    const homeOnlyFile = path.join(aliceProfile, 'notes', 'home-only.md');
    fs.writeFileSync(homeOnlyFile, '# Home Only');
    expect((await resolveAlice(`file://${path.join(aliceChatHome, 'notes', 'home-only.md')}`)).status).toBe(404);

    const viaChatHomeSkill = await resolveAlice(
      `file://${path.join(aliceChatHome, '.gemini', 'config', 'skills', 'algorithmic-art', 'SKILL.md')}`
    );
    expect(viaChatHomeSkill.status).toBe(200);
    expect(viaChatHomeSkill.data.artifact.id).toBe(fromFileUri.data.artifact.id);
  });
});
