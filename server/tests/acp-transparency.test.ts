import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageRecord } from '../src/types.js';
import { PathContainmentError, resolveContainedWriteTarget, supportsWorkspaceTextWrites, writeWorkspaceTextFile } from '../src/files/workspace.js';
import { getMessageActivity } from '../../web/src/utils/messageActivity.js';
import { newerMessage } from '../../web/src/utils/messageSnapshot.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('ACP transparency & Reactive Wakeup behavior (Issue #2)', () => {
  it.skipIf(!supportsWorkspaceTextWrites)('relays native ACP permission requests and replays activity in ACP order', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const { client } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await client.connectWs();

    const { data: { chat } } = await client.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST', '/api/chats', {}
    );
    const url = `/api/chats/${chat.id}`;
    await client.request('POST', `${url}/messages`, { text: '[ACTIVITY_SEQUENCE] [PERMISSION]' });
    const waitForPermission = async (previousId?: string) => {
      const frame = await client.waitForFrame((frame) => {
        if (frame.kind !== 'event') return false;
        const event = frame.event as { type: string; payload: { permission?: { id: string } } };
        return event.type === 'permission.requested' && event.payload.permission?.id !== previousId;
      });
      return (frame.event as { payload: { permission: { id: string } } }).payload.permission;
    };
    const firstPermission = await waitForPermission();
    const filename = path.join(chat.workspaceDir, 'created-by-tool.md');
    expect(fs.existsSync(filename)).toBe(false);
    const approval = await client.request('POST', `${url}/permissions/${firstPermission.id}`, { optionId: 'allow_once' });
    expect(approval.status).toBe(200);
    await client.waitForFrame((frame) =>
      frame.kind === 'event' && (frame.event as { type: string }).type === 'run.finished'
    );
    const fileContent = fs.readFileSync(filename, 'utf8');
    expect(fileContent).toContain('Created with user permission');

    const detail = await client.request<{ messages: MessageRecord[] }>('GET', url);
    const message = detail.data.messages.find((item) => item.role === 'assistant')!;
    expect(message.activity?.map(({ kind }) => kind)).toEqual([
      'thoughts', 'tool', 'tool', 'content', 'tool', 'content', 'answer_end',
    ]);
    const staleSnapshot = { ...message, status: 'streaming' } as const;
    expect(newerMessage(message, staleSnapshot)).toBe(message);
    expect(newerMessage(staleSnapshot, message)).toBe(message);
    const laterSnapshot = { ...staleSnapshot, updatedAt: message.updatedAt + 1 };
    expect(newerMessage(message, laterSnapshot)).toBe(laterSnapshot);

    const activity = getMessageActivity(message);
    expect(activity.blocks.map(({ kind }) => kind)).toEqual(['thoughts', 'tools', 'commentary', 'tools']);
    expect(activity.hasCurrentAnswer).toBe(true);
    expect(message.toolCalls.at(-1)?.diffStats).toEqual({ added: 4, removed: 0 });
    expect(activity.answer).toContain('created-by-tool.md');
    expect(activity.answer).not.toContain('作業フォルダを確認しました');

    // Replacing the same in-workspace path with an external symlink requires a decision.
    const outside = path.join(path.dirname(chat.workspaceDir), 'external.md');
    fs.renameSync(filename, outside);
    fs.symlinkSync(outside, filename);
    await client.request('POST', `${url}/messages`, { text: '[PERMISSION]' });
    const permission = await waitForPermission(firstPermission.id);
    const rejection = await client.request('POST', `${url}/permissions/${permission.id}`, { optionId: 'reject_once' });
    expect(rejection.status).toBe(200);
    expect(() => writeWorkspaceTextFile(chat.workspaceDir, 'created-by-tool.md', 'denied')).toThrow(PathContainmentError);
    fs.symlinkSync(path.dirname(outside), path.join(chat.workspaceDir, 'outside-dir'));
    expect(() => writeWorkspaceTextFile(chat.workspaceDir, 'outside-dir/external.md', 'denied')).toThrow();
    expect(fs.readFileSync(outside, 'utf8')).toBe(fileContent);

    writeWorkspaceTextFile(chat.workspaceDir, 'nested/notes.md', 'nested write');
    const nested = path.join(chat.workspaceDir, 'nested/notes.md');
    expect(fs.readFileSync(nested, 'utf8')).toBe('nested write');
    fs.symlinkSync('nested', path.join(chat.workspaceDir, 'nested-link'));
    writeWorkspaceTextFile(chat.workspaceDir, 'nested-link/via-directory.md', 'directory link write');
    expect(fs.readFileSync(path.join(chat.workspaceDir, 'nested/via-directory.md'), 'utf8')).toBe('directory link write');
    const fileLink = path.join(chat.workspaceDir, 'notes-link.md');
    fs.symlinkSync('nested/notes.md', fileLink);
    writeWorkspaceTextFile(chat.workspaceDir, 'notes-link.md', 'file link write');
    expect(fs.lstatSync(fileLink).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(nested, 'utf8')).toBe('file link write');
    fs.chmodSync(nested, 0o400);
    if (process.getuid?.() !== 0) {
      expect(() => writeWorkspaceTextFile(chat.workspaceDir, 'nested/notes.md', 'denied')).toThrow();
      expect(fs.readFileSync(nested, 'utf8')).toBe('file link write');
    }
    const danglingLink = path.join(chat.workspaceDir, 'dangling.md');
    fs.symlinkSync(path.join(chat.workspaceDir, 'missing.md'), danglingLink);
    expect(() => resolveContainedWriteTarget(chat.workspaceDir, 'dangling.md')).toThrow(PathContainmentError);
    client.closeWs();
  });

  it('handles delayed subagent_update after invoke_subagent completed, preserves native status & full child logs, and syncs background artifacts (#4, #5, #6, #10, #13, #18)', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST',
      '/api/chats',
      { title: 'Delayed Subagent Test' }
    );
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    await alice.request('POST', `/api/chats/${chatId}/messages`, {
      text: 'Run [DELAYED_SUBAGENT]',
    });

    const finishedFrame = await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );
    expect(
      (finishedFrame.event as { payload?: { run?: { status?: string } } }).payload?.run?.status
    ).toBe('completed');

    // Wait for background child session to reach idle and emit full content
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string }).type === 'message.updated' &&
        Boolean(
          (
            f.event as {
              payload?: {
                message?: {
                  toolCalls?: Array<{ subagentState?: string; subagentContentText?: string }>;
                };
              };
            }
          ).payload?.message?.toolCalls?.some(
            (tc) =>
              tc.subagentState === 'idle' &&
              (tc.subagentContentText?.length ?? 0) > 300
          )
        )
    );

    const detail = await alice.request<{
      messages: Array<{
        role: string;
        toolCalls: Array<{
          title: string;
          status: string;
          isSubagent?: boolean;
          subagentState?: string;
          subagentThoughtsText?: string;
          subagentContentText?: string;
          subagentToolCalls?: Array<{ title: string; status: string }>;
        }>;
      }>;
      artifacts: Array<{ relPath: string }>;
    }>('GET', `/api/chats/${chatId}`);

    const assistant = detail.data.messages.filter((m) => m.role === 'assistant').pop()!;
    expect(assistant).toBeTruthy();
    expect(assistant.toolCalls).toHaveLength(1);
    const subTc = assistant.toolCalls[0];
    // Native tool_call status ('completed') must not be rewritten to 'in_progress'
    expect(subTc.status).toBe('completed');
    expect(subTc.subagentState).toBe('idle');
    expect(subTc.subagentThoughtsText).toContain('子セッション思考ログ: 詳細解析中...');
    expect((subTc.subagentContentText ?? '').length).toBeGreaterThan(300);
    expect(subTc.subagentToolCalls?.some((c) => c.title === 'child_read_file' && c.status === 'completed')).toBe(
      true
    );

    // Background workspace file creation must be synced as an artifact
    expect(fs.existsSync(path.join(workspaceDir, 'delayed-output.txt'))).toBe(true);
    expect(detail.data.artifacts.some((a) => a.relPath === 'delayed-output.txt')).toBe(true);

    alice.closeWs();
  });

  it('does not revert terminal run status on background requestPermission and still resolves it (#3)', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST',
      '/api/chats',
      { title: 'Background Permission Test' }
    );
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    const msgRes = await alice.request<{ run: { id: string } }>(
      'POST',
      `/api/chats/${chatId}/messages`,
      { text: 'Start [BG_PERMISSION]' }
    );
    const runId = msgRes.data.run.id;

    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const permFrame = await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'permission.requested'
    );
    const permId = (
      permFrame.event as { payload?: { permission?: { id: string } } }
    ).payload?.permission?.id;
    expect(permId).toBeTruthy();

    // Terminal run must remain 'completed' (never reverted to 'awaiting_permission')
    const detailDuringPerm = await alice.request<{
      activeRun: unknown;
    }>('GET', `/api/chats/${chatId}`);
    expect(detailDuringPerm.data.activeRun).toBeNull();
    const runRecord = srv.ctx.db.getRun(userId, runId);
    expect(runRecord?.status).toBe('completed');

    const respondRes = await alice.request(
      'POST',
      `/api/chats/${chatId}/permissions/${permId}`,
      { optionId: 'allow_once' }
    );
    expect(respondRes.status).toBe(200);

    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string }).type === 'message.updated' &&
        Boolean(
          (f.event as { payload?: { message?: { contentText?: string } } }).payload?.message
            ?.contentText?.includes('背景Permissionが承認され完了しました')
        )
    );

    expect(fs.existsSync(path.join(workspaceDir, 'bg-permitted.txt'))).toBe(true);
    alice.closeWs();
  });

  it('persists session_message and session_message_chunk updates in message.sessionMessages (#7)', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Session Message Test',
    });
    const chatId = chatRes.data.chat.id;

    await alice.request('POST', `/api/chats/${chatId}/messages`, {
      text: 'Trigger [SESSION_MESSAGE_TEST]',
    });

    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const detail = await alice.request<{
      messages: Array<{
        role: string;
        contentText: string;
        sessionMessages?: Array<{
          messageId: string;
          senderSessionId?: string;
          recipientSessionId?: string;
          contentText: string;
          done?: boolean;
        }>;
      }>;
    }>('GET', `/api/chats/${chatId}`);

    const assistant = detail.data.messages.filter((m) => m.role === 'assistant').pop()!;
    expect(assistant.contentText).toContain('セッション間メッセージを受信しました。');
    expect(assistant.sessionMessages).toHaveLength(1);
    expect(assistant.sessionMessages?.[0].contentText).toBe('初期本文:チャンク追記完了');
    expect(assistant.sessionMessages?.[0].done).toBe(true);

    alice.closeWs();
  });

  it('keeps worker alive during skill update while background subagent is active and isolates multi-turn background bridges (#1, #2, #8)', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Multi-Turn Background Isolation Test',
    });
    const chatId = chatRes.data.chat.id;

    // Turn A starts a background subagent (150ms delay)
    await alice.request('POST', `/api/chats/${chatId}/messages`, {
      text: 'Turn A [MULTI_TURN_BG]',
    });

    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    // Updating skills while background subagent is active must NOT evict the worker (#1, #8)
    const skillRes = await alice.request('POST', '/api/skills', {
      scope: 'global',
      slug: 'bg-safe-skill',
      name: 'BG Safe Skill',
      description: 'Test skill created while background subagent runs',
      instructions: 'Be helpful.',
    });
    expect(skillRes.status).toBe(201);

    // Immediately send Turn B (creating artifacts) while Turn A's background subagent is still running
    const turnBRes = await alice.request<{ run: { id: string } }>(
      'POST',
      `/api/chats/${chatId}/messages`,
      { text: 'ターンB通常応答 [ARTIFACT]' }
    );
    const turnBRunId = turnBRes.data.run.id;

    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === turnBRunId
    );

    // Wait for Turn A's delayed subagent output to arrive
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string }).type === 'message.updated' &&
        Boolean(
          (
            f.event as {
              payload?: {
                message?: {
                  toolCalls?: Array<{ subagentContentText?: string }>;
                };
              };
            }
          ).payload?.message?.toolCalls?.some((tc) =>
            tc.subagentContentText?.includes('ターンA子の遅延出力')
          )
        )
    );

    const detail = await alice.request<{
      messages: Array<{
        id: string;
        role: string;
        contentText: string;
        artifactIds?: string[];
        toolCalls: Array<{ subagentContentText?: string; subagentState?: string }>;
      }>;
      artifacts: Array<{ id: string; relPath: string; messageId: string | null }>;
    }>('GET', `/api/chats/${chatId}`);

    const assistants = detail.data.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    const [turnAAssistant, turnBAssistant] = assistants;

    expect(turnAAssistant.contentText).toContain('ターンA初期応答');
    expect(turnAAssistant.toolCalls[0]?.subagentContentText).toContain('ターンA子の遅延出力');
    expect(turnAAssistant.toolCalls[0]?.subagentState).toBe('idle');

    // Turn B must NOT be polluted by Turn A's background subagent output
    expect(turnBAssistant.contentText).toContain('ターンB通常応答');
    expect(turnBAssistant.contentText).not.toContain('ターンA子の遅延出力');
    expect(turnBAssistant.toolCalls).toHaveLength(0);

    // Turn B's artifacts must remain owned by Turn B (not stolen by Turn A's background sync)
    const summaryArt = detail.data.artifacts.find((a) => a.relPath === 'summary.md');
    expect(summaryArt).toBeTruthy();
    expect(summaryArt?.messageId).toBe(turnBAssistant.id);
    expect(turnAAssistant.artifactIds ?? []).not.toContain(summaryArt?.id);

    alice.closeWs();
  });

  it('does not inject synthetic transcript bridge into user prompts after worker restart (#9)', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Prompt Transparency Test',
    });
    const chatId = chatRes.data.chat.id;

    const r1 = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: 'ファーストメッセージ',
    });
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === r1.data.run.id
    );

    // Force idle worker stop so next turn re-loads/re-creates session
    await srv.ctx.acp.stopChatWorkerIfIdle(chatId);

    const r2 = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: 'セカンドメッセージ',
    });
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === r2.data.run.id
    );

    const detail = await alice.request<{
      messages: Array<{ role: string; contentText: string }>;
    }>('GET', `/api/chats/${chatId}`);

    const assistants = detail.data.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[1].contentText).toContain('セカンドメッセージ');
    expect(assistants[1].contentText).not.toContain('[これまでの会話履歴]');

    alice.closeWs();
  });
});
