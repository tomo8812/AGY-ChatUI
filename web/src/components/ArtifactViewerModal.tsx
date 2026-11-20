import { ModalDialog } from './ModalDialog';
import type { StructuredPatch } from 'diff';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import type * as PdfJsTypes from 'pdfjs-dist';
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { ArtifactRecord, ProjectRecord } from '../types';
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
  canvas.style.width = `${entry.cssWidth}px`;
  canvas.style.height = `${entry.cssHeight}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(entry.bitmap, 0, 0);
}

const PdfCanvasViewer: React.FC<{ url: string }> = React.memo(({ url }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfJsTypes.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.25);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [pageNum, url]);

  useEffect(() => {
    let active = true;
    let loadedDoc: PdfJsTypes.PDFDocumentProxy | null = null;
    setLoading(true);
    setError(null);
    setPdfDoc(null);
    setNumPages(0);
    setPageNum(1);

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
    if (!pdfDoc || !canvasRef.current) return;
    let cancelled = false;
    let activeTask: PdfJsTypes.RenderTask | null = null;
    let prefetchTimer: number | undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const drawAndPrefetch = async () => {
      try {
        const key = makePdfBitmapKey(url, pageNum, scale, dpr);
        let cached = pdfPageBitmapCache.get(key);
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

        // Pre-render adjacent pages sequentially while idle for instant page flipping
        const neighbors = [pageNum + 1, pageNum - 1].filter((p) => p >= 1 && p <= numPages);
        if (neighbors.length > 0) {
          prefetchTimer = window.setTimeout(() => {
            const runPrefetch = async () => {
              for (const nPage of neighbors) {
                if (cancelled) break;
                const nKey = makePdfBitmapKey(url, nPage, scale, dpr);
                if (pdfPageBitmapCache.has(nKey)) continue;
                try {
                  const rendered = await renderPdfPageToBitmap(pdfDoc, nPage, scale, dpr, (t) => {
                    activeTask = t;
                  });
                  if (cancelled) {
                    if (typeof ImageBitmap !== 'undefined' && rendered.bitmap instanceof ImageBitmap) {
                      rendered.bitmap.close();
                    }
                    break;
                  }
                  pdfPageBitmapCache.set(nKey, rendered);
                } catch {
                  // ignore cancelled pre-render
                }
              }
            };
            void runPrefetch();
          }, 80);
        }
      } catch {
        // ignore abort when flipping pages quickly
      }
    };

    void drawAndPrefetch();

    return () => {
      cancelled = true;
      if (prefetchTimer !== undefined) window.clearTimeout(prefetchTimer);
      activeTask?.cancel();
    };
  }, [pdfDoc, url, pageNum, numPages, scale]);

  if (loading) return <div className="viewer-state muted-sm">PDFを読み込み中...</div>;
  if (error) return <div className="error-box" role="alert">{error}</div>;

  return (
    <div className="pdf-viewer-wrap">
      <div className="viewer-toolbar">
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={pageNum <= 1}
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
          >
            <ChevronIcon size={14} dir="left" /> 前
          </button>
          <span className="muted-xs">
            {pageNum} / {numPages}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={pageNum >= numPages}
            onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
          >
            次 <ChevronIcon size={14} dir="right" />
          </button>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            aria-label="縮小"
            onClick={() => setScale((s) => Math.max(0.6, Math.round((s - 0.2) * 10) / 10))}
          >
            −
          </button>
          <span className="muted-xs">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            aria-label="拡大"
            onClick={() => setScale((s) => Math.min(2.6, Math.round((s + 0.2) * 10) / 10))}
          >
            ＋
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="pdf-canvas-scroll">
        <canvas ref={canvasRef} />
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
  const [imageZoom, setImageZoom] = useState(false);
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
    setImageZoom(false);
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
        if (!src || imageError) {
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
        return (
          <div className={`media-stage ${imageZoom ? 'is-zoomed' : ''}`}>
            <button
              type="button"
              className={`image-zoom-button ${imageZoom ? 'is-zoomed' : ''}`}
              aria-label={imageZoom ? `${artifact.filename} の拡大表示を解除` : `${artifact.filename} を拡大表示`}
              aria-pressed={imageZoom}
              onClick={() => setImageZoom((zoom) => !zoom)}
            >
              <img
                src={src}
                alt={artifact.filename}
                decoding="async"
                className={imageZoom ? 'viewer-img zoomed' : 'viewer-img'}
                onError={() => setImageError(true)}
              />
            </button>
          </div>
        );
      }

      case 'pdf':
        return <PdfCanvasViewer url={contentUrl} />;

      case 'pptx':
        return (
          <div className="stack-gap">
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

        <div className="modal-body viewer-body">
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

