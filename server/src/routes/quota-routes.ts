import type { FastifyInstance } from 'fastify';
import type { QuotaService } from '../acp/quota-service.js';
import { requireAuth, type RouteDeps } from './auth-routes.js';

export interface QuotaRouteDeps extends RouteDeps {
  quotaService: QuotaService;
}

export async function registerQuotaRoutes(app: FastifyInstance, deps: QuotaRouteDeps): Promise<void> {
  const { db, quotaService } = deps;

  app.get('/api/quota', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    return { quota: quotaService.getCachedOrUnavailable(session.user.id) };
  });

  app.post('/api/quota/refresh', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const quota = await quotaService.refreshOnDemand(session.user.id);
    return { quota };
  });
}
