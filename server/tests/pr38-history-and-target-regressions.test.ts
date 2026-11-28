import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DiffAdapter } from '../src/artifacts/adapters/diff-adapter.js';
import { MermaidAdapter } from '../src/artifacts/adapters/mermaid-adapter.js';
import { inspectArtifactTarget } from '../src/artifacts/target-inspection.js';
import { computeTargetInspectionBudget } from '../src/artifacts/resource-governor.js';
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

it('allows target inspection of >32 MiB files when host memory is sufficient and fails safely on low memory', async () => {
  const { dir } = await workspace();
  const file = { filename: 'large.ts', relPath: 'large.ts', mimeType: 'text/plain', previewKind: 'code' as const };
  const full = path.join(dir, file.relPath);
  const line = 'const value = 42; // padding line for >32MiB inspection test\n';
  const targetSize = 33 * 1024 * 1024;
  const repeats = Math.ceil(targetSize / Buffer.byteLength(line));
  const payload = Buffer.from(line.repeat(repeats), 'utf8');
  fs.writeFileSync(full, payload);
  const sha256 = createHash('sha256').update(payload).digest('hex');

  const inspected = await inspectArtifactTarget<{ startLine: number; endLine: number; expectedSnippetHash: string }>({
    file: { ...file, sizeBytes: payload.length },
    snapshot: { path: full, sizeBytes: payload.length, sha256 },
    range: { sourceTarget: true, startLine: 1, endLine: 2 },
  });
  expect(inspected.startLine).toBe(1);
  expect(inspected.endLine).toBe(2);
  expect(inspected.expectedSnippetHash).toMatch(/^[0-9a-f]{64}$/);

  expect(() => computeTargetInspectionBudget({
    inputBytes: 33 * 1024 * 1024,
    isDocumentOrMedia: true,
    memAvailableMb: 200,
  })).toThrow(/メモリが不足/);
  expect(computeTargetInspectionBudget({
    inputBytes: 40 * 1024 * 1024,
    isDocumentOrMedia: true,
    memAvailableMb: 10_000,
  })).toMatchObject({ timeoutMs: 60_000 });
});

it('blocks concurrent resends from a different boot until a deferred commit can recover', async () => {
  const { artifactService: artifacts, db, userId, chatId } = await workspace();
  const input = {
    userId, chatId, scopeKind: 'chat' as const, relPath: 'deferred.txt', actorKind: 'user' as const,
    idempotencyKey: 'deferred', content: Buffer.from('once'),
  };
  artifacts.commitFaultHook = stage => { if (stage === 'after_T5') throw Error('restart before T6'); };
  await expect(artifacts.createArtifact(input)).rejects.toThrow('restart before T6');
  artifacts.commitFaultHook = undefined;
  db.db.prepare("UPDATE artifact_idempotency SET server_boot_id = 'previous-boot' WHERE idempotency_key = ?").run(input.idempotencyKey);
  db.db.exec(`CREATE TRIGGER fail_t6 BEFORE INSERT ON artifact_revisions
    BEGIN SELECT RAISE(ABORT, 'simulated DB failure'); END;`);
  await artifacts.recoverOnStartup();
  expect(artifacts.idempotency.recoverStaleIdempotency()).toBe(0);
  await Promise.all([0, 1].map(async () => {
    await expect(artifacts.createArtifact(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
  }));
  db.db.exec('DROP TRIGGER fail_t6');
  await artifacts.recoverOnStartup();
  const [{ artifact }, replay] = await Promise.all([artifacts.createArtifact(input), artifacts.createArtifact(input)]);
  expect(replay.artifact.id).toBe(artifact.id);
  expect(artifacts.listHistory(userId, artifact.id)).toHaveLength(1);
});

it('checks live session authorization and artifact lifecycle before replaying a creation', async () => {
  const { artifactService: artifacts, db, userId, chatId } = await workspace();
  let authorized = true;
  const input = {
    userId, chatId, scopeKind: 'chat' as const, relPath: 'replay.txt', actorKind: 'user' as const,
    idempotencyKey: 'replay', content: Buffer.from('secret'),
    assertAuthorized: () => { if (!authorized) throw new Error('session expired'); },
  };
  const { artifact } = await artifacts.createArtifact(input);
  authorized = false;
  await expect(artifacts.createArtifact(input)).rejects.toThrow('session expired');
  authorized = true;
  db.db.prepare("UPDATE artifacts SET lifecycle_state = 'deleted' WHERE id = ?").run(artifact.id);
  await expect(artifacts.createArtifact(input)).rejects.toMatchObject({ statusCode: 404 });
});

it('shares project provenance across T6 recovery, metadata-only synchronization and project deletion', async () => {
  const { artifactService: artifacts, db, client, userId, chatId } = await workspace();
  const { data: { project } } = await client.request<{ project: { id: string } }>('POST', '/api/projects', { name: 'Provenance' });
  const { artifact: original } = await artifacts.uploadProjectFile({
    userId, projectId: project.id, filename: 'sync.txt', buffer: Buffer.from('original'),
  });
  const { artifact: copy } = await artifacts.createProjectWorkingCopyInChat({
    userId, projectId: project.id, projectArtifactId: original.id, chatId,
  });
  const replace = (artifactId: string, expectedRevision: number, content: string) => artifacts.replaceArtifactBytes({
    userId, artifactId, expectedRevision, newBuffer: Buffer.from(content),
    actorKind: 'user', actorId: userId, operationType: 'replace', operationSummary: 'Replace',
  });
  await replace(copy.id, 1, 'edited');
  const reflect = () => artifacts.reflectWorkingCopyToProject({
    userId, workingCopyArtifactId: copy.id, actorKind: 'user',
  });
  artifacts.commitFaultHook = stage => { if (stage === 'after_T5') throw Error('restart after rename'); };
  await expect(reflect()).rejects.toThrow('restart after rename');
  artifacts.commitFaultHook = undefined;
  await artifacts.recoverOnStartup();
  expect(db.getArtifact(userId, original.id)).toMatchObject({ revision: 2 });
  expect(db.getArtifact(userId, copy.id)).toMatchObject({ revision: 2, sourceBaseRevision: 2 });

  await replace(original.id, 2, 'different');
  await replace(original.id, 3, 'edited');
  await expect(artifacts.syncProjectFilesToChat({ userId, chatId, projectId: project.id })).resolves.toEqual(['.project-context/sync.txt']);
  expect(db.getArtifact(userId, copy.id)).toMatchObject({ revision: 2, sourceBaseRevision: 4 });

  expect((await client.request('DELETE', '/api/projects/' + project.id)).status).toBeLessThan(300);
  expect(db.getArtifact(userId, copy.id)).toMatchObject({ sourceArtifactId: original.id, sourceBaseRevision: 4 });
  await expect(reflect()).rejects.toMatchObject({ statusCode: 409, code: 'ARTIFACT_CONFLICT' });
});

it.each([false, true])('rechecks project sync authorization at T3 (existing copy: %s)', async existing => {
  const { artifactService: artifacts, db, client, userId, chatId } = await workspace();
  const { data: { project } } = await client.request<{ project: { id: string } }>('POST', '/api/projects', { name: 'Sync auth' });
  const upload = (text: string) => artifacts.uploadProjectFile({
    userId, projectId: project.id, filename: 'sync.txt', buffer: Buffer.from(text),
  });
  if (existing) {
    await upload('previous');
    await artifacts.syncProjectFilesToChat({ userId, chatId, projectId: project.id });
  }
  await upload('new');
  let authorized = true;
  artifacts.commitFaultHook = stage => { if (stage === 'before_T3') authorized = false; };
  await expect(artifacts.syncProjectFilesToChat({
    userId, chatId, projectId: project.id,
    assertAuthorized: () => { if (!authorized) throw new Error('session expired'); },
  })).rejects.toThrow('session expired');
  artifacts.commitFaultHook = undefined;
  await artifacts.recoverOnStartup();
  expect(db.findArtifactByRelPath(userId, chatId, '.project-context/sync.txt')?.revision).toBe(existing ? 1 : undefined);
});

it.each(['csv', 'tsv'])('checks the original record outside a selected %s value before allowing re-resolution', async extension => {
  const { artifactService: artifacts, userId, chatId } = await workspace();
  const delimiter = extension === 'tsv' ? '\t' : ',';
  const bytes = (...rows: string[][]) => Buffer.from(rows.map(row => row.join(delimiter)).join('\n') + '\n');
  const { artifact } = await artifacts.createArtifact({
    userId, chatId, scopeKind: 'chat', relPath: 'sales.' + extension, actorKind: 'user',
    content: bytes(['Name', 'Amount'], ['Alice', '10'], ['Bob', '10']),
  });
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const selector = {
    kind: 'csv_range', baseRevision: 1, startRow: 1, endRow: 1, startCol: 1, endCol: 1,
    expectedRowCount: 3, expectedColCount: 2,
    expectedRangeValuesHash: hash([['10']]), expectedHeaderHash: hash(['Name', 'Amount']),
  };
  const replace = (expectedRevision: number, newBuffer: Buffer) => artifacts.replaceArtifactBytes({
    userId, artifactId: artifact.id, expectedRevision, newBuffer, operationType: 'test',
    actorKind: 'user', actorId: userId, operationSummary: 'Replace rows',
  });
  await replace(1, bytes(['Name', 'Amount'], ['Alice', '10'], ['Carol', '10']));
  expect(await artifacts.resolveTargetOnArtifact(userId, artifact.id, selector)).toMatchObject({ status: 'resolved' });
  await replace(2, bytes(['Name', 'Amount'], ['Bob', '10'], ['Alice', '10']));
  expect(await artifacts.resolveTargetOnArtifact(userId, artifact.id, selector)).toMatchObject({ status: 'needs_review' });
});

it('captures CRLF character selections with UTF-16 columns and refuses half of a surrogate pair', async () => {
  const { artifactService: artifacts, userId, chatId } = await workspace();
  const { artifact } = await artifacts.createArtifact({
    userId, chatId, scopeKind: 'chat', relPath: 'bounds.ts', actorKind: 'user',
    content: Buffer.from('before\r\nx😀日本\r\n右左\r\nafter'),
  });
  const bounds = { startLine: 2, startCol: 2, endLine: 3, endCol: 2 };
  const result = await artifacts.readRange(userId, artifact.id, { ...bounds, targetHashes: true });
  expect(result.text).toBe('😀日本\n右');
  const selector = {
    kind: 'code_char_range', baseRevision: 1, ...bounds, occurrenceIndex: result.occurrenceIndex,
    expectedSnippetHash: result.expectedSnippetHash, contextBeforeHash: result.contextBeforeHash, contextAfterHash: result.contextAfterHash,
  };
  expect(await artifacts.resolveTargetOnArtifact(userId, artifact.id, selector)).toMatchObject({
    status: 'resolved', resolvedSnippet: '😀日本\n右', resolvedRange: bounds,
  });
  await expect(artifacts.readRange(userId, artifact.id, { ...bounds, startCol: 3, targetHashes: true })).rejects.toMatchObject({ statusCode: 400 });
});

it('reports added, removed and changed dependency paths for a single revision restore', async () => {
  const { artifactService: artifacts, userId, chatId } = await workspace();
  const create = (relPath: string, content: string) => artifacts.createArtifact({
    userId, chatId, scopeKind: 'chat', relPath, actorKind: 'user', content: Buffer.from(content),
  });
  await create('before.css', 'body {color: red}');
  await create('after.css', 'body {color: blue}');
  const { artifact: shared } = await create('shared.css', 'p {color: red}');
  const { artifact: page } = await create('index.html', '<link rel="stylesheet" href="before.css"><link rel="stylesheet" href="shared.css">');
  await artifacts.replaceArtifactBytes({ userId, artifactId: shared.id, expectedRevision: 1,
    newBuffer: Buffer.from('p {color: blue}'), actorKind: 'user', actorId: userId,
    operationType: 'replace', operationSummary: 'Update shared stylesheet',
  });
  const current = artifacts.listHistory(userId, page.id)[0].revision;
  await artifacts.replaceArtifactBytes({ userId, artifactId: page.id, expectedRevision: current,
    newBuffer: Buffer.from('<link rel="stylesheet" href="after.css"><link rel="stylesheet" href="shared.css">'),
    actorKind: 'user', actorId: userId, operationType: 'replace', operationSummary: 'Change stylesheet',
  });
  const restored = await artifacts.restoreRevision({ userId, artifactId: page.id, targetRevision: 1, actorKind: 'user' });
  expect(restored.dependencyDiff).toEqual([
    { relPath: 'after.css', currentSha256: expect.any(String), targetSha256: null },
    { relPath: 'before.css', currentSha256: null, targetSha256: expect.any(String) },
    { relPath: 'shared.css', currentSha256: expect.any(String), targetSha256: expect.any(String) },
  ]);
  expect(restored.dependencyDiff[2].currentSha256).not.toBe(restored.dependencyDiff[2].targetSha256);
});
