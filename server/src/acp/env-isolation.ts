import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppConfig } from '../config.js';
import {
  isValidSkillSlug,
  LEGACY_BUILTIN_SYNC_MARKER,
  resolveActiveBuiltinSkillsForProfile,
} from '../skills/builtin-skills.js';
import type { SandboxStatus } from '../types.js';

const require = createRequire(import.meta.url);

export const SANDBOX_WORKSPACE_MOUNT = '/workspace';
export const SANDBOX_HOME_MOUNT = '/home/sandbox';
export const SANDBOX_DOC_RUNTIME_MOUNT = '/usr/local/agy-doc-runtime';
export const SANDBOX_CHAT_RUNTIME_MOUNT = '/home/sandbox/.cache/agy-chat-runtime';

export function getChatBrainHostDir(profileDir: string, workspaceDir?: string | null): string {
  const profileAbs = path.resolve(profileDir);
  const wsKey = workspaceDir ? path.basename(path.resolve(workspaceDir)) : 'default';
  return path.join(profileAbs, '.chat-brains', wsKey || 'default');
}

export interface IsolatedEnvOptions {
  profileDir: string;
  geminiApiKey?: string | null;
  includeMockVars?: boolean;
  sandboxTmpDir?: string | null;
  extraEnv?: Record<string, string | undefined>;
}

const SAFE_HOST_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

const SYSTEM_MOUNT_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32'] as const;

const ETC_WHITELIST_DIRS = [
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/pki',
  '/etc/ld.so.conf.d',
  '/etc/alternatives',
  '/etc/terminfo',
  '/etc/fonts',
  '/etc/libreoffice',
  '/etc/ImageMagick-6',
  '/etc/ImageMagick-7',
] as const;

const ETC_WHITELIST_FILES = [
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/nsswitch.conf',
  '/etc/gai.conf',
  '/etc/host.conf',
  '/etc/services',
  '/etc/protocols',
  '/etc/ca-certificates.conf',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/localtime',
  '/etc/timezone',
  '/etc/os-release',
  '/etc/lsb-release',
  '/etc/mime.types',
] as const;

export function buildIsolatedAgyEnv(opts: IsolatedEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of SAFE_HOST_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (typeof val === 'string' && val.length > 0) {
      env[key] = val;
    }
  }
  if (!env.PATH) {
    env.PATH = '/usr/local/bin:/usr/bin:/bin';
  }
  if (opts.includeMockVars && process.env.MOCK_ALLOW_UNAUTH !== undefined) {
    env.MOCK_ALLOW_UNAUTH = process.env.MOCK_ALLOW_UNAUTH;
  }
  if (opts.includeMockVars && process.env.MOCK_CLIENT_INFO_PATH !== undefined) {
    env.MOCK_CLIENT_INFO_PATH = process.env.MOCK_CLIENT_INFO_PATH;
  }

  const profileAbs = path.resolve(opts.profileDir);
  const xdgConfig = path.join(profileAbs, '.config');
  const xdgData = path.join(profileAbs, '.local', 'share');
  const xdgState = path.join(profileAbs, '.local', 'state');
  const xdgCache = path.join(profileAbs, '.cache');
  const hostTmpDir = path.join(profileAbs, '.tmp');

  for (const dir of [profileAbs, xdgConfig, xdgData, xdgState, xdgCache, hostTmpDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const effectiveTmpDir = opts.sandboxTmpDir || hostTmpDir;

  env.HOME = profileAbs;
  env.USERPROFILE = profileAbs;
  env.XDG_CONFIG_HOME = xdgConfig;
  env.XDG_DATA_HOME = xdgData;
  env.XDG_STATE_HOME = xdgState;
  env.XDG_CACHE_HOME = xdgCache;
  env.TMPDIR = effectiveTmpDir;
  env.TEMP = effectiveTmpDir;
  env.TMP = effectiveTmpDir;
  env.USER = 'sandbox';
  env.LOGNAME = 'sandbox';
  env.SHELL = '/bin/bash';
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  env.NO_BROWSER = '1';
  env.SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 22';
  env.TERM = 'xterm-256color';

  if (opts.geminiApiKey) {
    env.GEMINI_API_KEY = opts.geminiApiKey;
  }

  if (opts.extraEnv) {
    for (const [k, v] of Object.entries(opts.extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

export function resolveHostExecutable(bin: string, searchPath = process.env.PATH): string | null {
  const trimmed = bin.trim();
  if (!trimmed) return null;

  const tryCandidate = (candidate: string): string | null => {
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) return null;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      return null;
    }
  };

  if (trimmed.includes('/')) {
    return tryCandidate(path.resolve(trimmed));
  }

  for (const dir of (searchPath || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter)) {
    if (!dir) continue;
    const hit = tryCandidate(path.join(dir, trimmed));
    if (hit) return hit;
  }
  return null;
}

export const SYSTEM_STANDARD_BIN_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'] as const;

/**
 * Resolves the single canonical `agy` executable path so that server startup,
 * sandboxed ACP workers, non-sandboxed login/quota calls, and updaters all use
 * the exact same binary rather than drifting across user/shell PATH differences.
 */
export function resolveCanonicalAgyBin(
  configuredBin: string,
  searchPath = process.env.PATH,
  systemDirs: readonly string[] = SYSTEM_STANDARD_BIN_DIRS
): string {
  const trimmed = configuredBin.trim() || 'agy';
  if (trimmed.includes('/')) {
    return resolveHostExecutable(trimmed, searchPath) ?? path.resolve(trimmed);
  }
  if (trimmed === 'agy') {
    const systemSearchPath = systemDirs.filter(Boolean).join(path.delimiter);
    const systemHit = systemSearchPath ? resolveHostExecutable(trimmed, systemSearchPath) : null;
    if (systemHit) return systemHit;
  }
  return resolveHostExecutable(trimmed, searchPath) ?? trimmed;
}

function isInsideSystemMountTree(targetPath: string, mountedDirs: Set<string>): boolean {
  for (const dir of mountedDirs) {
    if (targetPath === dir || targetPath.startsWith(`${dir}/`)) {
      return true;
    }
  }
  return false;
}

function ensureSyntheticSandboxPasswdFiles(profileAbs: string): { passwdPath: string; groupPath: string } {
  const sandboxEtcDir = path.join(path.dirname(profileAbs), '.sandbox-etc');
  fs.mkdirSync(sandboxEtcDir, { recursive: true, mode: 0o700 });

  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;

  const passwdPath = path.join(sandboxEtcDir, 'passwd');
  const groupPath = path.join(sandboxEtcDir, 'group');

  const passwdContent = `root:x:0:0:root:/root:/bin/sh\nsandbox:x:${uid}:${gid}:Sandbox:${SANDBOX_WORKSPACE_MOUNT}:/bin/bash\n`;
  const groupContent = `root:x:0:\nsandbox:x:${gid}:\n`;

  fs.writeFileSync(passwdPath, passwdContent, { mode: 0o644 });
  fs.writeFileSync(groupPath, groupContent, { mode: 0o644 });

  return { passwdPath, groupPath };
}

function buildCoreBwrapRootfsArgs(): { args: string[]; mountedSystemDirs: Set<string> } {
  const args: string[] = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--hostname',
    'agy-sandbox',
    '--cap-drop',
    'ALL',
  ];

  const mountedSystemDirs = new Set<string>();
  for (const sysPath of SYSTEM_MOUNT_ROOTS) {
    try {
      const lst = fs.lstatSync(sysPath);
      if (lst.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(sysPath);
        args.push('--symlink', linkTarget, sysPath);
      } else if (lst.isDirectory()) {
        args.push('--ro-bind', sysPath, sysPath);
        mountedSystemDirs.add(sysPath);
      }
    } catch {
      // Skip absent system paths (e.g. /lib32 on arm64)
    }
  }

  args.push(
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/var',
    '--tmpfs',
    '/var/tmp',
    '--dir',
    '/run',
    '--dir',
    '/home',
    '--dir',
    '/root',
    '--dir',
    '/etc'
  );

  const mountedEtcDirs: string[] = [];
  for (const dirPath of ETC_WHITELIST_DIRS) {
    try {
      const real = fs.realpathSync(dirPath);
      if (fs.statSync(real).isDirectory()) {
        args.push('--ro-bind', real, dirPath);
        mountedEtcDirs.push(dirPath);
      }
    } catch {
      // Ignore absent optional /etc subdirectories
    }
  }

  const mountEtcFile = (filePath: string) => {
    if (mountedEtcDirs.some((d) => filePath.startsWith(`${d}/`))) {
      return;
    }
    try {
      const real = fs.realpathSync(filePath);
      if (fs.statSync(real).isFile()) {
        args.push('--ro-bind', real, filePath);
      }
    } catch {
      // Ignore absent optional /etc files
    }
  };

  for (const filePath of ETC_WHITELIST_FILES) {
    mountEtcFile(filePath);
  }
  for (const envVar of ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) {
    const val = process.env[envVar];
    if (val && path.isAbsolute(val) && val.startsWith('/etc/')) {
      mountEtcFile(val);
    }
  }

  return { args, mountedSystemDirs };
}

export interface SpawnCommandSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: boolean;
  layeredRuntimeIsolated: boolean;
  sandboxWorkspaceRoot: string;
}

const sandboxProbeCache = new Map<string, SandboxStatus>();

export function clearSandboxProbeCache(): void {
  sandboxProbeCache.clear();
}

const NON_ISOLATED_GUARANTEE_NOTE =
  '非隔離モードのため、共通ベースの読み取り専用保護およびチャット単位のパッケージ差分・プロセス隔離は保証されません。';

export function probeBwrapSandbox(config: AppConfig, useCache = true): SandboxStatus {
  if (config.agyMode === 'mock') {
    return {
      mode: config.sandboxMode,
      active: false,
      backend: 'mock',
      layeredRuntimeIsolated: false,
      reason: `モックモード（AGY_MODE=mock）で動作中です。${NON_ISOLATED_GUARANTEE_NOTE}`,
      remediation: null,
    };
  }
  if (config.sandboxMode === 'off') {
    return {
      mode: 'off',
      active: false,
      backend: 'none',
      layeredRuntimeIsolated: false,
      reason: `設定（SANDBOX_MODE=off）によりOSレベルの隔離が無効化されています。${NON_ISOLATED_GUARANTEE_NOTE}`,
      remediation: '/etc/antigravity-chat/env から SANDBOX_MODE=off / ENABLE_BWRAP=false を外して再起動してください。',
    };
  }
  if (process.platform !== 'linux') {
    return {
      mode: config.sandboxMode,
      active: false,
      backend: 'none',
      layeredRuntimeIsolated: false,
      reason: `bubblewrap サンドボックスは Linux 専用です（現在: ${process.platform}）。${NON_ISOLATED_GUARANTEE_NOTE}`,
      remediation: null,
    };
  }

  const cacheKey = `${config.sandboxMode}|${config.agyMode}|${config.bwrapBin}`;
  if (useCache) {
    const cached = sandboxProbeCache.get(cacheKey);
    if (cached) return cached;
  }

  const bwrapResolved = resolveHostExecutable(config.bwrapBin);
  if (!bwrapResolved) {
    const res: SandboxStatus = {
      mode: config.sandboxMode,
      active: false,
      backend: 'none',
      layeredRuntimeIsolated: false,
      reason: `bubblewrap (${config.bwrapBin}) が見つかりません。${NON_ISOLATED_GUARANTEE_NOTE}`,
      remediation: 'Ubuntu サーバーで sudo apt-get update && sudo apt-get install -y bubblewrap を実行してください。',
    };
    sandboxProbeCache.set(cacheKey, res);
    return res;
  }

  const trueBin = resolveHostExecutable('true');
  const shBin = trueBin ? null : resolveHostExecutable('sh');
  const probeExec = trueBin ?? shBin;
  if (!probeExec) {
    const res: SandboxStatus = {
      mode: config.sandboxMode,
      active: false,
      backend: 'none',
      layeredRuntimeIsolated: false,
      reason: `サンドボックス検証用バイナリ（true / sh）が見つかりません。${NON_ISOLATED_GUARANTEE_NOTE}`,
      remediation: null,
    };
    sandboxProbeCache.set(cacheKey, res);
    return res;
  }

  const { args: rootArgs } = buildCoreBwrapRootfsArgs();
  const probeArgs = [
    ...rootArgs,
    '--tmpfs',
    SANDBOX_WORKSPACE_MOUNT,
    '--chdir',
    SANDBOX_WORKSPACE_MOUNT,
    '--',
    probeExec,
    ...(trueBin ? [] : ['-c', 'exit 0']),
  ];

  let res: SandboxStatus;
  try {
    execFileSync(bwrapResolved, probeArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    res = {
      mode: config.sandboxMode,
      active: true,
      backend: 'bwrap',
      layeredRuntimeIsolated: true,
      reason: null,
      remediation: null,
    };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = (e.stderr ? String(e.stderr) : e.message ?? '').trim();
    const isPermissionIssue = /permission denied|operation not permitted|uid map|uid_map|apparmor|userns/i.test(stderr);
    res = {
      mode: config.sandboxMode,
      active: false,
      backend: 'none',
      layeredRuntimeIsolated: false,
      reason: isPermissionIssue
        ? `Ubuntu AppArmor またはカーネル名前空間の制限により bubblewrap の起動が拒否されました。${NON_ISOLATED_GUARANTEE_NOTE}`
        : `bubblewrap の起動テストに失敗しました: ${stderr.slice(0, 180) || 'unknown error'}。${NON_ISOLATED_GUARANTEE_NOTE}`,
      remediation: isPermissionIssue
        ? 'Ubuntu サーバーで最新の sudo bash deploy/ubuntu-setup.sh を実行し、/etc/apparmor.d/bwrap の作成と systemd の NoNewPrivileges=false を反映してください。'
        : 'sudo systemctl restart antigravity-chat と bubblewrap の動作を確認してください。',
    };
  }

  sandboxProbeCache.set(cacheKey, res);
  return res;
}

function getTsxImportUrl(): string {
  const resolved = require.resolve('tsx');
  return pathToFileURL(resolved).href;
}

function symlinkIfMissing(targetPath: string, linkPath: string): void {
  if (!fs.existsSync(targetPath)) return;
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() || st.isDirectory()) return;
    if (st.isFile()) {
      const targetStat = fs.statSync(targetPath);
      if (st.size > 0 || !targetStat.isFile() || targetStat.size === 0) return;
      fs.rmSync(linkPath, { force: true });
    }
  } catch {
    // does not exist
  }
  try {
    fs.symlinkSync(targetPath, linkPath);
  } catch {
    // ignore if created concurrently
  }
}

export function prepareAgyUsageHome(profileDir: string, usageHome: string): void {
  const profile = path.resolve(profileDir);
  for (const name of ['.mock-agy-auth.json', '.config', '.local', '.cache']) {
    symlinkIfMissing(path.join(profile, name), path.join(usageHome, name));
  }

  // Share credentials and other CLI data, while letting the one-shot command
  // normalize only its own copy of settings.json.
  const settingsDir = path.join('.gemini', 'antigravity-cli');
  for (const relativeDir of ['.gemini', settingsDir]) {
    const source = path.join(profile, relativeDir);
    const destination = path.join(usageHome, relativeDir);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    const entries = fs.existsSync(source) ? fs.readdirSync(source) : [];
    for (const name of entries) {
      const from = path.join(source, name);
      const to = path.join(destination, name);
      if (relativeDir === '.gemini' && name === 'antigravity-cli') continue;
      if (relativeDir === settingsDir && name === 'settings.json') {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      } else {
        symlinkIfMissing(from, to);
      }
    }
  }
}

function ensurePrivateDir(dirPath: string): void {
  try {
    if (fs.lstatSync(dirPath).isSymbolicLink()) {
      fs.rmSync(dirPath, { force: true });
    }
  } catch {
    // missing
  }
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function clearSymlinkMountPoint(mountHostPath: string): void {
  try {
    if (fs.lstatSync(mountHostPath).isSymbolicLink()) {
      fs.rmSync(mountHostPath, { force: true });
    }
  } catch {
    // missing
  }
}

function resolveBindableHostPath(candidate: string): { resolved: string; isDir: boolean } | null {
  try {
    const resolved = fs.realpathSync(candidate);
    const st = fs.statSync(resolved);
    if (st.isFile() || st.isDirectory()) {
      return { resolved, isDir: st.isDirectory() };
    }
  } catch {
    // missing or broken symlink
  }
  return null;
}

export function ensurePerChatHomeDir(
  profileDir: string,
  workspaceDir: string,
  builtinSkillsDir?: string | null
): string {
  const profileAbs = path.resolve(profileDir);
  const workspaceAbs = path.resolve(workspaceDir);
  const wsKey = path.basename(workspaceAbs) || 'default';
  const chatHomeDir = path.join(profileAbs, '.chat-homes', wsKey);
  const chatBrainHostDir = getChatBrainHostDir(profileAbs, workspaceAbs);
  const chatScratchHostDir = path.join(profileAbs, '.chat-scratch', wsKey);
  const chatPlaygroundHostDir = path.join(profileAbs, '.chat-playground', wsKey);

  ensurePrivateDir(chatHomeDir);
  ensurePrivateDir(chatBrainHostDir);
  ensurePrivateDir(chatScratchHostDir);
  ensurePrivateDir(chatPlaygroundHostDir);

  // Isolate XDG directories per chat persistently; share only Antigravity auth/user config
  for (const rel of ['.config', '.local', '.local/share', '.local/state', '.cache']) {
    ensurePrivateDir(path.join(chatHomeDir, rel));
  }
  symlinkIfMissing(
    path.join(profileAbs, '.mock-agy-auth.json'),
    path.join(chatHomeDir, '.mock-agy-auth.json')
  );

  // Isolate .gemini per chat while sharing auth/config/skills
  const profileGemini = path.join(profileAbs, '.gemini');
  const chatGemini = path.join(chatHomeDir, '.gemini');
  ensurePrivateDir(chatGemini);

  const { active: activeBuiltins } = resolveActiveBuiltinSkillsForProfile(profileAbs, builtinSkillsDir);
  const isolatedVendorDirs = new Set(['antigravity', 'antigravity-cli', 'jetski']);
  const isolatedLeafDirs = new Set(['brain', 'scratch', 'playground', 'tmp', 'logs']);
  const internalConfigEntries = new Set([
    'skills',
    '.builtin-skills-state.json',
    '.builtin-migration-backups',
  ]);

  if (fs.existsSync(profileGemini)) {
    for (const entry of fs.readdirSync(profileGemini, { withFileTypes: true })) {
      if (isolatedVendorDirs.has(entry.name) || isolatedLeafDirs.has(entry.name)) continue;
      if (entry.name === 'config' && activeBuiltins.length > 0) continue;
      symlinkIfMissing(path.join(profileGemini, entry.name), path.join(chatGemini, entry.name));
    }
  }

  const chatConfigDir = path.join(chatGemini, 'config');
  const profileConfigDir = path.join(profileGemini, 'config');
  if (activeBuiltins.length > 0) {
    ensurePrivateDir(chatConfigDir);
    if (fs.existsSync(profileConfigDir)) {
      for (const entry of fs.readdirSync(profileConfigDir, { withFileTypes: true })) {
        if (internalConfigEntries.has(entry.name)) continue;
        symlinkIfMissing(path.join(profileConfigDir, entry.name), path.join(chatConfigDir, entry.name));
      }
    }

    const chatSkillsDir = path.join(chatConfigDir, 'skills');
    fs.mkdirSync(chatSkillsDir, { recursive: true, mode: 0o700 });
    const desiredSkills = new Map<string, string>();
    const profileSkillsDir = path.join(profileConfigDir, 'skills');
    if (fs.existsSync(profileSkillsDir)) {
      for (const entry of fs.readdirSync(profileSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (!isValidSkillSlug(entry.name)) continue;
        const candidate = path.join(profileSkillsDir, entry.name);
        if (fs.existsSync(path.join(candidate, LEGACY_BUILTIN_SYNC_MARKER))) continue;
        if (fs.existsSync(path.join(candidate, 'SKILL.md'))) {
          desiredSkills.set(entry.name, candidate);
        }
      }
    }
    for (const builtin of activeBuiltins) {
      if (!desiredSkills.has(builtin.slug)) {
        desiredSkills.set(builtin.slug, builtin.dir);
      }
    }
    for (const existing of fs.readdirSync(chatSkillsDir, { withFileTypes: true })) {
      if (!desiredSkills.has(existing.name)) {
        fs.rmSync(path.join(chatSkillsDir, existing.name), { recursive: true, force: true });
      }
    }
    for (const [slug, targetDir] of desiredSkills.entries()) {
      const linkPath = path.join(chatSkillsDir, slug);
      try {
        const st = fs.lstatSync(linkPath);
        if (st.isSymbolicLink() && fs.readlinkSync(linkPath) === targetDir) continue;
        fs.rmSync(linkPath, { recursive: true, force: true });
      } catch {
        // missing
      }
      symlinkIfMissing(targetDir, linkPath);
    }
  } else {
    try {
      const st = fs.lstatSync(chatConfigDir);
      if (!st.isSymbolicLink() && st.isDirectory()) {
        fs.rmSync(chatConfigDir, { recursive: true, force: true });
      }
    } catch {
      // missing
    }
    if (fs.existsSync(profileConfigDir)) {
      symlinkIfMissing(profileConfigDir, chatConfigDir);
    }
  }

  symlinkIfMissing(chatBrainHostDir, path.join(chatGemini, 'brain'));
  symlinkIfMissing(chatScratchHostDir, path.join(chatGemini, 'scratch'));
  symlinkIfMissing(chatPlaygroundHostDir, path.join(chatGemini, 'playground'));

  for (const vendor of isolatedVendorDirs) {
    const chatVendorDir = path.join(chatGemini, vendor);
    const profileVendorDir = path.join(profileGemini, vendor);
    fs.mkdirSync(chatVendorDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(profileVendorDir)) {
      for (const entry of fs.readdirSync(profileVendorDir, { withFileTypes: true })) {
        if (isolatedLeafDirs.has(entry.name)) continue;
        symlinkIfMissing(path.join(profileVendorDir, entry.name), path.join(chatVendorDir, entry.name));
      }
    }
    symlinkIfMissing(chatBrainHostDir, path.join(chatVendorDir, 'brain'));
    symlinkIfMissing(chatScratchHostDir, path.join(chatVendorDir, 'scratch'));
    symlinkIfMissing(chatPlaygroundHostDir, path.join(chatVendorDir, 'playground'));
  }

  return chatHomeDir;
}

export function buildAgyCommandSpec(params: {
  config: AppConfig;
  subcommandArgs: string[];
  profileDir: string;
  workspaceDir?: string;
  geminiApiKey?: string | null;
  enableSandboxBwrap?: boolean;
}): SpawnCommandSpec {
  const workspaceFallback = path.resolve(params.workspaceDir ?? params.profileDir);

  const isProbeWorkspace =
    !params.workspaceDir || path.basename(path.resolve(params.workspaceDir)) === '.probe';

  if (params.config.agyMode === 'mock') {
    const effectiveHome = !isProbeWorkspace
      ? ensurePerChatHomeDir(params.profileDir, params.workspaceDir!, params.config.builtinSkillsDir)
      : params.profileDir;
    const env = buildIsolatedAgyEnv({
      profileDir: params.profileDir,
      geminiApiKey: params.geminiApiKey,
      includeMockVars: true,
      extraEnv: !isProbeWorkspace
        ? {
            HOME: effectiveHome,
            USERPROFILE: effectiveHome,
          }
        : undefined,
    });
    const mockArgs = params.config.mockAgentPath.endsWith('.ts')
      ? ['--import', getTsxImportUrl(), params.config.mockAgentPath, ...params.subcommandArgs]
      : [params.config.mockAgentPath, ...params.subcommandArgs];
    return {
      command: process.execPath,
      args: mockArgs,
      env,
      sandboxed: false,
      layeredRuntimeIsolated: false,
      sandboxWorkspaceRoot: workspaceFallback,
    };
  }

  const agyArgs =
    params.subcommandArgs[0] === 'acp'
      ? [...params.subcommandArgs, '--disable-telemetry']
      : params.subcommandArgs;

  const docRuntime = resolveDocRuntimeLayout(params.config.docRuntimeDir);

  const wantsSandbox =
    Boolean(params.enableSandboxBwrap) &&
    params.config.sandboxMode !== 'off' &&
    process.platform === 'linux' &&
    Boolean(params.workspaceDir);

  if (wantsSandbox) {
    const profileAbs = path.resolve(params.profileDir);
    const workspaceAbs = path.resolve(params.workspaceDir!);
    const bwrapCommand = resolveHostExecutable(params.config.bwrapBin) ?? params.config.bwrapBin;

    const env = buildIsolatedAgyEnv({
      profileDir: profileAbs,
      geminiApiKey: params.geminiApiKey,
      sandboxTmpDir: '/tmp',
      extraEnv: {
        HOME: SANDBOX_HOME_MOUNT,
        USERPROFILE: SANDBOX_HOME_MOUNT,
        XDG_CONFIG_HOME: `${SANDBOX_HOME_MOUNT}/.config`,
        XDG_DATA_HOME: `${SANDBOX_HOME_MOUNT}/.local/share`,
        XDG_STATE_HOME: `${SANDBOX_HOME_MOUNT}/.local/state`,
        XDG_CACHE_HOME: `${SANDBOX_HOME_MOUNT}/.cache`,
      },
    });

    const { args: rootArgs, mountedSystemDirs } = buildCoreBwrapRootfsArgs();
    const { passwdPath, groupPath } = ensureSyntheticSandboxPasswdFiles(profileAbs);

    const bwrapArgs: string[] = [
      ...rootArgs,
      '--ro-bind',
      passwdPath,
      '/etc/passwd',
      '--ro-bind',
      groupPath,
      '/etc/group',
    ];

    try {
      const fontCacheReal = fs.realpathSync('/var/cache/fontconfig');
      if (fs.statSync(fontCacheReal).isDirectory()) {
        bwrapArgs.push('--dir', '/var/cache', '--ro-bind', fontCacheReal, '/var/cache/fontconfig');
      }
    } catch {
      // Ignore absent host fontconfig cache
    }

    let optDirMounted = false;
    const ensureOptDir = () => {
      if (!optDirMounted) {
        bwrapArgs.push('--dir', '/opt');
        optDirMounted = true;
      }
    };

    const resolvedAgy = resolveCanonicalAgyBin(params.config.agyBin, env.PATH);
    let sandboxAgyCommand = resolvedAgy;
    let sandboxAgyBinDir: string | null = null;

    if (resolvedAgy.includes('/')) {
      if (isInsideSystemMountTree(resolvedAgy, mountedSystemDirs)) {
        sandboxAgyCommand = resolvedAgy;
      } else {
        ensureOptDir();
        bwrapArgs.push('--dir', '/opt/agy', '--ro-bind', resolvedAgy, '/opt/agy/agy');
        sandboxAgyBinDir = '/opt/agy';
        sandboxAgyCommand = '/opt/agy/agy';
      }
    }

    const realHostNode = resolveRealHostNodeBin();
    const isSystemMountedNode = Boolean(
      realHostNode && isInsideSystemMountTree(realHostNode, mountedSystemDirs)
    );
    const hasCustomNodeModules = Boolean(docRuntime?.nodeModulesRel);
    const needsCustomNodeBind = Boolean(hasCustomNodeModules && realHostNode && !isSystemMountedNode);
    const SANDBOX_CUSTOM_NODE_MOUNT = '/usr/local/agy-doc-node';
    let sandboxNodeBin = isSystemMountedNode && realHostNode ? realHostNode : '/usr/bin/node';

    if (docRuntime) {
      if (fs.existsSync('/usr/local')) {
        bwrapArgs.push('--tmpfs', '/usr/local');
        for (const entry of fs.readdirSync('/usr/local', { withFileTypes: true })) {
          if (
            entry.name === path.posix.basename(SANDBOX_DOC_RUNTIME_MOUNT) ||
            entry.name === path.posix.basename(SANDBOX_CUSTOM_NODE_MOUNT)
          ) {
            continue;
          }
          const entryPath = path.posix.join('/usr/local', entry.name);
          if (entry.isSymbolicLink()) {
            bwrapArgs.push('--symlink', fs.readlinkSync(entryPath), entryPath);
          } else if (entry.isDirectory() || entry.isFile()) {
            bwrapArgs.push('--ro-bind', entryPath, entryPath);
          }
        }
        if (needsCustomNodeBind && realHostNode) {
          let resolvedHostNode = realHostNode;
          try {
            resolvedHostNode = fs.realpathSync(realHostNode);
          } catch {
            // keep realHostNode
          }
          if (fs.existsSync(resolvedHostNode)) {
            bwrapArgs.push('--ro-bind', resolvedHostNode, SANDBOX_CUSTOM_NODE_MOUNT);
            sandboxNodeBin = SANDBOX_CUSTOM_NODE_MOUNT;
          }
        }
      } else if (needsCustomNodeBind && realHostNode) {
        let resolvedHostNode = realHostNode;
        try {
          resolvedHostNode = fs.realpathSync(realHostNode);
        } catch {
          // keep realHostNode
        }
        if (fs.existsSync(resolvedHostNode)) {
          ensureOptDir();
          bwrapArgs.push('--dir', '/opt/agy-node', '--ro-bind', resolvedHostNode, '/opt/agy-node/node');
          sandboxNodeBin = '/opt/agy-node/node';
        }
      }
      bwrapArgs.push('--ro-bind', docRuntime.hostDir, SANDBOX_DOC_RUNTIME_MOUNT);
    }

    const chatRuntimeHostDir = ensurePerChatRuntimeDir(
      profileAbs,
      workspaceAbs,
      docRuntime,
      SANDBOX_DOC_RUNTIME_MOUNT,
      SANDBOX_CHAT_RUNTIME_MOUNT,
      sandboxNodeBin
    );
    applySandboxLayeredRuntime(env, docRuntime, sandboxAgyBinDir);

    const wsKey = path.basename(workspaceAbs) || 'default';
    const chatHomeHostDir = path.join(profileAbs, '.chat-homes', wsKey);
    const chatBrainHostDir = getChatBrainHostDir(profileAbs, workspaceAbs);
    const chatScratchHostDir = path.join(profileAbs, '.chat-scratch', wsKey);
    const chatPlaygroundHostDir = path.join(profileAbs, '.chat-playground', wsKey);

    ensurePrivateDir(chatHomeHostDir);
    for (const rel of [
      '.config',
      '.local',
      '.local/share',
      '.local/state',
      '.cache',
      '.cache/agy-chat-runtime',
      '.gemini',
      '.gemini/antigravity',
      '.gemini/antigravity-cli',
      '.gemini/jetski',
      '.gemini/config',
    ]) {
      ensurePrivateDir(path.join(chatHomeHostDir, rel));
    }
    ensurePrivateDir(chatBrainHostDir);
    ensurePrivateDir(chatScratchHostDir);
    ensurePrivateDir(chatPlaygroundHostDir);

    const brainSubdirs = [
      ['.gemini', 'antigravity-cli', 'brain'],
      ['.gemini', 'antigravity', 'brain'],
      ['.gemini', 'jetski', 'brain'],
      ['.gemini', 'brain'],
    ] as const;
    const scratchSubdirs = [
      ['.gemini', 'antigravity-cli', 'scratch'],
      ['.gemini', 'antigravity', 'scratch'],
      ['.gemini', 'jetski', 'scratch'],
      ['.gemini', 'scratch'],
    ] as const;
    const playgroundSubdirs = [
      ['.gemini', 'antigravity', 'playground'],
      ['.gemini', 'jetski', 'playground'],
      ['.gemini', 'playground'],
    ] as const;
    for (const rel of [...brainSubdirs, ...scratchSubdirs, ...playgroundSubdirs]) {
      ensurePrivateDir(path.join(chatHomeHostDir, ...rel));
    }

    bwrapArgs.push(
      '--bind',
      chatHomeHostDir,
      SANDBOX_HOME_MOUNT,
      '--bind',
      chatRuntimeHostDir,
      SANDBOX_CHAT_RUNTIME_MOUNT
    );

    const pushSharedBindMount = (hostSource: string, relUnderHome: string, readonly = false) => {
      const target = resolveBindableHostPath(hostSource);
      if (!target) return;
      const stubHostPath = path.join(chatHomeHostDir, relUnderHome);
      if (target.isDir) {
        ensurePrivateDir(stubHostPath);
      } else {
        ensurePrivateDir(path.dirname(stubHostPath));
        clearSymlinkMountPoint(stubHostPath);
        if (!fs.existsSync(stubHostPath)) {
          fs.writeFileSync(stubHostPath, '', { mode: 0o600 });
        }
      }
      bwrapArgs.push(
        readonly ? '--ro-bind' : '--bind',
        target.resolved,
        `${SANDBOX_HOME_MOUNT}/${relUnderHome}`
      );
    };

    // Selectively share ONLY Antigravity authentication and explicitly shared profile config/skills
    pushSharedBindMount(path.join(profileAbs, '.mock-agy-auth.json'), '.mock-agy-auth.json');

    const profileGemini = path.join(profileAbs, '.gemini');
    const excludedGeminiRootEntries = new Set([
      'antigravity',
      'antigravity-cli',
      'jetski',
      'config',
      'brain',
      'scratch',
      'playground',
      'tmp',
      'logs',
    ]);
    if (fs.existsSync(profileGemini)) {
      for (const entry of fs.readdirSync(profileGemini, { withFileTypes: true })) {
        if (excludedGeminiRootEntries.has(entry.name)) continue;
        pushSharedBindMount(path.join(profileGemini, entry.name), `.gemini/${entry.name}`);
      }
    }

    const excludedVendorEntries = new Set(['brain', 'scratch', 'playground', 'tmp', 'logs']);
    for (const vendor of ['antigravity', 'antigravity-cli', 'jetski'] as const) {
      const profileVendorDir = path.join(profileGemini, vendor);
      if (!fs.existsSync(profileVendorDir)) continue;
      for (const entry of fs.readdirSync(profileVendorDir, { withFileTypes: true })) {
        if (excludedVendorEntries.has(entry.name)) continue;
        pushSharedBindMount(
          path.join(profileVendorDir, entry.name),
          `.gemini/${vendor}/${entry.name}`
        );
      }
    }

    const profileConfigDir = path.join(profileGemini, 'config');
    const excludedConfigEntries = new Set([
      'skills',
      '.builtin-skills-state.json',
      '.builtin-migration-backups',
    ]);
    if (fs.existsSync(profileConfigDir)) {
      for (const entry of fs.readdirSync(profileConfigDir, { withFileTypes: true })) {
        if (excludedConfigEntries.has(entry.name)) continue;
        pushSharedBindMount(
          path.join(profileConfigDir, entry.name),
          `.gemini/config/${entry.name}`
        );
      }
    }

    bwrapArgs.push(
      '--bind',
      chatBrainHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/antigravity-cli/brain`,
      '--bind',
      chatBrainHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/antigravity/brain`,
      '--bind',
      chatBrainHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/jetski/brain`,
      '--bind',
      chatBrainHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/brain`,
      '--bind',
      chatScratchHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/antigravity-cli/scratch`,
      '--bind',
      chatScratchHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/antigravity/scratch`,
      '--bind',
      chatScratchHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/jetski/scratch`,
      '--bind',
      chatScratchHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/scratch`,
      '--bind',
      chatPlaygroundHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/antigravity/playground`,
      '--bind',
      chatPlaygroundHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/jetski/playground`,
      '--bind',
      chatPlaygroundHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/playground`,
      ...(() => {
        const { active: activeBuiltins } = resolveActiveBuiltinSkillsForProfile(
          profileAbs,
          params.config.builtinSkillsDir
        );
        const customSkillsDir = path.join(profileAbs, '.gemini', 'config', 'skills');
        const hasCustomSkillsDir = fs.existsSync(customSkillsDir);
        if (activeBuiltins.length === 0 && !hasCustomSkillsDir) return [];
        ensurePrivateDir(path.join(chatHomeHostDir, '.gemini', 'config', 'skills'));
        const skillMounts: string[] = [
          '--tmpfs',
          `${SANDBOX_HOME_MOUNT}/.gemini/config/skills`,
        ];
        if (hasCustomSkillsDir) {
          const customEntries = fs.readdirSync(customSkillsDir, { withFileTypes: true });
          for (const entry of customEntries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            if (!isValidSkillSlug(entry.name)) continue;
            const candidate = path.join(customSkillsDir, entry.name);
            if (fs.existsSync(path.join(candidate, LEGACY_BUILTIN_SYNC_MARKER))) continue;
            if (!fs.existsSync(path.join(candidate, 'SKILL.md'))) continue;
            let resolvedHostDir: string;
            try {
              resolvedHostDir = fs.realpathSync(candidate);
            } catch {
              continue;
            }
            skillMounts.push(
              '--bind',
              resolvedHostDir,
              `${SANDBOX_HOME_MOUNT}/.gemini/config/skills/${entry.name}`
            );
          }
        }
        for (const builtin of activeBuiltins) {
          skillMounts.push(
            '--ro-bind',
            builtin.dir,
            `${SANDBOX_HOME_MOUNT}/.gemini/config/skills/${builtin.slug}`
          );
        }
        return skillMounts;
      })(),
      '--bind',
      workspaceAbs,
      SANDBOX_WORKSPACE_MOUNT,
      '--chdir',
      SANDBOX_WORKSPACE_MOUNT,
      '--',
      sandboxAgyCommand,
      ...agyArgs
    );

    return {
      command: bwrapCommand,
      args: bwrapArgs,
      env,
      sandboxed: true,
      layeredRuntimeIsolated: true,
      sandboxWorkspaceRoot: SANDBOX_WORKSPACE_MOUNT,
    };
  }

  const effectiveHome = params.workspaceDir
    ? ensurePerChatHomeDir(params.profileDir, params.workspaceDir, params.config.builtinSkillsDir)
    : params.profileDir;
  const env = buildIsolatedAgyEnv({
    profileDir: params.profileDir,
    geminiApiKey: params.geminiApiKey,
    extraEnv: params.workspaceDir
      ? {
          HOME: effectiveHome,
          USERPROFILE: effectiveHome,
        }
      : undefined,
  });

  // Non-isolated fallback intentionally does NOT claim or simulate layered per-chat
  // read-only base + writable diff guarantees.
  return {
    command: resolveCanonicalAgyBin(params.config.agyBin, env.PATH),
    args: agyArgs,
    env,
    sandboxed: false,
    layeredRuntimeIsolated: false,
    sandboxWorkspaceRoot: workspaceFallback,
  };
}

export interface DocRuntimeLayout {
  hostDir: string;
  venvBinRel: string | null;
  nodeModulesRel: string | null;
  nodeBinRel: string | null;
  pythonSiteRels: string[];
  pythonVersionDir: string | null;
}

export function resolveDocRuntimeLayout(rawDir?: string | null): DocRuntimeLayout | null {
  if (!rawDir || !rawDir.trim()) return null;
  let hostDir: string;
  try {
    hostDir = fs.realpathSync(path.resolve(rawDir));
    if (!fs.statSync(hostDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const hasDir = (rel: string): string | null => {
    try {
      const full = path.join(hostDir, rel);
      return fs.statSync(full).isDirectory() ? rel : null;
    } catch {
      return null;
    }
  };

  const venvBinRel = hasDir(path.join('venv', 'bin'));
  const nodeModulesRel = hasDir(path.join('node', 'node_modules')) ?? hasDir('node_modules');
  const nodeBinRel =
    hasDir(path.join('node', 'node_modules', '.bin')) ?? hasDir(path.join('node_modules', '.bin'));

  const pythonSiteRels: string[] = [];
  const seenSiteReals = new Set<string>();
  let pythonVersionDir: string | null = null;
  for (const libName of ['lib', 'lib64']) {
    const libDir = path.join(hostDir, 'venv', libName);
    try {
      if (!fs.statSync(libDir).isDirectory()) continue;
      for (const entry of fs.readdirSync(libDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^python\d+\.\d+$/.test(entry.name)) continue;
        const siteRel = path.join('venv', libName, entry.name, 'site-packages');
        if (!hasDir(siteRel)) continue;
        try {
          const siteReal = fs.realpathSync(path.join(hostDir, siteRel));
          if (seenSiteReals.has(siteReal)) continue;
          seenSiteReals.add(siteReal);
        } catch {
          continue;
        }
        if (!pythonVersionDir) pythonVersionDir = entry.name;
        pythonSiteRels.push(siteRel);
      }
    } catch {
      // ignore missing python lib dir
    }
  }

  if (!venvBinRel && !nodeModulesRel && pythonSiteRels.length === 0) {
    return null;
  }

  return {
    hostDir,
    venvBinRel,
    nodeModulesRel,
    nodeBinRel,
    pythonSiteRels,
    pythonVersionDir,
  };
}

let cachedHostPythonVersionDir: string | null = null;

export function detectHostPythonVersionDir(): string {
  if (cachedHostPythonVersionDir) return cachedHostPythonVersionDir;
  const pyBin = resolveHostExecutable('python3') ?? '/usr/bin/python3';
  try {
    const out = execFileSync(
      pyBin,
      ['-c', 'import sys; print(f"python{sys.version_info[0]}.{sys.version_info[1]}")'],
      { encoding: 'utf8', timeout: 2000 }
    ).trim();
    if (/^python\d+\.\d+$/.test(out)) {
      cachedHostPythonVersionDir = out;
      return out;
    }
  } catch {
    // fallback below
  }
  try {
    for (const entry of fs.readdirSync('/usr/lib', { withFileTypes: true })) {
      if (entry.isDirectory() && /^python\d+\.\d+$/.test(entry.name)) {
        cachedHostPythonVersionDir = entry.name;
        return entry.name;
      }
    }
  } catch {
    // ignore
  }
  cachedHostPythonVersionDir = 'python3.11';
  return cachedHostPythonVersionDir;
}

function writeFileIfChanged(filePath: string, content: string, mode: number): void {
  try {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
      fs.chmodSync(filePath, mode);
      return;
    }
  } catch {
    // rewrite
  }
  fs.writeFileSync(filePath, content, { mode });
}

function ensureSymlinkTarget(targetPath: string, linkPath: string): void {
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() && fs.readlinkSync(linkPath) === targetPath) {
      return;
    }
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // does not exist
  }
  fs.symlinkSync(targetPath, linkPath);
}

function reconcileBaseNodeModulesSymlinks(
  chatNodeModulesDir: string,
  docRuntime: DocRuntimeLayout | null,
  docRuntimeMountRoot: string
): void {
  const toPosix = (rel: string) => rel.split(path.sep).join(path.posix.sep);
  const managedPrefixes = Array.from(
    new Set([
      `${toPosix(SANDBOX_DOC_RUNTIME_MOUNT).replace(/\/+$/, '')}/`,
      `${toPosix(docRuntimeMountRoot).replace(/\/+$/, '')}/`,
    ])
  );
  const isManagedBaseTarget = (target: string): boolean => {
    const normalized = toPosix(target);
    return managedPrefixes.some((prefix) => normalized.startsWith(prefix));
  };

  const expectedLinks = new Map<string, string>();
  if (docRuntime?.nodeModulesRel) {
    const hostBaseNodeModules = path.join(docRuntime.hostDir, docRuntime.nodeModulesRel);
    const targetBaseRoot = path.posix.join(
      toPosix(docRuntimeMountRoot),
      toPosix(docRuntime.nodeModulesRel)
    );
    if (fs.existsSync(hostBaseNodeModules)) {
      for (const entry of fs.readdirSync(hostBaseNodeModules, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name.startsWith('@')) {
          const hostScopeDir = path.join(hostBaseNodeModules, entry.name);
          try {
            if (!fs.statSync(hostScopeDir).isDirectory()) continue;
          } catch {
            continue;
          }
          for (const sub of fs.readdirSync(hostScopeDir, { withFileTypes: true })) {
            if (sub.name.startsWith('.')) continue;
            expectedLinks.set(
              `${entry.name}/${sub.name}`,
              path.posix.join(targetBaseRoot, entry.name, sub.name)
            );
          }
        } else {
          expectedLinks.set(entry.name, path.posix.join(targetBaseRoot, entry.name));
        }
      }
    }
  }

  // Remove stale or removed base-runtime symlinks while preserving per-chat installs
  for (const entry of fs.readdirSync(chatNodeModulesDir, { withFileTypes: true })) {
    const entryPath = path.join(chatNodeModulesDir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const target = fs.readlinkSync(entryPath);
        if (isManagedBaseTarget(target) && expectedLinks.get(entry.name) !== target) {
          fs.rmSync(entryPath, { force: true });
        }
      } catch {
        // ignore readlink race
      }
      continue;
    }
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const sub of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (!sub.isSymbolicLink()) continue;
        const subPath = path.join(entryPath, sub.name);
        const rel = `${entry.name}/${sub.name}`;
        try {
          const target = fs.readlinkSync(subPath);
          if (isManagedBaseTarget(target) && expectedLinks.get(rel) !== target) {
            fs.rmSync(subPath, { force: true });
          }
        } catch {
          // ignore readlink race
        }
      }
      try {
        if (fs.readdirSync(entryPath).length === 0) {
          fs.rmdirSync(entryPath);
        }
      } catch {
        // ignore non-empty or concurrent write
      }
    }
  }

  for (const [rel, targetPath] of expectedLinks.entries()) {
    const linkPath = path.join(chatNodeModulesDir, rel);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true, mode: 0o700 });
    try {
      const st = fs.lstatSync(linkPath);
      // Preserve real directories or user-installed symlinks (e.g. per-chat npm install -g)
      if (!st.isSymbolicLink()) continue;
      if (!isManagedBaseTarget(fs.readlinkSync(linkPath))) continue;
      if (fs.readlinkSync(linkPath) === targetPath) continue;
      fs.rmSync(linkPath, { force: true });
    } catch {
      // missing -> create symlink below
    }
    fs.symlinkSync(targetPath, linkPath);
  }
}

function buildEsmHookScript(defaultLayerRoots: string[]): string {
  return `import path from 'node:path';
import { pathToFileURL } from 'node:url';

const envRoots = (process.env.AGY_NODE_LAYER_PATHS || '')
  .split(path.delimiter)
  .map((p) => p.trim())
  .filter(Boolean);
const fallbackRoots = envRoots.length > 0 ? envRoots : ${JSON.stringify(defaultLayerRoots)};

function isBareSpecifier(specifier) {
  if (!specifier) return false;
  if (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#')
  ) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return false;
  return true;
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!err || err.code !== 'ERR_MODULE_NOT_FOUND' || !isBareSpecifier(specifier)) {
      throw err;
    }
    for (const root of fallbackRoots) {
      try {
        const anchorUrl = pathToFileURL(path.join(root, '_agy_layer_anchor.mjs')).href;
        return await nextResolve(specifier, { ...context, parentURL: anchorUrl });
      } catch {
        // Try next layer
      }
    }
    throw err;
  }
}
`;
}

const ESM_REGISTER_SCRIPT = `import * as nodeModule from 'node:module';
if (typeof nodeModule.register === 'function') {
  nodeModule.register(new URL('./esm-hook.mjs', import.meta.url));
}
`;

function resolveRealHostNodeBin(excludePath?: string): string | null {
  if (
    process.execPath &&
    process.execPath !== excludePath &&
    path.basename(process.execPath).startsWith('node') &&
    fs.existsSync(process.execPath)
  ) {
    return process.execPath;
  }
  const fromPath = resolveHostExecutable('node');
  if (fromPath && fromPath !== excludePath && fs.existsSync(fromPath)) {
    return fromPath;
  }
  return null;
}

export function ensurePerChatRuntimeDir(
  profileDir: string,
  workspaceDir: string,
  docRuntime: DocRuntimeLayout | null,
  docRuntimeMountRoot = SANDBOX_DOC_RUNTIME_MOUNT,
  chatRuntimeMountRoot = SANDBOX_CHAT_RUNTIME_MOUNT,
  hostNodeBinOverride?: string
): string {
  const profileAbs = path.resolve(profileDir);
  const wsKey = path.basename(path.resolve(workspaceDir)) || 'default';
  const chatRuntimeDir = path.join(profileAbs, '.chat-runtime', wsKey);

  const pyVerDir = docRuntime?.pythonVersionDir ?? detectHostPythonVersionDir();
  const venvDir = path.join(chatRuntimeDir, 'venv');
  const venvBinDir = path.join(venvDir, 'bin');
  const sitePackagesDir = path.join(venvDir, 'lib', pyVerDir, 'site-packages');
  const nodePrefixDir = path.join(chatRuntimeDir, 'node');
  const chatNodeModulesDir = path.join(nodePrefixDir, 'lib', 'node_modules');
  const pipCacheDir = path.join(chatRuntimeDir, 'pip-cache');
  const npmCacheDir = path.join(chatRuntimeDir, 'npm-cache');

  for (const dir of [
    chatRuntimeDir,
    venvDir,
    venvBinDir,
    sitePackagesDir,
    nodePrefixDir,
    chatNodeModulesDir,
    path.join(nodePrefixDir, 'node_modules'),
    path.join(nodePrefixDir, 'bin'),
    path.join(chatRuntimeDir, 'bin'),
    pipCacheDir,
    npmCacheDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  let pythonTarget = '/usr/bin/python3';
  if (!fs.existsSync(pythonTarget)) {
    pythonTarget = resolveHostExecutable('python3') ?? '/usr/bin/python3';
  }
  ensureSymlinkTarget(pythonTarget, path.join(venvBinDir, 'python3'));
  ensureSymlinkTarget('python3', path.join(venvBinDir, 'python'));

  const pipWrapper = '#!/bin/sh\nexec "$(dirname "$0")/python3" -m pip "$@"\n';
  writeFileIfChanged(path.join(venvBinDir, 'pip'), pipWrapper, 0o755);
  writeFileIfChanged(path.join(venvBinDir, 'pip3'), pipWrapper, 0o755);

  const pyvenvCfg = [
    `home = ${path.posix.dirname(pythonTarget.split(path.sep).join(path.posix.sep))}`,
    'include-system-site-packages = true',
    '',
  ].join('\n');
  writeFileIfChanged(path.join(venvDir, 'pyvenv.cfg'), pyvenvCfg, 0o644);

  const pthPath = path.join(sitePackagesDir, 'zz_agy_doc_base.pth');
  if (docRuntime && docRuntime.pythonSiteRels.length > 0) {
    const lines = docRuntime.pythonSiteRels.map((rel) =>
      path.posix.join(docRuntimeMountRoot, rel.split(path.sep).join(path.posix.sep))
    );
    writeFileIfChanged(pthPath, lines.join('\n') + '\n', 0o644);
  } else if (fs.existsSync(pthPath)) {
    fs.rmSync(pthPath, { force: true });
  }

  reconcileBaseNodeModulesSymlinks(chatNodeModulesDir, docRuntime, docRuntimeMountRoot);

  const hooksDir = path.join(chatRuntimeDir, 'hooks');
  const nodeWrapperPath = path.join(chatRuntimeDir, 'bin', 'node');
  if (docRuntime?.nodeModulesRel) {
    const toPosix = (rel: string) => rel.split(path.sep).join(path.posix.sep);
    const chatMountPosix = toPosix(chatRuntimeMountRoot).replace(/\/+$/, '');
    const docNodeParent = path.posix.dirname(
      path.posix.join(toPosix(docRuntimeMountRoot), toPosix(docRuntime.nodeModulesRel))
    );
    const defaultLayerRoots = [`${chatMountPosix}/node/lib`, `${chatMountPosix}/node`, docNodeParent];
    fs.mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    writeFileIfChanged(path.join(hooksDir, 'esm-register.mjs'), ESM_REGISTER_SCRIPT, 0o644);
    writeFileIfChanged(path.join(hooksDir, 'esm-hook.mjs'), buildEsmHookScript(defaultLayerRoots), 0o644);

    const isSandboxMountedBin = (binPath: string | null | undefined): binPath is string =>
      Boolean(
        binPath &&
          binPath !== nodeWrapperPath &&
          (binPath.startsWith('/usr/') || binPath.startsWith('/bin/')) &&
          fs.existsSync(binPath)
      );
    const hostNodeBin = (() => {
      if (hostNodeBinOverride && hostNodeBinOverride !== nodeWrapperPath) {
        return hostNodeBinOverride;
      }
      const detected = resolveRealHostNodeBin(nodeWrapperPath);
      if (chatRuntimeMountRoot !== SANDBOX_CHAT_RUNTIME_MOUNT && detected) {
        return detected;
      }
      return isSandboxMountedBin(detected) ? detected : '/usr/bin/node';
    })();
    const shSingleQuote = (val: string) => `'${val.replace(/'/g, "'\\''")}'`;
    const registerInSandbox = `${chatMountPosix}/hooks/esm-register.mjs`;
    const wrapperScript = [
      '#!/bin/sh',
      'case "${1:-}" in',
      '  -v|--version|-h|--help)',
      `    exec ${shSingleQuote(hostNodeBin)} "$@"`,
      '    ;;',
      'esac',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    */agy|/opt/agy/agy|--disable-telemetry)',
      `      exec ${shSingleQuote(hostNodeBin)} "$@"`,
      '      ;;',
      '  esac',
      'done',
      `exec ${shSingleQuote(hostNodeBin)} --import=${shSingleQuote(registerInSandbox)} "$@"`,
      '',
    ].join('\n');
    writeFileIfChanged(nodeWrapperPath, wrapperScript, 0o755);
  } else {
    fs.rmSync(nodeWrapperPath, { force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  }

  return chatRuntimeDir;
}

export function applySandboxLayeredRuntime(
  env: NodeJS.ProcessEnv,
  docRuntime: DocRuntimeLayout | null,
  sandboxAgyBinDir: string | null = null,
  mounts?: {
    chatRuntimeMount?: string;
    docRuntimeMount?: string;
  }
): void {
  const chatMount = mounts?.chatRuntimeMount ?? SANDBOX_CHAT_RUNTIME_MOUNT;
  const docMount = mounts?.docRuntimeMount ?? SANDBOX_DOC_RUNTIME_MOUNT;
  const toPosix = (rel: string) => rel.split(path.sep).join(path.posix.sep);

  env.VIRTUAL_ENV = `${chatMount}/venv`;
  env.PYTHONNOUSERSITE = '1';
  env.PIP_CACHE_DIR = `${chatMount}/pip-cache`;
  env.NPM_CONFIG_PREFIX = `${chatMount}/node`;
  env.NPM_CONFIG_CACHE = `${chatMount}/npm-cache`;
  env.NPM_CONFIG_USERCONFIG = `${chatMount}/npmrc`;

  delete env.NODE_OPTIONS;

  if (docRuntime?.nodeModulesRel) {
    const docNodeModules = path.posix.join(docMount, toPosix(docRuntime.nodeModulesRel));
    env.NODE_PATH = [
      `${chatMount}/node/lib/node_modules`,
      `${chatMount}/node/node_modules`,
      docNodeModules,
    ].join(path.delimiter);
    env.AGY_NODE_LAYER_PATHS = [
      `${chatMount}/node/lib`,
      `${chatMount}/node`,
      path.posix.dirname(docNodeModules),
    ].join(path.delimiter);
  } else {
    delete env.NODE_PATH;
    delete env.AGY_NODE_LAYER_PATHS;
  }

  const pathEntries = [
    ...(sandboxAgyBinDir ? [sandboxAgyBinDir] : []),
    `${chatMount}/venv/bin`,
    `${chatMount}/node/bin`,
    `${chatMount}/bin`,
  ];
  if (docRuntime?.venvBinRel) {
    pathEntries.push(path.posix.join(docMount, toPosix(docRuntime.venvBinRel)));
  }
  if (docRuntime?.nodeBinRel) {
    pathEntries.push(path.posix.join(docMount, toPosix(docRuntime.nodeBinRel)));
  }
  pathEntries.push(env.PATH || '/usr/local/bin:/usr/bin:/bin');
  env.PATH = pathEntries.join(path.delimiter);

  if (docRuntime) {
    env.SAL_USE_VCLPLUGIN = 'svp';
  }
}
