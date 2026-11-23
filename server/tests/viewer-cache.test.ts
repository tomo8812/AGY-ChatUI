import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactRecord } from '../../web/src/types';
import { computePdfAutoFitScale, findActivePdfPage } from '../../web/src/utils/pdfFit';
import {
  artifactTextCache,
  buildArtifactContentUrl,
  buildArtifactSandboxUrl,
  ByteLruCache,
  clearAllViewerCaches,
  codeHighlightCache,
  invalidateChatViewerCache,
  notifyArtifactUpdated,
  pdfBytesCache,
  peekResolvedLink,
  resolveLinkCached,
  seedChatArtifacts,
  setViewerCacheUser,
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
    expect(normalizeClientLinkReference('file://example.com/workspace/private.png')).toBeNull();
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

  it('refreshes aliased links and emits updates when only filename, MIME or preview kind changes', async () => {
    setViewerCacheUser('user-a');
    let artifact = makeArtifact({ relPath: 'sub/report.bin', filename: 'report.bin', mimeType: 'application/octet-stream', previewKind: 'binary' });
    const fetcher = vi.fn(async () => ({
      artifact, previewUrl: buildArtifactContentUrl(artifact), downloadUrl: buildArtifactContentUrl(artifact, { download: true }),
    }));
    const alias = 'file:///workspace/alias/report.bin';
    await resolveLinkCached('chat-1', alias, { fetcher });
    const updated = vi.fn();
    const unsubscribe = subscribeArtifactUpdates(updated);
    try {
      for (const patch of [
        { mimeType: 'application/pdf' },
        { previewKind: 'pdf' as const },
        { filename: 'report.pdf' },
      ]) {
        artifact = { ...artifact, ...patch };
        notifyArtifactUpdated(artifact);
        expect(updated).toHaveBeenLastCalledWith(artifact);
        expect(peekResolvedLink('chat-1', alias)?.artifact).toEqual(artifact);
        expect((await resolveLinkCached('chat-1', alias, { fetcher })).artifact).toEqual(artifact);
      }
      expect(updated).toHaveBeenCalledTimes(3);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
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

    // Deleting chat-1 clears chat-1 entries while preserving chat-2
    invalidateChatViewerCache('chat-1');
    expect(peekResolvedLink('chat-1', 'img.png')).toBeNull();
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

  it('auto-fits both landscape and portrait PDFs/PPTX to the maximum contained scale across iPhone and PC viewports', () => {
    const slide16x9 = { width: 960, height: 540 };
    const wideSlide = { width: 1280, height: 720 };
    const a4Portrait = { width: 595, height: 842 };
    const a4Landscape = { width: 842, height: 595 };

    const viewports = [
      // iPhone 375x812 (PDF & PPTX with info-banner)
      { name: 'iphone375-pdf', width: 351, height: 560 },
      { name: 'iphone375-pptx', width: 351, height: 490 },
      // iPhone 430x932 (PDF & PPTX with info-banner)
      { name: 'iphone430-pdf', width: 406, height: 680 },
      { name: 'iphone430-pptx', width: 406, height: 610 },
      // PC standard viewports (1280x720, 1366x768, 1440x900, 1920x1080, 2560x1440)
      { name: 'pc-1280x720', width: 1196, height: 450 },
      { name: 'pc-1366x768', width: 1204, height: 500 },
      { name: 'pc-1440x900', width: 1204, height: 620 },
      { name: 'pc-1920x1080', width: 1204, height: 760 },
    ];

    for (const vp of viewports) {
      for (const page of [slide16x9, wideSlide, a4Portrait, a4Landscape]) {
        const scale = computePdfAutoFitScale(page, vp);
        const availW = vp.width - 24;
        const availH = vp.height - 24;
        // Must fit completely within both width and height without clipping
        expect(page.width * scale, `${vp.name} width`).toBeLessThanOrEqual(availW);
        expect(page.height * scale, `${vp.name} height`).toBeLessThanOrEqual(availH);
        // Must be the maximum 0.01-step scale that fits (next step overflows either width or height)
        const nextScale = Math.round((scale + 0.01) * 100) / 100;
        expect(
          page.width * nextScale > availW || page.height * nextScale > availH,
          `${vp.name} maximizes fit`
        ).toBe(true);
      }
    }

    // Regression guard: iPhone PPTX slide must never shrink down to 5%
    const iphonePptxScale = computePdfAutoFitScale(slide16x9, { width: 351, height: 490 });
    expect(iphonePptxScale).toBeGreaterThanOrEqual(0.3);
  });

  it('tracks the active page accurately during continuous vertical scrolling', () => {
    const rects = [
      { pageNum: 1, top: -400, bottom: 20 },
      { pageNum: 2, top: 32, bottom: 452 },
      { pageNum: 3, top: 464, bottom: 884 },
    ];
    // Container top=0, height=500, paddingTop=12 -> anchorY = 12 + 80 = 92 -> inside page 2
    expect(findActivePdfPage(0, 500, 12, rects)).toBe(2);

    // Anchor falls in the 12px gap between page 1 and page 2 -> picks closest page
    const gapRects = [
      { pageNum: 1, top: -300, bottom: 86 },
      { pageNum: 2, top: 98, bottom: 518 },
    ];
    expect(findActivePdfPage(0, 500, 12, gapRects)).toBe(1);

    // Empty page list defaults to page 1
    expect(findActivePdfPage(0, 500, 12, [])).toBe(1);
  });
});
