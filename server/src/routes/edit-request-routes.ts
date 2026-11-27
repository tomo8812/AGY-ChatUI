import type { ExecutionScheduler } from '../acp/scheduler.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isArtifactError } from '../artifacts/errors.js';
import { targetSelectorSchema } from '../artifacts/target-selector-schema.js';
import type { EditRequestService, EditRequestStatus } from '../edit-requests/edit-request-service.js';
import { requireAuth, type RouteDeps } from './auth-routes.js';

export interface EditRequestRouteDeps extends RouteDeps {
  editRequestService: EditRequestService;
  scheduler: ExecutionScheduler;
}

function sendEditRequestError(reply: FastifyReply, err: unknown) {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: 'INVALID_INPUT' });
  if (isArtifactError(err)) {
    return reply.code(err.statusCode).send({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  return reply.code(500).send({
    error: 'INTERNAL_ERROR',
    message: err instanceof Error ? err.message : '編集依頼処理エラーが発生しました。',
  });
}

const targetDetails = {
  range: z.record(z.unknown()).optional().nullable(),
  contentCoords: z.record(z.unknown()).optional().nullable(),
  selectedContentSnapshot: z.string().max(50_000).optional(),
  surroundingContext: z.string().max(20_000).optional().nullable(),
  regionImagePngBase64: z.string().max(8_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional().nullable(),
  viewStateSnapshot: z.record(z.unknown()).optional().nullable(),
};

function parseSelector(selector: unknown, baseRevision?: number) {
  return targetSelectorSchema.parse(
    baseRevision !== undefined && selector && typeof selector === 'object'
      ? { baseRevision, ...selector } : selector
  );
}

function targetInput<T extends { regionImagePngBase64?: string | null }>({ regionImagePngBase64: _legacyImage, ...data }: T) {
  return data;
}

export async function registerEditRequestRoutes(app: FastifyInstance, deps: EditRequestRouteDeps): Promise<void> {
  const { db, editRequestService, scheduler } = deps;

  app.get('/api/chats/:chatId/edit-requests', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const query = req.query as { artifactId?: string; richBlockId?: string; status?: EditRequestStatus };
    try {
      const requests = editRequestService.listRequests(session.user.id, chatId, {
        artifactId: query.artifactId,
        richBlockId: query.richBlockId,
        status: query.status,
      });
      return { requests };
    } catch (err) {
      return sendEditRequestError(reply, err);
    }
  });

  app.post('/api/chats/:chatId/edit-requests', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const parsed = z
      .object({
        targetKind: z.enum(['artifact', 'rich_block']),
        artifactId: z.string().min(1).optional().nullable(),
        richBlockId: z.string().min(1).optional().nullable(),
        baseRevision: z.number().int().min(1).optional(),
        selector: z.record(z.unknown()),
        ...targetDetails,
        instruction: z.string().trim().min(1).max(10_000),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const request = await editRequestService.createRequest({
        ...targetInput(parsed.data),
        userId: session.user.id,
        chatId,
      });
      return reply.code(201).send({ request });
    } catch (err) {
      return sendEditRequestError(reply, err);
    }
  });

  app.get('/api/chats/:chatId/edit-requests/:requestId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, requestId } = req.params as { chatId: string; requestId: string };
    try {
      const request = editRequestService.getRequest(session.user.id, chatId, requestId);
      if (!request) return reply.code(404).send({ error: 'NOT_FOUND' });
      const targetRevision = request.artifactId ? db.getArtifact(session.user.id, request.artifactId)?.revision : undefined;
      const reResolution = await editRequestService.resolveRequestTarget(request);
      if (request.artifactId && targetRevision !== db.getArtifact(session.user.id, request.artifactId)?.revision) {
        return reply.code(409).send({ error: 'TARGET_CONTENT_DRIFT' });
      }
      return { request, reResolution, targetRevision };
    } catch (err) {
      return sendEditRequestError(reply, err);
    }
  });

  app.patch('/api/chats/:chatId/edit-requests/:requestId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, requestId } = req.params as { chatId: string; requestId: string };
    const parsed = z
      .object({
        instruction: z.string().trim().min(1).max(10_000).optional(),
        selector: targetSelectorSchema.optional(),
        ...targetDetails,
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const request = await editRequestService.updateRequest({
        ...targetInput(parsed.data),
        userId: session.user.id,
        chatId,
        requestId,
      });
      return { request };
    } catch (err) {
      return sendEditRequestError(reply, err);
    }
  });

  app.delete('/api/chats/:chatId/edit-requests/:requestId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, requestId } = req.params as { chatId: string; requestId: string };
    try {
      const deleted = editRequestService.deleteRequest(session.user.id, chatId, requestId);
      if (!deleted) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { ok: true };
    } catch (err) {
      return sendEditRequestError(reply, err);
    }
  });

  app.post('/api/chats/:chatId/edit-requests/reorder', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const parsed = z.object({ orderedIds: z.array(z.string().min(1)) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      const requests = editRequestService.reorderDrafts(session.user.id, chatId, parsed.data.orderedIds);
      return { requests };
    } catch (err) {
      return sendEditRequestError(reply, err);
    }
  });

  app.post('/api/chats/:chatId/edit-requests/send-batch', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const parsed = z
      .object({
        requestIds: z.array(z.string().min(1)).min(1),
        clientMessageId: z.string().uuid(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    if (db.getAgyProfile(session.user.id)?.authStatus !== 'authenticated') {
      return reply.code(403).send({ error: 'AGY_AUTH_REQUIRED', message: 'Antigravity認証が必要です。' });
    }
    try {
      const clientMessageId = parsed.data.clientMessageId;
      return await editRequestService.sendBatch({
        userId: session.user.id,
        chatId,
        requestIds: parsed.data.requestIds,
        submit: {
          clientMessageId,
          enqueue: (text, persist) => scheduler.enqueueTurn({
            userId: session.user.id, chatId, userText: text, attachments: [], clientMessageId, persistWithMessage: persist,
          }),
        },
      });
    } catch (err) {
      return sendEditRequestError(reply, err);
    }
  });

  app.post('/api/chats/:chatId/edit-requests/:requestId/resolve', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, requestId } = req.params as { chatId: string; requestId: string };
    try {
      const request = await editRequestService.resolveByUser(session.user.id, chatId, requestId);
      return { request };
    } catch (err) {
      return sendEditRequestError(reply, err);
    }
  });

  app.post('/api/chats/:chatId/edit-requests/:requestId/reconfirm', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, requestId } = req.params as { chatId: string; requestId: string };
    const parsed = z
      .object({
        newBaseRevision: z.number().int().min(1),
        newSelector: z.record(z.unknown()),
        ...targetDetails,
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      const request = await editRequestService.reconfirmByUser({
        ...targetInput(parsed.data),
        userId: session.user.id,
        chatId,
        requestId,
        newSelector: parseSelector(parsed.data.newSelector, parsed.data.newBaseRevision),
      });
      return { request };
    } catch (err) {
      return sendEditRequestError(reply, err);
    }
  });
}
