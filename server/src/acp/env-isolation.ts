import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppConfig } from '../config.js';

const require = createRequire(import.meta.url);

export interface IsolatedEnvOptions {
  profileDir: string;
  geminiApiKey?: string | null;
  extraEnv?: Record<string, string | undefined>;
}

const GUI_AND_KEYRING_VARS = [
  'DBUS_SESSION_BUS_ADDRESS',
  'GNOME_KEYRING_CONTROL',
  'GNOME_KEYRING_PID',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'SESSION_MANAGER',
  'GPG_AGENT_INFO',
  'SSH_ASKPASS',
  'BROWSER',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];

export function buildIsolatedAgyEnv(opts: IsolatedEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GUI_AND_KEYRING_VARS) {
    delete env[key];
  }

  const profileAbs = path.resolve(opts.profileDir);
  const xdgConfig = path.join(profileAbs, '.config');
  const xdgData = path.join(profileAbs, '.local', 'share');
  const xdgState = path.join(profileAbs, '.local', 'state');
  const xdgCache = path.join(profileAbs, '.cache');
  const tmpDir = path.join(profileAbs, '.tmp');

  for (const dir of [profileAbs, xdgConfig, xdgData, xdgState, xdgCache, tmpDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  env.HOME = profileAbs;
  env.USERPROFILE = profileAbs;
  env.XDG_CONFIG_HOME = xdgConfig;
  env.XDG_DATA_HOME = xdgData;
  env.XDG_STATE_HOME = xdgState;
  env.XDG_CACHE_HOME = xdgCache;
  env.TMPDIR = tmpDir;
  env.TEMP = tmpDir;
  env.TMP = tmpDir;
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

export interface SpawnCommandSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function getTsxImportUrl(): string {
  const resolved = require.resolve('tsx');
  return pathToFileURL(resolved).href;
}

export function buildAgyCommandSpec(params: {
  config: AppConfig;
  subcommandArgs: string[];
  profileDir: string;
  workspaceDir?: string;
  geminiApiKey?: string | null;
  enableSandboxBwrap?: boolean;
}): SpawnCommandSpec {
  const env = buildIsolatedAgyEnv({
    profileDir: params.profileDir,
    geminiApiKey: params.geminiApiKey,
  });

  if (params.config.agyMode === 'mock') {
    const mockArgs = params.config.mockAgentPath.endsWith('.ts')
      ? ['--import', getTsxImportUrl(), params.config.mockAgentPath, ...params.subcommandArgs]
      : [params.config.mockAgentPath, ...params.subcommandArgs];
    return {
      command: process.execPath,
      args: mockArgs,
      env,
    };
  }

  // Real unmodified official `agy` binary
  if (
    params.enableSandboxBwrap &&
    params.config.enableBwrap &&
    process.platform === 'linux' &&
    params.workspaceDir
  ) {
    const profileAbs = path.resolve(params.profileDir);
    const workspaceAbs = path.resolve(params.workspaceDir);
    const bwrapArgs: string[] = [
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp',
      // Mask DATA_ROOT parent so peer users' profiles/workspaces are inaccessible even if permissions drift
      '--tmpfs',
      path.resolve(params.config.dataRoot),
      '--bind',
      profileAbs,
      profileAbs,
      '--bind',
      workspaceAbs,
      workspaceAbs,
      '--chdir',
      workspaceAbs,
      '--',
      params.config.agyBin,
      ...params.subcommandArgs,
    ];
    return {
      command: params.config.bwrapBin,
      args: bwrapArgs,
      env,
    };
  }

  return {
    command: params.config.agyBin,
    args: params.subcommandArgs,
    env,
  };
}
