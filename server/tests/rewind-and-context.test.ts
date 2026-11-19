import { afterEach, describe, expect, it } from 'vitest';
import type {
  ArtifactRecord,
  ChatRecord,
  MessageRecord,
  PendingPermissionRecord,
  RunRecord,
} from '../src/types.js';
import { createTestServer, registerAndBindAgy, TestApiClient } from './helpers/test-harness.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

interface ChatDetail {
  chat: ChatRecord;
  messages: MessageRecord[];
  artifacts: ArtifactRecord[];
  pendingPermissions: PendingPermissionRecord[];
  activeRun: RunRecord | null;
}

describe('ACP context usage and unavailable history operations', () => {
  it('persists usage and preserves conversation and workspace across edit and regenerate requests', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await client.connectWs({ clientId: 'alice-history' });
    cleanups.push(async () => client.closeWs());

    const created = await client.request<{ chat: ChatRecord }>('POST', '/api/chats', {});
    expect(created.status).toBe(201);
    expect(created.data.chat.contextUsed).toBeNull();
    expect(created.data.chat.contextSize).toBeNull();

    const base = `/api/chats/${created.data.chat.id}`;
    const files = new FormData();
    files.append('files', new Blob(['user attachment'], { type: 'text/plain' }), 'notes.txt');
    const uploaded = await client.request<{ attachments: Array<{ artifactId: string }> }>(
      'POST', `${base}/attachments`, files
    );
    expect(uploaded.status).toBe(201);
    const attachedId = uploaded.data.attachments[0].artifactId;

    const first = await client.request<{ run: RunRecord }>('POST', `${base}/messages`, {
      text: 'First turn',
      attachmentIds: [attachedId],
    });
    expect(first.status).toBe(202);
    await client.waitForFrame((frame) => {
      const event = frame.event as { type?: string; runId?: string } | undefined;
      return event?.type === 'run.finished' && event.runId === first.data.run.id;
    });
    const firstDetail = (await client.request<ChatDetail>('GET', base)).data;

    const second = await client.request<{ run: RunRecord }>('POST', `${base}/messages`, {
      text: 'Second turn [ARTIFACT]',
    });
    expect(second.status).toBe(202);
    await client.waitForFrame((frame) => {
      const event = frame.event as { type?: string; runId?: string } | undefined;
      return event?.type === 'run.finished' && event.runId === second.data.run.id;
    });
    const before = (await client.request<ChatDetail>('GET', base)).data;
    expect(before.chat.acpSessionId).toBeTruthy();
    expect(before.chat.acpSessionId).toBe(firstDetail.chat.acpSessionId);
    expect(before.chat.contextSize).toBe(1_000_000);
    expect(before.chat.contextUsed!).toBeGreaterThan(firstDetail.chat.contextUsed!);
    expect(before.messages).toHaveLength(4);
    expect(before.messages[0].attachments[0]?.artifactId).toBe(attachedId);
    expect(before.artifacts.some((artifact) => artifact.relPath === 'summary.md')).toBe(true);

    const userPath = `${base}/messages/${second.data.run.userMessageId}`;
    const answerPath = `${base}/messages/${second.data.run.assistantMessageId}`;
    const edit = await client.request<{ error: string }>('POST', `${userPath}/edit`, { text: 'Edited' });
    const regenerate = await client.request<{ error: string }>('POST', `${answerPath}/regenerate`);
    for (const response of [edit, regenerate]) {
      expect(response.status).toBe(501);
      expect(response.data.error).toBe('ACP_REWIND_UNAVAILABLE');
    }

    const wrongRole = await client.request('POST', `${userPath}/regenerate`);
    expect(wrongRole.status).toBe(400);
    const { client: otherUser } = await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');
    const otherUserEdit = await otherUser.request('POST', `${userPath}/edit`, { text: 'Edited' });
    expect(otherUserEdit.status).toBe(404);

    const after = (await client.request<ChatDetail>('GET', base)).data;
    expect(after.chat).toEqual(before.chat);
    expect(after.messages).toEqual(before.messages);
    expect(after.artifacts).toEqual(before.artifacts);
    expect(srv.ctx.db.getRun(userId, first.data.run.id)?.status).toBe('completed');
    expect(srv.ctx.db.getRun(userId, second.data.run.id)?.status).toBe('completed');
    const workspace = await client.request<{ files: Array<{ relPath: string }> }>('GET', `${base}/workspace`);
    expect(workspace.data.files.some((file) => file.relPath === 'summary.md')).toBe(true);
  });

  it('leaves an active ACP turn and its permission request intact when editing is unavailable', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const { client } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await client.connectWs({ clientId: 'alice-permission' });
    cleanups.push(async () => client.closeWs());

    const created = await client.request<{ chat: ChatRecord }>('POST', '/api/chats', {});
    const base = `/api/chats/${created.data.chat.id}`;
    const sent = await client.request<{ run: RunRecord }>('POST', `${base}/messages`, {
      text: 'Please ask for approval [PERMISSION]',
    });
    expect(sent.status).toBe(202);
    const before = await client.waitForFrame((frame) => {
      const event = frame.event as { type?: string; runId?: string } | undefined;
      return event?.type === 'permission.requested' && event.runId === sent.data.run.id;
    }) as { event: { payload: { permission: PendingPermissionRecord } } };
    const permission = before.event.payload.permission;

    const edit = await client.request('POST', `${base}/messages/${sent.data.run.userMessageId}/edit`, {
      text: 'Edited',
    });
    expect(edit.status).toBe(501);
    const after = (await client.request<ChatDetail>('GET', base)).data;
    expect(after.activeRun).toMatchObject({ id: sent.data.run.id, status: 'awaiting_permission' });
    expect(after.pendingPermissions.map(({ id }) => id)).toEqual([permission.id]);
    expect(after.messages[0].contentText).toBe('Please ask for approval [PERMISSION]');

    const cancel = await client.request('POST', `${base}/permissions/${permission.id}`, { cancel: true });
    expect(cancel.status).toBe(200);
  });
});
