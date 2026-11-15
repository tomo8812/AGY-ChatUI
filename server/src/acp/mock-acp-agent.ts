/**
 * ACP-compliant mock agent powered strictly by official @agentclientprotocol/sdk (`agent()`).
 * Used ONLY when `AGY_MODE=mock` for integration tests & offline UI verification.
 * Simulates unmodified `agy`:
 *   - `--login`: outputs unbroken Google OAuth URL in terminal and reads pasted code from stdin
 *   - `auth logout`: clears its own internal `$HOME/.mock-agy-auth.json`
 *   - `-p /usage --output-format json`: emits per-profile JSON usage info
 *   - `acp`: runs stdio JSON-RPC ACP agent enforcing auth via `-32000`, configOptions, streaming chunks,
 *            tool calls, `session/request_permission`, `session/cancel`, and file creation inside `cwd`.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';

const args = process.argv.slice(2);
const homeDir = process.env.HOME || process.cwd();
const authMarkerFile = path.join(homeDir, '.mock-agy-auth.json');

function readMockAuth(): { authenticated: boolean; label: string; method: string } | null {
  if (process.env.GEMINI_API_KEY) {
    return { authenticated: true, label: 'api-key-user', method: 'gemini-api-key' };
  }
  if (!fs.existsSync(authMarkerFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(authMarkerFile, 'utf8'));
  } catch {
    return null;
  }
}

async function runCliLogin(): Promise<number> {
  const stateToken = Buffer.from(homeDir).toString('base64url').slice(0, 12);
  process.stdout.write(
    `\nPlease visit the following URL to authorize Antigravity:\n` +
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=antigravity-cli-mock&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid+email&state=${stateToken}\n\n` +
      `Enter the authorization code: `
  );

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const code = await new Promise<string>((resolve) => {
    rl.once('line', (line) => {
      rl.close();
      resolve(line.trim());
    });
  });

  if (!code || code.toLowerCase() === 'invalid') {
    process.stderr.write('\nAuthorization failed: invalid code.\n');
    return 1;
  }

  fs.mkdirSync(homeDir, { recursive: true });
  const label = code.startsWith('user:') ? code.slice(5) : `mock-account-${stateToken}`;
  fs.writeFileSync(
    authMarkerFile,
    JSON.stringify({ authenticated: true, label, method: 'oauth-personal', codeSuffix: code.slice(-4) }),
    'utf8'
  );
  process.stdout.write(`\nSuccessfully authenticated as ${label}.\n`);
  return 0;
}

function runCliLogout(): number {
  if (fs.existsSync(authMarkerFile)) {
    fs.unlinkSync(authMarkerFile);
  }
  process.stdout.write('Logged out of Antigravity CLI.\n');
  return 0;
}

function runCliUsage(): number {
  const auth = readMockAuth();
  if (!auth) {
    process.stderr.write('Authentication required.\n');
    return 1;
  }
  const suffix = auth.label.includes('b') ? 42 : 84;
  const payload = {
    account: auth.label,
    buckets: [
      {
        model: 'gemini-2.5-pro',
        remainingPercent: suffix,
        usedPercent: 100 - suffix,
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
        status: 'ok',
      },
      {
        model: 'gemini-2.5-flash',
        remainingPercent: 95,
        usedPercent: 5,
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
        status: 'ok',
      },
    ],
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
  return 0;
}

interface SessionState {
  id: string;
  cwd: string;
  modelId: string;
  effortValue: string;
  systemPromptText: string | null;
  history: string[];
  cancelled: boolean;
}

function buildConfigOptions(modelId: string, effortValue: string): SessionConfigOption[] {
  const isFlash = modelId === 'gemini-2.5-flash';
  const effortOptions = isFlash
    ? [
        { value: 'low', name: 'Low', description: '高速応答' },
        { value: 'medium', name: 'Medium', description: '標準バランス' },
      ]
    : [
        { value: 'low', name: 'Low', description: '軽量推論' },
        { value: 'medium', name: 'Medium', description: '標準推論' },
        { value: 'high', name: 'High', description: '深い推論' },
      ];
  const validEffort = effortOptions.some((o) => o.value === effortValue) ? effortValue : effortOptions[0].value;

  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modelId,
      options: [
        { value: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: '高度な推論・分析・構成向け' },
        { value: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: '高速レスポンス向け' },
        { value: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', description: '最新プレビューモデル' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: validEffort,
      options: effortOptions,
    },
  ];
}

function runAcpServer(): void {
  const sessions = new Map<string, SessionState>();
  let seqCounter = 0;

  const requireAuthenticated = () => {
    const auth = readMockAuth();
    if (!auth && process.env.MOCK_ALLOW_UNAUTH !== '1') {
      throw new RequestError(-32000, 'Authentication required: run agy acp --login');
    }
    return auth;
  };

  const app = agent({ name: 'mock-agy-acp' })
    .onRequest(methods.agent.initialize, async ({ params }) => {
      return {
        protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: true,
            audio: false,
            embeddedContext: true,
          },
          sessionCapabilities: {
            list: {},
            resume: {},
            close: {},
            systemPrompt: {
              mode: { override: {} },
            },
          },
          auth: { logout: {} },
        },
        authMethods: [
          { id: 'oauth-personal', name: 'Login with Google', description: 'Google OAuth authorization code' },
          { id: 'gemini-api-key', name: 'Gemini API Key', description: 'Use GEMINI_API_KEY env' },
        ],
        agentInfo: {
          name: 'mock-agy-acp',
          title: 'Mock Antigravity ACP',
          version: '1.5.9-mock',
        },
      };
    })
    .onRequest(methods.agent.logout, async () => {
      if (fs.existsSync(authMarkerFile)) fs.unlinkSync(authMarkerFile);
      return {};
    })
    .onRequest(methods.agent.session.new, async ({ params }) => {
      requireAuthenticated();
      seqCounter += 1;
      const id = `mock-sess-${seqCounter}-${Date.now()}`;
      const sysText =
        params.systemPrompt?.content
          ?.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n') ?? null;

      const state: SessionState = {
        id,
        cwd: params.cwd,
        modelId: 'gemini-2.5-pro',
        effortValue: 'medium',
        systemPromptText: sysText,
        history: [],
        cancelled: false,
      };
      sessions.set(id, state);
      return {
        sessionId: id,
        configOptions: buildConfigOptions(state.modelId, state.effortValue),
      };
    })
    .onRequest(methods.agent.session.load, async ({ params }) => {
      requireAuthenticated();
      let state = sessions.get(params.sessionId);
      if (!state) {
        // Persist across simulated ACP restarts if sessionId starts with mock-sess-
        if (!params.sessionId.startsWith('mock-sess-')) {
          throw new RequestError(-32002, 'Session not found');
        }
        state = {
          id: params.sessionId,
          cwd: params.cwd,
          modelId: 'gemini-2.5-pro',
          effortValue: 'medium',
          systemPromptText: null,
          history: [],
          cancelled: false,
        };
        sessions.set(params.sessionId, state);
      }
      return {
        configOptions: buildConfigOptions(state.modelId, state.effortValue),
      };
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      requireAuthenticated();
      let state = sessions.get(params.sessionId);
      if (!state) {
        if (!params.sessionId.startsWith('mock-sess-')) {
          throw new RequestError(-32002, 'Session not found');
        }
        state = {
          id: params.sessionId,
          cwd: params.cwd,
          modelId: 'gemini-2.5-pro',
          effortValue: 'medium',
          systemPromptText: null,
          history: [],
          cancelled: false,
        };
        sessions.set(params.sessionId, state);
      }
      return {
        configOptions: buildConfigOptions(state.modelId, state.effortValue),
      };
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params, client }) => {
      requireAuthenticated();
      const state = sessions.get(params.sessionId);
      if (!state) throw new RequestError(-32002, 'Session not found');
      if (params.configId === 'model' && typeof params.value === 'string') {
        state.modelId = params.value;
      } else if (params.configId === 'reasoning_effort' && typeof params.value === 'string') {
        state.effortValue = params.value;
      }
      const configOptions = buildConfigOptions(state.modelId, state.effortValue);
      const effortOpt = configOptions.find((c) => c.id === 'reasoning_effort');
      if (effortOpt && effortOpt.type === 'select') {
        state.effortValue = effortOpt.currentValue;
      }
      await client.notify(methods.client.session.update, {
        sessionId: state.id,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions,
        },
      });
      return { configOptions };
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      sessions.delete(params.sessionId);
      return {};
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const state = sessions.get(params.sessionId);
      if (state) state.cancelled = true;
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const auth = requireAuthenticated();
      const state = sessions.get(ctx.params.sessionId);
      if (!state) throw new RequestError(-32002, 'Session not found');
      state.cancelled = false;

      const textParts: string[] = [];
      for (const block of ctx.params.prompt) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'resource_link') textParts.push(`[添付: ${block.name}]`);
        else if (block.type === 'image') textParts.push(`[画像: ${block.mimeType}]`);
      }
      const promptText = textParts.join('\n').trim();
      state.history.push(promptText);

      const sendUpdate = async (update: Parameters<AgentContext['notify']>[1]) => {
        await ctx.client.notify(methods.client.session.update, update as never);
      };

      // Emit thought chunk
      await sendUpdate({
        sessionId: state.id,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: `モデル ${state.modelId} (effort=${state.effortValue}) でリクエストを確認しています...\n` },
        },
      });

      // Sleep support for concurrency / cancellation tests
      const sleepMatch = /\[SLEEP_MS:(\d+)\]/.exec(promptText);
      if (sleepMatch) {
        const total = Math.min(Number(sleepMatch[1]), 15_000);
        const step = 40;
        for (let elapsed = 0; elapsed < total; elapsed += step) {
          if (state.cancelled) {
            return { stopReason: 'cancelled' as const };
          }
          await delay(step);
        }
      }

      if (state.cancelled) {
        return { stopReason: 'cancelled' as const };
      }

      // Tool call & interactive permission check
      if (promptText.includes('[PERMISSION]')) {
        const toolCallId = `tc-${Date.now()}`;
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'ワークスペースへレポートファイル created-by-tool.md を作成',
            kind: 'edit',
            status: 'pending',
            locations: [{ path: path.join(state.cwd, 'created-by-tool.md') }],
          },
        });

        const permRes = await ctx.client.request(methods.client.session.requestPermission, {
          sessionId: state.id,
          toolCall: {
            toolCallId,
            title: 'ファイル created-by-tool.md への書き込み許可',
            kind: 'edit',
            status: 'pending',
            locations: [{ path: path.join(state.cwd, 'created-by-tool.md') }],
          },
          options: [
            { optionId: 'allow_once', name: '今回のみ許可', kind: 'allow_once' },
            { optionId: 'reject_once', name: '拒否', kind: 'reject_once' },
          ],
        });

        if (state.cancelled || permRes.outcome.outcome === 'cancelled') {
          await sendUpdate({
            sessionId: state.id,
            update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' },
          });
          return { stopReason: state.cancelled ? ('cancelled' as const) : ('refusal' as const) };
        }

        if (permRes.outcome.outcome === 'selected' && permRes.outcome.optionId.startsWith('allow')) {
          const targetPath = path.join(state.cwd, 'created-by-tool.md');
          await ctx.client.request(methods.client.fs.writeTextFile, {
            sessionId: state.id,
            path: targetPath,
            content: `# Created with user permission\n\nAccount: ${auth?.label ?? 'anon'}\nModel: ${state.modelId}\n`,
          });
          await sendUpdate({
            sessionId: state.id,
            update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { wrote: 'created-by-tool.md' } },
          });
        } else {
          await sendUpdate({
            sessionId: state.id,
            update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: { rejected: true } },
          });
          await sendUpdate({
            sessionId: state.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '操作が拒否されたため、ファイルは作成しませんでした。' },
            },
          });
          return { stopReason: 'end_turn' as const };
        }
      }

      // Generate sample artifacts inside workspace if requested
      if (promptText.includes('[ARTIFACT]')) {
        fs.writeFileSync(
          path.join(state.cwd, 'summary.md'),
          `# Summary Report\n\nGenerated by ${auth?.label ?? 'mock'} using \`${state.modelId}\`.\n`,
          'utf8'
        );
        fs.writeFileSync(
          path.join(state.cwd, 'metrics.csv'),
          'metric,value,unit\nlatency_ms,42,ms\nworkers,2,procs\n',
          'utf8'
        );
        fs.writeFileSync(
          path.join(state.cwd, 'widget.html'),
          '<!doctype html><html><body><h1>Isolated Preview</h1><script>document.body.dataset.rendered="ok";</script></body></html>',
          'utf8'
        );
      }

      // Inspect project context files cleanly if [CONTEXT_CHECK] is requested
      let contextNotes = '';
      if (promptText.includes('[CONTEXT_CHECK]')) {
        const ctxDir = path.join(state.cwd, '.project-context');
        const files = fs.existsSync(ctxDir) ? fs.readdirSync(ctxDir) : [];
        const samples = files.map((f) => `${f}: ${fs.readFileSync(path.join(ctxDir, f), 'utf8').trim()}`);
        contextNotes = `\n\n### プロジェクト共有参照確認\n- Instructions: ${state.systemPromptText ?? '(none)'}\n- Shared files:\n${samples.map((s) => `  - ${s}`).join('\n')}`;
      }

      const reply = [
        `[${auth?.label ?? 'mock'} | ${state.modelId}/${state.effortValue}] 受信メッセージ: "${promptText}"`,
        promptText.includes('[ARTIFACT]')
          ? '\n生成物を作成しました: [summary.md](summary.md), [metrics.csv](metrics.csv), [widget.html](widget.html)'
          : '',
        promptText.includes('[PERMISSION]')
          ? '\n許可されたファイル [created-by-tool.md](created-by-tool.md) を作成しました。'
          : '',
        contextNotes,
        '\n\n```ts\nexport const status = "ok";\n```',
      ].join('');

      // Stream in chunks to test real-time streaming & mid-stream join
      const chunkSize = 18;
      for (let i = 0; i < reply.length; i += chunkSize) {
        if (state.cancelled) return { stopReason: 'cancelled' as const };
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: reply.slice(i, i + chunkSize) },
          },
        });
        await delay(15);
      }

      await sendUpdate({
        sessionId: state.id,
        update: {
          sessionUpdate: 'usage_update',
          used: 1200 + state.history.length * 100,
          size: 1_000_000,
        },
      });

      return { stopReason: 'end_turn' as const };
    });

  const stdinWeb = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const stdoutWeb = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  app.connect(ndJsonStream(stdoutWeb, stdinWeb));
}

if (args.includes('--login')) {
  runCliLogin().then((code) => process.exit(code));
} else if (args[0] === 'auth' && args[1] === 'logout') {
  process.exit(runCliLogout());
} else if (args.includes('/usage')) {
  process.exit(runCliUsage());
} else {
  runAcpServer();
}
