import { ModalDialog } from './ModalDialog';
import type { StructuredPatch } from 'diff';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import type * as PdfJsTypes from 'pdfjs-dist';
import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useContentZoomGestures } from '../hooks/useContentZoomGestures';
import type { ArtifactRecord, ProjectRecord } from '../types';
import {
  captureRelativeFocalPoint,
  clampZoomScale,
  computeFocalScrollDelta,
  computeMediaAutoFitScale,
  MEDIA_MAX_SCALE,
  MEDIA_MIN_SCALE,
  MEDIA_ZOOM_STEP_FACTOR,
  type RelativeFocalPoint,
} from '../utils/contentZoom';
import {
  computePdfAutoFitScale,
  findActivePdfPage,
  PDF_MANUAL_MAX_SCALE,
  PDF_MANUAL_MIN_SCALE,
} from '../utils/pdfFit';
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

function makePdfBitmapKey(url: string, pageNum: number, scale: number, dpr: number): string {
  return `${url}@p${pageNum}@s${Math.round(scale * 100)}@d${Math.round(dpr * 100)}`;
}

async function renderPdfPageToBitmap(
  doc: PdfJsTypes.PDFDocumentProxy,
  pageNum: number,
  scale: number,
  dpr: number,
  onTask?: (task: PdfJsTypes.RenderTask | null) => void
): Promise<{ bitmap: ImageBitmap | HTMLCanvasElement; cssWidth: number; cssHeight: number }> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const cssWidth = Math.max(1, Math.floor(viewport.width));
  const cssHeight = Math.max(1, Math.floor(viewport.height));

  const offscreen = document.createElement('canvas');
  offscreen.width = Math.max(1, Math.floor(viewport.width * dpr));
  offscreen.height = Math.max(1, Math.floor(viewport.height * dpr));
  const ctx = offscreen.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable');
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const renderTask = page.render({ canvasContext: ctx, viewport, canvas: offscreen });
  onTask?.(renderTask);
  try {
    await renderTask.promise;
  } finally {
    onTask?.(null);
  }

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(offscreen);
      return { bitmap, cssWidth, cssHeight };
    } catch {
      // Fallback to offscreen HTMLCanvasElement if ImageBitmap fails
    }
  }
  return { bitmap: offscreen, cssWidth, cssHeight };
}

function drawBitmapToCanvas(
  canvas: HTMLCanvasElement,
  entry: { bitmap: ImageBitmap | HTMLCanvasElement; cssWidth: number; cssHeight: number }
): void {
  canvas.width = entry.bitmap.width;
  canvas.height = entry.bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(entry.bitmap, 0, 0);
}

interface PdfPageSize {
  width: number;
  height: number;
}

const DEFAULT_PDF_PAGE_SIZE: PdfPageSize = { width: 595, height: 842 };

interface PdfPageCanvasProps {
  url: string;
  pdfDoc: PdfJsTypes.PDFDocumentProxy;
  pageNum: number;
  scale: number;
  cssWidth: number;
  cssHeight: number;
  scrollEl: HTMLDivElement | null;
  readyToRender: boolean;
  registerPageEl: (pageNum: number, el: HTMLDivElement | null) => void;
}

const PdfPageCanvas: React.FC<PdfPageCanvasProps> = React.memo(
  ({ url, pdfDoc, pageNum, scale, cssWidth, cssHeight, scrollEl, readyToRender, registerPageEl }) => {
    const slotRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const hasPaintedRef = useRef(false);
    const [isNearViewport, setIsNearViewport] = useState(pageNum <= 2);

    const setSlotRef = useCallback(
      (el: HTMLDivElement | null) => {
        slotRef.current = el;
        registerPageEl(pageNum, el);
      },
      [pageNum, registerPageEl]
    );

    useEffect(() => {
      hasPaintedRef.current = false;
    }, [url, pageNum]);

    useEffect(() => {
      const el = slotRef.current;
      if (!el) return;
      if (typeof IntersectionObserver === 'undefined') {
        setIsNearViewport(true);
        return;
      }
      if (!scrollEl) return;
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setIsNearViewport(true);
            }
          }
        },
        { root: scrollEl, rootMargin: '400px 0px' }
      );
      io.observe(el);
      return () => io.disconnect();
    }, [scrollEl]);

    useEffect(() => {
      if (!readyToRender || !isNearViewport || !canvasRef.current || scale <= 0) return;
      let cancelled = false;
      let activeTask: PdfJsTypes.RenderTask | null = null;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const key = makePdfBitmapKey(url, pageNum, scale, dpr);
      const cachedHit = pdfPageBitmapCache.get(key);

      const renderPage = async () => {
        try {
          let cached = cachedHit ?? pdfPageBitmapCache.get(key);
          if (!cached) {
            const rendered = await renderPdfPageToBitmap(pdfDoc, pageNum, scale, dpr, (t) => {
              activeTask = t;
            });
            if (cancelled) {
              if (typeof ImageBitmap !== 'undefined' && rendered.bitmap instanceof ImageBitmap) {
                rendered.bitmap.close();
              }
              return;
            }
            pdfPageBitmapCache.set(key, rendered);
            cached = rendered;
          }
          if (cancelled || !canvasRef.current) return;
          drawBitmapToCanvas(canvasRef.current, cached);
          hasPaintedRef.current = true;
        } catch {
          // ignore abort when zooming or closing quickly
        }
      };

      // Paint immediately on first render or cache hit; debounce subsequent scale changes
      // so continuous pinch / Ctrl+Wheel gestures smoothly CSS-scale without wasted renders.
      if (!hasPaintedRef.current || cachedHit) {
        void renderPage();
        return () => {
          cancelled = true;
          activeTask?.cancel();
        };
      }

      const timer = window.setTimeout(() => {
        void renderPage();
      }, 120);

      return () => {
        cancelled = true;
        window.clearTimeout(timer);
        activeTask?.cancel();
      };
    }, [pdfDoc, url, pageNum, scale, isNearViewport, readyToRender]);

    return (
      <div
        ref={setSlotRef}
        className="pdf-page-slot"
        data-page-number={pageNum}
        style={{ width: `${cssWidth}px`, height: `${cssHeight}px` }}
      >
        <canvas ref={canvasRef} />
      </div>
    );
  }
);

const PdfCanvasViewer: React.FC<{ url: string }> = React.memo(({ url }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const pagesListRef = useRef<HTMLDivElement | null>(null);
  const [pagesListEl, setPagesListEl] = useState<HTMLDivElement | null>(null);
  const pendingFocalRef = useRef<RelativeFocalPoint | null>(null);
  const pageElementsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const programmaticScrollRef = useRef<{ targetPage: number; expiresAt: number } | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  const [pdfDoc, setPdfDoc] = useState<PdfJsTypes.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [fitMode, setFitMode] = useState<'auto' | 'manual'>('auto');
  const [manualScale, setManualScale] = useState(1.0);
  const [pageSizes, setPageSizes] = useState<Array<PdfPageSize | null>>([]);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const setScrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);

  const setPagesListContainerRef = useCallback((el: HTMLDivElement | null) => {
    pagesListRef.current = el;
    setPagesListEl(el);
  }, []);

  const registerPageEl = useCallback((p: number, el: HTMLDivElement | null) => {
    if (el) {
      pageElementsRef.current.set(p, el);
    } else {
      pageElementsRef.current.delete(p);
    }
  }, []);

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
    setLoading(true);
    setError(null);
    setPdfDoc(null);
    setNumPages(0);
    setPageNum(1);
    setFitMode('auto');
    setPageSizes([]);
    programmaticScrollRef.current = null;
    pageElementsRef.current.clear();

    const load = async () => {
      try {
        let bytes = pdfBytesCache.get(url);
        if (!bytes) {
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) {
            const j = await res.json().catch(() => null);
            throw new Error(j?.message || `PDF読込エラー (${res.status})`);
          }
          const buf = await res.arrayBuffer();
          bytes = new Uint8Array(buf);
          pdfBytesCache.set(url, bytes);
        }

        const pdfjsLib = await loadPdfJs();
        if (!active) return;
        // Pass a copy because pdfjs transfers the underlying ArrayBuffer to its Web Worker
        const task = pdfjsLib.getDocument({ data: bytes.slice() });
        loadedDoc = await task.promise;
        if (!active) {
          void loadedDoc.destroy();
          return;
        }
        setPdfDoc(loadedDoc);
        setNumPages(loadedDoc.numPages);
        setPageNum(1);
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
      if (loadedDoc) void loadedDoc.destroy();
    };
  }, [url]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [url]);

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
        for (let p = 2; p <= numPages; p += 1) {
          if (!active) return;
          const page = await pdfDoc.getPage(p);
          if (!active) return;
          const vp = page.getViewport({ scale: 1 });
          allSizes[p - 1] = { width: vp.width, height: vp.height };
        }
        if (active) {
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

  const fallbackPageSize = pageSizes[0] ?? DEFAULT_PDF_PAGE_SIZE;

  const pageLayouts = useMemo(() => {
    return Array.from({ length: numPages }, (_, idx) => {
      const p = idx + 1;
      const natural = pageSizes[idx] ?? fallbackPageSize;
      const pageAutoScale = computePdfAutoFitScale(natural, containerSize);
      const pageScale = fitMode === 'auto' ? pageAutoScale : manualScale;
      return {
        pageNum: p,
        scale: pageScale,
        autoScale: pageAutoScale,
        cssWidth: Math.max(1, Math.floor(natural.width * pageScale)),
        cssHeight: Math.max(1, Math.floor(natural.height * pageScale)),
      };
    });
  }, [numPages, pageSizes, fallbackPageSize, containerSize, fitMode, manualScale]);

  const activeLayout = pageLayouts[Math.max(0, Math.min(pageLayouts.length - 1, pageNum - 1))];
  const currentAutoScale = activeLayout?.autoScale ?? computePdfAutoFitScale(pageSizes[0] ?? null, containerSize);
  const scale = fitMode === 'auto' ? currentAutoScale : manualScale;
  const manualMinScale = Math.min(PDF_MANUAL_MIN_SCALE, currentAutoScale);
  const readyToRender =
    Boolean(pdfDoc) &&
    (fitMode !== 'auto' || (pageSizes[0] !== null && containerSize.width > 0 && containerSize.height > 0));

  const scrollToPage = useCallback(
    (targetPage: number) => {
      if (numPages <= 0) return;
      const clamped = Math.max(1, Math.min(numPages, targetPage));
      setPageNum(clamped);
      programmaticScrollRef.current = { targetPage: clamped, expiresAt: performance.now() + 700 };
      const container = scrollRef.current;
      const targetEl = pageElementsRef.current.get(clamped);
      if (container && targetEl) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const paddingTop = parseFloat(window.getComputedStyle(container).paddingTop) || 0;
        const nextTop = container.scrollTop + (targetRect.top - containerRect.top) - paddingTop;
        container.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
      }
    },
    [numPages]
  );

  const cancelProgrammaticScrollLock = useCallback(() => {
    programmaticScrollRef.current = null;
  }, []);

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const container = scrollRef.current;
      if (!container || numPages <= 0) return;

      const lock = programmaticScrollRef.current;
      if (lock) {
        const targetEl = pageElementsRef.current.get(lock.targetPage);
        const containerRect = container.getBoundingClientRect();
        const paddingTop = parseFloat(window.getComputedStyle(container).paddingTop) || 0;
        const reached =
          targetEl !== undefined &&
          Math.abs(targetEl.getBoundingClientRect().top - (containerRect.top + paddingTop)) <= 4;
        if (reached || performance.now() >= lock.expiresAt) {
          programmaticScrollRef.current = null;
        } else {
          return;
        }
      }

      const containerRect = container.getBoundingClientRect();
      const paddingTop = parseFloat(window.getComputedStyle(container).paddingTop) || 0;
      const rects: Array<{ pageNum: number; top: number; bottom: number }> = [];
      for (let p = 1; p <= numPages; p += 1) {
        const el = pageElementsRef.current.get(p);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        rects.push({ pageNum: p, top: r.top, bottom: r.bottom });
      }
      if (rects.length === 0) return;
      const nextActive = findActivePdfPage(containerRect.top, container.clientHeight, paddingTop, rects);
      setPageNum((prev) => (prev === nextActive ? prev : nextActive));
    });
  }, [numPages]);

  const handleGestureScaleChange = useCallback((nextScale: number, focal: RelativeFocalPoint | null) => {
    pendingFocalRef.current = focal;
    setFitMode('manual');
    setManualScale(nextScale);
  }, []);

  const applyStepZoom = useCallback(
    (delta: number) => {
      const scroll = scrollRef.current;
      const list = pagesListRef.current;
      if (scroll && list) {
        const rect = scroll.getBoundingClientRect();
        pendingFocalRef.current = captureRelativeFocalPoint(
          list.getBoundingClientRect(),
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
      }
      const next = clampZoomScale(Math.round((scale + delta) * 100) / 100, manualMinScale, PDF_MANUAL_MAX_SCALE);
      setFitMode('manual');
      setManualScale(next);
    },
    [scale, manualMinScale]
  );

  const handleResetFit = useCallback(() => {
    pendingFocalRef.current = null;
    setFitMode('auto');
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
    }
  }, []);

  useLayoutEffect(() => {
    const focal = pendingFocalRef.current;
    const scroll = scrollRef.current;
    const list = pagesListRef.current;
    if (!focal || !scroll || !list) return;
    pendingFocalRef.current = null;
    const { deltaX, deltaY } = computeFocalScrollDelta(list.getBoundingClientRect(), focal);
    if (Math.abs(deltaX) > 0.5) {
      scroll.scrollLeft = Math.max(0, scroll.scrollLeft + deltaX);
    }
    if (Math.abs(deltaY) > 0.5) {
      scroll.scrollTop = Math.max(0, scroll.scrollTop + deltaY);
    }
  }, [scale, fitMode]);

  const { isPanning } = useContentZoomGestures({
    scrollEl,
    contentEl: pagesListEl,
    scale,
    minScale: manualMinScale,
    maxScale: PDF_MANUAL_MAX_SCALE,
    enableDragPan: true,
    onScaleChange: handleGestureScaleChange,
    onGestureStart: cancelProgrammaticScrollLock,
  });

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  if (loading) return <div className="viewer-state muted-sm">PDFを読み込み中...</div>;
  if (error) return <div className="error-box" role="alert">{error}</div>;

  const isManuallyZoomed = fitMode === 'manual' && scale > currentAutoScale + 0.01;

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
            onClick={() => applyStepZoom(-0.2)}
          >
            −
          </button>
          <span className="muted-xs pdf-scale-indicator">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="btn btn-secondary btn-xs pdf-zoom-step-btn"
            aria-label="拡大"
            onClick={() => applyStepZoom(0.2)}
          >
            ＋
          </button>
        </div>
      </div>
      <div
        ref={setScrollContainerRef}
        className={`pdf-canvas-scroll content-zoom-surface${isManuallyZoomed ? ' is-pannable' : ''}${isPanning ? ' is-panning' : ''}`}
        data-zoom-scale={Math.round(scale * 100)}
        data-fit-mode={fitMode}
        onScroll={handleScroll}
        onWheel={cancelProgrammaticScrollLock}
        onTouchStart={cancelProgrammaticScrollLock}
      >
        <div ref={setPagesListContainerRef} className="pdf-pages-list">
          {pdfDoc &&
            pageLayouts.map((layout) => (
              <PdfPageCanvas
                key={`${url}:${layout.pageNum}`}
                url={url}
                pdfDoc={pdfDoc}
                pageNum={layout.pageNum}
                scale={layout.scale}
                cssWidth={layout.cssWidth}
                cssHeight={layout.cssHeight}
                scrollEl={scrollEl}
                readyToRender={readyToRender}
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
  const mediaElRef = useRef<HTMLImageElement | null>(null);
  const [mediaEl, setMediaEl] = useState<HTMLImageElement | null>(null);
  const pendingFocalRef = useRef<RelativeFocalPoint | null>(null);

  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [fitMode, setFitMode] = useState<'auto' | 'manual'>('auto');
  const [manualScale, setManualScale] = useState(1.0);

  const setScrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);

  const setMediaImageRef = useCallback((el: HTMLImageElement | null) => {
    mediaElRef.current = el;
    setMediaEl(el);
  }, []);

  useEffect(() => {
    setFitMode('auto');
    setManualScale(1.0);
    setNaturalSize(null);
    pendingFocalRef.current = null;
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

  const handleGestureScaleChange = useCallback((nextScale: number, focal: RelativeFocalPoint | null) => {
    pendingFocalRef.current = focal;
    setFitMode('manual');
    setManualScale(nextScale);
  }, []);

  const applyStepZoom = useCallback(
    (factor: number) => {
      const scroll = scrollRef.current;
      const img = mediaElRef.current;
      if (scroll && img) {
        const rect = scroll.getBoundingClientRect();
        pendingFocalRef.current = captureRelativeFocalPoint(
          img.getBoundingClientRect(),
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
      }
      const next = clampZoomScale(scale * factor, minScale, MEDIA_MAX_SCALE);
      setFitMode('manual');
      setManualScale(next);
    },
    [scale, minScale]
  );

  const handleResetFit = useCallback(() => {
    pendingFocalRef.current = null;
    setFitMode('auto');
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0, left: 0 });
    }
  }, []);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const img = mediaElRef.current;
      if (fitMode === 'auto' || scale <= autoFitScale * 1.05) {
        const target = clampZoomScale(Math.max(autoFitScale * 2, 1.5), minScale, MEDIA_MAX_SCALE);
        if (img) {
          pendingFocalRef.current = captureRelativeFocalPoint(img.getBoundingClientRect(), e.clientX, e.clientY);
        }
        setFitMode('manual');
        setManualScale(target);
      } else {
        handleResetFit();
      }
    },
    [fitMode, scale, autoFitScale, minScale, handleResetFit]
  );

  useLayoutEffect(() => {
    const focal = pendingFocalRef.current;
    const scroll = scrollRef.current;
    const img = mediaElRef.current;
    if (!focal || !scroll || !img) return;
    pendingFocalRef.current = null;
    const { deltaX, deltaY } = computeFocalScrollDelta(img.getBoundingClientRect(), focal);
    if (Math.abs(deltaX) > 0.5) {
      scroll.scrollLeft = Math.max(0, scroll.scrollLeft + deltaX);
    }
    if (Math.abs(deltaY) > 0.5) {
      scroll.scrollTop = Math.max(0, scroll.scrollTop + deltaY);
    }
  }, [scale, fitMode]);

  const { isPanning } = useContentZoomGestures({
    scrollEl,
    contentEl: mediaEl,
    scale,
    minScale,
    maxScale: MEDIA_MAX_SCALE,
    enableDragPan: true,
    onScaleChange: handleGestureScaleChange,
  });

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
            onClick={() => applyStepZoom(1 / MEDIA_ZOOM_STEP_FACTOR)}
          >
            −
          </button>
          <span className="muted-xs pdf-scale-indicator">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="btn btn-secondary btn-xs pdf-zoom-step-btn"
            aria-label="拡大"
            onClick={() => applyStepZoom(MEDIA_ZOOM_STEP_FACTOR)}
          >
            ＋
          </button>
        </div>
      </div>
      <div
        ref={setScrollContainerRef}
        className={`media-zoom-scroll content-zoom-surface${isOverflowing ? ' is-pannable' : ''}${isPanning ? ' is-panning' : ''}`}
        data-zoom-scale={Math.round(scale * 100)}
        data-fit-mode={fitMode}
      >
        <div className="media-zoom-canvas">
          <img
            ref={setMediaImageRef}
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
  filename: string;
  source: string;
}> = React.memo(({ versionKey, filename, source }) => {
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

  return (
    <div className="code-viewer-wrap">
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
      {query && filteredLines && filteredLines.length === 0 ? (
        <div className="empty-box muted-sm" role="status">
          「{deferredSearch.trim()}」に一致する行が見つかりませんでした。
        </div>
      ) : (
        <pre className="code-pre hljs viewer-code-pre">
          {displayHtml ? <code dangerouslySetInnerHTML={{ __html: displayHtml }} /> : <code>{displayText}</code>}
        </pre>
      )}
    </div>
  );
});

const TableViewer: React.FC<{
  versionKey: string;
  sheets: ParsedSheetData[];
}> = React.memo(({ versionKey, sheets }) => {
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

  return (
    <div className="stack-gap viewer-table">
      <div className="viewer-toolbar">
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
      {totalPages > 1 && (
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
      )}
    </div>
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
    [artifact.id, artifact.sha256, artifact.previewKind]
  );
  const convertedPdfUrl = useMemo(
    () => buildArtifactContentUrl(artifact, { convertedPdf: true }),
    [artifact.id, artifact.sha256, artifact.previewKind]
  );
  const downloadUrl = useMemo(
    () => buildArtifactContentUrl(artifact, { download: true }),
    [artifact.id, artifact.sha256, artifact.previewKind]
  );
  const sandboxUrl = useMemo(
    () => buildArtifactSandboxUrl(artifact),
    [artifact.id, artifact.sha256]
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
      return <CodeViewer versionKey={versionKey} filename={artifact.filename} source={textContent} />;
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
        return <TableViewer versionKey={versionKey} sheets={sheets} />;

      case 'docx':
        return (
          <div className="stack-gap">
            <div className="warn-banner">
              簡易HTML変換プレビューのため、段組や複雑なレイアウトは元のWord文書と異なる場合があります。
            </div>
            <div
              className="docx-preview"
              dangerouslySetInnerHTML={{ __html: sanitizedHtml ?? '' }}
            />
          </div>
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

        <div
          className={`modal-body viewer-body${
            viewMode === 'preview' &&
            (artifact.previewKind === 'pdf' ||
              artifact.previewKind === 'pptx' ||
              ((artifact.previewKind === 'image' || artifact.previewKind === 'svg') && !imageError))
              ? ' viewer-body-pdf'
              : ''
          }`}
        >
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
          {renderBody()}
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

