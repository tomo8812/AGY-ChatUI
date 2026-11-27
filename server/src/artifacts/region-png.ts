import { PNG } from 'pngjs';

export function validateRegionPng(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 33 || buffer.length > 16 * 1024 * 1024) return null;
  if (!buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width < 1 || width > 8192 || height < 1 || height > 8192) return null;
  try {
    PNG.sync.read(buffer, { checkCRC: true });
    return { width, height };
  } catch {
    return null;
  }
}

export function pointRegionPt(point: Record<string, unknown>) {
  const { xPt, yPt, widthPt, heightPt } = point;
  if (typeof xPt !== 'number' || typeof yPt !== 'number' ||
      typeof widthPt !== 'number' || typeof heightPt !== 'number' ||
      ![xPt, yPt, widthPt, heightPt].every(Number.isFinite) ||
      widthPt <= 0 || heightPt <= 0 || xPt < 0 || yPt < 0 || xPt > widthPt || yPt > heightPt) return null;
  const x = Math.max(0, xPt - 36);
  const y = Math.max(0, yPt - 36);
  return { x, y, width: Math.min(widthPt, xPt + 36) - x, height: Math.min(heightPt, yPt + 36) - y, unit: 'pt' as const };
}
