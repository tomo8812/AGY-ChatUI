import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeStrongEtag, formatHttpDate, isFreshRequest } from '../files/http-cache.js';
import {
  detectMimeAndPreviewKind,
  resolveContainedExistingPath,
  resolveContainedWriteTarget,
  sanitizeFileName,
} from '../files/workspace.js';
import type { AcpClientManager } from '../acp/client-manager.js';
import { requireAuth, type RouteDeps } from './auth-routes.js';

export interface ProjectRouteDeps extends RouteDeps {
  acp?: AcpClientManager;
}

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(16000).optional(),
});

const patchProjectSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().max(16000).optional(),
});

export async function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): Promise<void> {
  const { config, db, hub, acp } = deps;

  app.get('/api/projects', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const projects = db.listProjects(session.user.id).map((p) => ({
      ...p,
      files: db.listProjectFiles(session.user.id, p.id),
    }));
    return { projects };
  });

  app.post('/api/projects', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: 'プロジェクト名を確認してください。' });
    }
    const id = crypto.randomUUID();
    const storageDir = path.join(config.projectsRoot, session.user.id, id, 'files');
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });

    const project = db.createProject({
      id,
      userId: session.user.id,
      name: parsed.data.name,
      description: parsed.data.description ?? '',
      instructions: parsed.data.instructions ?? '',
      storageDir,
    });
    const full = { ...project, files: [] };
    hub.emitDurable({
      userId: session.user.id,
      type: 'project.created',
      projectId: project.id,
      payload: { project: full },
    });
    return reply.code(201).send({ project: full });
  });

  app.get('/api/projects/:projectId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { projectId } = req.params as { projectId: string };
    const project = db.getProject(session.user.id, projectId);
    if (!project) return reply.code(404).send({ error: 'NOT_FOUND', message: 'プロジェクトが見つかりません。' });
    return {
      project: {
        ...project,
        files: db.listProjectFiles(session.user.id, project.id),
      },
    };
  });

  app.patch('/api/projects/:projectId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { projectId } = req.params as { projectId: string };
    const parsed = patchProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: '入力値が不正です。' });
    }
    const existing = db.getProject(session.user.id, projectId);
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'プロジェクトが見つかりません。' });

    const instructionsChanged =
      parsed.data.instructions !== undefined && parsed.data.instructions !== existing.instructions;

    const updated = db.updateProject(session.user.id, projectId, {
      ...parsed.data,
      bumpContextVersion: instructionsChanged,
    })!;

    const full = { ...updated, files: db.listProjectFiles(session.user.id, projectId) };
    hub.emitDurable({
      userId: session.user.id,
      type: 'project.updated',
      projectId,
      payload: { project: full },
    });
    return { project: full };
  });

  app.delete('/api/projects/:projectId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { projectId } = req.params as { projectId: string };
    const existing = db.getProject(session.user.id, projectId);
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'プロジェクトが見つかりません。' });
    const affectedChatIds = db.listChatIdsForProject(session.user.id, projectId);
    db.deleteProject(session.user.id, projectId);
    fs.rmSync(path.dirname(existing.storageDir), { recursive: true, force: true });
    if (affectedChatIds.length > 0) {
      await acp?.stopIdleWorkersForChats(session.user.id, affectedChatIds);
    }
    hub.emitDurable({
      userId: session.user.id,
      type: 'project.deleted',
      projectId,
      payload: { projectId },
    });
    return { ok: true };
  });

  app.post('/api/projects/:projectId/files', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { projectId } = req.params as { projectId: string };
    const project = db.getProject(session.user.id, projectId);
    if (!project) return reply.code(404).send({ error: 'NOT_FOUND', message: 'プロジェクトが見つかりません。' });

    fs.mkdirSync(project.storageDir, { recursive: true, mode: 0o700 });
    const uploaded: unknown[] = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const filename = sanitizeFileName(part.filename || 'file.bin');
      const target = resolveContainedWriteTarget(project.storageDir, filename);
      const buf = await part.toBuffer();
      await fs.promises.writeFile(target.absPath, buf);
      const { mimeType } = detectMimeAndPreviewKind(filename, part.mimetype);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

      const { file } = db.upsertProjectFile({
        id: crypto.randomUUID(),
        projectId: project.id,
        userId: session.user.id,
        relPath: target.relPath,
        filename,
        mimeType,
        sizeBytes: buf.length,
        sha256,
        createdAt: Date.now(),
      });
      uploaded.push(file);
    }

    if (uploaded.length === 0) {
      return reply.code(400).send({ error: 'NO_FILES', message: 'アップロードされたファイルがありません。' });
    }

    const latestProject = db.getProject(session.user.id, projectId)!;
    const full = { ...latestProject, files: db.listProjectFiles(session.user.id, projectId) };
    hub.emitDurable({
      userId: session.user.id,
      type: 'project.updated',
      projectId,
      payload: { project: full },
    });
    return reply.code(201).send({ project: full, uploaded });
  });

  app.delete('/api/projects/:projectId/files/:fileId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { projectId, fileId } = req.params as { projectId: string; fileId: string };
    const project = db.getProject(session.user.id, projectId);
    if (!project) return reply.code(404).send({ error: 'NOT_FOUND', message: 'プロジェクトが見つかりません。' });

    const { deleted } = db.deleteProjectFile(session.user.id, projectId, fileId);
    if (!deleted) return reply.code(404).send({ error: 'NOT_FOUND', message: 'ファイルが見つかりません。' });

    try {
      const { absPath } = resolveContainedExistingPath(project.storageDir, deleted.relPath);
      fs.rmSync(absPath, { force: true });
    } catch {
      // ignore if already absent
    }

    const updated = db.getProject(session.user.id, projectId)!;
    const full = { ...updated, files: db.listProjectFiles(session.user.id, projectId) };
    hub.emitDurable({
      userId: session.user.id,
      type: 'project.updated',
      projectId,
      payload: { project: full },
    });
    return { project: full };
  });

  app.get('/api/projects/:projectId/files/:fileId/content', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { projectId, fileId } = req.params as { projectId: string; fileId: string };
    const project = db.getProject(session.user.id, projectId);
    if (!project) return reply.code(404).send({ error: 'NOT_FOUND' });

    const file = db.listProjectFiles(session.user.id, projectId).find((f) => f.id === fileId);
    if (!file) return reply.code(404).send({ error: 'NOT_FOUND' });

    let absPath: string;
    try {
      absPath = resolveContainedExistingPath(project.storageDir, file.relPath).absPath;
    } catch {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }

    const stat = await fs.promises.stat(absPath);
    const etag = computeStrongEtag([
      'proj-file',
      file.id,
      file.sha256,
      stat.size,
      Math.round(stat.mtimeMs * 1000),
    ]);

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Vary', 'Cookie');
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
    reply.header('ETag', etag);
    reply.header('Last-Modified', formatHttpDate(stat.mtimeMs));
    reply.header('Content-Type', file.mimeType);
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);

    if (isFreshRequest(req.headers, etag, stat.mtimeMs)) {
      return reply.code(304).send();
    }

    reply.header('Content-Length', String(stat.size));
    return reply.send(fs.createReadStream(absPath));
  });
}
