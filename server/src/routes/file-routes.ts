import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { convertPresentationToPdfCached } from '../files/artifacts.js';
import { resolveAuthorizedChatFileReference } from '../files/link-resolver.js';
import {
  listWorkspaceFiles,
  resolveContainedExistingPath,
  resolveContainedWriteTarget,
  sha256File,
} from '../files/workspace.js';
import { requireAuth, type RouteDeps } from './auth-routes.js';

export async function registerFileRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, db, hub } = deps;

  app.get('/api/chats/:chatId/workspace', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const chat = db.getChat(session.user.id, chatId);
    if (!chat) return reply.code(404).send({ error: 'NOT_FOUND', message: 'チャットが見つかりません。' });
    const files = listWorkspaceFiles(chat.workspaceDir, true);
    const artifacts = db.listArtifactsForChat(session.user.id, chatId);
    return { files, artifacts };
  });

  app.post('/api/chats/:chatId/resolve-link', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const body = z.object({ reference: z.string().min(1).max(2048) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    const resolved = resolveAuthorizedChatFileReference({
      db,
      userId: session.user.id,
      chatId,
      reference: body.data.reference,
    });
    if (!resolved) {
      return reply.code(404).send({ error: 'LINK_NOT_FOUND', message: '対象ファイルが見つからないか権限がありません。' });
    }
    return resolved;
  });

  app.get('/api/files/:artifactId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const artifact = db.getArtifact(session.user.id, artifactId);
    if (!artifact) return reply.code(404).send({ error: 'NOT_FOUND', message: '成果物が見つかりません。' });
    const chat = db.getChat(session.user.id, artifact.chatId);
    if (!chat) return reply.code(404).send({ error: 'NOT_FOUND' });

    try {
      resolveContainedExistingPath(chat.workspaceDir, artifact.relPath);
    } catch {
      return reply.code(404).send({ error: 'FILE_MISSING', message: '作業領域上のファイルが見つかりません。' });
    }
    return { artifact };
  });

  app.get('/api/files/:artifactId/content', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const query = req.query as { download?: string; converted?: string };

    const artifact = db.getArtifact(session.user.id, artifactId);
    if (!artifact) return reply.code(404).send({ error: 'NOT_FOUND', message: 'ファイルが存在しないかアクセス権がありません。' });
    const chat = db.getChat(session.user.id, artifact.chatId);
    if (!chat) return reply.code(404).send({ error: 'NOT_FOUND' });

    let absPath: string;
    try {
      absPath = resolveContainedExistingPath(chat.workspaceDir, artifact.relPath).absPath;
    } catch {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }

    let serveMime = artifact.mimeType;
    let serveFilename = artifact.filename;

    if (query.converted === 'pdf' && artifact.previewKind === 'pptx') {
      const convertedPath = await convertPresentationToPdfCached({
        libreOfficeBin: config.libreOfficeBin,
        cacheRoot: config.artifactsCacheRoot,
        sourceAbsPath: absPath,
        sourceSha256: artifact.sha256,
      });
      if (!convertedPath) {
        return reply.code(422).send({
          error: 'CONVERSION_UNAVAILABLE',
          message: 'この環境にはプレゼン変換用のLibreOfficeが導入されていないため、原本ダウンロードをご利用ください。',
        });
      }
      absPath = convertedPath;
      serveMime = 'application/pdf';
      serveFilename = `${artifact.filename}.pdf`;
    }

    const stat = fs.statSync(absPath);
    const totalSize = stat.size;
    const forceDownload = query.download === '1' || query.download === 'true';

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
    reply.header('Accept-Ranges', 'bytes');

    // Never allow inline HTML/SVG script execution directly on the same origin `/content` URL
    if (!forceDownload && (serveMime === 'text/html' || serveMime === 'image/svg+xml')) {
      reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline';");
    }

    if (forceDownload) {
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(serveFilename)}`);
    } else {
      reply.header('Content-Type', serveMime);
      reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(serveFilename)}`);
    }

    const rangeHeader = req.headers.range;
    if (rangeHeader && !forceDownload) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match) {
        reply.code(416).header('Content-Range', `bytes */${totalSize}`);
        return reply.send();
      }
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(Number.parseInt(match[2], 10), totalSize - 1) : totalSize - 1;
      if (start > end || start >= totalSize || Number.isNaN(start) || Number.isNaN(end)) {
        reply.code(416).header('Content-Range', `bytes */${totalSize}`);
        return reply.send();
      }
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      reply.header('Content-Length', String(end - start + 1));
      return reply.send(fs.createReadStream(absPath, { start, end }));
    }

    reply.header('Content-Length', String(totalSize));
    return reply.send(fs.createReadStream(absPath));
  });

  app.get('/api/files/:artifactId/sandbox', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const artifact = db.getArtifact(session.user.id, artifactId);
    if (!artifact || artifact.previewKind !== 'html') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    const chat = db.getChat(session.user.id, artifact.chatId);
    if (!chat) return reply.code(404).send({ error: 'NOT_FOUND' });

    const { absPath } = resolveContainedExistingPath(chat.workspaceDir, artifact.relPath);
    const html = fs.readFileSync(absPath, 'utf8');

    // Strong sandbox + CSP: runs strictly in an opaque origin iframe (`sandbox="allow-scripts"`) with zero network or storage access
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self';"
    );
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(html);
  });

  app.post('/api/files/:artifactId/copy-to-project', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const parsed = z.object({ projectId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    const artifact = db.getArtifact(session.user.id, artifactId);
    if (!artifact) return reply.code(404).send({ error: 'ARTIFACT_NOT_FOUND' });
    const chat = db.getChat(session.user.id, artifact.chatId);
    const project = db.getProject(session.user.id, parsed.data.projectId);
    if (!chat || !project) return reply.code(404).send({ error: 'PROJECT_NOT_FOUND' });

    const { absPath: srcPath } = resolveContainedExistingPath(chat.workspaceDir, artifact.relPath);
    const target = resolveContainedWriteTarget(project.storageDir, artifact.filename);
    fs.mkdirSync(project.storageDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(srcPath, target.absPath);
    const stat = fs.statSync(target.absPath);

    const { file } = db.upsertProjectFile({
      id: crypto.randomUUID(),
      projectId: project.id,
      userId: session.user.id,
      relPath: target.relPath,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sizeBytes: stat.size,
      sha256: sha256File(target.absPath),
      createdAt: Date.now(),
    });

    const latestProject = db.getProject(session.user.id, project.id)!;
    const full = { ...latestProject, files: db.listProjectFiles(session.user.id, project.id) };
    hub.emitDurable({
      userId: session.user.id,
      type: 'project.updated',
      projectId: project.id,
      payload: { project: full },
    });

    return { project: full, file };
  });
}
