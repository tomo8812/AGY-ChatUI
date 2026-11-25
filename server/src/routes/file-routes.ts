import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isArtifactError } from '../artifacts/errors.js';
import { convertPresentationToPdfCached } from '../files/artifacts.js';
import { computeStrongEtag, formatHttpDate, isFreshRequest } from '../files/http-cache.js';
import { resolveArtifactFile, resolveAuthorizedChatFileReference } from '../files/link-resolver.js';
import { listWorkspaceFiles, resolveContainedExistingPath } from '../files/workspace.js';
import { HTML_SANDBOX_CSP, injectSandboxZoomBridge } from '../files/sandbox-bridge.js';
import type { ArtifactRecord } from '../types.js';
import { buildLiveSessionAuthVerifier, requireAuth, type RouteDeps } from './auth-routes.js';

export { injectSandboxZoomBridge };

function sendArtifactError(reply: FastifyReply, err: unknown) {
  if (isArtifactError(err)) {
    return reply.code(err.statusCode).send({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  const code = (err as { code?: string }).code ?? 'INTERNAL_ERROR';
  const message = err instanceof Error ? err.message : '処理中にエラーが発生しました。';
  return reply.code(status).send({ error: code, message });
}

function resolveArtifactHostPath(
  deps: RouteDeps,
  userId: string,
  artifact: ArtifactRecord
): { absPath: string; relPath: string } | null {
  if (artifact.scopeKind === 'project' && artifact.projectId) {
    const project = deps.db.getProject(userId, artifact.projectId);
    if (!project) return null;
    try {
      return resolveContainedExistingPath(project.storageDir, artifact.relPath);
    } catch {
      return null;
    }
  }
  if (!artifact.chatId) return null;
  const chat = deps.db.getChat(userId, artifact.chatId);
  if (!chat) return null;
  return resolveArtifactFile(deps.db, chat, artifact, deps.config.builtinSkillsDir);
}

function sendByteRangeOrFull(params: {
  req: { headers: Record<string, string | string[] | undefined> };
  reply: FastifyReply;
  absPath: string;
  totalSize: number;
  etag: string;
  forceDownload: boolean;
}) {
  const { req, reply, absPath, totalSize, etag, forceDownload } = params;
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const ifRange = typeof req.headers['if-range'] === 'string' ? req.headers['if-range'].trim() : undefined;

  // Strict RFC 9110 §13.1.5 If-Range strong comparison (`ARCH-08`):
  // Weak ETags (`W/"..."`) NEVER satisfy If-Range; fall back to full 200 OK representation.
  const ifRangeSatisfied = !ifRange || (!ifRange.startsWith('W/') && !etag.startsWith('W/') && ifRange === etag);

  if (rangeHeader && !forceDownload && ifRangeSatisfied) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) {
      reply.code(416).header('Content-Range', `bytes */${totalSize}`);
      return reply.send();
    }
    let start: number;
    let end: number;
    if (!match[1] && match[2]) {
      // Suffix byte range: bytes=-N
      const suffix = Number.parseInt(match[2], 10);
      if (Number.isNaN(suffix) || suffix <= 0) {
        reply.code(416).header('Content-Range', `bytes */${totalSize}`);
        return reply.send();
      }
      start = Math.max(0, totalSize - suffix);
      end = totalSize - 1;
    } else {
      start = match[1] ? Number.parseInt(match[1], 10) : 0;
      end = match[2] ? Math.min(Number.parseInt(match[2], 10), totalSize - 1) : totalSize - 1;
    }
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
}

export async function registerFileRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, db, artifactService } = deps;

  app.get('/api/chats/:chatId/workspace', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const chat = db.getChat(session.user.id, chatId);
    if (!chat) return reply.code(404).send({ error: 'NOT_FOUND', message: 'チャットが見つかりません。' });

    const files = listWorkspaceFiles(chat.workspaceDir, true);
    const artifacts = db.listArtifactsForChat(session.user.id, chatId);

    const etagParts: Array<string | number> = ['ws-v1', chatId, files.length, artifacts.length];
    let latestMtime = chat.updatedAt;
    for (const f of files) {
      etagParts.push(f.relPath, f.sizeBytes, f.mtimeMs);
      if (f.mtimeMs > latestMtime) latestMtime = f.mtimeMs;
    }
    for (const a of artifacts) {
      etagParts.push(a.id, a.revision, a.sha256, a.updatedAt);
      if (a.updatedAt > latestMtime) latestMtime = a.updatedAt;
    }

    const etag = computeStrongEtag(etagParts);
    reply.header('Vary', 'Cookie');
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
    reply.header('ETag', etag);
    reply.header('Last-Modified', formatHttpDate(latestMtime));

    if (isFreshRequest(req.headers, etag, latestMtime)) {
      return reply.code(304).send();
    }

    return { files, artifacts };
  });

  app.post('/api/chats/:chatId/resolve-link', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const body = z.object({ reference: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    const resolved = await resolveAuthorizedChatFileReference({
      artifactService,
      db,
      userId: session.user.id,
      chatId,
      reference: body.data.reference,
      builtinSkillsDir: config.builtinSkillsDir,
    });
    if (!resolved) {
      return reply.code(404).send({ error: 'LINK_NOT_FOUND', message: '対象ファイルが見つからないか権限がありません。' });
    }
    return resolved;
  });

  app.post('/api/chats/:chatId/artifacts', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const parsed = z
      .object({
        relPath: z.string().min(1),
        content: z.string().optional(),
        contentBase64: z.string().optional(),
        createParams: z.record(z.unknown()).optional(),
        mimeType: z.string().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
        operationSummary: z.string().max(300).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const contentBuf =
        parsed.data.contentBase64 !== undefined
          ? Buffer.from(parsed.data.contentBase64, 'base64')
          : parsed.data.content !== undefined
            ? Buffer.from(parsed.data.content, 'utf8')
            : undefined;
      const result = await artifactService.createArtifact({
        userId: session.user.id,
        scopeKind: 'chat',
        chatId,
        relPath: parsed.data.relPath,
        mimeType: parsed.data.mimeType,
        content: contentBuf,
        createParams: parsed.data.createParams,
        actorKind: 'user',
        actorId: session.user.id,
        idempotencyKey: parsed.data.idempotencyKey,
        operationSummary: parsed.data.operationSummary,
        assertAuthorized: buildLiveSessionAuthVerifier(req, db, session.user.id),
      });
      return reply.code(201).send(result);
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.get('/api/files/:artifactId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const artifact = db.getArtifact(session.user.id, artifactId);
    if (!artifact) return reply.code(404).send({ error: 'NOT_FOUND', message: '成果物が見つかりません。' });
    if (!resolveArtifactHostPath(deps, session.user.id, artifact)) {
      return reply.code(404).send({ error: 'FILE_MISSING', message: '参照先のファイルが見つかりません。' });
    }
    return { artifact };
  });

  const servePinnedRevisionContent = async (params: {
    req: { headers: Record<string, string | string[] | undefined> };
    reply: FastifyReply;
    userId: string;
    artifactId: string;
    revNum: number;
    query: { download?: string; converted?: string; v?: string; d?: string };
    immutableByPath: boolean;
  }) => {
    const { req, reply, userId, artifactId, revNum, query, immutableByPath } = params;
    const { artifact, revision, blobPath, sizeBytes } = artifactService.getRevisionContentBlob(userId, artifactId, revNum);
    const forceDownload = query.download === '1' || query.download === 'true';
    const isConvertedPdf = query.converted === 'pdf' && (artifact.previewKind === 'pptx' || artifact.previewKind === 'docx');

    let serveAbsPath = blobPath;
    let serveSize = sizeBytes;
    let serveMime = artifact.mimeType;
    let serveFilename = artifact.filename;

    if (isConvertedPdf) {
      const convertedPath = artifact.previewKind === 'docx'
        ? await artifactService.renderDocxPreviewPdf(userId, artifact.id, revision.revision)
        : await convertPresentationToPdfCached({
        artifactService,
        artifactId: artifact.id,
        revision: revision.revision,
        sourceAbsPath: blobPath,
        sourceFilename: artifact.filename,
        sourceSha256: revision.sha256,
        dependencyManifestHash: revision.dependencyManifestHash,
      });
      if (!convertedPath) {
        return reply.code(422).send({
          error: 'CONVERSION_UNAVAILABLE',
          message: 'この環境にはプレゼン変換用のLibreOfficeが導入されていないため、原本ダウンロードをご利用ください。',
        });
      }
      const stat = await fs.promises.stat(convertedPath);
      serveAbsPath = convertedPath;
      serveSize = stat.size;
      serveMime = 'application/pdf';
      serveFilename = `${artifact.filename}.pdf`;
    }

    const expectedV = revision.sha256.slice(0, 12);
    const expectedD = revision.dependencyManifestHash ? revision.dependencyManifestHash.slice(0, 8) : null;
    const depMatches = !expectedD || query.d === expectedD;
    const isImmutable = !forceDownload && (immutableByPath ? depMatches : Boolean(query.v && query.v === expectedV && depMatches));
    const variant = isConvertedPdf ? 'pdf' : forceDownload ? 'dl' : 'inline';
    const etag = computeStrongEtag([
      artifact.id,
      'rev',
      revision.revision,
      revision.sha256,
      revision.dependencyManifestHash ?? '',
      variant,
    ]);

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Artifact-Revision', String(revision.revision));
    reply.header(
      'Content-Location',
      isConvertedPdf
        ? `/api/files/${artifact.id}/revisions/${revision.revision}/content?converted=pdf`
        : `/api/files/${artifact.id}/revisions/${revision.revision}/content`
    );
    reply.header('Vary', 'Cookie');
    reply.header('ETag', etag);
    reply.header('Last-Modified', formatHttpDate(revision.createdAt));
    reply.header(
      'Cache-Control',
      isImmutable ? 'private, max-age=31536000, immutable' : 'private, max-age=0, must-revalidate'
    );
    reply.header('Accept-Ranges', 'bytes');

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

    if (isFreshRequest(req.headers, etag, revision.createdAt)) {
      return reply.code(304).send();
    }
    return sendByteRangeOrFull({ req, reply, absPath: serveAbsPath, totalSize: serveSize, etag, forceDownload });
  };

  // Immutable revision-pinned content endpoint (supports raw & `?converted=pdf` from immutable blob)
  app.get('/api/files/:artifactId/revisions/:rev/content', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId, rev: revParam } = req.params as { artifactId: string; rev: string };
    const query = req.query as { download?: string; converted?: string; v?: string; d?: string };
    const revNum = Number.parseInt(revParam, 10);
    if (!Number.isInteger(revNum) || revNum < 1) {
      return reply.code(400).send({ error: 'INVALID_REVISION' });
    }

    try {
      return await servePinnedRevisionContent({
        req,
        reply,
        userId: session.user.id,
        artifactId,
        revNum,
        query,
        immutableByPath: true,
      });
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.get('/api/files/:artifactId/content', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const query = req.query as { download?: string; converted?: string; v?: string; rev?: string; d?: string };

    const artifact = db.getArtifact(session.user.id, artifactId);
    if (!artifact) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'ファイルが存在しないかアクセス権がありません。' });
    }

    const forceDownload = query.download === '1' || query.download === 'true';
    const isConvertedPdf = query.converted === 'pdf' && artifact.previewKind === 'pptx';

    // Revision-pinned immutable blob serving (`?rev=<rev>&v=<sha12>[&d=<dep8>][&converted=pdf]`)
    if (query.rev) {
      const revNum = Number.parseInt(query.rev, 10);
      if (!Number.isInteger(revNum) || revNum < 1) {
        return reply.code(400).send({ error: 'INVALID_REVISION' });
      }
      try {
        return await servePinnedRevisionContent({
          req,
          reply,
          userId: session.user.id,
          artifactId,
          revNum,
          query,
          immutableByPath: false,
        });
      } catch (err) {
        return sendArtifactError(reply, err);
      }
    }

    const file = resolveArtifactHostPath(deps, session.user.id, artifact);
    if (!file) return reply.code(403).send({ error: 'FORBIDDEN' });
    let absPath = file.absPath;

    let serveMime = artifact.mimeType;
    let serveFilename = artifact.filename;

    if (isConvertedPdf) {
      const convertedPath = await convertPresentationToPdfCached({
        artifactService,
        artifactId: artifact.id,
        revision: artifact.revision,
        sourceAbsPath: absPath,
        sourceFilename: artifact.filename,
        sourceSha256: artifact.sha256,
        dependencyManifestHash: artifact.dependencyManifestHash,
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

    const stat = await fs.promises.stat(absPath);
    const totalSize = stat.size;
    const expectedV = artifact.sha256 ? artifact.sha256.slice(0, 12) : '';
    const diskMatchesArtifact =
      isConvertedPdf || (stat.size === artifact.sizeBytes && Math.floor(stat.mtimeMs) <= artifact.updatedAt);
    // Disallow long-term cache on legacy unpinned `?v=` URLs when artifact has relative dependencies
    const depCheckOk = !artifact.dependencyManifestHash || query.d === artifact.dependencyManifestHash.slice(0, 8);
    const hasMatchingVersion = Boolean(
      query.v && expectedV && query.v === expectedV && !forceDownload && diskMatchesArtifact && depCheckOk
    );

    const variant = isConvertedPdf ? 'pdf' : forceDownload ? 'dl' : 'inline';
    const etag = computeStrongEtag([
      artifact.id,
      artifact.revision,
      artifact.sha256,
      variant,
      totalSize,
      Math.round(stat.mtimeMs * 1000),
    ]);

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Artifact-Revision', String(artifact.revision));
    reply.header('Content-Location', `/api/files/${artifact.id}/revisions/${artifact.revision}/content`);
    reply.header('Vary', 'Cookie');
    reply.header('ETag', etag);
    reply.header('Last-Modified', formatHttpDate(stat.mtimeMs));
    reply.header(
      'Cache-Control',
      hasMatchingVersion ? 'private, max-age=300, stale-while-revalidate=3600' : 'private, max-age=0, must-revalidate'
    );
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

    if (isFreshRequest(req.headers, etag, stat.mtimeMs)) {
      return reply.code(304).send();
    }

    return sendByteRangeOrFull({ req, reply, absPath, totalSize, etag, forceDownload });
  });

  app.get('/api/files/:artifactId/sandbox', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const query = req.query as { v?: string; d?: string };

    const artifact = db.getArtifact(session.user.id, artifactId);
    if (!artifact || artifact.previewKind !== 'html') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    const file = resolveArtifactHostPath(deps, session.user.id, artifact);
    if (!file) return reply.code(404).send({ error: 'FILE_MISSING' });
    const { absPath } = file;
    const stat = await fs.promises.stat(absPath);

    const expectedV = artifact.sha256 ? artifact.sha256.slice(0, 12) : '';
    const diskMatchesArtifact =
      stat.size === artifact.sizeBytes && Math.floor(stat.mtimeMs) <= artifact.updatedAt;
    const depCheckOk = !artifact.dependencyManifestHash || query.d === artifact.dependencyManifestHash.slice(0, 8);
    const hasMatchingVersion = Boolean(query.v && expectedV && query.v === expectedV && diskMatchesArtifact && depCheckOk);

    const etag = computeStrongEtag([
      'sandbox-v2',
      artifact.id,
      artifact.revision,
      artifact.sha256,
      stat.size,
      Math.round(stat.mtimeMs * 1000),
    ]);

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Artifact-Revision', String(artifact.revision));
    reply.header('Vary', 'Cookie');
    reply.header('ETag', etag);
    reply.header('Last-Modified', formatHttpDate(stat.mtimeMs));
    reply.header(
      'Cache-Control',
      hasMatchingVersion ? 'private, max-age=300, stale-while-revalidate=3600' : 'private, max-age=0, must-revalidate'
    );
    reply.header('Content-Security-Policy', HTML_SANDBOX_CSP);
    reply.header('Content-Type', 'text/html; charset=utf-8');

    if (isFreshRequest(req.headers, etag, stat.mtimeMs)) {
      return reply.code(304).send();
    }

    const html = await fs.promises.readFile(absPath, 'utf8');
    return reply.send(injectSandboxZoomBridge(html));
  });

  app.post('/api/files/:artifactId/copy-to-project', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const parsed = z.object({ projectId: z.string().min(1), filename: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    const artifact = db.getArtifact(session.user.id, artifactId);
    if (!artifact) return reply.code(404).send({ error: 'ARTIFACT_NOT_FOUND' });
    const project = db.getProject(session.user.id, parsed.data.projectId);
    if (!project) return reply.code(404).send({ error: 'PROJECT_NOT_FOUND' });

    const fileSource = resolveArtifactHostPath(deps, session.user.id, artifact);
    if (!fileSource) return reply.code(404).send({ error: 'FILE_MISSING' });

    try {
      const { file } = await artifactService.copyArtifactToProject({
        userId: session.user.id,
        artifactId,
        projectId: project.id,
        targetFilename: parsed.data.filename,
        srcAbsPathOverride: fileSource.absPath,
        assertAuthorized: buildLiveSessionAuthVerifier(req, db, session.user.id),
      });
      const latestProject = db.getProject(session.user.id, project.id)!;
      const full = { ...latestProject, files: db.listProjectFiles(session.user.id, project.id) };
      return { project: full, file };
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.get('/api/files/:artifactId/capabilities', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    try {
      return artifactService.getCapabilities(session.user.id, artifactId);
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.get('/api/files/:artifactId/structure', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    try {
      return await artifactService.getStructure(session.user.id, artifactId);
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.get('/api/files/:artifactId/range', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const query = (req.query ?? {}) as Record<string, unknown>;
    try {
      return await artifactService.readRange(session.user.id, artifactId, {
        ...query, ...(query.evaluate === 'true' ? { evaluate: true } : {}),
      });
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  const renderQuerySchema = z.object({
    pageIndex: z.coerce.number().int().min(0).optional(),
    timeSeconds: z.coerce.number().finite().min(0).optional(),
    variant: z.enum(['background', 'sprite']).optional(),
    shapeId: z.coerce.number().int().positive().optional(),
    regionX: z.coerce.number().finite().min(0).optional(),
    regionY: z.coerce.number().finite().min(0).optional(),
    regionWidth: z.coerce.number().finite().positive().optional(),
    regionHeight: z.coerce.number().finite().positive().optional(),
    regionUnit: z.enum(['norm', 'px', 'pt']).optional(),
  });

  app.get('/api/files/:artifactId/render', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const query = renderQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'INVALID_RENDER_OPTIONS' });
    const { regionX, regionY, regionWidth, regionHeight, regionUnit, ...baseOptions } = query.data;
    const hasAnyRegion = [regionX, regionY, regionWidth, regionHeight].some((v) => v !== undefined);
    if (hasAnyRegion && [regionX, regionY, regionWidth, regionHeight].some((v) => v === undefined)) {
      return reply.code(400).send({ error: 'INVALID_RENDER_REGION' });
    }
    const region = hasAnyRegion
      ? { x: regionX!, y: regionY!, width: regionWidth!, height: regionHeight!, unit: regionUnit }
      : undefined;
    const { artifactId } = req.params as { artifactId: string };
    try {
      const { png, revision, sha256 } = await artifactService.renderPng(session.user.id, artifactId, { ...baseOptions, region });
      return reply.type('image/png').header('Cache-Control', 'private, no-store')
        .header('X-Artifact-Revision', revision).header('X-Artifact-Sha256', sha256).send(png);
    } catch (error) {
      return sendArtifactError(reply, error);
    }
  });

  app.post('/api/files/:artifactId/render-draft-sprite', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const parsed = z.object({
      expectedRevision:z.number().int().min(1), pageIndex:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      shapeId:z.number().int().positive().max(2147483647),
      text:z.string().max(20000).optional(),
      boundsPt:z.tuple([z.number().finite().min(-14400).max(14400),z.number().finite().min(-14400).max(14400),z.number().finite().min(1).max(14400),z.number().finite().min(1).max(14400)]).optional(),
      style:z.object({bold:z.boolean().optional(),italic:z.boolean().optional(),fontSizePt:z.number().finite().min(6).max(200).optional(),fontColor:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),fill:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()}).strict().optional(),
    }).strict().refine(body=>body.text!==undefined||body.boundsPt!==undefined||body.style!==undefined).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({error:'INVALID_INPUT'});
    const {artifactId}=req.params as {artifactId:string};
    try {
      const assertAuthorized=buildLiveSessionAuthVerifier(req,db,session.user.id);
      const result=await artifactService.renderPptxDraftSprite(session.user.id,artifactId,parsed.data,assertAuthorized);
      await assertAuthorized();
      return reply.type('image/png').header('Cache-Control','private, no-store')
        .header('X-Artifact-Revision',result.revision).header('X-Artifact-Sha256',result.sha256).send(result.png);
    } catch (error) { return sendArtifactError(reply,error); }
  });

  const draftBoundsSchema=z.tuple([z.number().finite().min(-14400).max(14400),z.number().finite().min(-14400).max(14400),z.number().finite().min(1).max(14400),z.number().finite().min(1).max(14400)]);
  const draftSlidePartSchema=z.string().regex(/^ppt\/slides\/[^/]+\.xml$/).max(200);
  const draftSlideOperation=z.discriminatedUnion('op',[
    z.object({op:z.literal('pptx.add_shape'),slidePart:draftSlidePartSchema,kind:z.enum(['rectangle','ellipse','textbox']),boundsPt:draftBoundsSchema,text:z.string().max(20000)}).strict(),
    z.object({op:z.literal('pptx.add_image'),slidePart:draftSlidePartSchema,boundsPt:draftBoundsSchema,imageBase64:z.string().min(1).max(8_000_000)}).strict(),
    z.object({op:z.literal('pptx.add_table'),slidePart:draftSlidePartSchema,boundsPt:draftBoundsSchema,rows:z.array(z.array(z.string().max(20_000)).min(1).max(30)).min(1).max(100)}).strict(),
    z.object({op:z.literal('pptx.remove_shape'),slidePart:draftSlidePartSchema,shapeId:z.number().int().positive().max(2147483647)}).strict(),
    z.object({op:z.literal('pptx.add_slide'),index:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),layoutPart:z.string().regex(/^ppt\/slideLayouts\/slideLayout[0-9]+\.xml$/)}).strict(),
    z.object({op:z.literal('pptx.remove_slide'),index:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict(),
    z.object({op:z.literal('pptx.reorder_slide'),index:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),toIndex:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict(),
  ]);
  app.post('/api/files/:artifactId/render-draft-slide',async(req,reply)=>{
    const session=requireAuth(req,reply,db);if(!session)return;
    const parsed=z.object({expectedRevision:z.number().int().positive(),pageIndex:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),operation:draftSlideOperation}).strict().safeParse(req.body);
    if(!parsed.success)return reply.code(400).send({error:'INVALID_INPUT'});
    const {artifactId}=req.params as {artifactId:string};
    try{
      const assertAuthorized=buildLiveSessionAuthVerifier(req,db,session.user.id);
      const result=await artifactService.renderPptxDraftSlide(session.user.id,artifactId,parsed.data,assertAuthorized);
      await assertAuthorized();
      return reply.type('image/png').header('Cache-Control','private, no-store').header('X-Artifact-Revision',result.revision).header('X-Artifact-Sha256',result.sha256).send(result.png);
    }catch(error){return sendArtifactError(reply,error)}
  });
  const editBodySchema = z.object({
    expectedRevision: z.number().int().min(1),
    operations: z.array(z.object({ op: z.string().min(1) }).passthrough()).min(1),
    idempotencyKey: z.string().min(1).max(200).optional(),
    operationSummary: z.string().max(300).optional(),
  });

  app.post('/api/files/:artifactId/edit', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const parsed = editBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      return await artifactService.editArtifact({
        userId: session.user.id,
        artifactId,
        expectedRevision: parsed.data.expectedRevision,
        operations: parsed.data.operations,
        actorKind: 'user',
        actorId: session.user.id,
        idempotencyKey: parsed.data.idempotencyKey,
        operationSummary: parsed.data.operationSummary,
        assertAuthorized: buildLiveSessionAuthVerifier(req, db, session.user.id),
      });
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.post('/api/files/:artifactId/batch-edit', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const parsed = editBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      return await artifactService.editArtifact({
        userId: session.user.id,
        artifactId,
        expectedRevision: parsed.data.expectedRevision,
        operations: parsed.data.operations,
        actorKind: 'user',
        actorId: session.user.id,
        idempotencyKey: parsed.data.idempotencyKey,
        operationSummary: parsed.data.operationSummary,
        assertAuthorized: buildLiveSessionAuthVerifier(req, db, session.user.id),
      });
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.post('/api/files/:artifactId/verify', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const parsed = z
      .object({
        slideIndices: z.array(z.number().int().min(0).max(500)).max(50).optional(),
        maxSlides: z.number().int().min(1).max(50).optional(),
        maxShapesPerSlide: z.number().int().min(1).max(100).optional(),
        selector: z.string().min(1).max(512).optional(),
        elementOffset: z.number().int().min(0).max(100_000).optional(),
        maxElements: z.number().int().min(1).max(250).optional(),
      })
      .optional()
      .safeParse(req.body ?? undefined);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'verify options が不正です。' });
    }
    try {
      return await artifactService.verifyArtifact(session.user.id, artifactId, parsed.data);
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.post('/api/files/:artifactId/export', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const parsed = z
      .object({
        targetFormat: z.string().min(1),
        outputRelPath: z.string().min(1).optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const { artifact } = await artifactService.exportArtifact({
        userId: session.user.id,
        artifactId,
        targetFormat: parsed.data.targetFormat,
        outputRelPath: parsed.data.outputRelPath,
        actorKind: 'user',
        actorId: session.user.id,
        idempotencyKey: parsed.data.idempotencyKey,
        assertAuthorized: buildLiveSessionAuthVerifier(req, db, session.user.id),
      });
      return reply.code(201).send({ artifact });
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.get('/api/files/:artifactId/history', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    try {
      const revisions = artifactService.listHistory(session.user.id, artifactId);
      const undoState = artifactService.getUndoState(session.user.id, artifactId, 'user', session.user.id);
      return { revisions, undoState };
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.post('/api/files/:artifactId/restore', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const parsed = z
      .object({
        targetRevision: z.number().int().min(1),
        idempotencyKey: z.string().min(1).max(200).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      return await artifactService.restoreRevision({
        userId: session.user.id,
        artifactId,
        targetRevision: parsed.data.targetRevision,
        actorKind: 'user',
        actorId: session.user.id,
        idempotencyKey: parsed.data.idempotencyKey,
        assertAuthorized: buildLiveSessionAuthVerifier(req, db, session.user.id),
      });
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.post('/api/files/:artifactId/restore-bundle', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const parsed = z
      .object({
        targetRevision: z.number().int().min(1),
        sharedPolicy: z.enum(['overwrite_shared', 'skip_shared']).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      const batch = await artifactService.restoreBundle({
        userId: session.user.id,
        parentArtifactId: artifactId,
        targetRevision: parsed.data.targetRevision,
        sharedPolicy: parsed.data.sharedPolicy,
        actorKind: 'user',
        actorId: session.user.id,
        assertAuthorized: buildLiveSessionAuthVerifier(req, db, session.user.id),
      });
      return { batch };
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.post('/api/files/:artifactId/undo', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const body = (req.body ?? {}) as { idempotencyKey?: string };
    try {
      return await artifactService.undo({
        userId: session.user.id,
        artifactId,
        actorKind: 'user',
        actorId: session.user.id,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
        assertAuthorized: buildLiveSessionAuthVerifier(req, db, session.user.id),
      });
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.post('/api/files/:artifactId/redo', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const body = (req.body ?? {}) as { idempotencyKey?: string };
    try {
      return await artifactService.redo({
        userId: session.user.id,
        artifactId,
        actorKind: 'user',
        actorId: session.user.id,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
        assertAuthorized: buildLiveSessionAuthVerifier(req, db, session.user.id),
      });
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });

  app.post('/api/files/:artifactId/reflect-to-project', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { artifactId } = req.params as { artifactId: string };
    const parsed = z
      .object({
        expectedProjectRevision: z.number().int().min(1).optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    try {
      return await artifactService.reflectWorkingCopyToProject({
        userId: session.user.id,
        workingCopyArtifactId: artifactId,
        expectedProjectRevision: parsed.data.expectedProjectRevision,
        actorKind: 'user',
        actorId: session.user.id,
        idempotencyKey: parsed.data.idempotencyKey,
        assertAuthorized: buildLiveSessionAuthVerifier(req, db, session.user.id),
      });
    } catch (err) {
      return sendArtifactError(reply, err);
    }
  });
}
