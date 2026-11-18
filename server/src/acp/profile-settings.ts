import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AGY_AGENT_MODES = ['auto', '', 'accept-edits', 'plan'] as const;
type AgentMode = (typeof AGY_AGENT_MODES)[number];

function withSettingsPath<T>(profileDir: string, operation: (file: string) => T): T {
  // Anchor writes to the opened directories on Linux, where the ACP worker
  // can access the profile while the server is editing its settings.
  const useDirectoryFd = process.platform === 'linux' && fs.existsSync('/proc/self/fd');
  let directory: number | undefined;
  let current = profileDir;
  try {
    for (const segment of ['', '.gemini', 'antigravity-cli']) {
      current = path.join(current, segment);
      fs.mkdirSync(current, { recursive: true, mode: 0o700 });
      if (useDirectoryFd) {
        const next = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        if (directory !== undefined) fs.closeSync(directory);
        directory = next;
        current = `/proc/self/fd/${directory}`;
      } else if (!fs.lstatSync(current).isDirectory()) {
        throw new Error('Antigravity の設定ディレクトリが不正です。');
      }
    }
    return operation(path.join(current, 'settings.json'));
  } finally {
    if (directory !== undefined) fs.closeSync(directory);
  }
}

function writeSettings(file: string, settings: Record<string, unknown>, existingMode?: number): void {
  const temporary = path.join(path.dirname(file), `.settings-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      if (existingMode !== undefined) fs.fchmodSync(fd, existingMode & 0o777);
    } finally {
      fs.closeSync(fd);
    }
    if (existingMode === undefined) {
      try {
        fs.linkSync(temporary, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    } else {
      fs.renameSync(temporary, file);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readSettings(file: string): { settings: Record<string, unknown>; mode: number } {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error('Antigravity の設定ファイルが不正です。');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile() || openedStat.nlink !== 1) {
      throw new Error('Antigravity の設定ファイルが不正です。');
    }
    let settings: unknown;
    try {
      settings = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch {
      throw new Error('Antigravity の settings.json を読み込めません。');
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('Antigravity の settings.json は JSON オブジェクトである必要があります。');
    }
    return { settings: settings as Record<string, unknown>, mode: openedStat.mode };
  } finally {
    fs.closeSync(fd);
  }
}

function ensureSettings(file: string): void {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
    writeSettings(file, { agentMode: 'auto' });
  }
}

export function ensureAgyProfileSettings(profileDir: string): void {
  withSettingsPath(profileDir, ensureSettings);
}

export function getAgyAgentMode(profileDir: string): string | null {
  return withSettingsPath(profileDir, (file) => {
    ensureSettings(file);
    const { settings } = readSettings(file);
    return typeof settings.agentMode === 'string' ? settings.agentMode : null;
  });
}

export function setAgyAgentMode(profileDir: string, agentMode: AgentMode): void {
  withSettingsPath(profileDir, (file) => {
    ensureSettings(file);
    const { settings, mode } = readSettings(file);
    if (settings.agentMode !== agentMode) {
      writeSettings(file, { ...settings, agentMode }, mode);
    }
  });
}
