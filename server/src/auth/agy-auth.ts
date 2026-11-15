import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { AcpClientManager } from '../acp/client-manager.js';
import { buildAgyCommandSpec, buildIsolatedAgyEnv } from '../acp/env-isolation.js';
import type { SyncHub } from '../sync/hub.js';
import type { AgyLoginFlowState, AgyProfile } from '../types.js';
import { encryptSmallSecret } from './password.js';

const execFileAsync = promisify(execFile);

interface ActiveLoginFlow {
  state: AgyLoginFlowState;
  child: ChildProcessWithoutNullStreams;
  accountLabel: string | null;
}

export class AgyAuthManager {
  private readonly flows = new Map<string, ActiveLoginFlow>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: SyncHub,
    private readonly acp: AcpClientManager
  ) {}

  getFlowState(userId: string): AgyLoginFlowState {
    const existing = this.flows.get(userId);
    if (existing) return existing.state;
    return {
      userId,
      status: 'idle',
      authUrl: null,
      outputLines: [],
      error: null,
      startedAt: 0,
      updatedAt: 0,
    };
  }

  async shutdown(): Promise<void> {
    for (const userId of [...this.flows.keys()]) {
      await this.cancelLogin(userId);
    }
  }

  /**
   * Starts interactive `agy acp --login` inside a user-isolated wide PTY via Python helper
   * to capture the official Google OAuth authorization URL without reading token files.
   */
  async startCodePasteLogin(userId: string, opts: { accountLabel?: string | null } = {}): Promise<AgyLoginFlowState> {
    const profile = this.db.getAgyProfile(userId);
    if (!profile) throw new Error('Antigravity profile missing for user');

    // Cancel any stale in-progress login flow for this user
    if (this.flows.has(userId)) {
      await this.cancelLogin(userId);
    }

    await this.acp.stopAllForUser(userId);

    const probeDir = path.join(profile.profileDir, '.probe');
    fs.mkdirSync(probeDir, { recursive: true, mode: 0o700 });

    const loginArgs = this.config.agyMode === 'mock' ? ['--login'] : ['acp', '--login'];
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: loginArgs,
      profileDir: profile.profileDir,
      workspaceDir: probeDir,
      enableSandboxBwrap: false,
    });

    const ptyArgs = [this.config.ptyHelperPath, spec.command, ...spec.args];
    const child = spawn(this.config.pythonBin, ptyArgs, {
      cwd: profile.profileDir,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const now = Date.now();
    const state: AgyLoginFlowState = {
      userId,
      status: 'awaiting_url',
      authUrl: null,
      outputLines: [],
      error: null,
      startedAt: now,
      updatedAt: now,
    };

    const flow: ActiveLoginFlow = {
      state,
      child,
      accountLabel: opts.accountLabel?.trim() || null,
    };
    this.flows.set(userId, flow);
    this.db.updateAgyProfile(userId, { authStatus: 'pending_login', lastError: null });

    const emitProgress = () => {
      state.updatedAt = Date.now();
      this.hub.emitDurable({
        userId,
        type: 'agy.login_progress',
        payload: { loginFlow: { ...state, outputLines: [...state.outputLines] } },
      });
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let evt: { type: string; url?: string; line?: string; message?: string; code?: number };
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }

      if (evt.type === 'auth_url' && evt.url) {
        state.authUrl = evt.url;
        state.status = 'awaiting_code';
        emitProgress();
      } else if (evt.type === 'awaiting_code' && state.status !== 'verifying') {
        state.status = 'awaiting_code';
        emitProgress();
      } else if (evt.type === 'output' && evt.line) {
        state.outputLines.push(evt.line);
        if (state.outputLines.length > 30) state.outputLines.shift();
        emitProgress();
      } else if (evt.type === 'error' && evt.message) {
        state.error = evt.message;
        emitProgress();
      }
    });

    const errRl = readline.createInterface({ input: child.stderr });
    errRl.on('line', (line) => {
      if (line.trim()) {
        state.outputLines.push(line.trim());
        if (state.outputLines.length > 30) state.outputLines.shift();
      }
    });

    child.once('close', async (exitCode) => {
      if (this.flows.get(userId) !== flow) return;

      if (state.status === 'cancelled') {
        this.db.updateAgyProfile(userId, { authStatus: 'unauthenticated' });
        this.flows.delete(userId);
        return;
      }

      if (exitCode !== 0) {
        state.status = 'failed';
        state.error = state.error ?? `認証プロセスがエラー終了しました (exit ${exitCode ?? 'unknown'})`;
        const nextProfile = this.db.updateAgyProfile(userId, {
          authStatus: 'error',
          lastError: state.error,
        });
        emitProgress();
        this.hub.emitDurable({
          userId,
          type: 'agy.auth_changed',
          payload: { profile: nextProfile },
        });
        this.flows.delete(userId);
        return;
      }

      // Verify strictly via official ACP probe (`initialize` + `session/new`) without reading tokens!
      state.status = 'verifying';
      emitProgress();
      const probe = await this.acp.verifyProfileViaOfficialAcp(userId, probeDir);
      if (probe.authenticated) {
        state.status = 'succeeded';
        const nextProfile = this.db.updateAgyProfile(userId, {
          authStatus: 'authenticated',
          authMethod: 'oauth-personal',
          accountLabel: flow.accountLabel ?? profile.accountLabel ?? 'Google Antigravity (OAuth)',
          lastVerifiedAt: Date.now(),
          lastError: null,
        });
        emitProgress();
        this.hub.emitDurable({
          userId,
          type: 'agy.auth_changed',
          payload: { profile: nextProfile },
        });
      } else {
        state.status = 'failed';
        state.error = probe.error ?? '認証完了後のACP接続検証に失敗しました';
        const nextProfile = this.db.updateAgyProfile(userId, {
          authStatus: 'error',
          lastError: state.error,
        });
        emitProgress();
        this.hub.emitDurable({
          userId,
          type: 'agy.auth_changed',
          payload: { profile: nextProfile },
        });
      }
      this.flows.delete(userId);
    });

    // Wait briefly (up to 4s) for the URL to arrive synchronously for snappy REST UX
    await new Promise<void>((resolve) => {
      const startWait = Date.now();
      const check = () => {
        if (state.authUrl || state.status === 'failed' || Date.now() - startWait > 4000) {
          resolve();
        } else {
          setTimeout(check, 60);
        }
      };
      setTimeout(check, 60);
    });

    return { ...state, outputLines: [...state.outputLines] };
  }

  async submitAuthorizationCode(userId: string, code: string): Promise<AgyLoginFlowState> {
    const flow = this.flows.get(userId);
    if (!flow) {
      throw new Error('進行中のAntigravityログインセッションがありません。再度「認証リンクを発行」を押してください。');
    }
    const cleanCode = code.trim();
    if (!cleanCode) {
      throw new Error('認証コードを入力してください。');
    }

    flow.state.status = 'verifying';
    flow.state.error = null;
    flow.state.updatedAt = Date.now();

    flow.child.stdin.write(JSON.stringify({ type: 'code', code: cleanCode }) + '\n');

    // Wait briefly for PTY completion & ACP verification (typically < 1s in mock, ~2s real)
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const check = () => {
        if (!this.flows.has(userId) || Date.now() - start > 15_000) {
          resolve();
        } else {
          setTimeout(check, 80);
        }
      };
      setTimeout(check, 80);
    });

    const latest = this.flows.get(userId)?.state;
    if (latest) {
      return { ...latest, outputLines: [...latest.outputLines] };
    }

    const profile = this.db.getAgyProfile(userId)!;
    return {
      userId,
      status: profile.authStatus === 'authenticated' ? 'succeeded' : 'failed',
      authUrl: flow.state.authUrl,
      outputLines: [...flow.state.outputLines],
      error: profile.lastError,
      startedAt: flow.state.startedAt,
      updatedAt: Date.now(),
    };
  }

  async cancelLogin(userId: string): Promise<void> {
    const flow = this.flows.get(userId);
    if (!flow) return;
    flow.state.status = 'cancelled';
    try {
      flow.child.stdin.write(JSON.stringify({ type: 'cancel' }) + '\n');
    } catch {
      // ignore
    }
    try {
      flow.child.kill('SIGTERM');
    } catch {
      // ignore
    }
    this.flows.delete(userId);
    const prof = this.db.getAgyProfile(userId);
    if (prof && prof.authStatus === 'pending_login') {
      const next = this.db.updateAgyProfile(userId, { authStatus: 'unauthenticated' });
      this.hub.emitDurable({
        userId,
        type: 'agy.auth_changed',
        payload: { profile: next },
      });
    }
  }

  async configureGeminiApiKey(userId: string, apiKey: string, accountLabel?: string | null): Promise<AgyProfile> {
    const profile = this.db.getAgyProfile(userId);
    if (!profile) throw new Error('Profile not found');
    const cleanKey = apiKey.trim();
    if (!cleanKey) throw new Error('APIキーが空です');

    await this.acp.stopAllForUser(userId);
    const encrypted = encryptSmallSecret(cleanKey, this.config.sessionSecret);
    this.db.updateAgyProfile(userId, {
      authMethod: 'gemini-api-key',
      encryptedApiKey: encrypted,
      accountLabel: accountLabel?.trim() || 'Gemini API Key',
      lastError: null,
    });

    const probeDir = path.join(profile.profileDir, '.probe');
    const probe = await this.acp.verifyProfileViaOfficialAcp(userId, probeDir);
    if (!probe.authenticated) {
      const reverted = this.db.updateAgyProfile(userId, {
        authStatus: 'error',
        encryptedApiKey: null,
        lastError: probe.error ?? 'APIキーでのACP接続検証に失敗しました',
      });
      throw new Error(reverted.lastError ?? 'ACP verification failed');
    }

    const updated = this.db.updateAgyProfile(userId, {
      authStatus: 'authenticated',
      authMethod: 'gemini-api-key',
      lastVerifiedAt: Date.now(),
      lastError: null,
    });
    this.hub.emitDurable({
      userId,
      type: 'agy.auth_changed',
      payload: { profile: updated },
    });
    return updated;
  }

  async disconnectAgyProfile(userId: string): Promise<AgyProfile> {
    await this.cancelLogin(userId);
    await this.acp.stopAllForUser(userId);

    const profile = this.db.getAgyProfile(userId);
    if (!profile) throw new Error('Profile not found');

    const probeDir = path.join(profile.profileDir, '.probe');
    // Best-effort official ACP logout then official CLI `auth logout`
    await this.acp.attemptOfficialLogoutViaAcp(userId, probeDir).catch(() => {});

    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: ['auth', 'logout'],
      profileDir: profile.profileDir,
      workspaceDir: probeDir,
      enableSandboxBwrap: false,
    });
    await execFileAsync(spec.command, spec.args, {
      cwd: profile.profileDir,
      env: spec.env,
      timeout: 10_000,
    }).catch(() => {});

    const updated = this.db.updateAgyProfile(userId, {
      authStatus: 'unauthenticated',
      authMethod: null,
      accountLabel: null,
      encryptedApiKey: null,
      lastVerifiedAt: null,
      lastError: null,
    });
    this.hub.emitDurable({
      userId,
      type: 'agy.auth_changed',
      payload: { profile: updated },
    });
    return updated;
  }
}
