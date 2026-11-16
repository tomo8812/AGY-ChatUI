import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDelimitedUsageLines, parseUsageOutput } from '../src/acp/quota-service.js';
import { createTestServer, registerAndBindAgy, TestApiClient } from './helpers/test-harness.js';

describe('Quota TSV Parsing, Pre-Chat Model/Effort Options, Cooldown Refresh, and Update Build IDs', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it('parses 4-column TSV /usage output (both raw and JSON-wrapped) accurately', () => {
    const tsv = [
      'Gemini Models\tWeekly Limit Remaining\t74%\t2026-11-21T18:09:35Z',
      'Gemini Models\tFive Hour Limit Remaining\t86%\t2026-11-16T03:06:41Z',
      'Claude and GPT models\tWeekly Limit Remaining\t81%\t2026-11-22T01:33:17Z',
      'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-16T05:50:16Z',
      'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-23T00:50:16Z',
    ].join('\n');

    for (const rawInput of [tsv, JSON.stringify({ response: tsv })]) {
      const parsed = parseUsageOutput(rawInput);
      expect(parsed.buckets).toHaveLength(5);

      expect(parsed.buckets[0]).toMatchObject({
        group: 'Gemini Models',
        windowLabel: 'Weekly Limit Remaining',
        remainingPercent: 74,
        usedPercent: 26,
        remainingLabel: '74%',
        resetAt: '2026-11-21T18:09:35Z',
        status: 'ok',
      });
      expect(parsed.buckets[1]).toMatchObject({
        group: 'Gemini Models',
        windowLabel: 'Five Hour Limit Remaining',
        remainingPercent: 86,
        usedPercent: 14,
        resetAt: '2026-11-16T03:06:41Z',
        status: 'ok',
      });
      expect(parsed.buckets[2]).toMatchObject({
        group: 'Claude and GPT models',
        windowLabel: 'Weekly Limit Remaining',
        remainingPercent: 81,
        usedPercent: 19,
        resetAt: '2026-11-22T01:33:17Z',
        status: 'ok',
      });
      expect(parsed.buckets[3]).toMatchObject({
        group: 'Claude and GPT models',
        windowLabel: 'Five Hour Limit Remaining',
        remainingPercent: 100,
        usedPercent: 0,
        resetAt: '2026-11-16T05:50:16Z',
        status: 'ok',
      });
      expect(parsed.buckets[4]).toMatchObject({
        group: 'Gemini 4 Argon',
        windowLabel: 'Gemini 4 Argon Weekly Limit',
        remainingPercent: 100,
        usedPercent: 0,
        resetAt: '2026-11-23T00:50:16Z',
        status: 'ok',
      });
    }

    const withAnsiAndZero = parseDelimitedUsageLines(
      '\x1B[32mGemini Models\tFive Hour Limit Remaining\t0%\t2026-11-16T03:06:41Z\x1B[0m'
    );
    expect(withAnsiAndZero).toHaveLength(1);
    expect(withAnsiAndZero[0].status).toBe('limited');
    expect(withAnsiAndZero[0].remainingPercent).toBe(0);
  });

  it('probes dynamic model & effort options pre-chat and applies selected options to new chats', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    // Reject before Agy account binding
    const unauthClient = new TestApiClient(srv.baseUrl);
    await unauthClient.request('POST', '/api/auth/register', {
      username: 'novice',
      password: 'password123',
    });
    const denied = await unauthClient.request<{ error: string }>('GET', '/api/agy/options');
    expect(denied.status).toBe(403);
    expect(denied.data.error).toBe('AGY_AUTH_REQUIRED');

    const { client } = await registerAndBindAgy(srv.baseUrl, 'prouser', 'user:prouser@gmail.com');

    // Default model (gemini-2.5-pro) exposes low/medium/high effort steps
    const defaultOpts = await client.request<{
      sessionOptions: {
        currentModelId: string;
        currentEffortValue: string;
        configOptions: Array<{ id: string; options: Array<{ value: string }> }>;
      };
    }>('GET', '/api/agy/options');
    expect(defaultOpts.status).toBe(200);
    expect(defaultOpts.data.sessionOptions.currentModelId).toBe('gemini-2.5-pro');
    const proEffort = defaultOpts.data.sessionOptions.configOptions.find((o) => o.id === 'reasoning_effort');
    expect(proEffort?.options.map((o) => o.value)).toEqual(['low', 'medium', 'high']);

    // Selecting gemini-2.5-flash dynamically narrows effort options to ['low', 'medium']
    const flashOpts = await client.request<{
      sessionOptions: {
        currentModelId: string;
        configOptions: Array<{ id: string; options: Array<{ value: string }> }>;
      };
    }>('GET', '/api/agy/options?modelId=gemini-2.5-flash');
    expect(flashOpts.status).toBe(200);
    expect(flashOpts.data.sessionOptions.currentModelId).toBe('gemini-2.5-flash');
    const flashEffort = flashOpts.data.sessionOptions.configOptions.find((o) => o.id === 'reasoning_effort');
    expect(flashEffort?.options.map((o) => o.value)).toEqual(['low', 'medium']);

    // Creating a chat with chosen model & effort persists and configures the ACP session
    const created = await client.request<{
      chat: { id: string; modelId: string; effortValue: string };
      sessionOptions: { currentModelId: string; currentEffortValue: string };
    }>('POST', '/api/chats', {
      modelId: 'gemini-2.5-flash',
      effortValue: 'medium',
    });
    expect(created.status).toBe(201);
    expect(created.data.chat.modelId).toBe('gemini-2.5-flash');
    expect(created.data.chat.effortValue).toBe('medium');
    expect(created.data.sessionOptions.currentModelId).toBe('gemini-2.5-flash');
    expect(created.data.sessionOptions.currentEffortValue).toBe('medium');
  });

  it('enforces cooldown for auto quota refresh while allowing explicit manual refreshes', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client } = await registerAndBindAgy(srv.baseUrl, 'quotauser', 'user:quota@gmail.com');

    const first = await client.request<{ quota: { status: string; fetchedAt: number } }>(
      'POST',
      '/api/quota/refresh',
      { auto: true }
    );
    expect(first.status).toBe(200);
    expect(first.data.quota.status).toBe('ok');
    const ts1 = first.data.quota.fetchedAt;
    expect(ts1).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 20));

    // Rapid second auto refresh returns cached snapshot within cooldown
    const secondAuto = await client.request<{ quota: { fetchedAt: number } }>(
      'POST',
      '/api/quota/refresh',
      { auto: true }
    );
    expect(secondAuto.status).toBe(200);
    expect(secondAuto.data.quota.fetchedAt).toBe(ts1);

    await new Promise((r) => setTimeout(r, 20));

    // Explicit manual refresh bypasses cooldown and refreshes timestamp
    const manual = await client.request<{ quota: { fetchedAt: number } }>(
      'POST',
      '/api/quota/refresh',
      { auto: false }
    );
    expect(manual.status).toBe(200);
    expect(manual.data.quota.fetchedAt).toBeGreaterThan(ts1);
  });

  it('exposes consistent buildId on health, bootstrap, and WS hello for update detection', async () => {
    const prevBuildId = process.env.AGY_BUILD_ID;
    process.env.AGY_BUILD_ID = 'build-test-v42';
    try {
      const srv = await createTestServer();
      cleanups.push(srv.cleanup);

      const { client } = await registerAndBindAgy(srv.baseUrl, 'upduser', 'user:upd@gmail.com');

      const health = await client.request<{ ok: boolean; buildId: string }>('GET', '/api/health');
      expect(health.status).toBe(200);
      expect(health.data.ok).toBe(true);
      expect(health.data.buildId).toBe('build-test-v42');

      const boot = await client.request<{ buildId: string; authenticated: boolean }>(
        'GET',
        '/api/auth/bootstrap'
      );
      expect(boot.status).toBe(200);
      expect(boot.data.buildId).toBe('build-test-v42');

      const hello = await client.connectWs({ clientId: 'upd-tab' });
      expect(hello.buildId).toBe('build-test-v42');
      client.closeWs();

      if (fs.existsSync(srv.ctx.config.webDistDir)) {
        const indexRes = await fetch(`${srv.baseUrl}/`);
        expect(indexRes.status).toBe(200);
        expect(indexRes.headers.get('cache-control')).toContain('no-store');

        const swRes = await fetch(`${srv.baseUrl}/sw.js`);
        expect(swRes.status).toBe(200);
        expect(swRes.headers.get('cache-control')).toContain('no-store');
      }
    } finally {
      if (prevBuildId === undefined) delete process.env.AGY_BUILD_ID;
      else process.env.AGY_BUILD_ID = prevBuildId;
    }
  });
});
