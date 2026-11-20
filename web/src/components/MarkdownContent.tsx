import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import React, { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { ArtifactRecord, MessageRecord } from '../types';
import {
  codeHighlightCache,
  fastTextHash,
  mermaidSvgCache,
  normalizeClientLinkReference,
  peekResolvedLink,
  resolveLinkCached,
  subscribeArtifactUpdates,
} from '../utils/viewerCache';
import { CheckIcon, CopyIcon, DownloadIcon } from './Icons';

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

let mermaidRenderSeq = 0;

const markdownUrlTransform = (url: string): string => {
  if (/^file:\/\//i.test(url.trim())) {
    return url.trim();
  }
  return defaultUrlTransform(url);
};

function getEffectiveTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
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

export const MermaidBlock: React.FC<{ code: string; streaming?: boolean }> = React.memo(
  ({ code, streaming = false }) => {
    const uid = useId().replace(/:/g, '_');
    const trimmed = code.trim();
    const theme = useSyncExternalStore(subscribeTheme, getEffectiveTheme);
    const cacheKey = `${theme}:${fastTextHash(trimmed)}`;

    const [svgHtml, setSvgHtml] = useState<string | null>(() => mermaidSvgCache.get(cacheKey) ?? null);
    const [showSource, setShowSource] = useState(false);
    const [renderError, setRenderError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
      const cached = mermaidSvgCache.get(cacheKey);
      if (cached) {
        setSvgHtml(cached);
        setRenderError(null);
        return;
      }
      if (!trimmed) {
        setSvgHtml(null);
        return;
      }

      let active = true;
      const delayMs = streaming ? 240 : 0;
      const timer = window.setTimeout(() => {
        const render = async () => {
          try {
            const mermaid = (await import('mermaid')).default;
            mermaid.initialize({
              startOnLoad: false,
              securityLevel: 'strict',
              theme: theme === 'dark' ? 'dark' : 'default',
            });
            mermaidRenderSeq += 1;
            const result = await mermaid.render(`mmd_${uid}_${mermaidRenderSeq}`, trimmed);
            if (!active) return;
            const safeSvg = DOMPurify.sanitize(result.svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
            });
            mermaidSvgCache.set(cacheKey, safeSvg);
            setSvgHtml(safeSvg);
            setRenderError(null);
          } catch (err) {
            if (!active) return;
            if (!streaming) {
              setRenderError(err instanceof Error ? err.message : 'Mermaidの描画に失敗しました');
            }
          }
        };
        void render();
      }, delayMs);

      return () => {
        active = false;
        window.clearTimeout(timer);
      };
    }, [trimmed, cacheKey, theme, streaming, uid]);

    const handleCopy = useCallback(async () => {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }, [code]);

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
        {showSource || (renderError && !streaming) ? (
          <div>
            {renderError && !streaming && <div className="muted-xs mermaid-warn">図の構文エラー: {renderError}</div>}
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
  }
);

export const CodeBlock: React.FC<{ language: string; code: string; streaming?: boolean }> = React.memo(
  ({ language, code, streaming = false }) => {
    const [copied, setCopied] = useState(false);
    const [wrapped, setWrapped] = useState(false);
    const [collapsed, setCollapsed] = useState(false);

    const normalized = useMemo(() => code.replace(/\n$/, ''), [code]);
    const lineCount = useMemo(() => normalized.split('\n').length, [normalized]);

    const highlightedHtml = useMemo(() => {
      const langKey = (language || 'auto').toLowerCase();
      const cacheKey = `block:${langKey}:${fastTextHash(normalized)}`;
      const cached = codeHighlightCache.get(cacheKey);
      if (cached) return cached.html;

      try {
        if (language && hljs.getLanguage(language) && normalized.length < 100_000) {
          const res = hljs.highlight(normalized, { language });
          if (!streaming) {
            codeHighlightCache.set(cacheKey, { html: res.value, language });
          }
          return res.value;
        }
        if (!streaming && normalized.length < 25_000) {
          const res = hljs.highlightAuto(normalized);
          codeHighlightCache.set(cacheKey, { html: res.value, language: res.language ?? 'auto' });
          return res.value;
        }
      } catch {
        // fallback to plain code
      }
      return '';
    }, [language, normalized, streaming]);

    const handleCopy = useCallback(async () => {
      await navigator.clipboard.writeText(normalized);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }, [normalized]);

    const handleDownload = useCallback(() => {
      const ext = extForLang(language);
      const blob = new Blob([normalized + '\n'], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `snippet.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, [language, normalized]);

    return (
      <div className="rich-block code-card">
        <div className="rich-block-head">
          <span className="lang-pill">
            {language || 'text'} ({lineCount}行)
          </span>
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
            {highlightedHtml ? <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} /> : <code>{normalized}</code>}
          </pre>
        )}
      </div>
    );
  }
);

const CopyableTable: React.FC<{ children: React.ReactNode }> = React.memo(({ children }) => {
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
          .map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
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
});

const CopyableBlockquote: React.FC<{ children: React.ReactNode }> = React.memo(({ children }) => {
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
});

const DIRECT_URL_RE = /^https?:|^data:|^blob:|^\/api\/files\//i;

const WorkspaceImage: React.FC<{
  chatId?: string;
  src: string;
  alt?: string;
  messageStatus?: MessageRecord['status'];
  onOpenArtifact?: (artifact: ArtifactRecord) => void;
}> = React.memo(({ chatId, src, alt, messageStatus, onOpenArtifact }) => {
  const isDirect = DIRECT_URL_RE.test(src);

  const [resolved, setResolved] = useState<{ url: string; artifact: ArtifactRecord } | null>(() => {
    if (isDirect || !chatId || !src) return null;
    const hit = peekResolvedLink(chatId, src);
    return hit ? { url: hit.previewUrl, artifact: hit.artifact } : null;
  });
  const [failed, setFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const prevStatusRef = useRef<MessageRecord['status'] | undefined>(messageStatus);

  useEffect(() => {
    if (isDirect || !chatId || !src) {
      setResolved(null);
      setFailed(false);
      return;
    }
    const hit = peekResolvedLink(chatId, src);
    if (hit) {
      setResolved((cur) =>
        cur && cur.url === hit.previewUrl && cur.artifact.updatedAt === hit.artifact.updatedAt
          ? cur
          : { url: hit.previewUrl, artifact: hit.artifact }
      );
      setFailed(false);
    } else {
      setResolved(null);
      setFailed(false);
      setRetryToken(0);
    }
  }, [chatId, src, isDirect]);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = messageStatus;
    if (prev !== 'completed' && messageStatus === 'completed' && !resolved && !isDirect && chatId && src) {
      setFailed(false);
      setRetryToken((t) => t + 1);
    }
  }, [messageStatus, resolved, isDirect, chatId, src]);

  useEffect(() => {
    if (isDirect || !chatId || !src || resolved) return;
    let active = true;
    let retryTimer: number | undefined;

    const attemptResolve = (allowRetry: boolean, forceRefresh = false) => {
      resolveLinkCached(chatId, src, { forceRefresh })
        .then((res) => {
          if (!active) return;
          setFailed(false);
          setResolved({ url: res.previewUrl, artifact: res.artifact });
        })
        .catch(() => {
          if (!active) return;
          if (allowRetry) {
            retryTimer = window.setTimeout(() => {
              if (active) attemptResolve(false, true);
            }, 500);
          } else {
            setFailed(true);
          }
        });
    };

    attemptResolve(true, retryToken > 0);

    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [chatId, src, isDirect, retryToken, resolved]);

  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  // Keep inline image URL up-to-date when artifact bytes change on server
  useEffect(() => {
    if (isDirect || !chatId || !src) return;
    const normalizedSrc = normalizeClientLinkReference(src);
    return subscribeArtifactUpdates((updated) => {
      if (updated.chatId !== chatId) return;
      const curResolved = resolvedRef.current;
      const matchesCurrent =
        (curResolved && curResolved.artifact.id === updated.id) ||
        (normalizedSrc && (updated.relPath === normalizedSrc || updated.id === normalizedSrc));
      if (matchesCurrent) {
        const refreshed = peekResolvedLink(chatId, updated.relPath);
        const nextUrl =
          refreshed?.previewUrl ??
          (updated.sha256
            ? `/api/files/${updated.id}/content?v=${updated.sha256.slice(0, 12)}`
            : `/api/files/${updated.id}/content`);
        setFailed(false);
        setResolved({ url: nextUrl, artifact: updated });
      }
    });
  }, [chatId, src, isDirect]);

  if (isDirect) {
    return <img src={src} alt={alt ?? ''} className="md-inline-img" loading="lazy" decoding="async" />;
  }
  if (!src) {
    return <span className="muted-xs">[画像リンク解決不可: {alt || '空のパス'}]</span>;
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
      decoding="async"
      onClick={() => onOpenArtifact?.(resolved.artifact)}
    />
  );
});

interface MarkdownRenderContextValue {
  chatId?: string;
  messageStatus?: MessageRecord['status'];
  onOpenArtifact?: (artifact: ArtifactRecord) => void;
  onWorkspaceHref: (href: string) => void;
}

const MarkdownRenderContext = React.createContext<MarkdownRenderContextValue>({
  onWorkspaceHref: () => {},
});

const MarkdownPre: React.FC<{ children?: React.ReactNode }> = React.memo(({ children }) => {
  const { messageStatus } = useContext(MarkdownRenderContext);
  const first = Array.isArray(children) ? children[0] : children;
  if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(first)) {
    const className = first.props.className ?? '';
    const langMatch = /language-([^\s]+)/.exec(className);
    const lang = langMatch ? langMatch[1] : '';
    const rawCode = extractReactText(first.props.children);
    const isStreaming = messageStatus === 'streaming';
    if (lang.toLowerCase() === 'mermaid') {
      return <MermaidBlock code={rawCode} streaming={isStreaming} />;
    }
    return <CodeBlock language={lang} code={rawCode} streaming={isStreaming} />;
  }
  return <pre className="code-pre">{children}</pre>;
});

const MarkdownCode: React.FC<React.HTMLAttributes<HTMLElement>> = React.memo(
  ({ className, children, ...props }) => (
    <code className={`inline-code ${className ?? ''}`} {...props}>
      {children}
    </code>
  )
);

const FileLinkButton: React.FC<{
  reference: string;
  onOpen: (reference: string) => void;
  children: React.ReactNode;
}> = ({ reference, onOpen, children }) => (
  <button
    type="button"
    className="md-link workspace-file-link"
    onClick={() => onOpen(reference)}
    title={reference ? `ファイルをプレビュー: ${reference}` : '空のリンク'}
  >
    {children}
  </button>
);

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const createMarkdownHeading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => {
  const HeadingComponent: React.FC<
    React.HTMLAttributes<HTMLHeadingElement> & { node?: unknown }
  > = ({ id, children, node: _node, ...props }) => {
    const computedId = id || slugifyHeading(extractReactText(children)) || undefined;
    return (
      <Tag id={computedId} {...props}>
        {children}
      </Tag>
    );
  };
  return React.memo(HeadingComponent);
};

const MarkdownH1 = createMarkdownHeading('h1');
const MarkdownH2 = createMarkdownHeading('h2');
const MarkdownH3 = createMarkdownHeading('h3');
const MarkdownH4 = createMarkdownHeading('h4');
const MarkdownH5 = createMarkdownHeading('h5');
const MarkdownH6 = createMarkdownHeading('h6');

const MarkdownLink: React.FC<{ href?: string; children?: React.ReactNode }> = React.memo(({ href, children }) => {
  const { onWorkspaceHref } = useContext(MarkdownRenderContext);
  const rawHref = (href ?? '').trim();
  if (rawHref.startsWith('#')) {
    const rawTarget = rawHref.slice(1);
    let decodedTarget = rawTarget;
    try {
      decodedTarget = decodeURIComponent(rawTarget);
    } catch {
      // keep raw
    }
    const normalizedTarget = slugifyHeading(decodedTarget);
    return (
      <a
        href={rawHref}
        className="md-link md-anchor-link"
        onClick={(e) => {
          e.preventDefault();
          const container = e.currentTarget.closest('.md-body');
          const candidates = container
            ? Array.from(container.querySelectorAll<HTMLElement>('[id]'))
            : [];
          const hit =
            candidates.find(
              (el) =>
                el.id === decodedTarget ||
                el.id === rawTarget ||
                (normalizedTarget && el.id === normalizedTarget)
            ) ??
            document.getElementById(decodedTarget) ??
            (normalizedTarget ? document.getElementById(normalizedTarget) : null);
          if (hit) {
            hit.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }}
      >
        {children}
      </a>
    );
  }
  const isExternal = /^https?:\/\/|^mailto:/i.test(rawHref);
  if (isExternal) {
    return (
      <a href={rawHref} target="_blank" rel="noopener noreferrer" className="md-link external">
        {children}
      </a>
    );
  }
  return (
    <FileLinkButton reference={rawHref} onOpen={onWorkspaceHref}>
      {children}
    </FileLinkButton>
  );
});

const MarkdownImage: React.FC<{ src?: string; alt?: string }> = React.memo(({ src, alt }) => {
  const { chatId, messageStatus, onOpenArtifact } = useContext(MarkdownRenderContext);
  return (
    <WorkspaceImage
      chatId={chatId}
      src={src ?? ''}
      alt={alt}
      messageStatus={messageStatus}
      onOpenArtifact={onOpenArtifact}
    />
  );
});

// Hoisted module-level component map so React never unmounts nested viewers (images, code, mermaid) across parent re-renders
const MARKDOWN_COMPONENTS: Components = {
  h1: MarkdownH1 as Components['h1'],
  h2: MarkdownH2 as Components['h2'],
  h3: MarkdownH3 as Components['h3'],
  h4: MarkdownH4 as Components['h4'],
  h5: MarkdownH5 as Components['h5'],
  h6: MarkdownH6 as Components['h6'],
  pre: MarkdownPre,
  code: MarkdownCode as Components['code'],
  table: CopyableTable as Components['table'],
  blockquote: CopyableBlockquote as Components['blockquote'],
  a: MarkdownLink as Components['a'],
  img: MarkdownImage as Components['img'],
};

export interface MarkdownContentProps {
  content: string;
  chatId?: string;
  messageStatus?: MessageRecord['status'];
  onOpenArtifact?: (artifact: ArtifactRecord) => void;
  onResolveError?: (message: string) => void;
}

export type FileLinkProps = Pick<MarkdownContentProps, 'chatId' | 'onOpenArtifact' | 'onResolveError'>;

function useOpenFileReference({ chatId, onOpenArtifact, onResolveError }: FileLinkProps) {
  const onResolveErrorRef = useRef(onResolveError);
  onResolveErrorRef.current = onResolveError;

  return useCallback(async (reference: string) => {
    if (!reference.trim()) {
      onResolveErrorRef.current?.('参照されたファイルパスが空のため開けませんでした。');
      return;
    }
    if (!chatId || !onOpenArtifact) return;
    try {
      const cached = peekResolvedLink(chatId, reference);
      const resolved = cached && !cached.artifact.relPath.startsWith('/')
        ? cached
        : await resolveLinkCached(chatId, reference, { forceRefresh: Boolean(cached) });
      onOpenArtifact(resolved.artifact);
    } catch {
      onResolveErrorRef.current?.(
        `参照されたファイル "${reference}" を開けませんでした（存在しないかアクセス権限がありません）。`
      );
    }
  }, [chatId, onOpenArtifact]);
}

export const FileReferenceLink: React.FC<FileLinkProps & { reference: string }> = ({ reference, ...props }) => {
  const onOpen = useOpenFileReference(props);
  return <FileLinkButton reference={reference} onOpen={onOpen}>{reference}</FileLinkButton>;
};

export const MarkdownContent: React.FC<MarkdownContentProps> = React.memo(
  ({ content, chatId, messageStatus, onOpenArtifact, onResolveError }) => {
    const handleWorkspaceHref = useOpenFileReference({ chatId, onOpenArtifact, onResolveError });

    const contextValue = useMemo<MarkdownRenderContextValue>(
      () => ({
        chatId,
        messageStatus,
        onOpenArtifact,
        onWorkspaceHref: handleWorkspaceHref,
      }),
      [chatId, messageStatus, onOpenArtifact, handleWorkspaceHref]
    );

    return (
      <div className="md-body">
        <MarkdownRenderContext.Provider value={contextValue}>
          <ReactMarkdown
            urlTransform={markdownUrlTransform}
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={MARKDOWN_COMPONENTS}
          >
            {content}
          </ReactMarkdown>
        </MarkdownRenderContext.Provider>
      </div>
    );
  }
);

