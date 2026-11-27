import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DiffAdapter } from '../src/artifacts/adapters/diff-adapter.js';
import { MermaidAdapter } from '../src/artifacts/adapters/mermaid-adapter.js';
import { inspectArtifactTarget } from '../src/artifacts/target-inspection.js';
import { MAX_INSPECTION_INPUT_BYTES } from '../src/artifacts/target-inspection-limits.js';
import { createTestServer, seedAuthenticatedMockProfile, TestApiClient } from './helpers/test-harness.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

async function workspace() {
  const server = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
  cleanups.push(server.cleanup);
  const client = new TestApiClient(server.baseUrl);
  const { data: { user } } = await client.request<{ user: { id: string } }>('POST', '/api/auth/register', {
    username: 'regression', displayName: 'Regression', password: 'password123',
  });
  const userId = user.id;
  seedAuthenticatedMockProfile(server.ctx, userId);
  const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Regression tests' });
  return { ...server.ctx, client, userId, chatId: chat.id, dir: server.ctx.db.getChat(userId, chat.id)!.workspaceDir };
}

it('reconstructs sequential per-actor Undo and Redo while preserving disjoint CSV cells', async () => {
  const { artifactService: artifacts, db, client, userId, chatId, dir } = await workspace();
  const { artifact } = await artifacts.createArtifact({
    userId, chatId, scopeKind: 'chat', relPath: 'edit.csv', actorKind: 'user', actorId: userId,
    content: Buffer.from('a,b,c\n1,2,3\n'),
  });
  const api = '/api/files/' + artifact.id;
  const edit = (expectedRevision: number, col: number, value: number, actorKind: 'user' | 'ai') => artifacts.editArtifact({
    userId, artifactId: artifact.id, actorKind, actorId: actorKind === 'user' ? userId : 'agent',
    expectedRevision, operations: [{ op: 'set_cell', row: 1, col, value }],
  });
  const request = (direction: string, idempotencyKey = randomUUID()) =>
    client.request<{ artifact: { revision: number }; error?: string }>('POST', api + '/' + direction, { idempotencyKey });
  const row = () => fs.readFileSync(path.join(dir, 'edit.csv'), 'utf8').split('\n')[1];
  await edit(1, 0, 11, 'user');
  await edit(2, 1, 22, 'user');
  await edit(3, 2, 33, 'ai');
  const first = randomUUID();
  expect((await request('undo', first)).data.artifact.revision).toBe(5);
  expect(row()).toBe('11,2,33');
  expect((await request('undo', first)).data.artifact.revision).toBe(5);
  expect((await request('undo')).status).toBe(200);
  expect(row()).toBe('1,2,33');
  expect(artifacts.getUndoState(userId, artifact.id, 'user', userId)).toMatchObject({ undoable: false, redoable: true });
  expect((await request('redo')).status).toBe(200);
  expect(row()).toBe('11,2,33');
  expect((await request('redo')).status).toBe(200);
  expect(row()).toBe('11,22,33');
  await edit(8, 1, 77, 'ai');
  expect((await request('undo')).data.error).toBe('UNDO_SEMANTIC_CONFLICT');
  expect(row()).toBe('11,77,33');
  db.db.prepare('UPDATE artifact_revisions SET blob_available = 0 WHERE artifact_id = ? AND revision = 2').run(artifact.id);
  expect(artifacts.getUndoState(userId, artifact.id, 'user', userId)).toMatchObject({ undoable: false, reason: 'history_pruned' });
  expect((await request('undo')).data.error).toBe('UNDO_HISTORY_PRUNED');
});

it('persists abort before unlink and resumes stage cleanup without reclassifying the commit', async () => {
  const { artifactService: artifacts, db, userId, chatId } = await workspace();
  artifacts.commitFaultHook = stage => { if (stage === 'after_T2') throw Error('interrupt after stage'); };
  await expect(artifacts.createArtifact({
    userId, chatId, scopeKind: 'chat', relPath: 'abort.txt', actorKind: 'user',
    idempotencyKey: 'aborted-create', content: Buffer.from('stage'),
  })).rejects.toThrow('interrupt after stage');
  artifacts.commitFaultHook = undefined;
  const journal = () => db.db.prepare('SELECT * FROM artifact_commit_journal WHERE rel_path = ?').get('abort.txt')!;
  const stagePath = String(journal().private_stage_path);
  const unlink = fs.unlinkSync.bind(fs);
  const fault = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (file === stagePath) {
      expect(journal().state).toBe('aborted');
      expect(db.db.prepare('SELECT id FROM artifacts WHERE id = ?').get(journal().artifact_id)).toBeUndefined();
      expect(db.db.prepare('SELECT status FROM artifact_idempotency WHERE idempotency_key = ?').get('aborted-create')).toBeUndefined();
      throw Error('interrupt before unlink');
    }
    unlink(file);
  });
  await artifacts.recoverOnStartup();
  expect(journal().state).toBe('aborted');
  expect(fs.existsSync(stagePath)).toBe(true);
  fault.mockRestore();
  await artifacts.recoverOnStartup();
  await artifacts.recoverOnStartup();
  expect(journal()).toMatchObject({ state: 'aborted', audit_note: 'prepared_aborted_before_replace' });
  expect(fs.existsSync(stagePath)).toBe(false);
});

it.each(['changed', 'deleted'] as const)('retries external sync after T6 and deduplicates the %s-file event', async kind => {
  const { artifactService: artifacts, db, hub, userId, chatId, dir } = await workspace();
  const { artifact } = await artifacts.createArtifact({
    userId, chatId, scopeKind: 'chat', relPath: 'state.txt', actorKind: 'user', content: Buffer.from('initial'),
  });
  artifacts.commitFaultHook = stage => { if (stage === 'after_T5') throw Error('interrupt before T6'); };
  await expect(artifacts.replaceArtifactBytes({
    userId, artifactId: artifact.id, actorKind: 'user', actorId: userId, expectedRevision: artifact.revision,
    newBuffer: Buffer.from('committed'), operationType: 'replace', operationSummary: 'change',
  })).rejects.toThrow('interrupt before T6');
  artifacts.commitFaultHook = undefined;
  const file = path.join(dir, artifact.relPath);
  if (kind === 'changed') fs.writeFileSync(file, 'external');
  else fs.unlinkSync(file);
  const publish = hub.broadcastPersistedEvent.bind(hub);
  const journal = () => db.db.prepare('SELECT state FROM artifact_commit_journal WHERE artifact_id = ?').get(artifact.id);
  const revision = () => db.getArtifact(userId, artifact.id)!;
  const countExternal = () => db.db.prepare("SELECT COUNT(*) AS count FROM sync_events WHERE json_extract(payload_json,'$.reason') = 'external_sync'").get()!.count;
  const faultBeforeSync = vi.spyOn(hub, 'broadcastPersistedEvent').mockImplementation(() => { throw Error('interrupt at T6'); });
  await artifacts.recoverOnStartup();
  faultBeforeSync.mockRestore();
  expect(journal()?.state).toBe('db_committed');
  expect(revision().revision).toBe(2);
  expect(countExternal()).toBe(0);
  const faultAfterSync = vi.spyOn(hub, 'broadcastPersistedEvent').mockImplementation(event => {
    if (event.payload.reason === 'external_sync') throw Error('interrupt after durable external sync');
    publish(event);
  });
  await artifacts.recoverOnStartup();
  faultAfterSync.mockRestore();
  expect(journal()?.state).toBe('db_committed');
  await artifacts.recoverOnStartup();
  await artifacts.recoverOnStartup();
  expect(journal()).toBeUndefined();
  expect(countExternal()).toBe(1);
  expect(revision()).toMatchObject({ revision: kind === 'changed' ? 3 : 2, deletedOnDisk: kind === 'deleted' });
});

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

it('requires a matching hunk, file, context and occurrence for a Diff line target', () => {
  const hunk = '@@ -1,3 +1,3 @@\n before\n-old\n+new\n after';
  const source = ['--- a/one', '+++ b/one', hunk, '--- a/two', '+++ b/two', hunk].join('\n');
  const meta = { filename: 'two.diff', relPath: 'two.diff', mimeType: 'text/plain', previewKind: 'diff' as const };
  const selector = { kind: 'diff_line_range', filePath: 'two', hunkHeader: '@@ -1,3 +1,3 @@', startLine: 13, endLine: 13,
    expectedSnippetHash: hash('+new'), contextBeforeHash: hash(' before\n-old'),
    contextAfterHash: hash(' after'), occurrenceIndex: 1 };
  const adapter = new DiffAdapter();
  expect(adapter.resolveTarget(Buffer.from(source), selector, meta)).toMatchObject({ status: 'resolved', resolvedRange: { startLine: 13 } });
  for (const next of [{ filePath: 'one' }, { hunkHeader: '@@ -9,3 +9,3 @@' }, { occurrenceIndex: 0 }]) {
    expect(adapter.resolveTarget(Buffer.from(source), { ...selector, ...next }, meta).status).not.toBe('resolved');
  }
});

it('rejects a Mermaid source anchor whose occurrence no longer matches', () => {
  const source = Buffer.from('flowchart LR\n# old\nA --> B\n# changed\n# before\nA --> B\n# after');
  const selector = { kind: 'mermaid_source_range', startLine: 6, endLine: 6, expectedSnippetHash: hash('A --> B'),
    occurrenceIndex: 1, contextBeforeHash: hash('# changed\n# before'), contextAfterHash: hash('# after') };
  const meta = { filename: 'a.mmd', relPath: 'a.mmd', mimeType: 'text/plain', previewKind: 'mermaid' as const };
  const adapter = new MermaidAdapter();
  expect(adapter.resolveTarget(source, selector, meta).status).toBe('resolved');
  expect(adapter.resolveTarget(source, { ...selector, occurrenceIndex: 0 }, meta))
    .toMatchObject({ status: 'needs_review', reason: 'occurrence_index_changed' });
});

it('bounds target inspection for both revision snapshots and live files with an omitted cap', async () => {
  const { dir } = await workspace();
  const file = { filename: 'large.ts', relPath: 'large.ts', mimeType: 'text/plain', previewKind: 'code' as const };
  const full = path.join(dir, file.relPath);
  fs.writeFileSync(full, '');
  fs.truncateSync(full, MAX_INSPECTION_INPUT_BYTES + 1);
  const sha256 = '0'.repeat(64);
  await expect(inspectArtifactTarget({
    file, snapshot: { path: full, sizeBytes: MAX_INSPECTION_INPUT_BYTES + 1, sha256 }, range: { sourceTarget: true },
  })).rejects.toMatchObject({ statusCode: 413 });
  await expect(inspectArtifactTarget({
    file, rootDir: dir, expectedSha256: sha256, selector: { kind: 'code_line_range', baseRevision: 1 },
  })).resolves.toMatchObject({ status: 'needs_review', reason: 'target_content_unavailable' });
});
