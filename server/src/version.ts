import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AppBuildInfo {
  version: string;
  tag: string | null;
  commitSha: string | null;
  shortSha: string | null;
  buildId: string;
  builtAt: string | null;
}

interface RawBuildInfoJson {
  version?: unknown;
  tag?: unknown;
  commitSha?: unknown;
  shortSha?: unknown;
  buildId?: unknown;
  builtAt?: unknown;
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function findBuildInfoPath(): string | null {
  const envPath = process.env.AGY_BUILD_INFO_PATH?.trim();
  if (envPath) {
    const resolved = path.resolve(envPath);
    return fs.existsSync(resolved) ? resolved : null;
  }
  const candidates = [
    path.resolve(import.meta.dirname, '..', '..', 'BUILD_INFO.json'),
    path.resolve(process.cwd(), 'BUILD_INFO.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolvePackageVersion(): string {
  const envVer = process.env.AGY_APP_VERSION?.trim();
  if (envVer) return envVer;

  const buildInfoPath = findBuildInfoPath();
  if (buildInfoPath) {
    const parsed = readJsonSafe<RawBuildInfoJson>(buildInfoPath);
    if (parsed && typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  }

  const pkgCandidates = [
    path.resolve(import.meta.dirname, '..', '..', 'package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const pkgPath of pkgCandidates) {
    const pkg = readJsonSafe<{ version?: unknown }>(pkgPath);
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  }
  return '1.0.0';
}

export function computeBuildId(webDistDir: string, extraFiles: Array<string | null> = []): string {
  if (process.env.AGY_BUILD_ID && process.env.AGY_BUILD_ID.trim()) {
    return process.env.AGY_BUILD_ID.trim();
  }
  const hash = crypto.createHash('sha256');
  const candidates = [
    path.join(webDistDir, 'index.html'),
    path.join(webDistDir, 'sw.js'),
    path.join(import.meta.dirname, 'app.js'),
    path.join(import.meta.dirname, 'app.ts'),
    findBuildInfoPath(),
    ...extraFiles,
  ];
  const seen = new Set<string>();
  for (const file of candidates) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    try {
      const data = fs.readFileSync(file);
      hash.update(path.basename(file));
      hash.update(String(data.length));
      hash.update(data);
    } catch {
      // ignore missing file during dev/test
    }
  }
  return hash.digest('hex').slice(0, 16);
}

export function loadAppBuildInfo(webDistDir: string, versionOverride?: string): AppBuildInfo {
  const buildInfoPath = findBuildInfoPath();
  const raw = buildInfoPath ? readJsonSafe<RawBuildInfoJson>(buildInfoPath) : null;

  const rawVersion =
    versionOverride?.trim() ||
    process.env.AGY_APP_VERSION?.trim() ||
    (raw && typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '') ||
    resolvePackageVersion();

  const commitSha =
    raw && typeof raw.commitSha === 'string' && raw.commitSha.trim() ? raw.commitSha.trim() : null;
  const shortSha =
    raw && typeof raw.shortSha === 'string' && raw.shortSha.trim()
      ? raw.shortSha.trim()
      : commitSha
        ? commitSha.slice(0, 8)
        : null;
  const tag =
    raw && typeof raw.tag === 'string' && raw.tag.trim()
      ? raw.tag.trim()
      : rawVersion
        ? `v${rawVersion.replace(/^v/, '')}`
        : null;
  const builtAt =
    raw && typeof raw.builtAt === 'string' && raw.builtAt.trim() ? raw.builtAt.trim() : null;
  const buildId = computeBuildId(webDistDir);

  return {
    version: rawVersion.replace(/^v/, ''),
    tag,
    commitSha,
    shortSha,
    buildId,
    builtAt,
  };
}
