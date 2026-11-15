import { parsePatch } from 'diff';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import * as mammoth from 'mammoth';
import Papa from 'papaparse';
import * as pdfjsLib from 'pdfjs-dist';
import React, { useEffect, useRef, useState } from 'react';
import readXlsxFile from 'read-excel-file/browser';
import { ApiError, api } from '../api/client';
import type { ArtifactRecord, ProjectRecord } from '../types';
import { CheckIcon, ChevronIcon, CloseIcon, CopyIcon, DownloadIcon, SearchIcon } from './Icons';
import { MarkdownContent, MermaidBlock } from './MarkdownContent';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface ArtifactViewerModalProps {
  artifact: ArtifactRecord;
  projects: ProjectRecord[];
  onClose: () => void;
  onCopiedToProject?: (project: ProjectRecord, filename: string) => void;
}

const PdfCanvasViewer: React.FC<{ url: string }> = ({ url }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.25);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let loadedDoc: pdfjsLib.PDFDocumentProxy | null = null;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
          const j = await res.json().catch(() => null);
          throw new Error(j?.message || `PDF読込エラー (${res.status})`);
        }
        const buf = await res.arrayBuffer();
        const task = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
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
    let renderTask: pdfjsLib.RenderTask | null = null;

    const draw = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled || !canvasRef.current) return;
        const viewport = page.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderTask = page.render({ canvasContext: ctx, viewport, canvas });
        await renderTask.promise;
      } catch {
        // ignore abort when flipping pages quickly
      }
    };
    void draw();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNum, scale]);

  if (loading) return <div className="viewer-state muted-sm">PDFを読み込み中...</div>;
  if (error) return <div className="error-box">{error}</div>;

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
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => setScale((s) => Math.max(0.6, s - 0.2))}>
            −
          </button>
          <span className="muted-xs">{Math.round(scale * 100)}%</span>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => setScale((s) => Math.min(2.6, s + 0.2))}>
            ＋
          </button>
        </div>
      </div>
      <div className="pdf-canvas-scroll">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
};

const DiffPatchView: React.FC<{ patch: string }> = ({ patch }) => {
  let files;
  try {
    files = parsePatch(patch);
  } catch {
    files = null;
  }

  if (!files || files.length === 0) {
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
};

export const ArtifactViewerModal: React.FC<ArtifactViewerModalProps> = ({
  artifact,
  projects,
  onClose,
  onCopiedToProject,
}) => {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [sanitizedHtml, setSanitizedHtml] = useState<string | null>(null);
  const [svgBlobUrl, setSvgBlobUrl] = useState<string | null>(null);
  const [sheets, setSheets] = useState<Array<{ name: string; rows: string[][] }>>([]);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [viewMode, setViewMode] = useState<'preview' | 'source' | 'diff'>(
    artifact.previewKind === 'diff' ? 'diff' : 'preview'
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [imageZoom, setImageZoom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState(projects[0]?.id ?? '');
  const [copyProjectMsg, setCopyProjectMsg] = useState<string | null>(null);

  const contentUrl = `/api/files/${artifact.id}/content`;
  const downloadUrl = `/api/files/${artifact.id}/content?download=1`;
  const sandboxUrl = `/api/files/${artifact.id}/sandbox`;

  useEffect(() => {
    let active = true;
    let createdBlobUrl: string | null = null;

    setLoading(true);
    setError(null);
    setTextContent(null);
    setSanitizedHtml(null);
    setSvgBlobUrl(null);
    setSheets([]);
    setActiveSheetIdx(0);
    setViewMode(artifact.previewKind === 'diff' ? 'diff' : 'preview');

    const load = async () => {
      try {
        const kind = artifact.previewKind;
        if (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf' || kind === 'pptx' || kind === 'binary') {
          setLoading(false);
          return;
        }

        const res = await fetch(contentUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(`ファイルの取得に失敗しました (${res.status})`);

        if (kind === 'table') {
          const isXlsx = artifact.filename.toLowerCase().endsWith('.xlsx');
          if (isXlsx) {
            const buf = await res.arrayBuffer();
            const parsedSheets = await readXlsxFile(buf);
            if (!active) return;
            setSheets(
              parsedSheets.map((s) => ({
                name: s.sheet || 'Sheet',
                rows: s.data.map((r) =>
                  r.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
                ),
              }))
            );
          } else {
            const txt = await res.text();
            if (!active) return;
            setTextContent(txt);
            const parsed = Papa.parse<string[]>(txt, { skipEmptyLines: false });
            setSheets([{ name: artifact.filename, rows: parsed.data }]);
          }
          setLoading(false);
          return;
        }

        if (kind === 'docx') {
          const buf = await res.arrayBuffer();
          const result = await mammoth.convertToHtml({ arrayBuffer: buf });
          if (!active) return;
          setSanitizedHtml(DOMPurify.sanitize(result.value));
          setLoading(false);
          return;
        }

        const txt = await res.text();
        if (!active) return;
        setTextContent(txt);

        if (kind === 'svg') {
          const cleanSvg = DOMPurify.sanitize(txt, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
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
  }, [artifact.id, artifact.previewKind, artifact.filename, contentUrl]);

  const handleCopyText = async () => {
    const data = viewMode === 'diff' && artifact.diffPatch ? artifact.diffPatch : textContent;
    if (!data) return;
    await navigator.clipboard.writeText(data);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const handleCopyCsv = async () => {
    const active = sheets[activeSheetIdx];
    if (!active) return;
    const csv = active.rows
      .map((r) =>
        r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')
      )
      .join('\n');
    await navigator.clipboard.writeText(csv);
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

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const renderCodeWithOptionalFilter = (source: string) => {
    const lines = source.split('\n');
    const q = searchTerm.trim().toLowerCase();
    const filtered = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
    const joined = filtered.join('\n');
    let html = '';
    try {
      if (joined.length < 40_000) {
        html = hljs.highlightAuto(joined).value;
      }
    } catch {
      html = '';
    }
    return (
      <div className="code-viewer-wrap">
        <div className="viewer-search-row">
          <SearchIcon size={14} />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="ファイル内を行検索..."
          />
          {q && (
            <span className="muted-xs">
              {filtered.length} / {lines.length} 行
            </span>
          )}
        </div>
        <pre className="code-pre hljs viewer-code-pre">
          {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{joined}</code>}
        </pre>
      </div>
    );
  };

  const renderBody = () => {
    if (loading) return <div className="viewer-state muted-sm">ファイルを読み込み中...</div>;
    if (error) return <div className="error-box">{error}</div>;

    if (viewMode === 'diff' && artifact.diffPatch) {
      return <DiffPatchView patch={artifact.diffPatch} />;
    }

    if (viewMode === 'source' && textContent !== null) {
      return renderCodeWithOptionalFilter(textContent);
    }

    switch (artifact.previewKind) {
      case 'image':
        return (
          <div className="media-stage">
            <img
              src={contentUrl}
              alt={artifact.filename}
              className={imageZoom ? 'viewer-img zoomed' : 'viewer-img'}
              onClick={() => setImageZoom((z) => !z)}
            />
          </div>
        );

      case 'svg':
        return (
          <div className="media-stage">
            {svgBlobUrl ? (
              <img src={svgBlobUrl} alt={artifact.filename} className="viewer-img" />
            ) : (
              <div className="muted-sm">SVGを表示できません</div>
            )}
          </div>
        );

      case 'pdf':
        return <PdfCanvasViewer url={contentUrl} />;

      case 'pptx':
        return (
          <div className="stack-gap">
            <div className="info-banner">
              プレゼンファイル (.pptx) を確認するには、PDF変換表示または原本ダウンロードをご利用ください。
            </div>
            <PdfCanvasViewer url={`${contentUrl}?converted=pdf`} />
          </div>
        );

      case 'table': {
        const sheet = sheets[activeSheetIdx];
        if (!sheet) return <div className="muted-sm">表データが空です</div>;
        return (
          <div className="stack-gap">
            <div className="viewer-toolbar">
              <div className="row-actions">
                {sheets.length > 1 &&
                  sheets.map((s, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={idx === activeSheetIdx ? 'chip-btn active' : 'chip-btn'}
                      onClick={() => setActiveSheetIdx(idx)}
                    >
                      {s.name}
                    </button>
                  ))}
              </div>
              <button type="button" className="btn btn-secondary btn-xs" onClick={handleCopyCsv}>
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                <span>CSVコピー</span>
              </button>
            </div>
            <div className="md-table-scroll viewer-table-scroll">
              <table>
                <tbody>
                  {sheet.rows.slice(0, 500).map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) =>
                        rIdx === 0 ? <th key={cIdx}>{cell}</th> : <td key={cIdx}>{cell}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {sheet.rows.length > 500 && (
                <div className="muted-xs" style={{ padding: '8px' }}>
                  先頭500行を表示中（全{sheet.rows.length}行 — 全件確認はダウンロードをご利用ください）
                </div>
              )}
            </div>
          </div>
        );
      }

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
          <div className="stack-gap">
            <div className="info-banner">
              分離オリジン (<code>sandbox="allow-scripts"</code> + 厳格CSP) で安全にプレビューしています。外部通信や親ページ権限へのアクセスは遮断されています。
            </div>
            <iframe
              sandbox="allow-scripts"
              src={sandboxUrl}
              title={artifact.filename}
              className="html-sandbox-frame"
            />
          </div>
        );

      case 'mermaid':
        return <MermaidBlock code={textContent ?? ''} />;

      case 'markdown':
        return <MarkdownContent content={textContent ?? ''} />;

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
        return renderCodeWithOptionalFilter(textContent ?? '');

      default:
        return (
          <div className="binary-card">
            <div className="kv-label">{artifact.filename}</div>
            <div className="muted-sm">
              MIME: {artifact.mimeType} ・ サイズ: {formatSize(artifact.sizeBytes)}
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

  const supportsSourceToggle = ['markdown', 'html', 'mermaid', 'svg'].includes(artifact.previewKind);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-xl viewer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="viewer-title-group">
            <h3>{artifact.filename}</h3>
            <span className="muted-xs">
              {artifact.relPath} ・ {formatSize(artifact.sizeBytes)}
            </span>
          </div>
          <div className="row-actions">
            {supportsSourceToggle && (
              <button
                type="button"
                className={`btn btn-secondary btn-xs ${viewMode === 'source' ? 'active' : ''}`}
                onClick={() => setViewMode(viewMode === 'source' ? 'preview' : 'source')}
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
            {textContent !== null && (
              <button type="button" className="btn btn-secondary btn-xs" onClick={handleCopyText}>
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

        <div className="modal-body viewer-body">{renderBody()}</div>

        {projects.length > 0 && (
          <div className="viewer-footer">
            <div className="row-actions">
              <select
                value={targetProjectId}
                onChange={(e) => setTargetProjectId(e.target.value)}
                className="compact-select"
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
              {copyProjectMsg && <span className="muted-xs">{copyProjectMsg}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
