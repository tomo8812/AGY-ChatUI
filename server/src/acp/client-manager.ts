import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable, Writable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { decryptSmallSecret } from '../auth/password.js';
import { captureWorkspaceSnapshot, syncWorkspaceChangesAsArtifacts } from '../files/artifacts.js';
import { resolveContainedExistingPath, resolveContainedWriteTarget } from '../files/workspace.js';
import type { SyncHub } from '../sync/hub.js';
import type {
  AcpConfigOption,
  AcpSelectOption,
  AttachmentRef,
  ChatRecord,
  PendingPermissionRecord,
  ToolCallItem,
} from '../types.js';
import { buildAgyCommandSpec, probeBwrapSandbox } from './env-isolation.js';

export function toHostWorkspacePath(
  workerWorkspaceDir: string,
  sandboxWorkspaceRoot: string,
  acpPath: string
): string {
  let cleaned = acpPath.trim();
  if (cleaned.startsWith('file://')) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      // Keep raw string so path containment check rejects malformed URIs
    }
  }
  if (!cleaned) return '';
  if (sandboxWorkspaceRoot !== workerWorkspaceDir) {
    if (cleaned === sandboxWorkspaceRoot) {
      return workerWorkspaceDir;
    }
    if (cleaned.startsWith(`${sandboxWorkspaceRoot}/`)) {
      return cleaned.slice(sandboxWorkspaceRoot.length + 1);
    }
  }
  return cleaned;
}

export interface ParsedSessionOptions {
  configOptions: AcpConfigOption[];
  modelOptionId: string | null;
  effortOptionId: string | null;
  currentModelId: string | null;
  currentEffortValue: string | null;
}

export function normalizeConfigOptions(rawList: SessionConfigOption[] | null | undefined): ParsedSessionOptions {
  const normalized: AcpConfigOption[] = [];
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      if (item.type !== 'select') continue;
      const flatOptions: AcpSelectOption[] = [];
      for (const entry of item.options) {
        if ('group' in entry && Array.isArray(entry.options)) {
          for (const sub of entry.options) {
            flatOptions.push({
              value: sub.value,
              name: `${entry.name}: ${sub.name}`,
              description: sub.description ?? null,
            });
          }
        } else if ('value' in entry) {
          flatOptions.push({
            value: entry.value,
            name: entry.name,
            description: entry.description ?? null,
          });
        }
      }
      normalized.push({
        id: item.id,
        name: item.name,
        category: item.category ?? null,
        currentValue: item.currentValue,
        options: flatOptions,
      });
    }
  }

  const modelOpt =
    normalized.find((c) => c.category === 'model') ??
    normalized.find((c) => c.id.toLowerCase().includes('model')) ??
    null;
  const effortOpt =
    normalized.find((c) => c.category === 'thought_level') ??
    normalized.find((c) => c.category === 'model_config' && /effort|thought|reason/i.test(c.id)) ??
    normalized.find((c) => /effort|thought|reasoning/i.test(c.id)) ??
    null;

  return {
    configOptions: normalized,
    modelOptionId: modelOpt?.id ?? null,
    effortOptionId: effortOpt?.id ?? null,
    currentModelId: modelOpt?.currentValue ?? null,
    currentEffortValue: effortOpt?.currentValue ?? null,
  };
}

interface ActiveTurnBridge {
  runId: string;
  userId: string;
  chatId: string;
  assistantMessageId: string;
  contentText: string;
  thoughtsText: string;
  toolCalls: ToolCallItem[];
  lastDbFlushAt: number;
  pendingResolvers: Map<string, (outcome: RequestPermissionResponse) => void>;
}

interface WorkerInstance {
  key: string; // `${userId}:${chatId}`
  userId: string;
  chatId: string;
  profileDir: string;
  workspaceDir: string;
  sandboxed: boolean;
  sandboxWorkspaceRoot: string;
  process: ChildProcessWithoutNullStreams;
  conn: ClientConnection;
  init: InitializeResponse;
  acpSessionId: string | null;
  parsedOptions: ParsedSessionOptions;
  supportsSystemPrompt: boolean;
  systemPromptInjectedFallback: boolean;
  needsTranscriptBridge: boolean;
  inFlight: boolean;
  lastUsedAt: number;
  activeTurn: ActiveTurnBridge | null;
  stderrTail: string[];
}

export class AcpClientManager {
  private readonly workers = new Map<string, WorkerInstance>();
  private readonly connecting = new Map<string, Promise<WorkerInstance>>();
  private readonly userOptionsCache = new Map<string, { options: ParsedSessionOptions; cachedAt: number }>();
  private readonly userOptionProbes = new Map<string, Promise<ParsedSessionOptions | null>>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: SyncHub
  ) {
    this.cleanupTimer = setInterval(() => this.evictIdleWorkers(), 30_000);
    this.cleanupTimer.unref();
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.allSettled([...this.workers.keys()].map((k) => this.stopWorkerByKey(k)));
  }

  invalidateUserOptionsCache(userId: string): void {
    for (const key of [...this.userOptionsCache.keys()]) {
      if (key.startsWith(`${userId}:`)) {
        this.userOptionsCache.delete(key);
      }
    }
  }

  async stopAllForUser(userId: string): Promise<void> {
    this.invalidateUserOptionsCache(userId);
    const keys = [...this.workers.values()].filter((w) => w.userId === userId).map((w) => w.key);
    await Promise.allSettled(keys.map((k) => this.stopWorkerByKey(k)));
  }

  async stopChatWorker(userId: string, chatId: string): Promise<void> {
    await this.stopWorkerByKey(`${userId}:${chatId}`);
  }

  async getOrProbeUserOptions(
    userId: string,
    desiredModelId: string | null = null
  ): Promise<ParsedSessionOptions | null> {
    const profile = this.db.getAgyProfile(userId);
    if (!profile || profile.authStatus !== 'authenticated') {
      return null;
    }

    // Reuse an already-running worker for this user if model matches (or no preference specified)
    for (const worker of this.workers.values()) {
      if (
        worker.userId === userId &&
        worker.parsedOptions.configOptions.length > 0 &&
        (!desiredModelId || worker.parsedOptions.currentModelId === desiredModelId)
      ) {
        this.cacheUserOptions(userId, worker.parsedOptions);
        return worker.parsedOptions;
      }
    }

    const cacheKey = `${userId}:${desiredModelId ?? ''}`;
    const cached = this.userOptionsCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < 15 * 60 * 1000) {
      return cached.options;
    }

    const inFlight = this.userOptionProbes.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = this.probeUserOptionsOnce(userId, profile.profileDir, desiredModelId).finally(() => {
      this.userOptionProbes.delete(cacheKey);
    });
    this.userOptionProbes.set(cacheKey, promise);
    return promise;
  }

  private cacheUserOptions(userId: string, options: ParsedSessionOptions): void {
    const now = Date.now();
    this.userOptionsCache.set(`${userId}:`, { options, cachedAt: now });
    if (options.currentModelId) {
      this.userOptionsCache.set(`${userId}:${options.currentModelId}`, { options, cachedAt: now });
    }
  }

  private async probeUserOptionsOnce(
    userId: string,
    profileDir: string,
    desiredModelId: string | null
  ): Promise<ParsedSessionOptions | null> {
    const tempProbeCwd = path.join(profileDir, '.tmp', 'options-probe');
    fs.mkdirSync(tempProbeCwd, { recursive: true, mode: 0o700 });
    const apiKey = this.loadApiKeyForUser(userId);
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: ['acp'],
      profileDir,
      workspaceDir: tempProbeCwd,
      geminiApiKey: apiKey,
      enableSandboxBwrap: false,
    });

    const child = spawn(spec.command, spec.args, {
      cwd: tempProbeCwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      const app = client({ name: 'antigravity-chat-options-probe' });
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      );
      const conn = app.connect(stream);
      const init = await Promise.race([
        conn.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'antigravity-chat-ui', title: 'Antigravity Chat UI', version: '1.0.0' },
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ACP options initialize timeout')), 15_000)),
      ]);

      const created = (await conn.agent.request(methods.agent.session.new, {
        cwd: tempProbeCwd,
        mcpServers: [],
      })) as NewSessionResponse;
      let parsed = normalizeConfigOptions(created.configOptions);

      if (desiredModelId && parsed.modelOptionId && parsed.currentModelId !== desiredModelId) {
        const updated = await conn.agent
          .request(methods.agent.session.setConfigOption, {
            sessionId: created.sessionId,
            configId: parsed.modelOptionId,
            value: desiredModelId,
          })
          .catch(() => null);
        if (updated) {
          parsed = normalizeConfigOptions(updated.configOptions);
        }
      }

      if (init.agentCapabilities?.sessionCapabilities?.close && created.sessionId) {
        await conn.agent.request(methods.agent.session.close, { sessionId: created.sessionId }).catch(() => {});
      }
      conn.close();

      if (parsed.configOptions.length > 0) {
        this.userOptionsCache.set(`${userId}:${desiredModelId ?? ''}`, { options: parsed, cachedAt: Date.now() });
        this.cacheUserOptions(userId, parsed);
      }
      return parsed;
    } catch {
      return null;
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  /**
   * Probes official ACP `initialize` + optionally `session/new` to verify that
   * an isolated profile is genuinely authenticated without inspecting token files.
   */
  async verifyProfileViaOfficialAcp(userId: string, tempProbeCwd: string): Promise<{
    authenticated: boolean;
    authMethods: Array<{ id: string; name: string }>;
    error?: string;
  }> {
    const profile = this.db.getAgyProfile(userId);
    if (!profile) {
      return { authenticated: false, authMethods: [], error: 'Profile not found' };
    }
    const apiKey = this.loadApiKeyForUser(userId);
    fs.mkdirSync(tempProbeCwd, { recursive: true, mode: 0o700 });
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: ['acp'],
      profileDir: profile.profileDir,
      workspaceDir: tempProbeCwd,
      geminiApiKey: apiKey,
      enableSandboxBwrap: false,
    });

    const child = spawn(spec.command, spec.args, {
      cwd: tempProbeCwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      const app = client({ name: 'antigravity-chat-probe' });
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      );
      const conn = app.connect(stream);
      const init = await Promise.race([
        conn.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'antigravity-chat-ui', title: 'Antigravity Chat UI', version: '1.0.0' },
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ACP initialize timeout')), 15_000)),
      ]);

      const authMethods = (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name }));
      // Probe session/new cleanly and close immediately
      const created = await conn.agent.request(methods.agent.session.new, {
        cwd: tempProbeCwd,
        mcpServers: [],
      });
      if (init.agentCapabilities?.sessionCapabilities?.close && created.sessionId) {
        await conn.agent.request(methods.agent.session.close, { sessionId: created.sessionId }).catch(() => {});
      }
      conn.close();
      return { authenticated: true, authMethods };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { authenticated: false, authMethods: [], error: msg };
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  async attemptOfficialLogoutViaAcp(userId: string, tempCwd: string): Promise<void> {
    const profile = this.db.getAgyProfile(userId);
    if (!profile) return;
    fs.mkdirSync(tempCwd, { recursive: true, mode: 0o700 });
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: ['acp'],
      profileDir: profile.profileDir,
      workspaceDir: tempCwd,
      enableSandboxBwrap: false,
    });
    const child = spawn(spec.command, spec.args, { cwd: tempCwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const app = client({ name: 'antigravity-chat-logout' });
      const conn = app.connect(
        ndJsonStream(
          Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
        )
      );
      const init = await conn.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'antigravity-chat-ui', version: '1.0.0' },
      });
      if (init.agentCapabilities?.auth?.logout) {
        await conn.agent.request(methods.agent.logout, {});
      }
      conn.close();
    } catch {
      // Fall through to CLI auth logout
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  async ensureSessionOptions(userId: string, chatId: string): Promise<ParsedSessionOptions> {
    const worker = await this.getOrStartWorker(userId, chatId);
    if (worker.parsedOptions.configOptions.length > 0) {
      this.cacheUserOptions(userId, worker.parsedOptions);
    }
    return worker.parsedOptions;
  }

  async setChatConfig(
    userId: string,
    chatId: string,
    patch: { modelId?: string | null; effortValue?: string | null }
  ): Promise<{ chat: ChatRecord; configOptions: ParsedSessionOptions }> {
    const chat = this.db.getChat(userId, chatId);
    if (!chat) throw new Error('Chat not found');

    const worker = await this.getOrStartWorker(userId, chatId);
    if (!worker.acpSessionId) throw new Error('ACP session not initialized');

    if (patch.modelId && worker.parsedOptions.modelOptionId) {
      const res = await worker.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId: worker.acpSessionId,
        configId: worker.parsedOptions.modelOptionId,
        value: patch.modelId,
      });
      worker.parsedOptions = normalizeConfigOptions(res.configOptions);
    }

    if (patch.effortValue && worker.parsedOptions.effortOptionId) {
      const res = await worker.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId: worker.acpSessionId,
        configId: worker.parsedOptions.effortOptionId,
        value: patch.effortValue,
      });
      worker.parsedOptions = normalizeConfigOptions(res.configOptions);
    }

    if (worker.parsedOptions.configOptions.length > 0) {
      this.cacheUserOptions(userId, worker.parsedOptions);
    }

    const updatedChat = this.db.updateChat(userId, chatId, {
      modelId: worker.parsedOptions.currentModelId ?? patch.modelId ?? chat.modelId,
      effortValue: worker.parsedOptions.currentEffortValue ?? patch.effortValue ?? chat.effortValue,
    })!;

    this.hub.emitDurable({
      userId,
      type: 'chat.updated',
      chatId,
      payload: { chat: updatedChat, sessionOptions: worker.parsedOptions },
    });

    return { chat: updatedChat, configOptions: worker.parsedOptions };
  }

  resolvePendingPermission(params: {
    userId: string;
    chatId: string;
    permissionId: string;
    selectedOptionId: string | null;
    cancel?: boolean;
    clientId?: string | null;
  }): PendingPermissionRecord | null {
    const status = params.cancel ? 'cancelled' : 'resolved';
    const updated = this.db.resolvePermissionAtomically({
      userId: params.userId,
      permissionId: params.permissionId,
      selectedOptionId: params.cancel ? null : params.selectedOptionId,
      status,
      clientId: params.clientId,
    });
    if (!updated) {
      return null;
    }

    const worker = this.workers.get(`${params.userId}:${params.chatId}`);
    const resolver = worker?.activeTurn?.pendingResolvers.get(params.permissionId);
    if (resolver) {
      worker!.activeTurn!.pendingResolvers.delete(params.permissionId);
      if (params.cancel || !params.selectedOptionId) {
        resolver({ outcome: { outcome: 'cancelled' } });
      } else {
        resolver({ outcome: { outcome: 'selected', optionId: params.selectedOptionId } });
      }
    }

    const run = this.db.getRun(params.userId, updated.runId);
    if (run && run.status === 'awaiting_permission') {
      this.db.updateRun(params.userId, run.id, { status: 'running' });
    }

    this.hub.emitDurable({
      userId: params.userId,
      type: 'permission.resolved',
      chatId: params.chatId,
      runId: updated.runId,
      payload: { permission: updated },
    });
    return updated;
  }

  async cancelTurn(userId: string, chatId: string, runId: string): Promise<void> {
    const worker = this.workers.get(`${userId}:${chatId}`);
    if (!worker || !worker.activeTurn || worker.activeTurn.runId !== runId) {
      return;
    }
    // Reject any awaiting permissions for this run first so prompt returns immediately
    for (const [permId, resolver] of worker.activeTurn.pendingResolvers.entries()) {
      this.db.resolvePermissionAtomically({
        userId,
        permissionId: permId,
        selectedOptionId: null,
        status: 'cancelled',
      });
      resolver({ outcome: { outcome: 'cancelled' } });
    }
    worker.activeTurn.pendingResolvers.clear();

    if (worker.acpSessionId) {
      await worker.conn.agent
        .notify(methods.agent.session.cancel, { sessionId: worker.acpSessionId })
        .catch(() => {});
    }
  }

  async executeTurn(params: {
    userId: string;
    chatId: string;
    runId: string;
    userText: string;
    attachments: AttachmentRef[];
    assistantMessageId: string;
    abortSignal: AbortSignal;
  }): Promise<{ stopReason: PromptResponse['stopReason'] }> {
    const chat = this.db.getChat(params.userId, params.chatId);
    if (!chat) throw new Error('Chat not found');

    const worker = await this.getOrStartWorker(params.userId, params.chatId);
    if (worker.userId !== params.userId || !worker.acpSessionId) {
      throw new Error('ACP session mismatch or unavailable');
    }

    // Apply chat-scoped model/effort before prompting if out of sync
    if (
      (chat.modelId && worker.parsedOptions.currentModelId !== chat.modelId && worker.parsedOptions.modelOptionId) ||
      (chat.effortValue && worker.parsedOptions.currentEffortValue !== chat.effortValue && worker.parsedOptions.effortOptionId)
    ) {
      await this.setChatConfig(params.userId, params.chatId, {
        modelId: chat.modelId ?? undefined,
        effortValue: chat.effortValue ?? undefined,
      }).catch(() => {});
    }

    const beforeSnap = captureWorkspaceSnapshot(chat.workspaceDir);
    const bridge: ActiveTurnBridge = {
      runId: params.runId,
      userId: params.userId,
      chatId: params.chatId,
      assistantMessageId: params.assistantMessageId,
      contentText: '',
      thoughtsText: '',
      toolCalls: [],
      lastDbFlushAt: Date.now(),
      pendingResolvers: new Map(),
    };
    worker.inFlight = true;
    worker.lastUsedAt = Date.now();
    worker.activeTurn = bridge;

    const onAbort = () => {
      this.cancelTurn(params.userId, params.chatId, params.runId).catch(() => {});
    };
    params.abortSignal.addEventListener('abort', onAbort, { once: true });

    try {
      const promptBlocks: ContentBlock[] = [];

      // If agent does not advertise systemPrompt capability, transparently pass explicit project instructions once
      let effectiveText = params.userText;
      if (worker.needsTranscriptBridge) {
        const prior = this.db
          .listMessages(params.userId, params.chatId)
          .filter((m) => m.runId !== params.runId && m.contentText.trim().length > 0)
          .slice(-10);
        if (prior.length > 0) {
          const historyLines = prior.map(
            (m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.contentText.slice(0, 1200)}`
          );
          effectiveText = `[これまでの会話履歴]\n${historyLines.join('\n\n')}\n\n[最新のメッセージ]\n${effectiveText}`;
        }
        worker.needsTranscriptBridge = false;
      }
      if (!worker.supportsSystemPrompt && !worker.systemPromptInjectedFallback && chat.projectId) {
        const proj = this.db.getProject(params.userId, chat.projectId);
        if (proj?.instructions.trim()) {
          effectiveText = `[プロジェクト指示]\n${proj.instructions.trim()}\n\n[ユーザーメッセージ]\n${effectiveText}`;
          worker.systemPromptInjectedFallback = true;
        }
      }

      if (effectiveText.trim()) {
        promptBlocks.push({ type: 'text', text: effectiveText });
      }

      for (const att of params.attachments) {
        try {
          const { absPath, relPath } = resolveContainedExistingPath(chat.workspaceDir, att.relPath);
          const acpFilePath = worker.sandboxed
            ? path.posix.join(worker.sandboxWorkspaceRoot, relPath)
            : absPath;
          if (att.previewKind === 'image' && worker.init.agentCapabilities?.promptCapabilities?.image) {
            const b64 = fs.readFileSync(absPath).toString('base64');
            promptBlocks.push({
              type: 'image',
              mimeType: att.mimeType,
              data: b64,
              uri: `file://${acpFilePath}`,
            });
          } else {
            promptBlocks.push({
              type: 'resource_link',
              name: att.filename,
              mimeType: att.mimeType,
              size: att.sizeBytes,
              uri: `file://${acpFilePath}`,
            });
          }
        } catch {
          // ignore inaccessible attachment
        }
      }

      if (promptBlocks.length === 0) {
        promptBlocks.push({ type: 'text', text: '' });
      }

      const response = await worker.conn.agent.request(methods.agent.session.prompt, {
        sessionId: worker.acpSessionId,
        prompt: promptBlocks,
      });

      // Collect tool-referenced locations as hint paths
      const hintPaths: string[] = [];
      for (const tc of bridge.toolCalls) {
        for (const loc of tc.locations ?? []) {
          const hostHint = toHostWorkspacePath(worker.workspaceDir, worker.sandboxWorkspaceRoot, loc.path);
          if (hostHint) hintPaths.push(hostHint);
        }
      }

      const newArtifacts = syncWorkspaceChangesAsArtifacts({
        db: this.db,
        userId: params.userId,
        chatId: params.chatId,
        workspaceDir: chat.workspaceDir,
        messageId: params.assistantMessageId,
        runId: params.runId,
        before: beforeSnap,
        hintPaths,
      });

      const finalStatus = response.stopReason === 'cancelled' ? 'cancelled' : 'completed';
      const updatedMsg = this.db.updateMessage(params.userId, params.assistantMessageId, {
        contentText: bridge.contentText,
        thoughtsText: bridge.thoughtsText,
        toolCalls: bridge.toolCalls,
        artifactIds: newArtifacts.map((a) => a.id),
        status: finalStatus,
      })!;

      for (const art of newArtifacts) {
        this.hub.emitDurable({
          userId: params.userId,
          type: 'artifact.created',
          chatId: params.chatId,
          runId: params.runId,
          payload: { artifact: art },
        });
      }

      this.hub.emitDurable({
        userId: params.userId,
        type: 'message.updated',
        chatId: params.chatId,
        runId: params.runId,
        payload: { message: updatedMsg },
      });

      return { stopReason: response.stopReason };
    } catch (err) {
      // Flush partial work even on error so nothing streamed so far is lost
      this.db.updateMessage(params.userId, params.assistantMessageId, {
        contentText: bridge.contentText,
        thoughtsText: bridge.thoughtsText,
        toolCalls: bridge.toolCalls,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      params.abortSignal.removeEventListener('abort', onAbort);
      worker.activeTurn = null;
      worker.inFlight = false;
      worker.lastUsedAt = Date.now();
    }
  }

  private async getOrStartWorker(userId: string, chatId: string): Promise<WorkerInstance> {
    const key = `${userId}:${chatId}`;
    const existing = this.workers.get(key);
    if (existing && !existing.process.killed && existing.process.exitCode === null) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const pendingConnect = this.connecting.get(key);
    if (pendingConnect) return pendingConnect;

    const promise = this.startWorker(userId, chatId).finally(() => {
      this.connecting.delete(key);
    });
    this.connecting.set(key, promise);
    return promise;
  }

  private async startWorker(userId: string, chatId: string): Promise<WorkerInstance> {
    const profile = this.db.getAgyProfile(userId);
    if (!profile || profile.authStatus !== 'authenticated') {
      throw new Error('Antigravity認証が完了していません。設定から公式認証を完了してください。');
    }

    const chat = this.db.getChat(userId, chatId);
    if (!chat || chat.userId !== userId) {
      throw new Error('Chat not found or unauthorized');
    }

    // Evict oldest idle worker if we are at worker pool ceiling (crucial on 1GB E2 Micro)
    this.evictOneIdleIfFull();

    fs.mkdirSync(chat.workspaceDir, { recursive: true, mode: 0o700 });
    const sandboxStatus = probeBwrapSandbox(this.config);
    if (this.config.agyMode === 'real' && this.config.sandboxMode === 'strict' && !sandboxStatus.active) {
      throw new Error(
        `${sandboxStatus.reason ?? 'サンドボックス環境を初期化できません。'}${
          sandboxStatus.remediation ? ` (${sandboxStatus.remediation})` : ''
        }`
      );
    }

    const apiKey = this.loadApiKeyForUser(userId);
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: ['acp'],
      profileDir: profile.profileDir,
      workspaceDir: chat.workspaceDir,
      geminiApiKey: apiKey,
      enableSandboxBwrap: sandboxStatus.active,
    });

    const child = spawn(spec.command, spec.args, {
      cwd: chat.workspaceDir,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const workerKey = `${userId}:${chatId}`;
    const stderrTail: string[] = [];
    const stderrRl = readline.createInterface({ input: child.stderr });
    stderrRl.on('line', (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
    });

    let workerRef: WorkerInstance | null = null;

    const acpClientApp = client({ name: 'antigravity-chat-ui' })
      .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
        if (!workerRef) throw new RequestError(-32603, 'Worker uninitialized');
        try {
          const hostCandidate = toHostWorkspacePath(
            workerRef.workspaceDir,
            workerRef.sandboxWorkspaceRoot,
            params.path
          );
          const { absPath } = resolveContainedExistingPath(workerRef.workspaceDir, hostCandidate);
          const raw = fs.readFileSync(absPath, 'utf8');
          const lines = raw.split(/\r?\n/);
          const start = params.line && params.line > 0 ? params.line - 1 : 0;
          const end = params.limit && params.limit > 0 ? start + params.limit : lines.length;
          return { content: lines.slice(start, end).join('\n') };
        } catch (err) {
          throw new RequestError(-32602, err instanceof Error ? err.message : 'File read denied');
        }
      })
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
        if (!workerRef) throw new RequestError(-32603, 'Worker uninitialized');
        try {
          const hostCandidate = toHostWorkspacePath(
            workerRef.workspaceDir,
            workerRef.sandboxWorkspaceRoot,
            params.path
          );
          const { absPath } = resolveContainedWriteTarget(workerRef.workspaceDir, hostCandidate);
          fs.mkdirSync(path.dirname(absPath), { recursive: true, mode: 0o700 });
          fs.writeFileSync(absPath, params.content, 'utf8');
          return {};
        } catch (err) {
          throw new RequestError(-32602, err instanceof Error ? err.message : 'File write denied');
        }
      })
      .onRequest(methods.client.session.requestPermission, async ({ params, signal }) => {
        if (!workerRef || !workerRef.activeTurn) {
          return { outcome: { outcome: 'cancelled' as const } };
        }
        const turn = workerRef.activeTurn;
        const prefs = this.db.getPreferences(turn.userId);

        // Optional user preference: auto-approve strictly read-only workspace reads
        if (prefs.autoApproveSafeReads && params.toolCall.kind === 'read') {
          const allContained = (params.toolCall.locations ?? []).every((loc) => {
            try {
              const hostCandidate = toHostWorkspacePath(
                workerRef!.workspaceDir,
                workerRef!.sandboxWorkspaceRoot,
                loc.path
              );
              resolveContainedExistingPath(workerRef!.workspaceDir, hostCandidate);
              return true;
            } catch {
              return false;
            }
          });
          const allowOpt = params.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
          if (allContained && allowOpt) {
            return { outcome: { outcome: 'selected' as const, optionId: allowOpt.optionId } };
          }
        }

        const permId = crypto.randomUUID();
        const toolCall: ToolCallItem = {
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? 'ツール実行の許可',
          kind: params.toolCall.kind ?? undefined,
          status: params.toolCall.status ?? 'pending',
          rawInput: params.toolCall.rawInput,
          locations: (params.toolCall.locations ?? []).map((l) => ({ path: l.path, line: l.line })),
        };
        const options = params.options.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        }));

        const record = this.db.createPendingPermission({
          id: permId,
          runId: turn.runId,
          chatId: turn.chatId,
          userId: turn.userId,
          toolCall,
          options,
        });

        this.db.updateRun(turn.userId, turn.runId, { status: 'awaiting_permission' });
        this.hub.emitDurable({
          userId: turn.userId,
          type: 'permission.requested',
          chatId: turn.chatId,
          runId: turn.runId,
          payload: { permission: record },
        });

        return new Promise<RequestPermissionResponse>((resolve) => {
          turn.pendingResolvers.set(permId, resolve);
          const onCancelSignal = () => {
            if (turn.pendingResolvers.delete(permId)) {
              this.db.resolvePermissionAtomically({
                userId: turn.userId,
                permissionId: permId,
                selectedOptionId: null,
                status: 'cancelled',
              });
              resolve({ outcome: { outcome: 'cancelled' } });
            }
          };
          signal.addEventListener('abort', onCancelSignal, { once: true });
        });
      })
      .onNotification(methods.client.session.update, async ({ params }) => {
        if (!workerRef) return;
        this.handleSessionNotification(workerRef, params);
      });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    );
    const conn = acpClientApp.connect(stream);

    child.once('exit', () => {
      if (this.workers.get(workerKey) === workerRef) {
        this.workers.delete(workerKey);
      }
    });

    const init = await conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
        session: { configOptions: { boolean: {} } },
        auth: { terminal: true },
      },
      clientInfo: {
        name: 'antigravity-chat-ui',
        title: 'Antigravity Chat UI',
        version: '1.0.0',
      },
    });

    const supportsSystemPrompt = Boolean(init.agentCapabilities?.sessionCapabilities?.systemPrompt);
    let systemPromptPayload:
      | { mode: 'append'; content: Array<{ type: 'text'; text: string }> }
      | undefined;

    if (supportsSystemPrompt && chat.projectId) {
      const proj = this.db.getProject(userId, chat.projectId);
      if (proj?.instructions.trim()) {
        systemPromptPayload = {
          mode: 'append',
          content: [{ type: 'text', text: proj.instructions.trim() }],
        };
      }
    }

    let acpSessionId: string | null = null;
    let restoredExistingSession = false;
    let parsedOptions: ParsedSessionOptions = {
      configOptions: [],
      modelOptionId: null,
      effortOptionId: null,
      currentModelId: null,
      currentEffortValue: null,
    };

    // Try load / resume existing ACP session seamlessly
    if (chat.acpSessionId) {
      try {
        if (init.agentCapabilities?.loadSession) {
          const loadRes = (await conn.agent.request(methods.agent.session.load, {
            sessionId: chat.acpSessionId,
            cwd: spec.sandboxWorkspaceRoot,
            mcpServers: [],
            ...(systemPromptPayload ? { systemPrompt: systemPromptPayload } : {}),
          })) as LoadSessionResponse | undefined;
          acpSessionId = chat.acpSessionId;
          restoredExistingSession = true;
          parsedOptions = normalizeConfigOptions(loadRes?.configOptions);
        } else if (init.agentCapabilities?.sessionCapabilities?.resume) {
          const resumeRes = (await conn.agent.request(methods.agent.session.resume, {
            sessionId: chat.acpSessionId,
            cwd: spec.sandboxWorkspaceRoot,
            mcpServers: [],
            ...(systemPromptPayload ? { systemPrompt: systemPromptPayload } : {}),
          })) as ResumeSessionResponse | undefined;
          acpSessionId = chat.acpSessionId;
          restoredExistingSession = true;
          parsedOptions = normalizeConfigOptions(resumeRes?.configOptions);
        }
      } catch {
        acpSessionId = null;
      }
    }

    if (!acpSessionId) {
      try {
        const newRes = (await conn.agent.request(methods.agent.session.new, {
          cwd: spec.sandboxWorkspaceRoot,
          mcpServers: [],
          ...(systemPromptPayload ? { systemPrompt: systemPromptPayload } : {}),
        })) as NewSessionResponse;
        acpSessionId = newRes.sessionId;
        parsedOptions = normalizeConfigOptions(newRes.configOptions);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('-32000') || /authentication required/i.test(msg)) {
          this.db.updateAgyProfile(userId, { authStatus: 'unauthenticated', lastError: msg });
          this.hub.emitDurable({
            userId,
            type: 'agy.auth_changed',
            payload: { profile: this.db.getAgyProfile(userId) },
          });
        }
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        throw err;
      }
    }

    if (chat.modelId && parsedOptions.modelOptionId && parsedOptions.currentModelId !== chat.modelId) {
      const res = await conn.agent
        .request(methods.agent.session.setConfigOption, {
          sessionId: acpSessionId,
          configId: parsedOptions.modelOptionId,
          value: chat.modelId,
        })
        .catch(() => null);
      if (res) {
        parsedOptions = normalizeConfigOptions(res.configOptions);
      }
    }

    if (
      chat.effortValue &&
      parsedOptions.effortOptionId &&
      parsedOptions.currentEffortValue !== chat.effortValue
    ) {
      const res = await conn.agent
        .request(methods.agent.session.setConfigOption, {
          sessionId: acpSessionId,
          configId: parsedOptions.effortOptionId,
          value: chat.effortValue,
        })
        .catch(() => null);
      if (res) {
        parsedOptions = normalizeConfigOptions(res.configOptions);
      }
    }

    this.db.updateChat(userId, chatId, {
      acpSessionId,
      modelId: parsedOptions.currentModelId ?? chat.modelId,
      effortValue: parsedOptions.currentEffortValue ?? chat.effortValue,
    });

    workerRef = {
      key: workerKey,
      userId,
      chatId,
      profileDir: profile.profileDir,
      workspaceDir: chat.workspaceDir,
      sandboxed: spec.sandboxed,
      sandboxWorkspaceRoot: spec.sandboxWorkspaceRoot,
      process: child,
      conn,
      init,
      acpSessionId,
      parsedOptions,
      supportsSystemPrompt,
      systemPromptInjectedFallback: Boolean(systemPromptPayload),
      needsTranscriptBridge: !restoredExistingSession,
      inFlight: false,
      lastUsedAt: Date.now(),
      activeTurn: null,
      stderrTail,
    };

    this.workers.set(workerKey, workerRef);
    return workerRef;
  }

  private handleSessionNotification(worker: WorkerInstance, params: SessionNotification): void {
    const update: SessionUpdate = params.update;
    const turn = worker.activeTurn;

    if (update.sessionUpdate === 'config_option_update') {
      worker.parsedOptions = normalizeConfigOptions(update.configOptions);
      this.hub.emitDurable({
        userId: worker.userId,
        type: 'chat.config_updated',
        chatId: worker.chatId,
        payload: { sessionOptions: worker.parsedOptions },
      });
      return;
    }

    if (update.sessionUpdate === 'usage_update') {
      this.hub.emitEphemeral({
        userId: worker.userId,
        type: 'chat.context_usage',
        chatId: worker.chatId,
        runId: turn?.runId ?? null,
        payload: { used: update.used, size: update.size, cost: update.cost ?? null },
      });
      return;
    }

    if (!turn) return;

    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content.type === 'text') {
        const offset = turn.contentText.length;
        const chunk = update.content.text;
        turn.contentText += chunk;
        this.hub.emitEphemeral({
          userId: worker.userId,
          type: 'run.delta',
          chatId: worker.chatId,
          runId: turn.runId,
          payload: {
            messageId: turn.assistantMessageId,
            field: 'content',
            offset,
            chunk,
          },
        });
        this.maybeFlushTurnProgress(turn);
      }
      return;
    }

    if (update.sessionUpdate === 'agent_thought_chunk') {
      if (update.content.type === 'text') {
        const offset = turn.thoughtsText.length;
        const chunk = update.content.text;
        turn.thoughtsText += chunk;
        this.hub.emitEphemeral({
          userId: worker.userId,
          type: 'run.delta',
          chatId: worker.chatId,
          runId: turn.runId,
          payload: {
            messageId: turn.assistantMessageId,
            field: 'thoughts',
            offset,
            chunk,
          },
        });
        this.maybeFlushTurnProgress(turn);
      }
      return;
    }

    if (update.sessionUpdate === 'tool_call') {
      const nextTool: ToolCallItem = {
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.kind,
        status: update.status ?? 'pending',
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        locations: update.locations?.map((l) => ({ path: l.path, line: l.line })),
      };
      const idx = turn.toolCalls.findIndex((t) => t.toolCallId === nextTool.toolCallId);
      if (idx >= 0) turn.toolCalls[idx] = nextTool;
      else turn.toolCalls.push(nextTool);

      this.db.updateMessage(turn.userId, turn.assistantMessageId, { toolCalls: turn.toolCalls });
      this.hub.emitEphemeral({
        userId: worker.userId,
        type: 'run.tool_update',
        chatId: worker.chatId,
        runId: turn.runId,
        payload: { messageId: turn.assistantMessageId, toolCalls: turn.toolCalls },
      });
      return;
    }

    if (update.sessionUpdate === 'tool_call_update') {
      const idx = turn.toolCalls.findIndex((t) => t.toolCallId === update.toolCallId);
      const existing: ToolCallItem =
        idx >= 0
          ? turn.toolCalls[idx]
          : { toolCallId: update.toolCallId, title: update.title ?? 'ツール実行', status: 'in_progress' };

      const merged: ToolCallItem = {
        ...existing,
        ...(update.title !== undefined && update.title !== null ? { title: update.title } : {}),
        ...(update.kind !== undefined && update.kind !== null ? { kind: update.kind } : {}),
        ...(update.status !== undefined && update.status !== null ? { status: update.status } : {}),
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        ...(update.locations !== undefined && update.locations !== null
          ? { locations: update.locations.map((l) => ({ path: l.path, line: l.line })) }
          : {}),
      };
      if (idx >= 0) turn.toolCalls[idx] = merged;
      else turn.toolCalls.push(merged);

      this.db.updateMessage(turn.userId, turn.assistantMessageId, { toolCalls: turn.toolCalls });
      this.hub.emitEphemeral({
        userId: worker.userId,
        type: 'run.tool_update',
        chatId: worker.chatId,
        runId: turn.runId,
        payload: { messageId: turn.assistantMessageId, toolCalls: turn.toolCalls },
      });
    }
  }

  private maybeFlushTurnProgress(turn: ActiveTurnBridge): void {
    const now = Date.now();
    if (now - turn.lastDbFlushAt >= 150) {
      turn.lastDbFlushAt = now;
      this.db.updateMessage(turn.userId, turn.assistantMessageId, {
        contentText: turn.contentText,
        thoughtsText: turn.thoughtsText,
      });
    }
  }

  private loadApiKeyForUser(userId: string): string | null {
    const enc = this.db.getAgyEncryptedApiKey(userId);
    if (!enc) return null;
    try {
      return decryptSmallSecret(enc, this.config.sessionSecret);
    } catch {
      return null;
    }
  }

  private async stopWorkerByKey(key: string): Promise<void> {
    const w = this.workers.get(key);
    if (!w) return;
    this.workers.delete(key);
    try {
      w.conn.close();
    } catch {
      // ignore
    }
    if (!w.process.killed && w.process.exitCode === null) {
      w.process.kill('SIGTERM');
    }
  }

  private evictOneIdleIfFull(): void {
    if (this.workers.size < this.config.maxConcurrentAcp) return;
    let oldestIdle: WorkerInstance | null = null;
    for (const w of this.workers.values()) {
      if (!w.inFlight && (!oldestIdle || w.lastUsedAt < oldestIdle.lastUsedAt)) {
        oldestIdle = w;
      }
    }
    if (oldestIdle) {
      void this.stopWorkerByKey(oldestIdle.key);
    }
  }

  private evictIdleWorkers(): void {
    const cutoff = Date.now() - this.config.idleWorkerMs;
    for (const w of this.workers.values()) {
      if (!w.inFlight && w.lastUsedAt < cutoff) {
        void this.stopWorkerByKey(w.key);
      }
    }
  }
}
