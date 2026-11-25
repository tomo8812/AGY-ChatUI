import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectMimeAndPreviewKind,
  normalizeRelPath,
  readContainedRegularFileNoFollowStable,
} from '../files/workspace.js';
import type { PreviewKind } from '../types.js';
import type { ArtifactDependencyEntry } from './types.js';
import { canonicalJson } from './idempotency-coordinator.js';

const MAX_CSS_RECURSION_DEPTH = 5;

function isRelativeAssetRef(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (
    s.startsWith('#') ||
    s.startsWith('//') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)
  ) {
    return false;
  }
  return true;
}

function stripQueryAndHash(raw: string): string {
  return raw.split('#')[0].split('?')[0].trim();
}

function resolveRelativeFrom(baseRelPath: string, rawRef: string): string | null {
  if (!isRelativeAssetRef(rawRef)) return null;
  let clean: string;
  try {
    clean = decodeURIComponent(stripQueryAndHash(rawRef));
  } catch {
    return null;
  }
  if (!clean || /[\\\0]/.test(clean)) return null;
  const baseDir = path.posix.dirname(baseRelPath);
  const joined = baseDir === '.' ? clean : path.posix.join(baseDir, clean);
  if (joined.startsWith('..') || path.posix.isAbsolute(joined)) return null;
  try {
    return normalizeRelPath(joined);
  } catch {
    return null;
  }
}

function extractCssUrls(cssText: string): { imports: string[]; urls: string[] } {
  const imports: string[] = [];
  const urls: string[] = [];

  for (const m of cssText.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?/gi)) {
    imports.push(m[1]);
  }
  for (const m of cssText.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")\s]+))\s*\)/gi)) {
    urls.push(m[1] ?? m[2] ?? m[3]);
  }
  return { imports, urls };
}

function extractRawRefsForText(previewKind: PreviewKind, relPath: string, text: string): string[] {
  const refs: string[] = [];
  const ext = path.extname(relPath).toLowerCase();

  if (previewKind === 'html') {
    for (const m of text.matchAll(/<(?:link|script|img|source)\b[^>]*\b(?:href|src)\s*=\s*['"]([^'"]+)['"]/gi)) {
      refs.push(m[1]);
    }
    for (const m of text.matchAll(/<(?:img|source)\b[^>]*\ssrcset\s*=\s*(["'])(.*?)\1/gi)) {
      if (!m[2].includes('data:')) {
        refs.push(...m[2].split(',').map((candidate) => candidate.trim().split(/\s+/)[0]));
      }
    }
    for (const m of text.matchAll(/\sstyle\s*=\s*(["'])(.*?)\1/gi)) {
      refs.push(...extractCssUrls(m[2]).urls);
    }
    for (const m of text.matchAll(/<video\b[^>]*\bposter\s*=\s*['"]([^'"]+)['"]/gi)) {
      refs.push(m[1]);
    }
    for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      const { imports, urls } = extractCssUrls(m[1]);
      refs.push(...imports, ...urls);
    }
  } else if (previewKind === 'markdown') {
    for (const m of text.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g)) {
      refs.push(m[1].replace(/^<|>$/g, ''));
    }
  } else if (previewKind === 'svg') {
    for (const m of text.matchAll(/<image\b[^>]*\b(?:xlink:href|href)\s*=\s*['"]([^'"]+)['"]/gi)) {
      refs.push(m[1]);
    }
    for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      const { imports, urls } = extractCssUrls(m[1]);
      refs.push(...imports, ...urls);
    }
  } else if (ext === '.css') {
    const { imports, urls } = extractCssUrls(text);
    refs.push(...imports, ...urls);
  }
  return refs;
}

export interface DependencyScanResult {
  deps: ArtifactDependencyEntry[];
  depBuffers: Map<string, Buffer>;
  manifestHash: string | null;
}

/**
 * Computes relative file dependencies for HTML, CSS (recursive depth 5, cycle-safe), Markdown, and SVG.
 */
export function scanArtifactDependencies(params: {
  rootDir: string;
  relPath: string;
  previewKind: PreviewKind;
  contentBuffer: Buffer;
}): DependencyScanResult {
  const ext = path.extname(params.relPath).toLowerCase();
  const supportsDeps =
    params.previewKind === 'html' ||
    params.previewKind === 'markdown' ||
    params.previewKind === 'svg' ||
    ext === '.css';

  if (!supportsDeps || !fs.existsSync(params.rootDir)) {
    return { deps: [], depBuffers: new Map(), manifestHash: null };
  }

  const visited = new Set<string>([normalizeRelPath(params.relPath)]);
  const entries = new Map<string, ArtifactDependencyEntry>();
  const depBuffers = new Map<string, Buffer>();

  const visitRefs = (sourceRelPath: string, previewKind: PreviewKind, text: string, cssDepth: number) => {
    const rawRefs = extractRawRefsForText(previewKind, sourceRelPath, text);
    for (const raw of rawRefs) {
      const resolvedRel = resolveRelativeFrom(sourceRelPath, raw);
      if (!resolvedRel) continue;
      if (resolvedRel === normalizeRelPath(params.relPath)) continue;
      if (entries.has(resolvedRel)) continue;

      const { mimeType } = detectMimeAndPreviewKind(path.basename(resolvedRel));
      try {
        const read = readContainedRegularFileNoFollowStable(params.rootDir, resolvedRel, {
          maxBytes: 25 * 1024 * 1024,
        });
        entries.set(resolvedRel, {
          relPath: resolvedRel,
          status: 'present',
          sha256: read.sha256,
          blobSha256: read.sha256,
          sizeBytes: read.sizeBytes,
          mimeType,
        });
        depBuffers.set(resolvedRel, read.buffer);

        // Recurse into CSS up to depth 5 with cycle guard
        if (
          path.extname(resolvedRel).toLowerCase() === '.css' &&
          cssDepth < MAX_CSS_RECURSION_DEPTH &&
          !visited.has(resolvedRel)
        ) {
          visited.add(resolvedRel);
          visitRefs(resolvedRel, 'code', read.buffer.toString('utf8'), cssDepth + 1);
        }
      } catch {
        entries.set(resolvedRel, {
          relPath: resolvedRel,
          status: 'missing',
          sha256: null,
          blobSha256: null,
          sizeBytes: 0,
          mimeType,
        });
      }
    }
  };

  visitRefs(normalizeRelPath(params.relPath), params.previewKind, params.contentBuffer.toString('utf8'), 0);

  if (entries.size === 0) {
    return { deps: [], depBuffers, manifestHash: null };
  }

  const sortedDeps = [...entries.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const manifestHash = crypto
    .createHash('sha256')
    .update(
      canonicalJson(
        sortedDeps.map((d) => ({
          relPath: d.relPath,
          status: d.status,
          sha256: d.sha256,
        }))
      )
    )
    .digest('hex');

  return { deps: sortedDeps, depBuffers, manifestHash };
}
