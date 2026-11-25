import path from 'node:path';
import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
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
  sha256Buffer,
  sha256Text,
  splitLines,
  type AdapterCapabilityContext,
  type AdapterFileMeta,
  type FormatAdapter,
} from './base.js';

const HTML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const HTML_RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp']);

const HTML_OPTIONAL_SELF_CLOSING_ON_SIBLING: Record<string, Set<string>> = {
  p: new Set([
    'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer',
    'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav',
    'ol', 'p', 'pre', 'section', 'table', 'ul',
  ]),
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  tr: new Set(['tr']),
  td: new Set(['td', 'th', 'tr']),
  th: new Set(['td', 'th', 'tr']),
  thead: new Set(['tbody', 'tfoot']),
  tbody: new Set(['tbody', 'tfoot']),
  option: new Set(['option', 'optgroup']),
  optgroup: new Set(['optgroup']),
};

const HTML_OPTIONAL_END_TAGS = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'option', 'optgroup']);

const META_CSP_IGNORED_DIRECTIVES = new Set(['frame-ancestors', 'report-uri', 'sandbox']);
const KNOWN_CSP_KEYWORDS = new Set(['none', 'self', 'unsafe-inline', 'unsafe-eval', 'strict-dynamic', 'unsafe-hashes', 'report-sample']);

interface ScannedHtmlTag {
  tag: string;
  line: number;
  attrs: Record<string, string>;
  rawTextBody?: string;
}

interface HtmlScanResult {
  tags: ScannedHtmlTag[];
  syntaxIssues: AdapterVerifyIssue[];
  duplicateIds: number;
  hasDoctype: boolean;
}

function countNewlinesInRange(str: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (str.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function scanHtmlDocument(rawHtml: string): HtmlScanResult {
  const html = rawHtml.charCodeAt(0) === 0xfeff ? rawHtml.slice(1) : rawHtml;
  const lower = html.toLowerCase();
  const n = html.length;
  const syntaxIssues: AdapterVerifyIssue[] = [];
  const tags: ScannedHtmlTag[] = [];
  const seenIds = new Map<string, number>();
  let duplicateIds = 0;
  let hasDoctype = false;

  const pushIssue = (issue: AdapterVerifyIssue) => {
    if (syntaxIssues.length < 100) syntaxIssues.push(issue);
  };

  const stack: Array<{ tag: string; line: number; foreignDepth: number }> = [];
  let i = 0;
  let line = 1;
  let foreignDepth = 0; // >0 inside <svg> or <math> where self-closing /> is valid

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    line += countNewlinesInRange(html, i, lt);
    i = lt;
    const tagStartLine = line;

    // 1. HTML comment <!-- ... -->
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end === -1) {
        pushIssue({
          severity: 'error',
          code: 'HTML_UNCLOSED_COMMENT',
          message: 'Unclosed HTML comment.',
          location: `line:${tagStartLine}`,
        });
        break;
      }
      line += countNewlinesInRange(html, i, end + 3);
      i = end + 3;
      continue;
    }

    // 2. DOCTYPE / declaration <! ... > or PI <? ... >
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i + 2);
      if (end === -1) {
        pushIssue({
          severity: 'error',
          code: 'HTML_UNCLOSED_TAG',
          message: 'Unclosed HTML declaration.',
          location: `line:${tagStartLine}`,
        });
        break;
      }
      if (/^<!doctype\b/i.test(html.slice(i, end + 1))) {
        hasDoctype = true;
      }
      line += countNewlinesInRange(html, i, end + 1);
      i = end + 1;
      continue;
    }

    // 3. Closing tag </name>
    if (html.startsWith('</', i)) {
      const gt = html.indexOf('>', i + 2);
      if (gt === -1) {
        pushIssue({
          severity: 'error',
          code: 'HTML_UNCLOSED_TAG',
          message: 'Unclosed HTML closing tag.',
          location: `line:${tagStartLine}`,
        });
        break;
      }
      const rawName = html.slice(i + 2, gt).trim().toLowerCase();
      if (!/^[a-z][a-z0-9:-]*$/.test(rawName)) {
        pushIssue({
          severity: 'error',
          code: 'HTML_INVALID_TAG',
          message: `Invalid HTML closing tag '</${rawName}>'.`,
          location: `line:${tagStartLine}`,
        });
      } else if (HTML_VOID_ELEMENTS.has(rawName)) {
        pushIssue({
          severity: 'warning',
          code: 'HTML_VOID_CLOSING_TAG',
          message: `Void element <${rawName}> should not have a closing tag '</${rawName}>'.`,
          location: `line:${tagStartLine}`,
        });
      } else {
        // Pop any optional-end tags (like <p> or <li>) sitting above a matching ancestor
        let matchIdx = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].tag === rawName) {
            matchIdx = s;
            break;
          }
        }
        if (matchIdx === -1) {
          pushIssue({
            severity: 'error',
            code: 'HTML_UNEXPECTED_CLOSING_TAG',
            message: `Unexpected closing tag '</${rawName}>' with no matching opening tag.`,
            location: `line:${tagStartLine}`,
          });
        } else {
          for (let s = stack.length - 1; s > matchIdx; s--) {
            if (!HTML_OPTIONAL_END_TAGS.has(stack[s].tag)) {
              pushIssue({
                severity: 'error',
                code: 'HTML_MISMATCHED_TAG',
                message: `Mismatched closing tag '</${rawName}>' before closing '<${stack[s].tag}>' opened at line ${stack[s].line}.`,
                location: `line:${tagStartLine}`,
              });
            }
          }
          stack.length = matchIdx;
          if (rawName === 'svg' || rawName === 'math') {
            foreignDepth = Math.max(0, foreignDepth - 1);
          }
        }
      }
      line += countNewlinesInRange(html, i, gt + 1);
      i = gt + 1;
      continue;
    }

    // 4. Not a tag start (e.g., stray '<' followed by space/digit in text)
    if (i + 1 >= n || !/[a-zA-Z]/.test(html[i + 1])) {
      i += 1;
      continue;
    }

    // 5. Opening tag <name ...>
    let cursor = i + 1;
    while (cursor < n && /[a-zA-Z0-9:-]/.test(html[cursor])) cursor += 1;
    const tagName = html.slice(i + 1, cursor).toLowerCase();

    const attrs: Record<string, string> = {};
    let selfClosing = false;
    let closedTag = false;
    let attrLine = tagStartLine;

    while (cursor < n) {
      const wsStart = cursor;
      while (cursor < n && /\s/.test(html[cursor])) cursor += 1;
      attrLine += countNewlinesInRange(html, wsStart, cursor);
      if (cursor >= n) break;

      if (html[cursor] === '>') {
        cursor += 1;
        closedTag = true;
        break;
      }
      if (html[cursor] === '/' && html[cursor + 1] === '>') {
        selfClosing = true;
        cursor += 2;
        closedTag = true;
        break;
      }
      if (html[cursor] === '<') {
        // Another tag began before closing '>'
        break;
      }

      const aStart = cursor;
      while (cursor < n && !/[\s=/>"<']/.test(html[cursor])) cursor += 1;
      const attrName = html.slice(aStart, cursor).toLowerCase();
      if (!attrName) {
        cursor += 1;
        continue;
      }

      const eqWs = cursor;
      while (cursor < n && /\s/.test(html[cursor])) cursor += 1;
      attrLine += countNewlinesInRange(html, eqWs, cursor);

      let attrVal = '';
      if (html[cursor] === '=') {
        cursor += 1;
        const valWs = cursor;
        while (cursor < n && /\s/.test(html[cursor])) cursor += 1;
        attrLine += countNewlinesInRange(html, valWs, cursor);

        const q = html[cursor];
        if (q === '"' || q === "'") {
          const valStart = cursor + 1;
          const valEnd = html.indexOf(q, valStart);
          if (valEnd === -1) {
            pushIssue({
              severity: 'error',
              code: 'HTML_UNCLOSED_ATTRIBUTE_QUOTE',
              message: `Unclosed attribute value for '${attrName}' on <${tagName}>.`,
              location: `line:${attrLine}`,
            });
            cursor = n;
            break;
          }
          attrVal = html.slice(valStart, valEnd);
          attrLine += countNewlinesInRange(html, valStart, valEnd);
          cursor = valEnd + 1;
        } else {
          const valStart = cursor;
          while (cursor < n && !/[\s>]/.test(html[cursor])) cursor += 1;
          attrVal = html.slice(valStart, cursor);
        }
      }

      if (!Object.prototype.hasOwnProperty.call(attrs, attrName)) {
        attrs[attrName] = attrVal;
      }
    }

    if (!closedTag) {
      pushIssue({
        severity: 'error',
        code: 'HTML_UNCLOSED_TAG',
        message: `Unclosed opening tag '<${tagName}'.`,
        location: `line:${tagStartLine}`,
      });
      if (cursor >= n) break;
      line = attrLine;
      i = cursor;
      continue;
    }

    // Track duplicate id attributes
    if (attrs.id && attrs.id.trim()) {
      const idVal = attrs.id.trim();
      const prevLine = seenIds.get(idVal);
      if (prevLine !== undefined) {
        duplicateIds += 1;
        pushIssue({
          severity: 'warning',
          code: 'HTML_DUPLICATE_ID',
          message: `Duplicate id '${idVal}' (first defined at line ${prevLine}).`,
          location: `line:${tagStartLine}`,
        });
      } else {
        seenIds.set(idVal, tagStartLine);
      }
    }

    // Handle raw-text elements (<script>, <style>, <textarea>, <title>, <xmp>)
    if (HTML_RAW_TEXT_ELEMENTS.has(tagName) && !selfClosing) {
      const needle = `</${tagName}`;
      let searchIdx = cursor;
      let closeStart = -1;
      let closeEnd = -1;
      while (searchIdx < n) {
        const found = lower.indexOf(needle, searchIdx);
        if (found === -1) break;
        const after = lower[found + needle.length];
        if (after === '>' || after === ' ' || after === '\t' || after === '\n' || after === '\r' || after === '\f') {
          const gt = html.indexOf('>', found + needle.length);
          if (gt !== -1) {
            closeStart = found;
            closeEnd = gt + 1;
            break;
          }
        }
        searchIdx = found + needle.length;
      }
      if (closeEnd === -1) {
        pushIssue({
          severity: 'error',
          code: 'HTML_UNCLOSED_RAW_TAG',
          message: `Unclosed <${tagName}> block opened at line ${tagStartLine}.`,
          location: `line:${tagStartLine}`,
        });
        tags.push({ tag: tagName, line: tagStartLine, attrs, rawTextBody: html.slice(cursor) });
        break;
      }
      const rawTextBody = html.slice(cursor, closeStart);
      tags.push({ tag: tagName, line: tagStartLine, attrs, rawTextBody });
      line = attrLine + countNewlinesInRange(html, cursor, closeEnd);
      i = closeEnd;
      continue;
    }

    tags.push({ tag: tagName, line: tagStartLine, attrs });

    if (!HTML_VOID_ELEMENTS.has(tagName)) {
      const isForeignSelfClose = (foreignDepth > 0 || tagName === 'svg' || tagName === 'math') && selfClosing;
      if (!isForeignSelfClose) {
        // Apply HTML5 optional-close rules for siblings (e.g., <p> followed by <p> or <div>)
        while (stack.length > 0) {
          const topTag = stack[stack.length - 1].tag;
          const closers = HTML_OPTIONAL_SELF_CLOSING_ON_SIBLING[topTag];
          if (closers && closers.has(tagName)) {
            stack.pop();
          } else {
            break;
          }
        }
        if (tagName === 'svg' || tagName === 'math') {
          foreignDepth += 1;
        }
        stack.push({ tag: tagName, line: tagStartLine, foreignDepth });
      }
    }

    line = attrLine;
    i = cursor;
  }

  for (let s = stack.length - 1; s >= 0; s--) {
    if (HTML_OPTIONAL_END_TAGS.has(stack[s].tag)) continue;
    pushIssue({
      severity: 'error',
      code: stack[s].tag === 'html' ? 'HTML_UNCLOSED_ROOT' : 'HTML_UNCLOSED_ELEMENT',
      message: `Unclosed <${stack[s].tag}> element opened at line ${stack[s].line}.`,
      location: `line:${stack[s].line}`,
    });
  }

  return { tags, syntaxIssues, duplicateIds, hasDoctype };
}

function extractCssUrlsFromText(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?/gi)) {
    out.push(m[1]);
  }
  for (const m of css.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")\s]+))\s*\)/gi)) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function classifyUrlScheme(raw: string): 'anchor' | 'data_or_blob' | 'external' | 'dangerous' | 'relative' | 'empty' {
  const s = raw.trim();
  if (!s) return 'empty';
  if (s.startsWith('#')) return 'anchor';
  const lower = s.toLowerCase();
  if (lower.startsWith('data:') || lower.startsWith('blob:')) return 'data_or_blob';
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:')) return 'dangerous';
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//')) return 'external';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return 'external';
  return 'relative';
}

function validateMetaCspPolicy(content: string, line: number, issues: AdapterVerifyIssue[]): void {
  const trimmed = content.trim();
  if (!trimmed) {
    issues.push({
      severity: 'error',
      code: 'HTML_INVALID_META_CSP',
      message: '<meta http-equiv="Content-Security-Policy"> has an empty content attribute.',
      location: `line:${line}`,
    });
    return;
  }
  const directives = trimmed.split(';').map((d) => d.trim()).filter(Boolean);
  if (directives.length === 0) {
    issues.push({
      severity: 'error',
      code: 'HTML_INVALID_META_CSP',
      message: '<meta http-equiv="Content-Security-Policy"> defines no directives.',
      location: `line:${line}`,
    });
    return;
  }
  for (const dir of directives) {
    const tokens = dir.split(/\s+/).filter(Boolean);
    const name = tokens[0]?.toLowerCase() ?? '';
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      issues.push({
        severity: 'error',
        code: 'HTML_INVALID_META_CSP',
        message: `Malformed CSP directive name '${tokens[0] ?? ''}' in <meta> CSP.`,
        location: `line:${line}`,
      });
      continue;
    }
    if (META_CSP_IGNORED_DIRECTIVES.has(name)) {
      issues.push({
        severity: 'warning',
        code: 'HTML_META_CSP_IGNORED_DIRECTIVE',
        message: `CSP directive '${name}' is ignored when delivered via <meta http-equiv="Content-Security-Policy">.`,
        location: `line:${line}`,
      });
    }
    const sources = tokens.slice(1);
    for (const src of sources) {
      const lowerSrc = src.toLowerCase();
      if (KNOWN_CSP_KEYWORDS.has(lowerSrc)) {
        issues.push({
          severity: 'error',
          code: 'HTML_INVALID_META_CSP',
          message: `CSP keyword '${src}' in '${name}' must be single-quoted ('${lowerSrc}').`,
          location: `line:${line}`,
        });
      }
      if (lowerSrc === "'unsafe-eval'" || (lowerSrc === '*' && (name === 'script-src' || name === 'default-src'))) {
        issues.push({
          severity: 'warning',
          code: 'HTML_META_CSP_UNSAFE_DIRECTIVE',
          message: `Permissive CSP source ${src} in '${name}' weakens script isolation.`,
          location: `line:${line}`,
        });
      }
    }
  }
}

function findHtmlElementsById(html: string, id: string): Array<{ tag: string; raw: string; fingerprint: string }> {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)([^>]*\\bid\\s*=\\s*["']${escaped}["'][^>]*)(?:\\/>|>([\\s\\S]*?)<\\/\\1>)`, 'gi');
  const out: Array<{ tag: string; raw: string; fingerprint: string }> = [];
  for (const m of html.matchAll(re)) {
    const tag = m[1].toLowerCase();
    out.push({ tag, raw: m[0], fingerprint: sha256Text(`${tag}|${m[0].trim()}`) });
  }
  return out;
}

export class HtmlAdapter implements FormatAdapter {
  readonly format = 'html' as const;
  readonly previewKind = 'html' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(ctx: AdapterCapabilityContext): OperationCapability[] {
    return [
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
      {
        operation: 'render_png',
        availability: ctx.runtimeProfile === 'full_runtime' && ctx.sandboxAvailable ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_only',
        remediation: ctx.runtimeProfile !== 'full_runtime' ? 'Full Runtime（deploy/setup-doc-runtime.sh --profile full）を有効化してください。' : undefined,
      },
      {
        operation: 'export:png',
        availability: ctx.runtimeProfile === 'full_runtime' && ctx.sandboxAvailable ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_and_ui',
        remediation: ctx.runtimeProfile !== 'full_runtime' ? 'Full Runtime（deploy/setup-doc-runtime.sh --profile full）を有効化してください。' : undefined,
      },
    ];
  }

  create(params: Record<string, unknown>, _meta: AdapterFileMeta): Buffer {
    if (typeof params.content === 'string') {
      return Buffer.from(params.content, 'utf8');
    }
    const title = String(params.title ?? 'Document');
    const body = String(params.body ?? '');
    return Buffer.from(
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <title>${title}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`,
      'utf8'
    );
  }

  getStructure(buffer: Buffer, _meta: AdapterFileMeta): Record<string, unknown> {
    const text = buffer.toString('utf8');
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    const ids: Array<{ id: string; tag: string; fingerprint: string }> = [];
    for (const m of text.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*\bid\s*=\s*["']([^"']+)["'][^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/gi)) {
      const tag = m[1].toLowerCase();
      ids.push({ id: m[3], tag, fingerprint: sha256Text(`${tag}|${m[0].trim()}`) });
    }
    return {
      format: 'html',
      title: titleMatch ? titleMatch[1].trim() : null,
      lineCount: splitLines(text).length,
      docSha256: sha256Buffer(buffer),
      identifiedElements: ids,
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
          throw new ArtifactError('SEARCH_NOT_FOUND', 'HTML search target not found.', 409);
        }
        text = text.replace(op.search, op.replace);
      } else {
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `HTML adapter does not support op '${op.op}'.`);
      }
    }
    return {
      buffer: Buffer.from(text, 'utf8'),
      summary: `Updated HTML (${operations.length} op${operations.length === 1 ? '' : 's'})`,
    };
  }

  verify(buffer: Buffer, meta: AdapterFileMeta): AdapterVerifyResult {
    const text = buffer.toString('utf8');
    const issues: AdapterVerifyIssue[] = [];
    const checks: AdapterVerifyCheck[] = [];

    if (text.trim().length === 0) {
      issues.push({ severity: 'error', code: 'HTML_EMPTY', message: 'HTML file is empty.', location: 'line:1' });
      checks.push(
        { id: 'html_syntax', status: 'failed', evidence: 'HTML file is empty.' },
        { id: 'html_relative_refs', status: 'unverified', evidence: 'Skipped because HTML file is empty.' },
        { id: 'html_csp', status: 'unverified', evidence: 'Skipped because HTML file is empty.' }
      );
      return {
        ok: false,
        coverage: 'partial',
        checks,
        issues,
        metrics: { tagCount: 0, relativeRefCount: 0, cspIssueCount: 0 },
      };
    }

    // 1. HTML5 syntax & structural tag balance
    const scan = scanHtmlDocument(text);
    issues.push(...scan.syntaxIssues);
    const syntaxErrors = scan.syntaxIssues.filter((i) => i.severity === 'error').length;
    const syntaxWarnings = scan.syntaxIssues.filter((i) => i.severity === 'warning').length;
    checks.push({
      id: 'html_syntax',
      status: syntaxErrors === 0 ? 'passed' : 'failed',
      evidence:
        syntaxErrors === 0
          ? `Scanned ${scan.tags.length} HTML tag(s); 0 syntax errors${syntaxWarnings ? `, ${syntaxWarnings} warning(s)` : ''}.`
          : `Detected ${syntaxErrors} HTML syntax error(s) across ${scan.tags.length} tag(s).`,
    });

    // 2. Relative reference extraction & validation
    const baseRelPath = (meta.relPath || meta.filename || 'index.html').replace(/\\/g, '/');
    const baseDir = path.posix.dirname(baseRelPath);
    const depStatusByPath = new Map<string, 'present' | 'missing' | 'outside_root'>();
    const hasDepSnapshot = Array.isArray(meta.dependencies);
    if (meta.dependencies) {
      for (const dep of meta.dependencies) {
        depStatusByPath.set(dep.relPath.replace(/\\/g, '/'), dep.status);
      }
    }

    interface ExtractedRef {
      tag: string;
      attr: string;
      raw: string;
      line: number;
    }
    const extractedRefs: ExtractedRef[] = [];
    for (const t of scan.tags) {
      const a = t.attrs;
      if (t.tag === 'link' && a.href) extractedRefs.push({ tag: t.tag, attr: 'href', raw: a.href, line: t.line });
      if (t.tag === 'script' && a.src) extractedRefs.push({ tag: t.tag, attr: 'src', raw: a.src, line: t.line });
      if ((t.tag === 'img' || t.tag === 'source') && a.src) {
        extractedRefs.push({ tag: t.tag, attr: 'src', raw: a.src, line: t.line });
      }
      if ((t.tag === 'img' || t.tag === 'source') && a.srcset && !a.srcset.includes('data:')) {
        for (const candidate of a.srcset.split(',')) {
          const urlPart = candidate.trim().split(/\s+/)[0];
          if (urlPart) extractedRefs.push({ tag: t.tag, attr: 'srcset', raw: urlPart, line: t.line });
        }
      }
      if (t.tag === 'video' && a.poster) extractedRefs.push({ tag: t.tag, attr: 'poster', raw: a.poster, line: t.line });
      if ((t.tag === 'video' || t.tag === 'audio' || t.tag === 'iframe' || t.tag === 'embed') && a.src) {
        extractedRefs.push({ tag: t.tag, attr: 'src', raw: a.src, line: t.line });
      }
      if (t.tag === 'object' && a.data) extractedRefs.push({ tag: t.tag, attr: 'data', raw: a.data, line: t.line });
      if (a.style) {
        for (const u of extractCssUrlsFromText(a.style)) {
          extractedRefs.push({ tag: t.tag, attr: 'style', raw: u, line: t.line });
        }
      }
      if (t.tag === 'style' && t.rawTextBody) {
        for (const u of extractCssUrlsFromText(t.rawTextBody)) {
          extractedRefs.push({ tag: t.tag, attr: 'style', raw: u, line: t.line });
        }
      }
    }

    let relativeRefCount = 0;
    let relativeRefErrors = 0;
    let unverifiedRelativeRefs = 0;
    const reportedMissingDeps = new Set<string>();

    for (const ref of extractedRefs) {
      const scheme = classifyUrlScheme(ref.raw);
      if (scheme !== 'relative') continue;
      relativeRefCount += 1;

      const stripped = ref.raw.split('#')[0].split('?')[0].trim();
      if (!stripped) continue;

      let decoded: string;
      try {
        decoded = decodeURIComponent(stripped);
      } catch {
        relativeRefErrors += 1;
        issues.push({
          severity: 'error',
          code: 'HTML_INVALID_REF_PATH',
          message: `Malformed percent-encoding in relative reference '${ref.raw}' on <${ref.tag} ${ref.attr}>.`,
          location: `line:${ref.line}`,
        });
        continue;
      }

      if (/[\\\0]/.test(decoded)) {
        relativeRefErrors += 1;
        issues.push({
          severity: 'error',
          code: 'HTML_INVALID_REF_PATH',
          message: `Invalid backslash or NUL character in relative reference '${ref.raw}' on <${ref.tag} ${ref.attr}>.`,
          location: `line:${ref.line}`,
        });
        continue;
      }

      if (decoded.startsWith('/')) {
        relativeRefErrors += 1;
        issues.push({
          severity: 'error',
          code: 'HTML_RELATIVE_REF_OUTSIDE_ROOT',
          message: `Root-relative path '${ref.raw}' on <${ref.tag} ${ref.attr}> is outside the artifact directory and cannot resolve in the sandbox.`,
          location: `line:${ref.line}`,
        });
        continue;
      }

      const joined = path.posix.normalize(baseDir === '.' ? decoded : path.posix.join(baseDir, decoded));
      if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) {
        relativeRefErrors += 1;
        issues.push({
          severity: 'error',
          code: 'HTML_RELATIVE_REF_OUTSIDE_ROOT',
          message: `Relative reference '${ref.raw}' on <${ref.tag} ${ref.attr}> escapes the artifact workspace root.`,
          location: `line:${ref.line}`,
        });
        continue;
      }

      if (joined === path.posix.normalize(baseRelPath)) {
        continue;
      }

      if (hasDepSnapshot) {
        const depStatus = depStatusByPath.get(joined);
        if (depStatus === 'missing') {
          relativeRefErrors += 1;
          reportedMissingDeps.add(joined);
          issues.push({
            severity: 'error',
            code: 'HTML_MISSING_RELATIVE_REF',
            message: `Relative asset '${ref.raw}' (resolved '${joined}') referenced by <${ref.tag} ${ref.attr}> was not found.`,
            location: `line:${ref.line}`,
          });
        } else if (depStatus === 'outside_root') {
          relativeRefErrors += 1;
          reportedMissingDeps.add(joined);
          issues.push({
            severity: 'error',
            code: 'HTML_RELATIVE_REF_OUTSIDE_ROOT',
            message: `Relative asset '${ref.raw}' (resolved '${joined}') is outside the allowed root.`,
            location: `line:${ref.line}`,
          });
        } else if (depStatus === undefined) {
          unverifiedRelativeRefs += 1;
        }
      } else {
        unverifiedRelativeRefs += 1;
      }
    }

    // Also surface any transitive CSS missing/outside_root dependencies recorded in artifact_revision_deps
    if (meta.dependencies) {
      for (const dep of meta.dependencies) {
        const normDep = dep.relPath.replace(/\\/g, '/');
        if (reportedMissingDeps.has(normDep)) continue;
        if (dep.status === 'missing') {
          relativeRefErrors += 1;
          issues.push({
            severity: 'error',
            code: 'HTML_MISSING_RELATIVE_REF',
            message: `Transitive relative asset '${normDep}' was not found.`,
          });
        } else if (dep.status === 'outside_root') {
          relativeRefErrors += 1;
          issues.push({
            severity: 'error',
            code: 'HTML_RELATIVE_REF_OUTSIDE_ROOT',
            message: `Transitive relative asset '${normDep}' is outside the allowed root.`,
          });
        }
      }
    }

    const relRefStatus: AdapterVerifyCheck['status'] =
      relativeRefErrors > 0 ? 'failed' : unverifiedRelativeRefs > 0 ? 'unverified' : 'passed';
    checks.push({
      id: 'html_relative_refs',
      status: relRefStatus,
      evidence:
        relativeRefErrors > 0
          ? `Checked ${relativeRefCount} relative reference(s); detected ${relativeRefErrors} missing, escaping, or invalid reference(s).`
          : unverifiedRelativeRefs > 0
            ? `Validated path containment for ${relativeRefCount} relative reference(s); ${unverifiedRelativeRefs} target(s) could not be checked for existence without workspace dependency context.`
            : `Checked ${relativeRefCount} relative reference(s); all resolved cleanly within workspace.`,
    });

    // 3. Sandbox CSP compatibility + <meta http-equiv="Content-Security-Policy"> validation
    //    Matches existing HTML sandbox header in file-routes.ts:
    //    default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
    //    img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self';
    const cspIssuesStart = issues.length;
    for (const t of scan.tags) {
      const a = t.attrs;
      const loc = `line:${t.line}`;

      if (t.tag === 'meta' && a['http-equiv']?.trim().toLowerCase() === 'content-security-policy') {
        validateMetaCspPolicy(a.content ?? '', t.line, issues);
      }

      if (t.tag === 'script') {
        if (a.src && a.src.trim()) {
          issues.push({
            severity: 'warning',
            code: 'HTML_CSP_BLOCKED_SCRIPT',
            message: `External or relative <script src="${a.src}"> is blocked by sandbox CSP (script-src 'unsafe-inline').`,
            location: loc,
          });
        }
        if (t.rawTextBody) {
          const netMatch = /\b(fetch\s*\(|XMLHttpRequest\b|new\s+WebSocket\s*\(|new\s+EventSource\s*\(|navigator\.sendBeacon\s*\()/.exec(
            t.rawTextBody
          );
          if (netMatch) {
            issues.push({
              severity: 'warning',
              code: 'HTML_CSP_BLOCKED_CONNECT',
              message: `Network API '${netMatch[1].trim()}' in inline <script> is blocked by sandbox CSP (connect-src 'none').`,
              location: loc,
            });
          }
        }
      }

      if (t.tag === 'link' && a.href && a.rel?.toLowerCase().split(/\s+/).includes('stylesheet')) {
        issues.push({
          severity: 'warning',
          code: 'HTML_CSP_BLOCKED_STYLE',
          message: `External or relative stylesheet <link href="${a.href}"> is blocked by sandbox CSP (style-src 'unsafe-inline').`,
          location: loc,
        });
      }

      if (t.tag === 'img' && a.src) {
        const scheme = classifyUrlScheme(a.src);
        if (scheme === 'external' || scheme === 'dangerous') {
          issues.push({
            severity: 'warning',
            code: 'HTML_CSP_BLOCKED_IMAGE',
            message: `<img src="${a.src}"> is blocked by sandbox CSP (img-src data: blob:).`,
            location: loc,
          });
        }
      }

      if (t.tag === 'video' && a.poster) {
        const scheme = classifyUrlScheme(a.poster);
        if (scheme === 'external' || scheme === 'dangerous') {
          issues.push({
            severity: 'warning',
            code: 'HTML_CSP_BLOCKED_IMAGE',
            message: `<video poster="${a.poster}"> is blocked by sandbox CSP (img-src data: blob:).`,
            location: loc,
          });
        }
      }

      if (t.tag === 'form' && a.action && a.action.trim() && !a.action.trim().startsWith('#')) {
        issues.push({
          severity: 'warning',
          code: 'HTML_CSP_BLOCKED_FORM_ACTION',
          message: `<form action="${a.action}"> submission is blocked by sandbox CSP (form-action 'none').`,
          location: loc,
        });
      }

      if ((t.tag === 'iframe' || t.tag === 'embed') && a.src && a.src.trim()) {
        issues.push({
          severity: 'warning',
          code: 'HTML_CSP_BLOCKED_EMBED',
          message: `<${t.tag} src="${a.src}"> is blocked by sandbox CSP (default-src 'none').`,
          location: loc,
        });
      }

      if (t.tag === 'object' && a.data && a.data.trim()) {
        issues.push({
          severity: 'warning',
          code: 'HTML_CSP_BLOCKED_EMBED',
          message: `<object data="${a.data}"> is blocked by sandbox CSP (default-src 'none').`,
          location: loc,
        });
      }

      if (t.tag === 'style' && t.rawTextBody) {
        for (const u of extractCssUrlsFromText(t.rawTextBody)) {
          const scheme = classifyUrlScheme(u);
          if (scheme === 'external' || scheme === 'dangerous') {
            issues.push({
              severity: 'warning',
              code: 'HTML_CSP_BLOCKED_EXTERNAL_URL',
              message: `External CSS resource '${u}' in <style> is blocked by sandbox CSP.`,
              location: loc,
            });
          }
        }
      }
    }

    const cspIssues = issues.slice(cspIssuesStart);
    const cspErrors = cspIssues.filter((i) => i.severity === 'error').length;
    const cspWarnings = cspIssues.filter((i) => i.severity === 'warning').length;
    checks.push({
      id: 'html_csp',
      status: cspErrors === 0 && cspWarnings === 0 ? 'passed' : 'failed',
      evidence:
        cspErrors === 0 && cspWarnings === 0
          ? 'Compatible with HTML sandbox CSP; no invalid <meta> CSP directives detected.'
          : `Detected ${cspErrors} CSP error(s) and ${cspWarnings} sandbox-CSP compatibility warning(s).`,
    });

    return {
      ok: !issues.some((i) => i.severity === 'error'),
      coverage: checks.some((c) => c.status === 'unverified') ? 'partial' : 'complete',
      checks,
      issues,
      metrics: {
        tagCount: scan.tags.length,
        hasDoctype: scan.hasDoctype,
        duplicateIds: scan.duplicateIds,
        relativeRefCount,
        cspIssueCount: cspIssues.length,
      },
    };
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    if (selector.kind === 'html_dom_element') {
      const cssSelector = String(selector.cssSelector ?? '').trim();
      const expectedTag = selector.expectedTag ? String(selector.expectedTag).toLowerCase() : null;
      const expectedFp = selector.expectedElementFingerprint ? String(selector.expectedElementFingerprint) : null;
      if (!cssSelector || !expectedFp) {
        return { status: 'needs_review', reason: 'missing_dom_fingerprint' };
      }
      const idMatch = /^#([a-zA-Z0-9_-]+)$/.exec(cssSelector);
      if (idMatch) {
        const found = findHtmlElementsById(text, idMatch[1]);
        if (found.length === 0) return { status: 'stale', reason: 'element_not_found' };
        if (found.length > 1) return { status: 'needs_review', reason: 'ambiguous_multiple_elements' };
        const el = found[0];
        if ((expectedTag && el.tag !== expectedTag) || el.fingerprint !== expectedFp) {
          return { status: 'needs_review', reason: 'element_replaced_or_modified' };
        }
        return { status: 'resolved', resolvedSnippet: el.raw };
      }
      return { status: 'needs_review', reason: 'complex_css_selector_requires_review' };
    }

    if (selector.kind === 'html_source_range' || selector.kind === 'html_text_range') {
      return resolveTextSnippetByContext({
        text,
        startLine: Number(selector.startLine ?? 1),
        endLine: Number(selector.endLine ?? 1),
        expectedSnippetHash: selector.expectedSnippetHash ? String(selector.expectedSnippetHash) : undefined,
        contextBeforeHash: selector.contextBeforeHash ? String(selector.contextBeforeHash) : undefined,
        contextAfterHash: selector.contextAfterHash ? String(selector.contextAfterHash) : undefined,
        occurrenceIndex: selector.occurrenceIndex !== undefined ? Number(selector.occurrenceIndex) : undefined,
      });
    }

    if (selector.kind === 'html_viewport_region') {
      if (selector.expectedDocSha256 && sha256Buffer(buffer) !== String(selector.expectedDocSha256)) {
        return { status: 'needs_review', reason: 'document_changed' };
      }
      return { status: 'resolved', resolvedCoords: { rectNorm: selector.rectNorm } };
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
