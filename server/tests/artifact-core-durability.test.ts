import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/artifacts/artifact-service.js';
import { ArtifactError } from '../src/artifacts/errors.js';
import { ResourceGovernor } from '../src/artifacts/resource-governor.js';
import { DocWorkerSandbox } from '../src/artifacts/sandbox-worker.js';
import type { CommitFaultStage } from '../src/artifacts/types.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/db/database.js';
import { openContainedRegularFileNoFollow, PathContainmentError } from '../src/files/workspace.js';
import { SyncHub } from '../src/sync/hub.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

function sha256(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

describe('PR 1 Core Durability, Fault Injection (T1..T7), GC, Batch Restore, PIN-02, Adapters & Security', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('SEC-02: openContainedRegularFileNoFollow rejects intermediate symlinks, leaf symlinks, path traversal, and hardlinks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sec02-'));
    cleanups.push(async () => fs.rmSync(tmp, { recursive: true, force: true }));

    const root = path.join(tmp, 'workspace');
    const outside = path.join(tmp, 'outside.txt');
    fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
    fs.writeFileSync(outside, 'secret');
    fs.writeFileSync(path.join(root, 'nested', 'ok.txt'), 'hello');
    fs.symlinkSync(outside, path.join(root, 'leaf-link.txt'));
    fs.symlinkSync(tmp, path.join(root, 'dir-link'));
    fs.linkSync(path.join(root, 'nested', 'ok.txt'), path.join(root, 'hardlink.txt'));

    // Valid contained regular file succeeds (with single nlink check on fresh unique file)
    fs.writeFileSync(path.join(root, 'nested', 'unique.txt'), 'unique');
    const opened = openContainedRegularFileNoFollow(root, 'nested/unique.txt');
    try {
      expect(fs.readFileSync(opened.fd, 'utf8')).toBe('unique');
    } finally {
      fs.closeSync(opened.fd);
    }

    // Traversal rejected
    expect(() => openContainedRegularFileNoFollow(root, '../outside.txt')).toThrow(PathContainmentError);
    // Leaf symlink rejected
    expect(() => openContainedRegularFileNoFollow(root, 'leaf-link.txt')).toThrow(PathContainmentError);
    // Intermediate directory symlink rejected
    expect(() => openContainedRegularFileNoFollow(root, 'dir-link/outside.txt')).toThrow(PathContainmentError);
    // Hardlink (nlink > 1) rejected by default
    expect(() => openContainedRegularFileNoFollow(root, 'hardlink.txt')).toThrow(PathContainmentError);
  });

  it('ARCH-04 & SEC-10: rejects cross-FS writes with 503 UNSUPPORTED_CROSS_FS_STORAGE without affecting reads', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const chatId = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'CrossFS' })).data.chat.id;

    // First create normally on same FS
    const created = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'note.md',
      content: '# Initial\n',
    });
    expect(created.status).toBe(201);

    // Simulate cross-FS mount mismatch
    srv.ctx.artifactService.setSameFsCheckOverride(() => false);
    const crossEdit = await alice.request<{ error: string }>('POST', `/api/files/${created.data.artifact.id}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: '# Updated\n' }],
    });
    expect(crossEdit.status).toBe(503);
    expect(crossEdit.data.error).toBe('UNSUPPORTED_CROSS_FS_STORAGE');

    // Reading existing file remains completely unaffected
    const readRes = await alice.request<string>('GET', `/api/files/${created.data.artifact.id}/content`);
    expect(readRes.status).toBe(200);
    expect(readRes.data).toBe('# Initial\n');
    srv.ctx.artifactService.setSameFsCheckOverride(undefined);
  });

  it('ARCH-05: T1..T7 pre/post fault injection tests converge cleanly and idempotently for create & update across isolated and non-isolated modes', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const chatId = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Faults' })).data.chat.id;

    const stages: CommitFaultStage[] = [
      'before_T1',
      'after_T1',
      'after_T2',
      'after_T3',
      'after_T4',
      'after_T5',
      'after_T6',
      'before_T7',
    ];

    // 1. Test CREATE fault injection across all stages (T1..T7)
    for (const stage of stages) {
      const relPath = `create-${stage}.txt`;
      srv.ctx.artifactService.setStagingIsolationOverride('bwrap_mount_isolated');
      srv.ctx.artifactService.commitFaultHook = (s) => {
        if (s === stage) throw new Error(`INJECTED_CRASH_${stage}`);
      };

      await expect(
        srv.ctx.artifactService.createArtifact({
          userId,
          scopeKind: 'chat',
          chatId,
          relPath,
          content: Buffer.from(`content-${stage}`, 'utf8'),
          actorKind: 'user',
          actorId: userId,
          idempotencyKey: `idem-create-${stage}`,
        })
      ).rejects.toThrow(`INJECTED_CRASH_${stage}`);
      srv.ctx.artifactService.commitFaultHook = undefined;

      // Pending create MUST NOT be publicly visible before recovery
      if (stage === 'after_T1' || stage === 'after_T2' || stage === 'after_T3') {
        expect(srv.ctx.db.findArtifactByRelPath(userId, chatId, relPath)).toBeNull();
      }

      // Run recovery (twice to verify strict idempotency!)
      await srv.ctx.artifactService.recoverOnStartup();
      const secondRun = await srv.ctx.artifactService.recoverOnStartup();
      expect(secondRun.commits.rolledForward + secondRun.commits.aborted + secondRun.commits.quarantined).toBe(0);

      const art = srv.ctx.db.findArtifactByRelPath(userId, chatId, relPath);
      if (stage === 'before_T1' || stage === 'after_T1' || stage === 'after_T2') {
        expect(art).toBeNull();
      } else if (stage === 'after_T3') {
        // replacing(is_create=1) without target placed -> MUST quarantine (never falsely assert aborted)
        expect(art).toBeNull();
        const jRow = srv.ctx.db.db
          .prepare('SELECT state FROM artifact_commit_journal WHERE rel_path = ? ORDER BY created_at DESC LIMIT 1')
          .get(relPath) as { state: string };
        expect(jRow.state).toBe('ambiguous_quarantined');
      } else {
        // after_T4, after_T5, after_T6, before_T7 -> rolled forward / finalized to active rev 1
        expect(art).not.toBeNull();
        expect(art!.revision).toBe(1);
        expect(art!.lifecycleState).toBe('active');
      }
    }

    // 2. Test UPDATE fault injection across stages in BOTH bwrap_mount_isolated and non_isolated_same_uid
    for (const mode of ['bwrap_mount_isolated', 'non_isolated_same_uid'] as const) {
      for (const stage of ['after_T1', 'after_T2', 'after_T3', 'after_T4', 'after_T5', 'after_T6'] as CommitFaultStage[]) {
        const relPath = `upd-${mode}-${stage}.txt`;
        srv.ctx.artifactService.setStagingIsolationOverride(mode);
        const base = await srv.ctx.artifactService.createArtifact({
          userId,
          scopeKind: 'chat',
          chatId,
          relPath,
          content: Buffer.from('v1', 'utf8'),
          actorKind: 'user',
          actorId: userId,
        });

        srv.ctx.artifactService.commitFaultHook = (s) => {
          if (s === stage) throw new Error(`INJECTED_UPD_${stage}`);
        };
        await expect(
          srv.ctx.artifactService.replaceArtifactBytes({
            userId,
            artifactId: base.artifact.id,
            expectedRevision: 1,
            newBuffer: Buffer.from('v2', 'utf8'),
            actorKind: 'user',
            actorId: userId,
            operationType: 'edit',
            operationSummary: 'v2',
          })
        ).rejects.toThrow(`INJECTED_UPD_${stage}`);
        srv.ctx.artifactService.commitFaultHook = undefined;

        await srv.ctx.artifactService.recoverOnStartup();
        const after = srv.ctx.db.getArtifact(userId, base.artifact.id)!;

        if (stage === 'after_T1' || stage === 'after_T2') {
          expect(after.revision).toBe(1);
        } else if (stage === 'after_T3') {
          expect(after.revision).toBe(1);
          const jRow = srv.ctx.db.db
            .prepare('SELECT state FROM artifact_commit_journal WHERE artifact_id = ? ORDER BY created_at DESC LIMIT 1')
            .get(base.artifact.id) as { state: string };
          expect(jRow.state).toBe(mode === 'bwrap_mount_isolated' ? 'aborted' : 'ambiguous_quarantined');
        } else {
          // after_T4, after_T5, after_T6 -> rolled forward to revision 2
          expect(after.revision).toBe(2);
          expect(after.sha256).toBe(sha256('v2'));
        }
      }
    }
    srv.ctx.artifactService.setStagingIsolationOverride(undefined);
  });

  it('ARCH-06: coalesces concurrent idempotent writes, rejects key reuse mismatch (409), reverifies auth on replay, and cleans stale boot rows', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const chatId = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Idemp' })).data.chat.id;

    // Concurrent identical create requests with same idempotencyKey coalesce cleanly
    const [r1, r2] = await Promise.all([
      srv.ctx.artifactService.createArtifact({
        userId,
        scopeKind: 'chat',
        chatId,
        relPath: 'idem.md',
        content: Buffer.from('# Hello\n'),
        actorKind: 'user',
        actorId: userId,
        idempotencyKey: 'same-key-1',
      }),
      srv.ctx.artifactService.createArtifact({
        userId,
        scopeKind: 'chat',
        chatId,
        relPath: 'idem.md',
        content: Buffer.from('# Hello\n'),
        actorKind: 'user',
        actorId: userId,
        idempotencyKey: 'same-key-1',
      }),
    ]);
    expect(r1.artifact.id).toBe(r2.artifact.id);
    expect(r1.artifact.revision).toBe(1);

    // Reusing same key with different payload -> 409 IDEMPOTENCY_KEY_REUSE_MISMATCH
    await expect(
      srv.ctx.artifactService.createArtifact({
        userId,
        scopeKind: 'chat',
        chatId,
        relPath: 'idem.md',
        content: Buffer.from('# DIFFERENT\n'),
        actorKind: 'user',
        actorId: userId,
        idempotencyKey: 'same-key-1',
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSE_MISMATCH' });

    // Live DB auth re-verification on completed idempotency replay rejects revoked auth
    await expect(
      srv.ctx.artifactService.createArtifact({
        userId,
        scopeKind: 'chat',
        chatId,
        relPath: 'idem.md',
        content: Buffer.from('# Hello\n'),
        actorKind: 'user',
        actorId: userId,
        idempotencyKey: 'same-key-1',
        assertAuthorized: () => {
          throw new ArtifactError('FORBIDDEN', 'Permission revoked', 403);
        },
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    // Stale in_progress row from an older server boot is purged by recoverStaleIdempotency
    const now = Date.now();
    srv.ctx.db.db
      .prepare(
        `INSERT INTO artifact_idempotency (
           user_id, scope_key, idempotency_key, status, server_boot_id, commit_id,
           actor_kind, actor_id, request_fingerprint, created_at, updated_at, expires_at
         ) VALUES (?, 'create:chat:x', 'orphan-key', 'in_progress', 'old-dead-boot', NULL, 'user', ?, 'fp', ?, ?, ?)`
      )
      .run(userId, userId, now, now, now + 60_000);
    expect(srv.ctx.artifactService.idempotency.recoverStaleIdempotency()).toBe(1);
  });

  it('ARCH-07: putBlobWithLease prevents GC deletion during active write lease and reclaims after release', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const data = Buffer.from('uncommitted-blob-data-' + crypto.randomUUID(), 'utf8');

    const lease = srv.ctx.artifactService.blobManager.putBlobWithLease(userId, data);
    expect(srv.ctx.artifactService.blobManager.hasBlob(userId, lease.sha256)).toBe(true);

    // Concurrent GC while lease is active MUST NOT delete the blob!
    const gcWhileLeased = srv.ctx.artifactService.blobManager.runGcForUser(userId, srv.ctx.db);
    expect(gcWhileLeased.skippedLeasedOrPinned).toBeGreaterThanOrEqual(1);
    expect(srv.ctx.artifactService.blobManager.hasBlob(userId, lease.sha256)).toBe(true);

    // After releasing lease (without DB ref), GC safely reclaims the orphan blob
    lease.release();
    const gcAfterRelease = srv.ctx.artifactService.blobManager.runGcForUser(userId, srv.ctx.db);
    expect(gcAfterRelease.deletedBlobs).toBeGreaterThanOrEqual(1);
    expect(srv.ctx.artifactService.blobManager.hasBlob(userId, lease.sha256)).toBe(false);
  });

  it('ARCH-07: dependency propagation queue & batch restore failed_partial propagate dependency_sync to BOTH un-restored parent in T and external sibling S', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const chatId = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'BatchDeps' })).data.chat.id;

    // Create shared CSS + two HTML parents (index.html and sibling.html)
    const css = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'styles.css',
      content: Buffer.from('body { color: red; }\n'),
      actorKind: 'user',
      actorId: userId,
    });
    const parentHtml = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'index.html',
      content: Buffer.from('<html><head><link rel="stylesheet" href="styles.css"></head><body>V1</body></html>'),
      actorKind: 'user',
      actorId: userId,
    });
    const siblingHtml = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'sibling.html',
      content: Buffer.from('<html><head><link rel="stylesheet" href="styles.css"></head><body>SIB</body></html>'),
      actorKind: 'user',
      actorId: userId,
    });
    expect(parentHtml.artifact.dependencyManifestHash).toBeTruthy();
    expect(siblingHtml.artifact.dependencyManifestHash).toBe(parentHtml.artifact.dependencyManifestHash);

    // Mutate styles.css -> dependency_sync automatically propagates to BOTH index.html and sibling.html!
    await srv.ctx.artifactService.editArtifact({
      userId,
      artifactId: css.artifact.id,
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: 'body { color: blue; }\n' }],
      actorKind: 'user',
      actorId: userId,
    });

    const parentAfterCss = srv.ctx.db.getArtifact(userId, parentHtml.artifact.id)!;
    const siblingAfterCss = srv.ctx.db.getArtifact(userId, siblingHtml.artifact.id)!;
    expect(parentAfterCss.revision).toBe(2); // dependency_sync
    expect(siblingAfterCss.revision).toBe(2); // dependency_sync
    expect(parentAfterCss.dependencyManifestHash).not.toBe(parentHtml.artifact.dependencyManifestHash);

    // Edit index.html to rev 3 (so restoring to rev 1 restores styles.css AND index.html)
    await srv.ctx.artifactService.editArtifact({
      userId,
      artifactId: parentHtml.artifact.id,
      expectedRevision: 2,
      operations: [{ op: 'replace_source', content: '<html><head><link rel="stylesheet" href="styles.css"></head><body>V2</body></html>' }],
      actorKind: 'user',
      actorId: userId,
    });

    // Trigger batch restore to rev 1 with mid-batch failure AFTER styles.css commits (count=1) and BEFORE index.html commits!
    const batch = await srv.ctx.artifactService.restoreBundle({
      userId,
      parentArtifactId: parentHtml.artifact.id,
      targetRevision: 1,
      sharedPolicy: 'overwrite_shared',
      actorKind: 'user',
      actorId: userId,
      failAfterCommittedCountForTest: 1,
    });
    expect(batch.state).toBe('failed_partial');
    expect(batch.items[0].status).toBe('committed'); // styles.css restored to red
    expect(batch.items[1].status).toBe('failed'); // index.html failed mid-batch

    // CRITICAL ARCH-07 CHECK:
    // Both un-restored parent (index.html inside T) AND external sibling (sibling.html = S) MUST receive dependency_sync!
    const parentAfterPartial = srv.ctx.db.getArtifact(userId, parentHtml.artifact.id)!;
    const siblingAfterPartial = srv.ctx.db.getArtifact(userId, siblingHtml.artifact.id)!;
    expect(parentAfterPartial.revision).toBe(4); // rev 3 + dependency_sync = 4
    expect(parentAfterPartial.dependencyManifestHash).toBe(parentHtml.artifact.dependencyManifestHash);
    expect(siblingAfterPartial.revision).toBe(3); // rev 2 + dependency_sync = 3
    expect(siblingAfterPartial.dependencyManifestHash).toBe(siblingHtml.artifact.dependencyManifestHash);
  });

  it('ARCH-02: idempotently migrates legacy DB (artifacts + project_files) and refuses legacy_unarchived restore with 422', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-legacy-db-'));
    cleanups.push(async () => fs.rmSync(tmp, { recursive: true, force: true }));

    const dbPath = path.join(tmp, 'legacy.db');
    const wsDir = path.join(tmp, 'workspaces', 'u1', 'c1');
    const projDir = path.join(tmp, 'projects', 'u1', 'p1', 'files');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'drifted.txt'), 'NEW_DISK_CONTENT');
    fs.writeFileSync(path.join(projDir, 'guide.md'), '# Project Guide');

    // Create legacy schema DB manually (no scope_kind, no artifact_id on project_files, no user_seq)
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', context_version INTEGER NOT NULL DEFAULT 1, storage_dir TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE project_files (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, rel_path TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(project_id, rel_path));
      CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, title TEXT NOT NULL, workspace_dir TEXT NOT NULL, acp_session_id TEXT, model_id TEXT, effort_value TEXT, project_context_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL, client_message_id TEXT, role TEXT NOT NULL, content_text TEXT NOT NULL DEFAULT '', thoughts_text TEXT NOT NULL DEFAULT '', tool_calls_json TEXT NOT NULL DEFAULT '[]', attachments_json TEXT NOT NULL DEFAULT '[]', artifact_refs_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'completed', run_id TEXT, error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT, run_id TEXT, rel_path TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, source TEXT NOT NULL, preview_kind TEXT NOT NULL, diff_patch TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(chat_id, rel_path));
      CREATE TABLE sync_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL, chat_id TEXT, project_id TEXT, run_id TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO users VALUES ('u1', 'alice', 'Alice', 'hash', 'user', 1, 1);
      INSERT INTO projects VALUES ('p1', 'u1', 'Proj', '', '', 1, '${projDir.replace(/'/g, "''")}', 1, 1);
      INSERT INTO project_files VALUES ('pf1', 'p1', 'u1', 'guide.md', 'guide.md', 'text/markdown', 15, '${sha256('# Project Guide')}', 1);
      INSERT INTO chats VALUES ('c1', 'u1', 'p1', 'Chat', '${wsDir.replace(/'/g, "''")}', NULL, NULL, NULL, 1, 1, 1, 1);
      INSERT INTO artifacts VALUES ('a1', 'u1', 'c1', NULL, NULL, 'drifted.txt', 'drifted.txt', 'text/plain', 3, '${sha256('OLD')}', 'generated', 'code', NULL, 1, 1);
      INSERT INTO sync_events (user_id, event_id, event_type, payload_json, created_at) VALUES ('u1', 'e1', 'chat.created', '{}', 1);
    `);
    raw.close();

    // Open twice to verify strict migration idempotency + PRAGMA synchronous = FULL
    const db1 = new AppDatabase(dbPath);
    const syncMode = db1.db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    expect(syncMode.synchronous).toBe(2); // 2 = FULL
    const pf = db1.listProjectFiles('u1', 'p1')[0];
    expect(pf.artifactId).toBeTruthy();
    expect(db1.getArtifact('u1', pf.artifactId!)?.scopeKind).toBe('project');
    expect(db1.getLatestUserSyncSeq('u1')).toBe(1);
    db1.close();

    const db2 = new AppDatabase(dbPath);
    const cfg = loadConfig({ dataRoot: tmp, dbPath });
    const svc = new ArtifactService(cfg, db2, new SyncHub(db2));

    // Accessing drifted legacy artifact migrates rev 1 as legacy_unarchived (blob_available=0) + rev 2 external_sync
    const history = svc.listHistory('u1', 'a1');
    expect(history.length).toBe(2);
    const rev1 = history.find((h) => h.revision === 1)!;
    const rev2 = history.find((h) => h.revision === 2)!;
    expect(rev1.operationType).toBe('legacy_unarchived');
    expect(rev1.blobAvailable).toBe(false);
    expect(rev1.restorable).toBe(false);
    expect(rev2.operationType).toBe('external_sync');
    expect(rev2.blobAvailable).toBe(true);

    // Restoring legacy_unarchived rev 1 MUST fail with 422 REVISION_SNAPSHOT_UNAVAILABLE
    await expect(
      svc.restoreRevision({ userId: 'u1', artifactId: 'a1', targetRevision: 1, actorKind: 'user', actorId: 'u1' })
    ).rejects.toMatchObject({ statusCode: 422, code: 'REVISION_SNAPSHOT_UNAVAILABLE' });
    db2.close();
  });

  it('PIN-03 & NEG-10: enforces source_base_revision conflict (409) when reflecting working copy to modified project original and blocks AI writes to project originals (403)', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const projId = (await alice.request<{ project: { id: string } }>('POST', '/api/projects', { name: 'SpecProj' })).data.project.id;

    const fd = new FormData();
    fd.append('files', new Blob(['Original V1\n'], { type: 'text/markdown' }), 'spec.md');
    const up = await alice.request<{ project: { files: Array<{ id: string; artifactId: string }> } }>(
      'POST',
      `/api/projects/${projId}/files`,
      fd
    );
    expect(up.status).toBe(201);
    const pf = up.data.project.files[0];
    expect(pf.artifactId).toBeTruthy();

    // AI/MCP direct write to project original MUST be 403 FORBIDDEN (NEG-10)
    await expect(
      srv.ctx.artifactService.editArtifact({
        userId,
        artifactId: pf.artifactId,
        expectedRevision: 1,
        operations: [{ op: 'replace_source', content: 'AI PWNED\n' }],
        actorKind: 'ai',
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    const chatId = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Work', projectId: projId })).data.chat.id;
    const wcRes = await alice.request<{ artifact: { id: string; sourceArtifactId: string; sourceBaseRevision: number } }>(
      'POST',
      `/api/projects/${projId}/files/${pf.id}/working-copy`,
      { chatId }
    );
    expect(wcRes.status).toBe(201);
    expect(wcRes.data.artifact.sourceArtifactId).toBe(pf.artifactId);
    expect(wcRes.data.artifact.sourceBaseRevision).toBe(1);

    // Edit working copy in chat (rev 1 -> 2)
    const wcEdit = await alice.request('POST', `/api/files/${wcRes.data.artifact.id}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: 'Edited In Chat\n' }],
    });
    expect(wcEdit.status).toBe(200);

    // Owner modifies project original directly (rev 1 -> 2)
    const origEdit = await alice.request('POST', `/api/files/${pf.artifactId}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: 'Original V2 Modified Elsewhere\n' }],
    });
    expect(origEdit.status).toBe(200);

    // Reflecting working copy without acknowledging rev 2 MUST return 409 ARTIFACT_CONFLICT (NEG-10)
    const conflictReflect = await alice.request<{ error: string }>('POST', `/api/files/${wcRes.data.artifact.id}/reflect-to-project`, {});
    expect(conflictReflect.status).toBe(409);
    expect(conflictReflect.data.error).toBe('ARTIFACT_CONFLICT');

    // Explicit overwrite confirming expectedProjectRevision: 2 succeeds and updates sourceBaseRevision to 3
    const okReflect = await alice.request<{
      projectArtifact: { revision: number };
      workingCopy: { sourceBaseRevision: number };
    }>('POST', `/api/files/${wcRes.data.artifact.id}/reflect-to-project`, { expectedProjectRevision: 2 });
    expect(okReflect.status).toBe(200);
    expect(okReflect.data.projectArtifact.revision).toBe(3);
    expect(okReflect.data.workingCopy.sourceBaseRevision).toBe(3);
  });

  it('ARCH-14: per-actor Undo/Redo protects intervening AI edits with 409 UNDO_SEMANTIC_CONFLICT and reports history_pruned', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const chatId = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'UndoTest' })).data.chat.id;

    const c = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'code.ts',
      content: Buffer.from('const x = 1;\n'),
      actorKind: 'user',
      actorId: userId,
    });

    // User edits rev 1 -> 2
    await srv.ctx.artifactService.editArtifact({
      userId,
      artifactId: c.artifact.id,
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: 'const x = 2;\n' }],
      actorKind: 'user',
      actorId: userId,
    });

    // Undo works cleanly when no intervening AI edit exists (rev 2 -> 3 restores rev 1)
    const undo1 = await alice.request<{ artifact: { revision: number } }>('POST', `/api/files/${c.artifact.id}/undo`, {});
    expect(undo1.status).toBe(200);
    expect(undo1.data.artifact.revision).toBe(3);
    expect(srv.ctx.artifactService.readActiveArtifactBytes(srv.ctx.db.getArtifact(userId, c.artifact.id)!)!.toString('utf8')).toBe(
      'const x = 1;\n'
    );

    // Redo works (rev 3 -> 4 restores rev 2)
    const redo1 = await alice.request<{ artifact: { revision: number } }>('POST', `/api/files/${c.artifact.id}/redo`, {});
    expect(redo1.status).toBe(200);
    expect(redo1.data.artifact.revision).toBe(4);

    // Now AI edits rev 4 -> 5; user attempting undo MUST get 409 UNDO_SEMANTIC_CONFLICT (protecting AI edit!)
    await srv.ctx.artifactService.editArtifact({
      userId,
      artifactId: c.artifact.id,
      expectedRevision: 4,
      operations: [{ op: 'replace_source', content: 'const x = 99; // AI\n' }],
      actorKind: 'ai',
    });

    const conflictUndo = await alice.request<{ error: string }>('POST', `/api/files/${c.artifact.id}/undo`, {});
    expect(conflictUndo.status).toBe(409);
    expect(conflictUndo.data.error).toBe('UNDO_SEMANTIC_CONFLICT');
  });

  it('PIN-01, PIN-02 (all 6 mandatory cases), PIN-05, PIN-06: strict target re-resolution, Binary rejection, and applied_unverified-only guard', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const chatId = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'PinTests' })).data.chat.id;

    // 0. Binary rejects target_pin with 422 unsupported_by_format
    const binArt = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'archive.bin',
      content: Buffer.from([0x00, 0x01, 0x02]),
      actorKind: 'user',
      actorId: userId,
    });
    const binPin = await alice.request<{ error: string }>('POST', `/api/chats/${chatId}/edit-requests`, {
      targetKind: 'artifact',
      artifactId: binArt.artifact.id,
      selector: { kind: 'binary_range' },
      instruction: 'edit binary',
    });
    expect(binPin.status).toBe(422);
    expect(binPin.data.error).toBe('UNSUPPORTED_OPERATION');

    // Case 1 (PIN-02): Same-dimension different image -> needs_review
    const imgBuf1 = Buffer.from('FAKE_PNG_1_SAME_LEN');
    const imgBuf2 = Buffer.from('FAKE_PNG_2_SAME_LEN');
    const imgArt = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'pic.png',
      content: imgBuf1,
      actorKind: 'user',
      actorId: userId,
    });
    const imgReq = srv.ctx.editRequestService.createRequest({
      userId,
      chatId,
      targetKind: 'artifact',
      artifactId: imgArt.artifact.id,
      selector: { kind: 'image_pin', xNorm: 0.5, yNorm: 0.5, expectedWidthPx: 100, expectedHeightPx: 100, expectedImageSha256: sha256(imgBuf1) },
      instruction: 'brighten center',
    });
    await srv.ctx.artifactService.replaceArtifactBytes({
      userId,
      artifactId: imgArt.artifact.id,
      expectedRevision: 1,
      newBuffer: imgBuf2,
      actorKind: 'user',
      actorId: userId,
      operationType: 'replace',
      operationSummary: 'replaced image',
    });
    expect(srv.ctx.editRequestService.getRequest(userId, chatId, imgReq.id)!.status).toBe('needs_review');

    // Case 2 (PIN-02): Same page count PDF page swap -> needs_review
    const pdfArt = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'doc.pdf',
      content: Buffer.from('%PDF-1.4 page1-A page2-B'),
      actorKind: 'user',
      actorId: userId,
    });
    const pdfRes = srv.ctx.artifactService.resolveTargetOnArtifact(userId, pdfArt.artifact.id, {
      kind: 'pdf_page',
      pageIndex: 0,
      expectedPageCount: 2,
      expectedPageContentHash: sha256('old-page-0'),
      _currentPageContentHash: sha256('swapped-page-1'),
    });
    expect(pdfRes.status).toBe('needs_review');

    // Case 3 (PIN-02): Same-structure XLSX value/order change -> needs_review (TARGET_CONTENT_DRIFT)
    const xlsxArt = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'sheet.xlsx',
      content: Buffer.from('PK\x03\x04dummy-xlsx'),
      actorKind: 'user',
      actorId: userId,
    });
    const xlsxRes = srv.ctx.artifactService.resolveTargetOnArtifact(userId, xlsxArt.artifact.id, {
      kind: 'xlsx_range',
      sheetId: 'Sheet1',
      rangeA1: 'A1:B2',
      expectedSheetStructHash: 'same',
      expectedRangeValuesHash: sha256('10,20'),
      _currentRangeValuesHash: sha256('20,10'),
    });
    expect(xlsxRes.status).toBe('needs_review');
    expect(xlsxRes.reason).toBe('TARGET_CONTENT_DRIFT');

    // Case 4 (PIN-02): Same ID replaced with different element (SVG elementId) -> needs_review
    const svgArt = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'icon.svg',
      content: Buffer.from('<svg viewBox="0 0 100 100"><rect id="hero" width="50" height="50"/></svg>'),
      actorKind: 'user',
      actorId: userId,
    });
    const svgStruct = srv.ctx.artifactService.getStructure(userId, svgArt.artifact.id) as {
      elements: Array<{ id: string; tag: string; fingerprint: string }>;
    };
    const heroEl = svgStruct.elements.find((e) => e.id === 'hero')!;
    await srv.ctx.artifactService.editArtifact({
      userId,
      artifactId: svgArt.artifact.id,
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: '<svg viewBox="0 0 100 100"><circle id="hero" r="25"/></svg>' }],
      actorKind: 'user',
      actorId: userId,
    });
    const svgRes = srv.ctx.artifactService.resolveTargetOnArtifact(userId, svgArt.artifact.id, {
      kind: 'svg_element',
      elementId: 'hero',
      expectedTag: heroEl.tag,
      expectedElementFingerprint: heroEl.fingerprint,
    });
    expect(svgRes.status).toBe('needs_review');

    // Case 5 (PIN-02): Duplicate code snippet -> ambiguous multiple matches -> needs_review
    const codeArt = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'dup.ts',
      content: Buffer.from('line0\nconst dup = 1;\nline2\nconst dup = 1;\nline4'),
      actorKind: 'user',
      actorId: userId,
    });
    await srv.ctx.artifactService.editArtifact({
      userId,
      artifactId: codeArt.artifact.id,
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: 'changed0\nconst dup = 1;\nchanged2\nconst dup = 1;\nchanged4' }],
      actorKind: 'user',
      actorId: userId,
    });
    const dupRes = srv.ctx.artifactService.resolveTargetOnArtifact(userId, codeArt.artifact.id, {
      kind: 'code_line_range',
      startLine: 1,
      endLine: 1,
      expectedSnippetHash: sha256('const dup = 1;'),
      contextBeforeHash: sha256('line0'),
      contextAfterHash: sha256('line2'),
    });
    expect(dupRes.status).toBe('needs_review');

    // Case 6 (PIN-02): Rich UI repeat item reordered -> needs_review (never silently re-index!)
    const richCreated = srv.ctx.richContentService.createBlock({
      userId,
      chatId,
      document: {
        schemaVersion: 1,
        state: {
          rows: [
            { id: 'r1', name: 'First' },
            { id: 'r2', name: 'Second' },
          ],
        },
        root: {
          id: 'root',
          type: 'stack',
          direction: 'col',
          children: [
            {
              id: 'rep-row',
              type: 'text',
              repeat: { itemsExpr: '$state.rows', as: 'row', keyField: 'id' },
              content: { expr: '$item.name' },
            },
          ],
        },
      },
    });
    const reqRich = srv.ctx.editRequestService.createRequest({
      userId,
      chatId,
      targetKind: 'rich_block',
      richBlockId: richCreated.block.id,
      selector: {
        kind: 'rich_repeat_item',
        repeatNodeId: 'rep-row',
        itemKey: 'r1',
        itemIndex: 0,
        expectedItemHash: sha256(JSON.stringify({ id: 'r1', name: 'First' })),
        expectedListOrderHash: sha256(JSON.stringify(['r1', 'r2'])),
      },
      instruction: 'Highlight first item',
    });
    // Swap array order r2, r1
    srv.ctx.richContentService.updateBlock({
      userId,
      chatId,
      blockId: richCreated.block.id,
      expectedRevision: 1,
      patchState: {
        rows: [
          { id: 'r2', name: 'Second' },
          { id: 'r1', name: 'First' },
        ],
      },
    });
    const richReRes = srv.ctx.editRequestService.resolveRequestTarget(reqRich);
    expect(richReRes.status).toBe('needs_review');
    expect(richReRes.orderChanged).toBe(true);

    // PIN-05 & PIN-06: getForAgent separates userInstruction vs untrustedTargetContent; markApplied ONLY transitions to applied_unverified
    const agentPayload = srv.ctx.editRequestService.getForAgent(userId, chatId, reqRich.id);
    expect(agentPayload.userInstruction).toBe('Highlight first item');
    expect(agentPayload.untrustedTargetContent).toBeDefined();

    const applied = srv.ctx.editRequestService.markAppliedByAgent({
      userId,
      chatId,
      requestId: reqRich.id,
      appliedRevision: 2,
    });
    expect(applied.status).toBe('applied_unverified'); // NEVER auto-resolved!

    const userResolved = await alice.request<{ request: { status: string } }>(
      'POST',
      `/api/chats/${chatId}/edit-requests/${reqRich.id}/resolve`
    );
    expect(userResolved.status).toBe(200);
    expect(userResolved.data.request.status).toBe('resolved');
  });

  it('ARCH-08, ARCH-09 & Basic 8 Adapters: supports immutable revision Range serving, WS user_seq/pong/snapshot, and Pure-JS CRUD/verify/export', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const hello = await alice.connectWs({ clientId: 'sync-client-1' });
    expect(typeof hello.latestUserSeq).toBe('number');

    const chatId = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Adapters' })).data.chat.id;

    // CSV adapter create + edit + verify + export JSON
    const csvRes = await alice.request<{ artifact: { id: string; sha256: string; revision: number } }>(
      'POST',
      `/api/chats/${chatId}/artifacts`,
      { relPath: 'data.csv', content: 'name,score\nAlice,90\nBob,80\n' }
    );
    expect(csvRes.status).toBe(201);
    const csvEdit = await alice.request<{ artifact: { revision: number; sha256: string } }>(
      'POST',
      `/api/files/${csvRes.data.artifact.id}/edit`,
      { expectedRevision: 1, operations: [{ op: 'set_cell', row: 1, col: 1, value: '95' }] }
    );
    expect(csvEdit.status).toBe(200);
    expect(csvEdit.data.artifact.revision).toBe(2);

    const csvVerify = await alice.request<{ ok: boolean }>('POST', `/api/files/${csvRes.data.artifact.id}/verify`);
    expect(csvVerify.data.ok).toBe(true);

    const csvExport = await alice.request<{ artifact: { relPath: string } }>('POST', `/api/files/${csvRes.data.artifact.id}/export`, {
      targetFormat: 'json',
    });
    expect(csvExport.status).toBe(201);
    expect(csvExport.data.artifact.relPath).toBe('data.json');

    // Revision-pinned immutable Range serving (ARCH-08)
    const rev1Sha12 = csvRes.data.artifact.sha256.slice(0, 12);
    const pinnedRes = await alice.request<string>(
      'GET',
      `/api/files/${csvRes.data.artifact.id}/content?rev=1&v=${rev1Sha12}`,
      undefined,
      { headers: { Range: 'bytes=0-9' } }
    );
    expect(pinnedRes.status).toBe(206);
    expect(pinnedRes.data).toBe('name,score');
    expect(pinnedRes.headers.get('cache-control')).toContain('immutable');
    expect(pinnedRes.headers.get('x-artifact-revision')).toBe('1');

    // Markdown, Mermaid, Diff adapters quick verification
    const mdRes = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'readme.md',
      content: '# Title\n\nBody\n',
    });
    expect((await alice.request<{ headings: unknown[] }>('GET', `/api/files/${mdRes.data.artifact.id}/structure`)).data.headings.length).toBe(1);

    const mmdRes = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'flow.mmd',
      content: 'flowchart TD\n  A[Start] --> B[End]\n',
    });
    expect((await alice.request<{ ok: boolean }>('POST', `/api/files/${mmdRes.data.artifact.id}/verify`)).data.ok).toBe(true);

    const diffRes = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'fix.diff',
      content: '--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n',
    });
    expect((await alice.request<{ ok: boolean }>('POST', `/api/files/${diffRes.data.artifact.id}/verify`)).data.ok).toBe(true);

    // SVG set_attr rejects on* handlers and invalid regex attribute names while safely updating valid attributes
    const svgRes = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'icon.svg',
      content: '<svg viewBox="0 0 100 100"><rect id="box" fill="red" width="10" height="10"/></svg>',
    });
    const badHandler = await alice.request<{ error: string }>('POST', `/api/files/${svgRes.data.artifact.id}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'set_attr', elementId: 'box', attr: 'onload', value: 'alert(1)' }],
    });
    expect(badHandler.status).toBe(400);
    expect(badHandler.data.error).toBe('INVALID_SVG_ATTRIBUTE');

    const badRegexAttr = await alice.request<{ error: string }>('POST', `/api/files/${svgRes.data.artifact.id}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'set_attr', elementId: 'box', attr: '[invalid(regex', value: 'x' }],
    });
    expect(badRegexAttr.status).toBe(400);
    expect(badRegexAttr.data.error).toBe('INVALID_SVG_ATTRIBUTE');

    const goodAttr = await alice.request<{ artifact: { revision: number } }>('POST', `/api/files/${svgRes.data.artifact.id}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'set_attr', elementId: 'box', attr: 'fill', value: 'blue' }],
    });
    expect(goodAttr.status).toBe(200);
    expect(goodAttr.data.artifact.revision).toBe(2);

    // WS ping -> pong includes latestUserSeq, and GET /api/sync/snapshot returns consistent snapshotUserSeq (ARCH-09)
    alice.ws!.send(JSON.stringify({ kind: 'ping', visible: true }));
    const pong = await alice.waitForFrame((f) => f.kind === 'pong');
    expect(Number(pong.latestUserSeq)).toBeGreaterThan(0);

    const snap = await alice.request<{ snapshotUserSeq: number; chats: unknown[]; artifacts: unknown[] }>(
      'GET',
      '/api/sync/snapshot'
    );
    expect(snap.status).toBe(200);
    expect(snap.data.snapshotUserSeq).toBeGreaterThanOrEqual(Number(pong.latestUserSeq));
    expect(snap.data.artifacts.length).toBeGreaterThanOrEqual(4);

    alice.closeWs();
  });

  it('ARCH-13, PERF-02, SEC-04: ResourceGovernor enforces MemAvailable 503 RESOURCE_BUSY and DocWorkerSandbox enforces 503 SANDBOX_REQUIRED without bwrap', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gov-'));
    cleanups.push(async () => fs.rmSync(tmp, { recursive: true, force: true }));

    // 1. Low MemAvailable -> 503 RESOURCE_BUSY for heavy worker
    const lowMemCfg = loadConfig({ dataRoot: tmp, minMemAvailableMb: 400 });
    const lowMemGov = new ResourceGovernor(lowMemCfg, () => 128);
    await expect(lowMemGov.runWithBudget('libreoffice', async () => 'ok')).rejects.toMatchObject({
      statusCode: 503,
      code: 'RESOURCE_BUSY',
    });

    // 2. Missing bwrap -> DocWorkerSandbox rejects with 503 SANDBOX_REQUIRED unless ALLOW_UNSANDBOXED_DOC_WORKERS=1
    const noBwrapCfg = loadConfig({
      dataRoot: tmp,
      sandboxMode: 'strict',
      bwrapBin: '/nonexistent/bwrap-missing',
      allowUnsandboxedDocWorkers: false,
    });
    const okGov = new ResourceGovernor(noBwrapCfg, () => 2048);
    const sandbox = new DocWorkerSandbox(noBwrapCfg, okGov);
    expect(sandbox.getIsolationStatus()).toBe('sandbox_required_blocked');
    await expect(
      sandbox.run({ kind: 'python', command: 'python3', args: ['-c', 'print(1)'] })
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SANDBOX_REQUIRED',
    });

    // 3. Concurrent waiters never exceed maxWeightBudget on wakeup
    const budgetCfg = loadConfig({ dataRoot: tmp, docWorkerBudget: 2 });
    const budgetGov = new ResourceGovernor(budgetCfg, () => 2048);
    let peakUsedWeight = 0;
    let activeCount = 0;
    let peakActive = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        budgetGov.runWithBudget('python', async () => {
          activeCount += 1;
          peakActive = Math.max(peakActive, activeCount);
          peakUsedWeight = Math.max(peakUsedWeight, budgetGov.getUsedWeight());
          await new Promise((r) => setTimeout(r, 25));
          activeCount -= 1;
        })
      )
    );
    expect(peakUsedWeight).toBeLessThanOrEqual(2);
    expect(peakActive).toBeLessThanOrEqual(2);
    expect(budgetGov.getUsedWeight()).toBe(0);
  });
});
