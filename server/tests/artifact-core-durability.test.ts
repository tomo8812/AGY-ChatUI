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
    const svgStruct = await srv.ctx.artifactService.getStructure(userId, svgArt.artifact.id) as {
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
    // Key-based selector without itemIndex resolves cleanly when key + hash match and order is unchanged
    const reqRichKeyOnly = srv.ctx.editRequestService.createRequest({
      userId,
      chatId,
      targetKind: 'rich_block',
      richBlockId: richCreated.block.id,
      selector: {
        kind: 'rich_repeat_item',
        repeatNodeId: 'rep-row',
        itemKey: 'r1',
        expectedItemHash: sha256(JSON.stringify({ id: 'r1', name: 'First' })),
        expectedListOrderHash: sha256(JSON.stringify(['r1', 'r2'])),
      },
      instruction: 'Check key-only item',
    });
    expect(srv.ctx.editRequestService.resolveRequestTarget(reqRichKeyOnly).status).toBe('resolved');

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

  it('Finding #2 (ARCH-03 / Sec 3.2): serializes concurrent ingestWorkspaceFile and editArtifact through ArtifactLockManager', async () => {
    const srv = await createTestServer({ sandboxMode: 'off' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'lock_alice', 'lock-code');
    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', { title: 'Lock Chat' });
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    const created = await alice.request<{ artifact: { id: string; revision: number } }>(
      'POST',
      `/api/chats/${chatId}/artifacts`,
      { relPath: 'shared.md', content: '# initial\n' }
    );
    const artifactId = created.data.artifact.id;

    // Spy on ArtifactLockManager to prove ingestWorkspaceFile acquires artifact & path locks
    const acquiredKeys: string[][] = [];
    const origWithLocks = srv.ctx.artifactService.lockManager.withLocks.bind(srv.ctx.artifactService.lockManager);
    srv.ctx.artifactService.lockManager.withLocks = (async (keys, fn) => {
      acquiredKeys.push([...keys]);
      return origWithLocks(keys, fn);
    }) as typeof srv.ctx.artifactService.lockManager.withLocks;

    // Simulate external ACP write + concurrent ingestWorkspaceFile vs editArtifact on the same artifact
    const filePath = path.join(workspaceDir, 'shared.md');
    fs.writeFileSync(filePath, '# external-acp-v2\n', 'utf8');

    const [ingestOut, editOut] = await Promise.all([
      srv.ctx.artifactService.ingestWorkspaceFile({
        userId,
        chatId,
        workspaceDir,
        relPath: 'shared.md',
        absPath: filePath,
      }),
      srv.ctx.artifactService.editArtifact({
        userId,
        artifactId,
        expectedRevision: 1,
        operations: [{ op: 'replace_source', content: '# user-edit\n' }],
        actorKind: 'user',
        actorId: userId,
      }).catch((err: unknown) => ({ conflictErr: err })),
    ]);

    expect(ingestOut.artifact.id).toBe(artifactId);
    expect(acquiredKeys.some((ks) => ks.includes(`artifact:${artifactId}`))).toBe(true);
    // Either ingest ran first (causing edit to see 409 CONFLICT on stale rev 1) OR edit ran first and ingest saw updated bytes;
    // in BOTH serialized orders, final DB artifact revision, sha256, and disk content must stay 100% consistent.
    const latest = srv.ctx.db.getArtifact(userId, artifactId)!;
    const diskBytes = fs.readFileSync(filePath);
    const diskSha = crypto.createHash('sha256').update(diskBytes).digest('hex');
    expect(latest.sha256).toBe(diskSha);
    expect(latest.revision).toBeGreaterThanOrEqual(2);
    expect(editOut).toBeDefined();
  });

  it('Finding #3 (ARCH-04 / ARCH-07): atomically marks artifact_restore_batch_items committed inside Stage T6 on both normal commit and crash recovery', async () => {
    const srv = await createTestServer({ sandboxMode: 'off' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'batch_t6_alice', 't6-code');
    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Batch T6 Chat' });
    const chatId = chatRes.data.chat.id;

    // Create shared CSS + parent HTML + external sibling HTML
    const cssRes = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'theme.css',
      content: 'body { color: navy; }',
    });
    const cssId = cssRes.data.artifact.id;

    const parentRes = await alice.request<{ artifact: { id: string; revision: number } }>(
      'POST',
      `/api/chats/${chatId}/artifacts`,
      { relPath: 'parent.html', content: '<link rel="stylesheet" href="theme.css"><h1>Parent v1</h1>' }
    );
    const parentId = parentRes.data.artifact.id;

    const siblingRes = await alice.request<{ artifact: { id: string; revision: number } }>(
      'POST',
      `/api/chats/${chatId}/artifacts`,
      { relPath: 'sibling.html', content: '<link rel="stylesheet" href="theme.css"><h1>Sibling v1</h1>' }
    );
    const siblingId = siblingRes.data.artifact.id;

    // Mutate theme.css to rev 2 (auto-propagating dependency_sync to parent & sibling -> rev 2)
    const editCss = await alice.request('POST', `/api/files/${cssId}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: 'body { color: crimson; }' }],
    });
    expect(editCss.status).toBe(200);
    const parentBeforeRestore = srv.ctx.db.getArtifact(userId, parentId)!;
    const siblingBeforeRestore = srv.ctx.db.getArtifact(userId, siblingId)!;
    expect(parentBeforeRestore.revision).toBe(2);
    expect(siblingBeforeRestore.revision).toBe(2);

    // Inject crash at after_T5 on the FIRST item (theme.css) during restoreBundle(parent, rev 1)
    let injectedOnce = false;
    srv.ctx.artifactService.commitFaultHook = (stage) => {
      if (stage === 'after_T5' && !injectedOnce) {
        injectedOnce = true;
        throw new Error('SIMULATED_CRASH_AFTER_T5_IN_BATCH');
      }
    };

    await expect(
      srv.ctx.artifactService.restoreBundle({
        userId,
        parentArtifactId: parentId,
        targetRevision: 1,
        sharedPolicy: 'overwrite_shared',
        actorKind: 'user',
        actorId: userId,
      })
    ).rejects.toThrow('SIMULATED_CRASH_AFTER_T5_IN_BATCH');
    srv.ctx.artifactService.commitFaultHook = undefined;

    // Before recovery: T6 did NOT run yet, so journal has batch_seq = 1 and batch item is still pending
    const journalBefore = srv.ctx.db.db
      .prepare('SELECT state, batch_id, batch_seq FROM artifact_commit_journal WHERE artifact_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(cssId) as { state: string; batch_id: string; batch_seq: number };
    expect(journalBefore.state).toBe('file_replaced');
    expect(journalBefore.batch_id).toBeTruthy();
    expect(journalBefore.batch_seq).toBe(1);

    const itemBefore = srv.ctx.db.db
      .prepare('SELECT status, committed_revision FROM artifact_restore_batch_items WHERE batch_id = ? AND seq = 1')
      .get(journalBefore.batch_id) as { status: string; committed_revision: number | null };
    expect(itemBefore.status).toBe('pending');
    expect(itemBefore.committed_revision).toBeNull();

    // Run startup crash recovery -> rolls forward T6 atomically marking batch item committed,
    // finalizes interrupted batch as failed_partial, and propagates dependency_sync to BOTH
    // the un-restored parent in T AND the external sibling S!
    await srv.ctx.artifactService.recoverOnStartup();

    const itemAfter = srv.ctx.db.db
      .prepare('SELECT status, committed_revision FROM artifact_restore_batch_items WHERE batch_id = ? AND seq = 1')
      .get(journalBefore.batch_id) as { status: string; committed_revision: number | null };
    expect(itemAfter.status).toBe('committed');
    expect(itemAfter.committed_revision).toBe(3);

    const batchRow = srv.ctx.db.db
      .prepare('SELECT state FROM artifact_restore_batches WHERE batch_id = ?')
      .get(journalBefore.batch_id) as { state: string };
    expect(batchRow.state).toBe('failed_partial');

    const parentAfter = srv.ctx.db.getArtifact(userId, parentId)!;
    const siblingAfter = srv.ctx.db.getArtifact(userId, siblingId)!;
    expect(parentAfter.revision).toBeGreaterThan(parentBeforeRestore.revision);
    expect(siblingAfter.revision).toBeGreaterThan(siblingBeforeRestore.revision);
  });

  it('Finding #4 (ARCH-03 / ARCH-07 / SEC-02): enforces ENOENT-only deletion, O_NOFOLLOW .project-context sync deletion with dep propagation, and gateway-routed project deletion', async () => {
    const srv = await createTestServer({ sandboxMode: 'off' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'proj_del_alice', 'projdel-code');

    // 1. Create project & upload ref.css
    const projRes = await alice.request<{ project: { id: string; storageDir: string } }>('POST', '/api/projects', {
      name: 'Strict Delete Project',
    });
    const projectId = projRes.data.project.id;
    const storageDir = projRes.data.project.storageDir;

    const up = await srv.ctx.artifactService.uploadProjectFile({
      userId,
      projectId,
      filename: 'ref.css',
      mimeType: 'text/css',
      buffer: Buffer.from('h1 { color: teal; }', 'utf8'),
    });

    // 2. Make storageDir read-only (0500) -> unlink fails with EACCES -> deleteProjectFile MUST throw and preserve DB row!
    fs.chmodSync(storageDir, 0o500);
    try {
      const failDel = await alice.request('DELETE', `/api/projects/${projectId}/files/${up.file.id}`);
      expect(failDel.status).toBeGreaterThanOrEqual(400);
      expect(srv.ctx.db.getProjectFileById(userId, projectId, up.file.id)).not.toBeNull();
      expect(srv.ctx.db.getArtifact(userId, up.artifact.id)).not.toBeNull();
    } finally {
      fs.chmodSync(storageDir, 0o700);
    }

    // 3. Create chat under project (copies ref.css into .project-context/ref.css) and create dependent HTML
    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'Sync Dep Chat',
      projectId,
    });
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;
    const docRes = await alice.request<{ artifact: { id: string; revision: number } }>(
      'POST',
      `/api/chats/${chatId}/artifacts`,
      { relPath: 'page.html', content: '<link rel="stylesheet" href=".project-context/ref.css"><p>Hi</p>' }
    );
    const pageId = docRes.data.artifact.id;
    const pageBeforeSync = srv.ctx.db.getArtifact(userId, pageId)!;
    expect(pageBeforeSync.dependencyManifestHash).toBeTruthy();

    // 4. Delete ref.css from project (simulate ENOENT first by manually removing file -> ENOENT IS tolerated)
    fs.unlinkSync(path.join(storageDir, up.file.relPath));
    const okDel = await alice.request('DELETE', `/api/projects/${projectId}/files/${up.file.id}`);
    expect(okDel.status).toBe(200);
    expect(srv.ctx.db.getProjectFileById(userId, projectId, up.file.id)).toBeNull();
    expect(srv.ctx.db.getArtifact(userId, up.artifact.id)).toBeNull();

    // Verify artifact.deleted durable event was persisted
    const delEvents = srv.ctx.db.db
      .prepare("SELECT event_type, payload_json FROM sync_events WHERE user_id = ? AND event_type = 'artifact.deleted'")
      .all(userId) as Array<{ event_type: string; payload_json: string }>;
    expect(delEvents.some((e) => e.payload_json.includes(up.artifact.id))).toBe(true);

    // 5. Sync project to chat -> deletes .project-context/ref.css with O_NOFOLLOW, emits artifact.deleted, and propagates dep update to page.html
    const syncRes = await alice.request('POST', `/api/chats/${chatId}/sync-project`, {});
    expect(syncRes.status).toBe(200);
    expect(fs.existsSync(path.join(workspaceDir, '.project-context', 'ref.css'))).toBe(false);
    const pageAfterSync = srv.ctx.db.getArtifact(userId, pageId)!;
    expect(pageAfterSync.revision).toBeGreaterThan(pageBeforeSync.revision);

    // 6. Replace .project-context with a symlink -> syncProjectFilesToChat MUST reject via O_NOFOLLOW!
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-outside-'));
    cleanups.push(async () => fs.rmSync(outsideDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
    const ctxDir = path.join(workspaceDir, '.project-context');
    fs.rmSync(ctxDir, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, ctxDir);

    await expect(
      srv.ctx.artifactService.syncProjectFilesToChat({ userId, projectId, chatId })
    ).rejects.toThrow();
    // Outside file must remain untouched
    expect(fs.existsSync(path.join(outsideDir, 'secret.txt'))).toBe(true);

    // Restore normal dir and upload another project file to test DELETE /api/projects/:projectId via ArtifactService
    fs.unlinkSync(ctxDir);
    const up2 = await srv.ctx.artifactService.uploadProjectFile({
      userId,
      projectId,
      filename: 'guide.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Guide', 'utf8'),
    });
    const delProjRes = await alice.request('DELETE', `/api/projects/${projectId}`);
    expect(delProjRes.status, JSON.stringify(delProjRes.data)).toBe(200);
    expect(srv.ctx.db.getProject(userId, projectId)).toBeNull();
    expect(srv.ctx.db.getArtifact(userId, up2.artifact.id)).toBeNull();
    expect(fs.existsSync(path.dirname(storageDir))).toBe(false);
    const projEvents = srv.ctx.db.db
      .prepare("SELECT event_type, payload_json FROM sync_events WHERE user_id = ? AND event_type IN ('artifact.deleted', 'project.deleted')")
      .all(userId) as Array<{ event_type: string; payload_json: string }>;
    expect(projEvents.some((e) => e.event_type === 'artifact.deleted' && e.payload_json.includes(up2.artifact.id))).toBe(true);
    expect(projEvents.some((e) => e.event_type === 'project.deleted' && e.payload_json.includes(projectId))).toBe(true);
  });

  it('Finding #5 (ARCH-05 / SEC-10): evaluates crash recovery strictly from commit-time persisted staging_isolation_mode (never current host bwrap state)', async () => {
    const srv = await createTestServer({ sandboxMode: 'off' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'iso_alice', 'iso-code');
    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', { title: 'Iso Chat' });
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    // 1. Create artifact, then inject crash at after_T3 while host has non_isolated_same_uid
    const created = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'iso.txt',
      content: 'rev1',
    });
    const artifactId = created.data.artifact.id;

    srv.ctx.artifactService.stagingIsolationOverride = 'non_isolated_same_uid';
    srv.ctx.artifactService.commitFaultHook = (stage) => {
      if (stage === 'after_T3') throw new Error('CRASH_AT_REPLACING_NON_ISOLATED');
    };
    await expect(
      srv.ctx.artifactService.editArtifact({
        userId,
        artifactId,
        expectedRevision: 1,
        operations: [{ op: 'replace_source', content: 'rev2-ambiguous' }],
        actorKind: 'user',
        actorId: userId,
      })
    ).rejects.toThrow('CRASH_AT_REPLACING_NON_ISOLATED');
    srv.ctx.artifactService.commitFaultHook = undefined;

    // Simulate ambiguous disk state AND flip host isolation to bwrap_mount_isolated before recovery!
    const jRow = srv.ctx.db.db
      .prepare('SELECT commit_id, state, staging_isolation_mode, new_sha256 FROM artifact_commit_journal WHERE artifact_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(artifactId) as { commit_id: string; state: string; staging_isolation_mode: string | null; new_sha256: string };
    expect(jRow.state).toBe('replacing');
    expect(jRow.staging_isolation_mode).toBe('non_isolated_same_uid');
    fs.writeFileSync(path.join(workspaceDir, 'iso.txt'), 'rev2-ambiguous', 'utf8');

    // Host switches to bwrap_mount_isolated at boot time — recovery MUST ignore host state and use persisted non_isolated_same_uid!
    srv.ctx.artifactService.stagingIsolationOverride = 'bwrap_mount_isolated';
    const report1 = await srv.ctx.artifactService.recoverOnStartup();
    expect(report1.commits.quarantined).toBeGreaterThanOrEqual(1);
    const jAfter1 = srv.ctx.db.db
      .prepare('SELECT state FROM artifact_commit_journal WHERE commit_id = ?')
      .get(jRow.commit_id) as { state: string };
    expect(jAfter1.state).toBe('ambiguous_quarantined');

    // 2. Test NULL/unknown staging_isolation_mode on a replacing journal row while host IS bwrap_mount_isolated -> MUST ALSO quarantine!
    const art2 = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'unknown-iso.txt',
      content: 'v1',
    });
    srv.ctx.artifactService.commitFaultHook = (stage) => {
      if (stage === 'after_T3') throw new Error('CRASH_UNKNOWN_ISO');
    };
    await expect(
      srv.ctx.artifactService.editArtifact({
        userId,
        artifactId: art2.data.artifact.id,
        expectedRevision: 1,
        operations: [{ op: 'replace_source', content: 'v2-unknown' }],
        actorKind: 'user',
        actorId: userId,
      })
    ).rejects.toThrow('CRASH_UNKNOWN_ISO');
    srv.ctx.artifactService.commitFaultHook = undefined;

    const j2 = srv.ctx.db.db
      .prepare('SELECT commit_id FROM artifact_commit_journal WHERE artifact_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(art2.data.artifact.id) as { commit_id: string };
    srv.ctx.db.db.prepare('UPDATE artifact_commit_journal SET staging_isolation_mode = NULL WHERE commit_id = ?').run(j2.commit_id);
    fs.writeFileSync(path.join(workspaceDir, 'unknown-iso.txt'), 'v2-unknown', 'utf8');

    const report2 = await srv.ctx.artifactService.recoverOnStartup();
    expect(report2.commits.quarantined).toBeGreaterThanOrEqual(1);
    const j2After = srv.ctx.db.db
      .prepare('SELECT state FROM artifact_commit_journal WHERE commit_id = ?')
      .get(j2.commit_id) as { state: string };
    expect(j2After.state).toBe('ambiguous_quarantined');
  });

  it('Finding #6 (ARCH-06): re-verifies live DB session & resource validity on REST edit idempotency replay and pre-commit', async () => {
    const srv = await createTestServer({ sandboxMode: 'off' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'auth_reverify_alice', 'auth-code');
    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Auth Chat' });
    const chatId = chatRes.data.chat.id;
    const created = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'doc.md',
      content: '# v1\n',
    });
    const artifactId = created.data.artifact.id;

    // 1. Initial idempotent edit succeeds
    const edit1 = await alice.request<{ artifact: { revision: number } }>('POST', `/api/files/${artifactId}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: '# v2\n' }],
      idempotencyKey: 'idem-live-auth-check',
    });
    expect(edit1.status).toBe(200);
    expect(edit1.data.artifact.revision).toBe(2);

    // 2. Replay while session is still valid -> returns cached idempotent result (rev 2)
    const replayOk = await alice.request<{ artifact: { revision: number } }>('POST', `/api/files/${artifactId}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: '# v2\n' }],
      idempotencyKey: 'idem-live-auth-check',
    });
    expect(replayOk.status).toBe(200);
    expect(replayOk.data.artifact.revision).toBe(2);

    // 3. Verify live session revocation rejects idempotent replay over REST (401)
    const savedCookie = alice.cookieHeader;
    const savedCsrf = decodeURIComponent(alice.csrfToken);
    await alice.request('POST', '/api/auth/logout', {});
    const replayAfterLogout = await fetch(`${srv.baseUrl}/api/files/${artifactId}/edit`, {
      method: 'POST',
      headers: {
        cookie: savedCookie,
        'x-csrf-token': savedCsrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        operations: [{ op: 'replace_source', content: '# v2\n' }],
        idempotencyKey: 'idem-live-auth-check',
      }),
    });
    expect(replayAfterLogout.status).toBe(401);

    // 4. Verify live re-check inside ArtifactService rejects replay when session is revoked right after entry
    let sessionAlive = true;
    const assertLive = () => {
      if (!sessionAlive) throw Object.assign(new Error('REVOKED'), { code: 'UNAUTHENTICATED', statusCode: 401 });
    };
    const directReplayOk = await srv.ctx.artifactService.editArtifact({
      userId,
      artifactId,
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: '# v2\n' }],
      actorKind: 'user',
      actorId: userId,
      idempotencyKey: 'idem-live-auth-check',
      assertAuthorized: assertLive,
    });
    expect(directReplayOk.artifact.revision).toBe(2);

    sessionAlive = false;
    await expect(
      srv.ctx.artifactService.editArtifact({
        userId,
        artifactId,
        expectedRevision: 1,
        operations: [{ op: 'replace_source', content: '# v2\n' }],
        actorKind: 'user',
        actorId: userId,
        idempotencyKey: 'idem-live-auth-check',
        assertAuthorized: assertLive,
      })
    ).rejects.toMatchObject({ statusCode: 401 });

    // 5. Log back in, delete the chat, and verify idempotent replay returns 404 (not stale cached result!)
    const loginRes = await alice.request('POST', '/api/auth/login', {
      username: 'auth_reverify_alice',
      password: 'password123',
    });
    expect(loginRes.status).toBe(200);
    await alice.request('DELETE', `/api/chats/${chatId}`);
    const replayAfterDelete = await alice.request('POST', `/api/files/${artifactId}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: '# v2\n' }],
      idempotencyKey: 'idem-live-auth-check',
    });
    expect(replayAfterDelete.status).toBe(404);
  });

  it('Finding #7 (ARCH-08): serves revision-pinned PPTX->PDF from immutable blob with exact cache key and enforces strict strong If-Range comparison', async () => {
    const srv = await createTestServer({ sandboxMode: 'off' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'pptx_pin_alice', 'pptx-code');
    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'PPTX Chat' });
    const chatId = chatRes.data.chat.id;

    // Create rev 1 PPTX and update to rev 2 PPTX
    const rev1Bytes = Buffer.from('PK-PPTX-REV-1-CONTENT', 'utf8');
    const rev2Bytes = Buffer.from('PK-PPTX-REV-2-UPDATED', 'utf8');
    const created = await srv.ctx.artifactService.createArtifact({
      userId,
      scopeKind: 'chat',
      chatId,
      relPath: 'deck.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      content: rev1Bytes,
      actorKind: 'user',
      actorId: userId,
    });
    const artifactId = created.artifact.id;
    const rev1Sha = created.artifact.sha256;

    const updated = await srv.ctx.artifactService.replaceArtifactBytes({
      userId,
      artifactId,
      expectedRevision: 1,
      newBuffer: rev2Bytes,
      actorKind: 'user',
      actorId: userId,
      operationType: 'edit',
      operationSummary: 'Update PPTX rev 2',
    });
    const rev2Sha = updated.artifact.sha256;

    // Intercept PPTX->PDF converter to inspect exact input bytes, staged filename, revision, sha256, and cache key
    const converterCalls: Array<{
      revision: number;
      sourceSha256: string;
      sourceFilename: string;
      sourceAbsPath: string;
      stagedContent: string;
      cacheKey: string;
    }> = [];
    srv.ctx.artifactService.renderCache.setPptxConverterOverrideForTest(async (p) => {
      const stagedContent = fs.readFileSync(p.stagedInputPath, 'utf8');
      converterCalls.push({
        revision: p.revision,
        sourceSha256: p.sourceSha256,
        sourceFilename: p.sourceFilename,
        sourceAbsPath: p.sourceAbsPath,
        stagedContent,
        cacheKey: p.cacheKey,
      });
      fs.writeFileSync(p.tmpTargetPath, `%PDF-1.4\n%rev=${p.revision}:${stagedContent}\n`, 'utf8');
      return true;
    });

    // 1. Revision-pinned `?rev=1&v=<sha12>&converted=pdf` MUST convert rev 1 immutable blob (NOT workspace rev 2)
    const pinPdf1 = await fetch(
      `${srv.baseUrl}/api/files/${artifactId}/content?rev=1&v=${rev1Sha.slice(0, 12)}&converted=pdf`,
      { headers: { cookie: alice.cookieHeader } }
    );
    expect(pinPdf1.status).toBe(200);
    expect(pinPdf1.headers.get('content-type')).toBe('application/pdf');
    expect(pinPdf1.headers.get('x-artifact-revision')).toBe('1');
    expect(pinPdf1.headers.get('cache-control')).toContain('immutable');
    const pinPdf1Body = await pinPdf1.text();
    expect(pinPdf1Body).toContain('%rev=1:PK-PPTX-REV-1-CONTENT');
    expect(converterCalls).toHaveLength(1);
    expect(converterCalls[0].revision).toBe(1);
    expect(converterCalls[0].sourceSha256).toBe(rev1Sha);
    expect(converterCalls[0].sourceFilename).toBe('deck.pptx');
    expect(converterCalls[0].sourceAbsPath).toContain(srv.ctx.config.artifactHistoryRoot);

    // 2. `/revisions/1/content?converted=pdf` MUST hit the exact same render cache entry without re-running converter
    const pinPdf1Direct = await fetch(
      `${srv.baseUrl}/api/files/${artifactId}/revisions/1/content?converted=pdf`,
      { headers: { cookie: alice.cookieHeader } }
    );
    expect(pinPdf1Direct.status).toBe(200);
    expect(await pinPdf1Direct.text()).toBe(pinPdf1Body);
    expect(converterCalls).toHaveLength(1);

    // 3. Unpinned legacy `?converted=pdf` still converts current workspace rev 2 (even without bwrap!)
    const legacyPdf = await fetch(
      `${srv.baseUrl}/api/files/${artifactId}/content?converted=pdf`,
      { headers: { cookie: alice.cookieHeader } }
    );
    expect(legacyPdf.status).toBe(200);
    expect(await legacyPdf.text()).toContain('%rev=2:PK-PPTX-REV-2-UPDATED');
    expect(converterCalls).toHaveLength(2);
    expect(converterCalls[1].revision).toBe(2);
    expect(converterCalls[1].sourceSha256).toBe(rev2Sha);

    // 4. Strict RFC 9110 If-Range comparison: strong ETag -> 206; weak ETag `W/...` -> 200 full body!
    const rawRev1 = await fetch(`${srv.baseUrl}/api/files/${artifactId}/revisions/1/content`, {
      headers: { cookie: alice.cookieHeader },
    });
    const strongEtag = rawRev1.headers.get('etag')!;
    expect(strongEtag.startsWith('"')).toBe(true);

    const strongRange = await fetch(`${srv.baseUrl}/api/files/${artifactId}/revisions/1/content`, {
      headers: { cookie: alice.cookieHeader, range: 'bytes=0-4', 'if-range': strongEtag },
    });
    expect(strongRange.status).toBe(206);
    expect(await strongRange.text()).toBe('PK-PP');

    const weakRange = await fetch(`${srv.baseUrl}/api/files/${artifactId}/revisions/1/content`, {
      headers: { cookie: alice.cookieHeader, range: 'bytes=0-4', 'if-range': `W/${strongEtag}` },
    });
    expect(weakRange.status).toBe(200);
    expect(await weakRange.text()).toBe('PK-PPTX-REV-1-CONTENT');
  });

  it('Finding #8 (SEC-04 / PERF-02): DocWorkerSandbox enforces real kernel RLIMIT_CPU, RLIMIT_FSIZE, RLIMIT_NOFILE, and RLIMIT_NPROC', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rlimit-'));
    cleanups.push(async () => fs.rmSync(tmp, { recursive: true, force: true }));

    const cfg = loadConfig({
      dataRoot: tmp,
      sandboxMode: 'off',
      allowUnsandboxedDocWorkers: true,
    });
    const gov = new ResourceGovernor(cfg, () => 2048);
    const sandbox = new DocWorkerSandbox(cfg, gov);

    // 1. Inspect actual kernel resource.getrlimit() inside the spawned worker process
    const res = await sandbox.run({
      kind: 'python',
      command: 'python3',
      args: [
        '-c',
        "import json, resource; print(json.dumps({k: list(resource.getrlimit(getattr(resource, k))) for k in ['RLIMIT_CPU','RLIMIT_FSIZE','RLIMIT_NOFILE','RLIMIT_NPROC']}))",
      ],
      rlimits: {
        cpuSeconds: 9,
        fsizeBytes: 2 * 1024 * 1024,
        nofile: 128,
        nproc: 256,
      },
    });
    expect(res.exitCode).toBe(0);
    const observed = JSON.parse(res.stdout.trim()) as Record<string, [number, number]>;
    expect(observed.RLIMIT_CPU).toEqual([9, 9]);
    expect(observed.RLIMIT_FSIZE).toEqual([2 * 1024 * 1024, 2 * 1024 * 1024]);
    expect(observed.RLIMIT_NOFILE).toEqual([128, 128]);
    expect(observed.RLIMIT_NPROC).toEqual([256, 256]);
    expect(res.appliedRlimits).toEqual({
      cpuSeconds: 9,
      fsizeBytes: 2 * 1024 * 1024,
      nofile: 128,
      nproc: 256,
    });

    // 2. Prove kernel enforces RLIMIT_FSIZE by rejecting a 256KB file write under a 64KB cap
    const fsizeRes = await sandbox.run({
      kind: 'python',
      command: 'python3',
      args: [
        '-c',
        "import os; p = os.path.join(os.environ['AGY_WORKER_OUT_DIR'], 'big.bin'); f = open(p, 'wb'); f.write(b'x' * (256 * 1024)); f.close()",
      ],
      rlimits: {
        cpuSeconds: 5,
        fsizeBytes: 64 * 1024,
        nofile: 128,
        nproc: 256,
      },
    });
    expect(fsizeRes.exitCode !== 0 || fsizeRes.signal === 'SIGXFSZ').toBe(true);
  });

  it('Remaining #1: recovers deleteProjectFile, syncProjectFilesToChat obsolete removal, and deleteProject consistently after mid-delete crashes (fault injection)', async () => {
    const srv = await createTestServer({ sandboxMode: 'off' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'del_rec_alice', 'delrec-code');
    const projRes = await alice.request<{ project: { id: string; storageDir: string } }>('POST', '/api/projects', {
      name: 'Delete Recovery Project',
    });
    const projectId = projRes.data.project.id;
    const storageDir = projRes.data.project.storageDir;

    // --- 1A. deleteProjectFile fault injection at after_T1 (before unlink) -> aborts cleanly, keeps file & DB ---
    const f1 = await srv.ctx.artifactService.uploadProjectFile({
      userId,
      projectId,
      filename: 'keep-on-t1.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Keep me', 'utf8'),
    });
    srv.ctx.artifactService.commitFaultHook = (stage) => {
      if (stage === 'after_T1') throw new Error('CRASH_DEL_AFTER_T1');
    };
    await expect(
      srv.ctx.artifactService.deleteProjectFile({ userId, projectId, fileId: f1.file.id })
    ).rejects.toThrow('CRASH_DEL_AFTER_T1');
    srv.ctx.artifactService.commitFaultHook = undefined;

    const rT1 = await srv.ctx.artifactService.recoverOnStartup();
    expect(rT1.commits.aborted).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(storageDir, f1.file.relPath))).toBe(true);
    expect(srv.ctx.db.getProjectFileById(userId, projectId, f1.file.id)).not.toBeNull();
    expect(srv.ctx.db.getArtifact(userId, f1.artifact.id)).not.toBeNull();

    // --- 1B. deleteProjectFile fault injection at after_T4 (after unlink, before T5/T6 DB tx) -> rolls forward cleanly ---
    srv.ctx.artifactService.commitFaultHook = (stage) => {
      if (stage === 'after_T4') throw new Error('CRASH_DEL_AFTER_T4');
    };
    await expect(
      srv.ctx.artifactService.deleteProjectFile({ userId, projectId, fileId: f1.file.id })
    ).rejects.toThrow('CRASH_DEL_AFTER_T4');
    srv.ctx.artifactService.commitFaultHook = undefined;

    // Immediately after crash: file is already gone on disk, DB still has project_file & active artifact
    expect(fs.existsSync(path.join(storageDir, f1.file.relPath))).toBe(false);
    expect(srv.ctx.db.getProjectFileById(userId, projectId, f1.file.id)).not.toBeNull();
    expect(srv.ctx.db.getArtifact(userId, f1.artifact.id)).not.toBeNull();

    const rT4 = await srv.ctx.artifactService.recoverOnStartup();
    expect(rT4.commits.rolledForward).toBeGreaterThanOrEqual(1);
    expect(srv.ctx.db.getProjectFileById(userId, projectId, f1.file.id)).toBeNull();
    expect(srv.ctx.db.getArtifact(userId, f1.artifact.id)).toBeNull();
    const delFileEvents = srv.ctx.db.db
      .prepare("SELECT event_type, payload_json FROM sync_events WHERE user_id = ? AND event_type = 'artifact.deleted'")
      .all(userId) as Array<{ event_type: string; payload_json: string }>;
    expect(delFileEvents.some((e) => e.payload_json.includes(f1.artifact.id))).toBe(true);

    // --- 1C. syncProjectFilesToChat obsolete removal crash at after_T4 -> rolls forward + propagates dep update ---
    const f2 = await srv.ctx.artifactService.uploadProjectFile({
      userId,
      projectId,
      filename: 'sync-ref.css',
      mimeType: 'text/css',
      buffer: Buffer.from('body { color: green; }', 'utf8'),
    });
    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'Sync Crash Chat',
      projectId,
    });
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    const parentRes = await alice.request<{ artifact: { id: string; revision: number } }>(
      'POST',
      `/api/chats/${chatId}/artifacts`,
      { relPath: 'view.html', content: '<link rel="stylesheet" href=".project-context/sync-ref.css"><p>v1</p>' }
    );
    const parentId = parentRes.data.artifact.id;
    const parentBefore = srv.ctx.db.getArtifact(userId, parentId)!;
    expect(parentBefore.dependencyManifestHash).toBeTruthy();

    // Delete from project normally, then crash mid-sync deletion at after_T4
    await srv.ctx.artifactService.deleteProjectFile({ userId, projectId, fileId: f2.file.id });
    srv.ctx.artifactService.commitFaultHook = (stage) => {
      if (stage === 'after_T4') throw new Error('CRASH_SYNC_DEL_AFTER_T4');
    };
    await expect(
      srv.ctx.artifactService.syncProjectFilesToChat({ userId, projectId, chatId })
    ).rejects.toThrow('CRASH_SYNC_DEL_AFTER_T4');
    srv.ctx.artifactService.commitFaultHook = undefined;

    const ctxArtBefore = srv.ctx.db.findArtifactByRelPath(userId, chatId, '.project-context/sync-ref.css');
    expect(fs.existsSync(path.join(workspaceDir, '.project-context', 'sync-ref.css'))).toBe(false);
    expect(ctxArtBefore).not.toBeNull();

    const rSync = await srv.ctx.artifactService.recoverOnStartup();
    expect(rSync.commits.rolledForward).toBeGreaterThanOrEqual(1);
    expect(srv.ctx.db.findArtifactByRelPath(userId, chatId, '.project-context/sync-ref.css')).toBeNull();
    const parentAfter = srv.ctx.db.getArtifact(userId, parentId)!;
    expect(parentAfter.revision).toBeGreaterThan(parentBefore.revision);

    // --- 1D. deleteProject crash at after_T4 (after subtree removal, before DB deletion) -> rolls forward cleanly ---
    const f3 = await srv.ctx.artifactService.uploadProjectFile({
      userId,
      projectId,
      filename: 'final.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Final', 'utf8'),
    });
    srv.ctx.artifactService.commitFaultHook = (stage) => {
      if (stage === 'after_T4') throw new Error('CRASH_PROJ_DEL_AFTER_T4');
    };
    await expect(
      srv.ctx.artifactService.deleteProject({ userId, projectId })
    ).rejects.toThrow('CRASH_PROJ_DEL_AFTER_T4');
    srv.ctx.artifactService.commitFaultHook = undefined;

    expect(fs.existsSync(path.dirname(storageDir))).toBe(false);
    expect(srv.ctx.db.getProject(userId, projectId)).not.toBeNull();

    const rProj = await srv.ctx.artifactService.recoverOnStartup();
    expect(rProj.commits.rolledForward).toBeGreaterThanOrEqual(1);
    expect(srv.ctx.db.getProject(userId, projectId)).toBeNull();
    expect(srv.ctx.db.getArtifact(userId, f3.artifact.id)).toBeNull();
    const projEvents = srv.ctx.db.db
      .prepare("SELECT event_type, payload_json FROM sync_events WHERE user_id = ? AND event_type IN ('artifact.deleted', 'project.deleted')")
      .all(userId) as Array<{ event_type: string; payload_json: string }>;
    expect(projEvents.some((e) => e.event_type === 'artifact.deleted' && e.payload_json.includes(f3.artifact.id))).toBe(true);
    expect(projEvents.some((e) => e.event_type === 'project.deleted' && e.payload_json.includes(projectId))).toBe(true);
  });

  it('Remaining #2: keeps Revision sha256, size_bytes, blob, and dependency_manifest_hash consistent when normal ACP externally modifies parent during dependency propagation', async () => {
    const srv = await createTestServer({ sandboxMode: 'off' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'dep_cons_alice', 'depcons-code');
    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'Dep Consistency Chat',
    });
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    const cssRes = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'style.css',
      content: 'h1 { color: black; }',
    });
    const cssId = cssRes.data.artifact.id;

    const htmlRes = await alice.request<{ artifact: { id: string } }>('POST', `/api/chats/${chatId}/artifacts`, {
      relPath: 'index.html',
      content: '<link rel="stylesheet" href="style.css"><h1>Original</h1>',
    });
    const htmlId = htmlRes.data.artifact.id;

    // Simulate unrestricted normal ACP external write directly modifying parent index.html on disk
    const externalParentHtml = '<link rel="stylesheet" href="style.css"><h1>Modified Externally By ACP with Extra Text</h1>';
    const externalParentBuf = Buffer.from(externalParentHtml, 'utf8');
    const externalParentSha = sha256(externalParentBuf);
    fs.writeFileSync(path.join(workspaceDir, 'index.html'), externalParentBuf);

    // Now edit child style.css via ArtifactService -> triggers drainDepPropagationQueue for index.html
    const editCss = await alice.request<{ artifact: { sha256: string } }>('POST', `/api/files/${cssId}/edit`, {
      expectedRevision: 1,
      operations: [{ op: 'replace_source', content: 'h1 { color: rebeccapurple; }' }],
    });
    expect(editCss.status).toBe(200);
    const newCssSha = editCss.data.artifact.sha256;

    // Verify artifacts row, latest artifact_revisions row, stored blob bytes, and artifact_revision_deps are 100% mutually consistent
    const parentAfter = srv.ctx.db.getArtifact(userId, htmlId)!;
    expect(parentAfter.revision).toBeGreaterThanOrEqual(2);
    expect(parentAfter.sha256).toBe(externalParentSha);
    expect(parentAfter.sizeBytes).toBe(externalParentBuf.length);
    expect(parentAfter.dependencyManifestHash).toBeTruthy();

    const revRows = srv.ctx.db.db
      .prepare('SELECT revision, sha256, size_bytes, blob_sha256, dependency_manifest_hash, operation_type FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision ASC')
      .all(htmlId) as Array<{
        revision: number;
        sha256: string;
        size_bytes: number;
        blob_sha256: string;
        dependency_manifest_hash: string | null;
        operation_type: string;
      }>;
    expect(revRows.length).toBeGreaterThanOrEqual(2);

    // Every single revision's metadata MUST exactly match its stored immutable blob bytes!
    for (const r of revRows) {
      const blobPath = srv.ctx.artifactService.blobManager.getBlobPath(userId, r.blob_sha256);
      const blobBytes = fs.readFileSync(blobPath);
      expect(r.sha256).toBe(r.blob_sha256);
      expect(sha256(blobBytes)).toBe(r.sha256);
      expect(blobBytes.length).toBe(r.size_bytes);
    }

    const latestRev = revRows[revRows.length - 1];
    expect(latestRev.revision).toBe(parentAfter.revision);
    expect(latestRev.sha256).toBe(externalParentSha);
    expect(latestRev.size_bytes).toBe(externalParentBuf.length);
    expect(latestRev.dependency_manifest_hash).toBe(parentAfter.dependencyManifestHash);

    const depRow = srv.ctx.db.db
      .prepare('SELECT sha256 FROM artifact_revision_deps WHERE artifact_id = ? AND revision = ? AND rel_path = ?')
      .get(htmlId, latestRev.revision, 'style.css') as { sha256: string } | undefined;
    expect(depRow?.sha256).toBe(newCssSha);

    // Serving the pinned latest revision returns the exact external bytes
    const pinnedRes = await fetch(`${srv.baseUrl}/api/files/${htmlId}/revisions/${latestRev.revision}/content`, {
      headers: { cookie: alice.cookieHeader },
    });
    expect(pinnedRes.status).toBe(200);
    expect(await pinnedRes.text()).toBe(externalParentHtml);
  });

  it('Remaining #3: preserves native ACP response content and completed status when Artifact ingestion intentionally fails', async () => {
    const srv = await createTestServer({ sandboxMode: 'off' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'acp_trans_alice', 'acptrans-code');
    await alice.connectWs();
    cleanups.push(async () => alice.closeWs());

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'ACP Transparency Chat',
    });
    const chatId = chatRes.data.chat.id;

    // Intentionally fail ArtifactService.ingestWorkspaceFile to simulate lock contention / FS / dep errors
    const origIngest = srv.ctx.artifactService.ingestWorkspaceFile.bind(srv.ctx.artifactService);
    let ingestAttempts = 0;
    srv.ctx.artifactService.ingestWorkspaceFile = (async () => {
      ingestAttempts += 1;
      throw new Error('INJECTED_ARTIFACT_INGEST_FAILURE');
    }) as typeof srv.ctx.artifactService.ingestWorkspaceFile;

    try {
      // Trigger a normal mock ACP turn that creates a workspace file and returns end_turn
      const sendRes = await alice.request('POST', `/api/chats/${chatId}/messages`, {
        text: '[ARTIFACT] Please write output and reply normally.',
      });
      expect(sendRes.status).toBe(202);

      const finishedFrame = await alice.waitForFrame(
        (frame) => frame.kind === 'event' && (frame.event as { type?: string })?.type === 'run.finished',
        15_000
      );
      const finishedPayload = (finishedFrame.event as { payload?: { status?: string; stopReason?: string } }).payload;
      expect(finishedPayload?.status).not.toBe('error');

      // Inspect persisted assistant message: MUST stay completed with native ACP content & no errorMessage
      const detail = await alice.request<{
        messages: Array<{ role: string; status: string; contentText: string; errorMessage: string | null }>;
      }>('GET', `/api/chats/${chatId}`);
      expect(detail.status).toBe(200);
      const assistant = detail.data.messages.find((m) => m.role === 'assistant');
      expect(assistant).toBeDefined();
      expect(assistant!.status).toBe('completed');
      expect(assistant!.errorMessage).toBeNull();
      expect(assistant!.contentText.length).toBeGreaterThan(0);

      // Verify Artifact ingestion WAS attempted, failed, and was recorded separately as artifact.sync_error
      expect(ingestAttempts).toBeGreaterThan(0);
      const syncErrEvents = srv.ctx.db.db
        .prepare("SELECT event_type, payload_json FROM sync_events WHERE user_id = ? AND chat_id = ? AND event_type = 'artifact.sync_error'")
        .all(userId, chatId) as Array<{ event_type: string; payload_json: string }>;
      expect(syncErrEvents.length).toBeGreaterThanOrEqual(1);
      expect(syncErrEvents[0].payload_json).toContain('INJECTED_ARTIFACT_INGEST_FAILURE');
    } finally {
      srv.ctx.artifactService.ingestWorkspaceFile = origIngest;
    }
  });

  it('Delete Recovery Identity & Partial Deletion: distinguishes deleted, intact, partially_deleted, externally_recreated, and indeterminate without ever deleting recreated or indeterminate targets', async () => {
    const srv = await createTestServer({ sandboxMode: 'off' });
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'del_id_alice', 'delid-code');

    // Helper: create a project with files
    const projRes = await alice.request<{ project: { id: string; storageDir: string } }>('POST', '/api/projects', {
      name: 'Delete Identity Project',
    });
    expect(projRes.status).toBe(201);
    const projectId = projRes.data.project.id;
    const storageDir = projRes.data.project.storageDir;

    // 1. External recreation AFTER file deletion (crash at after_T5 / state='file_replaced')
    const up1 = await srv.ctx.artifactService.uploadProjectFile({
      userId,
      projectId,
      filename: 'recreate-t5.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('original-v1-before-t5', 'utf8'),
    });
    const f1Path = path.join(storageDir, up1.file.relPath);
    srv.ctx.artifactService.commitFaultHook = async (stage) => {
      if (stage === 'after_T5') throw new Error('CRASH_AFTER_T5_FILE');
    };
    await expect(
      srv.ctx.artifactService.deleteProjectFile({ userId, projectId, fileId: up1.file.id })
    ).rejects.toThrow('CRASH_AFTER_T5_FILE');
    srv.ctx.artifactService.commitFaultHook = undefined;
    expect(fs.existsSync(f1Path)).toBe(false);

    // External actor creates a brand-new file at the exact same path before recovery runs
    fs.writeFileSync(f1Path, 'BRAND_NEW_EXTERNAL_FILE_AFTER_T5', 'utf8');

    const rec1 = await srv.ctx.artifactService.recoverOnStartup();
    expect(rec1.commits.rolledForward).toBe(1);
    expect(rec1.commits.quarantined).toBe(0);
    // Old DB record finalized deleted, yet externally recreated file on disk MUST be preserved intact!
    expect(srv.ctx.db.getProjectFileById(userId, projectId, up1.file.id)).toBeNull();
    expect(srv.ctx.db.getArtifact(userId, up1.artifact.id)).toBeNull();
    const art1Row = srv.ctx.db.db
      .prepare('SELECT lifecycle_state FROM artifacts WHERE id = ?')
      .get(up1.artifact.id) as { lifecycle_state: string } | undefined;
    expect(art1Row?.lifecycle_state).toBe('deleted');
    expect(fs.existsSync(f1Path)).toBe(true);
    expect(fs.readFileSync(f1Path, 'utf8')).toBe('BRAND_NEW_EXTERNAL_FILE_AFTER_T5');
    fs.unlinkSync(f1Path);

    // 2. External recreation during 'replacing' (crash at after_T4) -> MUST quarantine and preserve new file
    const up2 = await srv.ctx.artifactService.uploadProjectFile({
      userId,
      projectId,
      filename: 'recreate-t4.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('original-v1-before-t4', 'utf8'),
    });
    const f2Path = path.join(storageDir, up2.file.relPath);
    srv.ctx.artifactService.commitFaultHook = async (stage) => {
      if (stage === 'after_T4') throw new Error('CRASH_AFTER_T4_FILE');
    };
    await expect(
      srv.ctx.artifactService.deleteProjectFile({ userId, projectId, fileId: up2.file.id })
    ).rejects.toThrow('CRASH_AFTER_T4_FILE');
    srv.ctx.artifactService.commitFaultHook = undefined;
    expect(fs.existsSync(f2Path)).toBe(false);

    // External actor writes a brand-new file at the same path
    fs.writeFileSync(f2Path, 'RECREATED_DURING_REPLACING', 'utf8');

    const rec2 = await srv.ctx.artifactService.recoverOnStartup();
    expect(rec2.commits.quarantined).toBe(1);
    expect(rec2.commits.rolledForward).toBe(0);
    expect(fs.existsSync(f2Path)).toBe(true);
    expect(fs.readFileSync(f2Path, 'utf8')).toBe('RECREATED_DURING_REPLACING');
    const qRow2 = srv.ctx.db.db
      .prepare("SELECT state, audit_note FROM artifact_commit_journal WHERE artifact_id = ? AND state = 'ambiguous_quarantined'")
      .get(up2.artifact.id) as { state: string; audit_note: string } | undefined;
    expect(qRow2?.state).toBe('ambiguous_quarantined');
    expect(qRow2?.audit_note).toMatch(/^delete_replacing_(externally_recreated|indeterminate):/);

    // 3. Indeterminate target (missing T1 identity snapshot while file exists) -> MUST quarantine, NEVER delete
    const up3 = await srv.ctx.artifactService.uploadProjectFile({
      userId,
      projectId,
      filename: 'indeterminate-file.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('must-not-be-blindly-deleted', 'utf8'),
    });
    const f3Path = path.join(storageDir, up3.file.relPath);
    srv.ctx.artifactService.commitFaultHook = async (stage) => {
      if (stage === 'after_T3') throw new Error('CRASH_AFTER_T3_INDET');
    };
    await expect(
      srv.ctx.artifactService.deleteProjectFile({ userId, projectId, fileId: up3.file.id })
    ).rejects.toThrow('CRASH_AFTER_T3_INDET');
    srv.ctx.artifactService.commitFaultHook = undefined;

    // Strip targetIdentity from the journal payload to simulate an indeterminate/legacy journal entry
    const j3 = srv.ctx.db.db
      .prepare("SELECT commit_id, operation_payload_json FROM artifact_commit_journal WHERE artifact_id = ? AND state = 'replacing'")
      .get(up3.artifact.id) as { commit_id: string; operation_payload_json: string };
    const strippedPayload = JSON.parse(j3.operation_payload_json) as Record<string, unknown>;
    delete strippedPayload.targetIdentity;
    srv.ctx.db.db
      .prepare('UPDATE artifact_commit_journal SET operation_payload_json = ? WHERE commit_id = ?')
      .run(JSON.stringify(strippedPayload), j3.commit_id);

    const rec3 = await srv.ctx.artifactService.recoverOnStartup();
    expect(rec3.commits.quarantined).toBe(1);
    expect(rec3.commits.rolledForward).toBe(0);
    expect(fs.existsSync(f3Path)).toBe(true);
    expect(fs.readFileSync(f3Path, 'utf8')).toBe('must-not-be-blindly-deleted');

    // 4. Directory partial deletion (deleteChat): some files removed, directory + other files remain
    const chatPartRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'Partial Delete Chat',
    });
    const chatPartId = chatPartRes.data.chat.id;
    const chatPartWs = chatPartRes.data.chat.workspaceDir;
    fs.writeFileSync(path.join(chatPartWs, 'first.txt'), 'first-file', 'utf8');
    fs.mkdirSync(path.join(chatPartWs, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(chatPartWs, 'nested', 'second.txt'), 'second-file', 'utf8');

    // First verify untouched intact directory at after_T3 aborts cleanly without deleting anything
    srv.ctx.artifactService.commitFaultHook = async (stage) => {
      if (stage === 'after_T3') throw new Error('CRASH_CHAT_INTACT_T3');
    };
    await expect(srv.ctx.artifactService.deleteChat({ userId, chatId: chatPartId })).rejects.toThrow('CRASH_CHAT_INTACT_T3');
    srv.ctx.artifactService.commitFaultHook = undefined;
    const recIntact = await srv.ctx.artifactService.recoverOnStartup();
    expect(recIntact.commits.aborted).toBe(1);
    expect(recIntact.commits.rolledForward).toBe(0);
    expect(fs.existsSync(path.join(chatPartWs, 'first.txt'))).toBe(true);
    expect(fs.existsSync(path.join(chatPartWs, 'nested', 'second.txt'))).toBe(true);
    expect(srv.ctx.db.getChat(userId, chatPartId)).not.toBeNull();

    // Now simulate mid-way partial directory deletion (first.txt removed, nested/second.txt & workspaceDir remain)
    srv.ctx.artifactService.commitFaultHook = async (stage) => {
      if (stage === 'before_T4') {
        fs.unlinkSync(path.join(chatPartWs, 'first.txt'));
        throw new Error('CRASH_MID_DIR_DELETE');
      }
    };
    await expect(srv.ctx.artifactService.deleteChat({ userId, chatId: chatPartId })).rejects.toThrow('CRASH_MID_DIR_DELETE');
    srv.ctx.artifactService.commitFaultHook = undefined;
    // Directory still exists on disk, so existence alone would have misclassified this as intact!
    expect(fs.existsSync(chatPartWs)).toBe(true);
    expect(fs.existsSync(path.join(chatPartWs, 'nested', 'second.txt'))).toBe(true);

    const recPartial = await srv.ctx.artifactService.recoverOnStartup();
    expect(recPartial.commits.rolledForward).toBe(1);
    expect(recPartial.commits.aborted).toBe(0);
    expect(recPartial.commits.quarantined).toBe(0);
    expect(fs.existsSync(chatPartWs)).toBe(false);
    expect(srv.ctx.db.getChat(userId, chatPartId)).toBeNull();

    // 5. Directory partial deletion + external new file creation -> MUST classify indeterminate, quarantine & preserve new file
    const chatMixRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'Partial Plus External Chat',
    });
    const chatMixId = chatMixRes.data.chat.id;
    const chatMixWs = chatMixRes.data.chat.workspaceDir;
    fs.writeFileSync(path.join(chatMixWs, 'old-a.txt'), 'old-a', 'utf8');
    fs.writeFileSync(path.join(chatMixWs, 'old-b.txt'), 'old-b', 'utf8');

    srv.ctx.artifactService.commitFaultHook = async (stage) => {
      if (stage === 'before_T4') {
        fs.unlinkSync(path.join(chatMixWs, 'old-a.txt'));
        throw new Error('CRASH_MID_DIR_BEFORE_EXTERNAL');
      }
    };
    await expect(srv.ctx.artifactService.deleteChat({ userId, chatId: chatMixId })).rejects.toThrow('CRASH_MID_DIR_BEFORE_EXTERNAL');
    srv.ctx.artifactService.commitFaultHook = undefined;

    // External actor creates a brand-new file inside the partially deleted directory
    fs.writeFileSync(path.join(chatMixWs, 'external-new.txt'), 'DO_NOT_DELETE_ME', 'utf8');

    const recMix = await srv.ctx.artifactService.recoverOnStartup();
    expect(recMix.commits.quarantined).toBe(1);
    expect(recMix.commits.rolledForward).toBe(0);
    expect(fs.existsSync(path.join(chatMixWs, 'external-new.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(chatMixWs, 'external-new.txt'), 'utf8')).toBe('DO_NOT_DELETE_ME');
    expect(fs.existsSync(path.join(chatMixWs, 'old-b.txt'))).toBe(true);

    // 6. External recreation of a deleted directory AFTER T5 (deleteChat at after_T5 / file_replaced)
    const chatRecRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'Recreated Dir Chat',
    });
    const chatRecId = chatRecRes.data.chat.id;
    const chatRecWs = chatRecRes.data.chat.workspaceDir;
    fs.writeFileSync(path.join(chatRecWs, 'legacy.txt'), 'legacy', 'utf8');

    srv.ctx.artifactService.commitFaultHook = async (stage) => {
      if (stage === 'after_T5') throw new Error('CRASH_CHAT_AFTER_T5');
    };
    await expect(srv.ctx.artifactService.deleteChat({ userId, chatId: chatRecId })).rejects.toThrow('CRASH_CHAT_AFTER_T5');
    srv.ctx.artifactService.commitFaultHook = undefined;
    expect(fs.existsSync(chatRecWs)).toBe(false);

    // External actor recreates the directory with brand-new content
    fs.mkdirSync(chatRecWs, { recursive: true });
    fs.writeFileSync(path.join(chatRecWs, 'fresh-after-delete.txt'), 'FRESH_DIR_CONTENT', 'utf8');

    const recDirRecreate = await srv.ctx.artifactService.recoverOnStartup();
    expect(recDirRecreate.commits.rolledForward).toBe(1);
    expect(recDirRecreate.commits.quarantined).toBe(0);
    expect(srv.ctx.db.getChat(userId, chatRecId)).toBeNull();
    expect(fs.existsSync(path.join(chatRecWs, 'fresh-after-delete.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(chatRecWs, 'fresh-after-delete.txt'), 'utf8')).toBe('FRESH_DIR_CONTENT');

    // 7. Directory partial deletion for deleteProject
    const projPartRes = await alice.request<{ project: { id: string; storageDir: string } }>('POST', '/api/projects', {
      name: 'Partial Delete Project',
    });
    const projPartId = projPartRes.data.project.id;
    const projPartStorage = projPartRes.data.project.storageDir;
    const projPartDir = path.dirname(projPartStorage);
    const pA = await srv.ctx.artifactService.uploadProjectFile({
      userId,
      projectId: projPartId,
      filename: 'part-a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('proj-part-a', 'utf8'),
    });
    await srv.ctx.artifactService.uploadProjectFile({
      userId,
      projectId: projPartId,
      filename: 'part-b.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('proj-part-b', 'utf8'),
    });

    srv.ctx.artifactService.commitFaultHook = async (stage) => {
      if (stage === 'before_T4') {
        fs.unlinkSync(path.join(projPartStorage, pA.file.relPath));
        throw new Error('CRASH_MID_PROJECT_DELETE');
      }
    };
    await expect(srv.ctx.artifactService.deleteProject({ userId, projectId: projPartId })).rejects.toThrow('CRASH_MID_PROJECT_DELETE');
    srv.ctx.artifactService.commitFaultHook = undefined;
    expect(fs.existsSync(projPartDir)).toBe(true);

    const recProjPartial = await srv.ctx.artifactService.recoverOnStartup();
    expect(recProjPartial.commits.rolledForward).toBe(1);
    expect(recProjPartial.commits.aborted).toBe(0);
    expect(recProjPartial.commits.quarantined).toBe(0);
    expect(fs.existsSync(projPartDir)).toBe(false);
    expect(srv.ctx.db.getProject(userId, projPartId)).toBeNull();
  });
});

