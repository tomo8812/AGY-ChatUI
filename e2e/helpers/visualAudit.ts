import zlib from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, 4 bytes per pixel
}

export interface RectPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RectPt {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualMetrics {
  ssim: number;
  mae: number;
  maxChannelDiff: number;
  pixelCount: number;
}

export interface RegionAuditSpec {
  id: string;
  label: string;
  rectPx: RectPx;
  minSsim?: number;
  maxMae?: number;
}

export interface RegionAuditResult {
  id: string;
  label: string;
  rectPx: RectPx;
  metrics: VisualMetrics;
  passed: boolean;
  reason?: string;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Minimal, pure-Node PNG decoder supporting 8-bit grayscale, RGB, palette, and RGBA PNGs
 * (non-interlaced), used for deterministic whole-slide and bbox-region visual audits.
 */
export function decodePng(buf: Buffer): RgbaImage {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(sig)) {
    throw new Error('Invalid PNG signature');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatChunks: Buffer[] = [];

  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) break;

    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      const interlace = buf[dataStart + 12];
      if (bitDepth !== 8 || interlace !== 0) {
        throw new Error(`Unsupported PNG format: bitDepth=${bitDepth} interlace=${interlace}`);
      }
    } else if (type === 'PLTE') {
      palette = new Uint8Array(buf.subarray(dataStart, dataEnd));
    } else if (type === 'tRNS') {
      trns = new Uint8Array(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!width || !height || idatChunks.length === 0) {
    throw new Error('Incomplete PNG image');
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * bpp;
  const recon = new Uint8Array(height * stride);

  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos++];
    const rowOff = y * stride;
    const prevOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const byte = raw[inPos++];
      const a = x >= bpp ? recon[rowOff + x - bpp] : 0;
      const b = y > 0 ? recon[prevOff + x] : 0;
      const c = y > 0 && x >= bpp ? recon[prevOff + x - bpp] : 0;
      let val = byte;
      if (filter === 1) val = (byte + a) & 0xff;
      else if (filter === 2) val = (byte + b) & 0xff;
      else if (filter === 3) val = (byte + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (byte + paethPredictor(a, b, c)) & 0xff;
      recon[rowOff + x] = val;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (colorType === 6) {
      rgba[o] = recon[o];
      rgba[o + 1] = recon[o + 1];
      rgba[o + 2] = recon[o + 2];
      rgba[o + 3] = recon[o + 3];
    } else if (colorType === 2) {
      const s = i * 3;
      rgba[o] = recon[s];
      rgba[o + 1] = recon[s + 1];
      rgba[o + 2] = recon[s + 2];
      rgba[o + 3] = 255;
    } else if (colorType === 0) {
      const v = recon[i];
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 255;
    } else if (colorType === 4) {
      const s = i * 2;
      const v = recon[s];
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = recon[s + 1];
    } else if (colorType === 3 && palette) {
      const idx = recon[i];
      rgba[o] = palette[idx * 3] ?? 0;
      rgba[o + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[o + 2] = palette[idx * 3 + 2] ?? 0;
      rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, data: rgba };
}

/**
 * Bilinear resize to align reference image dimensions with actual screenshot dimensions.
 */
export function resizeRgba(src: RgbaImage, dstWidth: number, dstHeight: number): RgbaImage {
  if (src.width === dstWidth && src.height === dstHeight) return src;
  const out = new Uint8Array(dstWidth * dstHeight * 4);
  const scaleX = src.width / dstWidth;
  const scaleY = src.height / dstHeight;
  for (let y = 0; y < dstHeight; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dstWidth; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * src.width + x0) * 4;
      const i10 = (y0 * src.width + x1) * 4;
      const i01 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const o = (y * dstWidth + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src.data[i00 + c] * (1 - wx) + src.data[i10 + c] * wx;
        const bot = src.data[i01 + c] * (1 - wx) + src.data[i11 + c] * wx;
        out[o + c] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return { width: dstWidth, height: dstHeight, data: out };
}

export function clampRectPx(rect: RectPx, width: number, height: number): RectPx {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(rect.x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(rect.y)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(rect.x + rect.width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(rect.y + rect.height)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function ptBoundsToPx(
  boundsPt: RectPt,
  slideSizePt: { widthPt: number; heightPt: number },
  imageSizePx: { width: number; height: number },
  padPx = 2,
): RectPx {
  const sx = imageSizePx.width / slideSizePt.widthPt;
  const sy = imageSizePx.height / slideSizePt.heightPt;
  return clampRectPx(
    {
      x: boundsPt.x * sx - padPx,
      y: boundsPt.y * sy - padPx,
      width: boundsPt.width * sx + padPx * 2,
      height: boundsPt.height * sy + padPx * 2,
    },
    imageSizePx.width,
    imageSizePx.height,
  );
}

/**
 * Compute SSIM (on luma channel) and RGB MAE over a specific pixel rectangle.
 * Both images must have matching dimensions.
 */
export function computeRegionMetrics(actual: RgbaImage, expected: RgbaImage, rect?: RectPx): VisualMetrics {
  const alignedExpected = expected.width === actual.width && expected.height === actual.height
    ? expected
    : resizeRgba(expected, actual.width, actual.height);
  const box = rect
    ? clampRectPx(rect, actual.width, actual.height)
    : { x: 0, y: 0, width: actual.width, height: actual.height };

  const count = box.width * box.height;
  if (count <= 0) {
    return { ssim: 1, mae: 0, maxChannelDiff: 0, pixelCount: 0 };
  }

  let absDiffSum = 0;
  let maxChannelDiff = 0;
  let sumA = 0;
  let sumB = 0;
  const lumaA = new Float64Array(count);
  const lumaB = new Float64Array(count);

  let idx = 0;
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const o = (y * actual.width + x) * 4;
      const rA = actual.data[o], gA = actual.data[o + 1], bA = actual.data[o + 2];
      const rB = alignedExpected.data[o], gB = alignedExpected.data[o + 1], bB = alignedExpected.data[o + 2];
      const dr = Math.abs(rA - rB);
      const dg = Math.abs(gA - gB);
      const db = Math.abs(bA - bB);
      absDiffSum += dr + dg + db;
      if (dr > maxChannelDiff) maxChannelDiff = dr;
      if (dg > maxChannelDiff) maxChannelDiff = dg;
      if (db > maxChannelDiff) maxChannelDiff = db;
      const yA = 0.299 * rA + 0.587 * gA + 0.114 * bA;
      const yB = 0.299 * rB + 0.587 * gB + 0.114 * bB;
      lumaA[idx] = yA;
      lumaB[idx] = yB;
      sumA += yA;
      sumB += yB;
      idx++;
    }
  }

  const mae = absDiffSum / (count * 3);
  const meanA = sumA / count;
  const meanB = sumB / count;
  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let i = 0; i < count; i++) {
    const da = lumaA[i] - meanA;
    const db = lumaB[i] - meanB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }
  varA /= count;
  varB /= count;
  cov /= count;

  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const ssim = ((2 * meanA * meanB + c1) * (2 * cov + c2)) / ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2));

  return {
    ssim: Math.max(-1, Math.min(1, ssim)),
    mae,
    maxChannelDiff,
    pixelCount: count,
  };
}

/**
 * Audit every element/region bbox individually so whole-slide SSIM cannot mask
 * a local visual breakdown (misaligned ink/geom bounds, clipped group, bad shadow/opacity,
 * wrong Z-order, or residual ghost after move/delete).
 */
export function auditRegions(
  actual: RgbaImage,
  expected: RgbaImage,
  regions: RegionAuditSpec[],
  defaults = { minSsim: 0.88, maxMae: 8.5 },
): {
  wholeSlide: VisualMetrics;
  regions: RegionAuditResult[];
  allPassed: boolean;
  failedRegions: RegionAuditResult[];
} {
  const alignedExpected = expected.width === actual.width && expected.height === actual.height
    ? expected
    : resizeRgba(expected, actual.width, actual.height);
  const wholeSlide = computeRegionMetrics(actual, alignedExpected);
  const results: RegionAuditResult[] = regions.map((spec) => {
    const rectPx = clampRectPx(spec.rectPx, actual.width, actual.height);
    const metrics = computeRegionMetrics(actual, alignedExpected, rectPx);
    const minSsim = spec.minSsim ?? defaults.minSsim;
    const maxMae = spec.maxMae ?? defaults.maxMae;
    const ssimApplies = rectPx.width >= 8 && rectPx.height >= 8;
    const passed = metrics.mae <= maxMae && (!ssimApplies || metrics.ssim >= minSsim);
    return {
      id: spec.id,
      label: spec.label,
      rectPx,
      metrics,
      passed,
      ...(passed
        ? {}
        : {
            reason: `Region '${spec.label}' failed visual audit (SSIM=${metrics.ssim.toFixed(4)} < ${minSsim} or MAE=${metrics.mae.toFixed(2)} > ${maxMae})`,
          }),
    };
  });
  const failedRegions = results.filter((r) => !r.passed);
  return {
    wholeSlide,
    regions: results,
    allPassed: wholeSlide.ssim >= 0.95 && wholeSlide.mae <= 5.0 && failedRegions.length === 0,
    failedRegions,
  };
}
