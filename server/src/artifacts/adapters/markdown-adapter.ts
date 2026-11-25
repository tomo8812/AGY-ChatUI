import path from 'node:path';
import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterExportResult,
  AdapterOperation,
  AdapterVerifyCheck,
  AdapterVerifyIssue,
  AdapterVerifyResult,
  OperationCapability,
  TargetResolutionResult,
  TargetSelector,
} from '../types.js';
import {
  resolveTextSnippetByContext,
  sha256Text,
  splitLines,
  type AdapterCapabilityContext,
  type AdapterFileMeta,
  type FormatAdapter,
} from './base.js';
import { textVerificationReport } from './text-verification.js';

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function sanitizeHref(raw: string): string {
  const trimmed = unescapeBasicHtmlEntities(raw.trim()).trim();
  if (!trimmed) return '#';
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return escapeHtml(trimmed);
  }
  return '#';
}

function renderInlineMarkdown(raw: string): string {
  const codeSlots: string[] = [];
  const urlSlots: string[] = [];
  let text = raw.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = codeSlots.length;
    codeSlots.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  // Keep destinations out of the text escaping and emphasis passes.
  text = text.replace(/(!?\[[^\]]*\]\()([^)\s]+)(?=(?:\s+"[^"&<>]*")?\))/g, (_match, prefix: string, url: string) => {
    const index = urlSlots.length;
    urlSlots.push(sanitizeHref(url));
    return prefix + '\u0000URL' + index + '\u0000';
  });
  text = escapeHtml(text);

  // Images: ![alt](src)
  text = text.replace(/!\[([^\]]*)\]\((\u0000URL\d+\u0000)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_m, alt: string, src: string, title?: string) => {
    const titleAttr = title ? ` title="${title}"` : '';
    return `<img src="${src}" alt="${alt}"${titleAttr} />`;
  });

  // Links: [label](href)
  text = text.replace(/\[([^\]]+)\]\((\u0000URL\d+\u0000)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_m, label: string, href: string, title?: string) => {
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${href}"${titleAttr}>${label}</a>`;
  });

  // Bold + italic, bold, italic, strikethrough
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return text.replace(/\u0000(CODE|URL)(\d+)\u0000/g, (_m, kind: string, index: string) =>
    (kind === 'CODE' ? codeSlots[Number(index)] : urlSlots[Number(index)]) ?? ''
  );
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function parseTableAlignments(line: string): Array<'left' | 'center' | 'right' | null> | null {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns: Array<'left' | 'center' | 'right' | null> = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':')) aligns.push('center');
    else if (cell.endsWith(':')) aligns.push('right');
    else if (cell.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

export function renderMarkdownToHtmlDocument(markdown: string, title: string): string {
  const lines = splitLines(markdown);
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceOpen = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (fenceOpen) {
      const fenceMarker = fenceOpen[1][0];
      const fenceLen = fenceOpen[1].length;
      const lang = fenceOpen[2].trim().split(/\s+/)[0] ?? '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const closeLine = lines[i].trim();
        if (closeLine.startsWith(fenceMarker.repeat(fenceLen)) && /^([`~]+)\s*$/.test(closeLine)) {
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      blocks.push(`<pre><code${cls}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // ATX Heading
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const slug = slugifyHeading(heading[2]);
      blocks.push(`<h${level} id="${escapeHtml(slug)}">${renderInlineMarkdown(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(?:---+|\*\*\*+|___+)\s*$/.test(trimmed)) {
      blocks.push('<hr />');
      i += 1;
      continue;
    }

    // GFM Table
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = parseTableAlignments(lines[i + 1]);
      if (aligns) {
        const headers = splitTableRow(line);
        i += 2;
        const bodyRows: string[][] = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          bodyRows.push(splitTableRow(lines[i]));
          i += 1;
        }
        const thead = `<thead><tr>${headers
          .map((h, idx) => {
            const align = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '';
            return `<th${align}>${renderInlineMarkdown(h)}</th>`;
          })
          .join('')}</tr></thead>`;
        const tbody = `<tbody>${bodyRows
          .map(
            (r) =>
              `<tr>${headers
                .map((_, idx) => {
                  const align = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '';
                  return `<td${align}>${renderInlineMarkdown(r[idx] ?? '')}</td>`;
                })
                .join('')}</tr>`
          )
          .join('')}</tbody>`;
        blocks.push(`<table>${thead}${tbody}</table>`);
        continue;
      }
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push(`<blockquote><p>${quoteLines.map(renderInlineMarkdown).join('<br />')}</p></blockquote>`);
      continue;
    }

    // Unordered / Task list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^[-*+]\s+/, '');
        const task = /^\[([ xX])\]\s+(.*)$/.exec(itemText);
        if (task) {
          const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
          items.push(
            `<li class="task-list-item"><input type="checkbox" disabled${checked} /> ${renderInlineMarkdown(task[2])}</li>`
          );
        } else {
          items.push(`<li>${renderInlineMarkdown(itemText)}</li>`);
        }
        i += 1;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^\d+\.\s+/, '');
        items.push(`<li>${renderInlineMarkdown(itemText)}</li>`);
        i += 1;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Paragraph (collect contiguous lines until blank or block starter)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(`{3,}|~{3,})/.test(lines[i].trim()) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^(?:---+|\*\*\*+|___+)\s*$/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !/^[-*+]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push(`<p>${paraLines.map(renderInlineMarkdown).join('\n')}</p>`);
  }

  return [
    '<!DOCTYPE html>',
    '<html lang="ja">',
    '<head>',
    '  <meta charset="UTF-8" />',
    `  <title>${escapeHtml(title)}</title>`,
    '  <style>',
    '    body { font-family: -apple-system, BlinkMacSystemFont, "Noto Sans CJK JP", "Segoe UI", sans-serif; line-height: 1.65; max-width: 820px; margin: 32px auto; padding: 0 24px; color: #1f2937; }',
    '    h1, h2, h3, h4, h5, h6 { margin-top: 1.4em; margin-bottom: 0.5em; line-height: 1.3; }',
    '    pre { background: #f3f4f6; padding: 12px 16px; border-radius: 6px; overflow-x: auto; }',
    '    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f3f4f6; padding: 0.15em 0.35em; border-radius: 4px; }',
    '    pre code { background: transparent; padding: 0; }',
    '    table { border-collapse: collapse; width: 100%; margin: 1em 0; }',
    '    th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }',
    '    th { background: #f9fafb; font-weight: 600; }',
    '    blockquote { border-left: 4px solid #cbd5e1; margin: 1em 0; padding: 0.25em 1em; color: #475569; }',
    '    img { max-width: 100%; height: auto; }',
    '  </style>',
    '</head>',
    '<body>',
    ...blocks,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export class MarkdownAdapter implements FormatAdapter {
  readonly format = 'markdown' as const;
  readonly previewKind = 'markdown' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(ctx: AdapterCapabilityContext): OperationCapability[] {
    const docWorkerReady = ctx.runtimeProfile !== 'base_chatui' && ctx.sandboxAvailable;
    const webWorkerReady = ctx.runtimeProfile === 'full_runtime' && ctx.sandboxAvailable;
    const docRemediation =
      ctx.runtimeProfile === 'base_chatui'
        ? 'deploy/setup-doc-runtime.sh を実行してください。'
        : 'bubblewrap サンドボックスを有効化してください。';
    return [
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'export:html', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'export:txt', availability: 'supported', scope: 'mcp_and_ui' },
      {
        operation: 'export:pdf',
        availability: docWorkerReady ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_and_ui',
        remediation: docWorkerReady ? undefined : docRemediation,
      },
      {
        operation: 'export:docx',
        availability: docWorkerReady ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_and_ui',
        remediation: docWorkerReady ? undefined : docRemediation,
      },
      {
        operation: 'render_png',
        availability: webWorkerReady ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_only',
        remediation: webWorkerReady ? undefined : docRemediation,
      },
    ];
  }

  create(params: Record<string, unknown>, _meta: AdapterFileMeta): Buffer {
    if (typeof params.content === 'string') return Buffer.from(params.content, 'utf8');
    const title = String(params.title ?? 'Untitled');
    const body = String(params.body ?? '');
    return Buffer.from(`# ${title}\n\n${body}\n`, 'utf8');
  }

  getStructure(buffer: Buffer, _meta: AdapterFileMeta): Record<string, unknown> {
    const lines = splitLines(buffer.toString('utf8'));
    const headings: Array<{ level: number; text: string; slug: string; line: number; hash: string }> = [];
    const codeFences: Array<{ fenceIndex: number; lang: string; startLine: number; endLine: number; hash: string }> = [];

    let inFence = false;
    let fenceStart = 0;
    let fenceLang = '';
    let fenceLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fenceMatch = /^```(.*)$/.exec(line.trim());
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fenceStart = i + 1;
          fenceLang = fenceMatch[1].trim();
          fenceLines = [];
        } else {
          codeFences.push({
            fenceIndex: codeFences.length,
            lang: fenceLang,
            startLine: fenceStart,
            endLine: i + 1,
            hash: sha256Text(fenceLines.join('\n')),
          });
          inFence = false;
        }
        continue;
      }
      if (inFence) {
        fenceLines.push(line);
        continue;
      }
      const h = /^(#{1,6})\s+(.+)$/.exec(line);
      if (h) {
        headings.push({
          level: h[1].length,
          text: h[2].trim(),
          slug: slugifyHeading(h[2]),
          line: i + 1,
          hash: sha256Text(line.trim()),
        });
      }
    }

    return {
      format: 'markdown',
      lineCount: lines.length,
      headings,
      codeFences,
    };
  }

  readRange(buffer: Buffer, range: Record<string, unknown>, _meta: AdapterFileMeta): Record<string, unknown> {
    const lines = splitLines(buffer.toString('utf8'));
    const startLine = Math.max(1, Number(range.startLine ?? 1));
    const endLine = Math.min(lines.length, Math.max(startLine, Number(range.endLine ?? lines.length)));
    return {
      startLine,
      endLine,
      totalLines: lines.length,
      text: lines.slice(startLine - 1, endLine).join('\n'),
    };
  }

  applyOperations(buffer: Buffer, operations: AdapterOperation[], _meta: AdapterFileMeta): AdapterEditResult {
    let text = buffer.toString('utf8');
    for (const op of operations) {
      if (op.op === 'replace_source' && typeof op.content === 'string') {
        text = op.content;
      } else if (op.op === 'replace_range') {
        const lines = splitLines(text);
        const startLine = Math.max(1, Number(op.startLine ?? 1));
        const endLine = Math.min(lines.length, Math.max(startLine, Number(op.endLine ?? startLine)));
        const replacement = splitLines(String(op.content ?? ''));
        lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
        text = lines.join('\n');
      } else if (op.op === 'search_replace' && typeof op.search === 'string' && typeof op.replace === 'string') {
        if (!text.includes(op.search)) {
          throw new ArtifactError('SEARCH_NOT_FOUND', 'Markdown search target not found.', 409);
        }
        text = text.replace(op.search, op.replace);
      } else if (op.op === 'replace_section' && typeof op.headingSlug === 'string' && typeof op.content === 'string') {
        const lines = splitLines(text);
        let startIdx = -1;
        let level = 0;
        for (let i = 0; i < lines.length; i++) {
          const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
          if (m && slugifyHeading(m[2]) === op.headingSlug) {
            startIdx = i;
            level = m[1].length;
            break;
          }
        }
        if (startIdx < 0) {
          throw new ArtifactError('SECTION_NOT_FOUND', `Heading '${op.headingSlug}' not found.`, 404);
        }
        let endIdx = lines.length;
        for (let i = startIdx + 1; i < lines.length; i++) {
          const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
          if (m && m[1].length <= level) {
            endIdx = i;
            break;
          }
        }
        lines.splice(startIdx + 1, endIdx - startIdx - 1, ...splitLines(op.content));
        text = lines.join('\n');
      } else {
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `Markdown adapter does not support op '${op.op}'.`);
      }
    }
    return {
      buffer: Buffer.from(text, 'utf8'),
      summary: `Updated Markdown (${operations.length} op${operations.length === 1 ? '' : 's'})`,
    };
  }

  verify(buffer: Buffer, _meta: AdapterFileMeta): AdapterVerifyResult {
    const lines = splitLines(buffer.toString('utf8'));
    const issues: AdapterVerifyIssue[] = [];
    const checks: AdapterVerifyCheck[] = [];

    let fenceDepth = 0;
    let lastFenceLine = 0;
    const headingSlugs = new Set<string>();
    const duplicateSlugs = new Set<string>();
    let prevHeadingLevel = 0;
    let headingIssues = 0;
    const links: Array<{ line: number; target: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^(`{3,}|~{3,})/.test(trimmed)) {
        fenceDepth = fenceDepth === 0 ? 1 : 0;
        if (fenceDepth === 1) lastFenceLine = i + 1;
        continue;
      }
      if (fenceDepth !== 0) continue;

      const h = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
      if (h) {
        const level = h[1].length;
        const slug = slugifyHeading(h[2]);
        if (prevHeadingLevel > 0 && level > prevHeadingLevel + 1) {
          headingIssues += 1;
          issues.push({
            severity: 'warning',
            code: 'MD_HEADING_LEVEL_SKIP',
            message: `Heading jumps from H${prevHeadingLevel} to H${level}.`,
            location: `line:${i + 1}`,
          });
        }
        if (headingSlugs.has(slug)) {
          duplicateSlugs.add(slug);
          headingIssues += 1;
          issues.push({
            severity: 'warning',
            code: 'MD_DUPLICATE_HEADING_SLUG',
            message: `Duplicate heading slug '#${slug}'.`,
            location: `line:${i + 1}`,
          });
        }
        headingSlugs.add(slug);
        prevHeadingLevel = level;
      }

      for (const m of lines[i].matchAll(/!?\[[^\]]*\]\(([^)]*)\)/g)) {
        links.push({ line: i + 1, target: m[1].trim() });
      }
    }

    if (fenceDepth !== 0) {
      issues.push({
        severity: 'error',
        code: 'MD_UNCLOSED_FENCE',
        message: 'Unclosed fenced code block.',
        location: `line:${lastFenceLine}`,
      });
    }
    checks.push({
      id: 'markdown_fences',
      status: fenceDepth === 0 ? 'passed' : 'failed',
      evidence: fenceDepth === 0 ? 'All fenced code blocks are closed.' : `Unclosed fence opened at line ${lastFenceLine}.`,
    });
    checks.push({
      id: 'markdown_headings',
      status: headingIssues === 0 ? 'passed' : 'failed',
      evidence: `Checked ${headingSlugs.size + duplicateSlugs.size} headings; ${headingIssues} hierarchy/duplicate issues.`,
    });

    let brokenAnchors = 0;
    for (const link of links) {
      const target = link.target.split(/\s+/)[0] ?? '';
      if (!target) {
        brokenAnchors += 1;
        issues.push({
          severity: 'warning',
          code: 'MD_EMPTY_LINK_TARGET',
          message: 'Markdown link has an empty target.',
          location: `line:${link.line}`,
        });
      } else if (target.startsWith('#')) {
        const rawAnchor = target.slice(1);
        let decodedAnchor = rawAnchor;
        try {
          decodedAnchor = decodeURIComponent(rawAnchor);
        } catch {
          decodedAnchor = rawAnchor;
        }
        const anchor = slugifyHeading(decodedAnchor);
        if (anchor && !headingSlugs.has(anchor)) {
          brokenAnchors += 1;
          issues.push({
            severity: 'warning',
            code: 'MD_BROKEN_ANCHOR_LINK',
            message: `Internal anchor '${target}' does not match any heading.`,
            location: `line:${link.line}`,
          });
        }
      }
    }
    checks.push({
      id: 'markdown_links',
      status: brokenAnchors === 0 ? 'passed' : 'failed',
      evidence: `Checked ${links.length} Markdown links; ${brokenAnchors} empty or broken internal anchors.`,
    });

    return textVerificationReport(checks, issues, {
      lineCount: lines.length,
      headingCount: headingSlugs.size,
      linkCount: links.length,
    });
  }

  exportAs(buffer: Buffer, targetFormat: string, meta: AdapterFileMeta): AdapterExportResult {
    const text = buffer.toString('utf8');
    const stem = path.basename(meta.filename, path.extname(meta.filename));
    const fmt = targetFormat.toLowerCase();
    if (fmt === 'txt') {
      return { buffer: Buffer.from(text, 'utf8'), filename: `${stem}.txt`, mimeType: 'text/plain' };
    }
    if (fmt === 'html') {
      return {
        buffer: Buffer.from(renderMarkdownToHtmlDocument(text, stem || 'Document'), 'utf8'),
        filename: `${stem}.html`,
        mimeType: 'text/html',
      };
    }
    throw unsupportedOperationError(`export:${fmt}`, 'unsupported_by_format', `Markdown export to '${fmt}' requires the document worker or is unsupported.`);
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    const lines = splitLines(text);

    if (selector.kind === 'md_heading') {
      const slug = String(selector.headingSlug ?? '');
      const expectedHash = selector.expectedHeadingHash ? String(selector.expectedHeadingHash) : '';
      const matches: Array<{ line: number; text: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
        if (m && slugifyHeading(m[2]) === slug && (!expectedHash || sha256Text(lines[i].trim()) === expectedHash)) {
          matches.push({ line: i + 1, text: lines[i] });
        }
      }
      if (matches.length === 0) return { status: 'stale', reason: 'heading_not_found' };
      if (matches.length > 1) return { status: 'needs_review', reason: 'ambiguous_multiple_headings' };
      return { status: 'resolved', resolvedSnippet: matches[0].text, resolvedRange: { startLine: matches[0].line, endLine: matches[0].line } };
    }

    if (selector.kind === 'md_text_range' || selector.kind === 'md_block' || selector.kind === 'md_code_block') {
      const expectedHash =
        selector.expectedSnippetHash ?? selector.expectedBlockHash ?? selector.expectedCodeHash;
      return resolveTextSnippetByContext({
        text,
        startLine: Number(selector.startLine ?? 1),
        endLine: Number(selector.endLine ?? 1),
        expectedSnippetHash: expectedHash ? String(expectedHash) : undefined,
        contextBeforeHash: selector.contextBeforeHash ? String(selector.contextBeforeHash) : undefined,
        contextAfterHash: selector.contextAfterHash ? String(selector.contextAfterHash) : undefined,
        occurrenceIndex: selector.occurrenceIndex !== undefined ? Number(selector.occurrenceIndex) : undefined,
      });
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
