import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

it('reads the committed revision while an ACP write awaits ingestion', async () => {
  const srv = await createTestServer();
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'snapshot', 'user:snapshot');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Snapshot' });
    const { artifact } = await srv.ctx.artifactService.createArtifact({
      userId, scopeKind: 'chat', chatId: chat.id, relPath: 'sample.md',
      content: Buffer.from('# Initial\n'), actorKind: 'user',
    });
    const workspaceDir = srv.ctx.db.getChat(userId, chat.id)!.workspaceDir;
    fs.writeFileSync(path.join(workspaceDir, 'sample.md'), '# Workspace\n');
    const service = srv.ctx.artifactService;
    expect(await service.getStructure(userId, artifact.id)).toMatchObject({ revision: 1, sha256: artifact.sha256 });
    expect(await service.readRange(userId, artifact.id, { endLine: 1 })).toMatchObject({
      revision: 1, sha256: artifact.sha256, text: '# Initial',
    });
    expect(await service.verifyArtifact(userId, artifact.id)).toMatchObject({ revision: 1, sha256: artifact.sha256 });

    const ingested = await service.ingestWorkspaceFile({ userId, chatId: chat.id, workspaceDir, relPath: 'sample.md' });
    expect(await service.readRange(userId, artifact.id, { endLine: 1 })).toMatchObject({
      revision: 2, sha256: ingested.artifact.sha256, text: '# Workspace',
    });
  } finally {
    await srv.cleanup();
  }
});

const runtime = process.env.AGY_TEST_DOC_RUNTIME_DIR;

it.skipIf(!runtime)('renders only the current revision’s CSS and images through Chromium', async () => {
  const srv = await createTestServer({
    docRuntimeDir: runtime!, installDocRuntime: 'full',
    sandboxMode: 'off', allowUnsandboxedDocWorkers: true,
  });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'render', 'user:render');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Render' });
    const workspaceDir = srv.ctx.db.getChat(userId, chat.id)!.workspaceDir;
    const service = srv.ctx.artifactService;
    const create = (relPath: string, content: Buffer) => service.createArtifact({
      userId, scopeKind: 'chat', chatId: chat.id, relPath, content, actorKind: 'user',
    });
    const python = path.join(runtime!, 'venv/bin/python3');
    await create('site/styles/pixel image.png', execFileSync(python, ['-c',
      'import sys; from PIL import Image; Image.new("RGB",(2,2),(5,6,7)).save(sys.stdout.buffer,"PNG")']));
    await create('site/styles/theme.css', Buffer.from(
      'html{background:rgb(21,43,65)}body{margin:0;background:url("pixel image.png") no-repeat;height:20px}'
    ));
    const { artifact } = await create('site/index.html', Buffer.from(
      '<!doctype html><link rel="stylesheet" href="styles/theme.css"><body></body>'
    ));
    const colors = (png: Buffer) => JSON.parse(execFileSync(python, ['-c',
      'import io,sys,json; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB"); print(json.dumps([im.getpixel((0,0)),im.getpixel((50,50))]))',
    ], { input: png, encoding: 'utf8' }));
    expect(colors((await service.renderPng(userId, artifact.id)).png)).toEqual([[5, 6, 7], [21, 43, 65]]);
    fs.writeFileSync(path.join(workspaceDir, 'site/styles/theme.css'), 'html{background:rgb(10,20,30)}');
    expect(colors((await service.renderPng(userId, artifact.id)).png)).toEqual([[5, 6, 7], [21, 43, 65]]);
    await service.ingestWorkspaceFile({ userId, chatId: chat.id, workspaceDir, relPath: 'site/styles/theme.css' });
    expect(colors((await service.renderPng(userId, artifact.id)).png)).toEqual([[10, 20, 30], [10, 20, 30]]);
  } finally {
    await srv.cleanup();
  }
}, 40_000);
