import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import React, { useEffect, useId, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { api } from '../api/client';
import type { ArtifactRecord } from '../types';
import { CheckIcon, CopyIcon, DownloadIcon } from './Icons';

function getEffectiveTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function extForLang(lang: string): string {
  const map: Record<string, string> = {
    typescript: 'ts',
    ts: 'ts',
    tsx: 'tsx',
    javascript: 'js',
    js: 'js',
    jsx: 'jsx',
    python: 'py',
    py: 'py',
    bash: 'sh',
    sh: 'sh',
    zsh: 'sh',
    json: 'json',
    yaml: 'yaml',
    yml: 'yml',
    html: 'html',
    css: 'css',
    sql: 'sql',
    rust: 'rs',
    go: 'go',
    markdown: 'md',
    md: 'md',
  };
  return map[lang.toLowerCase()] || 'txt';
}

function extractReactText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractReactText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return extractReactText(node.props.children);
  }
  return '';
}

export const MermaidBlock: React.FC<{ code: string }> = ({ code }) => {
  const uid = useId().replace(/:/g, '_');
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    const render = async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: getEffectiveTheme() === 'dark' ? 'dark' : 'default',
        });
        const result = await mermaid.render(`mmd_${uid}_${Date.now()}`, code.trim());
        if (!active) return;
        const safeSvg = DOMPurify.sanitize(result.svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
        setSvgHtml(safeSvg);
        setRenderError(null);
      } catch (err) {
        if (!active) return;
        setRenderError(err instanceof Error ? err.message : 'Mermaidの描画に失敗しました');
      }
    };
    void render();
    return () => {
      active = false;
    };
  }, [code, uid]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="rich-block mermaid-card">
      <div className="rich-block-head">
        <span className="lang-pill">Mermaid 図</span>
        <div className="row-actions">
          <button type="button" className="chip-btn" onClick={() => setShowSource((v) => !v)}>
            {showSource ? '図を表示' : 'ソース'}
          </button>
          <button type="button" className="chip-btn" onClick={handleCopy}>
            {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            <span>{copied ? 'コピー済' : 'コピー'}</span>
          </button>
        </div>
      </div>
      {showSource || renderError ? (
        <div>
          {renderError && <div className="muted-xs mermaid-warn">図の構文エラー: {renderError}</div>}
          <pre className="code-pre">
            <code>{code}</code>
          </pre>
        </div>
      ) : svgHtml ? (
        <div className="mermaid-svg-wrap" dangerouslySetInnerHTML={{ __html: svgHtml }} />
      ) : (
        <div className="mermaid-loading muted-sm">図を描画中...</div>
      )}
    </div>
  );
};

export const CodeBlock: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const normalized = code.replace(/\n$/, '');
  const lineCount = normalized.split('\n').length;

  let highlightedHtml = '';
  try {
    if (language && hljs.getLanguage(language)) {
      highlightedHtml = hljs.highlight(normalized, { language }).value;
    } else if (normalized.length < 25_000) {
      highlightedHtml = hljs.highlightAuto(normalized).value;
    }
  } catch {
    highlightedHtml = '';
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(normalized);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const handleDownload = () => {
    const ext = extForLang(language);
    const blob = new Blob([normalized + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `snippet.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="rich-block code-card">
      <div className="rich-block-head">
        <span className="lang-pill">{language || 'text'} ({lineCount}行)</span>
        <div className="row-actions">
          <button type="button" className="chip-btn" onClick={() => setWrapped((w) => !w)}>
            {wrapped ? '折返し解除' : '折返し'}
          </button>
          {lineCount > 14 && (
            <button type="button" className="chip-btn" onClick={() => setCollapsed((c) => !c)}>
              {collapsed ? '展開' : '畳む'}
            </button>
          )}
          <button type="button" className="chip-btn" onClick={handleDownload} title="ファイルとして保存">
            <DownloadIcon size={13} />
          </button>
          <button type="button" className="chip-btn" onClick={handleCopy}>
            {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            <span>{copied ? 'コピー済' : 'コピー'}</span>
          </button>
        </div>
      </div>
      {!collapsed && (
        <pre className={`code-pre hljs ${wrapped ? 'wrapped' : ''}`}>
          {highlightedHtml ? (
            <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          ) : (
            <code>{normalized}</code>
          )}
        </pre>
      )}
    </div>
  );
};

const CopyableTable: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tableRef = useRef<HTMLTableElement>(null);
  const [copiedMode, setCopiedMode] = useState<'md' | 'csv' | null>(null);

  const extractRows = (): string[][] => {
    const table = tableRef.current;
    if (!table) return [];
    const rows: string[][] = [];
    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      const cells = Array.from(tr.querySelectorAll('th, td')).map((c) =>
        (c.textContent ?? '').replace(/\s+/g, ' ').trim()
      );
      if (cells.length > 0) rows.push(cells);
    }
    return rows;
  };

  const handleCopyMarkdown = async () => {
    const rows = extractRows();
    if (rows.length === 0) return;
    const header = `| ${rows[0].map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
    const sep = `| ${rows[0].map(() => '---').join(' | ')} |`;
    const body = rows.slice(1).map((r) => `| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`);
    await navigator.clipboard.writeText([header, sep, ...body].join('\n'));
    setCopiedMode('md');
    setTimeout(() => setCopiedMode(null), 1600);
  };

  const handleCopyCsv = async () => {
    const rows = extractRows();
    if (rows.length === 0) return;
    const csv = rows
      .map((r) =>
        r
          .map((cell) =>
            /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
          )
          .join(',')
      )
      .join('\n');
    await navigator.clipboard.writeText(csv);
    setCopiedMode('csv');
    setTimeout(() => setCopiedMode(null), 1600);
  };

  return (
    <div className="rich-block table-card">
      <div className="rich-block-head">
        <span className="lang-pill">テーブル</span>
        <div className="row-actions">
          <button type="button" className="chip-btn" onClick={handleCopyMarkdown}>
            {copiedMode === 'md' ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            <span>{copiedMode === 'md' ? 'MDコピー済' : 'Markdown'}</span>
          </button>
          <button type="button" className="chip-btn" onClick={handleCopyCsv}>
            {copiedMode === 'csv' ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            <span>{copiedMode === 'csv' ? 'CSVコピー済' : 'CSV'}</span>
          </button>
        </div>
      </div>
      <div className="md-table-scroll">
        <table ref={tableRef}>{children}</table>
      </div>
    </div>
  );
};

const CopyableBlockquote: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const quoteRef = useRef<HTMLQuoteElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const txt = quoteRef.current?.innerText?.trim() ?? '';
    if (!txt) return;
    await navigator.clipboard.writeText(txt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="quote-wrap">
      <blockquote ref={quoteRef}>{children}</blockquote>
      <button type="button" className="quote-copy-btn" onClick={handleCopy} title="引用文をコピー">
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
    </div>
  );
};

const WorkspaceImage: React.FC<{
  chatId?: string;
  src: string;
  alt?: string;
  onOpenArtifact?: (artifact: ArtifactRecord) => void;
}> = ({ chatId, src, alt, onOpenArtifact }) => {
  const [resolved, setResolved] = useState<{ url: string; artifact: ArtifactRecord } | null>(null);
  const [failed, setFailed] = useState(false);

  const isDirect = /^https?:|^data:|^blob:|^\/api\/files\//i.test(src);

  useEffect(() => {
    if (isDirect || !chatId) return;
    let active = true;
    api
      .resolveLink(chatId, src)
      .then((res) => {
        if (!active) return;
        setResolved({ url: res.previewUrl, artifact: res.artifact });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [chatId, src, isDirect]);

  if (isDirect) {
    return <img src={src} alt={alt ?? ''} className="md-inline-img" loading="lazy" />;
  }
  if (failed) {
    return <span className="muted-xs">[画像リンク解決不可: {alt || src}]</span>;
  }
  if (!resolved) {
    return <span className="muted-xs">画像読込中...</span>;
  }
  return (
    <img
      src={resolved.url}
      alt={alt ?? resolved.artifact.filename}
      className="md-inline-img clickable"
      loading="lazy"
      onClick={() => onOpenArtifact?.(resolved.artifact)}
    />
  );
};

export interface MarkdownContentProps {
  content: string;
  chatId?: string;
  onOpenArtifact?: (artifact: ArtifactRecord) => void;
  onResolveError?: (message: string) => void;
}

export const MarkdownContent: React.FC<MarkdownContentProps> = React.memo(
  ({ content, chatId, onOpenArtifact, onResolveError }) => {
    const handleWorkspaceHref = async (href: string) => {
      if (!chatId || !onOpenArtifact) return;
      try {
        const res = await api.resolveLink(chatId, href);
        onOpenArtifact(res.artifact);
      } catch {
        onResolveError?.(`参照されたファイル "${href}" を開けませんでした（存在しないかアクセス権限がありません）。`);
      }
    };

    return (
      <div className="md-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            pre: ({ children }) => {
              const first = Array.isArray(children) ? children[0] : children;
              if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(first)) {
                const className = first.props.className ?? '';
                const langMatch = /language-([^\s]+)/.exec(className);
                const lang = langMatch ? langMatch[1] : '';
                const rawCode = extractReactText(first.props.children);
                if (lang.toLowerCase() === 'mermaid') {
                  return <MermaidBlock code={rawCode} />;
                }
                return <CodeBlock language={lang} code={rawCode} />;
              }
              return <pre className="code-pre">{children}</pre>;
            },
            code: ({ className, children, ...props }) => {
              return (
                <code className={`inline-code ${className ?? ''}`} {...props}>
                  {children}
                </code>
              );
            },
            table: ({ children }) => <CopyableTable>{children}</CopyableTable>,
            blockquote: ({ children }) => <CopyableBlockquote>{children}</CopyableBlockquote>,
            a: ({ href, children }) => {
              const rawHref = href ?? '';
              const isExternal = /^https?:\/\/|^mailto:/i.test(rawHref);
              if (isExternal) {
                return (
                  <a href={rawHref} target="_blank" rel="noopener noreferrer" className="md-link external">
                    {children}
                  </a>
                );
              }
              return (
                <button
                  type="button"
                  className="md-link workspace-file-link"
                  onClick={() => void handleWorkspaceHref(rawHref)}
                  title={`ワークスペース内のファイルをプレビュー: ${rawHref}`}
                >
                  {children}
                </button>
              );
            },
            img: ({ src, alt }) => (
              <WorkspaceImage
                chatId={chatId}
                src={src ?? ''}
                alt={alt}
                onOpenArtifact={onOpenArtifact}
              />
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }
);
