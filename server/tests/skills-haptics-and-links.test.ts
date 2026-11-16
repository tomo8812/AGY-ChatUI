import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

function decryptAes128GcmPayload(params: {
  encryptedBody: Buffer;
  uaEcdh: crypto.ECDH;
  authSecret: Buffer;
}): string {
  const { encryptedBody, uaEcdh, authSecret } = params;
  const uaPublicKey = uaEcdh.getPublicKey();

  const salt = encryptedBody.subarray(0, 16);
  const idlen = encryptedBody[20];
  const asPublicKey = encryptedBody.subarray(21, 21 + idlen);
  const ciphertextAndTag = encryptedBody.subarray(21 + idlen);

  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const authTag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);

  const ecdhSecret = uaEcdh.computeSecret(asPublicKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\x00', 'ascii'), uaPublicKey, asPublicKey]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));

  const cek = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\x00', 'ascii'), 16)
  );
  const nonce = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\x00', 'ascii'), 12)
  );

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(authTag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return padded.subarray(0, padded.length - 1).toString('utf8');
}

describe('Brain Image Resolution, Haptics & Push Vibrate, Quota minAgeMs, and Agent Skills', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('imports and serves authorized profile brain images into workspace while blocking dotdirs, oauth files, and other users', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId: aliceId } = await registerAndBindAgy(
      srv.baseUrl,
      'alice',
      'user:alice@gmail.com'
    );
    const { client: bob, userId: bobId } = await registerAndBindAgy(
      srv.baseUrl,
      'bob',
      'user:bob@gmail.com'
    );
    await alice.connectWs({ clientId: 'alice-brain' });
    cleanups.push(() => alice.closeWs());

    const aliceProfile = srv.ctx.db.getAgyProfile(aliceId)!;
    const bobProfile = srv.ctx.db.getAgyProfile(bobId)!;

    // Seed authorized brain artifacts for Alice across multiple .gemini brain roots
    const cliBrainDir = path.join(aliceProfile.profileDir, '.gemini', 'antigravity-cli', 'brain', 'sess-1');
    const jetskiBrainDir = path.join(aliceProfile.profileDir, '.gemini', 'jetski', 'brain', 'sess-2');
    const dotBrainDir = path.join(aliceProfile.profileDir, '.gemini', 'antigravity-cli', 'brain', '.system_generated');
    fs.mkdirSync(cliBrainDir, { recursive: true });
    fs.mkdirSync(jetskiBrainDir, { recursive: true });
    fs.mkdirSync(dotBrainDir, { recursive: true });

    const sampleJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
    const samplePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
    const aliceBrainJpg = path.join(cliBrainDir, 'miffy_custom.jpg');
    const aliceBrainPng = path.join(jetskiBrainDir, 'diagram.png');
    const dotSecret = path.join(dotBrainDir, 'internal.txt');
    const oauthSecret = path.join(aliceProfile.profileDir, '.gemini', 'oauth_creds.json');

    fs.writeFileSync(aliceBrainJpg, sampleJpg);
    fs.writeFileSync(aliceBrainPng, samplePng);
    fs.writeFileSync(dotSecret, 'internal metadata');
    fs.writeFileSync(oauthSecret, '{"token":"secret"}');

    // Bob's brain image must NOT be resolvable by Alice
    const bobBrainDir = path.join(bobProfile.profileDir, '.gemini', 'antigravity-cli', 'brain', 'bob-sess');
    fs.mkdirSync(bobBrainDir, { recursive: true });
    const bobBrainJpg = path.join(bobBrainDir, 'bob_only.jpg');
    fs.writeFileSync(bobBrainJpg, sampleJpg);

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: '画像リンク解決テスト',
    });
    const chatId = chatRes.data.chat.id;

    // 1) Raw path inside .gemini/antigravity-cli/brain/ resolves and serves exact bytes
    const resRaw = await alice.request<{
      artifact: { id: string; relPath: string; filename: string; previewKind: string };
      previewUrl: string;
    }>('POST', `/api/chats/${chatId}/resolve-link`, {
      reference: aliceBrainJpg,
    });
    expect(resRaw.status).toBe(200);
    expect(resRaw.data.artifact.relPath).toBe('generated/miffy_custom.jpg');
    expect(resRaw.data.artifact.previewKind).toBe('image');

    const imgFetch = await fetch(`${srv.baseUrl}${resRaw.data.previewUrl}`, {
      headers: { Cookie: alice.cookieHeader },
    });
    expect(imgFetch.status).toBe(200);
    expect(Buffer.from(await imgFetch.arrayBuffer())).toEqual(sampleJpg);

    // 2) file:// URI with line fragment resolves cleanly across jetski brain root too
    const resUri = await alice.request<{
      artifact: { id: string; relPath: string };
    }>('POST', `/api/chats/${chatId}/resolve-link`, {
      reference: `file://${aliceBrainPng}#L1`,
    });
    expect(resUri.status).toBe(200);
    expect(resUri.data.artifact.relPath).toBe('generated/diagram.png');

    // 3) Dot-directories (.system_generated), credential files, and other users' brain files are strictly blocked
    expect(
      (await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: dotSecret })).status
    ).toBe(404);
    expect(
      (await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: oauthSecret })).status
    ).toBe(404);
    expect(
      (await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: `file://${bobBrainJpg}` })).status
    ).toBe(404);

    // 4) Real ACP turn with [BRAIN_IMAGE] auto-imports generated brain image as artifact.created
    const turnRes = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: 'イラスト描いて [BRAIN_IMAGE]',
    });
    expect(turnRes.status).toBe(202);

    const artEvent = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { artifact?: { filename?: string } } }).type === 'artifact.created' &&
        (f.event as { payload?: { artifact?: { filename?: string } } }).payload?.artifact?.filename ===
          'mock-brain-art.jpg'
    );
    const createdArt = (
      artEvent.event as { payload: { artifact: { id: string; relPath: string; previewKind: string } } }
    ).payload.artifact;
    expect(createdArt.relPath).toBe('generated/mock-brain-art.jpg');
    expect(createdArt.previewKind).toBe('image');

    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === turnRes.data.run.id
    );

    const chatDetail = await alice.request<{
      artifacts: Array<{ id: string; relPath: string }>;
      messages: Array<{ role: string; contentText: string; artifactIds: string[] }>;
    }>('GET', `/api/chats/${chatId}`);
    expect(chatDetail.data.artifacts.some((a) => a.id === createdArt.id)).toBe(true);
    const assistantMsg = chatDetail.data.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.artifactIds).toContain(createdArt.id);

    // Resolving the same file:// brain path mentioned in the message reuses the imported artifact ID cleanly
    const match = /file:\/\/([^\s)]+\.jpg)/.exec(assistantMsg?.contentText ?? '');
    expect(match).not.toBeNull();
    const resolvedSame = await alice.request<{ artifact: { id: string; relPath: string } }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: `file://${match![1]}` }
    );
    expect(resolvedSame.status).toBe(200);
    expect(resolvedSame.data.artifact.id).toBe(createdArt.id);

    // Confirm Bob gets 404 trying to access Alice's artifact content
    const bobReadAliceFile = await bob.request('GET', `/api/files/${createdArt.id}/content`);
    expect(bobReadAliceFile.status).toBe(404);
  });

  it('migrates haptic_feedback column safely, persists preferences, and includes vibrate patterns in Web Push payloads when enabled', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-haptic-migrate-'));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const dbPath = path.join(tmpDir, 'legacy.db');

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        theme TEXT NOT NULL DEFAULT 'system',
        auto_approve_safe_reads INTEGER NOT NULL DEFAULT 0,
        default_model_id TEXT,
        default_effort_value TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('u1', 'olduser', 'Old', 'hash', 'admin', 1000, 1000);
      INSERT INTO user_preferences VALUES ('u1', 'light', 0, NULL, NULL, 1000);
    `);
    legacy.close();

    const migrated = new AppDatabase(dbPath);
    const initialPrefs = migrated.getPreferences('u1');
    expect(initialPrefs.notifyOnResponse).toBe(false);
    expect(initialPrefs.hapticFeedback).toBe(true);
    const turnedOff = migrated.updatePreferences('u1', { hapticFeedback: false });
    expect(turnedOff.hapticFeedback).toBe(false);
    migrated.close();

    // End-to-end encrypted Push vibrate payload test
    const receivedPayloads: Array<Record<string, unknown>> = [];
    const uaEcdh = crypto.createECDH('prime256v1');
    const uaPub = uaEcdh.generateKeys();
    const authSecret = crypto.randomBytes(16);

    const mockPushServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const decrypted = decryptAes128GcmPayload({
          encryptedBody: Buffer.concat(chunks),
          uaEcdh,
          authSecret,
        });
        receivedPayloads.push(JSON.parse(decrypted) as Record<string, unknown>);
        res.statusCode = 201;
        res.end('Created');
      });
    });

    await new Promise<void>((resolve) => mockPushServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockPushServer.address() as { port: number };
    const endpoint = `http://127.0.0.1:${addr.port}/push/haptic`;
    cleanups.push(() => new Promise<void>((resolve) => mockPushServer.close(() => resolve())));

    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs({ clientId: 'alice-haptic' });
    cleanups.push(() => alice.closeWs());

    await alice.request('POST', '/api/notifications/subscribe', {
      endpoint,
      keys: {
        p256dh: uaPub.toString('base64url'),
        auth: authSecret.toString('base64url'),
      },
    });
    const prefOn = await alice.request<{ preferences: { notifyOnResponse: boolean; hapticFeedback: boolean } }>(
      'PATCH',
      '/api/preferences',
      { notifyOnResponse: true, hapticFeedback: true }
    );
    expect(prefOn.status).toBe(200);
    expect(prefOn.data.preferences.hapticFeedback).toBe(true);

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: '触覚Push' });
    const chatId = chatRes.data.chat.id;

    // 1) With hapticFeedback = true, completed push carries vibrate array
    const send1 = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: 'PushバイブON確認',
    });
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === send1.data.run.id
    );

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (receivedPayloads.length >= 1) return resolve();
        if (Date.now() - start > 3000) return reject(new Error('Push wait timeout #1'));
        setTimeout(poll, 20);
      };
      poll();
    });
    expect(receivedPayloads[0].vibrate).toEqual([14, 55, 16, 55, 42]);

    // 2) Error notification when hapticFeedback = true carries distinct vibrate pattern
    await srv.ctx.pushService.notifyRunFinished({
      userId,
      chatId,
      runId: 'err-run-1',
      status: 'error',
      errorMessage: 'simulated failure',
    });
    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[1].vibrate).toEqual([65, 65, 65, 65, 65]);

    // 3) Turn off hapticFeedback -> next notification omits vibrate property
    const prefOff = await alice.request<{ preferences: { hapticFeedback: boolean } }>(
      'PATCH',
      '/api/preferences',
      { hapticFeedback: false }
    );
    expect(prefOff.data.preferences.hapticFeedback).toBe(false);

    const send2 = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: 'PushバイブOFF確認',
    });
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === send2.data.run.id
    );
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (receivedPayloads.length >= 3) return resolve();
        if (Date.now() - start > 3000) return reject(new Error('Push wait timeout #3'));
        setTimeout(poll, 20);
      };
      poll();
    });
    expect(receivedPayloads[2].vibrate).toBeUndefined();
  });

  it('honors minAgeMs parameter on auto quota refresh and refreshes automatically on run completion', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(
      srv.baseUrl,
      'alice',
      'user:alice@gmail.com'
    );
    await alice.connectWs({ clientId: 'alice-quota' });
    cleanups.push(() => alice.closeWs());

    const initial = await alice.request<{ quota: { status: string; fetchedAt: number } }>(
      'POST',
      '/api/quota/refresh',
      { auto: true }
    );
    expect(initial.status).toBe(200);
    expect(initial.data.quota.status).toBe('ok');
    const t0 = initial.data.quota.fetchedAt;

    // Within 5s window -> custom minAgeMs: 5000 returns cached snapshot
    const within5s = await alice.request<{ quota: { fetchedAt: number } }>('POST', '/api/quota/refresh', {
      auto: true,
      minAgeMs: 5000,
    });
    expect(within5s.data.quota.fetchedAt).toBe(t0);

    // Age snapshot by 12s (> 5s custom minAgeMs, < 5m default cooldown)
    const snap = srv.ctx.db.getQuotaSnapshot(userId)!;
    const agedTs = Date.now() - 12_000;
    srv.ctx.db.saveQuotaSnapshot({ ...snap, fetchedAt: agedTs });

    // Default auto cooldown (5m) keeps 12s-old snapshot cached
    const defaultAuto = await alice.request<{ quota: { fetchedAt: number } }>('POST', '/api/quota/refresh', {
      auto: true,
    });
    expect(defaultAuto.data.quota.fetchedAt).toBe(agedTs);

    // Custom minAgeMs: 5000 bypasses cache and fetches fresh snapshot
    const freshAuto = await alice.request<{ quota: { fetchedAt: number } }>('POST', '/api/quota/refresh', {
      auto: true,
      minAgeMs: 5000,
    });
    expect(freshAuto.data.quota.fetchedAt).toBeGreaterThan(agedTs);

    // Backdate by 8s and finish a chat turn -> scheduler automatically refreshes quota cleanly
    const backdated = Date.now() - 8_000;
    srv.ctx.db.saveQuotaSnapshot({ ...freshAuto.data.quota, userId, fetchedAt: backdated } as never);
    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'クォーター連動' });
    const nextQuotaPromise = alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { quota?: { fetchedAt: number } } }).type === 'quota.updated' &&
        ((f.event as { payload?: { quota?: { fetchedAt: number } } }).payload?.quota?.fetchedAt ?? 0) > backdated,
      8000,
      false
    );
    await alice.request('POST', `/api/chats/${chatRes.data.chat.id}/messages`, { text: '応答後クォーター更新' });

    await nextQuotaPromise;
    const latestQuota = await alice.request<{ quota: { fetchedAt: number } }>('GET', '/api/quota');
    expect(latestQuota.data.quota.fetchedAt).toBeGreaterThan(backdated);
  });

  it('manages global/project/workspace Agent Skills, legacy skills, resources, workspace hiding, and ACP slash command execution', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(
      srv.baseUrl,
      'alice',
      'user:alice@gmail.com'
    );
    await alice.connectWs({ clientId: 'alice-skills' });
    cleanups.push(() => alice.closeWs());

    const aliceProfile = srv.ctx.db.getAgyProfile(userId)!;

    // Seed a legacy global skill under ~/.gemini/skills/legacy-helper
    const legacyDir = path.join(aliceProfile.profileDir, '.gemini', 'skills', 'legacy-helper');
    fs.mkdirSync(path.join(legacyDir, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'SKILL.md'),
      '---\nname: "Legacy Helper"\ndescription: "Legacy skill description"\n---\n\nAlways check legacy docs.\n',
      'utf8'
    );
    fs.writeFileSync(path.join(legacyDir, 'references', 'guide.md'), '# Legacy Guide\n', 'utf8');

    const list1 = await alice.request<{
      global: Array<{ slug: string; storageKind: string; enabled: boolean; resourceCount: number }>;
      commands: Array<{ name: string }>;
      templates: Array<{ slug: string }>;
    }>('GET', '/api/skills');
    expect(list1.status).toBe(200);
    expect(list1.data.templates.length).toBeGreaterThanOrEqual(4);
    const legacySummary = list1.data.global.find((s) => s.slug === 'legacy-helper');
    expect(legacySummary).toMatchObject({
      slug: 'legacy-helper',
      storageKind: 'legacy',
      enabled: true,
      resourceCount: 1,
    });
    expect(list1.data.commands.some((c) => c.name === 'legacy-helper')).toBe(true);

    // Toggling off moves legacy skill to config/skills-disabled and removes it from slash commands
    const disabledLegacy = await alice.request<{ skill: { enabled: boolean; storageKind: string } }>(
      'PUT',
      '/api/skills/global/legacy-helper',
      { enabled: false }
    );
    expect(disabledLegacy.status).toBe(200);
    expect(disabledLegacy.data.skill.enabled).toBe(false);
    expect(
      fs.existsSync(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills-disabled', 'legacy-helper', 'SKILL.md'))
    ).toBe(true);

    const afterDisableList = await alice.request<{ commands: Array<{ name: string }> }>('GET', '/api/skills');
    expect(afterDisableList.data.commands.some((c) => c.name === 'legacy-helper')).toBe(false);

    // Re-enabling promotes it to canonical config/skills/ and keeps references/guide.md
    const reenabled = await alice.request<{
      skill: { enabled: boolean; storageKind: string; resources: Array<{ relPath: string }> };
    }>('PUT', '/api/skills/global/legacy-helper', { enabled: true });
    expect(reenabled.status).toBe(200);
    expect(reenabled.data.skill.enabled).toBe(true);
    expect(reenabled.data.skill.storageKind).toBe('canonical');
    expect(reenabled.data.skill.resources.some((r) => r.relPath === 'references/guide.md')).toBe(true);

    // Create global skill + validate bad slug & resource upload/traversal guards
    const badSlug = await alice.request('POST', '/api/skills', {
      scope: 'global',
      slug: 'Invalid Slug!',
      description: 'desc',
    });
    expect(badSlug.status).toBe(400);

    const createdGlobal = await alice.request<{
      skill: { slug: string; disableModelInvocation: boolean; enabled: boolean };
    }>('POST', '/api/skills', {
      scope: 'global',
      slug: 'global-lint',
      name: 'Global Lint',
      description: 'コードスタイルを検証するときに使う',
      instructions: 'STEP_GLOBAL_LINT',
      disableModelInvocation: true,
    });
    expect(createdGlobal.status).toBe(201);
    expect(createdGlobal.data.skill.disableModelInvocation).toBe(true);

    // Add text script & multipart file, check traversal blocked & SKILL.md delete blocked
    const scriptAdd = await alice.request<{ skill: { resources: Array<{ relPath: string }> } }>(
      'POST',
      '/api/skills/global/global-lint/files',
      { relPath: 'scripts/check.sh', content: '#!/bin/sh\necho ok\n' }
    );
    expect(scriptAdd.status).toBe(201);
    expect(scriptAdd.data.skill.resources.some((r) => r.relPath === 'scripts/check.sh')).toBe(true);

    const traversal = await alice.request('POST', '/api/skills/global/global-lint/files', {
      relPath: '../../etc/passwd',
      content: 'nope',
    });
    expect(traversal.status).toBe(403);

    const fd = new FormData();
    fd.append('files', new Blob(['# Checklist\n- item 1\n'], { type: 'text/markdown' }), 'checklist.md');
    const multipartRes = await alice.request<{ skill: { resources: Array<{ relPath: string }> } }>(
      'POST',
      '/api/skills/global/global-lint/files?folder=references',
      fd
    );
    expect(multipartRes.status).toBe(201);
    expect(multipartRes.data.skill.resources.some((r) => r.relPath === 'references/checklist.md')).toBe(true);

    const readScript = await alice.request<{ relPath: string; content: string }>(
      'GET',
      '/api/skills/global/global-lint/files?path=scripts/check.sh'
    );
    expect(readScript.status).toBe(200);
    expect(readScript.data.content).toContain('echo ok');

    const delSkillMd = await alice.request(
      'DELETE',
      '/api/skills/global/global-lint/files?path=SKILL.md'
    );
    expect(delSkillMd.status).toBe(400);

    // Project skill + Workspace skill + ACP integration
    const projRes = await alice.request<{ project: { id: string } }>('POST', '/api/projects', {
      name: 'Skill Project',
    });
    const projectId = projRes.data.project.id;

    const projSkill = await alice.request('POST', '/api/skills', {
      scope: 'project',
      projectId,
      slug: 'proj-deploy',
      name: 'Project Deploy',
      description: 'プロジェクトの手順に従って安全なデプロイ確認を行う',
      instructions: 'VERIFY_PROJECT_DEPLOY',
    });
    expect(projSkill.status).toBe(201);

    const chatRes = await alice.request<{
      chat: { id: string; workspaceDir: string };
      sessionOptions: { availableCommands?: Array<{ name: string }> };
    }>('POST', '/api/chats', {
      title: 'スキル実行チャット',
      projectId,
    });
    expect(chatRes.status).toBe(201);
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    // Project skill must be synced to chat workspace .agents/skills/proj-deploy with marker
    expect(fs.existsSync(path.join(workspaceDir, '.agents', 'skills', 'proj-deploy', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, '.agents', 'skills', 'proj-deploy', '.agy-project-skill'))).toBe(true);

    // Add a workspace-only skill after chat creation
    const wsSkill = await alice.request('POST', '/api/skills', {
      scope: 'workspace',
      chatId,
      slug: 'ws-custom',
      name: 'Workspace Custom',
      description: 'このチャット専用のカスタム集計手順',
      instructions: 'APPLY_WORKSPACE_CUSTOM_SKILL',
    });
    expect(wsSkill.status).toBe(201);

    // Listing skills with chatId separates workspace skill from synced project skill!
    const scopedList = await alice.request<{
      project: Array<{ slug: string }>;
      workspace: Array<{ slug: string }>;
      commands: Array<{ name: string; scope?: string }>;
    }>('GET', `/api/skills?projectId=${encodeURIComponent(projectId)}&chatId=${encodeURIComponent(chatId)}`);
    expect(scopedList.data.project.map((s) => s.slug)).toEqual(['proj-deploy']);
    expect(scopedList.data.workspace.map((s) => s.slug)).toEqual(['ws-custom']);

    // .agents/ internal directory must stay hidden from workspace file explorer!
    const wsFiles = await alice.request<{ files: Array<{ relPath: string }> }>(
      'GET',
      `/api/chats/${chatId}/workspace`
    );
    expect(wsFiles.data.files.some((f) => f.relPath.startsWith('.agents') || f.relPath.startsWith('.agent'))).toBe(false);

    // Opening chat exposes merged ACP + Skill availableCommands
    const chatDetail = await alice.request<{
      sessionOptions: { availableCommands?: Array<{ name: string }> };
    }>('GET', `/api/chats/${chatId}`);
    const cmdNames = (chatDetail.data.sessionOptions.availableCommands ?? []).map((c) => c.name);
    expect(cmdNames).toContain('compact');
    expect(cmdNames).toContain('global-lint');
    expect(cmdNames).toContain('proj-deploy');
    expect(cmdNames).toContain('ws-custom');

    // Execute slash command /ws-custom -> ACP mock activates matching skill
    const sendWs = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: '/ws-custom レポート作成して',
    });
    expect(sendWs.status).toBe(202);
    const doneWs = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === sendWs.data.run.id
    );
    const wsReply = ((doneWs.event as { payload: { message: { contentText: string } } }).payload.message).contentText;
    expect(wsReply).toContain('`/ws-custom` (workspace)');
    expect(wsReply).toContain('APPLY_WORKSPACE_CUSTOM_SKILL');

    // Disabling project skill removes synced copy from workspace without touching ws-custom
    await alice.request('PUT', `/api/skills/project/proj-deploy?projectId=${encodeURIComponent(projectId)}`, {
      enabled: false,
    });
    expect(fs.existsSync(path.join(workspaceDir, '.agents', 'skills', 'proj-deploy'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, '.agents', 'skills', 'ws-custom', 'SKILL.md'))).toBe(true);

    // Deleting global skill cleans it up cleanly
    const delGlobal = await alice.request('DELETE', '/api/skills/global/global-lint');
    expect(delGlobal.status).toBe(200);
    const afterDel = await alice.request<{ global: Array<{ slug: string }> }>('GET', '/api/skills');
    expect(afterDel.data.global.some((s) => s.slug === 'global-lint')).toBe(false);
  });
});
