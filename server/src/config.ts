import path from 'node:path';

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  trustProxy: boolean;
  dataRoot: string;
  profilesRoot: string;
  workspacesRoot: string;
  projectsRoot: string;
  uploadsRoot: string;
  artifactsCacheRoot: string;
  dbPath: string;
  webDistDir: string;
  agyBin: string;
  agyMode: 'real' | 'mock';
  mockAgentPath: string;
  pythonBin: string;
  ptyHelperPath: string;
  libreOfficeBin: string;
  enableBwrap: boolean;
  bwrapBin: string;
  sessionTtlMs: number;
  sessionSecret: string;
  maxConcurrentAcp: number;
  maxAcpPerUser: number;
  idleWorkerMs: number;
  maxUploadBytes: number;
  allowPublicSignup: boolean;
  secureCookies: 'auto' | 'always' | 'never';
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const dataRoot = path.resolve(process.env.DATA_ROOT ?? path.join(repoRoot, 'data'));
  const agyModeRaw = (process.env.AGY_MODE ?? 'real').toLowerCase();
  const agyMode: 'real' | 'mock' = agyModeRaw === 'mock' ? 'mock' : 'real';

  const secureRaw = (process.env.SECURE_COOKIES ?? 'auto').toLowerCase();
  const secureCookies: 'auto' | 'always' | 'never' =
    secureRaw === 'always' || secureRaw === 'never' ? secureRaw : 'auto';

  const base: AppConfig = {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    host: process.env.HOST ?? '127.0.0.1',
    port: parsePositiveInt(process.env.PORT, 3000),
    trustProxy: parseBool(process.env.TRUST_PROXY, true),
    dataRoot,
    profilesRoot: path.join(dataRoot, 'profiles'),
    workspacesRoot: path.join(dataRoot, 'workspaces'),
    projectsRoot: path.join(dataRoot, 'projects'),
    uploadsRoot: path.join(dataRoot, 'uploads'),
    artifactsCacheRoot: path.join(dataRoot, 'artifacts-cache'),
    dbPath: path.resolve(process.env.DB_PATH ?? path.join(dataRoot, 'antigravity-chat.db')),
    webDistDir: path.resolve(process.env.WEB_DIST_DIR ?? path.join(repoRoot, 'web', 'dist')),
    agyBin: process.env.AGY_BIN ?? 'agy',
    agyMode,
    mockAgentPath: path.resolve(
      process.env.MOCK_AGENT_PATH ?? path.join(import.meta.dirname, 'acp', 'mock-acp-agent.ts')
    ),
    pythonBin: process.env.PYTHON_BIN ?? 'python3',
    ptyHelperPath: path.resolve(path.join(repoRoot, 'server', 'scripts', 'agy_pty_login.py')),
    libreOfficeBin: process.env.LIBREOFFICE_BIN ?? 'libreoffice',
    enableBwrap: parseBool(process.env.ENABLE_BWRAP, false),
    bwrapBin: process.env.BWRAP_BIN ?? 'bwrap',
    sessionTtlMs: parsePositiveInt(process.env.SESSION_TTL_DAYS, 30) * 24 * 60 * 60 * 1000,
    sessionSecret: process.env.SESSION_SECRET ?? 'dev-ephemeral-session-secret-change-in-prod',
    maxConcurrentAcp: parsePositiveInt(process.env.MAX_CONCURRENT_ACP, 2),
    maxAcpPerUser: parsePositiveInt(process.env.MAX_ACP_PER_USER, 2),
    idleWorkerMs: parsePositiveInt(process.env.IDLE_WORKER_MS, 10 * 60 * 1000),
    maxUploadBytes: parsePositiveInt(process.env.MAX_UPLOAD_MB, 50) * 1024 * 1024,
    allowPublicSignup: parseBool(process.env.ALLOW_PUBLIC_SIGNUP, true),
    secureCookies,
  };

  const merged = { ...base, ...overrides };
  if (!overrides.profilesRoot) merged.profilesRoot = path.join(merged.dataRoot, 'profiles');
  if (!overrides.workspacesRoot) merged.workspacesRoot = path.join(merged.dataRoot, 'workspaces');
  if (!overrides.projectsRoot) merged.projectsRoot = path.join(merged.dataRoot, 'projects');
  if (!overrides.uploadsRoot) merged.uploadsRoot = path.join(merged.dataRoot, 'uploads');
  if (!overrides.artifactsCacheRoot) merged.artifactsCacheRoot = path.join(merged.dataRoot, 'artifacts-cache');
  if (!overrides.dbPath && overrides.dataRoot) {
    merged.dbPath = path.join(merged.dataRoot, 'antigravity-chat.db');
  }
  return merged;
}
