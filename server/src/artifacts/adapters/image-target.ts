import { imageSize } from 'image-size';
import type { TargetSelector } from '../types.js';
import { sha256Text } from './base.js';

function webpOrientation(buffer: Buffer): number | undefined {
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > buffer.length) return undefined;
    if (buffer.toString('ascii', offset, offset + 4) === 'EXIF') {
      let start = offset + 8;
      if (buffer.toString('ascii', start, start + 6) === 'Exif\0\0') start += 6;
      if (start + 8 > end) return undefined;
      const exif = buffer.subarray(start, end);
      const endian = exif.toString('ascii', 0, 2);
      if (endian !== 'II' && endian !== 'MM') return undefined;
      const u16 = (index: number) => endian === 'II' ? exif.readUInt16LE(index) : exif.readUInt16BE(index);
      const u32 = (index: number) => endian === 'II' ? exif.readUInt32LE(index) : exif.readUInt32BE(index);
      if (u16(2) !== 42) return undefined;
      const ifd = u32(4);
      if (ifd < 8 || ifd + 2 > exif.length) return undefined;
      const last = ifd + 2 + 12 * u16(ifd);
      if (last > exif.length) return undefined;
      for (let entry = ifd + 2; entry < last; entry += 12) {
        if (u16(entry) === 0x112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) return u16(entry + 8);
      }
      return undefined;
    }
    offset = end + (length % 2);
  }
  return undefined;
}

export function readImageDimensions(buffer: Buffer) {
  try {
    const info = imageSize(buffer);
    const { width, height, type } = info;
    const orientation = info.orientation ?? (type === 'webp' ? webpOrientation(buffer) : undefined);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null;
    const turned = orientation !== undefined && orientation >= 5 && orientation <= 8;
    return { widthPx: turned ? height : width, heightPx: turned ? width : height, orientation, imageType: type };
  } catch {
    return null;
  }
}

export function describeImageRegion(selector: TargetSelector, image: { widthPx: number; heightPx: number }, sha256: string) {
  const { widthPx, heightPx } = image;
  let coordinates: unknown;
  let bounds: [number, number, number, number];
  if (selector.kind === 'image_pin') {
    const [x, y] = [Number(selector.xNorm), Number(selector.yNorm)];
    coordinates = [x, y];
    bounds = [x, y, x, y];
  } else if (selector.kind === 'image_rect') {
    const [x, y, w, h] = [selector.xNorm, selector.yNorm, selector.wNorm, selector.hNorm].map(Number);
    coordinates = [x, y, w, h];
    bounds = [x, y, x + w, y + h];
    if (w <= 0 || h <= 0) return null;
  } else if (selector.kind === 'image_freeform' && Array.isArray(selector.pointsNorm)) {
    bounds = [1, 1, 0, 0];
    for (const point of selector.pointsNorm) {
      if (!Array.isArray(point) || point.length !== 2) return null;
      const [x, y] = point;
      if (![x, y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) return null;
      bounds = [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)];
    }
    if (selector.pointsNorm.length < 3 || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return null;
    coordinates = selector.pointsNorm;
  } else {
    return null;
  }
  if (!bounds.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  const [left, top, right, bottom] = bounds;
  const x = Math.min(widthPx - 1, Math.floor(left * widthPx));
  const y = Math.min(heightPx - 1, Math.floor(top * heightPx));
  const region = {
    x, y, width: Math.max(1, Math.ceil(right * widthPx) - x), height: Math.max(1, Math.ceil(bottom * heightPx) - y),
    unit: 'px' as const,
  };
  // A byte-identical source fixes all image pixels. Bind the normalized
  // coordinates and EXIF-oriented pixel bounds to that source without a PNG encoder.
  return {
    expectedImageSha256: sha256, expectedWidthPx: widthPx, expectedHeightPx: heightPx,
    expectedRegionSha256: sha256Text(JSON.stringify(['image-region-v1', sha256, widthPx, heightPx, selector.kind, coordinates, region])),
    region,
  };
}
