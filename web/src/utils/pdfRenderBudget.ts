/**
 * Pure PDF rendering budget, DPR capping, cancellation classification, and
 * render-job coordination helpers shared by `PdfCanvasViewer` and unit tests.
 */

export const MAX_PDF_CONCURRENT_RENDERS = 2;
export const MAX_PDF_CANVAS_DIM = 3072;
export const MAX_PDF_CANVAS_PIXELS = 6_000_000;
export const MAX_TOTAL_PDF_CANVAS_PIXELS = 24_000_000; // ~96 MiB RGBA ceiling across all live page canvases
export const PDF_OFFSCREEN_RELEASE_DISTANCE = 14;
export const MAX_PDF_PAGE_RENDER_ATTEMPTS = 2;

export function computeBoundedPdfDpr(cssWidth: number, cssHeight: number, rawDpr: number): number {
  let effectiveDpr = Math.min(rawDpr || 1, 2);
  const maxDim = Math.max(1, cssWidth, cssHeight);
  if (maxDim * effectiveDpr > MAX_PDF_CANVAS_DIM) {
    effectiveDpr = Math.min(effectiveDpr, MAX_PDF_CANVAS_DIM / maxDim);
  }
  const pixelArea = Math.max(1, cssWidth * cssHeight);
  if (pixelArea * effectiveDpr * effectiveDpr > MAX_PDF_CANVAS_PIXELS) {
    effectiveDpr = Math.min(effectiveDpr, Math.sqrt(MAX_PDF_CANVAS_PIXELS / pixelArea));
  }
  const floored = Math.floor(effectiveDpr * 1000) / 1000;
  return floored > 0 ? floored : Math.max(0.001, effectiveDpr);
}

export function isPdfRenderCancelledError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'RenderingCancelledException' || name === 'AbortError';
}

export interface LivePdfCanvasEntry {
  pageNum: number;
  pixels: number;
}

/**
 * Selects offscreen PDF page canvases to release so total backing pixels across
 * all live `<canvas>` elements stay within `maxTotalPixels` (regardless of whether
 * `numPages <= 20` or `numPages > 20`), and releases very far offscreen pages on
 * long documents.
 *
 * Currently visible pages and `anchorPage` are prioritized and preserved.
 */
export function selectPdfCanvasesToRelease(
  liveCanvases: readonly LivePdfCanvasEntry[],
  visiblePages: ReadonlySet<number>,
  anchorPage: number,
  numPages: number,
  maxTotalPixels = MAX_TOTAL_PDF_CANVAS_PIXELS,
  farReleaseDistance = PDF_OFFSCREEN_RELEASE_DISTANCE
): number[] {
  const toRelease = new Set<number>();
  let remainingPixels = 0;

  // 1. On long PDFs, release very far offscreen pages immediately
  for (const entry of liveCanvases) {
    if (entry.pixels <= 0) continue;
    const isProtected = entry.pageNum === anchorPage || visiblePages.has(entry.pageNum);
    if (!isProtected && numPages > 20 && Math.abs(entry.pageNum - anchorPage) > farReleaseDistance) {
      toRelease.add(entry.pageNum);
    } else {
      remainingPixels += entry.pixels;
    }
  }

  if (remainingPixels <= maxTotalPixels) {
    return Array.from(toRelease);
  }

  // 2. Enforce pixel memory budget by releasing furthest non-visible canvases first
  const offscreenCandidates = liveCanvases
    .filter(
      (entry) =>
        entry.pixels > 0 &&
        !toRelease.has(entry.pageNum) &&
        entry.pageNum !== anchorPage &&
        !visiblePages.has(entry.pageNum)
    )
    .sort((a, b) => {
      const distDiff = Math.abs(b.pageNum - anchorPage) - Math.abs(a.pageNum - anchorPage);
      if (distDiff !== 0) return distDiff;
      return b.pixels - a.pixels;
    });

  for (const entry of offscreenCandidates) {
    if (remainingPixels <= maxTotalPixels) break;
    toRelease.add(entry.pageNum);
    remainingPixels -= entry.pixels;
  }

  return Array.from(toRelease);
}

export interface DrawBitmapResult {
  drew: boolean;
  releasedUnadoptedBitmap: boolean;
}

/**
 * Draws a rendered PDF bitmap onto a display canvas and enforces single-owner
 * resource cleanup when the bitmap was NOT retained by the LRU cache.
 */
export function commitPdfBitmapToCanvas(
  canvas: HTMLCanvasElement | null,
  entry: { bitmap: ImageBitmap | HTMLCanvasElement; cssWidth: number; cssHeight: number },
  adoptedByCache: boolean
): DrawBitmapResult {
  let drew = false;
  try {
    if (canvas) {
      if (canvas.width !== entry.bitmap.width) canvas.width = entry.bitmap.width;
      if (canvas.height !== entry.bitmap.height) canvas.height = entry.bitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(entry.bitmap, 0, 0);
        drew = true;
      }
    }
  } finally {
    if (!adoptedByCache) {
      closeBitmapIfOwned(entry.bitmap);
    }
  }
  return {
    drew,
    releasedUnadoptedBitmap: !adoptedByCache,
  };
}

export function closeBitmapIfOwned(bitmap: ImageBitmap | HTMLCanvasElement): void {
  if (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap) {
    try {
      bitmap.close();
    } catch {
      // already closed
    }
  } else if (typeof HTMLCanvasElement !== 'undefined' && bitmap instanceof HTMLCanvasElement) {
    bitmap.width = 0;
    bitmap.height = 0;
  } else if (bitmap && typeof (bitmap as { close?: unknown }).close === 'function') {
    try {
      (bitmap as { close: () => void }).close();
    } catch {
      // ignore
    }
  }
}

export interface PdfRenderJobRecord {
  jobId: number;
  pageNum: number;
  key: string;
  cancelled: boolean;
  cancel: () => void;
}

/**
 * Job-identity-safe tracker for in-flight PDF render jobs.
 * Prevents an older cancelled job's `.finally()` from deleting a newer re-enqueued
 * job for the same `(pageNum, key)` and keeps concurrency accurately bounded even
 * while cancelled jobs are still winding down.
 */
export class PdfRenderJobTracker {
  private nextJobId = 1;
  private readonly activeByPage = new Map<number, PdfRenderJobRecord>();
  private readonly runningJobs = new Set<PdfRenderJobRecord>();
  private readonly failedAttempts = new Map<string, number>();

  get runningCount(): number {
    return this.runningJobs.size;
  }

  hasActive(pageNum: number): boolean {
    return this.activeByPage.has(pageNum);
  }

  getActive(pageNum: number): PdfRenderJobRecord | undefined {
    return this.activeByPage.get(pageNum);
  }

  listActive(): PdfRenderJobRecord[] {
    return Array.from(this.activeByPage.values());
  }

  hasExceededFailures(key: string, maxAttempts = MAX_PDF_PAGE_RENDER_ATTEMPTS): boolean {
    return (this.failedAttempts.get(key) ?? 0) >= maxAttempts;
  }

  recordFailure(key: string): number {
    const next = (this.failedAttempts.get(key) ?? 0) + 1;
    this.failedAttempts.set(key, next);
    return next;
  }

  clearFailure(key: string): void {
    this.failedAttempts.delete(key);
  }

  clearAllFailures(): void {
    this.failedAttempts.clear();
  }

  get failedKeyCount(): number {
    return this.failedAttempts.size;
  }

  startJob(pageNum: number, key: string, onCancel: () => void): PdfRenderJobRecord {
    const existing = this.activeByPage.get(pageNum);
    if (existing) {
      existing.cancel();
    }

    const record: PdfRenderJobRecord = {
      jobId: this.nextJobId++,
      pageNum,
      key,
      cancelled: false,
      cancel: () => {
        if (record.cancelled) return;
        record.cancelled = true;
        if (this.activeByPage.get(pageNum) === record) {
          this.activeByPage.delete(pageNum);
        }
        onCancel();
      },
    };

    this.activeByPage.set(pageNum, record);
    this.runningJobs.add(record);
    return record;
  }

  finishJob(record: PdfRenderJobRecord): void {
    this.runningJobs.delete(record);
    if (this.activeByPage.get(record.pageNum) === record) {
      this.activeByPage.delete(record.pageNum);
    }
  }

  cancelAll(): void {
    for (const job of Array.from(this.activeByPage.values())) {
      job.cancel();
    }
    for (const job of Array.from(this.runningJobs)) {
      job.cancel();
    }
  }
}
