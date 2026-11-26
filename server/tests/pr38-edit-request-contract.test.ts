import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EditRequestService, type AiEditRequestRecord } from '../src/edit-requests/edit-request-service.js';
import { canonicalJson } from '../src/artifacts/idempotency-coordinator.js';
import { FormatAdapterRegistry } from '../src/artifacts/adapters/registry.js';
import { targetSelectorSchema } from '../src/artifacts/target-selector-schema.js';
import { ResourceGovernor } from '../src/artifacts/resource-governor.js';
import { loadConfig } from '../src/config.js';
import { createTestServer, registerAndBindAgy, TestApiClient } from './helpers/test-harness.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMFAAAAAASUVORK5CYII=', 'base64');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

it('validates source pins through REST, rolls back reorder and state events, and reconfirms a fresh target for MCP', async () => {
  const srv = await createTestServer();
  cleanups.push(srv.cleanup);
  const { ctx } = srv;
  const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
  const { data: { chat: { id: chatId } } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Edit requests' });
  const base = `/api/chats/${chatId}/edit-requests`;
  const { artifact } = await ctx.artifactService.createArtifact({
    userId, chatId, scopeKind: 'chat', relPath: 'notes.ts',
    content: Buffer.from('old before\nold choice\nold after'), actorKind: 'user',
  });
  const selector = (revision: number, before: string, value: string, after: string) => ({
    kind: 'code_line_range', baseRevision: revision, startLine: 2, endLine: 2, occurrenceIndex: 0,
    expectedSnippetHash: hash(value), contextBeforeHash: hash(before), contextAfterHash: hash(after),
  });
  const original = selector(1, 'old before', 'old choice', 'old after');
  const input = {
    targetKind: 'artifact', artifactId: artifact.id, selector: original,
    contentCoords: { x: 20 }, regionImagePngBase64: png.toString('base64'), instruction: 'Update choice',
  };
  const post = (body: unknown) => client.request<{ request: AiEditRequestRecord }>('POST', base, body);
  expect((await post({ ...input, selector: { ...original, expectedSnippetHash: undefined } })).status).toBe(400);
  expect((await post({ ...input, selector: { ...original, baseRevision: 2 } })).status).toBe(409);
  expect((await post({ ...input, selector: { ...original, expectedSnippetHash: hash('wrong') } })).status).toBe(409);
  const created = await post(input);
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  const first = created.data.request;
  const second = (await post({ ...input, instruction: 'Second' })).data.request;
  expect(first.selectedContentSnapshot).toBe('old choice');
  expect(first.regionImageBlobSha256).toBeTruthy();
  expect(() => ctx.editRequestService.resolveByUser(userId, chatId, first.id)).toThrow();
  expect(() => ctx.editRequestService.markAppliedByAgent({ userId, chatId, requestId: first.id, appliedRevision: 1 }))
    .toThrow(expect.objectContaining({ code: 'EDIT_REQUEST_NOT_SENT' }));

  const insert = ctx.db.insertSyncEventInTx.bind(ctx.db);
  const latest = ctx.db.getLatestUserSyncSeq(userId);
  const fault = vi.spyOn(ctx.db, 'insertSyncEventInTx').mockImplementation(event => {
    const envelope = insert(event);
    if (event.type === 'edit_request.reordered') throw new Error('event insert fault');
    return envelope;
  });
  expect(() => ctx.editRequestService.reorderDrafts(userId, chatId, [second.id, first.id])).toThrow('event insert fault');
  expect(ctx.db.getLatestUserSyncSeq(userId)).toBe(latest);
  expect(ctx.editRequestService.listRequests(userId, chatId).map(r => r.id)).toEqual([first.id, second.id]);
  fault.mockRestore();
  const otherDevice = new TestApiClient(srv.baseUrl);
  expect((await otherDevice.request('POST', '/api/auth/login', { username: 'alice', password: 'password123' })).status).toBe(200);
  await client.connectWs({ clientId: 'order-origin' });
  await otherDevice.connectWs({ clientId: 'order-listener' });
  expect((await client.request('POST', base + '/reorder', { orderedIds: [second.id, first.id] })).status).toBe(200);
  await otherDevice.waitForFrame(frame => frame.kind === 'event' && (frame.event as { type?: string })?.type === 'edit_request.reordered');
  const listed = (await otherDevice.request<{ requests: AiEditRequestRecord[] }>('GET', base)).data.requests;
  expect(listed.map(r => [r.id, r.createdAt])).toEqual([[second.id, second.createdAt], [first.id, first.createdAt]]);

  const submit = () => client.request('POST', base + '/send-batch', { requestIds: [first.id] });
  expect((await submit()).status).toBe(200);
  const failedEvent = vi.fn();
  const revalidationFault = vi.spyOn(ctx.db, 'insertSyncEventInTx').mockImplementation(event => {
    const envelope = insert(event);
    if (event.type === 'edit_request.updated' &&
        (event.payload.editRequest as AiEditRequestRecord).id === first.id) {
      failedEvent();
      throw Error('revalidation event insert fault');
    }
    return envelope;
  });
  await ctx.artifactService.replaceArtifactBytes({
    userId, artifactId: artifact.id, expectedRevision: 1, actorKind: 'user', actorId: userId,
    newBuffer: Buffer.from('new before\nnew choice\nnew after'), operationType: 'replace', operationSummary: 'changed',
  });
  await expect.poll(() => failedEvent.mock.calls.length, { timeout: 12_000 }).toBe(1);
  expect(ctx.editRequestService.getRequest(userId, chatId, first.id)?.status).toBe('sent');
  revalidationFault.mockRestore();
  await ctx.editRequestService.revalidateForArtifact(userId, artifact.id, 2);
  expect(ctx.editRequestService.getRequest(userId, chatId, first.id)?.status).toBe('needs_review');
  expect((await submit()).status).toBe(409);
  const reconfirm = (newBaseRevision: number, newSelector: Record<string, unknown>) =>
    client.request<{ request: AiEditRequestRecord }>('POST', `${base}/${first.id}/reconfirm`, { newBaseRevision, newSelector });
  expect((await reconfirm(1, original)).status).toBe(409);
  const next = selector(2, 'new before', 'new choice', 'new after');
  expect((await reconfirm(2, { ...next, contextAfterHash: undefined })).status).toBe(400);
  const fresh = (await reconfirm(2, next)).data.request;
  expect(fresh).toMatchObject({
    baseRevision: 2, selector: next, status: 'draft', selectedContentSnapshot: 'new choice',
    surroundingContext: 'new before\n---\nnew after', range: { startLine: 2, endLine: 2 },
    contentCoords: null, regionImageBlobSha256: null, batchId: null,
  });
  await expect(ctx.editRequestService.getForAgent(userId, chatId, first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await submit()).status).toBe(200);
  const binding = await ctx.mcpService.bindBuiltinArtifactServer({ userId, chatId, tentativeTurn: () => null }, []);
  const { url, headers } = binding!.server;
  const mcp = new Client({ name: 'pin-contract-test', version: '1' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: Object.fromEntries(headers.map(({name,value}) => [name,value])) },
  }));
  try {
    const result = await mcp.callTool({ name: 'edit_request_get', arguments: { requestId: first.id } });
    const content = result.content as { type: string; text: string }[];
    expect(content.map(piece => piece.type)).toEqual(['text']);
    expect(JSON.parse(content[0].text)).toMatchObject({
      status: 'sent', untrustedTargetContent: { selectedContentSnapshot: 'new choice' }, reResolution: { status: 'resolved' },
    });
    const applied = await mcp.callTool({ name: 'edit_request_mark_applied', arguments: { requestId: first.id, appliedRevision: 2 } });
    expect(applied.isError).not.toBe(true);
    expect(ctx.editRequestService.getRequest(userId, chatId, first.id)?.status).toBe('applied_unverified');
  } finally {
    await mcp.close();
  }
  expect(ctx.editRequestService.resolveByUser(userId, chatId, first.id).status).toBe('resolved');
  client.closeWs();
  otherDevice.closeWs();
}, 50_000);

it('rolls back RichBlock revalidation with its event and migrates a legacy invalid selector safely', async () => {
  const srv = await createTestServer();
  cleanups.push(srv.cleanup);
  const { ctx } = srv;
  const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
  const { data: { chat: { id: chatId } } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Rich request' });
  const before = { id: 'r', type: 'text' as const, content: 'old' };
  const document = { schemaVersion: 1 as const, root: before };
  const { block } = ctx.richContentService.createBlock({ userId, chatId, document });
  const input = { userId, chatId, richBlockId: block.id, targetKind: 'rich_block' as const, instruction: 'change' };
  const selector = { kind: 'rich_node', baseRevision: 1, blockId: block.id, nodeId: 'r', expectedNodeType: 'text', expectedNodeFingerprint: hash(canonicalJson(before)) };
  const request = await ctx.editRequestService.createRequest({ ...input, selector });
  const legacy = await ctx.editRequestService.createRequest({ ...input, selector });
  ctx.db.db.prepare("UPDATE ai_edit_requests SET selector_json = json_remove(selector_json, '$.expectedNodeFingerprint') WHERE id = ?").run(legacy.id);
  new EditRequestService(ctx.db, ctx.hub, ctx.artifactService, ctx.richContentService);
  expect(ctx.editRequestService.getRequest(userId, chatId, legacy.id)?.status).toBe('needs_review');

  const insert = ctx.db.insertSyncEventInTx.bind(ctx.db);
  const latest = ctx.db.getLatestUserSyncSeq(userId);
  const fault = vi.spyOn(ctx.db, 'insertSyncEventInTx').mockImplementation(event => {
    const envelope = insert(event);
    if (event.type === 'edit_request.updated') throw Error('event insert fault');
    return envelope;
  });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const patch = { ...before, content: 'new' };
  ctx.richContentService.updateBlock({ userId, chatId, blockId: block.id, expectedRevision: 1, document: { ...document, root: patch } });
  expect(logged).toHaveBeenCalled();
  expect(ctx.editRequestService.getRequest(userId, chatId, request.id)?.status).toBe('draft');
  expect(ctx.db.getLatestUserSyncSeq(userId)).toBe(latest + 1); // Only the RichBlock update committed.
  fault.mockRestore();
  expect(ctx.editRequestService.revalidateForRichBlock(userId, chatId, block.id)).toEqual([
    expect.objectContaining({ id: request.id, status: 'needs_review' }),
  ]);
  expect(ctx.db.getLatestUserSyncSeq(userId)).toBe(latest + 2);
}, 15_000);

it('rechecks memory after a queued heavy worker gets its slot and releases the slot on 503', async () => {
  let available = 800;
  const governor = new ResourceGovernor({ ...loadConfig(), docWorkerBudget: 2, minMemAvailableMb: 400 }, () => available);
  let finish!: () => void;
  const first = governor.runWithBudget('libreoffice', () => new Promise<void>(resolve => { finish = resolve; }));
  await expect.poll(() => Boolean(finish)).toBe(true);
  const start = vi.fn(async () => 'started');
  const waiting = governor.runWithBudget('chromium', start);
  expect(start).not.toHaveBeenCalled();
  await Promise.resolve();
  available = 399;
  finish();
  await first;
  await expect(waiting).rejects.toMatchObject({ code: 'RESOURCE_BUSY', statusCode: 503 });
  expect(start).not.toHaveBeenCalled();
  expect(governor.getUsedWeight()).toBe(0);
  available = 400;
  await expect(governor.runWithBudget('chromium', start)).resolves.toBe('started');
});


it('requires the exact selector fields and refuses a whole-file digest as proof of an Office subtarget', () => {
  const body = 'OOXML content';
  const meta = { filename: 'a.docx', relPath: 'a.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', previewKind: 'docx' as const };
  const selector = { kind: 'docx_table_cell', baseRevision: 1, tableId: 't', row: 0, col: 0, expectedCellHash: hash(body), expectedTableFingerprint: hash('table') };
  expect(targetSelectorSchema.safeParse(selector).success).toBe(true);
  expect(targetSelectorSchema.safeParse({ ...selector, expectedTableFingerprint: undefined }).success).toBe(false);
  expect(new FormatAdapterRegistry().resolve(meta.filename, meta.previewKind).resolveTarget(Buffer.from(body), selector, meta).status).toBe('needs_review');
  expect(targetSelectorSchema.safeParse({
    kind: 'code_char_range', baseRevision: 1, startLine: 1, endLine: 2, startCol: 10, endCol: 3,
    expectedSnippetHash: hash('snippet'), contextBeforeHash: hash('before'), contextAfterHash: hash('after'), occurrenceIndex: 0,
  }).success).toBe(true);
});
