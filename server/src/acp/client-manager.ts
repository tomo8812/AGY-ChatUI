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
  type AvailableCommand,
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
import {
  type BrainSnapshotEntry,
  captureBrainSnapshot,
  extractCandidatePathsFromText,
  extractCandidatePathsFromToolCalls,
  importAuthorizedBrainFileToWorkspace,
  resolveAuthorizedBrainFile,
  rewriteInternalPathsToWorkspace,
  scrubToolCallsInternalPaths,
  type SyncedBrainFile,
  syncNewBrainFilesToWorkspace,
} from '../files/link-resolver.js';
import {
  detectMimeAndPreviewKind,
  resolveContainedExistingPath,
  resolveContainedWriteTarget,
  sanitizeFileName,
  sha256File,
} from '../files/workspace.js';
import type { SyncHub } from '../sync/hub.js';
import type {
  AcpConfigOption,
  AcpSelectOption,
  AttachmentRef,
  AvailableCommandItem,
  ChatRecord,
  PendingPermissionRecord,
  ToolCallItem,
} from '../types.js';
import type { SkillService } from '../skills/skill-service.js';
import {
  buildAgyCommandSpec,
  probeBwrapSandbox,
  SANDBOX_HOME_MOUNT,
  SANDBOX_WORKSPACE_MOUNT,
} from './env-isolation.js';

export function classifySubagentToolCall(params: {
  name?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  rawContent?: unknown;
}): { isSubagent: boolean; isAsyncSubagentLaunch?: boolean; subagentLabel?: string } {
  const nameStr = (params.name ?? '').trim();
  const titleStr = (params.title ?? '').trim();
  const combined = `${nameStr} ${titleStr}`;

  const rawObj =
    params.rawInput && typeof params.rawInput === 'object' && !Array.isArray(params.rawInput)
      ? (params.rawInput as Record<string, unknown>)
      : null;

  const isImageGen =
    /generate_image|image_gen|画像生成/i.test(combined) ||
    Boolean(
      rawObj &&
        ('ImageName' in rawObj || 'image_name' in rawObj) &&
        ('Prompt' in rawObj || 'prompt' in rawObj)
    );

  if (isImageGen) {
    const imgName =
      (rawObj && typeof rawObj.ImageName === 'string' && rawObj.ImageName.trim()) ||
      (rawObj && typeof rawObj.image_name === 'string' && rawObj.image_name.trim()) ||
      titleStr ||
      'generate_image';
    return {
      isSubagent: true,
      isAsyncSubagentLaunch: false,
      subagentLabel: `画像生成サブエージェント (${imgName})`,
    };
  }

  const hasSubagentsArray = Boolean(
    rawObj && Array.isArray(rawObj.Subagents) && rawObj.Subagents.length > 0
  );
  const hasSessionRefContent =
    Array.isArray(params.rawContent) &&
    params.rawContent.some(
      (c) =>
        c &&
        typeof c === 'object' &&
        ((c as { type?: string }).type === 'session' || (c as { type?: string }).type === 'subagent')
    );
  const isAsyncLaunch =
    hasSubagentsArray ||
    hasSessionRefContent ||
    /\binvoke_subagent\b|\bspawn_agent\b|\bdelegate_agent\b/i.test(combined);

  const isSubagentTool =
    isAsyncLaunch ||
    /define_subagent|manage_subagents|subagent|teamwork|サブエージェント/i.test(combined);

  if (isSubagentTool) {
    if (hasSubagentsArray && rawObj && Array.isArray(rawObj.Subagents)) {
      const roles = rawObj.Subagents.map((s) => {
        if (s && typeof s === 'object') {
          const item = s as Record<string, unknown>;
          return (
            (typeof item.Role === 'string' && item.Role.trim()) ||
            (typeof item.TypeName === 'string' && item.TypeName.trim()) ||
            ''
          );
        }
        return '';
      }).filter(Boolean);
      if (roles.length > 0) {
        return {
          isSubagent: true,
          isAsyncSubagentLaunch: isAsyncLaunch,
          subagentLabel: `サブエージェント (${roles.join(', ')})`,
        };
      }
    }
    return {
      isSubagent: true,
      isAsyncSubagentLaunch: isAsyncLaunch,
      subagentLabel: `サブエージェント (${titleStr || nameStr || '実行'})`,
    };
  }

  return { isSubagent: false };
}

function hasBackgroundTaskOutput(tc: ToolCallItem): boolean {
  const rawIn =
    tc.rawInput && typeof tc.rawInput === 'object' && !Array.isArray(tc.rawInput)
      ? (tc.rawInput as Record<string, unknown>)
      : null;
  if (rawIn?.IsDaemon === true || rawIn?.isDaemon === true) {
    return false;
  }
  const combinedOut = `${tc.contentText ?? ''} ${
    tc.rawOutput !== undefined ? JSON.stringify(tc.rawOutput) : ''
  }`;
  return /running as a background task with task id:/i.test(combinedOut);
}

function captureWorkspaceSkillsSignature(workspaceDir: string): string {
  const roots = [
    path.join(workspaceDir, '.agents', 'skills'),
    path.join(workspaceDir, '.agent', 'skills'),
  ];
  const parts: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillMd = path.join(root, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          const st = fs.statSync(skillMd);
          parts.push(`${root}:${entry.name}:${st.size}:${Math.floor(st.mtimeMs)}`);
        }
      }
    } catch {
      // ignore
    }
  }
  return parts.join('|');
}

export function mapAcpAvailableCommands(raw: unknown): AvailableCommandItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AvailableCommandItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as AvailableCommand;
    const name = typeof item.name === 'string' ? item.name.trim().replace(/^\//, '') : '';
    if (!name) continue;
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const inputHint =
      item.input && typeof item.input === 'object' && typeof item.input.hint === 'string'
        ? item.input.hint
        : null;
    out.push({
      name,
      description: description || name,
      ...(inputHint ? { inputHint } : {}),
      source: 'acp',
    });
  }
  return out;
}

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
  availableCommands?: AvailableCommandItem[];
}

export function normalizeConfigOptions(
  rawList: SessionConfigOption[] | null | undefined,
  availableCommands?: AvailableCommandItem[]
): ParsedSessionOptions {
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
    ...(availableCommands ? { availableCommands } : {}),
  };
}

interface TrackedSubagentState {
  sessionId: string;
  toolCallId: string;
  title: string;
  description?: string;
  state: 'running' | 'idle' | 'requires_action' | 'unknown';
  stopReason?: string | null;
  lastActivityAt: number;
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
  beforeBrainSnap: Map<string, BrainSnapshotEntry>;
  emittedArtifactIds: Set<string>;
  syncedBrainFiles: Map<string, SyncedBrainFile>;
  textAfterLastToolCall: string;
  lastActivityAt: number;
  subagents: Map<string, TrackedSubagentState>;
  asyncSubagentToolIds: Set<string>;
  initialPromptDone: boolean;
  parentState: 'running' | 'idle' | 'requires_action' | 'unknown';
  backgroundWorkCount: number;
  parentWakeupStarted: boolean;
  parentWakeupIdle: boolean;
  receivedWakeupText: boolean;
  lastParentActivityAt: number;
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
  backgroundBridge: ActiveTurnBridge | null;
  lastBackgroundActivityAt: number;
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
    private readonly hub: SyncHub,
    private readonly skillService?: SkillService
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

  async stopIdleWorkersForUser(userId: string): Promise<void> {
    this.invalidateUserOptionsCache(userId);
    const keys = [...this.workers.values()]
      .filter((w) => w.userId === userId && !w.inFlight)
      .map((w) => w.key);
    await Promise.allSettled(keys.map((k) => this.stopWorkerByKey(k)));
  }

  async stopChatWorker(userId: string, chatId: string): Promise<void> {
    await this.stopWorkerByKey(`${userId}:${chatId}`);
  }

  async stopChatWorkerIfIdle(userId: string, chatId: string): Promise<boolean> {
    const key = `${userId}:${chatId}`;
    const w = this.workers.get(key);
    if (!w) return true;
    if (w.inFlight) return false;
    await this.stopWorkerByKey(key);
    return true;
  }

  private mergeAvailableCommands(
    userId: string,
    acpCommands: AvailableCommandItem[] | undefined,
    ctx: { projectId?: string | null; chatId?: string | null }
  ): AvailableCommandItem[] {
    const skillCommands = this.skillService
      ? this.skillService.listAvailableSkillCommands(userId, ctx)
      : [];
    const byName = new Map<string, AvailableCommandItem>();

    for (const cmd of acpCommands ?? []) {
      byName.set(cmd.name.toLowerCase(), cmd);
    }
    for (const sk of skillCommands) {
      byName.set(sk.name.toLowerCase(), sk);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private enrichParsedOptions(
    userId: string,
    parsed: ParsedSessionOptions,
    ctx: { projectId?: string | null; chatId?: string | null },
    acpCommandsOverride?: AvailableCommandItem[]
  ): ParsedSessionOptions {
    const baseCommands =
      acpCommandsOverride ??
      (parsed.availableCommands ?? []).filter((c) => c.source !== 'skill');
    const merged = this.mergeAvailableCommands(userId, baseCommands, ctx);
    return {
      ...parsed,
      availableCommands: merged,
    };
  }

  async getOrProbeUserOptions(
    userId: string,
    desiredModelId: string | null = null,
    ctx: { projectId?: string | null; chatId?: string | null } = {}
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
        return this.enrichParsedOptions(userId, worker.parsedOptions, ctx);
      }
    }

    const cacheKey = `${userId}:${desiredModelId ?? ''}`;
    const cached = this.userOptionsCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < 15 * 60 * 1000) {
      return this.enrichParsedOptions(userId, cached.options, ctx);
    }

    const inFlight = this.userOptionProbes.get(cacheKey);
    if (inFlight) {
      const res = await inFlight;
      return res ? this.enrichParsedOptions(userId, res, ctx) : null;
    }

    const promise = this.probeUserOptionsOnce(userId, profile.profileDir, desiredModelId).finally(() => {
      this.userOptionProbes.delete(cacheKey);
    });
    this.userOptionProbes.set(cacheKey, promise);
    const res = await promise;
    return res ? this.enrichParsedOptions(userId, res, ctx) : null;
  }

  private cacheUserOptions(userId: string, options: ParsedSessionOptions): void {
    const now = Date.now();
    const acpOnly = (options.availableCommands ?? []).filter((c) => c.source !== 'skill');
    const baseOptions: ParsedSessionOptions = { ...options, availableCommands: acpOnly };
    this.userOptionsCache.set(`${userId}:`, { options: baseOptions, cachedAt: now });
    if (options.currentModelId) {
      this.userOptionsCache.set(`${userId}:${options.currentModelId}`, { options: baseOptions, cachedAt: now });
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
      let capturedCommands: AvailableCommandItem[] = [];
      const app = client({ name: 'antigravity-chat-options-probe' }).onNotification(
        methods.client.session.update,
        async ({ params }) => {
          if (params.update.sessionUpdate === 'available_commands_update') {
            capturedCommands = mapAcpAvailableCommands(params.update.availableCommands);
          }
        }
      );
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      );
      const conn = app.connect(stream);
      const init = await Promise.race([
        conn.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'antigravity-chat-ui', title: 'Antigravity Chat UI', version: this.config.appVersion },
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ACP options initialize timeout')), 15_000)),
      ]);

      const created = (await conn.agent.request(methods.agent.session.new, {
        cwd: tempProbeCwd,
        mcpServers: [],
      })) as NewSessionResponse;
      let parsed = normalizeConfigOptions(created.configOptions, capturedCommands);

      if (desiredModelId && parsed.modelOptionId && parsed.currentModelId !== desiredModelId) {
        const updated = await conn.agent
          .request(methods.agent.session.setConfigOption, {
            sessionId: created.sessionId,
            configId: parsed.modelOptionId,
            value: desiredModelId,
          })
          .catch(() => null);
        if (updated) {
          parsed = normalizeConfigOptions(updated.configOptions, capturedCommands);
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
      return this.enrichParsedOptions(userId, parsed, {}, capturedCommands);
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
          clientInfo: { name: 'antigravity-chat-ui', title: 'Antigravity Chat UI', version: this.config.appVersion },
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
        clientInfo: { name: 'antigravity-chat-ui', version: this.config.appVersion },
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
    const chat = this.db.getChat(userId, chatId);
    const worker = await this.getOrStartWorker(userId, chatId);
    if (worker.parsedOptions.configOptions.length > 0) {
      this.cacheUserOptions(userId, worker.parsedOptions);
    }
    const enriched = this.enrichParsedOptions(userId, worker.parsedOptions, {
      projectId: chat?.projectId ?? null,
      chatId,
    });
    worker.parsedOptions = enriched;
    return enriched;
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
      const prevAcpCommands = (worker.parsedOptions.availableCommands ?? []).filter(
        (c) => c.source !== 'skill'
      );
      const res = await worker.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId: worker.acpSessionId,
        configId: worker.parsedOptions.modelOptionId,
        value: patch.modelId,
      });
      worker.parsedOptions = this.enrichParsedOptions(
        userId,
        normalizeConfigOptions(res.configOptions),
        { projectId: chat.projectId, chatId },
        prevAcpCommands
      );
    }

    if (patch.effortValue && worker.parsedOptions.effortOptionId) {
      const prevAcpCommands = (worker.parsedOptions.availableCommands ?? []).filter(
        (c) => c.source !== 'skill'
      );
      const res = await worker.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId: worker.acpSessionId,
        configId: worker.parsedOptions.effortOptionId,
        value: patch.effortValue,
      });
      worker.parsedOptions = this.enrichParsedOptions(
        userId,
        normalizeConfigOptions(res.configOptions),
        { projectId: chat.projectId, chatId },
        prevAcpCommands
      );
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
    const targetBridge = worker?.activeTurn ?? worker?.backgroundBridge ?? null;
    const resolver = targetBridge?.pendingResolvers.get(params.permissionId);
    if (resolver && targetBridge) {
      targetBridge.pendingResolvers.delete(params.permissionId);
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

    if (chat.projectId && this.skillService) {
      this.skillService.syncProjectSkillsToChat(params.userId, chat.projectId, chat.workspaceDir);
    }

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

    const beforeSkillsSig = captureWorkspaceSkillsSignature(chat.workspaceDir);
    const beforeSnap = captureWorkspaceSnapshot(chat.workspaceDir);
    const beforeBrainSnap = captureBrainSnapshot(worker.profileDir, chat.workspaceDir);
    const nowInit = Date.now();
    const bridge: ActiveTurnBridge = {
      runId: params.runId,
      userId: params.userId,
      chatId: params.chatId,
      assistantMessageId: params.assistantMessageId,
      contentText: '',
      thoughtsText: '',
      toolCalls: [],
      lastDbFlushAt: nowInit,
      pendingResolvers: new Map(),
      beforeBrainSnap,
      emittedArtifactIds: new Set(),
      syncedBrainFiles: new Map(),
      textAfterLastToolCall: '',
      lastActivityAt: nowInit,
      subagents: new Map(),
      asyncSubagentToolIds: new Set(),
      initialPromptDone: false,
      parentWakeupStarted: false,
      parentWakeupIdle: false,
      receivedWakeupText: false,
      lastParentActivityAt: nowInit,
      parentState: 'running',
      backgroundWorkCount: 0,
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
        if (proj && proj.instructions.trim()) {
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

      bridge.initialPromptDone = true;
      bridge.parentState = 'idle';
      // Yield to macrotask queue so any notifications queued in the same stdio frame are processed
      await new Promise((r) => setImmediate(r));

      this.syncBrainDeliverablesMidTurn(worker, bridge);

      const hasPendingWork = () => {
        const hasRunningSubagents = [...bridge.subagents.values()].some(
          (s) => s.state === 'running' || s.state === 'requires_action'
        );
        const hasBackgroundCommandWork =
          bridge.backgroundWorkCount > 0 ||
          bridge.toolCalls.some(
            (tc) =>
              (tc.status === 'in_progress' || tc.status === 'pending') &&
              hasBackgroundTaskOutput(tc)
          );
        const hasPendingToolsOrPerms =
          bridge.pendingResolvers.size > 0 ||
          bridge.toolCalls.some((tc) => tc.status === 'in_progress' || tc.status === 'pending');
        const isParentStillActive =
          bridge.parentState === 'running' || bridge.parentState === 'requires_action';
        return {
          hasRunningSubagents,
          hasBackgroundCommandWork,
          hasPendingToolsOrPerms,
          isParentStillActive,
          anyActive:
            hasRunningSubagents ||
            hasBackgroundCommandWork ||
            hasPendingToolsOrPerms ||
            isParentStillActive,
        };
      };

      // When Antigravity has active subagents, background tasks, pending tools/permissions,
      // or has not yet reached an idle parent state after reactive wakeup, keep this turn open
      // until Antigravity explicitly reports completion via ACP notifications.
      if (
        response.stopReason === 'end_turn' &&
        !params.abortSignal.aborted &&
        hasPendingWork().anyActive
      ) {
        let lastBrainPollAt = Date.now();
        const hadBackgroundSubagentOrTaskAtPromptEnd =
          hasPendingWork().hasRunningSubagents || hasPendingWork().hasBackgroundCommandWork;

        while (
          !params.abortSignal.aborted &&
          !worker.process.killed &&
          worker.process.exitCode === null
        ) {
          const now = Date.now();

          if (now - lastBrainPollAt >= 300) {
            lastBrainPollAt = now;
            this.syncBrainDeliverablesMidTurn(worker, bridge);
          }

          const state = hasPendingWork();
          const hasActiveNonSubagentTools = bridge.toolCalls.some(
            (tc) =>
              !bridge.asyncSubagentToolIds.has(tc.toolCallId) &&
              !tc.toolCallId.startsWith('subagent:') &&
              (tc.status === 'in_progress' || tc.status === 'pending')
          );

          const hasExpectationOfWakeup =
            hadBackgroundSubagentOrTaskAtPromptEnd ||
            bridge.parentWakeupStarted ||
            state.hasRunningSubagents ||
            state.hasBackgroundCommandWork;

          if (!hasExpectationOfWakeup) {
            if (
              !state.hasRunningSubagents &&
              !hasActiveNonSubagentTools &&
              bridge.pendingResolvers.size === 0 &&
              bridge.backgroundWorkCount === 0 &&
              !state.isParentStillActive
            ) {
              break;
            }
          } else {
            // Wait until all child subagents are explicitly idle, no tools/permissions/background work
            // remain active, and the parent session has completed its reactive wakeup and reported idle.
            if (
              bridge.parentWakeupIdle &&
              bridge.parentState === 'idle' &&
              !state.hasRunningSubagents &&
              bridge.backgroundWorkCount === 0 &&
              !hasActiveNonSubagentTools &&
              bridge.pendingResolvers.size === 0
            ) {
              break;
            }
          }

          await new Promise((r) => setTimeout(r, 50));
        }

        this.syncBrainDeliverablesMidTurn(worker, bridge);
      }

      // Scrub any internal brain/profile paths in toolCalls and contentText into /workspace/generated/...
      bridge.toolCalls = scrubToolCallsInternalPaths(
        bridge.toolCalls,
        worker.profileDir,
        chat.workspaceDir
      );
      bridge.contentText = rewriteInternalPathsToWorkspace(
        bridge.contentText,
        worker.profileDir,
        chat.workspaceDir
      );

      // Ensure every newly synced brain deliverable is referenced in the assistant message
      for (const synced of bridge.syncedBrainFiles.values()) {
        if (
          !bridge.contentText.includes(synced.filename) &&
          !bridge.contentText.includes(synced.workspaceRelPath)
        ) {
          const { previewKind } = detectMimeAndPreviewKind(synced.filename);
          const snippet =
            previewKind === 'image' || previewKind === 'svg'
              ? `\n\n![${synced.filename}](${synced.workspaceRelPath})\n\n保存先: [${synced.filename}](file://${SANDBOX_WORKSPACE_MOUNT}/${synced.workspaceRelPath})`
              : `\n\n成果物を保存しました: [${synced.filename}](file://${SANDBOX_WORKSPACE_MOUNT}/${synced.workspaceRelPath})`;
          this.appendTurnContentChunk(worker, bridge, snippet);
        }
      }

      // Collect tool-referenced locations and any authorized profile brain assets mentioned by the agent
      const hintPaths: string[] = [...bridge.syncedBrainFiles.values()].map((s) => s.workspaceRelPath);
      const candidatePaths = new Set<string>();
      for (const tc of bridge.toolCalls) {
        for (const loc of tc.locations ?? []) {
          candidatePaths.add(loc.path);
          const hostHint = toHostWorkspacePath(worker.workspaceDir, worker.sandboxWorkspaceRoot, loc.path);
          if (hostHint) hintPaths.push(hostHint);
        }
      }
      for (const extracted of extractCandidatePathsFromToolCalls(bridge.toolCalls)) {
        candidatePaths.add(extracted);
      }
      for (const extracted of extractCandidatePathsFromText(bridge.contentText)) {
        candidatePaths.add(extracted);
      }

      for (const candidatePath of candidatePaths) {
        const brainFile = resolveAuthorizedBrainFile({
          profileDir: worker.profileDir,
          workspaceDir: chat.workspaceDir,
          candidatePath,
        });
        if (!brainFile) continue;
        try {
          const imported = importAuthorizedBrainFileToWorkspace({
            workspaceDir: chat.workspaceDir,
            sourceAbsPath: brainFile.absPath,
          });
          hintPaths.push(imported.relPath);
        } catch {
          // ignore unreadable brain asset
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
        if (bridge.emittedArtifactIds.has(art.id)) continue;
        bridge.emittedArtifactIds.add(art.id);
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

      const afterSkillsSig = captureWorkspaceSkillsSignature(chat.workspaceDir);
      if (afterSkillsSig !== beforeSkillsSig && this.skillService) {
        const refreshed = this.enrichParsedOptions(params.userId, worker.parsedOptions, {
          projectId: chat.projectId,
          chatId: params.chatId,
        });
        worker.parsedOptions = refreshed;
        this.hub.emitDurable({
          userId: params.userId,
          type: 'skills.updated',
          projectId: chat.projectId,
          chatId: params.chatId,
          payload: {
            scope: 'workspace',
            projectId: chat.projectId,
            chatId: params.chatId,
          },
        });
        this.hub.emitDurable({
          userId: params.userId,
          type: 'chat.commands_updated',
          chatId: params.chatId,
          payload: {
            availableCommands: refreshed.availableCommands ?? [],
            sessionOptions: refreshed,
          },
        });
      }

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
      worker.backgroundBridge = bridge;
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
    if (chat.projectId && this.skillService) {
      this.skillService.syncProjectSkillsToChat(userId, chat.projectId, chat.workspaceDir);
    }
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
    let earlyAvailableCommands: AvailableCommandItem[] | undefined;
    let earlyConfigOptions: SessionConfigOption[] | undefined;

    const acpClientApp = client({ name: 'antigravity-chat-ui' });
    const internalBuilder = (
      acpClientApp as unknown as {
        builder?: { handlers?: Array<{ describe?: () => string }> };
      }
    ).builder;
    if (Array.isArray(internalBuilder?.handlers)) {
      internalBuilder.handlers = internalBuilder.handlers.filter(
        (h) => h.describe?.() !== 'client-session-update-router'
      );
    }

    acpClientApp
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
        const turn =
          workerRef?.activeTurn ?? (workerRef ? this.ensureBackgroundBridge(workerRef) : null);
        if (!workerRef || !turn) {
          return { outcome: { outcome: 'cancelled' as const } };
        }
        workerRef.lastUsedAt = Date.now();
        workerRef.lastBackgroundActivityAt = Date.now();

        // First sync any newly generated brain files into /workspace/generated/
        this.syncBrainDeliverablesMidTurn(workerRef, turn);

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
        const subagentMeta = classifySubagentToolCall({
          name: (params.toolCall as { name?: string }).name,
          title: params.toolCall.title ?? undefined,
          kind: params.toolCall.kind ?? undefined,
          rawInput: params.toolCall.rawInput,
        });
        const rawToolCall: ToolCallItem = {
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? 'ツール実行の許可',
          ...((params.toolCall as { name?: string }).name
            ? { name: (params.toolCall as { name?: string }).name }
            : {}),
          kind: params.toolCall.kind ?? undefined,
          status: params.toolCall.status ?? 'pending',
          ...(subagentMeta.isSubagent
            ? { isSubagent: true, subagentLabel: subagentMeta.subagentLabel }
            : {}),
          rawInput: params.toolCall.rawInput,
          locations: (params.toolCall.locations ?? []).map((l) => ({ path: l.path, line: l.line })),
        };
        const [toolCall] = scrubToolCallsInternalPaths(
          [rawToolCall],
          workerRef.profileDir,
          workerRef.workspaceDir
        );
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
      .onNotification(
        methods.client.session.update as unknown as `_${string}`,
        (rawParams: unknown) => rawParams as SessionNotification,
        async ({ params }) => {
          if (!workerRef) {
            if (params.update?.sessionUpdate === 'available_commands_update') {
              earlyAvailableCommands = mapAcpAvailableCommands(params.update.availableCommands);
            } else if (params.update?.sessionUpdate === 'config_option_update') {
              earlyConfigOptions = params.update.configOptions;
            }
            return;
          }
          this.handleSessionNotification(workerRef, params);
        }
      );

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

    const init = (await (conn.agent.request as (method: string, params: unknown) => Promise<unknown>)(
      methods.agent.initialize,
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
          session: { configOptions: { boolean: {} } },
          subagents: {},
          plan: {},
          auth: { terminal: true },
        },
        clientInfo: {
          name: 'antigravity-chat-ui',
          title: 'Antigravity Chat UI',
          version: this.config.appVersion,
        },
      }
    )) as InitializeResponse;

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
          parsedOptions = normalizeConfigOptions(
            loadRes?.configOptions ?? earlyConfigOptions,
            earlyAvailableCommands
          );
        } else if (init.agentCapabilities?.sessionCapabilities?.resume) {
          const resumeRes = (await conn.agent.request(methods.agent.session.resume, {
            sessionId: chat.acpSessionId,
            cwd: spec.sandboxWorkspaceRoot,
            mcpServers: [],
            ...(systemPromptPayload ? { systemPrompt: systemPromptPayload } : {}),
          })) as ResumeSessionResponse | undefined;
          acpSessionId = chat.acpSessionId;
          restoredExistingSession = true;
          parsedOptions = normalizeConfigOptions(
            resumeRes?.configOptions ?? earlyConfigOptions,
            earlyAvailableCommands
          );
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
        parsedOptions = normalizeConfigOptions(
          newRes.configOptions ?? earlyConfigOptions,
          earlyAvailableCommands
        );
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
        parsedOptions = normalizeConfigOptions(res.configOptions, earlyAvailableCommands);
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
        parsedOptions = normalizeConfigOptions(res.configOptions, earlyAvailableCommands);
      }
    }

    parsedOptions = this.enrichParsedOptions(
      userId,
      parsedOptions,
      { projectId: chat.projectId, chatId: chat.id },
      earlyAvailableCommands
    );

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
      backgroundBridge: null,
      lastBackgroundActivityAt: 0,
      stderrTail,
    };

    this.workers.set(workerKey, workerRef);
    return workerRef;
  }

  private appendTurnContentChunk(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    rawChunk: string
  ): void {
    if (!rawChunk) return;
    const chunk = rewriteInternalPathsToWorkspace(
      rawChunk,
      worker.profileDir,
      worker.workspaceDir
    );
    const offset = turn.contentText.length;
    turn.contentText += chunk;
    turn.textAfterLastToolCall += chunk;
    turn.lastActivityAt = Date.now();
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

  private saveInlineBase64AssetToWorkspace(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    params: { data: string; mimeType: string; suggestedName?: string }
  ): string | null {
    try {
      const buf = Buffer.from(params.data, 'base64');
      if (buf.length === 0) return null;
      const extFromMime =
        params.mimeType === 'image/png'
          ? '.png'
          : params.mimeType === 'image/jpeg'
            ? '.jpg'
            : params.mimeType === 'image/webp'
              ? '.webp'
              : params.mimeType === 'image/gif'
                ? '.gif'
                : params.mimeType === 'image/svg+xml'
                  ? '.svg'
                  : '.bin';
      const baseName = sanitizeFileName(
        params.suggestedName || `generated-${Date.now()}${extFromMime}`
      );
      const finalName = path.extname(baseName) ? baseName : `${baseName}${extFromMime}`;
      const relPath = `generated/${finalName}`;
      const target = resolveContainedWriteTarget(worker.workspaceDir, relPath);
      fs.mkdirSync(path.dirname(target.absPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target.absPath, buf);
      this.registerAndEmitSyncedWorkspaceFile(worker, turn, {
        brainAbsPath: target.absPath,
        relUnderBrain: finalName,
        workspaceAbsPath: target.absPath,
        workspaceRelPath: target.relPath,
        filename: path.basename(target.relPath),
      });
      return target.relPath;
    } catch {
      return null;
    }
  }

  private registerAndEmitSyncedWorkspaceFile(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    item: SyncedBrainFile
  ): void {
    turn.syncedBrainFiles.set(item.workspaceRelPath, item);
    try {
      const stat = fs.statSync(item.workspaceAbsPath);
      if (!stat.isFile()) return;
      const fileSha = sha256File(item.workspaceAbsPath);
      const { mimeType, previewKind } = detectMimeAndPreviewKind(item.filename);
      const existing = this.db.findArtifactByRelPath(
        worker.userId,
        worker.chatId,
        item.workspaceRelPath
      );
      const artifact = this.db.upsertArtifact({
        id: existing?.id ?? crypto.randomUUID(),
        userId: worker.userId,
        chatId: worker.chatId,
        messageId: turn.assistantMessageId,
        runId: turn.runId,
        relPath: item.workspaceRelPath,
        filename: item.filename,
        mimeType,
        sizeBytes: stat.size,
        sha256: fileSha,
        source: 'generated',
        previewKind,
        diffPatch: null,
        minUpdatedAt: stat.mtimeMs,
      });
      if (!turn.emittedArtifactIds.has(artifact.id)) {
        turn.emittedArtifactIds.add(artifact.id);
        this.hub.emitDurable({
          userId: worker.userId,
          type: 'artifact.created',
          chatId: worker.chatId,
          runId: turn.runId,
          payload: { artifact },
        });
      }
    } catch {
      // ignore transient stat error
    }
  }

  private syncBrainDeliverablesMidTurn(
    worker: WorkerInstance,
    turn: ActiveTurnBridge
  ): SyncedBrainFile[] {
    const newlySynced = syncNewBrainFilesToWorkspace({
      profileDir: worker.profileDir,
      workspaceDir: worker.workspaceDir,
      beforeSnap: turn.beforeBrainSnap,
    });

    for (const item of newlySynced) {
      this.registerAndEmitSyncedWorkspaceFile(worker, turn, item);
    }

    // Also inspect any explicit paths mentioned in toolCalls so far
    const candidates = new Set<string>([
      ...extractCandidatePathsFromToolCalls(turn.toolCalls),
      ...extractCandidatePathsFromText(turn.contentText),
    ]);
    for (const tc of turn.toolCalls) {
      for (const loc of tc.locations ?? []) {
        if (loc.path) candidates.add(loc.path);
      }
    }

    for (const candidatePath of candidates) {
      const brainFile = resolveAuthorizedBrainFile({
        profileDir: worker.profileDir,
        workspaceDir: worker.workspaceDir,
        candidatePath,
      });
      if (!brainFile) continue;
      try {
        const imported = importAuthorizedBrainFileToWorkspace({
          workspaceDir: worker.workspaceDir,
          sourceAbsPath: brainFile.absPath,
        });
        const item: SyncedBrainFile = {
          brainAbsPath: brainFile.absPath,
          relUnderBrain: brainFile.relUnderBrain,
          workspaceAbsPath: imported.absPath,
          workspaceRelPath: imported.relPath,
          filename: path.basename(imported.relPath),
        };
        this.registerAndEmitSyncedWorkspaceFile(worker, turn, item);
        newlySynced.push(item);
      } catch {
        // ignore
      }
    }

    return newlySynced;
  }

  private extractToolCallContentAndSaveAssets(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    rawContent: unknown
  ): string | undefined {
    if (!Array.isArray(rawContent) || rawContent.length === 0) return undefined;
    const textParts: string[] = [];
    for (const item of rawContent) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      if (entry.type === 'content' && entry.content && typeof entry.content === 'object') {
        const block = entry.content as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(
            rewriteInternalPathsToWorkspace(block.text, worker.profileDir, worker.workspaceDir)
          );
        } else if (
          block.type === 'image' &&
          typeof block.data === 'string' &&
          typeof block.mimeType === 'string'
        ) {
          const rel = this.saveInlineBase64AssetToWorkspace(worker, turn, {
            data: block.data,
            mimeType: block.mimeType,
          });
          if (rel) {
            textParts.push(`![生成画像](${rel})`);
          }
        } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
          const rewritten = rewriteInternalPathsToWorkspace(
            block.uri,
            worker.profileDir,
            worker.workspaceDir
          );
          textParts.push(rewritten);
        }
      } else if (entry.type === 'diff' && typeof entry.path === 'string') {
        const cleanPath = rewriteInternalPathsToWorkspace(
          entry.path,
          worker.profileDir,
          worker.workspaceDir
        );
        textParts.push(`Diff: ${cleanPath}`);
      }
    }
    return textParts.length > 0 ? textParts.join('\n').trim() : undefined;
  }

  private upsertSubagentToolCall(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    params: {
      subSessionId: string;
      toolCallId?: string | null;
      title?: string | null;
      description?: string | null;
      state?: 'running' | 'idle' | 'requires_action' | 'unknown';
      stopReason?: string | null;
      activityNote?: string;
    }
  ): void {
    const existingTrack = turn.subagents.get(params.subSessionId);
    const fallbackId = `subagent:${params.subSessionId}`;
    let targetToolCallId =
      (params.toolCallId && params.toolCallId.trim()) || existingTrack?.toolCallId;

    if (!targetToolCallId || targetToolCallId === fallbackId) {
      const boundToolIds = new Set(
        [...turn.subagents.values()]
          .filter((s) => s.sessionId !== params.subSessionId)
          .map((s) => s.toolCallId)
      );
      const unboundAsyncId = [...turn.asyncSubagentToolIds].find((id) => !boundToolIds.has(id));
      if (unboundAsyncId) {
        if (existingTrack?.toolCallId === fallbackId && unboundAsyncId !== fallbackId) {
          turn.toolCalls = turn.toolCalls.filter((t) => t.toolCallId !== fallbackId);
        }
        targetToolCallId = unboundAsyncId;
      } else if (!targetToolCallId) {
        targetToolCallId = fallbackId;
      }
    } else if (existingTrack?.toolCallId && existingTrack.toolCallId !== targetToolCallId) {
      turn.toolCalls = turn.toolCalls.filter((t) => t.toolCallId !== existingTrack.toolCallId);
    }

    const nextState = params.state ?? existingTrack?.state ?? 'running';
    const nextTitle =
      (params.title && params.title.trim()) ||
      existingTrack?.title ||
      (params.description && params.description.trim()) ||
      'サブエージェント';
    const nextDesc =
      params.description !== undefined
        ? params.description ?? undefined
        : existingTrack?.description;

    const tracked: TrackedSubagentState = {
      sessionId: params.subSessionId,
      toolCallId: targetToolCallId,
      title: nextTitle,
      description: nextDesc,
      state: nextState,
      stopReason: params.stopReason !== undefined ? params.stopReason : existingTrack?.stopReason,
      lastActivityAt: Date.now(),
    };
    turn.subagents.set(params.subSessionId, tracked);

    const mappedStatus: ToolCallItem['status'] =
      nextState === 'running' || nextState === 'requires_action'
        ? 'in_progress'
        : tracked.stopReason === 'error' || tracked.stopReason === 'refusal'
          ? 'failed'
          : 'completed';

    const label = nextDesc
      ? `サブエージェント (${nextTitle}: ${nextDesc})`
      : `サブエージェント (${nextTitle})`;

    const idx = turn.toolCalls.findIndex((t) => t.toolCallId === targetToolCallId);
    if (idx >= 0) {
      const prev = turn.toolCalls[idx];
      turn.toolCalls[idx] = {
        ...prev,
        isSubagent: true,
        subagentLabel: prev.subagentLabel || label,
        status: mappedStatus,
        ...(params.activityNote ? { contentText: params.activityNote } : {}),
      };
    } else {
      turn.toolCalls.push({
        toolCallId: targetToolCallId,
        title: nextTitle,
        isSubagent: true,
        subagentLabel: label,
        status: mappedStatus,
        ...(params.activityNote ? { contentText: params.activityNote } : {}),
      });
    }

    this.db.updateMessage(turn.userId, turn.assistantMessageId, { toolCalls: turn.toolCalls });
    this.hub.emitEphemeral({
      userId: worker.userId,
      type: 'run.tool_update',
      chatId: worker.chatId,
      runId: turn.runId,
      payload: { messageId: turn.assistantMessageId, toolCalls: turn.toolCalls },
    });
  }

  private handleChildSessionNotification(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    childSessionId: string,
    update: SessionUpdate
  ): void {
    const rawUpdate = update as unknown as Record<string, unknown>;
    const rawUpdateType = String(rawUpdate.sessionUpdate || '');
    if (rawUpdateType === 'state_update') {
      const hasExplicitNullState = 'state' in rawUpdate && rawUpdate.state === null;
      const stateObj = rawUpdate as {
        state?: 'running' | 'idle' | 'requires_action' | 'unknown' | null;
        stopReason?: string | null;
      };
      const resolvedState = hasExplicitNullState
        ? 'idle'
        : stateObj.state ?? (stateObj.stopReason ? 'idle' : 'running');
      this.upsertSubagentToolCall(worker, turn, {
        subSessionId: childSessionId,
        state: resolvedState,
        stopReason: stateObj.stopReason,
      });
      this.syncBrainDeliverablesMidTurn(worker, turn);
      return;
    }

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const contentNote = this.extractToolCallContentAndSaveAssets(
        worker,
        turn,
        (update as { content?: unknown }).content
      );
      this.syncBrainDeliverablesMidTurn(worker, turn);
      const isFinishedTool =
        update.sessionUpdate === 'tool_call_update' &&
        (update.status === 'completed' || update.status === 'failed');
      const activityNote =
        contentNote ||
        (update.title ? (isFinishedTool ? update.title : `実行中: ${update.title}`) : undefined);
      this.upsertSubagentToolCall(worker, turn, {
        subSessionId: childSessionId,
        state: 'running',
        activityNote,
      });
      return;
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content.type === 'image') {
        this.saveInlineBase64AssetToWorkspace(worker, turn, {
          data: update.content.data,
          mimeType: update.content.mimeType,
        });
      } else if (update.content.type === 'resource_link') {
        this.syncBrainDeliverablesMidTurn(worker, turn);
      } else if (update.content.type === 'text' && update.content.text.trim()) {
        const cleaned = rewriteInternalPathsToWorkspace(
          update.content.text.trim(),
          worker.profileDir,
          worker.workspaceDir
        );
        this.upsertSubagentToolCall(worker, turn, {
          subSessionId: childSessionId,
          activityNote: cleaned.slice(0, 300),
        });
      }
      this.syncBrainDeliverablesMidTurn(worker, turn);
    }
  }

  private ensureBackgroundBridge(worker: WorkerInstance): ActiveTurnBridge | null {
    if (worker.backgroundBridge) {
      return worker.backgroundBridge;
    }
    const messages = this.db.listMessages(worker.userId, worker.chatId);
    const latestAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!latestAssistant) return null;

    const beforeBrainSnap = captureBrainSnapshot(worker.profileDir, worker.workspaceDir);
    const bridge: ActiveTurnBridge = {
      runId: latestAssistant.runId ?? '',
      userId: worker.userId,
      chatId: worker.chatId,
      assistantMessageId: latestAssistant.id,
      contentText: latestAssistant.contentText,
      thoughtsText: latestAssistant.thoughtsText,
      toolCalls: [...latestAssistant.toolCalls],
      lastDbFlushAt: 0,
      pendingResolvers: new Map(),
      beforeBrainSnap,
      emittedArtifactIds: new Set(latestAssistant.artifactIds),
      syncedBrainFiles: new Map(),
      textAfterLastToolCall: '',
      lastActivityAt: Date.now(),
      subagents: new Map(),
      asyncSubagentToolIds: new Set(),
      initialPromptDone: true,
      parentWakeupStarted: true,
      parentWakeupIdle: false,
      receivedWakeupText: true,
      lastParentActivityAt: Date.now(),
      parentState: 'idle',
      backgroundWorkCount: 0,
    };
    worker.backgroundBridge = bridge;
    return bridge;
  }

  private flushBackgroundBridgeToMessage(worker: WorkerInstance, bridge: ActiveTurnBridge): void {
    const updated = this.db.updateMessage(worker.userId, bridge.assistantMessageId, {
      contentText: bridge.contentText,
      thoughtsText: bridge.thoughtsText,
      toolCalls: bridge.toolCalls,
      artifactIds: [...bridge.emittedArtifactIds],
    });
    if (updated) {
      this.hub.emitDurable({
        userId: worker.userId,
        type: 'message.updated',
        chatId: worker.chatId,
        runId: bridge.runId || null,
        payload: { message: updated },
      });
    }
  }

  private handleSessionNotification(worker: WorkerInstance, params: SessionNotification): void {
    const update: SessionUpdate = params.update;

    if (update.sessionUpdate === 'config_option_update') {
      const chat = this.db.getChat(worker.userId, worker.chatId);
      const prevAcpCommands = (worker.parsedOptions.availableCommands ?? []).filter(
        (c) => c.source !== 'skill'
      );
      worker.parsedOptions = this.enrichParsedOptions(
        worker.userId,
        normalizeConfigOptions(update.configOptions),
        { projectId: chat?.projectId ?? null, chatId: worker.chatId },
        prevAcpCommands
      );
      this.hub.emitDurable({
        userId: worker.userId,
        type: 'chat.config_updated',
        chatId: worker.chatId,
        payload: { sessionOptions: worker.parsedOptions },
      });
      return;
    }

    if (update.sessionUpdate === 'available_commands_update') {
      const chat = this.db.getChat(worker.userId, worker.chatId);
      const acpCmds = mapAcpAvailableCommands(update.availableCommands);
      worker.parsedOptions = this.enrichParsedOptions(
        worker.userId,
        worker.parsedOptions,
        { projectId: chat?.projectId ?? null, chatId: worker.chatId },
        acpCmds
      );
      this.hub.emitDurable({
        userId: worker.userId,
        type: 'chat.commands_updated',
        chatId: worker.chatId,
        payload: {
          availableCommands: worker.parsedOptions.availableCommands ?? [],
          sessionOptions: worker.parsedOptions,
        },
      });
      return;
    }

    const isBackgroundTurn = !worker.activeTurn;
    const turn = worker.activeTurn ?? this.ensureBackgroundBridge(worker);

    if (update.sessionUpdate === 'usage_update') {
      if (turn) {
        turn.lastActivityAt = Date.now();
        turn.lastParentActivityAt = Date.now();
      }
      this.hub.emitEphemeral({
        userId: worker.userId,
        type: 'chat.context_usage',
        chatId: worker.chatId,
        runId: turn?.runId ?? null,
        payload: { used: update.used, size: update.size, cost: update.cost ?? null },
      });
      return;
    }

    if (!turn) {
      return;
    }

    const now = Date.now();
    turn.lastActivityAt = now;
    worker.lastUsedAt = now;
    if (isBackgroundTurn) {
      worker.lastBackgroundActivityAt = now;
    }

    const finalizeIfBackground = () => {
      if (isBackgroundTurn) {
        this.flushBackgroundBridgeToMessage(worker, turn);
      }
    };

    // Route child subagent session notifications cleanly without mixing child scratch output into parent text
    if (params.sessionId && worker.acpSessionId && params.sessionId !== worker.acpSessionId) {
      this.handleChildSessionNotification(worker, turn, params.sessionId, update);
      finalizeIfBackground();
      return;
    }

    const rawUpdate = update as unknown as Record<string, unknown>;
    const rawUpdateType = String(rawUpdate.sessionUpdate || '');

    if (rawUpdateType === 'subagent_update') {
      // In ACP v1/v2 (`SubagentUpdate.state`), `state: null` clears the current activity of the subagent.
      const hasExplicitNullState = 'state' in rawUpdate && rawUpdate.state === null;
      const subStateObj = rawUpdate.state as
        | { state?: 'running' | 'idle' | 'requires_action' | 'unknown'; stopReason?: string | null }
        | null
        | undefined;
      const resolvedSubState = hasExplicitNullState
        ? 'idle'
        : subStateObj?.state ?? (subStateObj?.stopReason ? 'idle' : undefined);
      this.upsertSubagentToolCall(worker, turn, {
        subSessionId: typeof rawUpdate.sessionId === 'string' ? rawUpdate.sessionId : 'subagent',
        toolCallId: typeof rawUpdate.toolCallId === 'string' ? rawUpdate.toolCallId : null,
        title: typeof rawUpdate.title === 'string' ? rawUpdate.title : null,
        description: typeof rawUpdate.description === 'string' ? rawUpdate.description : null,
        state: resolvedSubState,
        stopReason: subStateObj?.stopReason,
      });
      this.syncBrainDeliverablesMidTurn(worker, turn);
      finalizeIfBackground();
      return;
    }

    if (rawUpdateType === 'state_update') {
      const stateObj = rawUpdate as {
        state?: 'running' | 'idle' | 'requires_action' | 'unknown';
        stopReason?: string | null;
        background?: Array<{ type?: string; sessionId?: string; toolCallId?: string }> | null;
      };
      turn.lastParentActivityAt = now;
      if (Array.isArray(stateObj.background)) {
        turn.backgroundWorkCount = stateObj.background.length;
        const activeBgSubagentIds = new Set<string>();
        for (const item of stateObj.background) {
          if (item && item.type === 'subagent' && typeof item.sessionId === 'string') {
            activeBgSubagentIds.add(item.sessionId);
            if (!turn.subagents.has(item.sessionId)) {
              this.upsertSubagentToolCall(worker, turn, {
                subSessionId: item.sessionId,
                toolCallId: typeof item.toolCallId === 'string' ? item.toolCallId : null,
                state: 'running',
              });
            }
          }
        }
        // Any tracked subagent that is no longer present in Antigravity's active `background` list has finished
        for (const [subSessionId, tracked] of turn.subagents.entries()) {
          if (
            (tracked.state === 'running' || tracked.state === 'requires_action') &&
            !activeBgSubagentIds.has(subSessionId)
          ) {
            this.upsertSubagentToolCall(worker, turn, {
              subSessionId,
              state: 'idle',
            });
          }
        }
      } else if (stateObj.background === null) {
        turn.backgroundWorkCount = 0;
        for (const [subSessionId, tracked] of turn.subagents.entries()) {
          if (tracked.state === 'running' || tracked.state === 'requires_action') {
            this.upsertSubagentToolCall(worker, turn, {
              subSessionId,
              state: 'idle',
            });
          }
        }
      }
      if (stateObj.state) {
        turn.parentState = stateObj.state;
      }
      if (
        (stateObj.state === 'running' || stateObj.state === 'requires_action') &&
        turn.initialPromptDone
      ) {
        turn.parentWakeupStarted = true;
        turn.parentWakeupIdle = false;
      } else if (stateObj.state === 'idle' && turn.initialPromptDone) {
        if (turn.parentWakeupStarted && !Array.isArray(stateObj.background)) {
          for (const [subSessionId, tracked] of turn.subagents.entries()) {
            if (tracked.state === 'running' || tracked.state === 'requires_action') {
              this.upsertSubagentToolCall(worker, turn, {
                subSessionId,
                state: 'idle',
              });
            }
          }
        }
        const anySubagentStillRunning = [...turn.subagents.values()].some(
          (s) => s.state === 'running' || s.state === 'requires_action'
        );
        if (turn.backgroundWorkCount === 0 && !anySubagentStillRunning) {
          turn.parentWakeupIdle = true;
        }
        this.syncBrainDeliverablesMidTurn(worker, turn);
      }
      finalizeIfBackground();
      return;
    }

    if (rawUpdateType === 'session_message' || rawUpdateType === 'session_message_chunk') {
      this.syncBrainDeliverablesMidTurn(worker, turn);
      const senderSessionId =
        typeof rawUpdate.senderSessionId === 'string' ? rawUpdate.senderSessionId : null;
      const isFinalChunk = rawUpdateType === 'session_message' || rawUpdate.done !== false;
      if (isFinalChunk && senderSessionId && senderSessionId !== worker.acpSessionId) {
        this.upsertSubagentToolCall(worker, turn, {
          subSessionId: senderSessionId,
          state: 'idle',
        });
      }
      finalizeIfBackground();
      return;
    }

    // Parent session activity arriving after the initial session/prompt resolved means
    // Antigravity's native Reactive Wakeup has resumed the parent session.
    if (
      turn.initialPromptDone &&
      (update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk' ||
        update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update')
    ) {
      turn.lastParentActivityAt = now;
      turn.parentState = 'running';
      turn.parentWakeupIdle = false;
      if (!turn.parentWakeupStarted) {
        turn.parentWakeupStarted = true;
        this.syncBrainDeliverablesMidTurn(worker, turn);
      }
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      if (turn.initialPromptDone && !turn.receivedWakeupText) {
        turn.receivedWakeupText = true;
        if (turn.contentText.trim().length > 0 && !turn.contentText.endsWith('\n\n')) {
          this.appendTurnContentChunk(
            worker,
            turn,
            turn.contentText.endsWith('\n') ? '\n' : '\n\n'
          );
        }
      }
      if (update.content.type === 'text') {
        this.appendTurnContentChunk(worker, turn, update.content.text);
      } else if (update.content.type === 'image') {
        const rel = this.saveInlineBase64AssetToWorkspace(worker, turn, {
          data: update.content.data,
          mimeType: update.content.mimeType,
        });
        if (rel) {
          this.appendTurnContentChunk(worker, turn, `\n\n![生成画像](${rel})\n`);
        }
      } else if (update.content.type === 'resource_link') {
        this.syncBrainDeliverablesMidTurn(worker, turn);
        const rewrittenUri = rewriteInternalPathsToWorkspace(
          update.content.uri,
          worker.profileDir,
          worker.workspaceDir
        );
        const rel = rewrittenUri.replace(/^file:\/\//, '').replace(/^\/workspace\//, '');
        const { previewKind } = detectMimeAndPreviewKind(update.content.name || rel);
        const md =
          previewKind === 'image' || previewKind === 'svg'
            ? `\n\n![${update.content.name || path.basename(rel)}](${rel})\n`
            : `\n\n[${update.content.name || path.basename(rel)}](${rewrittenUri})\n`;
        this.appendTurnContentChunk(worker, turn, md);
      }
      finalizeIfBackground();
      return;
    }

    if (update.sessionUpdate === 'agent_thought_chunk') {
      if (update.content.type === 'text') {
        const offset = turn.thoughtsText.length;
        const chunk = rewriteInternalPathsToWorkspace(
          update.content.text,
          worker.profileDir,
          worker.workspaceDir
        );
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
      finalizeIfBackground();
      return;
    }

    if (update.sessionUpdate === 'tool_call') {
      const rawName = (update as { name?: string }).name;
      const rawContent = (update as { content?: unknown }).content;
      const subagentMeta = classifySubagentToolCall({
        name: rawName,
        title: update.title,
        kind: update.kind,
        rawInput: update.rawInput,
        rawContent,
      });
      if (subagentMeta.isAsyncSubagentLaunch) {
        turn.asyncSubagentToolIds.add(update.toolCallId);
        for (const tracked of turn.subagents.values()) {
          if (tracked.toolCallId === `subagent:${tracked.sessionId}`) {
            turn.toolCalls = turn.toolCalls.filter((t) => t.toolCallId !== tracked.toolCallId);
            tracked.toolCallId = update.toolCallId;
            break;
          }
        }
      }
      const contentText = this.extractToolCallContentAndSaveAssets(worker, turn, rawContent);
      const isBoundSubagentStillRunning = [...turn.subagents.values()].some(
        (s) =>
          s.toolCallId === update.toolCallId &&
          (s.state === 'running' || s.state === 'requires_action')
      );
      let effectiveStatus: ToolCallItem['status'] = update.status ?? 'in_progress';
      if (isBoundSubagentStillRunning && effectiveStatus === 'completed') {
        effectiveStatus = 'in_progress';
      }

      const nextToolRaw: ToolCallItem = {
        toolCallId: update.toolCallId,
        title: update.title,
        ...(rawName ? { name: rawName } : {}),
        kind: update.kind,
        status: effectiveStatus,
        ...(subagentMeta.isSubagent
          ? { isSubagent: true, subagentLabel: subagentMeta.subagentLabel }
          : {}),
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        locations: update.locations?.map((l) => ({ path: l.path, line: l.line })),
        ...(contentText ? { contentText } : {}),
      };
      const [nextTool] = scrubToolCallsInternalPaths(
        [nextToolRaw],
        worker.profileDir,
        worker.workspaceDir
      );
      const idx = turn.toolCalls.findIndex((t) => t.toolCallId === nextTool.toolCallId);
      if (idx >= 0) turn.toolCalls[idx] = nextTool;
      else turn.toolCalls.push(nextTool);

      turn.textAfterLastToolCall = '';
      this.syncBrainDeliverablesMidTurn(worker, turn);

      this.db.updateMessage(turn.userId, turn.assistantMessageId, { toolCalls: turn.toolCalls });
      this.hub.emitEphemeral({
        userId: worker.userId,
        type: 'run.tool_update',
        chatId: worker.chatId,
        runId: turn.runId,
        payload: { messageId: turn.assistantMessageId, toolCalls: turn.toolCalls },
      });
      finalizeIfBackground();
      return;
    }

    if (update.sessionUpdate === 'tool_call_update') {
      const idx = turn.toolCalls.findIndex((t) => t.toolCallId === update.toolCallId);
      const existing: ToolCallItem =
        idx >= 0
          ? turn.toolCalls[idx]
          : { toolCallId: update.toolCallId, title: update.title ?? 'ツール実行', status: 'in_progress' };

      const rawName = (update as { name?: string }).name ?? existing.name;
      const mergedTitle =
        update.title !== undefined && update.title !== null ? update.title : existing.title;
      const mergedKind =
        update.kind !== undefined && update.kind !== null ? update.kind : existing.kind;
      const mergedRawInput = update.rawInput !== undefined ? update.rawInput : existing.rawInput;
      const rawContent = (update as { content?: unknown }).content;
      const subagentMeta = classifySubagentToolCall({
        name: rawName,
        title: mergedTitle,
        kind: mergedKind,
        rawInput: mergedRawInput,
        rawContent,
      });
      if (subagentMeta.isAsyncSubagentLaunch) {
        turn.asyncSubagentToolIds.add(update.toolCallId);
        for (const tracked of turn.subagents.values()) {
          if (tracked.toolCallId === `subagent:${tracked.sessionId}`) {
            turn.toolCalls = turn.toolCalls.filter((t) => t.toolCallId !== tracked.toolCallId);
            tracked.toolCallId = update.toolCallId;
            break;
          }
        }
      }
      const contentText = this.extractToolCallContentAndSaveAssets(worker, turn, rawContent);

      // Only keep status as `in_progress` if an active tracked subagent in `turn.subagents` is bound to this toolCallId
      const isBoundSubagentStillRunning = [...turn.subagents.values()].some(
        (s) =>
          s.toolCallId === update.toolCallId &&
          (s.state === 'running' || s.state === 'requires_action')
      );

      let effectiveStatus =
        update.status !== undefined && update.status !== null ? update.status : existing.status;
      if (isBoundSubagentStillRunning && effectiveStatus === 'completed') {
        effectiveStatus = 'in_progress';
      }

      const mergedRaw: ToolCallItem = {
        ...existing,
        title: mergedTitle,
        ...(rawName ? { name: rawName } : {}),
        ...(mergedKind !== undefined ? { kind: mergedKind } : {}),
        status: effectiveStatus,
        ...(subagentMeta.isSubagent
          ? { isSubagent: true, subagentLabel: subagentMeta.subagentLabel }
          : {}),
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        ...(update.locations !== undefined && update.locations !== null
          ? { locations: update.locations.map((l) => ({ path: l.path, line: l.line })) }
          : {}),
        ...(contentText ? { contentText } : {}),
      };
      const [merged] = scrubToolCallsInternalPaths(
        [mergedRaw],
        worker.profileDir,
        worker.workspaceDir
      );
      const nextIdx = turn.toolCalls.findIndex((t) => t.toolCallId === update.toolCallId);
      if (nextIdx >= 0) turn.toolCalls[nextIdx] = merged;
      else turn.toolCalls.push(merged);

      turn.textAfterLastToolCall = '';
      this.syncBrainDeliverablesMidTurn(worker, turn);

      this.db.updateMessage(turn.userId, turn.assistantMessageId, { toolCalls: turn.toolCalls });
      this.hub.emitEphemeral({
        userId: worker.userId,
        type: 'run.tool_update',
        chatId: worker.chatId,
        runId: turn.runId,
        payload: { messageId: turn.assistantMessageId, toolCalls: turn.toolCalls },
      });
      finalizeIfBackground();
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

  private isWorkerBusy(w: WorkerInstance): boolean {
    if (w.inFlight || w.activeTurn !== null) return true;
    const bg = w.backgroundBridge;
    if (bg) {
      if (bg.pendingResolvers.size > 0) return true;
      if (bg.parentState === 'running' || bg.parentState === 'requires_action') return true;
      if (bg.backgroundWorkCount > 0) return true;
      if (
        [...bg.subagents.values()].some(
          (s) => s.state === 'running' || s.state === 'requires_action'
        )
      ) {
        return true;
      }
      if (bg.toolCalls.some((tc) => tc.status === 'in_progress' || tc.status === 'pending')) {
        return true;
      }
    }
    return false;
  }

  private evictOneIdleIfFull(): void {
    if (this.workers.size < this.config.maxConcurrentAcp) return;
    let oldestIdle: WorkerInstance | null = null;
    for (const w of this.workers.values()) {
      if (!this.isWorkerBusy(w) && (!oldestIdle || w.lastUsedAt < oldestIdle.lastUsedAt)) {
        oldestIdle = w;
      }
    }
    if (oldestIdle && !this.isWorkerBusy(oldestIdle)) {
      void this.stopWorkerByKey(oldestIdle.key);
    }
  }

  private evictIdleWorkers(): void {
    const cutoff = Date.now() - this.config.idleWorkerMs;
    for (const w of this.workers.values()) {
      if (!this.isWorkerBusy(w) && w.lastUsedAt < cutoff) {
        void this.stopWorkerByKey(w.key);
      }
    }
  }
}
