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
    const query = (req.query ?? {}) as { auto?: string; minAgeMs?: string };
    const body = (req.body ?? {}) as { auto?: boolean; minAgeMs?: number };
    const auto = query.auto === '1' || query.auto === 'true' || body.auto === true;
    const rawMinAge =
      typeof body.minAgeMs === 'number'
        ? body.minAgeMs
        : query.minAgeMs
          ? Number(query.minAgeMs)
          : undefined;
    const minAgeMs =
      typeof rawMinAge === 'number' && Number.isFinite(rawMinAge) && rawMinAge > 0
        ? Math.max(5_000, Math.min(15 * 60 * 1000, Math.round(rawMinAge)))
        : undefined;
    const quota = await quotaService.refreshOnDemand(session.user.id, { auto, minAgeMs });
    return { quota };
  });
}
