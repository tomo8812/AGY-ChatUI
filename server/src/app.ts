import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { AcpClientManager } from './acp/client-manager.js';
import { ensureAgyProfileSettings } from './acp/profile-settings.js';
import { QuotaService } from './acp/quota-service.js';
import { ExecutionScheduler } from './acp/scheduler.js';
import { ArtifactService } from './artifacts/artifact-service.js';
import { AgyAuthManager } from './auth/agy-auth.js';
import { authenticateRequest } from './auth/session.js';
import { loadConfig, type AppConfig } from './config.js';
import { AppDatabase } from './db/database.js';
import { EditRequestService } from './edit-requests/edit-request-service.js';
import { McpService } from './mcp/mcp-service.js';
import { BuiltinArtifactMcpServer } from './mcp/builtin-artifact-mcp.js';
import { PushNotificationService } from './notifications/web-push.js';
import { RichContentService } from './rich/rich-content-service.js';
import { registerAuthRoutes, requireAuth } from './routes/auth-routes.js';
import { registerChatRoutes } from './routes/chat-routes.js';
import { registerEditRequestRoutes } from './routes/edit-request-routes.js';
import { registerFileRoutes } from './routes/file-routes.js';
import { registerMcpRoutes } from './routes/mcp-routes.js';
import { registerNotificationRoutes } from './routes/notification-routes.js';
import { registerProjectRoutes } from './routes/project-routes.js';
import { registerQuotaRoutes } from './routes/quota-routes.js';
import { registerRichRoutes } from './routes/rich-routes.js';
import { registerSkillRoutes } from './routes/skill-routes.js';
import { SkillService } from './skills/skill-service.js';
import { SyncHub } from './sync/hub.js';
import { loadAppBuildInfo, type AppBuildInfo } from './version.js';

export interface AppContext {
  app: FastifyInstance;
  config: AppConfig;
  buildInfo: AppBuildInfo;
  db: AppDatabase;
  hub: SyncHub;
  artifactService: ArtifactService;
  richContentService: RichContentService;
  editRequestService: EditRequestService;
  acp: AcpClientManager;
  agyAuth: AgyAuthManager;
  scheduler: ExecutionScheduler;
  quotaService: QuotaService;
  pushService: PushNotificationService;
  skillService: SkillService;
  mcpService: McpService;
  shutdown: () => Promise<void>;
}

export async function createApp(configOverrides: Partial<AppConfig> = {}): Promise<AppContext> {
  const config = loadConfig(configOverrides);
  for (const dir of [
    config.dataRoot,
    config.profilesRoot,
    config.workspacesRoot,
    config.projectsRoot,
    config.uploadsRoot,
    config.artifactsCacheRoot,
    config.artifactHistoryRoot,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const buildInfo = loadAppBuildInfo(config.webDistDir, configOverrides.appVersion);
  config.appVersion = buildInfo.version;
  const buildId = buildInfo.buildId;
  const db = new AppDatabase(config.dbPath);
  db.recoverInterruptedRuns();

  const hub = new SyncHub(db, buildId, buildInfo.version);
  const artifactService = new ArtifactService(config, db, hub);
  await artifactService.recoverOnStartup();
  const richContentService = new RichContentService(config, db, hub, artifactService);
  const editRequestService = new EditRequestService(db, hub, artifactService, richContentService);

  const pushService = new PushNotificationService(config, db, hub);
  const quotaService = new QuotaService(config, db, hub);
  const skillService = new SkillService(config, db, hub);
  const builtinMcp = new BuiltinArtifactMcpServer(db, artifactService, editRequestService, richContentService);
  const mcpService = new McpService(config, db, hub, builtinMcp);
  const acp = new AcpClientManager(config, db, hub, artifactService, skillService, pushService, mcpService);
  const agyAuth = new AgyAuthManager(config, db, hub, acp);
  const scheduler = new ExecutionScheduler(config, db, hub, acp, pushService, quotaService);

  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 10 * 1024 * 1024,
    logger: config.nodeEnv === 'test' ? false : { level: 'info' },
    forceCloseConnections: config.nodeEnv === 'test' ? true : 'idle',
  });

  for (const profileDir of db.listAgyProfileDirs()) {
    try {
      ensureAgyProfileSettings(profileDir);
      mcpService.syncAllSharedMcpPermissionsToProfile(profileDir);
    } catch (err) {
      app.log.error({ err, profileDir }, 'Failed to initialize Antigravity profile settings');
    }
    try {
      const migration = skillService.syncBuiltinSkillsToProfile(profileDir);
      if (migration.preservedCustom.length > 0) {
        app.log.warn(
          { profileDir, preservedCustom: migration.preservedCustom },
          'Preserved modified legacy built-in skills as custom skills with backups'
        );
      }
    } catch (err) {
      app.log.error({ err, profileDir }, 'Failed to sync built-in skills to profile');
    }
  }

  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 20,
    },
  });
  await app.register(websocket);

  app.get('/api/health', async () => {
    return {
      ok: true,
      agyMode: config.agyMode,
      version: buildInfo.version,
      tag: buildInfo.tag,
      shortSha: buildInfo.shortSha,
      builtAt: buildInfo.builtAt,
      buildId,
      uptimeSec: Math.floor(process.uptime()),
    };
  });

  // Single-transaction full resync snapshot endpoint (`ARCH-09`)
  app.get('/api/sync/snapshot', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    return db.getSyncSnapshot(session.user.id);
  });

  const sharedRouteDeps = {
    config,
    db,
    hub,
    agyAuth,
    artifactService,
    richContentService,
    editRequestService,
  };

  await registerAuthRoutes(app, { ...sharedRouteDeps, skillService, mcpService, buildId, buildInfo });
  await registerProjectRoutes(app, { ...sharedRouteDeps, acp });
  await registerChatRoutes(app, { ...sharedRouteDeps, acp, scheduler, skillService });
  await registerFileRoutes(app, sharedRouteDeps);
  await registerRichRoutes(app, { ...sharedRouteDeps, richContentService });
  await registerEditRequestRoutes(app, { ...sharedRouteDeps, editRequestService });
  await registerQuotaRoutes(app, { ...sharedRouteDeps, quotaService });
  await registerNotificationRoutes(app, { ...sharedRouteDeps, pushService });
  await registerSkillRoutes(app, { ...sharedRouteDeps, skillService, acp });
  await registerMcpRoutes(app, { ...sharedRouteDeps, mcpService, acp });

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const session = authenticateRequest(req, db);
    if (!session) {
      socket.close(4401, 'unauthenticated');
      return;
    }

    const query = req.query as { sinceSeq?: string; sinceUserSeq?: string; clientId?: string };
    const sinceSeq = query.sinceSeq ? Number.parseInt(query.sinceSeq, 10) : 0;
    const sinceUserSeq =
      query.sinceUserSeq !== undefined ? Number.parseInt(query.sinceUserSeq, 10) : undefined;
    const clientId = (query.clientId || crypto.randomUUID()).slice(0, 128);

    const unregister = hub.registerConnection({
      userId: session.user.id,
      sessionIdHash: session.sessionIdHash,
      clientId,
      ws: socket,
      sinceSeq: Number.isFinite(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0,
      sinceUserSeq:
        sinceUserSeq !== undefined && Number.isFinite(sinceUserSeq) && sinceUserSeq >= 0
          ? sinceUserSeq
          : undefined,
    });

    const pingInterval = setInterval(() => {
      if (socket.readyState === 1) {
        socket.ping();
      }
    }, 25_000);
    pingInterval.unref();

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          kind?: string;
          sinceSeq?: number;
          visible?: unknown;
          pushEndpoint?: unknown;
        };
        if (msg.kind === 'ping') {
          hub.touchVisibleHeartbeat(
            session.user.id,
            socket,
            typeof msg.visible === 'boolean' ? msg.visible : undefined
          );
          socket.send(
            JSON.stringify({
              kind: 'pong',
              ts: Date.now(),
              latestUserSeq: hub.getLatestUserSyncSeq(session.user.id),
            })
          );
        } else if (msg.kind === 'presence') {
          const visible = typeof msg.visible === 'boolean' ? msg.visible : false;
          const pushEndpoint =
            typeof msg.pushEndpoint === 'string' &&
            msg.pushEndpoint.trim().length > 0 &&
            msg.pushEndpoint.length <= 2048
              ? msg.pushEndpoint.trim()
              : msg.pushEndpoint === null
                ? null
                : undefined;
          hub.updatePresence({
            userId: session.user.id,
            ws: socket,
            visible,
            pushEndpoint,
          });
        }
      } catch {
        // ignore invalid messages
      }
    });

    socket.on('close', () => {
      clearInterval(pingInterval);
      unregister();
    });

    socket.on('error', () => {
      clearInterval(pingInterval);
      unregister();
    });
  });

  // Serve built frontend bundle when present
  if (fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      wildcard: false,
      setHeaders: (reply, filePath) => {
        if (
          filePath.endsWith('index.html') ||
          filePath.endsWith('sw.js') ||
          filePath.endsWith('.webmanifest')
        ) {
          reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'APIルートが見つかりません。' });
      }
      const indexFile = path.join(config.webDistDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        return reply
          .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
          .type('text/html; charset=utf-8')
          .send(fs.readFileSync(indexFile, 'utf8'));
      }
      return reply.code(404).send({ error: 'NOT_FOUND' });
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    });
  }

  const shutdown = async () => {
    await quotaService.shutdown();
    await agyAuth.shutdown();
    await acp.shutdown();
    await mcpService.shutdown();
    await app.close();
    db.close();
  };

  return {
    app,
    config,
    buildInfo,
    db,
    hub,
    artifactService,
    richContentService,
    editRequestService,
    acp,
    agyAuth,
    scheduler,
    quotaService,
    pushService,
    skillService,
    mcpService,
    shutdown,
  };
}
