import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.AGY_REAL_TEST !== '1') {
  console.log('UNVERIFIED (REQUIRES REAL AGY / PHYSICAL IPHONE)');
  process.exit(0);
}

const {
  AGY_REAL_TEST_URL, AGY_REAL_TEST_COOKIE, AGY_REAL_TEST_CHAT_ID,
  AGY_REAL_TEST_EXTERNAL_TOOL, AGY_REAL_TEST_EXTERNAL_RESULT,
  AGY_REAL_TEST_RESUME_STATE, AGY_REAL_TEST_RESUME_ONLY,
} = process.env;
assert(AGY_REAL_TEST_URL && AGY_REAL_TEST_COOKIE && AGY_REAL_TEST_CHAT_ID,
  'Set AGY_REAL_TEST_URL, AGY_REAL_TEST_COOKIE and AGY_REAL_TEST_CHAT_ID for a dedicated chat on an authenticated AGY_MODE=real server.');
const origin = new URL(AGY_REAL_TEST_URL);
assert(origin.protocol === 'https:' ||
  (origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)),
'Use HTTPS or a loopback server for the test session.');
const csrf = AGY_REAL_TEST_COOKIE.split(';').map(cookie => cookie.trim())
  .find(cookie => cookie.startsWith('agy_chat_csrf='))?.slice('agy_chat_csrf='.length);
assert(csrf, 'The session cookie header must include agy_chat_csrf.');
const chatPath = `/api/chats/${encodeURIComponent(AGY_REAL_TEST_CHAT_ID)}`;
const tools = [
  'artifact_list', 'artifact_capabilities', 'artifact_create', 'artifact_get_structure', 'artifact_read_range',
  'artifact_edit', 'artifact_batch_edit', 'artifact_render', 'artifact_verify', 'artifact_export', 'artifact_history',
  'artifact_restore', 'artifact_restore_bundle', 'edit_request_list', 'edit_request_get', 'edit_request_mark_applied',
  'rich_capabilities', 'rich_validate', 'rich_create', 'rich_get', 'rich_update', 'rich_save_as_artifact',
];

async function api(path, body) {
  const headers = { cookie: AGY_REAL_TEST_COOKIE };
  if (body) {
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = decodeURIComponent(csrf);
  }
  const response = await fetch(new URL(path, origin), {
    method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `Request failed (${response.status}) for ${path}`);
  return response.json();
}

async function waitForRun(runId, expectedStatus = 'completed') {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = await api(chatPath);
    const output = state.messages.find(message => message.role === 'assistant' && message.runId === runId);
    if (output && ['completed', 'cancelled', 'error'].includes(output.status)) {
      assert.equal(output.status, expectedStatus, 'The real ACP turn finished in an unexpected state.');
      return { output, state };
    }
    await delay(2000);
  }
  assert.fail('The real ACP turn did not finish before the deadline.');
}
const send = async text => (await api(`${chatPath}/messages`, { text, clientMessageId: crypto.randomUUID() })).run.id;
const report = description => console.log(`VERIFIED (REAL RUNTIME): ${description}`);
const pending = description => console.log(`UNVERIFIED (REQUIRES REAL AGY / PHYSICAL IPHONE): ${description}`);

function assertToolCall(output, name) {
  const call = output.toolCalls?.find(call => JSON.stringify([call.name, call.toolName]).includes(name) &&
    call.status === 'completed');
  assert(call, `The real ACP transcript did not record completed ${name}.`);
  return call;
}

function assertImageOutput(call) {
  const output = call.rawOutput;
  const content = Array.isArray(output) ? output : output?.content;
  assert(content?.some(part => part.type === 'image' && part.mimeType === 'image/png' &&
    typeof part.data === 'string' && Buffer.from(part.data, 'base64').subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )), `The transcript did not retain a PNG image block for ${call.name}.`);
}

function makeColorPdf() {
  const stream = '1 0 0 rg 0 120 120 120 re f\n0 0 1 rg 120 0 120 240 re f\n0 0 0 rg 0 0 120 120 re f\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n` +
    offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString('base64');
}

if (AGY_REAL_TEST_RESUME_ONLY === '1') {
  assert(AGY_REAL_TEST_RESUME_STATE, 'Set AGY_REAL_TEST_RESUME_STATE to the previous run evidence and restart the real server before running this mode.');
  const { blockId, sessionId, messageId, chatId } = JSON.parse(await readFile(AGY_REAL_TEST_RESUME_STATE, 'utf8'));
  assert.equal(chatId, AGY_REAL_TEST_CHAT_ID);
  const { output, state } = await waitForRun(await send(
    `Use rich_get to read ${blockId} and include agy-rich://${blockId} in your reply with any one word of normal text.`,
  ));
  assertToolCall(output, 'rich_get');
  assert.equal(state.chat.acpSessionId, sessionId);
  assert(output.contentText.includes(`agy-rich://${blockId}`));
  assert(!output.richBlockIds?.includes(blockId));
  const { block } = await api(`${chatPath}/rich-blocks/${blockId}`);
  assert.equal(block.confirmedMessageId, messageId);
  report('real ACP session reuse and historical Rich reference after the operator restart');
  process.exit(0);
}

const nonce = crypto.randomUUID();
const marker = `Artifact MCP runtime check ${nonce}`;
const plain = `PLAIN-${nonce}`;
const { output, state } = await waitForRun(await send([
  'Enumerate the exact names of all tools currently exposed by the built-in artifact MCP server under AVAILABLE_TOOLS.',
  'Call artifact_list and rich_capabilities. Then use rich_create to save a schema version 1 document',
  `with a Markdown node containing this exact text: ${marker}`,
  `In your final response include both the exact agy-rich:// reference from rich_create and this ordinary text line: ${plain}`,
].join('\n')));
for (const name of ['artifact_list', 'rich_capabilities', 'rich_create']) assertToolCall(output, name);
for (const name of tools) assert(new RegExp(`\\b${name}\\b`).test(output.contentText), `The agent did not report ${name}.`);
assert(output.contentText.includes(plain), 'Ordinary reply text is missing.');
const blockId = /agy-rich:\/\/([0-9a-f-]{36})/i.exec(output.contentText)?.[1];
assert(blockId, 'The reply did not include a rich_create reference.');
const { block } = await api(`${chatPath}/rich-blocks/${blockId}`);
assert(JSON.stringify(block.document).includes(marker), 'The returned rich block did not contain the test marker.');
assert.equal(block.bindingState, 'confirmed_by_tool_call');
assert.equal(block.confirmedMessageId, output.id);
assert(output.richBlockIds?.includes(blockId));
report('agent-reported inventory of all 22 tool names and Rich reference mixed with ordinary text');

const { artifact } = await api(`${chatPath}/artifacts`, {
  relPath: `panel-${nonce}.pdf`, contentBase64: makeColorPdf(),
});
const query = new URLSearchParams({ targetMetadata: 'true', pageIndex: '0', rectPt: '[60,60,0,0]' });
const { target } = await api(`/api/files/${artifact.id}/range?${query}`);
assert(target?.pageContentHash && target.regionDigest);
const { request } = await api(`${chatPath}/edit-requests`, {
  targetKind: 'artifact', artifactId: artifact.id,
  selector: { kind: 'pdf_pin', baseRevision: artifact.revision, pageIndex: 0,
    expectedPageCount: target.pageCount, expectedPageContentHash: target.pageContentHash,
    expectedRegionDigest: target.regionDigest, xPt: 60, yPt: 60 },
  instruction: `Call edit_request_get for this request and artifact_render for PDF ${artifact.id}. Do not modify the file. Report the solid color of the cropped PIN image as CROP-COLOR=<color> and describe the full-page image colors.`,
});
const before = await api(chatPath);
const { requests } = await api(`${chatPath}/edit-requests/send-batch`, {
  requestIds: [request.id], clientMessageId: crypto.randomUUID(),
});
const registered = await api(chatPath);
const submitted = registered.messages.find(message => message.id === requests[0].sentMessageId);
assert(submitted?.runId && !before.messages.some(message => message.id === submitted.id));
const { output: images } = await waitForRun(submitted.runId);
assertImageOutput(assertToolCall(images, 'edit_request_get'));
assertImageOutput(assertToolCall(images, 'artifact_render'));
assert.match(images.contentText, /CROP-COLOR\s*=\s*(?:\*\*)?red/i);
assert.match(images.contentText, /blue/i);
report('real MCP page image and point-crop visual access');

if (AGY_REAL_TEST_EXTERNAL_TOOL && AGY_REAL_TEST_EXTERNAL_RESULT) {
  const { output: external } = await waitForRun(await send(
    `Call external tool ${AGY_REAL_TEST_EXTERNAL_TOOL} and built-in artifact_list in the same turn. Print the external tool result verbatim.`,
  ));
  assertToolCall(external, AGY_REAL_TEST_EXTERNAL_TOOL);
  assertToolCall(external, 'artifact_list');
  assert(external.contentText.includes(AGY_REAL_TEST_EXTERNAL_RESULT));
  report('external and built-in MCP tools coexist in one turn');
} else {
  pending('external MCP coexistence requires AGY_REAL_TEST_EXTERNAL_TOOL and AGY_REAL_TEST_EXTERNAL_RESULT');
}

const normalMarker = `NORMAL-${nonce}`;
const { output: normal } = await waitForRun(await send(`Give the exact reply ${normalMarker} without using any tools.`));
assert(normal.contentText.includes(normalMarker));
assert(!normal.richBlockIds?.length && !normal.toolCalls?.length);
report('ordinary ACP reply in an MCP-enabled session');

if (AGY_REAL_TEST_RESUME_STATE) {
  assert(state.chat.acpSessionId);
  await writeFile(AGY_REAL_TEST_RESUME_STATE, JSON.stringify({
    blockId, sessionId: state.chat.acpSessionId, messageId: output.id, chatId: AGY_REAL_TEST_CHAT_ID,
  }), { mode: 0o600 });
}
pending('session resume requires a real-server restart and AGY_REAL_TEST_RESUME_ONLY=1');
