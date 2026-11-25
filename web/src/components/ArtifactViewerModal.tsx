import { ModalDialog } from './ModalDialog';
import type { StructuredPatch } from 'diff';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import type * as PdfJsTypes from 'pdfjs-dist';
import {PdfNavigationPanel} from './shared-ui/document/PdfNavigationPanel';
import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useUnifiedViewerZoom, type ZoomAnchorAdapter } from '../hooks/useUnifiedViewerZoom';
import type { ArtifactRecord, ProjectRecord } from '../types';
import {
  clampZoomScale,
  computeMediaAutoFitScale,
  computeStepZoomScale,
  MEDIA_MAX_SCALE,
  MEDIA_MIN_SCALE,
} from '../utils/contentZoom';
import {
  computePdfAutoFitScale,
  findActivePdfPage,
  PDF_MANUAL_MAX_SCALE,
  PDF_MANUAL_MIN_SCALE,
} from '../utils/pdfFit';
import {
  closeBitmapIfOwned,
  commitPdfBitmapToCanvas,
  computeBoundedPdfDpr,
  isPdfRenderCancelledError,
  MAX_PDF_CONCURRENT_RENDERS,
  MAX_TOTAL_PDF_CANVAS_PIXELS,
  PdfRenderJobTracker,
  selectPdfCanvasesToRelease,
} from '../utils/pdfRenderBudget';
import { UnifiedViewerZoomShell } from './UnifiedViewerZoomShell';
import {
  artifactTextCache,
  artifactVersionKey,
  buildArtifactContentUrl,
  buildArtifactSandboxUrl,
  codeHighlightCache,
  detectCodeLanguage,
  diffPatchCache,
  docxHtmlCache,
  formatBytesCompact,
  pdfBytesCache,
  pdfPageBitmapCache,
  svgMarkupCache,
  tableSheetsCache,
  type ParsedSheetData,
} from '../utils/viewerCache';
import { CheckIcon, ChevronIcon, CloseIcon, CopyIcon, DownloadIcon, SearchIcon } from './Icons';
import { MarkdownContent, MermaidBlock } from './MarkdownContent';

type ParsedDiff = StructuredPatch;

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
      return mod;
    });
  }
  return pdfjsPromise;
}

interface ArtifactViewerModalProps {
  artifact: ArtifactRecord;
  projects: ProjectRecord[];
  onClose: () => void;
  onCopiedToProject?: (project: ProjectRecord, filename: string) => void;
  onOpenArtifact?: (artifact: ArtifactRecord) => void;
}

const pdfScratchCanvasPool: HTMLCanvasElement[] = [];

function acquirePdfScratchCanvas(): HTMLCanvasElement {
  return pdfScratchCanvasPool.pop() ?? document.createElement('canvas');
}

function releasePdfScratchCanvas(canvas: HTMLCanvasElement): void {
  if (pdfScratchCanvasPool.length < MAX_PDF_CONCURRENT_RENDERS) {
    pdfScratchCanvasPool.push(canvas);
  }
}

function makePdfBitmapKey(url: string, pageNum: number, scale: number, dpr: number): string {
  return `${url}@p${pageNum}@s${Math.round(scale * 100)}@d${Math.round(dpr * 100)}`;
}

async function renderPdfPageToBitmap(
  doc: PdfJsTypes.PDFDocumentProxy,
  pageNum: number,
  scale: number,
  rawDpr: number,
  isCancelled: () => boolean,
  onTask?: (task: PdfJsTypes.RenderTask | null) => void
): Promise<{ bitmap: ImageBitmap | HTMLCanvasElement; cssWidth: number; cssHeight: number } | null> {
  if (isCancelled()) return null;
  const page = await doc.getPage(pageNum);
  if (isCancelled()) return null;

  const viewport = page.getViewport({ scale });
  const cssWidth = Math.max(1, Math.floor(viewport.width));
  const cssHeight = Math.max(1, Math.floor(viewport.height));
  const dpr = computeBoundedPdfDpr(cssWidth, cssHeight, rawDpr);
  const backingWidth = Math.max(1, Math.floor(cssWidth * dpr));
  const backingHeight = Math.max(1, Math.floor(cssHeight * dpr));

  const scratch = acquirePdfScratchCanvas();
  let reusedScratch = true;
  try {
    if (isCancelled()) return null;
    if (scratch.width !== backingWidth) scratch.width = backingWidth;
    if (scratch.height !== backingHeight) scratch.height = backingHeight;
    const ctx = scratch.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable');
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    const renderTask = page.render({ canvasContext: ctx, viewport, canvas: scratch });
    onTask?.(renderTask);
    if (isCancelled()) {
      renderTask.cancel();
    }
    try {
      await renderTask.promise;
    } catch (err) {
      if (isCancelled() || isPdfRenderCancelledError(err)) {
        return null;
      }
      throw err;
    } finally {
      onTask?.(null);
    }

    if (isCancelled()) return null;

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(scratch);
        if (isCancelled()) {
          closeBitmapIfOwned(bitmap);
          return null;
        }
        return { bitmap, cssWidth, cssHeight };
      } catch {
        // Fallback to dedicated canvas copy if ImageBitmap creation fails
      }
    }

    if (isCancelled()) return null;

    // Fallback when ImageBitmap is unavailable: hand off a dedicated canvas so scratch stays reusable
    const copy = document.createElement('canvas');
    copy.width = backingWidth;
    copy.height = backingHeight;
    const copyCtx = copy.getContext('2d');
    if (copyCtx) {
      copyCtx.drawImage(scratch, 0, 0);
      return { bitmap: copy, cssWidth, cssHeight };
    }
    reusedScratch = false;
    return { bitmap: scratch, cssWidth, cssHeight };
  } finally {
    if (reusedScratch) {
      releasePdfScratchCanvas(scratch);
    }
  }
}

interface PdfPageSize {
  width: number;
  height: number;
}

const DEFAULT_PDF_PAGE_SIZE: PdfPageSize = { width: 595, height: 842 };

interface PdfPageSlotProps {
  pageNum: number;
  naturalWidth: number;
  naturalHeight: number;
  autoScale: number;
  registerPageEl: (pageNum: number, slot: HTMLDivElement | null, canvas: HTMLCanvasElement | null) => void;
}

/**
 * Pure structural slot for a single PDF page.
 * Sizing is driven by CSS custom properties (`--page-w`, `--page-h`, `--page-auto-scale`,
 * and parent `--pdf-scale`), so zooming NEVER re-renders any `PdfPageSlot` or mutates
 * per-page inline styles.
 */
const PdfPageSlot: React.FC<PdfPageSlotProps> = React.memo(
  ({ pageNum, naturalWidth, naturalHeight, autoScale, registerPageEl }) => {
    const slotRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    const setSlotRef = useCallback(
      (el: HTMLDivElement | null) => {
        slotRef.current = el;
        registerPageEl(pageNum, el, canvasRef.current);
      },
      [pageNum, registerPageEl]
    );

    const setCanvasRef = useCallback(
      (el: HTMLCanvasElement | null) => {
        canvasRef.current = el;
        registerPageEl(pageNum, slotRef.current, el);
      },
      [pageNum, registerPageEl]
    );

    const slotStyle = useMemo(
      () =>
        ({
          '--page-w': `${naturalWidth}px`,
          '--page-h': `${naturalHeight}px`,
          '--page-auto-scale': String(autoScale),
        }) as React.CSSProperties,
      [naturalWidth, naturalHeight, autoScale]
    );

    return (
      <div
        ref={setSlotRef}
        className="pdf-page-slot"
        data-page-number={pageNum}
        style={slotStyle}
      >
        <canvas ref={setCanvasRef} />
      </div>
    );
  }
);

interface PdfPageFocalAnchor {
  pageNum: number;
  relX: number;
  relY: number;
}

export const PdfCanvasViewer: React.FC<{
  url: string;
  /** Stable identity enables page/zoom/scroll restoration on a newer revision. */
  documentKey?: string;
  onSelectPage?: (pageIndex: number, pageCount: number, selectedText?: string) => void;
  enhancedNavigation?: boolean;
}> = React.memo(({ url, documentKey = url, onSelectPage, enhancedNavigation=false }) => {
  const [navigation,setNavigation]=useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const pagesListRef = useRef<HTMLDivElement | null>(null);
  const [pagesListEl, setPagesListEl] = useState<HTMLDivElement | null>(null);
  const [scaleBadgeEl, setScaleBadgeEl] = useState<HTMLSpanElement | null>(null);

  const pageElementsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const canvasElementsRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const visiblePagesRef = useRef<Set<number>>(new Set([1, 2]));
  const renderedKeyByPageRef = useRef<Map<number, string>>(new Map());
  const jobTrackerRef = useRef<PdfRenderJobTracker>(new PdfRenderJobTracker());
  const isZoomInteractingRef = useRef(false);
  const programmaticScrollRef = useRef<{ targetPage: number; expiresAt: number } | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const scheduleRenderRef = useRef<() => void>(() => {});
  const pageNumRef = useRef(1);
  const loadedKeyRef = useRef<string | null>(null);
  const restoreViewRef = useRef<{ page: number; offsetY: number; scrollLeft: number } | null>(null);

  const [pdfDoc, setPdfDoc] = useState<PdfJsTypes.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [fitMode, setFitMode] = useState<'auto' | 'manual'>('auto');
  const [manualScale, setManualScale] = useState(1.0);
  const [pageSizes, setPageSizes] = useState<Array<PdfPageSize | null>>([]);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const [pageRenderErrorCount, setPageRenderErrorCount] = useState(0);
  const [loading, setLoading] = useState(true);

  pageNumRef.current = pageNum;

  const setScrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);

  const setPagesListContainerRef = useCallback((el: HTMLDivElement | null) => {
    pagesListRef.current = el;
    setPagesListEl(el);
  }, []);

  const registerPageEl = useCallback(
    (p: number, slot: HTMLDivElement | null, canvas: HTMLCanvasElement | null) => {
      if (slot) {
        pageElementsRef.current.set(p, slot);
      } else {
        pageElementsRef.current.delete(p);
      }
      if (canvas) {
        canvasElementsRef.current.set(p, canvas);
      } else {
        canvasElementsRef.current.delete(p);
      }
    },
    []
  );

  useEffect(() => {
    if (!scrollEl) return;
    const measure = () => {
      const nextW = Math.round(scrollEl.clientWidth);
      const nextH = Math.round(scrollEl.clientHeight);
      setContainerSize((prev) =>
        prev.width === nextW && prev.height === nextH ? prev : { width: nextW, height: nextH }
      );
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(scrollEl);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [scrollEl]);

  useEffect(() => {
    let active = true;
    let loadedDoc: PdfJsTypes.PDFDocumentProxy | null = null;
    const abort = new AbortController();
    const sameDocument = loadedKeyRef.current === documentKey;
    const previousPage = sameDocument ? pageNumRef.current : 1;
    if (sameDocument) {
      const sc = scrollRef.current;
      const slot = pageElementsRef.current.get(previousPage);
      if (sc && slot) {
        restoreViewRef.current = { page: previousPage,
          offsetY: slot.getBoundingClientRect().top - sc.getBoundingClientRect().top,
          scrollLeft: sc.scrollLeft };
      }
    } else {
      restoreViewRef.current = null;
    }
    loadedKeyRef.current = documentKey;
    setLoading(true);
    setError(null);
    setPageRenderErrorCount(0);
    setPdfDoc(null);
    setNumPages(0);
    if (!sameDocument) {
      setPageNum(1);
      setFitMode('auto');
      setManualScale(1.0);
    }
    setPageSizes([]);
    isZoomInteractingRef.current = false;
    programmaticScrollRef.current = null;
    pageElementsRef.current.clear();
    canvasElementsRef.current.clear();
    visiblePagesRef.current = new Set([previousPage, previousPage + 1]);
    renderedKeyByPageRef.current.clear();
    jobTrackerRef.current.cancelAll();
    jobTrackerRef.current.clearAllFailures();

    const load = async () => {
      try {
        let bytes = pdfBytesCache.get(url);
        if (!bytes) {
          const res = await fetch(url, { credentials: 'include', signal: abort.signal });
          if (!res.ok) {
            const j = await res.json().catch(() => null);
            throw new Error(j?.message || `PDF読込エラー (${res.status})`);
          }
          const buf = await res.arrayBuffer();
          bytes = new Uint8Array(buf);
          if (!active) return;
          pdfBytesCache.set(url, bytes);
        }

        const pdfjsLib = await loadPdfJs();
        if (!active) return;
        const task = pdfjsLib.getDocument({ data: bytes.slice() });
        loadedDoc = await task.promise;
        if (!active) {
          void loadedDoc.destroy();
          return;
        }
        setPdfDoc(loadedDoc);
        setNumPages(loadedDoc.numPages);
        const nextPage = Math.max(1, Math.min(loadedDoc.numPages, previousPage));
        pageNumRef.current = nextPage;
        setPageNum(nextPage);
        if (restoreViewRef.current) restoreViewRef.current.page = nextPage;
        setPageSizes(new Array<PdfPageSize | null>(loadedDoc.numPages).fill(null));
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'PDFの表示に失敗しました');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();

    return () => {
      active = false;
      abort.abort();
      jobTrackerRef.current.cancelAll();
      if (loadedDoc) void loadedDoc.destroy();
    };
  }, [url, documentKey]);

  const pendingSizeAnchorRef = useRef<{ pageNum: number; offsetTop: number } | null>(null);

  useEffect(() => {
    if (!pdfDoc || numPages <= 0) return;
    let active = true;

    const loadPageSizes = async () => {
      try {
        const firstPage = await pdfDoc.getPage(1);
        if (!active) return;
        const firstVp = firstPage.getViewport({ scale: 1 });
        const firstSize: PdfPageSize = { width: firstVp.width, height: firstVp.height };
        setPageSizes((prev) => {
          const next = prev.length === numPages ? [...prev] : new Array<PdfPageSize | null>(numPages).fill(null);
          next[0] = firstSize;
          return next;
        });

        if (numPages <= 1) return;
        const allSizes: Array<PdfPageSize | null> = new Array<PdfPageSize | null>(numPages).fill(null);
        allSizes[0] = firstSize;

        // Fetch remaining page dimensions in bounded non-blocking batches to keep UI responsive on long PDFs
        const BATCH_SIZE = 12;
        for (let start = 2; start <= numPages; start += BATCH_SIZE) {
          if (!active) return;
          const end = Math.min(numPages, start + BATCH_SIZE - 1);
          const batchNums: number[] = [];
          for (let p = start; p <= end; p += 1) batchNums.push(p);

          const batchResults = await Promise.all(
            batchNums.map(async (p) => {
              const page = await pdfDoc.getPage(p);
              const vp = page.getViewport({ scale: 1 });
              return { p, size: { width: vp.width, height: vp.height } as PdfPageSize };
            })
          );
          if (!active) return;
          for (const item of batchResults) {
            allSizes[item.p - 1] = item.size;
          }
          if (end < numPages) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          }
        }

        if (active) {
          // Capture the active page's viewport offset before applying real page sizes so
          // downstream viewing position never jumps on mixed portrait/landscape PDFs.
          const sc = scrollRef.current;
          const anchorPage = pageNumRef.current;
          const anchorSlot = pageElementsRef.current.get(anchorPage);
          if (sc && anchorSlot && sc.scrollTop > 0) {
            pendingSizeAnchorRef.current = {
              pageNum: anchorPage,
              offsetTop: anchorSlot.getBoundingClientRect().top - sc.getBoundingClientRect().top,
            };
          }
          setPageSizes(allSizes);
        }
      } catch {
        // ignore page lookup error during teardown
      }
    };

    void loadPageSizes();
    return () => {
      active = false;
    };
  }, [pdfDoc, numPages]);

  // Synchronously preserve scroll anchor when delayed page dimensions commit
  useLayoutEffect(() => {
    const anchor = pendingSizeAnchorRef.current;
    if (!anchor) return;
    pendingSizeAnchorRef.current = null;
    const sc = scrollRef.current;
    const slot = pageElementsRef.current.get(anchor.pageNum);
    if (!sc || !slot) return;
    const afterOffsetTop = slot.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    const delta = afterOffsetTop - anchor.offsetTop;
    if (Math.abs(delta) > 0.5) {
      sc.scrollTop = Math.max(0, sc.scrollTop + delta);
    }
  }, [pageSizes]);

  const fallbackPageSize = pageSizes[0] ?? DEFAULT_PDF_PAGE_SIZE;

  // Auto-fit geometry depends ONLY on pageSizes & containerSize (NOT on manualScale!)
  const pageBaseSpecs = useMemo(() => {
    return Array.from({ length: numPages }, (_, idx) => {
      const p = idx + 1;
      const natural = pageSizes[idx] ?? fallbackPageSize;
      const autoScale = computePdfAutoFitScale(natural, containerSize);
      return {
        pageNum: p,
        naturalWidth: natural.width,
        naturalHeight: natural.height,
        autoScale,
      };
    });
  }, [numPages, pageSizes, fallbackPageSize, containerSize]);

  const activeSpec = pageBaseSpecs[Math.max(0, Math.min(pageBaseSpecs.length - 1, pageNum - 1))];
  const currentAutoScale = activeSpec?.autoScale ?? computePdfAutoFitScale(pageSizes[0] ?? null, containerSize);
  const committedScale = fitMode === 'auto' ? currentAutoScale : manualScale;
  const manualMinScale = Math.min(PDF_MANUAL_MIN_SCALE, currentAutoScale);
  const readyToRender =
    Boolean(pdfDoc) &&
    (fitMode !== 'auto' || (pageSizes[0] !== null && containerSize.width > 0 && containerSize.height > 0));

  useLayoutEffect(() => {
    const anchor = restoreViewRef.current;
    const sc = scrollRef.current;
    if (!anchor || !sc || loading || !pdfDoc || !pageSizes[anchor.page - 1] || containerSize.width <= 0) return;
    const slot = pageElementsRef.current.get(anchor.page);
    if (!slot) return;
    restoreViewRef.current = null;
    programmaticScrollRef.current = { targetPage: anchor.page, expiresAt: performance.now() + 700 };
    sc.scrollTo({ top: Math.max(0, sc.scrollTop + slot.getBoundingClientRect().top - sc.getBoundingClientRect().top - anchor.offsetY),
      left: anchor.scrollLeft, behavior: 'instant' });
    pageNumRef.current = anchor.page;
    setPageNum(anchor.page);
  }, [loading, pdfDoc, pageSizes, containerSize.width, scrollEl]);

  // Single shared IntersectionObserver for all pages (replaces N observers!)
  useEffect(() => {
    if (!scrollEl || numPages <= 0) return;
    if (typeof IntersectionObserver === 'undefined') {
      const all = new Set<number>();
      for (let p = 1; p <= numPages; p += 1) all.add(p);
      visiblePagesRef.current = all;
      if (!isZoomInteractingRef.current) {
        scheduleRenderRef.current();
      }
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const p = Number((entry.target as HTMLElement).dataset.pageNumber);
          if (!Number.isFinite(p) || p < 1) continue;
          if (entry.isIntersecting) {
            if (!visiblePagesRef.current.has(p)) {
              visiblePagesRef.current.add(p);
              changed = true;
            }
          } else if (visiblePagesRef.current.has(p)) {
            visiblePagesRef.current.delete(p);
            changed = true;
          }
        }
        // Suppress renders/evictions while a GPU preview zoom gesture is actively running
        if (changed && !isZoomInteractingRef.current) {
          scheduleRenderRef.current();
        }
      },
      { root: scrollEl, rootMargin: '220px 0px' }
    );

    for (let p = 1; p <= numPages; p += 1) {
      const slot = pageElementsRef.current.get(p);
      if (slot) io.observe(slot);
    }

    return () => {
      io.disconnect();
    };
  }, [scrollEl, numPages]);

  // Prioritized PDF render scheduler with:
  // - Pause during active zoom preview gestures
  // - Strict total backing-pixel memory budget across ALL PDFs (including <= 20 pages)
  // - Single-owner bitmap cleanup when LRU cache declines an oversized entry
  // - Verified canvas 2D draw success before recording renderedScale
  // - Bounded failure retry (no infinite retry loop on corrupt pages / context failures)
  // - Job-identity-safe cancellation & concurrency accounting
  useEffect(() => {
    if (!readyToRender || !pdfDoc || numPages <= 0) return;

    let disposed = false;
    const tracker = jobTrackerRef.current;

    const getTargetScaleForPage = (p: number): number => {
      if (fitMode === 'manual') return manualScale;
      return pageBaseSpecs[p - 1]?.autoScale ?? currentAutoScale;
    };

    const enforceCanvasMemoryBudget = () => {
      const live: Array<{ pageNum: number; pixels: number }> = [];
      for (const [p, canvas] of canvasElementsRef.current.entries()) {
        const pixels = canvas.width * canvas.height;
        if (pixels > 0) {
          live.push({ pageNum: p, pixels });
        }
      }
      const releaseList = selectPdfCanvasesToRelease(
        live,
        visiblePagesRef.current,
        pageNumRef.current,
        numPages,
        MAX_TOTAL_PDF_CANVAS_PIXELS
      );
      for (const p of releaseList) {
        const canvas = canvasElementsRef.current.get(p);
        if (canvas && (canvas.width > 0 || canvas.height > 0)) {
          canvas.width = 0;
          canvas.height = 0;
        }
        renderedKeyByPageRef.current.delete(p);
        const slot = pageElementsRef.current.get(p);
        if (slot) {
          delete slot.dataset.renderedScale;
        }
      }
    };

    const pumpQueue = () => {
      if (disposed || isZoomInteractingRef.current) return;

      const rawDpr = window.devicePixelRatio || 1;
      const anchor = pageNumRef.current;

      const candidatePages = new Set<number>(visiblePagesRef.current);
      if (anchor >= 1 && anchor <= numPages) {
        candidatePages.add(anchor);
      }

      // 1. Cancel any active render jobs that are now offscreen or at an outdated scale
      for (const activeJob of tracker.listActive()) {
        const p = activeJob.pageNum;
        const targetScale = getTargetScaleForPage(p);
        const spec = pageBaseSpecs[p - 1];
        const cssW = Math.max(1, Math.floor((spec?.naturalWidth ?? DEFAULT_PDF_PAGE_SIZE.width) * targetScale));
        const cssH = Math.max(1, Math.floor((spec?.naturalHeight ?? DEFAULT_PDF_PAGE_SIZE.height) * targetScale));
        const boundedDpr = computeBoundedPdfDpr(cssW, cssH, rawDpr);
        const desiredKey = makePdfBitmapKey(url, p, targetScale, boundedDpr);
        if (!candidatePages.has(p) || activeJob.key !== desiredKey) {
          activeJob.cancel();
        }
      }

      // 2. Collect candidate pages needing render, sorted by distance from anchor
      const pending: Array<{ pageNum: number; scale: number; key: string; priority: number }> = [];
      for (const p of candidatePages) {
        const canvas = canvasElementsRef.current.get(p);
        if (!canvas) continue;
        const targetScale = getTargetScaleForPage(p);
        if (targetScale <= 0) continue;
        const spec = pageBaseSpecs[p - 1];
        const cssW = Math.max(1, Math.floor((spec?.naturalWidth ?? DEFAULT_PDF_PAGE_SIZE.width) * targetScale));
        const cssH = Math.max(1, Math.floor((spec?.naturalHeight ?? DEFAULT_PDF_PAGE_SIZE.height) * targetScale));
        const boundedDpr = computeBoundedPdfDpr(cssW, cssH, rawDpr);
        const key = makePdfBitmapKey(url, p, targetScale, boundedDpr);

        if (renderedKeyByPageRef.current.get(p) === key && canvas.width > 0) continue;
        if (tracker.hasExceededFailures(key)) continue;

        // Instant cache hit: blit synchronously and verify draw success
        const cached = pdfPageBitmapCache.get(key);
        if (cached) {
          const { drew } = commitPdfBitmapToCanvas(canvas, cached, true);
          const slot = pageElementsRef.current.get(p);
          if (drew) {
            renderedKeyByPageRef.current.set(p, key);
            tracker.clearFailure(key);
            if (slot) {
              slot.dataset.renderedScale = String(Math.round(targetScale * 100));
              delete slot.dataset.renderError;
            }
          } else {
            tracker.recordFailure(key);
            if (slot) {
              delete slot.dataset.renderedScale;
              slot.dataset.renderError = 'true';
            }
            setPageRenderErrorCount(tracker.failedKeyCount);
          }
          continue;
        }

        if (tracker.hasActive(p)) continue;

        pending.push({
          pageNum: p,
          scale: targetScale,
          key,
          priority: Math.abs(p - anchor),
        });
      }

      pending.sort((a, b) => a.priority - b.priority || a.pageNum - b.pageNum);

      // 3. Launch up to MAX_PDF_CONCURRENT_RENDERS PDF.js tasks (counting winding-down cancelled jobs too)
      for (const jobSpec of pending) {
        if (tracker.runningCount >= MAX_PDF_CONCURRENT_RENDERS) break;

        let pdfTask: PdfJsTypes.RenderTask | null = null;
        const job = tracker.startJob(jobSpec.pageNum, jobSpec.key, () => {
          pdfTask?.cancel();
        });

        const isCancelled = () => disposed || job.cancelled || isZoomInteractingRef.current;

        void renderPdfPageToBitmap(
          pdfDoc,
          jobSpec.pageNum,
          jobSpec.scale,
          rawDpr,
          isCancelled,
          (t) => {
            pdfTask = t;
            if (t && isCancelled()) {
              t.cancel();
            }
          }
        )
          .then((rendered) => {
            if (!rendered) return;
            if (isCancelled()) {
              closeBitmapIfOwned(rendered.bitmap);
              return;
            }

            pdfPageBitmapCache.set(jobSpec.key, rendered);
            const adoptedByCache = pdfPageBitmapCache.peek(jobSpec.key) === rendered;

            const canvas = canvasElementsRef.current.get(jobSpec.pageNum) ?? null;
            const slot = pageElementsRef.current.get(jobSpec.pageNum);
            const { drew } = commitPdfBitmapToCanvas(canvas, rendered, adoptedByCache);

            if (drew) {
              renderedKeyByPageRef.current.set(jobSpec.pageNum, jobSpec.key);
              tracker.clearFailure(jobSpec.key);
              if (slot) {
                slot.dataset.renderedScale = String(Math.round(jobSpec.scale * 100));
                delete slot.dataset.renderError;
              }
              setPageRenderErrorCount(tracker.failedKeyCount);
            } else {
              tracker.recordFailure(jobSpec.key);
              if (slot) {
                delete slot.dataset.renderedScale;
                slot.dataset.renderError = 'true';
              }
              setPageRenderErrorCount(tracker.failedKeyCount);
            }
          })
          .catch((err) => {
            if (isCancelled() || isPdfRenderCancelledError(err)) {
              return;
            }
            tracker.recordFailure(jobSpec.key);
            const slot = pageElementsRef.current.get(jobSpec.pageNum);
            if (slot) {
              delete slot.dataset.renderedScale;
              slot.dataset.renderError = 'true';
            }
            setPageRenderErrorCount(tracker.failedKeyCount);
          })
          .finally(() => {
            tracker.finishJob(job);
            if (!isZoomInteractingRef.current) {
              if (!disposed) {
                enforceCanvasMemoryBudget();
              }
              // Always wake the LATEST scheduler when a concurrency slot frees up,
              // even if this cancelled job came from an earlier effect closure.
              scheduleRenderRef.current();
            }
          });
      }

      enforceCanvasMemoryBudget();
    };

    scheduleRenderRef.current = pumpQueue;
    if (!isZoomInteractingRef.current) {
      pumpQueue();
    }

    return () => {
      disposed = true;
      tracker.cancelAll();
    };
  }, [readyToRender, pdfDoc, url, numPages, fitMode, manualScale, pageBaseSpecs]);

  useEffect(() => {
    return () => {
      scheduleRenderRef.current = () => {};
    };
  }, []);

  const handleRetryFailedPages = useCallback(() => {
    jobTrackerRef.current.clearAllFailures();
    setPageRenderErrorCount(0);
    for (const slot of pageElementsRef.current.values()) {
      delete slot.dataset.renderError;
    }
    scheduleRenderRef.current();
  }, []);

  const scrollToPage = useCallback(
    (targetPage: number) => {
      if (numPages <= 0) return;
      const clamped = Math.max(1, Math.min(numPages, targetPage));
      pageNumRef.current = clamped;
      setPageNum(clamped);
      programmaticScrollRef.current = { targetPage: clamped, expiresAt: performance.now() + 700 };
      const container = scrollRef.current;
      const targetEl = pageElementsRef.current.get(clamped);
      if (container && targetEl) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const paddingTop = parseFloat(window.getComputedStyle(container).paddingTop) || 0;
        const nextTop = container.scrollTop + (targetRect.top - containerRect.top) - paddingTop;
        container.scrollTo({ top: Math.max(0, nextTop), behavior: 'instant' });
      }
      if (!isZoomInteractingRef.current) {
        scheduleRenderRef.current();
      }
    },
    [numPages]
  );

  const cancelProgrammaticScrollLock = useCallback(() => {
    programmaticScrollRef.current = null;
  }, []);

  const handleGestureStart = useCallback(() => {
    programmaticScrollRef.current = null;
    isZoomInteractingRef.current = true;
    jobTrackerRef.current.cancelAll();
  }, []);

  const handleGestureEnd = useCallback(() => {
    isZoomInteractingRef.current = false;
    scheduleRenderRef.current();
  }, []);

  // O(visible) active page resolver (avoids scanning all N slots on long PDFs)
  const findNearestCandidatePages = useCallback(
    (container: HTMLDivElement): number[] => {
      const set = new Set<number>(visiblePagesRef.current);
      const cur = pageNumRef.current;
      for (let d = -2; d <= 2; d += 1) {
        const p = cur + d;
        if (p >= 1 && p <= numPages) set.add(p);
      }

      // Binary-search by offsetTop if scroll jumped rapidly past IO observations
      if (numPages > 0) {
        const targetOffset = container.scrollTop + Math.min(80, Math.max(0, container.clientHeight * 0.2));
        let lo = 1;
        let hi = numPages;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const el = pageElementsRef.current.get(mid);
          if (!el || el.offsetTop + el.offsetHeight < targetOffset) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        for (let d = -1; d <= 1; d += 1) {
          const p = lo + d;
          if (p >= 1 && p <= numPages) set.add(p);
        }
      }
      return Array.from(set).sort((a, b) => a - b);
    },
    [numPages]
  );

  const handleScroll = useCallback(() => {
    if (isZoomInteractingRef.current) return;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (isZoomInteractingRef.current) return;
      const container = scrollRef.current;
      if (!container || numPages <= 0) return;

      const lock = programmaticScrollRef.current;
      if (lock) {
        // Keep the explicitly selected page through layout and scroll events.
        // A short last page may not be able to align its top to the viewport.
        if (performance.now() < lock.expiresAt) return;
        programmaticScrollRef.current = null;
      }

      const containerRect = container.getBoundingClientRect();
      const paddingTop = parseFloat(window.getComputedStyle(container).paddingTop) || 0;
      const candidateNums = findNearestCandidatePages(container);
      const rects: Array<{ pageNum: number; top: number; bottom: number }> = [];
      for (const p of candidateNums) {
        const el = pageElementsRef.current.get(p);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        rects.push({ pageNum: p, top: r.top, bottom: r.bottom });
      }
      if (rects.length === 0) return;
      const atBottom = container.scrollHeight > container.clientHeight + 2 &&
        container.scrollHeight - container.clientHeight - container.scrollTop <= 2;
      const nextActive = atBottom && rects.some(r => r.pageNum === numPages && r.bottom > containerRect.top)
        ? numPages : findActivePdfPage(containerRect.top, container.clientHeight, paddingTop, rects);
      if (nextActive !== pageNumRef.current) {
        pageNumRef.current = nextActive;
        setPageNum(nextActive);
        scheduleRenderRef.current();
      }
    });
  }, [numPages, findNearestCandidatePages]);

  // Page-level focal anchor adapter: pins zoom center to exact normalized (relX, relY) inside
  // the actual target PDF page so mixed portrait/landscape auto-fit -> manual transitions never jump pages.
  const pdfAnchorAdapter = useMemo<ZoomAnchorAdapter<PdfPageFocalAnchor>>(
    () => ({
      capture: (clientX, clientY) => {
        const container = scrollRef.current;
        if (!container || numPages <= 0) return null;
        const candidates = findNearestCandidatePages(container);
        let bestPage = pageNumRef.current;
        let bestRect: DOMRect | null = null;
        let bestDist = Infinity;

        for (const p of candidates) {
          const el = pageElementsRef.current.get(p);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          if (clientY >= r.top && clientY <= r.bottom) {
            bestPage = p;
            bestRect = r;
            bestDist = 0;
            break;
          }
          const dist = clientY < r.top ? r.top - clientY : clientY - r.bottom;
          if (dist < bestDist) {
            bestDist = dist;
            bestPage = p;
            bestRect = r;
          }
        }

        if (!bestRect) return null;
        return {
          pageNum: bestPage,
          relX: (clientX - bestRect.left) / Math.max(1, bestRect.width),
          relY: (clientY - bestRect.top) / Math.max(1, bestRect.height),
        };
      },
      restore: (anchor, clientX, clientY) => {
        const container = scrollRef.current;
        const slot = pageElementsRef.current.get(anchor.pageNum);
        if (!container || !slot) return;
        const afterRect = slot.getBoundingClientRect();
        if (afterRect.width <= 0 || afterRect.height <= 0) return;
        const targetClientX = afterRect.left + anchor.relX * afterRect.width;
        const targetClientY = afterRect.top + anchor.relY * afterRect.height;
        programmaticScrollRef.current = { targetPage: anchor.pageNum, expiresAt: performance.now() + 700 };
        const deltaX = targetClientX - clientX;
        const deltaY = targetClientY - clientY;
        if (Math.abs(deltaX) > 0.5) {
          container.scrollLeft = Math.max(0, container.scrollLeft + deltaX);
        }
        if (Math.abs(deltaY) > 0.5) {
          container.scrollTop = Math.max(0, container.scrollTop + deltaY);
        }
        if (anchor.pageNum !== pageNumRef.current) {
          pageNumRef.current = anchor.pageNum;
          setPageNum(anchor.pageNum);
        }
      },
    }),
    [numPages, findNearestCandidatePages]
  );

  const handleCommitScale = useCallback((nextScale: number) => {
    setFitMode('manual');
    setManualScale(nextScale);
  }, []);

  const { isPanning, commitDiscreteScale, cancelActiveGesture } = useUnifiedViewerZoom({
    scrollEl,
    stageEl: pagesListEl,
    anchorAdapter: pdfAnchorAdapter,
    scaleBadgeEl,
    committedScale,
    minScale: manualMinScale,
    maxScale: PDF_MANUAL_MAX_SCALE,
    enableDragPan: true,
    dragPanMode: 'direct',
    onCommitScale: handleCommitScale,
    onGestureStart: handleGestureStart,
    onGestureEnd: handleGestureEnd,
    onPanStart: cancelProgrammaticScrollLock,
    resetKey: documentKey,
  });

  const applyStepZoom = useCallback(
    (direction: 'in' | 'out') => {
      const sc = scrollRef.current;
      const slot = pageElementsRef.current.get(pageNumRef.current);
      let x: number | undefined;
      let y: number | undefined;
      if (sc && slot) {
        const viewport = sc.getBoundingClientRect(), page = slot.getBoundingClientRect();
        const left = Math.max(viewport.left, page.left), right = Math.min(viewport.right, page.right);
        const top = Math.max(viewport.top, page.top), bottom = Math.min(viewport.bottom, page.bottom);
        if (right > left && bottom > top) {
          x = (left + right) / 2;
          y = (top + bottom) / 2;
        }
      }
      commitDiscreteScale((cur) => computeStepZoomScale(cur, direction, manualMinScale, PDF_MANUAL_MAX_SCALE), x, y);
    },
    [manualMinScale, commitDiscreteScale]
  );

  const handleResetFit = useCallback(() => {
    cancelActiveGesture();
    setFitMode('auto');
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
    }
  }, [cancelActiveGesture]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  if (loading) return <div className="viewer-state muted-sm">PDFを読み込み中...</div>;
  if (error) return <div className="error-box" role="alert">{error}</div>;

  const isManuallyZoomed = fitMode === 'manual' && committedScale > currentAutoScale + 0.01;

  return (
    <div className="pdf-viewer-wrap">
      <div className="viewer-toolbar pdf-viewer-toolbar">
        <div className="pdf-toolbar-group pdf-nav-group">
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={pageNum <= 1}
            onClick={() => scrollToPage(pageNum - 1)}
          >
            <ChevronIcon size={14} dir="left" /> 前
          </button>
          <span className="muted-xs pdf-page-indicator">
            {pageNum} / {numPages}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={pageNum >= numPages}
            onClick={() => scrollToPage(pageNum + 1)}
          >
            次 <ChevronIcon size={14} dir="right" />
          </button>
          {enhancedNavigation&&<button type="button" className="btn btn-secondary btn-xs" aria-expanded={navigation} onClick={()=>setNavigation(v=>!v)}>ナビゲーション</button>}
          {onSelectPage && <button type="button" className="btn btn-secondary btn-xs" disabled={!numPages}
            onClick={() => onSelectPage(pageNumRef.current - 1, numPages)}>ページを対象にする</button>}
        </div>
        <div className="pdf-toolbar-group pdf-zoom-group">
          <button
            type="button"
            className={`btn btn-secondary btn-xs ${fitMode === 'auto' ? 'active' : ''}`}
            onClick={handleResetFit}
            title="画面サイズに合わせて表示"
          >
            画面に合わせる
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-xs pdf-zoom-step-btn"
            aria-label="縮小"
            onClick={() => applyStepZoom('out')}
          >
            −
          </button>
          <span ref={setScaleBadgeEl} className="muted-xs pdf-scale-indicator">
            {Math.round(committedScale * 100)}%
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-xs pdf-zoom-step-btn"
            aria-label="拡大"
            onClick={() => applyStepZoom('in')}
          >
            ＋
          </button>
        </div>
      </div>
      {enhancedNavigation&&navigation&&pdfDoc&&<PdfNavigationPanel doc={pdfDoc} page={pageNum} onJump={scrollToPage} onClose={()=>setNavigation(false)} onSelectText={onSelectPage?text=>onSelectPage(pageNumRef.current-1,numPages,text):undefined}/>}
      {pageRenderErrorCount > 0 && (
        <div className="warn-banner pdf-render-error-banner" role="status">
          <span>一部ページの描画に失敗しました（他のページは閲覧を継続できます）。</span>
          <button type="button" className="btn btn-secondary btn-xs" onClick={handleRetryFailedPages}>
            再試行
          </button>
        </div>
      )}
      <div
        ref={setScrollContainerRef}
        className={`pdf-canvas-scroll content-zoom-surface${isManuallyZoomed ? ' is-pannable' : ''}${isPanning ? ' is-panning' : ''}`}
        data-viewer-zoom-surface="true"
        data-zoom-scale={Math.round(committedScale * 100)}
        data-fit-mode={fitMode}
        onScroll={handleScroll}
        onWheel={cancelProgrammaticScrollLock}
        onTouchStart={cancelProgrammaticScrollLock}
      >
        <div
          ref={setPagesListContainerRef}
          className="pdf-pages-list"
          data-fit-mode={fitMode}
          style={{ '--pdf-scale': String(manualScale) } as React.CSSProperties}
        >
          {pdfDoc &&
            pageBaseSpecs.map((spec) => (
              <PdfPageSlot
                key={`${url}:${spec.pageNum}`}
                pageNum={spec.pageNum}
                naturalWidth={spec.naturalWidth}
                naturalHeight={spec.naturalHeight}
                autoScale={spec.autoScale}
                registerPageEl={registerPageEl}
              />
            ))}
        </div>
      </div>
    </div>
  );
});

interface MediaZoomViewerProps {
  src: string;
  alt: string;
  isSvg: boolean;
  onError: () => void;
}

const MediaZoomViewer: React.FC<MediaZoomViewerProps> = React.memo(({ src, alt, isSvg, onError }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [mediaEl, setMediaEl] = useState<HTMLImageElement | null>(null);
  const [scaleBadgeEl, setScaleBadgeEl] = useState<HTMLSpanElement | null>(null);

  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [fitMode, setFitMode] = useState<'auto' | 'manual'>('auto');
  const [manualScale, setManualScale] = useState(1.0);

  const setScrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);

  useEffect(() => {
    setFitMode('auto');
    setManualScale(1.0);
    setNaturalSize(null);
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [src]);

  useEffect(() => {
    if (!scrollEl) return;
    const measure = () => {
      const nextW = Math.round(scrollEl.clientWidth);
      const nextH = Math.round(scrollEl.clientHeight);
      setContainerSize((prev) =>
        prev.width === nextW && prev.height === nextH ? prev : { width: nextW, height: nextH }
      );
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(scrollEl);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [scrollEl]);

  const autoFitScale = useMemo(
    () => computeMediaAutoFitScale(naturalSize, containerSize, 24, isSvg),
    [naturalSize, containerSize, isSvg]
  );

  const scale = fitMode === 'auto' ? autoFitScale : manualScale;
  const minScale = Math.min(MEDIA_MIN_SCALE, autoFitScale);

  const cssWidth = naturalSize ? Math.max(1, Math.round(naturalSize.width * scale)) : undefined;
  const cssHeight = naturalSize ? Math.max(1, Math.round(naturalSize.height * scale)) : undefined;

  const handleCommitScale = useCallback((nextScale: number) => {
    setFitMode('manual');
    setManualScale(nextScale);
  }, []);

  const { isPanning, commitDiscreteScale, cancelActiveGesture } = useUnifiedViewerZoom({
    scrollEl,
    stageEl: mediaEl,
    scaleBadgeEl,
    committedScale: scale,
    minScale,
    maxScale: MEDIA_MAX_SCALE,
    enableDragPan: true,
    onCommitScale: handleCommitScale,
    resetKey: src,
  });

  const applyStepZoom = useCallback(
    (direction: 'in' | 'out') => {
      commitDiscreteScale((cur) => computeStepZoomScale(cur, direction, minScale, MEDIA_MAX_SCALE));
    },
    [minScale, commitDiscreteScale]
  );

  const handleResetFit = useCallback(() => {
    cancelActiveGesture();
    setFitMode('auto');
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [cancelActiveGesture]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      if (fitMode === 'auto' || scale <= autoFitScale * 1.05) {
        const target = clampZoomScale(Math.max(autoFitScale * 2, 1.5), minScale, MEDIA_MAX_SCALE);
        commitDiscreteScale(target, e.clientX, e.clientY);
      } else {
        handleResetFit();
      }
    },
    [fitMode, scale, autoFitScale, minScale, commitDiscreteScale, handleResetFit]
  );

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth || img.width || 800;
    const nh = img.naturalHeight || img.height || 600;
    setNaturalSize({ width: nw, height: nh });
  }, []);

  const isOverflowing =
    Boolean(cssWidth && containerSize.width && cssWidth > containerSize.width - 24) ||
    Boolean(cssHeight && containerSize.height && cssHeight > containerSize.height - 24);

  return (
    <div className="media-zoom-wrap">
      <div className="viewer-toolbar pdf-viewer-toolbar media-zoom-toolbar">
        <div className="pdf-toolbar-group pdf-zoom-group">
          <button
            type="button"
            className={`btn btn-secondary btn-xs ${fitMode === 'auto' ? 'active' : ''}`}
            onClick={handleResetFit}
            title="画面サイズに合わせて表示"
          >
            画面に合わせる
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-xs pdf-zoom-step-btn"
            aria-label="縮小"
            onClick={() => applyStepZoom('out')}
          >
            −
          </button>
          <span ref={setScaleBadgeEl} className="muted-xs pdf-scale-indicator">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-xs pdf-zoom-step-btn"
            aria-label="拡大"
            onClick={() => applyStepZoom('in')}
          >
            ＋
          </button>
        </div>
      </div>
      <div
        ref={setScrollContainerRef}
        className={`media-zoom-scroll content-zoom-surface${isOverflowing ? ' is-pannable' : ''}${isPanning ? ' is-panning' : ''}`}
        data-viewer-zoom-surface="true"
        data-zoom-scale={Math.round(scale * 100)}
        data-fit-mode={fitMode}
      >
        <div className="media-zoom-canvas">
          <img
            ref={setMediaEl}
            src={src}
            alt={alt}
            decoding="async"
            draggable={false}
            className="viewer-img media-zoom-img"
            style={
              cssWidth && cssHeight
                ? { width: `${cssWidth}px`, height: `${cssHeight}px`, maxWidth: 'none', maxHeight: 'none' }
                : undefined
            }
            onLoad={handleImageLoad}
            onError={onError}
            onDoubleClick={handleDoubleClick}
          />
        </div>
      </div>
    </div>
  );
});

const DiffPatchView: React.FC<{ versionKey: string; patch: string }> = React.memo(({ versionKey, patch }) => {
  const cacheKey = `${versionKey}:diff`;
  const [files, setFiles] = useState<ParsedDiff[] | null>(
    () => (diffPatchCache.get(cacheKey) as ParsedDiff[] | undefined) ?? null
  );

  useEffect(() => {
    const cached = diffPatchCache.get(cacheKey) as ParsedDiff[] | undefined;
    if (cached) {
      setFiles(cached);
      return;
    }
    let active = true;
    void import('diff')
      .then(({ parsePatch }) => {
        if (!active) return;
        const parsed = parsePatch(patch);
        diffPatchCache.set(cacheKey, parsed);
        setFiles(parsed);
      })
      .catch(() => {
        if (active) setFiles([]);
      });
    return () => {
      active = false;
    };
  }, [cacheKey, patch]);

  if (!files) {
    return <div className="viewer-state muted-sm">差分を解析中...</div>;
  }

  if (files.length === 0) {
    return <pre className="code-pre">{patch}</pre>;
  }

  return (
    <div className="diff-container">
      {files.map((file, fIdx) => (
        <div key={fIdx} className="diff-file">
          <div className="diff-file-head">
            {file.oldFileName} → {file.newFileName}
          </div>
          <div className="diff-lines">
            {file.hunks.map((hunk, hIdx) => (
              <React.Fragment key={hIdx}>
                <div className="diff-line hunk">
                  @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                </div>
                {hunk.lines.map((line, lIdx) => {
                  const cls = line.startsWith('+')
                    ? 'add'
                    : line.startsWith('-')
                      ? 'del'
                      : 'ctx';
                  return (
                    <div key={lIdx} className={`diff-line ${cls}`}>
                      {line}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
});

const MAX_CODE_PREVIEW_LINES = 2000;
const TABLE_PAGE_SIZE = 200;

function looksLikeDataCell(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?%?$/.test(v)) return true;
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(v)) return true;
  if (/^(true|false|yes|no|null|nan)$/i.test(v)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  return false;
}

function inferHasHeaderRow(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (first.length === 0) return false;
  const nonEmptyFirst = first.filter((c) => c.trim().length > 0);
  if (nonEmptyFirst.length === 0) return false;
  // Duplicate cell values in row 0 strongly suggest data rather than column headers
  const uniqueFirst = new Set(nonEmptyFirst.map((c) => c.trim().toLowerCase()));
  if (uniqueFirst.size < nonEmptyFirst.length) return false;
  // If any cell in row 0 looks like numeric/date/boolean/email/URL data, treat as headerless
  if (nonEmptyFirst.some(looksLikeDataCell)) return false;
  return true;
}

const CodeViewer: React.FC<{
  versionKey: string;
  resetKey: string;
  filename: string;
  source: string;
}> = React.memo(({ versionKey, resetKey, filename, source }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [showAllLines, setShowAllLines] = useState(false);
  const deferredSearch = useDeferredValue(searchTerm);

  useEffect(() => {
    setSearchTerm('');
    setShowAllLines(false);
  }, [versionKey]);

  const language = useMemo(() => detectCodeLanguage(filename), [filename]);
  const allLines = useMemo(() => source.split('\n'), [source]);

  // Cache highlighted HTML once for full (or truncated) unfiltered source
  const unfilteredHtml = useMemo(() => {
    const visibleText =
      allLines.length > MAX_CODE_PREVIEW_LINES && !showAllLines
        ? allLines.slice(0, MAX_CODE_PREVIEW_LINES).join('\n')
        : source;

    if (visibleText.length > 120_000) return '';

    const suffix = allLines.length > MAX_CODE_PREVIEW_LINES && !showAllLines ? 'head2k' : 'full';
    const cacheKey = `${versionKey}:hl:${language ?? 'auto'}:${suffix}`;
    const cached = codeHighlightCache.get(cacheKey);
    if (cached) return cached.html;

    try {
      const res =
        language && hljs.getLanguage(language)
          ? hljs.highlight(visibleText, { language })
          : visibleText.length < 40_000
            ? hljs.highlightAuto(visibleText)
            : null;
      if (res) {
        codeHighlightCache.set(cacheKey, { html: res.value, language: res.language ?? language ?? 'auto' });
        return res.value;
      }
    } catch {
      // fall back to plain text
    }
    return '';
  }, [versionKey, source, allLines, language, showAllLines]);

  const query = deferredSearch.trim().toLowerCase();
  const filteredLines = useMemo(() => {
    if (!query) return null;
    return allLines.filter((l) => l.toLowerCase().includes(query));
  }, [allLines, query]);

  const { displayText, displayHtml, truncatedTotal } = useMemo(() => {
    if (!filteredLines) {
      const isTruncated = allLines.length > MAX_CODE_PREVIEW_LINES && !showAllLines;
      const text = isTruncated ? allLines.slice(0, MAX_CODE_PREVIEW_LINES).join('\n') : source;
      return {
        displayText: text,
        displayHtml: unfilteredHtml,
        truncatedTotal: isTruncated ? allLines.length : 0,
      };
    }

    const isTruncated = filteredLines.length > MAX_CODE_PREVIEW_LINES && !showAllLines;
    const slice = isTruncated ? filteredLines.slice(0, MAX_CODE_PREVIEW_LINES) : filteredLines;
    const joined = slice.join('\n');
    let html = '';
    if (joined.length < 40_000 && language && hljs.getLanguage(language)) {
      try {
        html = hljs.highlight(joined, { language }).value;
      } catch {
        html = '';
      }
    }
    return {
      displayText: joined,
      displayHtml: html,
      truncatedTotal: isTruncated ? filteredLines.length : 0,
    };
  }, [filteredLines, allLines, source, unfilteredHtml, showAllLines, language]);

  const controlsTop = (
    <div className="code-viewer-controls">
      <div className="viewer-search-row">
        <SearchIcon size={14} />
        <input
          type="text"
          aria-label="ファイル内を行検索"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="ファイル内を行検索..."
        />
        {query && filteredLines && (
          <span className="muted-xs">
            {filteredLines.length} / {allLines.length} 行
          </span>
        )}
      </div>
      {truncatedTotal > 0 && (
        <div className="viewer-truncation-bar">
          <span className="muted-xs">
            先頭 {MAX_CODE_PREVIEW_LINES} 行を表示中（全 {truncatedTotal} 行）
          </span>
          <button type="button" className="chip-btn" onClick={() => setShowAllLines(true)}>
            すべて表示
          </button>
        </div>
      )}
    </div>
  );

  return (
    <UnifiedViewerZoomShell resetKey={resetKey} controlsTop={controlsTop}>
      {query && filteredLines && filteredLines.length === 0 ? (
        <div className="empty-box muted-sm" role="status">
          「{deferredSearch.trim()}」に一致する行が見つかりませんでした。
        </div>
      ) : (
        <pre className="code-pre hljs viewer-code-pre">
          {displayHtml ? <code dangerouslySetInnerHTML={{ __html: displayHtml }} /> : <code>{displayText}</code>}
        </pre>
      )}
    </UnifiedViewerZoomShell>
  );
});

const TableViewer: React.FC<{
  versionKey: string;
  resetKey: string;
  sheets: ParsedSheetData[];
}> = React.memo(({ versionKey, resetKey, sheets }) => {
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState(false);
  const [headerOverride, setHeaderOverride] = useState<boolean | null>(null);

  useEffect(() => {
    setActiveSheetIdx(0);
    setPage(0);
    setHeaderOverride(null);
  }, [versionKey]);

  const sheet = sheets[activeSheetIdx];
  const inferredHasHeader = useMemo(
    () => (sheet ? inferHasHeaderRow(sheet.rows) : false),
    [sheet]
  );
  const hasHeader = headerOverride ?? inferredHasHeader;

  const colCount = useMemo(() => {
    if (!sheet) return 0;
    return sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
  }, [sheet]);

  const headerRow = useMemo(() => {
    if (!sheet || sheet.rows.length === 0) return [];
    if (hasHeader) {
      return Array.from({ length: colCount }, (_, idx) => sheet.rows[0][idx] ?? '');
    }
    return Array.from({ length: colCount }, (_, idx) => `列 ${idx + 1}`);
  }, [sheet, hasHeader, colCount]);

  const dataRows = useMemo(() => {
    if (!sheet || sheet.rows.length === 0) return [];
    return hasHeader ? sheet.rows.slice(1) : sheet.rows;
  }, [sheet, hasHeader]);

  const totalPages = Math.max(1, Math.ceil(dataRows.length / TABLE_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);

  useEffect(() => {
    tableScrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [safePage, activeSheetIdx, versionKey, hasHeader]);

  const handleCopyCsv = useCallback(async () => {
    if (!sheet) return;
    const csv = sheet.rows
      .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
      .join('\n');
    await navigator.clipboard.writeText(csv);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [sheet]);

  if (!sheet || sheet.rows.length === 0) {
    return <div className="muted-sm">表データが空です</div>;
  }

  const pageStart = safePage * TABLE_PAGE_SIZE;
  const pageRows = dataRows.slice(pageStart, pageStart + TABLE_PAGE_SIZE);

  const controlsTop = (
    <div className="viewer-toolbar table-viewer-controls">
      <div className="row-actions">
        {sheets.length > 1 &&
          sheets.map((s, idx) => (
            <button
              key={idx}
              type="button"
              className={idx === activeSheetIdx ? 'chip-btn active' : 'chip-btn'}
              onClick={() => {
                setActiveSheetIdx(idx);
                setPage(0);
                setHeaderOverride(null);
              }}
            >
              {s.name}
            </button>
          ))}
        <button
          type="button"
          className={`chip-btn ${hasHeader ? 'active' : ''}`}
          aria-pressed={hasHeader}
          onClick={() => {
            setHeaderOverride(!hasHeader);
            setPage(0);
          }}
        >
          先頭行を見出しにする: {hasHeader ? 'ON' : 'OFF'}
        </button>
      </div>
      <button type="button" className="btn btn-secondary btn-xs" onClick={handleCopyCsv}>
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        <span>{copied ? 'コピー済' : 'CSVコピー'}</span>
      </button>
    </div>
  );

  const controlsBottom =
    totalPages > 1 ? (
      <div className="viewer-pagination">
        <span className="muted-xs">
          {pageStart + 1}〜{Math.min(pageStart + pageRows.length, dataRows.length)} 行 / 全{' '}
          {dataRows.length} データ行
        </span>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={safePage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronIcon size={13} dir="left" /> 前
          </button>
          <span className="muted-xs">
            {safePage + 1} / {totalPages}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            次 <ChevronIcon size={13} dir="right" />
          </button>
        </div>
      </div>
    ) : undefined;

  return (
    <UnifiedViewerZoomShell
      resetKey={`${resetKey}:s${activeSheetIdx}:p${safePage}`}
      controlsTop={controlsTop}
      controlsBottom={controlsBottom}
    >
      <div ref={tableScrollRef} className="md-table-scroll viewer-table-scroll">
        <table>
          <thead>
            <tr>
              {headerRow.map((cell, cIdx) => (
                <th key={cIdx}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, rIdx) => (
              <tr key={pageStart + rIdx}>
                {Array.from({ length: colCount }, (_, cIdx) => (
                  <td key={cIdx}>{row[cIdx] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </UnifiedViewerZoomShell>
  );
});

export const ArtifactViewerModal: React.FC<ArtifactViewerModalProps> = ({
  artifact,
  projects,
  onClose,
  onCopiedToProject,
  onOpenArtifact,
}) => {
  const versionKey = artifactVersionKey(artifact);
  const contentUrl = useMemo(
    () => buildArtifactContentUrl(artifact),
    [versionKey, artifact.previewKind]
  );
  const convertedPdfUrl = useMemo(
    () => buildArtifactContentUrl(artifact, { convertedPdf: true }),
    [versionKey, artifact.previewKind]
  );
  const downloadUrl = useMemo(
    () => buildArtifactContentUrl(artifact, { download: true }),
    [versionKey, artifact.previewKind]
  );
  const sandboxUrl = useMemo(
    () => buildArtifactSandboxUrl(artifact),
    [versionKey]
  );

  const [textContent, setTextContent] = useState<string | null>(() => artifactTextCache.get(versionKey) ?? null);
  const [sanitizedHtml, setSanitizedHtml] = useState<string | null>(() =>
    artifact.previewKind === 'docx' ? (docxHtmlCache.get(versionKey) ?? null) : null
  );
  const [svgBlobUrl, setSvgBlobUrl] = useState<string | null>(null);
  const [sheets, setSheets] = useState<ParsedSheetData[]>(() =>
    artifact.previewKind === 'table' ? (tableSheetsCache.get(versionKey) ?? []) : []
  );
  const [viewMode, setViewMode] = useState<'preview' | 'source' | 'diff'>(
    artifact.previewKind === 'diff' ? 'diff' : 'preview'
  );
  const [imageError, setImageError] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => {
    const k = artifact.previewKind;
    if (k === 'image' || k === 'audio' || k === 'video' || k === 'pdf' || k === 'pptx' || k === 'binary') {
      return false;
    }
    if (k === 'table' && tableSheetsCache.has(versionKey)) return false;
    if (k === 'docx' && docxHtmlCache.has(versionKey)) return false;
    if (k === 'svg' && svgMarkupCache.has(versionKey)) return false;
    if (artifactTextCache.has(versionKey)) return false;
    return true;
  });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState(projects[0]?.id ?? '');
  const [copyProjectMsg, setCopyProjectMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!targetProjectId && projects[0]?.id) {
      setTargetProjectId(projects[0].id);
    }
  }, [projects, targetProjectId]);

  useEffect(() => {
    setImageError(false);
    setLinkError(null);
    setCopyProjectMsg(null);
    setCopied(false);
    setViewMode(artifact.previewKind === 'diff' ? 'diff' : 'preview');
  }, [artifact.id, contentUrl]);

  useEffect(() => {
    let active = true;
    let createdBlobUrl: string | null = null;
    const kind = artifact.previewKind;

    setError(null);

    if (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf' || kind === 'pptx' || kind === 'binary') {
      setTextContent(null);
      setSanitizedHtml(null);
      setSvgBlobUrl(null);
      setSheets([]);
      setLoading(false);
      return;
    }

    if (kind === 'table') {
      const cachedSheets = tableSheetsCache.get(versionKey);
      const cachedText = artifactTextCache.get(versionKey) ?? null;
      if (cachedSheets) {
        setTextContent(cachedText);
        setSanitizedHtml(null);
        setSvgBlobUrl(null);
        setSheets(cachedSheets);
        setLoading(false);
        return;
      }
    } else if (kind === 'docx') {
      const cachedDocx = docxHtmlCache.get(versionKey);
      if (cachedDocx !== undefined) {
        setTextContent(null);
        setSanitizedHtml(cachedDocx);
        setSvgBlobUrl(null);
        setSheets([]);
        setLoading(false);
        return;
      }
    } else if (kind === 'svg') {
      const cachedSvg = svgMarkupCache.get(versionKey);
      const cachedText = artifactTextCache.get(versionKey) ?? null;
      if (cachedSvg !== undefined) {
        setTextContent(cachedText);
        setSanitizedHtml(null);
        setSheets([]);
        const blob = new Blob([cachedSvg], { type: 'image/svg+xml' });
        createdBlobUrl = URL.createObjectURL(blob);
        setSvgBlobUrl(createdBlobUrl);
        setLoading(false);
        return () => {
          if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
        };
      }
    } else {
      const cachedText = artifactTextCache.get(versionKey);
      if (cachedText !== undefined) {
        setTextContent(cachedText);
        setSanitizedHtml(null);
        setSvgBlobUrl(null);
        setSheets([]);
        setLoading(false);
        return;
      }
    }

    setLoading(true);
    setTextContent(null);
    setSanitizedHtml(null);
    setSvgBlobUrl(null);
    setSheets([]);

    const load = async () => {
      try {
        const res = await fetch(contentUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(`ファイルの取得に失敗しました (${res.status})`);

        if (kind === 'table') {
          const isXlsx = artifact.filename.toLowerCase().endsWith('.xlsx');
          if (isXlsx) {
            const [buf, readXlsxMod] = await Promise.all([
              res.arrayBuffer(),
              import('read-excel-file/browser'),
            ]);
            const parsedSheets = await readXlsxMod.default(buf);
            if (!active) return;
            const normalized: ParsedSheetData[] = parsedSheets.map((s) => ({
              name: s.sheet || 'Sheet',
              rows: s.data.map((r) =>
                r.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
              ),
            }));
            tableSheetsCache.set(versionKey, normalized);
            setSheets(normalized);
          } else {
            const [txt, papaMod] = await Promise.all([res.text(), import('papaparse')]);
            if (!active) return;
            artifactTextCache.set(versionKey, txt);
            setTextContent(txt);
            const parsed = papaMod.default.parse<string[]>(txt, { skipEmptyLines: false });
            const normalized: ParsedSheetData[] = [{ name: artifact.filename, rows: parsed.data }];
            tableSheetsCache.set(versionKey, normalized);
            setSheets(normalized);
          }
          setLoading(false);
          return;
        }

        if (kind === 'docx') {
          const [buf, mammoth] = await Promise.all([res.arrayBuffer(), import('mammoth')]);
          const result = await mammoth.convertToHtml({ arrayBuffer: buf });
          if (!active) return;
          const clean = DOMPurify.sanitize(result.value);
          docxHtmlCache.set(versionKey, clean);
          setSanitizedHtml(clean);
          setLoading(false);
          return;
        }

        const txt = await res.text();
        if (!active) return;
        artifactTextCache.set(versionKey, txt);
        setTextContent(txt);

        if (kind === 'svg') {
          const cleanSvg = DOMPurify.sanitize(txt, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
          svgMarkupCache.set(versionKey, cleanSvg);
          const blob = new Blob([cleanSvg], { type: 'image/svg+xml' });
          createdBlobUrl = URL.createObjectURL(blob);
          setSvgBlobUrl(createdBlobUrl);
        }

        setLoading(false);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'プレビューの読込に失敗しました');
          setLoading(false);
        }
      }
    };
    void load();

    return () => {
      active = false;
      if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
    };
  }, [artifact.id, artifact.previewKind, artifact.filename, versionKey, contentUrl]);

  const copyableText =
    viewMode === 'diff'
      ? (artifact.diffPatch ?? (artifact.previewKind === 'diff' ? textContent : null))
      : textContent;
  const canCopyText = Boolean(copyableText && copyableText.length > 0);

  const handleCopyText = async () => {
    if (!copyableText) return;
    await navigator.clipboard.writeText(copyableText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const handleSaveToProject = async () => {
    if (!targetProjectId) return;
    try {
      const res = await api.copyArtifactToProject(artifact.id, targetProjectId);
      setCopyProjectMsg(`"${res.project.name}" に保存しました`);
      onCopiedToProject?.(res.project, res.file.filename);
      setTimeout(() => setCopyProjectMsg(null), 2600);
    } catch (err) {
      setCopyProjectMsg(err instanceof ApiError ? err.message : '保存に失敗しました');
    }
  };

  const renderBody = () => {
    if (loading) return <div className="viewer-state muted-sm">ファイルを読み込み中...</div>;
    if (error) return <div className="error-box" role="alert">{error}</div>;

    if (viewMode === 'diff') {
      const patchText = artifact.diffPatch ?? (artifact.previewKind === 'diff' ? textContent : null);
      if (patchText !== null) {
        return <DiffPatchView versionKey={versionKey} patch={patchText} />;
      }
    }

    if (viewMode === 'source' && textContent !== null) {
      return (
        <CodeViewer
          versionKey={versionKey}
          resetKey={`${versionKey}:source`}
          filename={artifact.filename}
          source={textContent}
        />
      );
    }

    switch (artifact.previewKind) {
      case 'diff':
        return <DiffPatchView versionKey={versionKey} patch={artifact.diffPatch ?? textContent ?? ''} />;

      case 'image':
      case 'svg': {
        const src = artifact.previewKind === 'svg' ? svgBlobUrl : contentUrl;
        if (imageError || (artifact.previewKind !== 'svg' && !src)) {
          return (
            <div className="viewer-image-error">
              <div className="error-box" role="alert">
                画像の読み込みに失敗しました。ファイルが破損しているか、取得できませんでした。
              </div>
              <a href={downloadUrl} className="btn btn-secondary btn-sm" download={artifact.filename}>
                <DownloadIcon size={14} />
                <span>原本をダウンロード</span>
              </a>
            </div>
          );
        }
        if (!src) {
          return <div className="viewer-state muted-sm">画像を読み込み中...</div>;
        }
        return (
          <MediaZoomViewer
            src={src}
            alt={artifact.filename}
            isSvg={artifact.previewKind === 'svg'}
            onError={() => setImageError(true)}
          />
        );
      }

      case 'pdf':
        return <PdfCanvasViewer url={contentUrl} />;

      case 'pptx':
        return (
          <div className="stack-gap pptx-viewer-wrap">
            <div className="info-banner">
              プレゼンファイル (.pptx) を確認するには、PDF変換表示または原本ダウンロードをご利用ください。
            </div>
            <PdfCanvasViewer url={convertedPdfUrl} />
          </div>
        );

      case 'table':
        return <TableViewer versionKey={versionKey} resetKey={`${versionKey}:table`} sheets={sheets} />;

      case 'docx':
        return (
          <UnifiedViewerZoomShell
            resetKey={`${versionKey}:docx`}
            controlsTop={
              <div className="warn-banner">
                簡易HTML変換プレビューのため、段組や複雑なレイアウトは元のWord文書と異なる場合があります。
              </div>
            }
          >
            <div
              className="docx-preview"
              dangerouslySetInnerHTML={{ __html: sanitizedHtml ?? '' }}
            />
          </UnifiedViewerZoomShell>
        );

      case 'html':
        return (
          <iframe
            sandbox="allow-scripts"
            src={sandboxUrl}
            title={artifact.filename}
            className="html-sandbox-frame"
          />
        );

      case 'mermaid':
        return <MermaidBlock code={textContent ?? ''} />;

      case 'markdown':
        return (
          <MarkdownContent
            content={textContent ?? ''}
            chatId={artifact.chatId}
            onOpenArtifact={(nextArt) => {
              setLinkError(null);
              onOpenArtifact?.(nextArt);
            }}
            onResolveError={(msg) => setLinkError(msg)}
          />
        );

      case 'audio':
        return (
          <div className="media-stage">
            <audio controls src={contentUrl} style={{ width: '100%', maxWidth: 480 }} />
          </div>
        );

      case 'video':
        return (
          <div className="media-stage">
            <video controls playsInline src={contentUrl} className="viewer-video" />
          </div>
        );

      case 'code':
        return (
          <CodeViewer
            versionKey={versionKey}
            resetKey={`${versionKey}:code`}
            filename={artifact.filename}
            source={textContent ?? ''}
          />
        );

      default:
        return (
          <div className="binary-card">
            <div className="kv-label">{artifact.filename}</div>
            <div className="muted-sm">
              MIME: {artifact.mimeType} ・ サイズ: {formatBytesCompact(artifact.sizeBytes)}
            </div>
            <div className="muted-xs">SHA-256: {artifact.sha256.slice(0, 16)}...</div>
            <a href={downloadUrl} className="btn btn-primary" download={artifact.filename}>
              <DownloadIcon size={16} />
              <span>原本をダウンロード</span>
            </a>
          </div>
        );
    }
  };

  const supportsSourceToggle = ['markdown', 'html', 'mermaid', 'svg', 'diff'].includes(artifact.previewKind);
  const isSelfShelledView =
    !loading &&
    !error &&
    ((viewMode === 'source' && textContent !== null) ||
      (viewMode === 'preview' &&
        (artifact.previewKind === 'code' ||
          artifact.previewKind === 'table' ||
          artifact.previewKind === 'docx')));

  const isOuterUnifiedShellView =
    !loading &&
    !error &&
    !isSelfShelledView &&
    ((viewMode === 'diff' && Boolean(artifact.diffPatch ?? (artifact.previewKind === 'diff' ? textContent : null))) ||
      (viewMode === 'preview' &&
        (artifact.previewKind === 'diff' ||
          artifact.previewKind === 'markdown' ||
          artifact.previewKind === 'mermaid' ||
          artifact.previewKind === 'html')));

  const usesManagedZoomLayout =
    isSelfShelledView ||
    isOuterUnifiedShellView ||
    (viewMode === 'preview' &&
      (artifact.previewKind === 'pdf' ||
        artifact.previewKind === 'pptx' ||
        ((artifact.previewKind === 'image' || artifact.previewKind === 'svg') && !imageError)));

  return (
    <ModalDialog label={artifact.filename} size="modal-xl viewer-modal" onClose={onClose}>
        <div className="modal-head">
          <div className="viewer-title-group">
            <h3 className="truncate" title={artifact.filename}>{artifact.filename}</h3>
            <span className="muted-xs truncate" title={artifact.relPath}>
              {artifact.relPath} ・ {formatBytesCompact(artifact.sizeBytes)}
            </span>
          </div>
          <div className="row-actions modal-head-actions">
            {supportsSourceToggle && (
              <button
                type="button"
                className={`btn btn-secondary btn-xs ${viewMode === 'source' ? 'active' : ''}`}
                onClick={() =>
                  setViewMode(
                    viewMode === 'source'
                      ? (artifact.previewKind === 'diff' ? 'diff' : 'preview')
                      : 'source'
                  )
                }
              >
                {viewMode === 'source' ? 'プレビュー' : 'ソース'}
              </button>
            )}
            {artifact.diffPatch && (
              <button
                type="button"
                className={`btn btn-secondary btn-xs ${viewMode === 'diff' ? 'active' : ''}`}
                onClick={() => setViewMode(viewMode === 'diff' ? 'preview' : 'diff')}
              >
                {viewMode === 'diff' ? 'ファイル本体' : '差分 (Diff)'}
              </button>
            )}
            {copyableText !== null && (
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={handleCopyText}
                disabled={!canCopyText}
                title={canCopyText ? '内容をコピー' : 'コピーする内容がありません'}
              >
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                <span>{copied ? 'コピー済' : 'コピー'}</span>
              </button>
            )}
            <a href={downloadUrl} className="btn btn-secondary btn-xs" download={artifact.filename}>
              <DownloadIcon size={13} />
              <span>DL</span>
            </a>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
              <CloseIcon size={18} />
            </button>
          </div>
        </div>

        <div className={`modal-body viewer-body${usesManagedZoomLayout ? ' viewer-body-pdf' : ''}`}>
          {linkError && (
            <div className="error-box viewer-link-error" role="alert" style={{ marginBottom: 12 }}>
              <span>{linkError}</span>
              <button
                type="button"
                className="icon-btn-sm"
                aria-label="エラーを閉じる"
                onClick={() => setLinkError(null)}
              >
                <CloseIcon size={13} />
              </button>
            </div>
          )}
          {isOuterUnifiedShellView ? (
            <UnifiedViewerZoomShell
              resetKey={`${versionKey}:${viewMode}`}
              fillViewportHeight={viewMode === 'preview' && artifact.previewKind === 'html'}
            >
              {renderBody()}
            </UnifiedViewerZoomShell>
          ) : (
            renderBody()
          )}
        </div>

        {projects.length > 0 && (
          <div className="viewer-footer">
            <div className="row-actions viewer-footer-actions">
              <select
                aria-label="保存先プロジェクト"
                value={targetProjectId}
                onChange={(e) => setTargetProjectId(e.target.value)}
                className="compact-select viewer-project-select"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-secondary btn-xs" onClick={handleSaveToProject}>
                プロジェクト資料へ保存
              </button>
              {copyProjectMsg && <span className="muted-xs" role="status">{copyProjectMsg}</span>}
            </div>
          </div>
        )}
    </ModalDialog>
  );
};

