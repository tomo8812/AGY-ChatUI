import { api } from '../api/client';
import type {
  ArtifactRecord,
  PreviewKind,
  SkillScope,
} from '../types';

export interface ByteLruOptions<K, V> {
  maxEntries: number;
  maxBytes: number;
  maxSingleEntryBytes?: number;
  sizeOf?: (value: V, key: K) => number;
  onEvict?: (key: K, value: V) => void;
}

interface CacheNode<V> {
  value: V;
  bytes: number;
}

export class ByteLruCache<K, V> {
  private readonly store = new Map<K, CacheNode<V>>();
  private totalBytesValue = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxSingleEntryBytes: number;
  private readonly sizeOf: (value: V, key: K) => number;
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(options: ByteLruOptions<K, V>) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxBytes = Math.max(1024, options.maxBytes);
    this.maxSingleEntryBytes = options.maxSingleEntryBytes ?? Math.floor(this.maxBytes * 0.75);
    this.sizeOf = options.sizeOf ?? (() => 256);
    this.onEvict = options.onEvict;
  }

  get entryCount(): number {
    return this.store.size;
  }

  get totalBytes(): number {
    return this.totalBytesValue;
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  peek(key: K): V | undefined {
    return this.store.get(key)?.value;
  }

  get(key: K): V | undefined {
    const node = this.store.get(key);
    if (!node) return undefined;
    this.store.delete(key);
    this.store.set(key, node);
    return node.value;
  }

  set(key: K, value: V): void {
    const bytes = Math.max(1, this.sizeOf(value, key));
    if (bytes > this.maxSingleEntryBytes) {
      // Never flush useful smaller items to hold one giant file
      this.delete(key);
      return;
    }

    const existing = this.store.get(key);
    if (existing) {
      this.totalBytesValue -= existing.bytes;
      this.store.delete(key);
      if (existing.value !== value) {
        this.safeEvict(key, existing.value);
      }
    }

    this.store.set(key, { value, bytes });
    this.totalBytesValue += bytes;

    while (this.store.size > this.maxEntries || this.totalBytesValue > this.maxBytes) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      const evictKey = oldest.value;
      const evictNode = this.store.get(evictKey);
      if (!evictNode) break;
      this.store.delete(evictKey);
      this.totalBytesValue -= evictNode.bytes;
      this.safeEvict(evictKey, evictNode.value);
    }
  }

  delete(key: K): boolean {
    const existing = this.store.get(key);
    if (!existing) return false;
    this.store.delete(key);
    this.totalBytesValue -= existing.bytes;
    this.safeEvict(key, existing.value);
    return true;
  }

  deleteWhere(predicate: (key: K, value: V) => boolean): void {
    for (const [key, node] of Array.from(this.store.entries())) {
      if (predicate(key, node.value)) {
        this.store.delete(key);
        this.totalBytesValue -= node.bytes;
        this.safeEvict(key, node.value);
      }
    }
  }

  updateWhere(predicate: (key: K, value: V) => boolean, nextValue: V): void {
    const nextBytes = Math.max(1, this.sizeOf(nextValue, undefined as unknown as K));
    for (const [key, node] of Array.from(this.store.entries())) {
      if (predicate(key, node.value)) {
        this.totalBytesValue += nextBytes - node.bytes;
        this.store.set(key, { value: nextValue, bytes: nextBytes });
      }
    }
  }

  clear(): void {
    if (this.onEvict) {
      for (const [key, node] of this.store.entries()) {
        this.safeEvict(key, node.value);
      }
    }
    this.store.clear();
    this.totalBytesValue = 0;
  }

  private safeEvict(key: K, value: V): void {
    try {
      this.onEvict?.(key, value);
    } catch {
      // ignore cleanup errors on evicted GPU/DOM resources
    }
  }
}

export interface ResolvedLinkEntry {
  artifact: ArtifactRecord;
  previewUrl: string;
  downloadUrl: string;
}

export interface ParsedSheetData {
  name: string;
  rows: string[][];
}

export interface PdfCachedPage {
  bitmap: ImageBitmap | HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
}

export function fastTextHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}_${text.length}`;
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function previewKindLabel(kind: PreviewKind): string {
  switch (kind) {
    case 'image':
      return 'IMG';
    case 'svg':
      return 'SVG';
    case 'pdf':
      return 'PDF';
    case 'pptx':
      return 'PPTX';
    case 'docx':
      return 'DOCX';
    case 'table':
      return 'TBL';
    case 'markdown':
      return 'MD';
    case 'html':
      return 'HTML';
    case 'mermaid':
      return 'MMD';
    case 'diff':
      return 'DIFF';
    case 'audio':
      return 'AUD';
    case 'video':
      return 'VID';
    case 'code':
      return 'CODE';
    default:
      return 'BIN';
  }
}

const EXT_TO_HLJS_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  env: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  r: 'r',
};

export function detectCodeLanguage(filename: string): string | null {
  const lower = filename.trim().toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1);
  return EXT_TO_HLJS_LANG[ext] ?? null;
}

export function buildArtifactContentUrl(
  artifact: Pick<ArtifactRecord, 'id' | 'sha256' | 'previewKind'>,
  opts?: { download?: boolean; convertedPdf?: boolean }
): string {
  if (opts?.download) {
    return `/api/files/${artifact.id}/content?download=1`;
  }
  const qs = new URLSearchParams();
  if (opts?.convertedPdf && artifact.previewKind === 'pptx') {
    qs.set('converted', 'pdf');
  }
  if (artifact.sha256) {
    qs.set('v', artifact.sha256.slice(0, 12));
  }
  const suffix = qs.toString();
  return `/api/files/${artifact.id}/content${suffix ? `?${suffix}` : ''}`;
}

export function buildArtifactSandboxUrl(artifact: Pick<ArtifactRecord, 'id' | 'sha256'>): string {
  const suffix = artifact.sha256 ? `?v=${artifact.sha256.slice(0, 12)}` : '';
  return `/api/files/${artifact.id}/sandbox${suffix}`;
}

export function normalizeClientLinkReference(rawReference: string): string | null {
  const raw = rawReference.trim();
  if (!raw) return null;
  if (/^(?:https?:|mailto:|data:|blob:|\/api\/files\/)/i.test(raw)) {
    return null;
  }

  let candidate = raw;
  const isFileUri = /^file:\/\//i.test(candidate);
  if (/^file:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname) return null;
      candidate = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  }

  if (!isFileUri) {
    candidate = candidate.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '').trim();
  }
  if (!candidate) return null;

  if (candidate === '/workspace') return null;
  if (candidate.startsWith('/workspace/')) {
    candidate = candidate.slice('/workspace/'.length);
  }
  while (candidate.startsWith('./')) {
    candidate = candidate.slice(2);
  }
  return candidate.replace(/\/+/g, '/') || null;
}

// ---------- User-scoped viewer caches ----------

let activeCacheUserId: string | null = null;

// Per-chat known artifacts and link resolution caches
const knownArtifactsByChat = new Map<string, Map<string, ArtifactRecord>>(); // chatId -> (by id AND by normalized relPath -> ArtifactRecord)
const resolvedLinkCache = new ByteLruCache<string, ResolvedLinkEntry>({
  maxEntries: 600,
  maxBytes: 2 * 1024 * 1024,
  sizeOf: (v) => 384 + (v.artifact.diffPatch?.length ?? 0),
});
const inFlightLinkResolves = new Map<string, Promise<ResolvedLinkEntry>>();
const artifactListeners = new Set<(artifact: ArtifactRecord) => void>();

// Artifact viewer payload & parsed result caches
export const artifactTextCache = new ByteLruCache<string, string>({
  maxEntries: 60,
  maxBytes: 16 * 1024 * 1024,
  maxSingleEntryBytes: 4 * 1024 * 1024,
  sizeOf: (s) => s.length * 2,
});

export const codeHighlightCache = new ByteLruCache<string, { html: string; language: string }>({
  maxEntries: 100,
  maxBytes: 10 * 1024 * 1024,
  maxSingleEntryBytes: 2 * 1024 * 1024,
  sizeOf: (v) => v.html.length * 2 + 64,
});

export const diffPatchCache = new ByteLruCache<string, unknown>({
  maxEntries: 40,
  maxBytes: 4 * 1024 * 1024,
  sizeOf: (_v, key) => Math.max(512, key.length * 4),
});

export const tableSheetsCache = new ByteLruCache<string, ParsedSheetData[]>({
  maxEntries: 20,
  maxBytes: 14 * 1024 * 1024,
  maxSingleEntryBytes: 6 * 1024 * 1024,
  sizeOf: (sheets) => {
    let bytes = 256;
    for (const s of sheets) {
      for (const row of s.rows) {
        bytes += 24;
        for (const cell of row) {
          bytes += 12 + cell.length * 2;
        }
      }
    }
    return bytes;
  },
});

export const docxHtmlCache = new ByteLruCache<string, string>({
  maxEntries: 20,
  maxBytes: 8 * 1024 * 1024,
  sizeOf: (html) => html.length * 2,
});

export const svgMarkupCache = new ByteLruCache<string, string>({
  maxEntries: 40,
  maxBytes: 4 * 1024 * 1024,
  sizeOf: (svg) => svg.length * 2,
});

export const mermaidSvgCache = new ByteLruCache<string, string>({
  maxEntries: 60,
  maxBytes: 4 * 1024 * 1024,
  sizeOf: (svg) => svg.length * 2,
});

export const pdfBytesCache = new ByteLruCache<string, Uint8Array>({
  maxEntries: 15,
  maxBytes: 64 * 1024 * 1024,
  maxSingleEntryBytes: 24 * 1024 * 1024,
  sizeOf: (bytes) => bytes.byteLength,
});

export const pdfPageBitmapCache = new ByteLruCache<string, PdfCachedPage>({
  maxEntries: 36,
  maxBytes: 48 * 1024 * 1024,
  maxSingleEntryBytes: 12 * 1024 * 1024,
  sizeOf: (page) => Math.max(4096, page.bitmap.width * page.bitmap.height * 4),
  onEvict: (_k, page) => {
    if (typeof ImageBitmap !== 'undefined' && page.bitmap instanceof ImageBitmap) {
      page.bitmap.close();
    }
  },
});

export const skillFileCache = new ByteLruCache<string, { relPath: string; content: string }>({
  maxEntries: 60,
  maxBytes: 2 * 1024 * 1024,
  sizeOf: (v) => v.content.length * 2 + 128,
});

export function artifactVersionKey(artifact: Pick<ArtifactRecord, 'id' | 'sha256' | 'updatedAt'>): string {
  return `${artifact.id}:${artifact.sha256 || artifact.updatedAt}`;
}

export function clearAllViewerCaches(): void {
  knownArtifactsByChat.clear();
  resolvedLinkCache.clear();
  inFlightLinkResolves.clear();
  artifactTextCache.clear();
  codeHighlightCache.clear();
  diffPatchCache.clear();
  tableSheetsCache.clear();
  docxHtmlCache.clear();
  svgMarkupCache.clear();
  mermaidSvgCache.clear();
  pdfBytesCache.clear();
  pdfPageBitmapCache.clear();
  skillFileCache.clear();
}

export function setViewerCacheUser(userId: string | null): void {
  if (activeCacheUserId !== userId) {
    clearAllViewerCaches();
    activeCacheUserId = userId;
  }
}

export function invalidateChatViewerCache(chatId: string): void {
  knownArtifactsByChat.delete(chatId);
  const prefix = `${chatId}\0`;
  resolvedLinkCache.deleteWhere((k) => k.startsWith(prefix));
}

function purgeOldArtifactPayloads(artifact: Pick<ArtifactRecord, 'id' | 'sha256' | 'updatedAt'>): void {
  const currentKey = artifactVersionKey(artifact);
  const prefix = `${artifact.id}:`;
  const pdfPrefix = `/api/files/${artifact.id}/content`;
  const shortV = artifact.sha256 ? artifact.sha256.slice(0, 12) : '';
  const staleCheck = (k: string) =>
    k.startsWith(prefix) && k !== currentKey && !k.startsWith(`${currentKey}:`);
  artifactTextCache.deleteWhere(staleCheck);
  codeHighlightCache.deleteWhere(staleCheck);
  diffPatchCache.deleteWhere(staleCheck);
  tableSheetsCache.deleteWhere(staleCheck);
  docxHtmlCache.deleteWhere(staleCheck);
  svgMarkupCache.deleteWhere(staleCheck);
  pdfBytesCache.deleteWhere((k) => k.startsWith(pdfPrefix) && (!shortV || !k.includes(`v=${shortV}`)));
  pdfPageBitmapCache.deleteWhere((k) => k.startsWith(pdfPrefix) && (!shortV || !k.includes(`v=${shortV}`)));
}

function upsertKnownArtifactInternal(artifact: ArtifactRecord): { changed: boolean } {
  let chatMap = knownArtifactsByChat.get(artifact.chatId);
  if (!chatMap) {
    chatMap = new Map<string, ArtifactRecord>();
    knownArtifactsByChat.set(artifact.chatId, chatMap);
  }
  const prev = chatMap.get(artifact.id) ?? chatMap.get(`rel:${artifact.relPath}`);
  const changed =
    !prev ||
    prev.sha256 !== artifact.sha256 ||
    prev.sizeBytes !== artifact.sizeBytes ||
    prev.updatedAt !== artifact.updatedAt ||
    prev.diffPatch !== artifact.diffPatch ||
    prev.filename !== artifact.filename ||
    prev.mimeType !== artifact.mimeType ||
    prev.previewKind !== artifact.previewKind ||
    prev.relPath !== artifact.relPath;

  chatMap.set(artifact.id, artifact);
  chatMap.set(`rel:${artifact.relPath}`, artifact);

  const entry: ResolvedLinkEntry = {
    artifact,
    previewUrl: buildArtifactContentUrl(artifact),
    downloadUrl: buildArtifactContentUrl(artifact, { download: true }),
  };

  resolvedLinkCache.set(`${artifact.chatId}\0${artifact.relPath}`, entry);
  resolvedLinkCache.set(`${artifact.chatId}\0${artifact.id}`, entry);

  // Refresh any cached alias keys in this chat pointing to the same artifact ID or relPath
  const chatPrefix = `${artifact.chatId}\0`;
  resolvedLinkCache.updateWhere((key, cached) => {
    if (!key.startsWith(chatPrefix)) return false;
    const matchesSame = cached.artifact.id === artifact.id || cached.artifact.relPath === artifact.relPath;
    return matchesSame;
  }, entry);

  if (prev && (prev.sha256 !== artifact.sha256 || prev.updatedAt !== artifact.updatedAt)) {
    purgeOldArtifactPayloads(artifact);
  }

  return { changed };
}

export function seedChatArtifacts(chatId: string, artifacts: ArtifactRecord[]): void {
  if (!chatId) return;
  for (const art of artifacts) {
    const { changed } = upsertKnownArtifactInternal(art);
    if (changed) {
      emitArtifactUpdated(art);
    }
  }
}

export function notifyArtifactUpdated(artifact: ArtifactRecord): void {
  const { changed } = upsertKnownArtifactInternal(artifact);
  if (changed) {
    emitArtifactUpdated(artifact);
  }
}

function emitArtifactUpdated(artifact: ArtifactRecord): void {
  for (const listener of artifactListeners) {
    try {
      listener(artifact);
    } catch {
      // ignore listener error
    }
  }
}

export function subscribeArtifactUpdates(listener: (artifact: ArtifactRecord) => void): () => void {
  artifactListeners.add(listener);
  return () => {
    artifactListeners.delete(listener);
  };
}

export function findKnownArtifact(chatId: string | undefined, reference: string): ArtifactRecord | null {
  if (!chatId || !reference) return null;
  const chatMap = knownArtifactsByChat.get(chatId);
  if (!chatMap) return null;

  const trimmed = reference.trim();
  const directById = chatMap.get(trimmed);
  if (directById) return directById;

  const normalized = normalizeClientLinkReference(trimmed);
  if (!normalized) return null;

  return chatMap.get(normalized) ?? chatMap.get(`rel:${normalized}`) ?? null;
}

export function peekResolvedLink(chatId: string | undefined, reference: string): ResolvedLinkEntry | null {
  if (!chatId || !reference) return null;
  const normalized = normalizeClientLinkReference(reference);
  if (!normalized) return null;

  const cacheKey = `${chatId}\0${normalized}`;
  const cached = resolvedLinkCache.get(cacheKey);
  if (cached) return cached;

  const rawKey = `${chatId}\0${reference.trim()}`;
  const cachedRaw = resolvedLinkCache.get(rawKey);
  if (cachedRaw) return cachedRaw;

  const known = findKnownArtifact(chatId, reference);
  if (!known) return null;

  const derived: ResolvedLinkEntry = {
    artifact: known,
    previewUrl: buildArtifactContentUrl(known),
    downloadUrl: buildArtifactContentUrl(known, { download: true }),
  };
  resolvedLinkCache.set(cacheKey, derived);
  return derived;
}

export async function resolveLinkCached(
  chatId: string,
  reference: string,
  opts?: {
    forceRefresh?: boolean;
    fetcher?: (chatId: string, ref: string) => Promise<ResolvedLinkEntry>;
  }
): Promise<ResolvedLinkEntry> {
  const normalized = normalizeClientLinkReference(reference);
  if (!normalized) {
    throw new Error('INVALID_LINK_REFERENCE');
  }

  const cacheKey = `${chatId}\0${normalized}`;
  if (!opts?.forceRefresh) {
    const hit = peekResolvedLink(chatId, reference);
    if (hit) return hit;
  }

  const existingPromise = !opts?.forceRefresh ? inFlightLinkResolves.get(cacheKey) : undefined;
  if (existingPromise) return existingPromise;

  const capturedUser = activeCacheUserId;
  const resolveFn = opts?.fetcher ?? ((cid: string, ref: string) => api.resolveLink(cid, ref));
  const promise = resolveFn(chatId, reference)
    .then((res) => {
      const normalizedUrl = buildArtifactContentUrl(res.artifact);
      const enriched: ResolvedLinkEntry = {
        artifact: res.artifact,
        previewUrl: res.previewUrl.includes('?v=') ? res.previewUrl : normalizedUrl,
        downloadUrl: res.downloadUrl || buildArtifactContentUrl(res.artifact, { download: true }),
      };
      if (activeCacheUserId !== capturedUser) {
        return enriched;
      }
      const { changed } = upsertKnownArtifactInternal(enriched.artifact);
      resolvedLinkCache.set(cacheKey, enriched);
      if (changed) {
        emitArtifactUpdated(enriched.artifact);
      }
      return enriched;
    })
    .finally(() => {
      if (inFlightLinkResolves.get(cacheKey) === promise) {
        inFlightLinkResolves.delete(cacheKey);
      }
    });

  inFlightLinkResolves.set(cacheKey, promise);
  return promise;
}

// ---------- Skill resource cache helpers ----------

export function makeSkillFileCacheKey(params: {
  scope: SkillScope;
  slug: string;
  relPath: string;
  projectId?: string | null;
  chatId?: string | null;
}): string {
  return `${params.scope}\0${params.projectId ?? ''}\0${params.chatId ?? ''}\0${params.slug}\0${params.relPath}`;
}

export function invalidateSkillFileCache(params: {
  scope: SkillScope;
  slug: string;
  projectId?: string | null;
  chatId?: string | null;
  relPath?: string;
}): void {
  const prefix = `${params.scope}\0${params.projectId ?? ''}\0${params.chatId ?? ''}\0${params.slug}\0`;
  if (params.relPath) {
    skillFileCache.delete(`${prefix}${params.relPath}`);
  } else {
    skillFileCache.deleteWhere((k) => k.startsWith(prefix));
  }
}
