import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

interface VersionScriptApi {
  parseSemver: (input: string) => { major: number; minor: number; patch: number; version: string; tag: string } | null;
  compareSemver: (a: unknown, b: unknown) => number;
  bumpSemver: (base: unknown, bump: 'major' | 'minor' | 'patch' | 'none') => { version: string; tag: string };
  classifyCommit: (subject: string, body?: string) => 'major' | 'minor' | 'patch';
  classifyCommits: (commits: Array<{ sha: string; subject: string; body?: string }>) => string;
  resolveReleaseVersion: (params: Record<string, unknown>) => {
    version: string;
    baseVersion: string;
    tag: string;
    releaseTag: string;
    prevTag: string;
    bump: string;
    alreadyTagged: boolean;
  };
  resolveFromGitRepo: (cwd: string, opts?: Record<string, unknown>) => {
    version: string;
    tag: string;
    releaseTag: string;
    prevTag: string;
    bump: string;
    alreadyTagged: boolean;
    shortSha: string;
  };
  stampServiceWorker: (swPath: string, version: string, shortSha?: string) => { cacheName: string };
  stampManifests: (stageDir: string, version: string) => string[];
  writeBuildInfo: (opts: {
    outPath: string;
    version: string;
    tag: string;
    commitSha: string;
    files?: string[];
  }) => { version: string; tag: string; commitSha: string; shortSha: string; buildId: string; builtAt: string };
}

async function loadVersionScript(): Promise<VersionScriptApi> {
  const scriptPath = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'version.mjs');
  return (await import(pathToFileURL(scriptPath).href)) as VersionScriptApi;
}

describe('Automatic SemVer Versioning, Build Stamping, and Runtime Version Exposure', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it('classifies Conventional Commits and resolves SemVer bumps accurately across edge cases', async () => {
    const v = await loadVersionScript();

    expect(v.classifyCommit('fix: handle empty chat')).toBe('patch');
    expect(v.classifyCommit('ui: adjust padding')).toBe('patch');
    expect(v.classifyCommit('Update readme without prefix')).toBe('patch');
    expect(v.classifyCommit('feat: add versioning')).toBe('minor');
    expect(v.classifyCommit('feat(ci): add auto tagging')).toBe('minor');
    expect(v.classifyCommit('feat!: drop legacy endpoint')).toBe('major');
    expect(v.classifyCommit('fix(auth): rotate cookie', 'BREAKING CHANGE: old tokens invalidated')).toBe('major');

    // Initial repo without tags: feat after package.json -> 1.1.0
    const initialFeat = v.resolveReleaseVersion({
      pkgVersion: '1.0.0',
      commitsSincePkgChange: [{ sha: 'aaa', subject: 'feat: initial release pipeline' }],
      commitSha: '1234567890abcdef',
    });
    expect(initialFeat).toMatchObject({
      version: '1.1.0',
      tag: 'v1.1.0',
      releaseTag: 'v1.1.0',
      prevTag: '',
      bump: 'minor',
      alreadyTagged: false,
    });

    // package.json explicitly created/bumped at HEAD without prior tags -> keep exact version
    const exactPkgAtHead = v.resolveReleaseVersion({
      pkgVersion: '1.0.0',
      pkgChangedAtHead: true,
    });
    expect(exactPkgAtHead).toMatchObject({ version: '1.0.0', tag: 'v1.0.0', bump: 'manual' });

    // Existing v1.1.0 tag followed by fix -> v1.1.1
    const patchAfterTag = v.resolveReleaseVersion({
      pkgVersion: '1.0.0',
      mergedTags: ['v1.0.0', 'v1.1.0'],
      allRepoTags: ['v1.0.0', 'v1.1.0'],
      commitsSincePrevTag: [{ sha: 'bbb', subject: 'fix(ui): align button' }],
    });
    expect(patchAfterTag).toMatchObject({
      version: '1.1.1',
      tag: 'v1.1.1',
      prevTag: 'v1.1.0',
      bump: 'patch',
      alreadyTagged: false,
    });

    // Existing v1.1.1 followed by breaking change -> v2.0.0
    const majorAfterTag = v.resolveReleaseVersion({
      pkgVersion: '1.0.0',
      mergedTags: ['v1.1.1'],
      allRepoTags: ['v1.1.1'],
      commitsSincePrevTag: [
        { sha: 'ccc', subject: 'fix: minor tweak' },
        { sha: 'ddd', subject: 'feat!: new session protocol' },
      ],
    });
    expect(majorAfterTag).toMatchObject({ version: '2.0.0', tag: 'v2.0.0', bump: 'major' });

    // Manual package.json bump higher than latest tag -> respects manual version
    const manualPkgBump = v.resolveReleaseVersion({
      pkgVersion: '1.5.0',
      mergedTags: ['v1.2.0'],
      allRepoTags: ['v1.2.0'],
      commitsSincePrevTag: [{ sha: 'eee', subject: 'chore: release 1.5.0' }],
    });
    expect(manualPkgBump).toMatchObject({ version: '1.5.0', tag: 'v1.5.0', bump: 'manual' });

    // Idempotent re-run on already tagged HEAD
    const idempotent = v.resolveReleaseVersion({
      pkgVersion: '1.0.0',
      headTags: ['v1.2.0'],
      mergedTags: ['v1.1.0', 'v1.2.0'],
      allRepoTags: ['v1.1.0', 'v1.2.0'],
    });
    expect(idempotent).toMatchObject({
      version: '1.2.0',
      tag: 'v1.2.0',
      prevTag: 'v1.1.0',
      alreadyTagged: true,
      bump: 'existing',
    });

    // Collision avoidance when another branch already created v1.1.1
    const collisionSafe = v.resolveReleaseVersion({
      pkgVersion: '1.0.0',
      mergedTags: ['v1.1.0'],
      allRepoTags: ['v1.1.0', 'v1.1.1'],
      commitsSincePrevTag: [{ sha: 'fff', subject: 'fix: hotfix' }],
    });
    expect(collisionSafe).toMatchObject({ version: '1.1.2', tag: 'v1.1.2' });

    // PR preview formatting
    const prPreview = v.resolveReleaseVersion({
      pkgVersion: '1.0.0',
      mergedTags: ['v1.1.0'],
      allRepoTags: ['v1.1.0'],
      commitsSincePrevTag: [{ sha: '111', subject: 'feat: preview feature' }],
      prNumber: 27,
    });
    expect(prPreview).toMatchObject({
      version: '1.2.0-pr.27',
      tag: 'pr-27',
      releaseTag: 'v1.2.0',
    });

    expect(() =>
      v.resolveReleaseVersion({ pkgVersion: '1.0.0', overrideVersion: 'not-a-semver' })
    ).toThrow(/Invalid explicit SemVer/);
  });

  it('resolves SemVer progression cleanly in a real git repository ignoring non-SemVer "latest" tag', async () => {
    const v = await loadVersionScript();
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ver-git-'));
    cleanups.push(async () => {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    });

    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: tmpRepo, encoding: 'utf8' }).trim();

    git('init');
    git('config', 'user.name', 'Test Bot');
    git('config', 'user.email', 'test@example.com');

    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));
    git('add', 'package.json');
    git('commit', '-m', 'feat: initial commit');

    // Moving rolling tag "latest" must NOT interfere with SemVer calculation
    git('tag', '-f', 'latest');
    expect(v.resolveFromGitRepo(tmpRepo)).toMatchObject({ version: '1.0.0', tag: 'v1.0.0' });

    // Add a feature commit -> bumps 1.0.0 -> 1.1.0
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'hello\n');
    git('add', 'README.md');
    git('commit', '-m', 'feat: add readme');
    git('tag', '-f', 'latest');

    const firstRelease = v.resolveFromGitRepo(tmpRepo);
    expect(firstRelease).toMatchObject({
      version: '1.1.0',
      tag: 'v1.1.0',
      bump: 'minor',
      alreadyTagged: false,
    });

    // Tag v1.1.0 -> re-running on same commit is idempotent
    git('tag', '-a', 'v1.1.0', '-m', 'Release v1.1.0');
    expect(v.resolveFromGitRepo(tmpRepo)).toMatchObject({
      version: '1.1.0',
      tag: 'v1.1.0',
      alreadyTagged: true,
      bump: 'existing',
    });

    // Next fix commit -> bumps v1.1.0 -> v1.1.1
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'hello v2\n');
    git('add', 'README.md');
    git('commit', '-m', 'fix: typo in readme');
    git('tag', '-f', 'latest');

    expect(v.resolveFromGitRepo(tmpRepo)).toMatchObject({
      version: '1.1.1',
      tag: 'v1.1.1',
      prevTag: 'v1.1.0',
      bump: 'patch',
      alreadyTagged: false,
    });
  });

  it('stamps Service Worker cache name, bundle manifests, and BUILD_INFO.json cleanly', async () => {
    const v = await loadVersionScript();
    const tmpStage = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ver-stamp-'));
    cleanups.push(async () => {
      fs.rmSync(tmpStage, { recursive: true, force: true });
    });

    fs.mkdirSync(path.join(tmpStage, 'server'), { recursive: true });
    fs.mkdirSync(path.join(tmpStage, 'web', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmpStage, 'package.json'), JSON.stringify({ name: 'root', version: '1.0.0' }));
    fs.writeFileSync(path.join(tmpStage, 'server', 'package.json'), JSON.stringify({ name: 'srv', version: '1.0.0' }));
    fs.writeFileSync(path.join(tmpStage, 'web', 'package.json'), JSON.stringify({ name: 'web', version: '1.0.0' }));

    const swPath = path.join(tmpStage, 'web', 'dist', 'sw.js');
    fs.writeFileSync(swPath, "const CACHE_NAME = 'antigravity-chat-shell-v4';\nconsole.log('sw');\n");
    const htmlPath = path.join(tmpStage, 'web', 'dist', 'index.html');
    fs.writeFileSync(htmlPath, '<!doctype html><html></html>\n');

    const stamped = v.stampServiceWorker(swPath, '1.2.3', 'deadbeef');
    expect(stamped.cacheName).toBe('antigravity-chat-shell-v1.2.3-deadbeef');
    const swContent = fs.readFileSync(swPath, 'utf8');
    expect(swContent).toContain('// Build: v1.2.3 (deadbeef)');
    expect(swContent).toContain("const CACHE_NAME = 'antigravity-chat-shell-v1.2.3-deadbeef';");

    const updatedManifests = v.stampManifests(tmpStage, '1.2.3');
    expect(updatedManifests).toHaveLength(3);
    for (const mf of updatedManifests) {
      const parsed = JSON.parse(fs.readFileSync(mf, 'utf8')) as { version: string };
      expect(parsed.version).toBe('1.2.3');
    }

    const buildInfoOut = path.join(tmpStage, 'BUILD_INFO.json');
    const info = v.writeBuildInfo({
      outPath: buildInfoOut,
      version: '1.2.3',
      tag: 'v1.2.3',
      commitSha: 'deadbeef1234567890',
      files: [htmlPath, swPath],
    });
    expect(info.version).toBe('1.2.3');
    expect(info.tag).toBe('v1.2.3');
    expect(info.shortSha).toBe('deadbeef');
    expect(info.buildId).toHaveLength(16);
    expect(fs.existsSync(buildInfoOut)).toBe(true);
  });

  it('exposes BUILD_INFO.json version across /api/health, /api/auth/bootstrap, WS hello, and ACP clientInfo', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ver-runtime-'));
    const buildInfoPath = path.join(tmpDir, 'BUILD_INFO.json');
    const clientInfoCapturePath = path.join(tmpDir, 'acp-client-info.json');

    fs.writeFileSync(
      buildInfoPath,
      JSON.stringify({
        version: '2.4.1',
        tag: 'v2.4.1',
        commitSha: 'cafe1234deadbeef5678',
        shortSha: 'cafe1234',
        buildId: 'testbuild99',
        builtAt: '2026-11-16T06:00:00Z',
      })
    );

    const prevBuildInfoEnv = process.env.AGY_BUILD_INFO_PATH;
    const prevBuildIdEnv = process.env.AGY_BUILD_ID;
    const prevClientCapture = process.env.MOCK_CLIENT_INFO_PATH;

    process.env.AGY_BUILD_INFO_PATH = buildInfoPath;
    process.env.AGY_BUILD_ID = 'build-v241-test';
    process.env.MOCK_CLIENT_INFO_PATH = clientInfoCapturePath;

    cleanups.push(async () => {
      if (prevBuildInfoEnv === undefined) delete process.env.AGY_BUILD_INFO_PATH;
      else process.env.AGY_BUILD_INFO_PATH = prevBuildInfoEnv;
      if (prevBuildIdEnv === undefined) delete process.env.AGY_BUILD_ID;
      else process.env.AGY_BUILD_ID = prevBuildIdEnv;
      if (prevClientCapture === undefined) delete process.env.MOCK_CLIENT_INFO_PATH;
      else process.env.MOCK_CLIENT_INFO_PATH = prevClientCapture;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client } = await registerAndBindAgy(srv.baseUrl, 'veruser', 'user:ver@gmail.com');

    const health = await client.request<{
      ok: boolean;
      version: string;
      tag: string;
      shortSha: string;
      builtAt: string;
      buildId: string;
    }>('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.data).toMatchObject({
      ok: true,
      version: '2.4.1',
      tag: 'v2.4.1',
      shortSha: 'cafe1234',
      builtAt: '2026-11-16T06:00:00Z',
      buildId: 'build-v241-test',
    });

    const boot = await client.request<{
      version: string;
      shortSha: string;
      builtAt: string;
      buildId: string;
    }>('GET', '/api/auth/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.data).toMatchObject({
      version: '2.4.1',
      shortSha: 'cafe1234',
      builtAt: '2026-11-16T06:00:00Z',
      buildId: 'build-v241-test',
    });

    const hello = await client.connectWs({ clientId: 'ver-tab' });
    expect(hello.version).toBe('2.4.1');
    expect(hello.buildId).toBe('build-v241-test');
    client.closeWs();

    // Verify ACP initialize sent the resolved app version in clientInfo
    expect(fs.existsSync(clientInfoCapturePath)).toBe(true);
    const capturedClientInfo = JSON.parse(fs.readFileSync(clientInfoCapturePath, 'utf8')) as {
      name: string;
      version: string;
    };
    expect(capturedClientInfo.name).toBe('antigravity-chat-ui');
    expect(capturedClientInfo.version).toBe('2.4.1');
  });
});
