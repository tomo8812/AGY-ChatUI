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
