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

export function resolveContainedWriteTarget(rootDir: string, relPathRaw: string): {
  absPath: string;
  relPath: string;
} {
  const rel = normalizeRelPath(relPathRaw);
  const rootReal = fs.realpathSync(rootDir);
  const targetAbs = path.resolve(rootReal, rel);
  const relative = path.relative(rootReal, targetAbs);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathContainmentError('不正な書き込み先パスです。');
  }

  // Reject links that point outside the workspace or cannot be resolved.
  const segments = relative.split(path.sep);
  let walk = rootReal;
  for (const segment of segments) {
    walk = path.join(walk, segment);
    const stat = fs.lstatSync(walk, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      try {
        resolveContainedExistingPath(rootReal, walk);
      } catch {
        throw new PathContainmentError('作業領域内で解決できないシンボリックリンクへの書き込みは拒否されました。');
      }
    }
  }
  return { absPath: targetAbs, relPath: rel };
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
  if (mimeType.startsWith('audio/')) return { mimeType, previewKind: 'audio' };
  if (mimeType.startsWith('video/')) return { mimeType, previewKind: 'video' };

  const codeOrTextExts = new Set([
    '.txt', '.log', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini', '.env', '.conf',
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh', '.bash', '.zsh', '.sql', '.css',
    '.scss', '.less', '.rs', '.go', '.java', '.kt', '.c', '.cpp', '.h', '.hpp', '.rb', '.php',
    '.swift', '.dockerfile', '.gitignore',
  ]);
  if (codeOrTextExts.has(ext) || mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
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
