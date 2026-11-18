import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  isAllowedPushEndpoint,
  type PushNotificationService,
  validateSubscriptionKeys,
} from '../notifications/web-push.js';
import { requireAuth, type RouteDeps } from './auth-routes.js';

export interface NotificationRouteDeps extends RouteDeps {
  pushService: PushNotificationService;
}

const subscribeSchema = z.object({
  endpoint: z.string().trim().min(1).max(2048),
  keys: z.object({
    p256dh: z.string().trim().min(10).max(512),
    auth: z.string().trim().min(10).max(256),
  }),
  userAgent: z.string().max(512).optional(),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().trim().min(1).max(2048),
});

const statusSchema = z.object({
  endpoint: z.string().trim().min(1).max(2048).optional(),
});

const testPushSchema = z
  .object({
    endpoint: z.string().trim().min(1).max(2048).optional(),
  })
  .optional();

export async function registerNotificationRoutes(
  app: FastifyInstance,
  deps: NotificationRouteDeps
): Promise<void> {
  const { config, db, pushService } = deps;

  app.get('/api/notifications/config', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    return {
      vapidPublicKey: pushService.getPublicKey(),
      subscriptionCount: db.countPushSubscriptions(session.user.id),
    };
  });

  app.post('/api/notifications/status', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;

    const parsed = statusSchema.safeParse(req.body ?? {});
    const endpoint = parsed.success ? parsed.data.endpoint : undefined;
    return {
      registeredOnServer: endpoint ? db.hasPushSubscription(session.user.id, endpoint) : false,
      subscriptionCount: db.countPushSubscriptions(session.user.id),
    };
  });

  app.post('/api/notifications/subscribe', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;

    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_SUBSCRIPTION',
        message: '通知購読データが不正です。',
      });
    }

    const { endpoint, keys, userAgent } = parsed.data;
    if (!isAllowedPushEndpoint(endpoint, config.nodeEnv === 'test')) {
      return reply.code(400).send({
        error: 'INVALID_ENDPOINT',
        message: '無効なPushエンドポイントURLです。',
      });
    }

    try {
      validateSubscriptionKeys(keys);
    } catch {
      return reply.code(400).send({
        error: 'INVALID_SUBSCRIPTION_KEYS',
        message: 'Push暗号鍵が不正です。',
      });
    }

    db.upsertPushSubscription({
      id: crypto.randomUUID(),
      userId: session.user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: (userAgent || String(req.headers['user-agent'] || '')).slice(0, 512),
    });

    return {
      ok: true,
      subscriptionCount: db.countPushSubscriptions(session.user.id),
    };
  });

  app.post('/api/notifications/unsubscribe', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;

    const parsed = unsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        message: 'endpoint が必要です。',
      });
    }

    const removed = db.deletePushSubscriptionByEndpoint(session.user.id, parsed.data.endpoint);
    return {
      ok: true,
      removed,
      subscriptionCount: db.countPushSubscriptions(session.user.id),
    };
  });

  app.post('/api/notifications/test', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;

    const parsed = testPushSchema.safeParse(req.body ?? {});
    const currentEndpoint = parsed.success ? parsed.data?.endpoint : undefined;

    const result = await pushService.sendToUser(
      session.user.id,
      {
        title: 'Antigravity Chat',
        body: 'テスト通知：応答が完了するとこのように通知が届きます。',
        tag: `test-${Date.now()}`,
        url: '/',
      },
      { currentEndpoint }
    );
    return result;
  });
}
