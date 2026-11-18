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

function assertSettingsUnchanged(current: fs.BigIntStats | undefined, original: fs.BigIntStats): void {
  if (!current || current.dev !== original.dev || current.ino !== original.ino ||
      current.mtimeNs !== original.mtimeNs || current.ctimeNs !== original.ctimeNs ||
      current.size !== original.size) {
    throw Object.assign(new Error('settings.json が別の処理で更新されたため、そちらの変更を優先しました。'), {
      statusCode: 409,
      code: 'AGY_SETTINGS_CHANGED',
    });
  }
}

function createDefaultSettings(file: string): void {
  const temporary = path.join(path.dirname(file), `.settings-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, '{\n  "agentMode": "auto"\n}\n', 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporary, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function withSettingsFile<T>(file: string, access: number, operation: (fd: number) => T): T {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error('Antigravity の設定ファイルが不正です。');
  const fd = fs.openSync(file, access | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const openedStat = fs.fstatSync(fd, { bigint: true });
    if (!openedStat.isFile() || openedStat.nlink !== 1n) {
      throw new Error('Antigravity の設定ファイルが不正です。');
    }
    return operation(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function parseSettings(content: Buffer): Record<string, unknown> {
  let settings: unknown;
  try {
    settings = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error('Antigravity の settings.json を読み込めません。');
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Antigravity の settings.json は JSON オブジェクトである必要があります。');
  }
  return settings as Record<string, unknown>;
}

function ensureSettings(file: string): void {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
    createDefaultSettings(file);
  }
}

export function ensureAgyProfileSettings(profileDir: string): void {
  withSettingsPath(profileDir, ensureSettings);
}

export function getAgyAgentMode(profileDir: string): string | null {
  return withSettingsPath(profileDir, (file) => {
    ensureSettings(file);
    return withSettingsFile(file, fs.constants.O_RDONLY, (fd) => {
      const { agentMode } = parseSettings(fs.readFileSync(fd));
      return typeof agentMode === 'string' ? agentMode : null;
    });
  });
}

export function setAgyAgentMode(profileDir: string, agentMode: AgentMode): void {
  withSettingsPath(profileDir, (file) => {
    ensureSettings(file);
    withSettingsFile(file, fs.constants.O_RDWR, (fd) => {
      const original = fs.fstatSync(fd, { bigint: true });
      const previous = fs.readFileSync(fd);
      const settings = parseSettings(previous);
      if (settings.agentMode === agentMode) return;

      const json = Buffer.from(`${JSON.stringify({ ...settings, agentMode }, null, 2)}\n`, 'utf8');
      // Pad shorter JSON with whitespace so saving requires no separate truncate.
      const updated = Buffer.alloc(Math.max(json.length, previous.length), 0x20);
      json.copy(updated);
      assertSettingsUnchanged(fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }), original);

      // The CLI saves by replacing the path. Writing to the open descriptor
      // leaves any file installed by the CLI intact, even during this write.
      const written = fs.writeSync(fd, updated, 0, updated.length, 0);
      if (written !== updated.length) {
        fs.writeSync(fd, previous, 0, Math.min(previous.length, written), 0);
        fs.ftruncateSync(fd, previous.length);
        throw new Error('Antigravity の settings.json を保存できませんでした。');
      }
      assertSettingsUnchanged(fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }), fs.fstatSync(fd, { bigint: true }));
    });
  });
}
