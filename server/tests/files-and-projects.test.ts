import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

describe('Workspaces, Project Isolation, Artifacts, Path Containment & Sandbox', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('copies project files cleanly with copy-on-write isolation and explicit sync-project', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs({ clientId: 'alice-ws' });

    const projRes = await alice.request<{ project: { id: string; contextVersion: number; storageDir: string } }>(
      'POST',
      '/api/projects',
      {
        name: 'Research Project',
        instructions: 'INSTRUCTIONS_V1',
      }
    );
    const projectId = projRes.data.project.id;

    // Upload a reference file to the project
    const fd = new FormData();
    fd.append('files', new Blob(['Spec Content V1\n'], { type: 'text/plain' }), 'spec.txt');
    const upRes = await alice.request<{ project: { contextVersion: number } }>(
      'POST',
      `/api/projects/${projectId}/files`,
      fd
    );
    expect(upRes.status).toBe(201);

    const chat1 = await alice.request<{ chat: { id: string; workspaceDir: string; projectContextVersion: number } }>(
      'POST',
      '/api/chats',
      { title: 'Chat 1', projectId }
    );
    const chat2 = await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST',
      '/api/chats',
      { title: 'Chat 2', projectId }
    );

    // Send prompt checking context in Chat 1
    await alice.request('POST', `/api/chats/${chat1.data.chat.id}/messages`, {
      text: 'Confirm context [CONTEXT_CHECK]',
    });
    const done1 = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; chatId?: string }).type === 'run.finished' &&
        (f.event as { chatId?: string }).chatId === chat1.data.chat.id
    );
    const msg1 = ((done1.event as { payload: { message: { contentText: string } } }).payload.message).contentText;
    expect(msg1).toContain('INSTRUCTIONS_V1');
    expect(msg1).toContain('Spec Content V1');

    // Simulate mutating `.project-context/spec.txt` inside Chat 1 workspace -> must NOT affect Project original or Chat 2!
    fs.writeFileSync(path.join(chat1.data.chat.workspaceDir, '.project-context', 'spec.txt'), 'MUTATED IN CHAT 1');
    expect(fs.readFileSync(path.join(projRes.data.project.storageDir, 'spec.txt'), 'utf8')).toBe('Spec Content V1\n');
    expect(
      fs.readFileSync(path.join(chat2.data.chat.workspaceDir, '.project-context', 'spec.txt'), 'utf8')
    ).toBe('Spec Content V1\n');

    // Update project instructions to V2 & upload v2 doc -> contextVersion bumps
    const updatedProj = await alice.request<{ project: { contextVersion: number } }>(
      'PATCH',
      `/api/projects/${projectId}`,
      { instructions: 'INSTRUCTIONS_V2' }
    );
    expect(updatedProj.data.project.contextVersion).toBeGreaterThan(chat1.data.chat.projectContextVersion);

    const fd2 = new FormData();
    fd2.append('files', new Blob(['Extra Doc V2\n'], { type: 'text/plain' }), 'notes-v2.txt');
    await alice.request('POST', `/api/projects/${projectId}/files`, fd2);

    // Explicitly synchronize Chat 1
    const synced = await alice.request<{ chat: { projectContextVersion: number } }>(
      'POST',
      `/api/chats/${chat1.data.chat.id}/sync-project`
    );
    expect(synced.status).toBe(200);
    expect(synced.data.chat.projectContextVersion).toBeGreaterThan(chat1.data.chat.projectContextVersion);

    // Next turn in Chat 1 picks up INSTRUCTIONS_V2, notes-v2.txt, AND preserves previous turn via transcript bridge
    await alice.request('POST', `/api/chats/${chat1.data.chat.id}/messages`, {
      text: 'Verify after sync [CONTEXT_CHECK]',
    });
    const done2 = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; chatId?: string }).type === 'run.finished' &&
        (f.event as { payload: { message: { contentText: string } } }).payload.message.contentText.includes(
          'Verify after sync'
        ),
      8000,
      true
    );
    const msg2 = ((done2.event as { payload: { message: { contentText: string } } }).payload.message).contentText;
    expect(msg2).toContain('INSTRUCTIONS_V2');
    expect(msg2).toContain('Extra Doc V2');

    alice.closeWs();
  });

  it('blocks path traversal & symlink escape while supporting artifacts, diff patches, Range streaming, and CSP HTML sandbox', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'Artifacts Chat',
    });
    const chatId = chatRes.data.chat.id;

    // Create symlink inside workspace pointing outside workspace (`/etc/hosts`)
    const symlinkPath = path.join(chatRes.data.chat.workspaceDir, 'escape-link.txt');
    fs.symlinkSync('/etc/hosts', symlinkPath);

    // Traversal and symlink escape attempts MUST return 404 from resolve-link
    expect((await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: '../../etc/passwd' })).status).toBe(404);
    expect((await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: '/etc/passwd' })).status).toBe(404);
    expect((await alice.request('POST', `/api/chats/${chatId}/resolve-link`, { reference: 'escape-link.txt' })).status).toBe(404);

    // Generate real artifacts in workspace via [ARTIFACT]
    await alice.request('POST', `/api/chats/${chatId}/messages`, { text: 'Build deliverables [ARTIFACT]' });
    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const resolvedMd = await alice.request<{ artifact: { id: string; diffPatch: string | null } }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: './summary.md#L1' }
    );
    expect(resolvedMd.status).toBe(200);
    expect(resolvedMd.data.artifact.diffPatch).toContain('+# Summary Report');

    // HTTP Byte Range test on generated metrics.csv
    const resolvedCsv = await alice.request<{ artifact: { id: string } }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: 'metrics.csv' }
    );
    const rangeRes = await alice.request<string>(
      'GET',
      `/api/files/${resolvedCsv.data.artifact.id}/content`,
      undefined,
      { headers: { Range: 'bytes=0-11' } }
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toMatch(/^bytes 0-11\/\d+$/);
    expect(rangeRes.data).toBe('metric,value');

    // Sandbox HTML endpoint enforces strict CSP
    const resolvedHtml = await alice.request<{ artifact: { id: string } }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: 'widget.html' }
    );
    const sandboxRes = await alice.request<string>(
      'GET',
      `/api/files/${resolvedHtml.data.artifact.id}/sandbox`
    );
    expect(sandboxRes.status).toBe(200);
    expect(sandboxRes.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(sandboxRes.data).toContain('Isolated Preview');

    alice.closeWs();
  });

  it('supports ETag/Last-Modified 304 validation, ?v= cache headers, Range precedence, disk-staleness detection, and cross-user isolation', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const { client: bob } = await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'HTTP Cache Chat',
    });
    const chatId = chatRes.data.chat.id;

    await alice.request('POST', `/api/chats/${chatId}/messages`, { text: 'Build deliverables [ARTIFACT]' });
    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const resolved = await alice.request<{
      artifact: { id: string; sha256: string; relPath: string };
      previewUrl: string;
      downloadUrl: string;
    }>('POST', `/api/chats/${chatId}/resolve-link`, { reference: 'summary.md' });
    expect(resolved.status).toBe(200);
    const art = resolved.data.artifact;
    expect(art.sha256).toMatch(/^[a-f0-9]{64}$/);
    const shortV = art.sha256.slice(0, 12);
    expect(resolved.data.previewUrl).toBe(`/api/files/${art.id}/content?v=${shortV}`);
    expect(resolved.data.downloadUrl).toBe(`/api/files/${art.id}/content?download=1`);

    // 1. Versioned request receives private 5m cache + strong ETag + Last-Modified + Vary: Cookie
    const versionedRes = await alice.request<string>('GET', `/api/files/${art.id}/content?v=${shortV}`);
    expect(versionedRes.status).toBe(200);
    const etag = versionedRes.headers.get('etag');
    const lastModified = versionedRes.headers.get('last-modified');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(lastModified).toBeTruthy();
    expect(versionedRes.headers.get('vary')).toContain('Cookie');
    expect(versionedRes.headers.get('cache-control')).toBe('private, max-age=300, stale-while-revalidate=3600');

    // 2. Conditional 304 via If-None-Match (exact strong ETag, even with stale If-Modified-Since per RFC 9110)
    const notModInm = await alice.request<string>('GET', `/api/files/${art.id}/content?v=${shortV}`, undefined, {
      headers: {
        'If-None-Match': etag!,
        'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT',
      },
    });
    expect(notModInm.status).toBe(304);
    expect(notModInm.data).toBe('');
    expect(notModInm.headers.get('etag')).toBe(etag);
    expect(notModInm.headers.get('vary')).toContain('Cookie');

    // 3. Mismatched If-None-Match overrides matching If-Modified-Since (must return 200)
    const mismatchInm = await alice.request<string>('GET', `/api/files/${art.id}/content?v=${shortV}`, undefined, {
      headers: {
        'If-None-Match': '"wrong-etag"',
        'If-Modified-Since': lastModified!,
      },
    });
    expect(mismatchInm.status).toBe(200);

    // 4. Unversioned request downgrades to must-revalidate and supports If-Modified-Since 304
    const unversionedRes = await alice.request<string>('GET', `/api/files/${art.id}/content`);
    expect(unversionedRes.status).toBe(200);
    expect(unversionedRes.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');

    const notModIms = await alice.request<string>('GET', `/api/files/${art.id}/content`, undefined, {
      headers: { 'If-Modified-Since': lastModified! },
    });
    expect(notModIms.status).toBe(304);

    // 5. Range request bypasses 304 and serves 206 Partial Content
    const rangeWithInm = await alice.request<string>('GET', `/api/files/${art.id}/content?v=${shortV}`, undefined, {
      headers: {
        'If-None-Match': etag!,
        Range: 'bytes=0-8',
      },
    });
    expect(rangeWithInm.status).toBe(206);
    expect(rangeWithInm.data).toBe('# Summary');

    // 6. Cross-user isolation MUST still reject with 404 even when supplying valid ETag & ?v=
    const bobProbe = await bob.request('GET', `/api/files/${art.id}/content?v=${shortV}`, undefined, {
      headers: { 'If-None-Match': etag! },
    });
    expect(bobProbe.status).toBe(404);

    // 7. Sandbox endpoint supports ?v= cache, ETag, 304, and preserves CSP on 304
    const resolvedHtml = await alice.request<{ artifact: { id: string; sha256: string } }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: 'widget.html' }
    );
    const htmlArt = resolvedHtml.data.artifact;
    const htmlV = htmlArt.sha256.slice(0, 12);
    const sb200 = await alice.request<string>('GET', `/api/files/${htmlArt.id}/sandbox?v=${htmlV}`);
    expect(sb200.status).toBe(200);
    expect(sb200.headers.get('cache-control')).toBe('private, max-age=300, stale-while-revalidate=3600');
    const sbEtag = sb200.headers.get('etag')!;
    expect(sbEtag).toBeTruthy();

    const sb304 = await alice.request<string>('GET', `/api/files/${htmlArt.id}/sandbox?v=${htmlV}`, undefined, {
      headers: { 'If-None-Match': sbEtag },
    });
    expect(sb304.status).toBe(304);
    expect(sb304.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(sb304.headers.get('vary')).toContain('Cookie');

    // 8. Disk mutation invalidates old ETag & downgrades old ?v= response to must-revalidate until re-resolved
    const absMdPath = path.join(chatRes.data.chat.workspaceDir, art.relPath);
    fs.writeFileSync(absMdPath, '# Summary Report V2 (Updated on disk cleanly)\n');
    const futureDate = new Date(Date.now() + 3000);
    fs.utimesSync(absMdPath, futureDate, futureDate);

    const mutatedRes = await alice.request<string>('GET', `/api/files/${art.id}/content?v=${shortV}`, undefined, {
      headers: { 'If-None-Match': etag! },
    });
    expect(mutatedRes.status).toBe(200);
    expect(mutatedRes.data).toContain('V2 (Updated on disk cleanly)');
    expect(mutatedRes.headers.get('etag')).not.toBe(etag);
    expect(mutatedRes.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');

    // Re-resolving refreshes sha256 and new ?v= restores cache-control max-age=300
    const reResolved = await alice.request<{ artifact: { sha256: string }; previewUrl: string }>(
      'POST',
      `/api/chats/${chatId}/resolve-link`,
      { reference: 'summary.md' }
    );
    expect(reResolved.data.artifact.sha256).not.toBe(art.sha256);
    const refreshedContent = await alice.request<string>('GET', reResolved.data.previewUrl);
    expect(refreshedContent.status).toBe(200);
    expect(refreshedContent.headers.get('cache-control')).toBe('private, max-age=300, stale-while-revalidate=3600');

    alice.closeWs();
  });

  it('caches /workspace listing and /projects/:id/files/:fileId/content with ETag/304 and enriched file metadata', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const { client: bob } = await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');

    const projRes = await alice.request<{ project: { id: string } }>('POST', '/api/projects', {
      name: 'Docs Project',
    });
    const projectId = projRes.data.project.id;

    const fd = new FormData();
    fd.append('files', new Blob(['Project Doc Body\n'], { type: 'text/plain' }), 'guide.txt');
    const upProj = await alice.request<{ uploaded: Array<{ id: string }> }>(
      'POST',
      `/api/projects/${projectId}/files`,
      fd
    );
    expect(upProj.status).toBe(201);
    const projFileId = upProj.data.uploaded[0].id;

    // Project file content ETag / 304 + isolation
    const pf200 = await alice.request<string>('GET', `/api/projects/${projectId}/files/${projFileId}/content`);
    expect(pf200.status).toBe(200);
    const pfEtag = pf200.headers.get('etag')!;
    expect(pfEtag).toBeTruthy();
    expect(pf200.headers.get('vary')).toContain('Cookie');
    expect(pf200.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(pf200.data).toBe('Project Doc Body\n');

    const pf304 = await alice.request<string>(
      'GET',
      `/api/projects/${projectId}/files/${projFileId}/content`,
      undefined,
      { headers: { 'If-None-Match': pfEtag } }
    );
    expect(pf304.status).toBe(304);

    const bobProj = await bob.request('GET', `/api/projects/${projectId}/files/${projFileId}/content`, undefined, {
      headers: { 'If-None-Match': pfEtag },
    });
    expect(bobProj.status).toBe(404);

    // Chat workspace metadata + ETag + 304 + change invalidation
    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>('POST', '/api/chats', {
      title: 'Workspace Tree Cache',
      projectId,
    });
    const chatId = chatRes.data.chat.id;
    fs.writeFileSync(path.join(chatRes.data.chat.workspaceDir, 'notes.md'), '# Notes\n');

    interface WorkspaceEntry {
      relPath: string;
      isProjectContext: boolean;
      mtimeMs: number;
      updatedAt?: number;
      previewKind: string;
      mimeType: string;
    }

    const wsRes1 = await alice.request<{ files: WorkspaceEntry[] }>('GET', `/api/chats/${chatId}/workspace`);
    expect(wsRes1.status).toBe(200);
    const wsEtag = wsRes1.headers.get('etag')!;
    expect(wsEtag).toBeTruthy();
    expect(wsRes1.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(wsRes1.headers.get('vary')).toContain('Cookie');

    const ctxGuide = wsRes1.data.files.find((f) => f.relPath.endsWith('guide.txt'));
    const workNote = wsRes1.data.files.find((f) => f.relPath === 'notes.md');
    expect(ctxGuide).toBeDefined();
    expect(ctxGuide!.isProjectContext).toBe(true);
    expect(ctxGuide!.mtimeMs).toBeGreaterThan(0);
    expect(ctxGuide!.updatedAt).toBe(ctxGuide!.mtimeMs);
    expect(ctxGuide!.previewKind).toBe('code');

    expect(workNote).toBeDefined();
    expect(workNote!.isProjectContext).toBe(false);
    expect(workNote!.previewKind).toBe('markdown');
    expect(workNote!.mimeType).toBe('text/markdown');

    const ws304 = await alice.request('GET', `/api/chats/${chatId}/workspace`, undefined, {
      headers: { 'If-None-Match': wsEtag },
    });
    expect(ws304.status).toBe(304);

    // Adding a file invalidates workspace ETag
    fs.writeFileSync(path.join(chatRes.data.chat.workspaceDir, 'chart.svg'), '<svg></svg>');
    const wsRes2 = await alice.request<{ files: WorkspaceEntry[] }>('GET', `/api/chats/${chatId}/workspace`, undefined, {
      headers: { 'If-None-Match': wsEtag },
    });
    expect(wsRes2.status).toBe(200);
    expect(wsRes2.headers.get('etag')).not.toBe(wsEtag);
    expect(wsRes2.data.files.some((f) => f.relPath === 'chart.svg')).toBe(true);
  });
});
