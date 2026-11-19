import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactRecord, ChatRecord, MessageRecord, RunRecord } from '../src/types.js';
import { createTestServer, registerAndBindAgy, TestApiClient } from './helpers/test-harness.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('Message rewind (edit/regenerate) & persisted context usage', () => {
  it('persists ACP usage_update on chat, resets it on edit rewind, and re-runs cleanly without fake transcript injection', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await client.connectWs({ clientId: 'alice-rewind-1' });

    const chatRes = await client.request<{ chat: ChatRecord }>('POST', '/api/chats', {});
    expect(chatRes.status).toBe(201);
    const chatId = chatRes.data.chat.id;
    expect(chatRes.data.chat.contextUsed ?? null).toBeNull();
    expect(chatRes.data.chat.contextSize ?? null).toBeNull();

    // Upload a user attachment to verify edit rewind preserves user attachments while pruning generated artifacts
    const fd = new FormData();
    fd.append('files', new Blob(['user attachment content'], { type: 'text/plain' }), 'notes.txt');
    const uploadRes = await client.request<{ attachments: Array<{ artifactId: string; filename: string }> }>(
      'POST',
      `/api/chats/${chatId}/attachments`,
      fd
    );
    expect(uploadRes.status).toBe(201);
    const uploadedAtt = uploadRes.data.attachments[0];
    expect(uploadedAtt).toBeTruthy();

    // Turn 1 with [ARTIFACT] so generated artifacts are created and linked
    const send1 = await client.request<{ userMessage: MessageRecord; run: RunRecord }>(
      'POST',
      `/api/chats/${chatId}/messages`,
      {
        text: 'First prompt [ARTIFACT]',
        attachments: [uploadedAtt],
      }
    );
    expect(send1.status).toBe(202);
    const u1Id = send1.data.userMessage.id;

    await client.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === send1.data.run.id
    );

    const detailAfter1 = await client.request<{
      chat: ChatRecord;
      messages: MessageRecord[];
      artifacts: ArtifactRecord[];
    }>('GET', `/api/chats/${chatId}`);
    expect(detailAfter1.data.chat.contextUsed).toBeGreaterThan(0);
    expect(detailAfter1.data.chat.contextSize).toBe(1_000_000);
    expect(detailAfter1.data.chat.title).toBe('First prompt [ARTIFACT]');
    const firstSessionId = detailAfter1.data.chat.acpSessionId;
    expect(firstSessionId).toBeTruthy();
    expect(detailAfter1.data.artifacts.some((a) => a.source === 'generated')).toBe(true);
    expect(detailAfter1.data.artifacts.some((a) => a.id === uploadedAtt.artifactId && a.source === 'attachment')).toBe(true);

    // Turn 2
    const send2 = await client.request<{ run: RunRecord }>('POST', `/api/chats/${chatId}/messages`, {
      text: 'Second turn question',
    });
    expect(send2.status).toBe(202);
    await client.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === send2.data.run.id
    );

    const detailAfter2 = await client.request<{ chat: ChatRecord; messages: MessageRecord[] }>(
      'GET',
      `/api/chats/${chatId}`
    );
    expect(detailAfter2.data.messages).toHaveLength(4);
    expect(detailAfter2.data.chat.contextUsed!).toBeGreaterThan(detailAfter1.data.chat.contextUsed!);

    // Role & input validations
    const assistantMsg1 = detailAfter2.data.messages[1];
    const invalidEditRole = await client.request<{ error: string }>(
      'POST',
      `/api/chats/${chatId}/messages/${assistantMsg1.id}/edit`,
      { text: 'Should fail' }
    );
    expect(invalidEditRole.status).toBe(400);
    expect(invalidEditRole.data.error).toBe('INVALID_ROLE');

    const invalidRegenRole = await client.request<{ error: string }>(
      'POST',
      `/api/chats/${chatId}/messages/${u1Id}/regenerate`,
      {}
    );
    expect(invalidRegenRole.status).toBe(400);
    expect(invalidRegenRole.data.error).toBe('INVALID_ROLE');

    // Cross-user isolation check
    await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');
    const bob = new TestApiClient(srv.baseUrl);
    await bob.request('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
    const crossUserEdit = await bob.request('POST', `/api/chats/${chatId}/messages/${u1Id}/edit`, {
      text: 'Hijack',
    });
    expect(crossUserEdit.status).toBe(404);

    // Edit user message #1 -> rewinds turns 1 assistant & turn 2, deletes generated artifacts, preserves uploaded attachment
    const editRes = await client.request<{
      userMessage: MessageRecord;
      assistantMessage: MessageRecord;
      run: RunRecord;
      chat: ChatRecord;
      messages: MessageRecord[];
      artifacts: ArtifactRecord[];
    }>('POST', `/api/chats/${chatId}/messages/${u1Id}/edit`, {
      text: 'Edited first prompt cleanly',
    });
    expect(editRes.status).toBe(200);
    expect(editRes.data.userMessage.id).toBe(u1Id);
    expect(editRes.data.userMessage.contentText).toBe('Edited first prompt cleanly');
    expect(editRes.data.chat.title).toBe('Edited first prompt cleanly');
    expect(editRes.data.chat.contextUsed ?? null).toBeNull();
    expect(editRes.data.chat.contextSize ?? null).toBeNull();
    expect(editRes.data.chat.acpSessionId ?? null).toBeNull();
    expect(editRes.data.messages).toHaveLength(2);
    expect(editRes.data.artifacts.some((a) => a.source === 'generated')).toBe(false);
    expect(editRes.data.artifacts.some((a) => a.id === uploadedAtt.artifactId)).toBe(true);

    // Durable chat.rewound event emitted cleanly
    const rewoundEvt = await client.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'chat.rewound'
    );
    expect((rewoundEvt.event as { chatId?: string }).chatId).toBe(chatId);

    // Wait for re-executed run to finish
    const editFinished = await client.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === editRes.data.run.id
    );
    const finMsg = (editFinished.event as { payload: { message: MessageRecord } }).payload.message;
    expect(finMsg.contentText).toContain('受信メッセージ: "Edited first prompt cleanly"');
    // Verify no synthetic prior-history prompt injection took place
    expect(finMsg.contentText).not.toContain('Second turn question');
    expect(finMsg.contentText).not.toContain('First prompt [ARTIFACT]');

    // New ACP session created & fresh context usage persisted
    const detailAfterEdit = await client.request<{ chat: ChatRecord; messages: MessageRecord[] }>(
      'GET',
      `/api/chats/${chatId}`
    );
    expect(detailAfterEdit.data.messages).toHaveLength(2);
    expect(detailAfterEdit.data.chat.acpSessionId).toBeTruthy();
    expect(detailAfterEdit.data.chat.acpSessionId).not.toBe(firstSessionId);
    expect(detailAfterEdit.data.chat.contextUsed).toBeGreaterThan(0);
    expect(detailAfterEdit.data.chat.contextSize).toBe(1_000_000);
    expect(srv.ctx.db.getRun(userId, send1.data.run.id)).toBeNull();
    expect(srv.ctx.db.getRun(userId, send2.data.run.id)).toBeNull();
    expect(srv.ctx.db.getRun(userId, editRes.data.run.id)?.status).toBe('completed');

    client.closeWs();
  });

  it('regenerates an assistant turn, cancels active/queued runs cleanly on rewind, and restores prior user prompt', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await client.connectWs({ clientId: 'alice-regen-1' });

    const chatId = (await client.request<{ chat: ChatRecord }>('POST', '/api/chats', {})).data.chat.id;

    // Turn 1
    const send1 = await client.request<{ userMessage: MessageRecord; assistantMessage: MessageRecord; run: RunRecord }>(
      'POST',
      `/api/chats/${chatId}/messages`,
      { text: 'Explain event loops briefly' }
    );
    expect(send1.status).toBe(202);
    await client.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === send1.data.run.id
    );
    const a1Id = send1.data.assistantMessage.id;

    // Start slow Turn 2 so it's actively running when we rewind back to Turn 1's assistant message
    const send2 = await client.request<{ run: RunRecord }>('POST', `/api/chats/${chatId}/messages`, {
      text: '[SLEEP_MS:2500] Slow follow-up turn',
    });
    expect(send2.status).toBe(202);

    // Regenerate Turn 1 assistant message -> cancels Turn 2, rewinds to user #1, and enqueues fresh run
    const regenRes = await client.request<{
      userMessage: MessageRecord;
      assistantMessage: MessageRecord;
      run: RunRecord;
      messages: MessageRecord[];
    }>('POST', `/api/chats/${chatId}/messages/${a1Id}/regenerate`, {});
    expect(regenRes.status).toBe(200);
    expect(regenRes.data.userMessage.id).toBe(send1.data.userMessage.id);
    expect(regenRes.data.userMessage.contentText).toBe('Explain event loops briefly');
    expect(regenRes.data.assistantMessage.id).not.toBe(a1Id);
    expect(regenRes.data.messages).toHaveLength(2);

    const regenFinished = await client.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId?: string }).type === 'run.finished' &&
        (f.event as { runId?: string }).runId === regenRes.data.run.id,
      8000,
      true
    );
    const regeneratedAssistant = (regenFinished.event as { payload: { message: MessageRecord } }).payload.message;
    expect(regeneratedAssistant.status).toBe('completed');
    expect(regeneratedAssistant.contentText).toContain('受信メッセージ: "Explain event loops briefly"');
    expect(regeneratedAssistant.contentText).not.toContain('Slow follow-up turn');

    // Final DB state must have only the 1 turn cleanly completed and no stray active runs
    const finalDetail = await client.request<{
      chat: ChatRecord;
      messages: MessageRecord[];
      activeRun: RunRecord | null;
    }>('GET', `/api/chats/${chatId}`);
    expect(finalDetail.data.messages).toHaveLength(2);
    expect(finalDetail.data.activeRun).toBeNull();
    expect(finalDetail.data.chat.contextUsed).toBeGreaterThan(0);

    client.closeWs();
  });
});
