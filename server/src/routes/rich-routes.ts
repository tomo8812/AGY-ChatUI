import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { RichNode, RichStateValue } from '../../../shared/rich-schema.js';
import { isArtifactError } from '../artifacts/errors.js';
import { RichContentError, type RichContentService } from '../rich/rich-content-service.js';
import { requireAuth, type RouteDeps } from './auth-routes.js';

export interface RichRouteDeps extends RouteDeps {
  richContentService: RichContentService;
}

function sendRichError(reply: FastifyReply, err: unknown) {
  if (err instanceof RichContentError) {
    return reply.code(err.statusCode).send({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  if (isArtifactError(err)) {
    return reply.code(err.statusCode).send({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  return reply.code(500).send({
    error: 'INTERNAL_ERROR',
    message: err instanceof Error ? err.message : 'リッチコンテンツ処理エラーが発生しました。',
  });
}

export async function registerRichRoutes(app: FastifyInstance, deps: RichRouteDeps): Promise<void> {
  const { db, richContentService } = deps;

  app.get('/api/rich/capabilities', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    return richContentService.getCapabilities();
  });

  app.post('/api/rich/validate', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const parsed = z
      .object({
        chatId: z.string().min(1).optional(),
        document: z.unknown(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const result = richContentService.validateDocument(
        session.user.id,
        parsed.data.chatId ?? null,
        parsed.data.document
      );
      if (!result.valid) {
        return reply.code(result.statusCode).send({
          valid: false,
          error: result.primaryErrorCode,
          issues: result.issues,
          stats: result.stats,
        });
      }
      return result;
    } catch (err) {
      return sendRichError(reply, err);
    }
  });

  app.get('/api/chats/:chatId/rich-blocks', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    try {
      const blocks = richContentService.listBlocksForChat(session.user.id, chatId);
      return { blocks };
    } catch (err) {
      return sendRichError(reply, err);
    }
  });

  app.post('/api/chats/:chatId/rich-blocks', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const parsed = z
      .object({
        document: z.unknown(),
        title: z.string().max(200).optional(),
        operationSummary: z.string().max(300).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const created = richContentService.createBlock({
        userId: session.user.id,
        chatId,
        document: parsed.data.document,
        title: parsed.data.title,
        actorKind: 'user',
        actorId: session.user.id,
        operationSummary: parsed.data.operationSummary,
      });
      return reply.code(201).send(created);
    } catch (err) {
      return sendRichError(reply, err);
    }
  });

  app.get('/api/chats/:chatId/rich-blocks/:blockId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, blockId } = req.params as { chatId: string; blockId: string };
    const block = richContentService.getBlock(session.user.id, chatId, blockId);
    if (!block) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'リッチブロックが見つからないかアクセス権がありません。' });
    }
    return { block };
  });

  app.patch('/api/chats/:chatId/rich-blocks/:blockId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, blockId } = req.params as { chatId: string; blockId: string };
    const parsed = z
      .object({
        expectedRevision: z.number().int().min(1),
        document: z.unknown().optional(),
        patchNodes: z.array(z.object({ nodeId: z.string().min(1), replacement: z.unknown() })).optional(),
        patchState: z.record(z.unknown()).optional(),
        title: z.string().max(200).optional(),
        operationSummary: z.string().max(300).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      return richContentService.updateBlock({
        userId: session.user.id,
        chatId,
        blockId,
        expectedRevision: parsed.data.expectedRevision,
        document: parsed.data.document,
        patchNodes: parsed.data.patchNodes as Array<{ nodeId: string; replacement: RichNode }> | undefined,
        patchState: parsed.data.patchState as Record<string, RichStateValue> | undefined,
        title: parsed.data.title,
        actorKind: 'user',
        actorId: session.user.id,
        operationSummary: parsed.data.operationSummary,
      });
    } catch (err) {
      return sendRichError(reply, err);
    }
  });

  app.put('/api/chats/:chatId/rich-blocks/:blockId/ui-state', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, blockId } = req.params as { chatId: string; blockId: string };
    const parsed = z.object({ uiState: z.record(z.unknown()) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const block = richContentService.updateUiStateSnapshot(
        session.user.id,
        chatId,
        blockId,
        parsed.data.uiState as Record<string, RichStateValue>
      );
      return { block };
    } catch (err) {
      return sendRichError(reply, err);
    }
  });

  app.post('/api/chats/:chatId/rich-blocks/:blockId/save-as-artifact', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, blockId } = req.params as { chatId: string; blockId: string };
    const parsed = z
      .object({
        filename: z.string().min(1).max(200),
        format: z.enum(['svg', 'md', 'txt', 'csv', 'json', 'code']),
        content: z.string().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const saved = await richContentService.saveBlockAsArtifact({
        userId: session.user.id,
        chatId,
        blockId,
        filename: parsed.data.filename,
        format: parsed.data.format,
        content: parsed.data.content,
        actorKind: 'user',
        actorId: session.user.id,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return reply.code(201).send(saved);
    } catch (err) {
      return sendRichError(reply, err);
    }
  });
}
