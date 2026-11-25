import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.AGY_REAL_TEST !== '1') {
  console.log('UNVERIFIED (REQUIRES REAL AGY / PHYSICAL IPHONE)');
  process.exit(0);
}

const { AGY_REAL_TEST_URL, AGY_REAL_TEST_COOKIE, AGY_REAL_TEST_CHAT_ID } = process.env;
assert(AGY_REAL_TEST_URL && AGY_REAL_TEST_COOKIE && AGY_REAL_TEST_CHAT_ID,
  'Set AGY_REAL_TEST_URL, AGY_REAL_TEST_COOKIE and AGY_REAL_TEST_CHAT_ID for a dedicated chat on an authenticated AGY_MODE=real server.');
const origin = new URL(AGY_REAL_TEST_URL);
assert(origin.protocol === 'https:' ||
  (origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)),
'Use HTTPS or a loopback server for the test session.');
const csrf = AGY_REAL_TEST_COOKIE.split(';').map((cookie) => cookie.trim())
  .find((cookie) => cookie.startsWith('agy_chat_csrf='))?.slice('agy_chat_csrf='.length);
assert(csrf, 'The session cookie header must include agy_chat_csrf.');
const chatPath = `/api/chats/${encodeURIComponent(AGY_REAL_TEST_CHAT_ID)}`;

async function api(path, body) {
  const headers = { cookie: AGY_REAL_TEST_COOKIE };
  if (body) {
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = decodeURIComponent(csrf);
  }
  const response = await fetch(new URL(path, origin), {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `Request failed (${response.status}) for ${path}`);
  return response.json();
}

const marker = `Artifact MCP runtime check ${crypto.randomUUID()}`;
const before = await api(chatPath);
const oldIds = new Set(before.messages.map(({ id }) => id));
await api(`${chatPath}/messages`, {
  text: [
    'Use the built-in Artifact tools to inspect artifact_list and rich_capabilities.',
    'Use rich_create to save a schema version 1 document with a markdown node containing this exact text:',
    marker,
    'In your final reply include the exact agy-rich:// link returned by rich_create.',
  ].join('\n'),
});

const deadline = Date.now() + 180_000;
let output;
while (Date.now() < deadline) {
  const { messages } = await api(chatPath);
  output = messages.find((message) => message.role === 'assistant' && !oldIds.has(message.id) &&
    ['completed', 'cancelled', 'error'].includes(message.status));
  if (output) break;
  await delay(2000);
}
assert(output, 'The real ACP turn did not finish before the deadline.');
assert.equal(output.status, 'completed', 'The real ACP turn did not complete successfully.');
const blockId = /agy-rich:\/\/([0-9a-f-]{36})/i.exec(output.contentText)?.[1];
assert(blockId, 'The reply did not include a rich_create reference.');
const { block } = await api(`${chatPath}/rich-blocks/${blockId}`);
assert(JSON.stringify(block.document).includes(marker), 'The returned rich block did not contain the test marker.');
console.log('VERIFIED (REAL RUNTIME): real ACP rich_create and explicit reference');
if (block.bindingState === 'confirmed_by_tool_call' && block.confirmedMessageId === output.id &&
    output.richBlockIds?.includes(blockId)) {
  console.log('VERIFIED (REAL RUNTIME): completed tool call confirmed the block for its assistant message');
} else {
  console.log('UNVERIFIED (REQUIRES REAL AGY / PHYSICAL IPHONE): completed tool call binding');
}
