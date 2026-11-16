import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactRecord, WorkspaceFileEntry } from '../../web/src/types';
import {
  artifactTextCache,
  buildArtifactContentUrl,
  buildArtifactSandboxUrl,
  buildWorkspaceTree,
  ByteLruCache,
  clearAllViewerCaches,
  codeHighlightCache,
  invalidateChatViewerCache,
  loadWorkspaceCached,
  markWorkspaceDirty,
  notifyArtifactUpdated,
  pdfBytesCache,
  peekResolvedLink,
  resolveLinkCached,
  seedChatArtifacts,
  setViewerCacheUser,
  setWorkspaceFolderExpanded,
  getCachedWorkspace,
  getWorkspaceFolderExpandedMap,
  normalizeClientLinkReference,
  skillFileCache,
  subscribeArtifactUpdates,
} from '../../web/src/utils/viewerCache';

function makeArtifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'art-1',
    chatId: 'chat-1',
    relPath: 'sub/chart.png',
    filename: 'chart.png',
    mimeType: 'image/png',
    previewKind: 'image',
    sizeBytes: 1024,
    sha256: 'aaaaaaaaaaaa1111111111112222222222223333333333334444444444445555',
    diffPatch: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('viewerCache client caching & LRU utilities', () => {
  afterEach(() => {
    clearAllViewerCaches();
    setViewerCacheUser(null);
  });

  it('enforces maxEntries, maxBytes, maxSingleEntryBytes, LRU order, and onEvict in ByteLruCache', () => {
    const evicted: string[] = [];
    const cache = new ByteLruCache<string, string>({
      maxEntries: 3,
      maxBytes: 2048,
      maxSingleEntryBytes: 1200,
      sizeOf: (v) => v.length,
      onEvict: (k) => evicted.push(k),
    });

    cache.set('a', 'x'.repeat(700));
    cache.set('b', 'x'.repeat(700));
    expect(cache.entryCount).toBe(2);
    expect(cache.totalBytes).toBe(1400);

    // Access 'a' so 'b' becomes LRU
    expect(cache.get('a')).toBe('x'.repeat(700));
    // Peek does NOT change LRU order
    expect(cache.peek('b')).toBe('x'.repeat(700));

    // Inserting 'c' triggers byte eviction of 'b' (since 1400+700 > 2048)
    cache.set('c', 'x'.repeat(700));
    expect(evicted).toEqual(['b']);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);

    // Oversized item is skipped without flushing healthy items
    cache.set('giant', 'x'.repeat(1500));
    expect(cache.has('giant')).toBe(false);
    expect(cache.entryCount).toBe(2);
  });

  it('normalizes client workspace link references and rejects external or API URLs', () => {
    expect(normalizeClientLinkReference('./sub//report.md#L10-L25')).toBe('sub/report.md');
    expect(normalizeClientLinkReference('/workspace/src/main.ts:42:9')).toBe('src/main.ts');
    expect(normalizeClientLinkReference('file:///workspace/assets/diagram.svg')).toBe('assets/diagram.svg');
    expect(normalizeClientLinkReference('https://example.com/a.png')).toBeNull();
    expect(normalizeClientLinkReference('/api/files/123/content')).toBeNull();
    expect(normalizeClientLinkReference('blob:http://localhost/123')).toBeNull();
  });

  it('builds versioned content/sandbox/convertedPdf URLs properly', () => {
    const png = makeArtifact({ id: 'a1', previewKind: 'image', sha256: '0123456789abcdef0000' });
    expect(buildArtifactContentUrl(png)).toBe('/api/files/a1/content?v=0123456789ab');
    expect(buildArtifactContentUrl(png, { download: true })).toBe('/api/files/a1/content?download=1');

    const pptx = makeArtifact({ id: 'a2', previewKind: 'pptx', sha256: 'fedcba9876540000' });
    expect(buildArtifactContentUrl(pptx, { convertedPdf: true })).toBe(
      '/api/files/a2/content?converted=pdf&v=fedcba987654'
    );

    const html = makeArtifact({ id: 'a3', previewKind: 'html', sha256: 'abc123def4560000' });
    expect(buildArtifactSandboxUrl(html)).toBe('/api/files/a3/sandbox?v=abc123def456');
  });

  it('deduplicates concurrent resolveLinkCached calls and keeps aliased cache keys in sync on updates', async () => {
    setViewerCacheUser('user-a');
    const v1 = makeArtifact({ id: 'art-1', relPath: 'sub/chart.png', sha256: '111111111111aaaa' });
    const v2 = makeArtifact({ id: 'art-1', relPath: 'sub/chart.png', sha256: '222222222222bbbb', updatedAt: 2000 });

    const fetcher = vi.fn(async (_chatId: string, _ref: string) => ({
      artifact: v1,
      previewUrl: `/api/files/${v1.id}/content?v=${v1.sha256.slice(0, 12)}`,
      downloadUrl: `/api/files/${v1.id}/content?download=1`,
    }));

    // Concurrent calls with slightly different reference spellings share a single in-flight request
    const [r1, r2] = await Promise.all([
      resolveLinkCached('chat-1', './sub/chart.png', { fetcher }),
      resolveLinkCached('chat-1', 'sub/chart.png#L1', { fetcher }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r1.previewUrl).toBe('/api/files/art-1/content?v=111111111111');
    expect(r2.previewUrl).toBe('/api/files/art-1/content?v=111111111111');

    // Pre-populate stale payloads for v1 + another unrelated artifact 'art-other'
    artifactTextCache.set('art-1:111111111111aaaa', 'old-v1');
    codeHighlightCache.set('art-1:111111111111aaaa:hl:ts:full', { html: 'old', language: 'ts' });
    pdfBytesCache.set('/api/files/art-1/content?v=111111111111', new Uint8Array([1, 2, 3]));
    artifactTextCache.set('art-other:999999999999', 'keep-me');

    const updates: ArtifactRecord[] = [];
    const unsub = subscribeArtifactUpdates((art) => updates.push(art));

    // Re-notifying identical v1 is idempotent (emits nothing)
    notifyArtifactUpdated(v1);
    expect(updates).toHaveLength(0);

    // Updating to v2 updates aliased link entries, notifies subscribers, and purges old v1 payloads only
    notifyArtifactUpdated(v2);
    expect(updates).toEqual([v2]);
    expect(peekResolvedLink('chat-1', './sub/chart.png')?.previewUrl).toBe('/api/files/art-1/content?v=222222222222');
    expect(artifactTextCache.has('art-1:111111111111aaaa')).toBe(false);
    expect(codeHighlightCache.has('art-1:111111111111aaaa:hl:ts:full')).toBe(false);
    expect(pdfBytesCache.has('/api/files/art-1/content?v=111111111111')).toBe(false);
    expect(artifactTextCache.get('art-other:999999999999')).toBe('keep-me');
    unsub();
  });

  it('isolates viewer caches per user and invalidates deleted chats selectively', async () => {
    setViewerCacheUser('user-1');
    const a1 = makeArtifact({ id: 'art-c1', chatId: 'chat-1', relPath: 'img.png' });
    const a2 = makeArtifact({ id: 'art-c2', chatId: 'chat-2', relPath: 'img.png' });
    seedChatArtifacts('chat-1', [a1]);
    seedChatArtifacts('chat-2', [a2]);
    artifactTextCache.set('art-c1:hash', 'secret-user-1');
    skillFileCache.set('global:my-skill:SKILL.md', { relPath: 'SKILL.md', content: 'skill-body' });
    setWorkspaceFolderExpanded('chat-1', 'src', false);

    // Deleting chat-1 clears chat-1 entries while preserving chat-2
    invalidateChatViewerCache('chat-1');
    expect(peekResolvedLink('chat-1', 'img.png')).toBeNull();
    expect(getWorkspaceFolderExpandedMap('chat-1')).toEqual({});
    expect(peekResolvedLink('chat-2', 'img.png')?.artifact.id).toBe('art-c2');

    // Switching user wipes EVERYTHING
    setViewerCacheUser('user-2');
    expect(peekResolvedLink('chat-2', 'img.png')).toBeNull();
    expect(artifactTextCache.entryCount).toBe(0);
    expect(skillFileCache.entryCount).toBe(0);

    // Mid-flight resolve started under user-2 must NOT write into user-3's cache after switch
    let releaseResolve!: (val: { artifact: ArtifactRecord; previewUrl: string; downloadUrl: string }) => void;
    const inflight = resolveLinkCached('chat-9', 'leak.png', {
      fetcher: () =>
        new Promise((resolve) => {
          releaseResolve = resolve;
        }),
    });
    setViewerCacheUser('user-3');
    releaseResolve({
      artifact: makeArtifact({ id: 'leak', chatId: 'chat-9', relPath: 'leak.png' }),
      previewUrl: '/api/files/leak/content?v=123',
      downloadUrl: '/api/files/leak/content?download=1',
    });
    await inflight;
    expect(peekResolvedLink('chat-9', 'leak.png')).toBeNull();
  });

  it('deduplicates workspace loads, preserves dirty state on mid-flight mutations, and builds sorted trees', async () => {
    setViewerCacheUser('user-1');
    const sampleFiles: WorkspaceFileEntry[] = [
      { relPath: 'zeta.txt', name: 'zeta.txt', sizeBytes: 10, mtimeMs: 100, isProjectContext: false, previewKind: 'code', mimeType: 'text/plain' },
      { relPath: 'src/b.ts', name: 'b.ts', sizeBytes: 20, mtimeMs: 100, isProjectContext: false, previewKind: 'code', mimeType: 'text/typescript' },
      { relPath: 'src/nested/a.png', name: 'a.png', sizeBytes: 30, mtimeMs: 100, isProjectContext: false, previewKind: 'image', mimeType: 'image/png' },
    ];

    let resolveFetch!: (val: { files: WorkspaceFileEntry[]; artifacts: ArtifactRecord[] }) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<{ files: WorkspaceFileEntry[]; artifacts: ArtifactRecord[] }>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const p1 = loadWorkspaceCached('chat-w1', { fetcher });
    const p2 = loadWorkspaceCached('chat-w1', { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Simulate artifact creation occurring WHILE the initial workspace fetch is in flight
    markWorkspaceDirty('chat-w1');
    resolveFetch({ files: sampleFiles, artifacts: [] });

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.dirty).toBe(true);
    expect(res2.dirty).toBe(true);
    expect(getCachedWorkspace('chat-w1')?.dirty).toBe(true);

    // Next load sees dirty=true and refreshes cleanly when un-interrupted
    const clean = await loadWorkspaceCached('chat-w1', {
      fetcher: async () => ({ files: sampleFiles, artifacts: [] }),
    });
    expect(clean.dirty).toBe(false);
    expect(clean.files).toHaveLength(3);

    // Verify hierarchical tree structure & sorting (folders first, alphabetical, recursive file counts)
    const tree = buildWorkspaceTree(sampleFiles);
    expect(tree).toHaveLength(2);
    expect(tree[0].kind).toBe('folder');
    if (tree[0].kind === 'folder') {
      expect(tree[0].name).toBe('src');
      expect(tree[0].fileCount).toBe(2);
      expect(tree[0].children).toHaveLength(2);
      expect(tree[0].children[0].kind).toBe('folder');
      expect(tree[0].children[0].name).toBe('nested');
      if (tree[0].children[0].kind === 'folder') {
        expect(tree[0].children[0].fileCount).toBe(1);
        expect(tree[0].children[0].children[0].name).toBe('a.png');
      }
      expect(tree[0].children[1].kind).toBe('file');
      expect(tree[0].children[1].name).toBe('b.ts');
    }
    expect(tree[1].kind).toBe('file');
    expect(tree[1].name).toBe('zeta.txt');
  });
});
