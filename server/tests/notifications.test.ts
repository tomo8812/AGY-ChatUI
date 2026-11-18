import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/db/database.js';
import {
  createVapidJwt,
  decodeBase64Url,
  encryptWebPushPayload,
  loadOrCreateVapidKeys,
  PushNotificationService,
} from '../src/notifications/web-push.js';
import { createTestServer, registerAndBindAgy, TestApiClient } from './helpers/test-harness.js';

function decryptAes128GcmPayload(params: {
  encryptedBody: Buffer;
  uaEcdh: crypto.ECDH;
  authSecret: Buffer;
}): string {
  const { encryptedBody, uaEcdh, authSecret } = params;
  const uaPublicKey = uaEcdh.getPublicKey();

  const salt = encryptedBody.subarray(0, 16);
  const rs = encryptedBody.readUInt32BE(16);
  expect(rs).toBeGreaterThanOrEqual(18);
  const idlen = encryptedBody[20];
  expect(idlen).toBe(65);
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
  expect(padded[padded.length - 1]).toBe(0x02);
  return padded.subarray(0, padded.length - 1).toString('utf8');
}

describe('Notifications & Pure-Node Web Push (RFC 8291 / 8292)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it('encrypts payloads with valid RFC 8291 aes128gcm framing and signs valid RFC 8292 ES256 VAPID JWT', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-push-crypto-'));
    cleanups.push(async () => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const db = new AppDatabase(path.join(tmpDir, 'test.db'));
    const { privateKey, publicKeyBase64Url } = loadOrCreateVapidKeys(db);

    // Reloading from SQLite must reuse the same persisted VAPID keys
    const reloaded = loadOrCreateVapidKeys(db);
    expect(reloaded.publicKeyBase64Url).toBe(publicKeyBase64Url);

    const jwt = createVapidJwt({
      audience: 'https://push.example.com',
      subject: 'mailto:test@antigravity.local',
      privateKey,
    });

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(decodeBase64Url(parts[0]).toString('utf8')) as { typ: string; alg: string };
    const claims = JSON.parse(decodeBase64Url(parts[1]).toString('utf8')) as {
      aud: string;
      sub: string;
      exp: number;
    };
    expect(header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(claims.aud).toBe('https://push.example.com');
    expect(claims.sub).toBe('mailto:test@antigravity.local');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Convert raw 65-byte uncompressed VAPID public key to SPKI/KeyObject and verify P-1363 signature
    const rawPub = decodeBase64Url(publicKeyBase64Url);
    expect(rawPub).toHaveLength(65);
    expect(rawPub[0]).toBe(0x04);
    const pubKeyObj = crypto.createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: rawPub.subarray(1, 33).toString('base64url'),
        y: rawPub.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    const verified = crypto.verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      { key: pubKeyObj, dsaEncoding: 'ieee-p1363' },
      decodeBase64Url(parts[2])
    );
    expect(verified).toBe(true);

    // Verify RFC 8291 encryption & decryption with Japanese multi-byte text
    const uaEcdh = crypto.createECDH('prime256v1');
    const uaPub = uaEcdh.generateKeys();
    const authSecret = crypto.randomBytes(16);

    const originalJson = JSON.stringify({
      title: 'テストチャット',
      body: '応答が完了しました。日本語のテキストも正しく暗号化・復号されます。',
      tag: 'run-123',
      chatId: 'chat-abc',
    });

    const encrypted = encryptWebPushPayload({
      payload: originalJson,
      p256dh: uaPub.toString('base64url'),
      auth: authSecret.toString('base64url'),
    });

    const decrypted = decryptAes128GcmPayload({
      encryptedBody: encrypted.body,
      uaEcdh,
      authSecret,
    });
    expect(decrypted).toBe(originalJson);
    db.close();
  });

  it('safely migrates legacy user_preferences table lacking notify_on_response', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-db-migrate-'));
    cleanups.push(async () => fs.rmSync(tmpDir, { recursive: true, force: true }));
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
      CREATE TABLE agy_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile_dir TEXT NOT NULL UNIQUE,
        auth_status TEXT NOT NULL DEFAULT 'unauthenticated',
        auth_method TEXT,
        account_label TEXT,
        encrypted_api_key TEXT,
        last_verified_at INTEGER,
        last_error TEXT,
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
      INSERT INTO users VALUES ('u1', 'legacyuser', 'Legacy', 'hash', 'admin', 1000, 1000);
      INSERT INTO user_preferences VALUES ('u1', 'dark', 1, NULL, NULL, 1000);
    `);
    legacy.close();

    const migrated = new AppDatabase(dbPath);
    const prefs = migrated.getPreferences('u1');
    expect(prefs.theme).toBe('dark');
    expect(prefs.notifyOnResponse).toBe(false);

    const updated = migrated.updatePreferences('u1', { notifyOnResponse: true });
    expect(updated.notifyOnResponse).toBe(true);
    expect(updated.theme).toBe('dark');
    migrated.close();
  });

  it('dispatches Web Push notifications on finished runs only when notifyOnResponse=true, skips cancelled runs, and prunes 410 subscriptions', async () => {
    const receivedRequests: Array<{
      headers: http.IncomingHttpHeaders;
      decrypted: Record<string, unknown>;
    }> = [];
    let mockStatusCode = 201;

    const uaEcdh = crypto.createECDH('prime256v1');
    const uaPub = uaEcdh.generateKeys();
    const authSecret = crypto.randomBytes(16);

    const mockPushServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (mockStatusCode === 201) {
          const rawBody = Buffer.concat(chunks);
          const jsonText = decryptAes128GcmPayload({
            encryptedBody: rawBody,
            uaEcdh,
            authSecret,
          });
          receivedRequests.push({
            headers: req.headers,
            decrypted: JSON.parse(jsonText) as Record<string, unknown>,
          });
        }
        res.statusCode = mockStatusCode;
        res.end(mockStatusCode >= 400 ? 'Gone' : 'Created');
      });
    });

    await new Promise<void>((resolve) => mockPushServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockPushServer.address() as { port: number };
    const pushEndpoint = `http://127.0.0.1:${addr.port}/push/sub-1`;
    cleanups.push(
      () => new Promise<void>((resolve) => mockPushServer.close(() => resolve()))
    );

    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    // Unauthenticated request blocked
    const anon = new TestApiClient(srv.baseUrl);
    const anonCfg = await anon.request('GET', '/api/notifications/config');
    expect(anonCfg.status).toBe(401);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const { client: bob } = await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');

    const cfgRes = await alice.request<{ vapidPublicKey: string; subscriptionCount: number }>(
      'GET',
      '/api/notifications/config'
    );
    expect(cfgRes.status).toBe(200);
    expect(cfgRes.data.vapidPublicKey.length).toBeGreaterThan(80);
    expect(cfgRes.data.subscriptionCount).toBe(0);

    // Validation rejects malformed subscription keys or non-https public endpoints
    const badKey = await alice.request('POST', '/api/notifications/subscribe', {
      endpoint: pushEndpoint,
      keys: { p256dh: 'short', auth: 'short' },
    });
    expect(badKey.status).toBe(400);

    const badEndpoint = await alice.request('POST', '/api/notifications/subscribe', {
      endpoint: 'http://example.com/insecure',
      keys: { p256dh: uaPub.toString('base64url'), auth: authSecret.toString('base64url') },
    });
    expect(badEndpoint.status).toBe(400);

    // Alice subscribes cleanly
    const subRes = await alice.request<{ ok: boolean; subscriptionCount: number }>(
      'POST',
      '/api/notifications/subscribe',
      {
        endpoint: pushEndpoint,
        keys: {
          p256dh: uaPub.toString('base64url'),
          auth: authSecret.toString('base64url'),
        },
        userAgent: 'Vitest-Client',
      }
    );
    expect(subRes.status).toBe(200);
    expect(subRes.data.subscriptionCount).toBe(1);

    // Bob cannot delete Alice's subscription
    const bobUnsub = await bob.request<{ removed: boolean }>('POST', '/api/notifications/unsubscribe', {
      endpoint: pushEndpoint,
    });
    expect(bobUnsub.status).toBe(200);
    expect(bobUnsub.data.removed).toBe(false);

    // Create a chat and connect Alice's WebSocket to await run.finished deterministically
    await alice.connectWs({ clientId: 'alice-tab' });
    cleanups.push(async () => alice.closeWs());

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: '通知テストチャット',
    });
    const chatId = chatRes.data.chat.id;

    // 1) While notifyOnResponse is OFF (default), completed turn sends 0 pushes
    const send1 = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: '1回目のテストメッセージ',
    });
    expect(send1.status).toBe(202);
    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string; runId?: string }).type === 'run.finished' && (f.event as { runId?: string }).runId === send1.data.run.id
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(receivedRequests).toHaveLength(0);

    // 2) Turn ON notifyOnResponse via PATCH /api/preferences
    const prefRes = await alice.request<{ preferences: { notifyOnResponse: boolean } }>(
      'PATCH',
      '/api/preferences',
      { notifyOnResponse: true }
    );
    expect(prefRes.status).toBe(200);
    expect(prefRes.data.preferences.notifyOnResponse).toBe(true);

    // 3) Run another turn -> encrypted Web Push is sent automatically!
    const send2 = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: '通知オン後のメッセージ',
    });
    expect(send2.status).toBe(202);
    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string; runId?: string }).type === 'run.finished' && (f.event as { runId?: string }).runId === send2.data.run.id
    );

    // Allow async fire-and-forget notification HTTP delivery to settle
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (receivedRequests.length >= 1) return resolve();
        if (Date.now() - start > 3000) return reject(new Error('Timed out waiting for Web Push delivery'));
        setTimeout(poll, 25);
      };
      poll();
    });

    expect(receivedRequests).toHaveLength(1);
    const delivered = receivedRequests[0];
    expect(delivered.headers['content-encoding']).toBe('aes128gcm');
    expect(delivered.headers['urgency']).toBe('high');
    expect(delivered.headers['authorization']).toContain(`k=${cfgRes.data.vapidPublicKey}`);
    expect(delivered.decrypted.title).toBe('通知テストチャット');
    expect(String(delivered.decrypted.body).length).toBeGreaterThan(0);
    expect(delivered.decrypted.chatId).toBe(chatId);
    expect(delivered.decrypted.tag).toBe(`run-${send2.data.run.id}`);

    // Default VAPID subject must not use non-public .local domain (rejected by Apple Push with 403)
    const defaultCfg = loadConfig();
    expect(defaultCfg.vapidSubject).not.toContain('.local');
    expect(defaultCfg.vapidSubject.startsWith('https://') || defaultCfg.vapidSubject.startsWith('mailto:')).toBe(true);

    // Status endpoint distinguishes registered vs unregistered device endpoints
    const statusRegistered = await alice.request<{ registeredOnServer: boolean; subscriptionCount: number }>(
      'POST',
      '/api/notifications/status',
      { endpoint: pushEndpoint }
    );
    expect(statusRegistered.status).toBe(200);
    expect(statusRegistered.data).toEqual({ registeredOnServer: true, subscriptionCount: 1 });

    const statusOther = await alice.request<{ registeredOnServer: boolean; subscriptionCount: number }>(
      'POST',
      '/api/notifications/status',
      { endpoint: 'http://127.0.0.1:9999/other' }
    );
    expect(statusOther.status).toBe(200);
    expect(statusOther.data).toEqual({ registeredOnServer: false, subscriptionCount: 1 });

    // 4) Cancel run -> no push sent
    const sendCancel = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: 'slow task [SLEEP_MS:2500]',
    });
    expect(sendCancel.status).toBe(202);
    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string; runId?: string }).type === 'run.started' && (f.event as { runId?: string }).runId === sendCancel.data.run.id
    );
    await alice.request('POST', `/api/chats/${chatId}/runs/${sendCancel.data.run.id}/cancel`);
    const cancelFinished = await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string; runId?: string }).type === 'run.finished' && (f.event as { runId?: string }).runId === sendCancel.data.run.id
    );
    expect(((cancelFinished.event as { payload: { run: { status: string } } }).payload.run).status).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 150));
    expect(receivedRequests).toHaveLength(1);

    // 5) Test push endpoint delivers test notification and reports per-device delivery
    const testPush = await alice.request<{
      sent: number;
      failed: number;
      currentDeviceRegistered?: boolean;
      currentDeviceSent?: boolean;
    }>('POST', '/api/notifications/test', { endpoint: pushEndpoint });
    expect(testPush.status).toBe(200);
    expect(testPush.data.sent).toBe(1);
    expect(testPush.data.currentDeviceRegistered).toBe(true);
    expect(testPush.data.currentDeviceSent).toBe(true);
    expect(receivedRequests).toHaveLength(2);
    expect(receivedRequests[1].decrypted.title).toBe('Antigravity Chat');

    // 6) Mock 410 Gone -> server auto-removes stale subscription
    mockStatusCode = 410;
    const goneTest = await alice.request<{
      sent: number;
      failed: number;
      removed: number;
      currentDeviceRegistered?: boolean;
      currentDeviceSent?: boolean;
      currentDeviceError?: string;
    }>('POST', '/api/notifications/test', { endpoint: pushEndpoint });
    expect(goneTest.status).toBe(200);
    expect(goneTest.data.sent).toBe(0);
    expect(goneTest.data.removed).toBe(1);
    expect(goneTest.data.currentDeviceRegistered).toBe(true);
    expect(goneTest.data.currentDeviceSent).toBe(false);
    expect(goneTest.data.currentDeviceError).toContain('410');

    const cfgAfter = await alice.request<{ subscriptionCount: number }>('GET', '/api/notifications/config');
    expect(cfgAfter.data.subscriptionCount).toBe(0);
  });

  it('sends Web Push notifications for permission requests and native Reactive Wakeup completions', async () => {
    const receivedRequests: Array<{
      headers: http.IncomingHttpHeaders;
      decrypted: Record<string, unknown>;
    }> = [];

    const uaEcdh = crypto.createECDH('prime256v1');
    const uaPub = uaEcdh.generateKeys();
    const authSecret = crypto.randomBytes(16);

    const mockPushServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const jsonText = decryptAes128GcmPayload({
          encryptedBody: Buffer.concat(chunks),
          uaEcdh,
          authSecret,
        });
        receivedRequests.push({
          headers: req.headers,
          decrypted: JSON.parse(jsonText) as Record<string, unknown>,
        });
        res.statusCode = 201;
        res.end('Created');
      });
    });

    await new Promise<void>((resolve) => mockPushServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockPushServer.address() as { port: number };
    const pushEndpoint = `http://127.0.0.1:${addr.port}/push/wakeup`;
    cleanups.push(
      () => new Promise<void>((resolve) => mockPushServer.close(() => resolve()))
    );

    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs({ clientId: 'alice-wakeup' });
    cleanups.push(async () => alice.closeWs());

    await alice.request('POST', '/api/notifications/subscribe', {
      endpoint: pushEndpoint,
      keys: { p256dh: uaPub.toString('base64url'), auth: authSecret.toString('base64url') },
      userAgent: 'Vitest-Wakeup',
    });
    await alice.request('PATCH', '/api/preferences', { notifyOnResponse: true });

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Wakeup & Permission 通知',
    });
    const chatId = chatRes.data.chat.id;

    // 1) Reactive Wakeup ([SUBAGENT_IMAGE]): initial turn finishes, then background subagent triggers wakeup -> state_update: idle
    const wakeupRun = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: '画像を生成 [SUBAGENT_IMAGE]',
    });
    const wakeupRunId = wakeupRun.data.run.id;

    const wakeupEvt = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.wakeup_finished' &&
        (f.event as { runId?: string }).runId === wakeupRunId,
      6000
    );
    const wakeupPayload = (wakeupEvt.event as { payload: { previewText?: string; notificationTag?: string } }).payload;
    expect(wakeupPayload.previewText).toContain('サブエージェントによる画像生成が完了しました');
    expect(wakeupPayload.notificationTag).toBe(`run-${wakeupRunId}-wakeup-1`);

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (receivedRequests.some((r) => r.decrypted.tag === `run-${wakeupRunId}-wakeup-1`)) return resolve();
        if (Date.now() - start > 3000) return reject(new Error('Timed out waiting for wakeup Web Push'));
        setTimeout(poll, 25);
      };
      poll();
    });

    const wakeupPush = receivedRequests.find((r) => r.decrypted.tag === `run-${wakeupRunId}-wakeup-1`)!;
    expect(String(wakeupPush.decrypted.body)).toContain('サブエージェントによる画像生成が完了しました');

    // 2) Permission request sends a push with perm-<id> tag
    const permRun = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: '承認テスト [PERMISSION]',
    });
    const permFrame = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'permission.requested' &&
        (f.event as { runId?: string }).runId === permRun.data.run.id
    );
    const permId = (permFrame.event as { payload: { permission: { id: string } } }).payload.permission.id;

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (receivedRequests.some((r) => r.decrypted.tag === `perm-${permId}`)) return resolve();
        if (Date.now() - start > 3000) return reject(new Error('Timed out waiting for permission Web Push'));
        setTimeout(poll, 25);
      };
      poll();
    });

    const permPush = receivedRequests.find((r) => r.decrypted.tag === `perm-${permId}`)!;
    expect(String(permPush.decrypted.title)).toContain('確認待ち');
    expect(String(permPush.decrypted.body)).toContain('承認が必要です');

    // Cleanly reject pending permission so worker terminates smoothly
    await alice.request('POST', `/api/chats/${chatId}/permissions/${permId}`, { optionId: 'reject_once' });
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === permRun.data.run.id
    );
  });

  it('uses previewText on error notifications when errorMessage is omitted and neutral text when empty', async () => {
    const receivedBodies: Array<{ title: string; body: string; tag: string }> = [];
    const uaEcdh = crypto.createECDH('prime256v1');
    const uaPub = uaEcdh.generateKeys();
    const authSecret = crypto.randomBytes(16);

    const mockPushServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const jsonText = decryptAes128GcmPayload({
          encryptedBody: Buffer.concat(chunks),
          uaEcdh,
          authSecret,
        });
        const parsed = JSON.parse(jsonText) as { title: string; body: string; tag: string };
        receivedBodies.push(parsed);
        res.statusCode = 201;
        res.end('Created');
      });
    });

    await new Promise<void>((resolve) => mockPushServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockPushServer.address() as { port: number };
    cleanups.push(
      () => new Promise<void>((resolve) => mockPushServer.close(() => resolve()))
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-push-err-'));
    cleanups.push(async () => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const db = new AppDatabase(path.join(tmpDir, 'test.db'));
    cleanups.push(async () => db.close());

    const user = db.createUser({
      id: 'err-user-1',
      username: 'erruser',
      displayName: 'Err User',
      passwordHash: 'hash',
      role: 'user',
      profileDir: path.join(tmpDir, 'profile'),
    });
    db.updatePreferences(user.id, { notifyOnResponse: true });
    const chat = db.createChat({
      id: 'err-chat-1',
      userId: user.id,
      projectId: null,
      title: 'エラー検証',
      workspaceDir: tmpDir,
      modelId: null,
      effortValue: null,
      projectContextVersion: 0,
    });
    db.upsertPushSubscription({
      id: 'sub-err-1',
      userId: user.id,
      endpoint: `http://127.0.0.1:${addr.port}/push/err`,
      p256dh: uaPub.toString('base64url'),
      auth: authSecret.toString('base64url'),
      userAgent: 'Vitest-Error-Test',
    });

    const cfg = loadConfig({ port: 0, dataRoot: tmpDir, nodeEnv: 'test' });
    const pushService = new PushNotificationService(cfg, db);

    await pushService.notifyRunFinished({
      userId: user.id,
      chatId: chat.id,
      runId: 'run-err-1',
      status: 'error',
      previewText: 'ツール実行でエラーが発生しました',
      tagOverride: 'run-err-1-wakeup-1',
    });

    await pushService.notifyRunFinished({
      userId: user.id,
      chatId: chat.id,
      runId: 'run-err-2',
      status: 'error',
      previewText: '',
      tagOverride: 'run-err-2-wakeup-1',
    });

    await pushService.notifyRunFinished({
      userId: user.id,
      chatId: chat.id,
      runId: 'run-ok-empty',
      status: 'completed',
      previewText: '',
      tagOverride: 'run-ok-empty-wakeup-1',
    });

    expect(receivedBodies).toHaveLength(3);
    expect(receivedBodies[0]).toMatchObject({
      tag: 'run-err-1-wakeup-1',
      title: 'エラーで終了 — エラー検証',
      body: 'ツール実行でエラーが発生しました',
    });
    expect(receivedBodies[1]).toMatchObject({
      tag: 'run-err-2-wakeup-1',
      title: 'エラーで終了 — エラー検証',
      body: '応答の生成中にエラーが発生しました。',
    });
    expect(receivedBodies[2]).toMatchObject({
      tag: 'run-ok-empty-wakeup-1',
      title: 'エラー検証',
      body: '応答が完了しました。',
    });
  });
});
