import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Computes a strong HTTP ETag from stable metadata parts.
 * Never exposes internal server paths.
 */
export function computeStrongEtag(parts: Array<string | number | bigint>): string {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(String(part));
    hash.update('\0');
  }
  return `"${hash.digest('base64url').slice(0, 27)}"`;
}

export function formatHttpDate(ms: number): string {
  const safeMs = Number.isFinite(ms) ? Math.floor(ms) : Date.now();
  return new Date(safeMs).toUTCString();
}

function splitIfNoneMatch(headerVal: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < headerVal.length; i += 1) {
    const ch = headerVal[i];
    if (ch === '"' && headerVal[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      const trimmed = current.trim();
      if (trimmed) tokens.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) tokens.push(tail);
  return tokens;
}

function normalizeWeakTag(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2).trim() : tag;
}

/**
 * Evaluates RFC 9110 conditional request headers (`If-None-Match` and `If-Modified-Since`).
 * Per RFC 9110 §13.1.3, `If-Modified-Since` is ignored whenever `If-None-Match` is present.
 */
export function isFreshRequest(
  headers: IncomingHttpHeaders,
  etag: string,
  lastModifiedMs: number
): boolean {
  if (headers.range) {
    return false;
  }

  const rawInm = headers['if-none-match'];
  if (rawInm !== undefined) {
    const combined = Array.isArray(rawInm) ? rawInm.join(',') : rawInm;
    const candidates = splitIfNoneMatch(combined);
    const normalizedCurrent = normalizeWeakTag(etag);
    return candidates.some((candidate) => {
      if (candidate === '*') return true;
      return normalizeWeakTag(candidate) === normalizedCurrent;
    });
  }

  const rawIms = headers['if-modified-since'];
  if (rawIms !== undefined && typeof rawIms === 'string') {
    const parsedIms = Date.parse(rawIms);
    if (Number.isFinite(parsedIms)) {
      const resourceSecMs = Math.floor(lastModifiedMs / 1000) * 1000;
      return resourceSecMs <= parsedIms;
    }
  }

  return false;
}
