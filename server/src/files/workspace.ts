import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PreviewKind } from '../types.js';
import mime from 'mime-types';

export class PathContainmentError extends Error {
  public readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

export function sanitizeFileName(rawName: string): string {
  const cleaned = path.basename(rawName.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'unnamed_file';
  }
  return cleaned;
}

export function normalizeRelPath(rawRel: string): string {
  const posix = rawRel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!posix || posix.includes('\x00')) {
    throw new PathContainmentError('無効なファイルパスです。');
  }
  const segments = posix.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..')) {
    throw new PathContainmentError('ディレクトリ外への参照（..）は許可されていません。');
  }
  return segments.join('/');
}

export function resolveContainedExistingPath(rootDir: string, candidatePath: string): {
  absPath: string;
  relPath: string;
} {
  const rootReal = fs.realpathSync(rootDir);
  const absCandidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(rootReal, normalizeRelPath(candidatePath));

  let candidateReal: string;
  try {
    candidateReal = fs.realpathSync(absCandidate);
  } catch {
    throw new PathContainmentError('対象のファイルが存在しないかアクセスできません。');
  }

  if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + path.sep)) {
    throw new PathContainmentError('許可された作業領域外のファイルにはアクセスできません。');
  }
  const relPath = path.relative(rootReal, candidateReal).split(path.sep).join('/');
  return { absPath: candidateReal, relPath };
}

function relativeWorkspaceTarget(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathContainmentError('不正な書き込み先パスです。');
  }
  return relative;
}

export function resolveContainedWriteTarget(rootDir: string, relPathRaw: string): {
  absPath: string;
  relPath: string;
  resolvedPath: string;
} {
  const rel = normalizeRelPath(relPathRaw);
  const rootReal = fs.realpathSync(rootDir);
  const targetAbs = path.resolve(rootReal, rel);
  const relative = relativeWorkspaceTarget(rootReal, targetAbs);

  // Reject links that point outside the workspace or cannot be resolved.
  const segments = relative.split(path.sep);
  let walk = rootReal;
  for (const segment of segments) {
    walk = path.join(walk, segment);
    const stat = fs.lstatSync(walk, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      try {
        walk = resolveContainedExistingPath(rootReal, walk).absPath;
      } catch {
        throw new PathContainmentError('作業領域内で解決できないシンボリックリンクへの書き込みは拒否されました。');
      }
    }
  }
  return { absPath: targetAbs, relPath: rel, resolvedPath: walk };
}

export const supportsWorkspaceTextWrites = process.platform === 'linux' && fs.existsSync('/proc/self/fd');

export class ExternalConcurrentWriteError extends Error {
  public readonly statusCode = 409;
  public readonly code = 'EXTERNAL_CONCURRENT_WRITE';
  constructor(message = 'ファイルの読取中に外部からの同時変更を検出しました。') {
    super(message);
    this.name = 'ExternalConcurrentWriteError';
  }
}

export interface FileFingerprint {
  dev: bigint;
  ino: bigint;
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export function extractFileFingerprint(stat: fs.BigIntStats): FileFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

export function fingerprintsMatch(a: FileFingerprint, b: FileFingerprint): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

export function fsyncDir(dirPath: string): void {
  const { O_RDONLY, O_DIRECTORY } = fs.constants;
  let fd: number | null = null;
  try {
    fd = fs.openSync(dirPath, O_RDONLY | O_DIRECTORY);
    fs.fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'EBADF' && code !== 'EROFS') {
      throw err;
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function checkSameFilesystem(pathA: string, pathB: string): boolean {
  const statA = fs.statSync(pathA, { bigint: true });
  const statB = fs.statSync(pathB, { bigint: true });
  return statA.dev === statB.dev;
}

function openRootDirectoryNoFollow(rootDir: string): { rootReal: string; dirFd: number } {
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(rootDir);
  } catch {
    throw new PathContainmentError('ルートディレクトリが存在しないかアクセスできません。');
  }
  const dirFd = fs.openSync(rootReal, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  return { rootReal, dirFd };
}

/**
 * Walk every intermediate parent directory with O_DIRECTORY | O_NOFOLLOW and optionally create missing directories.
 * Caller MUST close the returned `dirFd`.
 */
export function ensureContainedDirectoryNoFollow(
  rootDir: string,
  relDirPath: string,
  opts: { createMissing?: boolean } = {}
): { dirFd: number; rootReal: string; absDirPath: string } {
  if (!supportsWorkspaceTextWrites) {
    throw new PathContainmentError('この実行環境では O_NOFOLLOW による安全なディレクトリ走査を利用できません。');
  }
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
  const directoryFlags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
  const { rootReal, dirFd: initialFd } = openRootDirectoryNoFollow(rootDir);
  let dirFd = initialFd;
  try {
    const trimmed = relDirPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const segments = trimmed ? normalizeRelPath(trimmed).split('/') : [];
    for (const segment of segments) {
      const child = `/proc/self/fd/${dirFd}/${segment}`;
      if (opts.createMissing) {
        try {
          fs.mkdirSync(child, { mode: 0o700 });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      let nextFd: number;
      try {
        nextFd = fs.openSync(child, directoryFlags);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENOTDIR') {
          throw new PathContainmentError('中間ディレクトリにシンボリックリンクまたは不正なエントリが含まれています。');
        }
        throw err;
      }
      fs.closeSync(dirFd);
      dirFd = nextFd;
    }
    const absDirPath = segments.length > 0 ? path.join(rootReal, ...segments) : rootReal;
    return { dirFd, rootReal, absDirPath };
  } catch (err) {
    try {
      fs.closeSync(dirFd);
    } catch {
      // ignore
    }
    throw err;
  }
}

export interface OpenedContainedFile {
  fd: number;
  stat: fs.BigIntStats;
  fingerprint: FileFingerprint;
  relPath: string;
  absPath: string;
}

/**
 * Open a regular file strictly contained inside `rootDir` by walking EVERY intermediate directory
 * with O_DIRECTORY | O_NOFOLLOW and opening the leaf with O_NOFOLLOW | O_NONBLOCK.
 * Rejects symlinks (intermediate or leaf), path traversal, non-regular files, and hardlinks (by default).
 * Caller MUST close `fd`.
 */
export function openContainedRegularFileNoFollow(
  rootDir: string,
  relPathRaw: string,
  opts: { allowHardlinks?: boolean; maxBytes?: number } = {}
): OpenedContainedFile {
  if (!supportsWorkspaceTextWrites) {
    throw new PathContainmentError('この実行環境では O_NOFOLLOW による安全なファイル参照を利用できません。');
  }
  const relPath = normalizeRelPath(relPathRaw);
  const segments = relPath.split('/');
  const filename = segments.pop()!;
  const parentRel = segments.join('/');
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

  const { dirFd, rootReal } = ensureContainedDirectoryNoFollow(rootDir, parentRel, { createMissing: false });
  let fileFd: number | null = null;
  try {
    const leafPath = `/proc/self/fd/${dirFd}/${filename}`;
    try {
      fileFd = fs.openSync(leafPath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        throw new PathContainmentError('シンボリックリンクの参照は許可されていません。');
      }
      throw err;
    }

    const stat = fs.fstatSync(fileFd, { bigint: true });
    if (!stat.isFile()) {
      throw new PathContainmentError('通常のファイルのみアクセスできます。');
    }
    if (!opts.allowHardlinks && stat.nlink !== 1n) {
      throw new PathContainmentError('ハードリンクされたファイルへのアクセスは拒否されました。');
    }
    if (opts.maxBytes !== undefined && Number(stat.size) > opts.maxBytes) {
      throw new PathContainmentError(`ファイルサイズが上限（${opts.maxBytes} bytes）を超えています。`);
    }

    const absPath = path.join(rootReal, ...segments, filename);
    const result: OpenedContainedFile = {
      fd: fileFd,
      stat,
      fingerprint: extractFileFingerprint(stat),
      relPath,
      absPath,
    };
    fileFd = null; // transferred to caller
    return result;
  } finally {
    fs.closeSync(dirFd);
    if (fileFd !== null) {
      try {
        fs.closeSync(fileFd);
      } catch {
        // ignore
      }
    }
  }
}

export interface StableFileReadResult {
  buffer: Buffer;
  sha256: string;
  sizeBytes: number;
  fingerprint: FileFingerprint;
  relPath: string;
  absPath: string;
}

/**
 * Read a contained regular file from a single O_NOFOLLOW FD while checking fstat before/after
 * and parent-entry lstat consistency. Retries up to `maxRetries` times on concurrent external writes.
 */
export function readContainedRegularFileNoFollowStable(
  rootDir: string,
  relPathRaw: string,
  opts: { allowHardlinks?: boolean; maxBytes?: number; maxRetries?: number } = {}
): StableFileReadResult {
  const maxRetries = opts.maxRetries ?? 2;
  const relPath = normalizeRelPath(relPathRaw);
  const segments = relPath.split('/');
  const filename = segments.pop()!;
  const parentRel = segments.join('/');
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { dirFd, rootReal } = ensureContainedDirectoryNoFollow(rootDir, parentRel, { createMissing: false });
    let fileFd: number | null = null;
    try {
      const leafPath = `/proc/self/fd/${dirFd}/${filename}`;
      try {
        fileFd = fs.openSync(leafPath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') {
          throw new PathContainmentError('シンボリックリンクの参照は許可されていません。');
        }
        throw err;
      }

      const statBefore = fs.fstatSync(fileFd, { bigint: true });
      if (!statBefore.isFile()) {
        throw new PathContainmentError('通常のファイルのみアクセスできます。');
      }
      if (!opts.allowHardlinks && statBefore.nlink !== 1n) {
        throw new PathContainmentError('ハードリンクされたファイルへのアクセスは拒否されました。');
      }
      if (opts.maxBytes !== undefined && Number(statBefore.size) > opts.maxBytes) {
        throw new PathContainmentError(`ファイルサイズが上限（${opts.maxBytes} bytes）を超えています。`);
      }

      const fpBefore = extractFileFingerprint(statBefore);
      const hash = crypto.createHash('sha256');
      const chunks: Buffer[] = [];
      let totalRead = 0;
      const buf = Buffer.allocUnsafe(64 * 1024);
      let bytesRead = 0;
      while ((bytesRead = fs.readSync(fileFd, buf, 0, buf.length, null)) > 0) {
        totalRead += bytesRead;
        if (opts.maxBytes !== undefined && totalRead > opts.maxBytes) {
          throw new PathContainmentError(`ファイルサイズが上限（${opts.maxBytes} bytes）を超えています。`);
        }
        const slice = Buffer.from(buf.subarray(0, bytesRead));
        chunks.push(slice);
        hash.update(slice);
      }

      const statAfter = fs.fstatSync(fileFd, { bigint: true });
      const fpAfter = extractFileFingerprint(statAfter);
      const lstatTarget = fs.lstatSync(leafPath, { bigint: true, throwIfNoEntry: false });
      const fpLstat = lstatTarget ? extractFileFingerprint(lstatTarget) : null;

      if (
        !fingerprintsMatch(fpBefore, fpAfter) ||
        !fpLstat ||
        !fingerprintsMatch(fpBefore, fpLstat) ||
        totalRead !== fpBefore.size
      ) {
        if (attempt < maxRetries) {
          continue;
        }
        throw new ExternalConcurrentWriteError();
      }

      return {
        buffer: Buffer.concat(chunks, totalRead),
        sha256: hash.digest('hex'),
        sizeBytes: totalRead,
        fingerprint: fpAfter,
        relPath,
        absPath: path.join(rootReal, ...segments, filename),
      };
    } finally {
      if (fileFd !== null) {
        try {
          fs.closeSync(fileFd);
        } catch {
          // ignore
        }
      }
      fs.closeSync(dirFd);
    }
  }
  throw new ExternalConcurrentWriteError();
}

export function sha256Fd(fd: number): { sha256: string; sizeBytes: number } {
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  let bytesRead = 0;
  while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, offset)) > 0) {
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return { sha256: hash.digest('hex'), sizeBytes: offset };
}

export function writeWorkspaceBinaryFile(rootDir: string, relativePath: string, content: Buffer): void {
  if (!supportsWorkspaceTextWrites) {
    throw new PathContainmentError('この実行環境では ACP の作業ファイル書き込みを利用できません。');
  }

  const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NONBLOCK } = fs.constants;
  const directoryFlags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
  let directory = fs.openSync(rootDir, directoryFlags);
  try {
    const root = fs.realpathSync(`/proc/self/fd/${directory}`);
    const { resolvedPath } = resolveContainedWriteTarget(root, relativePath);
    const segments = relativeWorkspaceTarget(root, resolvedPath).split(path.sep);
    const filename = segments.pop()!;

    // Walk the resolved workspace path without following links introduced after resolution.
    for (const segment of segments) {
      const child = `/proc/self/fd/${directory}/${segment}`;
      try {
        fs.mkdirSync(child, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const next = fs.openSync(child, directoryFlags);
      fs.closeSync(directory);
      directory = next;
    }

    const parent = `/proc/self/fd/${directory}`;
    const target = `${parent}/${filename}`;
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) {
      throw new PathContainmentError('通常のファイルにのみ書き込めます。');
    }

    if (stat) {
      // Rename checks the directory's permissions. Also require write access to the file itself.
      const existing = fs.openSync(target, O_WRONLY | O_NOFOLLOW | O_NONBLOCK);
      fs.closeSync(existing);
    }

    const temporary = `${parent}/.agy-write-${crypto.randomUUID()}`;
    const fd = fs.openSync(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, stat ? stat.mode & 0o777 : 0o666);
    let replaced = false;
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
      if (stat) fs.fchmodSync(fd, stat.mode & 0o777);
      // Rename replaces the directory entry without following a concurrently introduced link.
      fs.renameSync(temporary, target);
      replaced = true;
    } finally {
      fs.closeSync(fd);
      if (!replaced) fs.rmSync(temporary, { force: true });
    }
  } finally {
    fs.closeSync(directory);
  }
}

export function writeWorkspaceTextFile(rootDir: string, relativePath: string, content: string): void {
  writeWorkspaceBinaryFile(rootDir, relativePath, Buffer.from(content, 'utf8'));
}

export function ensureUserDirs(baseRoots: {
  profilesRoot: string;
  workspacesRoot: string;
  projectsRoot: string;
  userId: string;
}): { profileDir: string; userWorkspaceRoot: string; userProjectsRoot: string } {
  const profileDir = path.join(baseRoots.profilesRoot, baseRoots.userId, 'agy-home');
  const userWorkspaceRoot = path.join(baseRoots.workspacesRoot, baseRoots.userId);
  const userProjectsRoot = path.join(baseRoots.projectsRoot, baseRoots.userId);

  for (const dir of [profileDir, userWorkspaceRoot, userProjectsRoot]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore on filesystems that don't support POSIX modes cleanly
    }
  }

  // Isolate XDG/tmp subdirs inside profileDir
  for (const sub of ['.config', '.local/share', '.local/state', '.cache', '.tmp', '.gemini', '.gemini/config/skills']) {
    fs.mkdirSync(path.join(profileDir, sub), { recursive: true, mode: 0o700 });
  }

  return { profileDir, userWorkspaceRoot, userProjectsRoot };
}

export function copyFileWithCowFallback(srcPath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
  try {
    fs.copyFileSync(srcPath, destPath, fs.constants.COPYFILE_FICLONE);
  } catch {
    fs.copyFileSync(srcPath, destPath);
  }
}

export function syncProjectFilesToWorkspace(params: {
  projectStorageDir: string;
  workspaceDir: string;
  relPaths: string[];
}): string[] {
  const contextDir = path.join(params.workspaceDir, '.project-context');
  fs.mkdirSync(contextDir, { recursive: true, mode: 0o700 });

  // Clean removed files inside .project-context when syncing explicitly
  const existingExpected = new Set(params.relPaths.map((r) => normalizeRelPath(r)));
  const walkExisting = (dir: string, prefix = '') => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkExisting(full, rel);
      } else if (entry.isFile() && !existingExpected.has(rel)) {
        fs.rmSync(full, { force: true });
      }
    }
  };
  walkExisting(contextDir);

  const syncedPaths: string[] = [];
  for (const relRaw of params.relPaths) {
    const rel = normalizeRelPath(relRaw);
    const { absPath: src } = resolveContainedExistingPath(params.projectStorageDir, rel);
    const { absPath: dst } = resolveContainedWriteTarget(contextDir, rel);
    copyFileWithCowFallback(src, dst);
    syncedPaths.push(`.project-context/${rel}`);
  }
  return syncedPaths;
}

export function detectMimeAndPreviewKind(filename: string, providedMime?: string | null): {
  mimeType: string;
  previewKind: PreviewKind;
} {
  const ext = path.extname(filename).toLowerCase();
  const guessed = (mime.lookup(filename) || providedMime || 'application/octet-stream').toLowerCase();
  const mimeType = providedMime && providedMime !== 'application/octet-stream' ? providedMime : guessed;

  if (ext === '.svg' || mimeType === 'image/svg+xml') return { mimeType: 'image/svg+xml', previewKind: 'svg' };
  if (mimeType.startsWith('image/')) return { mimeType, previewKind: 'image' };
  if (ext === '.pdf' || mimeType === 'application/pdf') return { mimeType: 'application/pdf', previewKind: 'pdf' };
  if (ext === '.docx') return { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', previewKind: 'docx' };
  if (ext === '.pptx' || ext === '.ppt' || ext === '.odp') return { mimeType, previewKind: 'pptx' };
  if (ext === '.csv' || ext === '.tsv' || ext === '.xlsx') return { mimeType, previewKind: 'table' };
  if (ext === '.html' || ext === '.htm') return { mimeType: 'text/html', previewKind: 'html' };
  if (ext === '.mmd' || ext === '.mermaid') return { mimeType: 'text/plain', previewKind: 'mermaid' };
  if (ext === '.diff' || ext === '.patch') return { mimeType: 'text/x-diff', previewKind: 'diff' };
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return { mimeType: 'text/markdown', previewKind: 'markdown' };
  const codeOrTextExts = new Set([
    '.txt', '.log', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini', '.env', '.conf',
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh', '.bash', '.zsh', '.sql', '.css',
    '.scss', '.less', '.rs', '.go', '.java', '.kt', '.c', '.cpp', '.h', '.hpp', '.rb', '.php',
    '.swift', '.dockerfile', '.gitignore',
  ]);
  if (codeOrTextExts.has(ext)) {
    const resolvedMime =
      ext === '.ts' || ext === '.tsx'
        ? 'text/typescript'
        : mimeType === 'application/octet-stream'
          ? 'text/plain'
          : mimeType;
    return { mimeType: resolvedMime, previewKind: 'code' };
  }
  if (mimeType.startsWith('audio/')) return { mimeType, previewKind: 'audio' };
  if (mimeType.startsWith('video/')) return { mimeType, previewKind: 'video' };
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
    return { mimeType, previewKind: 'code' };
  }
  return { mimeType, previewKind: 'binary' };
}

export function sha256File(absPath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256FileAsync(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export interface WorkspaceTreeEntry {
  relPath: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  updatedAt: number;
  isProjectContext: boolean;
  previewKind: PreviewKind;
  mimeType: string;
}

export function listWorkspaceFiles(workspaceDir: string, includeProjectContext = true): WorkspaceTreeEntry[] {
  const results: WorkspaceTreeEntry[] = [];
  if (!fs.existsSync(workspaceDir)) return results;
  const rootReal = fs.realpathSync(workspaceDir);

  const walk = (dir: string, prefix = '') => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (prefix === '' && (entry.name === '.agents' || entry.name === '.agent')) continue;
      if (!includeProjectContext && prefix === '' && entry.name === '.project-context') continue;
      if (entry.isSymbolicLink()) continue; // never traverse symlinks
      const full = path.join(dir, entry.name);
      let real: string;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (!real.startsWith(rootReal + path.sep)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(real, rel);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(real);
          const { mimeType, previewKind } = detectMimeAndPreviewKind(entry.name);
          const mtimeMs = Math.floor(stat.mtimeMs);
          results.push({
            relPath: rel,
            name: entry.name,
            sizeBytes: stat.size,
            mtimeMs,
            updatedAt: mtimeMs,
            isProjectContext: rel === '.project-context' || rel.startsWith('.project-context/'),
            previewKind,
            mimeType,
          });
        } catch {
          // ignore files deleted mid-walk
        }
      }
    }
  };
  walk(rootReal);
  results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return results;
}
