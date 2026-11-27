import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RichNode, RichStateValue } from '../../../shared/rich-schema.js';
import type { ArtifactService } from '../artifacts/artifact-service.js';
import { ArtifactError } from '../artifacts/errors.js';
import type { AppDatabase } from '../db/database.js';
import type { EditRequestService } from '../edit-requests/edit-request-service.js';
import type { RichContentService } from '../rich/rich-content-service.js';

export const BUILTIN_ARTIFACT_MCP_NAME = 'agy_artifact';
export const BUILTIN_ARTIFACT_TOOLS = {
  artifact_list: '成果物の一覧',
  artifact_capabilities: '利用できる成果物操作の確認',
  artifact_create: '成果物の作成',
  artifact_get_structure: '成果物の構造取得',
  artifact_read_range: '指定範囲の読み取り',
  artifact_edit: '成果物の編集',
  artifact_batch_edit: '成果物の一括編集',
  artifact_render: '成果物の画像化',
  artifact_verify: '成果物の検証',
  artifact_export: '成果物の形式変換',
  artifact_history: '成果物の版履歴',
  artifact_restore: '過去の版への復元',
  artifact_restore_bundle: '関連ファイルを含む一括復元',
  edit_request_list: '編集依頼の一覧',
  edit_request_get: '編集依頼の詳細',
  edit_request_mark_applied: '編集依頼への対応を記録',
  rich_capabilities: 'リッチ回答の対応機能の確認',
  rich_validate: 'リッチ回答の検証',
  rich_create: 'リッチ回答の作成',
  rich_get: 'リッチ回答の取得',
  rich_update: 'リッチ回答の更新',
  rich_save_as_artifact: 'リッチ回答を成果物として保存',
} as const;

export function effectiveBuiltinMcpPolicy(db: AppDatabase, userId: string, projectId?: string | null, chatId?: string | null) {
  let enabled = true;
  let disabledTools: string[] = [];
  const scopes = ['shared', `profile:${userId}`];
  if (projectId) scopes.push(`project:${projectId}`);
  if (chatId) scopes.push(`chat:${chatId}`);
  for (const scope of scopes) {
    const settings = db.getBuiltinMcpSettings(scope);
    enabled = settings.enabled ?? enabled;
    disabledTools = settings.disabledTools ?? disabledTools;
  }
  return { enabled, disabledTools };
}

export type BuiltinMcpBinding = {
  userId: string;
  chatId: string;
  tentativeTurn: () => { messageId: string; runId: string } | null;
};

const identifier = z.string().min(1).max(256);
const revision = z.number().int().positive();
const object = z.record(z.unknown());
const operation = z.object({ op: identifier }).passthrough();
const artifactId = { artifactId: identifier };
const blockId = { blockId: identifier };
const requestId = { requestId: identifier };
const idempotencyKey = { idempotencyKey: identifier };

function readCreatedBlockId(output: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  if (typeof output === 'string' && output.length <= 16_384) {
    try { return readCreatedBlockId(JSON.parse(output), depth + 1); }
    catch { return null; }
  }
  if (!output || typeof output !== 'object') return null;
  if (Array.isArray(output)) return output.length === 1 ? readCreatedBlockId(output[0], depth + 1) : null;
  const record = output as Record<string, unknown>;
  if (typeof record.blockId === 'string' && record.referenceUrl === `agy-rich://${record.blockId}`) {
    return record.blockId;
  }
  if (record.type === 'text') return readCreatedBlockId(record.text, depth + 1);
  if (Array.isArray(record.content) && record.content.length === 1) {
    return readCreatedBlockId(record.content[0], depth + 1);
  }
  return null;
}

class ToolOutput {
  constructor(readonly content: CallToolResult['content']) {}
}

export class BuiltinArtifactMcpServer {
  private readonly tokens = new Map<string, BuiltinMcpBinding & { createdBlocks: Set<string> }>();
  private listener?: http.Server;
  private listening?: Promise<number>;

  constructor(
    private readonly db: AppDatabase,
    private readonly artifacts: ArtifactService,
    private readonly editRequests: EditRequestService,
    private readonly rich: RichContentService
  ) {}

  async bind(binding: BuiltinMcpBinding, usedNames: ReadonlySet<string>) {
    const chat = this.db.getChat(binding.userId, binding.chatId);
    if (!chat || !effectiveBuiltinMcpPolicy(this.db, binding.userId, chat.projectId, chat.id).enabled) return undefined;
    const port = await (this.listening ??= this.listen());
    const token = crypto.randomBytes(32).toString('base64url');
    const createdBlocks = new Set<string>();
    this.tokens.set(token, { ...binding, createdBlocks });
    let name = BUILTIN_ARTIFACT_MCP_NAME;
    for (let suffix = 1; usedNames.has(name); suffix++) {
      name = suffix === 1 ? 'agy_artifact_builtin' : `agy_artifact_builtin_${suffix}`;
    }
    return {
      server: {
        type: 'http' as const,
        name,
        url: `http://127.0.0.1:${port}/mcp`,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
      },
      permissionTarget: () => {
        const current = this.db.getChat(binding.userId, binding.chatId);
        const policy = current && effectiveBuiltinMcpPolicy(this.db, binding.userId, current.projectId, current.id);
        return {
          name,
          discoveredTools: this.tokens.has(token) && policy?.enabled
            ? Object.keys(BUILTIN_ARTIFACT_TOOLS).filter((tool) => !policy.disabledTools.includes(tool))
            : [],
          strictTools: true,
        };
      },
      revoke: () => this.tokens.delete(token),
      confirm: (toolName: string, output: unknown, messageId: string, runId: string, toolCallId: string) => {
        if (!this.tokens.has(token) || ![
          `${name}/rich_create`, `mcp(${name}/rich_create)`, `mcp__${name}__rich_create`,
        ].includes(toolName)) return;
        const blockId = readCreatedBlockId(output);
        if (blockId && createdBlocks.has(blockId)) {
          this.rich.confirmBlockBinding({
            userId: binding.userId, chatId: binding.chatId, blockId, messageId, runId, toolCallId,
          });
          createdBlocks.delete(blockId);
        }
      },
    };
  }

  private async listen(): Promise<number> {
    const listener = http.createServer({ requestTimeout: 30_000 }, (req, res) => {
      void this.handle(req, res).catch(() => {
        if (res.headersSent) res.destroy();
        else res.writeHead(500).end();
      });
    });
    this.listener = listener;
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
      });
      return (listener.address() as AddressInfo).port;
    } catch (error) {
      this.listener = undefined;
      this.listening = undefined;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.tokens.clear();
    const listener = this.listener;
    if (listener) {
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
        listener.closeAllConnections();
      });
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const port = (this.listener?.address() as AddressInfo | null)?.port;
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const binding = token ? this.tokens.get(token) : undefined;
    const chat = binding && this.db.getChat(binding.userId, binding.chatId);
    if (!token || !binding || !chat) {
      res.writeHead(401).end();
      return;
    }
    if (!effectiveBuiltinMcpPolicy(this.db, binding.userId, chat.projectId, chat.id).enabled) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const server = this.makeServer(token, binding);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.once('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  private makeServer(token: string, binding: BuiltinMcpBinding & { createdBlocks: Set<string> }): McpServer {
    const { userId, chatId } = binding;
    const context = { userId, chatId };
    const actor = { actorKind: 'ai' as const, actorId: userId };
    const server = new McpServer({ name: BUILTIN_ARTIFACT_MCP_NAME, version: '1.0.0' });
    const currentPolicy = () => {
      const chat = this.db.getChat(userId, chatId);
      return chat && effectiveBuiltinMcpPolicy(this.db, userId, chat.projectId, chatId);
    };
    const policy = currentPolicy();
    const assertToolAuthorized = (name: string) => {
      const latest = currentPolicy();
      if (!this.tokens.has(token) || !latest?.enabled || latest.disabledTools.includes(name)) {
        throw new ArtifactError('FORBIDDEN', 'MCP session authorization expired.', 403);
      }
    };
    const assertArtifact = (id: string) => {
      const artifact = this.db.getArtifact(userId, id);
      if (artifact?.scopeKind !== 'chat' || artifact.chatId !== chatId) {
        throw new ArtifactError('FORBIDDEN', 'Artifact access is outside the MCP session scope.', 403);
      }
    };
    const tool = <T extends z.ZodRawShape>(
      name: keyof typeof BUILTIN_ARTIFACT_TOOLS,
      description: string,
      shape: T,
      handler: (input: z.objectOutputType<T, z.ZodTypeAny>, authorize: () => void) => unknown
    ) => {
      if (!policy?.enabled || policy.disabledTools.includes(name)) return;
      // Parse at the call boundary as well so handler types stay tied to the same schema.
        const schema = z.object(shape);
      server.registerTool(name, { description, inputSchema: shape as z.ZodRawShape }, async (input): Promise<CallToolResult> => {
        try {
          const authorize = () => assertToolAuthorized(name);
          authorize();
          const result = await handler(schema.parse(input), authorize);
          if (result instanceof ToolOutput) return { content: result.content };
          return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
        } catch (error) {
          const known = error instanceof Error && 'code' in error && 'statusCode' in error;
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify(known
                ? { code: error.code, message: error.message, status: error.statusCode, ...('details' in error ? { details: error.details } : {}) }
                : { code: 'TOOL_ERROR', message: 'The operation failed.' }),
            }],
          };
        }
      });
    };

    tool('artifact_list', 'List artifacts in the current chat.', {}, () => this.db.listArtifactsForChat(userId, chatId));
    tool('artifact_capabilities', 'Get available operations for an artifact.', artifactId, ({ artifactId }) => {
      assertArtifact(artifactId);
      return this.artifacts.getCapabilities(userId, artifactId);
    });
    tool('artifact_create', 'Create an artifact in the current chat. PDF creation can merge PDFs listed in createParams.sourceArtifactIds.', {
      relPath: z.string().min(1).max(1024),
      content: z.string().optional(),
      createParams: object.optional(),
      ...idempotencyKey,
    }, ({ relPath, content, createParams, idempotencyKey }, authorize) => this.artifacts.createArtifact({
      ...context, ...actor, scopeKind: 'chat', relPath, createParams, idempotencyKey,
      content: content === undefined ? undefined : Buffer.from(content),
      assertAuthorized: authorize,
    }));
    tool('artifact_get_structure', 'Inspect an artifact’s structure.', artifactId, ({ artifactId }) => {
      assertArtifact(artifactId);
      return this.artifacts.getStructure(userId, artifactId);
    });
    tool('artifact_read_range', 'Read a range of an artifact. PDF uses pageIndex. XLSX uses sheetId and rangeA1 and can request evaluate.', { ...artifactId, range: object }, ({ artifactId, range }) => {
      assertArtifact(artifactId);
      return this.artifacts.readRange(userId, artifactId, range);
    });
    const editRequestIds = z.array(identifier).min(1).max(100)
      .refine(ids => new Set(ids).size === ids.length).optional();
    tool('artifact_edit', 'Apply one operation to an artifact. Include editRequestIds for requests read via edit_request_get.', {
      ...artifactId, expectedRevision: revision, operation, ...idempotencyKey, editRequestIds,
    }, ({ operation, ...input }, authorize) => {
      assertArtifact(input.artifactId);
      return this.artifacts.editArtifact({
        userId, ...actor, ...input, operations: [operation],
        assertAuthorized: () => { authorize(); assertArtifact(input.artifactId); },
        assertEditRequestsCurrent: () => this.editRequests.assertAgentMutation({
          ...context, ...input, targetKind: 'artifact', targetId: input.artifactId,
        }),
      });
    });
    tool('artifact_batch_edit', 'Apply operations atomically as one revision. Include editRequestIds for submitted requests.', {
      ...artifactId, expectedRevision: revision, operations: z.array(operation).min(1).max(1000), ...idempotencyKey, editRequestIds,
    }, (input, authorize) => {
      assertArtifact(input.artifactId);
      return this.artifacts.editArtifact({
        userId, ...actor, ...input,
        assertAuthorized: () => { authorize(); assertArtifact(input.artifactId); },
        assertEditRequestsCurrent: () => this.editRequests.assertAgentMutation({
          ...context, ...input, targetKind: 'artifact', targetId: input.artifactId,
        }),
      });
    });
    tool('artifact_render', 'Get a PNG rendition of a page, slide, frame, table, or cropped region. PPTX can also render a background plate or an isolated transparent sprite for shapeId.', {
      ...artifactId, pageIndex: z.number().int().min(0).optional(), timeSeconds: z.number().min(0).optional(),
      variant: z.enum(['background', 'sprite']).optional(), shapeId: z.number().int().positive().optional(),
      region: z.object({
        x: z.number().finite().min(0),
        y: z.number().finite().min(0),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
        unit: z.enum(['norm', 'px', 'pt']).optional(),
      }).optional(),
    }, async ({ artifactId, ...options }) => {
      assertArtifact(artifactId);
      const { png, revision, sha256 } = await this.artifacts.renderPng(userId, artifactId, options);
      return new ToolOutput([
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
        { type: 'text', text: JSON.stringify({ artifactId, revision, sha256 }) },
      ]);
    });
    tool('artifact_verify', 'Verify the current artifact revision. PPTX accepts optional options.slideIndices, maxSlides, and maxShapesPerSlide for server-side layer visual consistency verification. Full Runtime SVG and HTML support options.selector and bounded element windows.', {
      ...artifactId,
      options: z.object({
        slideIndices: z.array(z.number().int().min(0).max(500)).max(50).optional(),
        maxSlides: z.number().int().min(1).max(50).optional(),
        maxShapesPerSlide: z.number().int().min(1).max(100).optional(),
        selector: z.string().min(1).max(512).optional(),
        elementOffset: z.number().int().min(0).max(100_000).optional(),
        maxElements: z.number().int().min(1).max(250).optional(),
      }).optional(),
    }, ({ artifactId, options }) => {
      assertArtifact(artifactId);
      return this.artifacts.verifyArtifact(userId, artifactId, options);
    });
    tool('artifact_export', 'Convert an artifact and save the result in this chat.', {
      ...artifactId, targetFormat: identifier, outputRelPath: z.string().max(1024).optional(), ...idempotencyKey,
    }, async (input, authorize) => {
      assertArtifact(input.artifactId);
      const { artifact } = await this.artifacts.exportArtifact({
        userId, ...actor, ...input,
        assertAuthorized: () => { authorize(); assertArtifact(input.artifactId); },
      });
      return { artifact };
    });
    tool('artifact_history', 'List artifact revisions.', artifactId, ({ artifactId }) => {
      assertArtifact(artifactId);
      return this.artifacts.listHistory(userId, artifactId);
    });
    tool('artifact_restore', 'Restore a historical revision as a new revision.', {
      ...artifactId, targetRevision: revision, ...idempotencyKey,
    }, (input, authorize) => {
      assertArtifact(input.artifactId);
      return this.artifacts.restoreRevision({
        userId, ...actor, ...input,
        assertAuthorized: () => { authorize(); assertArtifact(input.artifactId); },
      });
    });
    tool('artifact_restore_bundle', 'Restore a revision and its archived dependencies.', {
      ...artifactId, targetRevision: revision, sharedPolicy: z.enum(['overwrite_shared', 'skip_shared']).optional(),
    }, ({ artifactId, targetRevision, sharedPolicy }, authorize) => {
      assertArtifact(artifactId);
      return this.artifacts.restoreBundle({
        userId, ...actor, parentArtifactId: artifactId, targetRevision, sharedPolicy,
        assertAuthorized: () => { authorize(); assertArtifact(artifactId); },
      });
    });

    tool('edit_request_list', 'List submitted editing requests in this chat.', {}, () =>
      this.editRequests.listRequests(userId, chatId).filter(({ batchId, sentMessageId }) => batchId !== null && sentMessageId !== null));
    tool('edit_request_get', 'Read a submitted editing request and its target.', requestId, async ({ requestId }, authorize) => {
      const { regionImagePngBase64, ...payload } = await this.editRequests.getForAgent(userId, chatId, requestId);
      authorize();
      const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(payload) }];
      if (regionImagePngBase64) content.push({ type: 'image', mimeType: 'image/png', data: regionImagePngBase64 });
      return new ToolOutput(content);
    });
    tool('edit_request_mark_applied', 'Mark the saved revision of a linked edit applied, pending user verification. Use the current target revision.', {
      ...requestId, appliedRevision: revision,
    }, input => this.editRequests.markAppliedByAgent({ ...context, ...input }));

    tool('rich_capabilities', 'Get the rich content schema and limits.', {}, () => this.rich.getCapabilities());
    tool('rich_validate', 'Validate a rich document without writing it.', {
      document: z.unknown().refine((value) => value !== undefined),
    }, ({ document }) => this.rich.validateDocument(userId, chatId, document));
    tool('rich_create', 'Save a rich document and return its inline reference URL.', {
      document: z.unknown().refine((value) => value !== undefined), title: z.string().max(256).optional(),
    }, ({ document, title }) => {
      const turn = binding.tentativeTurn();
      const created = this.rich.createBlock({
        ...context, ...actor, document, title,
        tentativeMessageId: turn?.messageId,
        runId: turn?.runId,
      });
      binding.createdBlocks.add(created.block.id);
      return { blockId: created.block.id, referenceUrl: created.referenceUrl };
    });
    tool('rich_get', 'Get a rich block in this chat.', blockId, ({ blockId }) => {
      const block = this.rich.getBlock(userId, chatId, blockId);
      if (!block) throw new ArtifactError('NOT_FOUND', 'Rich block was not found in this chat.', 404);
      return block;
    });
    tool('rich_update', 'Replace a rich document or patch its nodes and state at the expected revision.', {
      ...blockId,
      expectedRevision: revision,
      document: z.unknown().optional(),
      patchNodes: z.array(z.object({ nodeId: identifier, replacement: object })).max(100).optional(),
      patchState: object.optional(),
      title: z.string().max(256).optional(), editRequestIds,
    }, ({ patchNodes, patchState, ...input }) => {
      this.editRequests.assertAgentMutation({ ...context, ...input, targetKind: 'rich_block', targetId: input.blockId });
      return this.rich.updateBlock({
      ...context, ...actor, ...input,
      patchNodes: patchNodes?.map(({ nodeId, replacement }) => ({ nodeId, replacement: replacement as unknown as RichNode })),
        patchState: patchState as Record<string, RichStateValue> | undefined,
      });
    });
    tool('rich_save_as_artifact', 'Save a rich block as an artifact in this chat.', {
      ...blockId, ...idempotencyKey, filename: z.string().min(1).max(255),
      format: z.enum(['svg', 'md', 'txt', 'csv', 'json', 'code']), content: z.string().optional(),
    }, (input, authorize) => this.rich.saveBlockAsArtifact({ ...context, ...actor, ...input, assertAuthorized: authorize }));
    return server;
  }
}
