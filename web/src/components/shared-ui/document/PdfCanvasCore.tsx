import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type * as PdfJsTypes from 'pdfjs-dist';
import {PdfNavigationPanel} from './PdfNavigationPanel';
import {useUnifiedViewerZoom,type ZoomAnchorAdapter} from '../../../hooks/useUnifiedViewerZoom';
import {computeStepZoomScale} from '../../../utils/contentZoom';
import {computePdfAutoFitScale,findActivePdfPage,PDF_MANUAL_MAX_SCALE,PDF_MANUAL_MIN_SCALE} from '../../../utils/pdfFit';
import {closeBitmapIfOwned,commitPdfBitmapToCanvas,computeBoundedPdfDpr,isPdfRenderCancelledError,MAX_PDF_CONCURRENT_RENDERS,MAX_TOTAL_PDF_CANVAS_PIXELS,PdfRenderJobTracker,selectPdfCanvasesToRelease} from '../../../utils/pdfRenderBudget';
import {pdfBytesCache,pdfPageBitmapCache} from '../../../utils/viewerCache';
import {ChevronIcon} from '../../Icons';

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
  // Explicit navigation owns the active page until the user scrolls the document.
  // Wall-clock timeouts cannot distinguish a delayed layout event from user input.
  const programmaticScrollRef = useRef<{ targetPage: number; offsetRatio: number; settled?: { top:number;width:number;height:number;scrollHeight:number } } | null>(null);
  const rememberScrollPosition=(container:HTMLDivElement)=>{
    const anchor=programmaticScrollRef.current;
    if(anchor)anchor.settled={top:container.scrollTop,width:container.clientWidth,height:container.clientHeight,scrollHeight:container.scrollHeight};
  };
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
    programmaticScrollRef.current = { targetPage: anchor.page, offsetRatio: -anchor.offsetY / Math.max(1,slot.getBoundingClientRect().height) };
    sc.scrollTo({ top: Math.max(0, sc.scrollTop + slot.getBoundingClientRect().top - sc.getBoundingClientRect().top - anchor.offsetY),
      left: anchor.scrollLeft, behavior: 'instant' });
    rememberScrollPosition(sc);
    pageNumRef.current = anchor.page;
    setPageNum(anchor.page);
  }, [loading, pdfDoc, pageSizes, containerSize.width, scrollEl]);

  // A panel opening/closing, inspector appearing, or delayed page dimensions
  // can change auto-fit page heights and clamp scrollTop (especially WebKit).
  // Re-anchor the explicitly selected page against the NEW slot geometry.
  useLayoutEffect(() => {
    const lock=programmaticScrollRef.current, sc=scrollRef.current;
    if(!lock||!sc||loading||!pdfDoc||isZoomInteractingRef.current||!containerSize.width||!containerSize.height)return;
    const slot=pageElementsRef.current.get(lock.targetPage);
    if(!slot)return;
    const settled=lock.settled;
    // A ResizeObserver callback can be queued before an accessibility or
    // scrollbar scroll. Never restore an old page over new input when the
    // actual viewport and document geometry are unchanged.
    if(settled&&settled.width===sc.clientWidth&&settled.height===sc.clientHeight&&settled.scrollHeight===sc.scrollHeight){
      if(Math.abs(sc.scrollTop-settled.top)>2){programmaticScrollRef.current=null;return;}
      if(fitMode==='manual')return;
    }
    const rect=slot.getBoundingClientRect(), viewport=sc.getBoundingClientRect();
    const padding=parseFloat(window.getComputedStyle(sc).paddingTop)||0;
    sc.scrollTo({top:Math.max(0,sc.scrollTop+rect.top-viewport.top-padding+lock.offsetRatio*rect.height),behavior:'instant'});
    rememberScrollPosition(sc);
    pageNumRef.current=lock.targetPage;setPageNum(lock.targetPage);
    scheduleRenderRef.current();
  },[containerSize.width,containerSize.height,pageSizes,pdfDoc,loading,scrollEl,fitMode]);

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
      programmaticScrollRef.current = { targetPage: clamped, offsetRatio: 0 };
      const container = scrollRef.current;
      const targetEl = pageElementsRef.current.get(clamped);
      if (container && targetEl) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const paddingTop = parseFloat(window.getComputedStyle(container).paddingTop) || 0;
        const nextTop = container.scrollTop + (targetRect.top - containerRect.top) - paddingTop;
        container.scrollTo({ top: Math.max(0, nextTop), behavior: 'instant' });
        rememberScrollPosition(container);
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
    const sc=scrollRef.current,lock=programmaticScrollRef.current,settled=lock?.settled;
    if(sc&&settled&&settled.width===sc.clientWidth&&settled.height===sc.clientHeight&&settled.scrollHeight===sc.scrollHeight&&Math.abs(sc.scrollTop-settled.top)>2){
      programmaticScrollRef.current=null;
    }
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (isZoomInteractingRef.current) return;
      const container = scrollRef.current;
      if (!container || numPages <= 0) return;

      const anchor=programmaticScrollRef.current;
      if(anchor){
        const settled=anchor.settled;
        // Layout changes can clamp scrollTop before ResizeObserver commits
        // the new fit geometry. The layout effect restores the anchor.
        if(!settled||settled.width!==container.clientWidth||settled.height!==container.clientHeight||settled.scrollHeight!==container.scrollHeight)return;
        // The recorded position is our own last scroll, not an indefinite
        // input lock. Scrollbar, accessibility or script navigation on the
        // same geometry releases it even without pointer/wheel events.
        if(Math.abs(container.scrollTop-settled.top)<=2)return;
        programmaticScrollRef.current=null;
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
        programmaticScrollRef.current = { targetPage: anchor.pageNum, offsetRatio: (container.getBoundingClientRect().top + (parseFloat(window.getComputedStyle(container).paddingTop)||0) - (clientY-anchor.relY*afterRect.height))/Math.max(1,afterRect.height) };
        const deltaX = targetClientX - clientX;
        const deltaY = targetClientY - clientY;
        if (Math.abs(deltaX) > 0.5) {
          container.scrollLeft = Math.max(0, container.scrollLeft + deltaX);
        }
        if (Math.abs(deltaY) > 0.5) {
          container.scrollTop = Math.max(0, container.scrollTop + deltaY);
        }
        rememberScrollPosition(container);
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
    programmaticScrollRef.current={targetPage:pageNumRef.current,offsetRatio:0};
    setFitMode('auto');
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
      rememberScrollPosition(scrollRef.current);
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
        tabIndex={0}
        aria-label="PDFページ表示"
        onWheel={cancelProgrammaticScrollLock}
        onPointerDown={cancelProgrammaticScrollLock}
        onTouchStart={cancelProgrammaticScrollLock}
        onKeyDown={e=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key))cancelProgrammaticScrollLock()}}
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

