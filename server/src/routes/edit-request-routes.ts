import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isArtifactError } from '../artifacts/errors.js';
import type { TargetSelector } from '../artifacts/types.js';
import type { EditRequestService, EditRequestStatus } from '../edit-requests/edit-request-service.js';
import { requireAuth, type RouteDeps } from './auth-routes.js';

export interface EditRequestRouteDeps extends RouteDeps {
  editRequestService: EditRequestService;
}

function sendEditRequestError(reply: FastifyReply, err: unknown) {
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

export async function registerEditRequestRoutes(app: FastifyInstance, deps: EditRequestRouteDeps): Promise<void> {
  const { db, editRequestService } = deps;

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
        selector: z.object({ kind: z.string().min(1) }).passthrough(),
        range: z.record(z.unknown()).optional().nullable(),
        contentCoords: z.record(z.unknown()).optional().nullable(),
        selectedContentSnapshot: z.string().max(50_000).optional(),
        surroundingContext: z.string().max(20_000).optional().nullable(),
        regionImagePngBase64: z.string().optional().nullable(),
        instruction: z.string().trim().min(1).max(10_000),
        viewStateSnapshot: z.record(z.unknown()).optional().nullable(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const regionBuf = parsed.data.regionImagePngBase64
        ? Buffer.from(parsed.data.regionImagePngBase64, 'base64')
        : null;
      const request = editRequestService.createRequest({
        userId: session.user.id,
        chatId,
        targetKind: parsed.data.targetKind,
        artifactId: parsed.data.artifactId,
        richBlockId: parsed.data.richBlockId,
        baseRevision: parsed.data.baseRevision,
        selector: parsed.data.selector as TargetSelector,
        range: parsed.data.range,
        contentCoords: parsed.data.contentCoords,
        selectedContentSnapshot: parsed.data.selectedContentSnapshot,
        surroundingContext: parsed.data.surroundingContext,
        regionImagePngBuffer: regionBuf,
        instruction: parsed.data.instruction,
        viewStateSnapshot: parsed.data.viewStateSnapshot,
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
      const reResolution = editRequestService.resolveRequestTarget(request);
      return { request, reResolution };
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
        selector: z.object({ kind: z.string().min(1) }).passthrough().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const request = editRequestService.updateRequest({
        userId: session.user.id,
        chatId,
        requestId,
        instruction: parsed.data.instruction,
        selector: parsed.data.selector as TargetSelector | undefined,
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
    const deleted = editRequestService.deleteRequest(session.user.id, chatId, requestId);
    if (!deleted) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true };
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
        sentMessageId: z.string().optional().nullable(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      return editRequestService.sendBatch({
        userId: session.user.id,
        chatId,
        requestIds: parsed.data.requestIds,
        sentMessageId: parsed.data.sentMessageId,
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
      const request = editRequestService.resolveByUser(session.user.id, chatId, requestId);
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
        newSelector: z.object({ kind: z.string().min(1) }).passthrough().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      const request = editRequestService.reconfirmByUser({
        userId: session.user.id,
        chatId,
        requestId,
        newBaseRevision: parsed.data.newBaseRevision,
        newSelector: parsed.data.newSelector as TargetSelector | undefined,
      });
      return { request };
    } catch (err) {
      return sendEditRequestError(reply, err);
    }
  });
}
