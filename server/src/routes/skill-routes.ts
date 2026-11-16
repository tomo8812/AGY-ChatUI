import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AcpClientManager } from '../acp/client-manager.js';
import { PathContainmentError, sanitizeFileName } from '../files/workspace.js';
import { SkillService, SkillValidationError } from '../skills/skill-service.js';
import type { SkillScope } from '../types.js';
import { requireAuth, type RouteDeps } from './auth-routes.js';

export interface SkillRouteDeps extends RouteDeps {
  skillService: SkillService;
  acp: AcpClientManager;
}

const scopeSchema = z.enum(['global', 'project', 'workspace']);

const createOrUpdateSkillSchema = z.object({
  scope: scopeSchema.optional(),
  projectId: z.string().nullable().optional(),
  chatId: z.string().nullable().optional(),
  slug: z.string().trim().min(1).max(64).optional(),
  name: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(120_000).optional(),
  rawSkillMd: z.string().max(150_000).optional(),
  disableModelInvocation: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

function handleSkillError(reply: import('fastify').FastifyReply, err: unknown) {
  if (err instanceof SkillValidationError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  if (err instanceof PathContainmentError) {
    return reply.code(err.statusCode).send({ error: 'FORBIDDEN', message: err.message });
  }
  return reply.code(400).send({
    error: 'SKILL_ERROR',
    message: err instanceof Error ? err.message : 'スキル操作に失敗しました。',
  });
}

export async function registerSkillRoutes(app: FastifyInstance, deps: SkillRouteDeps): Promise<void> {
  const { db, skillService, acp } = deps;

  const refreshAcpForAffectedChats = async (
    userId: string,
    scope: SkillScope,
    affectedChatIds: string[],
    chatId?: string | null
  ) => {
    acp.invalidateUserOptionsCache(userId);
    if (scope === 'global') {
      await acp.stopIdleWorkersForUser(userId);
    } else if (scope === 'project') {
      await Promise.allSettled(affectedChatIds.map((cId) => acp.stopChatWorkerIfIdle(userId, cId)));
    } else if (scope === 'workspace' && chatId) {
      await acp.stopChatWorkerIfIdle(userId, chatId);
    }
  };

  app.get('/api/skills', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const query = (req.query ?? {}) as { projectId?: string; chatId?: string };
    try {
      const list = skillService.listSkills(session.user.id, {
        projectId: query.projectId || null,
        chatId: query.chatId || null,
      });
      const commands = skillService.listAvailableSkillCommands(session.user.id, {
        projectId: list.projectId,
        chatId: list.chatId,
      });
      return { ...list, commands };
    } catch (err) {
      return handleSkillError(reply, err);
    }
  });

  app.post('/api/skills', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const parsed = createOrUpdateSkillSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.slug) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        message: 'スキルID（スラッグ）と必須項目を入力してください。',
      });
    }
    const scope: SkillScope = parsed.data.scope ?? 'global';
    try {
      const { detail, affectedProjectChatIds } = skillService.saveSkill(session.user.id, {
        scope,
        projectId: parsed.data.projectId ?? null,
        chatId: parsed.data.chatId ?? null,
        slug: parsed.data.slug,
        name: parsed.data.name,
        description: parsed.data.description,
        instructions: parsed.data.instructions,
        rawSkillMd: parsed.data.rawSkillMd,
        disableModelInvocation: parsed.data.disableModelInvocation,
        enabled: parsed.data.enabled,
        createOnly: true,
      });
      await refreshAcpForAffectedChats(session.user.id, scope, affectedProjectChatIds, detail.chatId);
      return reply.code(201).send({ skill: detail });
    } catch (err) {
      return handleSkillError(reply, err);
    }
  });

  app.get('/api/skills/:scope/:slug', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { scope: rawScope, slug } = req.params as { scope: string; slug: string };
    const parsedScope = scopeSchema.safeParse(rawScope);
    if (!parsedScope.success) {
      return reply.code(400).send({ error: 'INVALID_SCOPE', message: '無効なスキルスコープです。' });
    }
    const query = (req.query ?? {}) as { projectId?: string; chatId?: string };
    try {
      const detail = skillService.getSkillDetail(session.user.id, {
        scope: parsedScope.data,
        slug,
        projectId: query.projectId || null,
        chatId: query.chatId || null,
      });
      return { skill: detail };
    } catch (err) {
      return handleSkillError(reply, err);
    }
  });

  app.put('/api/skills/:scope/:slug', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { scope: rawScope, slug } = req.params as { scope: string; slug: string };
    const parsedScope = scopeSchema.safeParse(rawScope);
    if (!parsedScope.success) {
      return reply.code(400).send({ error: 'INVALID_SCOPE', message: '無効なスキルスコープです。' });
    }
    const parsedBody = createOrUpdateSkillSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: '入力値が不正です。' });
    }

    const query = (req.query ?? {}) as { projectId?: string; chatId?: string };
    const projectId = parsedBody.data.projectId ?? query.projectId ?? null;
    const chatId = parsedBody.data.chatId ?? query.chatId ?? null;

    try {
      // Toggle-only shortcut when no content fields are passed
      if (
        parsedBody.data.enabled !== undefined &&
        parsedBody.data.rawSkillMd === undefined &&
        parsedBody.data.description === undefined &&
        parsedBody.data.instructions === undefined &&
        parsedBody.data.name === undefined &&
        parsedBody.data.disableModelInvocation === undefined
      ) {
        const { detail, affectedProjectChatIds } = skillService.setSkillEnabled(session.user.id, {
          scope: parsedScope.data,
          slug,
          projectId,
          chatId,
          enabled: parsedBody.data.enabled,
        });
        await refreshAcpForAffectedChats(session.user.id, parsedScope.data, affectedProjectChatIds, chatId);
        return { skill: detail };
      }

      const { detail, affectedProjectChatIds } = skillService.saveSkill(session.user.id, {
        scope: parsedScope.data,
        projectId,
        chatId,
        slug,
        name: parsedBody.data.name,
        description: parsedBody.data.description,
        instructions: parsedBody.data.instructions,
        rawSkillMd: parsedBody.data.rawSkillMd,
        disableModelInvocation: parsedBody.data.disableModelInvocation,
        enabled: parsedBody.data.enabled,
      });
      await refreshAcpForAffectedChats(session.user.id, parsedScope.data, affectedProjectChatIds, chatId);
      return { skill: detail };
    } catch (err) {
      return handleSkillError(reply, err);
    }
  });

  app.delete('/api/skills/:scope/:slug', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { scope: rawScope, slug } = req.params as { scope: string; slug: string };
    const parsedScope = scopeSchema.safeParse(rawScope);
    if (!parsedScope.success) {
      return reply.code(400).send({ error: 'INVALID_SCOPE', message: '無効なスキルスコープです。' });
    }
    const query = (req.query ?? {}) as { projectId?: string; chatId?: string };
    try {
      const { affectedProjectChatIds } = skillService.deleteSkill(session.user.id, {
        scope: parsedScope.data,
        slug,
        projectId: query.projectId || null,
        chatId: query.chatId || null,
      });
      await refreshAcpForAffectedChats(session.user.id, parsedScope.data, affectedProjectChatIds, query.chatId || null);
      return { ok: true };
    } catch (err) {
      return handleSkillError(reply, err);
    }
  });

  app.post('/api/skills/:scope/:slug/files', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { scope: rawScope, slug } = req.params as { scope: string; slug: string };
    const parsedScope = scopeSchema.safeParse(rawScope);
    if (!parsedScope.success) {
      return reply.code(400).send({ error: 'INVALID_SCOPE', message: '無効なスキルスコープです。' });
    }
    const query = (req.query ?? {}) as { projectId?: string; chatId?: string; folder?: string };
    const allowedFolders = new Set(['scripts', 'references', 'examples', 'resources', 'assets']);
    const folderPrefix = query.folder && allowedFolders.has(query.folder) ? query.folder : '';

    try {
      const contentType = String(req.headers['content-type'] || '');
      if (contentType.includes('application/json')) {
        const jsonSchema = z.object({
          relPath: z.string().trim().min(1).max(200),
          content: z.string().max(500_000),
          projectId: z.string().nullable().optional(),
          chatId: z.string().nullable().optional(),
        });
        const parsed = jsonSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'INVALID_INPUT', message: 'ファイルパスと内容を指定してください。' });
        }
        const { detail, affectedProjectChatIds } = skillService.upsertResourceFile(session.user.id, {
          scope: parsedScope.data,
          slug,
          projectId: parsed.data.projectId ?? query.projectId ?? null,
          chatId: parsed.data.chatId ?? query.chatId ?? null,
          relPath: parsed.data.relPath,
          content: Buffer.from(parsed.data.content, 'utf8'),
        });
        await refreshAcpForAffectedChats(session.user.id, parsedScope.data, affectedProjectChatIds, detail.chatId);
        return reply.code(201).send({ skill: detail });
      }

      let lastDetail = null;
      let affected: string[] = [];
      let count = 0;
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        const safeName = sanitizeFileName(part.filename || 'resource.txt');
        const relPath = folderPrefix ? `${folderPrefix}/${safeName}` : `resources/${safeName}`;
        const buf = await part.toBuffer();
        const res = skillService.upsertResourceFile(session.user.id, {
          scope: parsedScope.data,
          slug,
          projectId: query.projectId || null,
          chatId: query.chatId || null,
          relPath,
          content: buf,
        });
        lastDetail = res.detail;
        affected = res.affectedProjectChatIds;
        count += 1;
      }

      if (count === 0 || !lastDetail) {
        return reply.code(400).send({ error: 'NO_FILES', message: 'アップロードされたファイルがありません。' });
      }
      await refreshAcpForAffectedChats(session.user.id, parsedScope.data, affected, lastDetail.chatId);
      return reply.code(201).send({ skill: lastDetail });
    } catch (err) {
      return handleSkillError(reply, err);
    }
  });

  app.get('/api/skills/:scope/:slug/files', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { scope: rawScope, slug } = req.params as { scope: string; slug: string };
    const parsedScope = scopeSchema.safeParse(rawScope);
    if (!parsedScope.success) {
      return reply.code(400).send({ error: 'INVALID_SCOPE' });
    }
    const query = (req.query ?? {}) as { projectId?: string; chatId?: string; path?: string };
    if (!query.path) {
      return reply.code(400).send({ error: 'PATH_REQUIRED', message: 'path クエリが必要です。' });
    }
    try {
      const { absPath, relPath } = skillService.readResourceFile(session.user.id, {
        scope: parsedScope.data,
        slug,
        projectId: query.projectId || null,
        chatId: query.chatId || null,
        relPath: query.path,
      });
      const fs = await import('node:fs');
      const content = fs.readFileSync(absPath, 'utf8');
      return { relPath, content };
    } catch (err) {
      return handleSkillError(reply, err);
    }
  });

  app.delete('/api/skills/:scope/:slug/files', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { scope: rawScope, slug } = req.params as { scope: string; slug: string };
    const parsedScope = scopeSchema.safeParse(rawScope);
    if (!parsedScope.success) {
      return reply.code(400).send({ error: 'INVALID_SCOPE' });
    }
    const query = (req.query ?? {}) as { projectId?: string; chatId?: string; path?: string };
    if (!query.path) {
      return reply.code(400).send({ error: 'PATH_REQUIRED', message: 'path クエリが必要です。' });
    }
    try {
      const { detail, affectedProjectChatIds } = skillService.deleteResourceFile(session.user.id, {
        scope: parsedScope.data,
        slug,
        projectId: query.projectId || null,
        chatId: query.chatId || null,
        relPath: query.path,
      });
      await refreshAcpForAffectedChats(session.user.id, parsedScope.data, affectedProjectChatIds, detail.chatId);
      return { skill: detail };
    } catch (err) {
      return handleSkillError(reply, err);
    }
  });
}
