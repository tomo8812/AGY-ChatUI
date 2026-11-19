import { expect, it } from 'vitest';
import type { ChatRecord, RunRecord } from '../src/types.js';
import { createTestServer, registerAndBindAgy, type TestApiClient } from './helpers/test-harness.js';

it('persists usage updates from Antigravity in the chat record', async () => {
  const srv = await createTestServer();
  let client: TestApiClient | undefined;
  try {
    ({ client } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com'));
    await client.connectWs({ clientId: 'alice-context' });

    const created = await client.request<{ chat: ChatRecord }>('POST', '/api/chats', {});
    expect(created.status).toBe(201);
    expect(created.data.chat.contextUsed).toBeNull();
    expect(created.data.chat.contextSize).toBeNull();

    const chatPath = `/api/chats/${created.data.chat.id}`;
    for (const [text, expectedUsage] of [
      ['First turn', 1300],
      ['Second turn', 1400],
    ] as const) {
      const sent = await client.request<{ run: RunRecord }>('POST', `${chatPath}/messages`, { text });
      expect(sent.status).toBe(202);
      await client.waitForFrame((frame) => {
        const event = frame.event as { type?: string; runId?: string } | undefined;
        return event?.type === 'run.finished' && event.runId === sent.data.run.id;
      });

      const detail = await client.request<{ chat: ChatRecord }>('GET', chatPath);
      expect(detail.status).toBe(200);
      expect(detail.data.chat.contextUsed).toBe(expectedUsage);
      expect(detail.data.chat.contextSize).toBe(1_000_000);
    }
  } finally {
    client?.closeWs();
    await srv.cleanup();
  }
});
