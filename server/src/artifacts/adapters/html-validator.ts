import path from 'node:path';
import { parse as parseCss, walk as walkCss } from 'css-tree';
import { defaultTreeAdapter, html, parse, type DefaultTreeAdapterMap } from 'parse5';
import { HTML_SANDBOX_CSP } from '../../files/sandbox-bridge.js';
import type { AdapterVerifyCheck, AdapterVerifyIssue, AdapterVerifyResult } from '../types.js';
import type { AdapterFileMeta } from './base.js';
import {
  decodeVerificationText, MAX_VERIFY_DEPTH, MAX_VERIFY_DIAGNOSTICS, MAX_VERIFY_NODES, skippedTextVerification,
  textVerificationReport, VerificationLimit, verificationMessage,
} from './text-verification.js';

export const HTML_VERIFICATION_CHECKS: [string, ...string[]] = [
  'html_encoding', 'html_syntax', 'html_relative_refs', 'html_csp',
];

// parse5 permits recovery. Check source elements with mandatory end tags as well
// as the tokenizer/tree-builder diagnostics it exposes. This is not a content-model validator.
const OPTIONAL_OR_VOID_END_TAGS = new Set([
  'area', 'base', 'br', 'col', 'colgroup', 'dd', 'dt', 'embed', 'head', 'hr', 'html', 'body',
  'img', 'input', 'li', 'link', 'meta', 'optgroup', 'option', 'p', 'param', 'rp', 'rt',
  'source', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'track', 'wbr',
]);
const IGNORED_META_DIRECTIVES = new Set(['frame-ancestors', 'report-uri', 'sandbox']);
const SANDBOX_DIRECTIVES = new Map(HTML_SANDBOX_CSP.split(';').filter((part) => part.trim()).map((part) => {
  const [directive, ...sources] = part.trim().split(/ +/);
  return [directive, sources];
}));
const HTML_URL_WHITESPACE = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;

type HtmlElement = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
interface Resource {
  url: string;
  directive: string;
  source: string;
  line: number;
}

function browserUrl(value: string): string {
  return value.replace(HTML_URL_WHITESPACE, '').replace(/[\t\r\n]/g, '');
}

const IMAGE_PROPERTIES = /^(?:-webkit-)?(?:background(?:-image)?|border-image(?:-source)?|list-style(?:-image)?|mask(?:-image|-border|-border-source)?|clip-path|filter|cursor|content|shape-outside|offset-path)$/;
const MAX_CSS_VERIFY_LENGTH = 32_768;

function inspectCss(
  css: string,
  inline: boolean,
  load: (url: string, directive: string) => void,
  unverified: () => void
) {
  if (css.length > MAX_CSS_VERIFY_LENGTH) {
    unverified();
    return;
  }
  try {
    const tree = parseCss(css, { context: inline ? 'declarationList' : 'stylesheet', onParseError: unverified });
    walkCss(tree, function (node) {
      if (node.type === 'Raw' || (node.type === 'Function' && /^(?:image|(?:-webkit-)?image-set|src)$/i.test(node.name))) {
        unverified();
      }
      const atRule = this.atrule?.name.toLowerCase();
      if (node.type !== 'Url' && !(node.type === 'String' && atRule === 'import' && !this.declaration)) return;
      if (node.type === 'Url' && atRule === 'namespace' && !this.declaration) return;
      const url = browserUrl(node.value);
      if (!url || url.startsWith('#')) return;
      const property = this.declaration?.property.toLowerCase();
      if (atRule === 'import' && !property) load(url, 'style-src');
      else if (atRule === 'font-face' && property === 'src') load(url, 'font-src');
      else if (property && IMAGE_PROPERTIES.test(property)) load(url, 'img-src');
      else unverified();
    });
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof RangeError)) throw error;
    unverified();
  }
}

export function verifyHtml(buffer: Buffer, meta: AdapterFileMeta): AdapterVerifyResult {
  const input = decodeVerificationText(buffer, HTML_VERIFICATION_CHECKS);
  if ('report' in input) return input.report;
  const issues: AdapterVerifyIssue[] = [];
  const checks: AdapterVerifyCheck[] = [{ id: 'html_encoding', status: 'passed', evidence: 'Valid UTF-8 with no NUL bytes.' }];
  function issue(severity: AdapterVerifyIssue['severity'], code: string, message: string, line?: number) {
    if (issues.length < MAX_VERIFY_DIAGNOSTICS) {
      issues.push({ severity, code, message: verificationMessage(message), ...(line ? { location: `line:${line}` } : {}) });
    }
  }

  let syntaxErrors = 0;
  let parsedNodes = 0;
  let openElements = 0;
  let document: DefaultTreeAdapterMap['document'];
  try {
    document = parse(input.text, {
      sourceCodeLocationInfo: true,
      treeAdapter: {
        ...defaultTreeAdapter,
        createElement(...args) {
          if (++parsedNodes > MAX_VERIFY_NODES) throw new VerificationLimit(`HTML exceeds ${MAX_VERIFY_NODES} elements and comments.`);
          return defaultTreeAdapter.createElement(...args);
        },
        createCommentNode(data) {
          if (++parsedNodes > MAX_VERIFY_NODES) throw new VerificationLimit(`HTML exceeds ${MAX_VERIFY_NODES} elements and comments.`);
          return defaultTreeAdapter.createCommentNode(data);
        },
        onItemPush() {
          if (++openElements > MAX_VERIFY_DEPTH) throw new VerificationLimit(`HTML nesting exceeds ${MAX_VERIFY_DEPTH} open elements.`);
        },
        onItemPop() { openElements--; },
      },
      onParseError(error) {
        // The existing sandbox can serve snippets as documents with implied roots.
        if (error.code === 'missing-doctype') return;
        syntaxErrors++;
        issue('error', 'HTML_SYNTAX_ERROR', error.code, error.startLine);
      },
    });
  } catch (error) {
    if (!(error instanceof VerificationLimit)) throw error;
    const skipped = skippedTextVerification(HTML_VERIFICATION_CHECKS.slice(2), error.message);
    checks.push({
      id: 'html_syntax',
      status: syntaxErrors ? 'failed' : 'unverified',
      evidence: `${error.message} Detected ${syntaxErrors} parse error(s) before stopping.`,
    }, ...skipped.checks!);
    return textVerificationReport(checks, issues);
  }

  const nodes: Array<{ node: HtmlElement; inert: boolean }> = [];
  const pending: Array<{ parent: ParentNode; inert: boolean }> = [{ parent: document, inert: false }];
  while (pending.length) {
    const { parent, inert } = pending.pop()!;
    if (defaultTreeAdapter.isElementNode(parent)) nodes.push({ node: parent, inert });
    // Template content is parsed for syntax but does not load resources while inert.
    const template = 'content' in parent;
    const children = template ? parent.content.childNodes : parent.childNodes;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (defaultTreeAdapter.isElementNode(child)) pending.push({ parent: child, inert: inert || template });
    }
  }

  const seenIds = new Set<string>();
  const seenStartOffsets = new Set<number>();
  let sourceTags = 0;
  for (const { node, inert } of nodes) {
    const loc = node.sourceCodeLocation;
    if (!loc?.startTag || seenStartOffsets.has(loc.startTag.startOffset)) continue;
    seenStartOffsets.add(loc.startTag.startOffset);
    sourceTags++;
    if (!loc.endTag && node.namespaceURI === html.NS.HTML && !OPTIONAL_OR_VOID_END_TAGS.has(node.tagName)) {
      syntaxErrors++;
      issue('error', 'HTML_MISSING_END_TAG', `Missing end tag for <${node.tagName}>.`, loc.startLine);
    }
    const id = node.attrs.find((attr) => attr.name === 'id')?.value;
    if (!inert && id) {
      if (seenIds.has(id)) issue('warning', 'HTML_DUPLICATE_ID', `Duplicate id "${id}".`, loc.startLine);
      seenIds.add(id);
    }
  }
  checks.push({
    id: 'html_syntax',
    status: syntaxErrors ? 'failed' : 'passed',
    evidence: `parse5 HTML5 diagnostics and mandatory HTML end tags: ${syntaxErrors} error(s) across ${sourceTags} source elements. Document fragments and implied roots are accepted. HTML content models are outside this check.`,
  });
  if (syntaxErrors) {
    for (const id of HTML_VERIFICATION_CHECKS.slice(2)) {
      checks.push({ id, status: 'unverified', evidence: 'Skipped because HTML syntax verification failed.' });
    }
    return textVerificationReport(checks, issues, { tagCount: sourceTags });
  }

  const resources: Resource[] = [];
  const cspUnknown = new Set<string>();
  const refUnknown = new Set<string>();
  let cspBlocks = 0;
  let hasBase = false;
  function unknown(reason: string) {
    cspUnknown.add(reason);
    refUnknown.add(reason);
  }
  function blocked(code: string, message: string, line: number) {
    cspBlocks++;
    issue('warning', code, message, line);
  }
  for (const { node, inert } of nodes) {
    if (inert) continue;
    const line = node.sourceCodeLocation?.startLine ?? 1;
    const tag = node.tagName;
    const attrs = new Map(node.attrs.map(({ name, prefix, value }) => [prefix ? `${prefix}:${name}` : name, value]));
    const attr = (name: string) => attrs.get(name) ?? '';
    const load = (name: string, directive: string) => {
      const url = browserUrl(attr(name));
      if (url) resources.push({ url, directive, line, source: `<${tag} ${name}>` });
    };
    const inspectStyle = (css: string, inline: boolean) => inspectCss(css, inline, (url, directive) => {
      resources.push({ url, directive, line, source: inline ? `<${tag} style>` : '<style>' });
    }, () => unknown('CSS constructs outside static resource inspection'));
    if (attrs.has('style')) inspectStyle(attr('style'), true);
    if ([...attrs.keys()].some((name) => name.startsWith('on'))) unknown('JavaScript event handlers');
    if (node.namespaceURI !== html.NS.HTML) {
      if (attrs.has('href') || attrs.has('xlink:href') || tag === 'style' || tag === 'script' || tag === 'foreignObject') {
        unknown('embedded SVG or MathML resources and active content');
      }
      continue;
    }
    switch (tag) {
      case 'base':
        hasBase ||= attrs.has('href');
        break;
      case 'meta': {
        const httpEquiv = attr('http-equiv').trim().toLowerCase();
        if (httpEquiv === 'refresh') cspUnknown.add('meta refresh navigation');
        if (httpEquiv !== 'content-security-policy' || !attr('content').trim()) break;
        if (node.parentNode?.nodeName !== 'head') {
          issue('warning', 'HTML_META_CSP_OUTSIDE_HEAD', 'Browsers ignore meta CSP outside <head>.', line);
          break;
        }
        for (const entry of attr('content').split(';')) {
          const name = entry.trim().split(/\s+/, 1)[0].toLowerCase();
          if (IGNORED_META_DIRECTIVES.has(name)) {
            issue('warning', 'HTML_META_CSP_IGNORED_DIRECTIVE', `Browsers ignore "${name}" in a meta CSP.`, line);
          } else if (name) {
            cspUnknown.add('additional restrictions and document order from meta CSP');
          }
        }
        break;
      }
      case 'script': {
        const type = attr('type').trim().toLowerCase().split(';', 1)[0].trim();
        if (!type || type === 'module' || type === 'importmap' || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(type)) {
          load('src', 'script-src');
          if (!attr('src') && node.childNodes.length) unknown('JavaScript execution');
        } else if (!/^(?:application\/(?:json|ld\+json)|text\/plain)$/.test(type)) {
          unknown('unclassified script type');
        }
        break;
      }
      case 'link': {
        const rel = attr('rel').toLowerCase().split(/\s+/);
        if (rel.includes('stylesheet')) load('href', 'style-src');
        else if (rel.includes('icon')) load('href', 'img-src');
        else if (attr('href')) unknown('other link relations');
        if (attrs.has('imagesrcset')) unknown('responsive image selection');
        break;
      }
      case 'style':
        for (const child of node.childNodes) {
          if (defaultTreeAdapter.isTextNode(child)) inspectStyle(child.value, false);
        }
        break;
      case 'img':
        load('src', 'img-src');
        if (attrs.has('srcset')) unknown('responsive image selection');
        break;
      case 'input':
        if (attr('type').toLowerCase() === 'image') load('src', 'img-src');
        if (attrs.has('formaction')) blocked('HTML_CSP_BLOCKED_FORM_ACTION', 'Form submission is blocked by the sandbox.', line);
        break;
      case 'form':
        blocked('HTML_CSP_BLOCKED_FORM_ACTION', 'Form submission is blocked by form-action and the iframe sandbox.', line);
        break;
      case 'video':
        load('poster', 'img-src');
        // fall through: both audio and video can have a media source
      case 'audio':
      case 'track':
        load('src', 'media-src');
        break;
      case 'source':
        if (node.parentNode?.nodeName === 'picture') unknown('responsive image selection');
        else load('src', 'media-src');
        break;
      case 'iframe':
        if (attrs.has('srcdoc') || /^(?:about:|javascript:)/i.test(browserUrl(attr('src')))) {
          unknown('inline iframe documents');
        } else {
          load('src', 'frame-src');
        }
        break;
      case 'object':
        load('data', 'object-src');
        break;
      case 'embed':
        load('src', 'object-src');
        break;
      default:
        if (/^javascript:/i.test(browserUrl(attr('href')))) unknown('JavaScript navigation');
        if (attrs.has('background')) load('background', 'img-src');
        if (attrs.has('ping')) unknown('link auditing requests');
        break;
    }
  }

  const basePath = path.posix.normalize(meta.relPath);
  const dependencies = new Map(meta.dependencies?.map((dep) => [dep.relPath, dep.status]));
  let refs = 0;
  let refErrors = 0;
  const reported = new Set<string>();
  const cspCodes: Record<string, string> = {
    'img-src': 'HTML_CSP_BLOCKED_IMAGE', 'style-src': 'HTML_CSP_BLOCKED_STYLE', 'script-src': 'HTML_CSP_BLOCKED_SCRIPT',
    'font-src': 'HTML_CSP_BLOCKED_FONT',
    'media-src': 'HTML_CSP_BLOCKED_MEDIA', 'frame-src': 'HTML_CSP_BLOCKED_EMBED', 'object-src': 'HTML_CSP_BLOCKED_EMBED',
  };
  for (const { url, directive, source, line } of resources) {
    const scheme = /^[a-z][a-z\d+.-]*:/i.exec(url)?.[0].toLowerCase();
    const sources = SANDBOX_DIRECTIVES.get(directive) ?? SANDBOX_DIRECTIVES.get('default-src') ?? [];
    if (!scheme || !sources.includes(scheme)) {
      const applied = SANDBOX_DIRECTIVES.has(directive) ? directive : 'default-src';
      blocked(cspCodes[directive], `A resource in ${source} would be blocked if requested by the viewer (${applied}).`, line);
    }
    if (scheme || /^[/\\]{2}/.test(url) || url.startsWith('#')) continue;
    const rawPath = url.split(/[?#]/, 1)[0];
    if (!rawPath) continue;
    refs++;
    if (hasBase) {
      refUnknown.add('relative references with a document base URL');
      continue;
    }
    let resolved: string;
    try {
      const decoded = decodeURIComponent(rawPath);
      if (/[\\\0]/.test(decoded)) throw new URIError();
      resolved = path.posix.isAbsolute(decoded) ? decoded : path.posix.normalize(path.posix.join(path.posix.dirname(basePath), decoded));
    } catch {
      refErrors++;
      issue('error', 'HTML_INVALID_REF_PATH', `Invalid relative path in ${source}.`, line);
      continue;
    }
    if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved) || dependencies.get(resolved) === 'outside_root') {
      refErrors++;
      reported.add(resolved);
      issue('error', 'HTML_RELATIVE_REF_OUTSIDE_ROOT', `Relative reference "${url}" in ${source} is outside the artifact workspace.`, line);
    } else if (dependencies.get(resolved) === 'missing') {
      refErrors++;
      reported.add(resolved);
      issue('error', 'HTML_MISSING_RELATIVE_REF', `Relative reference "${url}" in ${source} is missing from this revision.`, line);
    } else if (resolved !== basePath && dependencies.get(resolved) !== 'present') {
      refUnknown.add('references not represented in this revision’s dependency manifest');
    }
  }
  // The revision manifest also holds transitive dependencies of active stylesheets.
  // Its lexical discovery can include inert text, so unmatched entries cannot prove failure.
  if (meta.dependencyManifestTruncated) refUnknown.add('dependency manifest exceeds the inspection budget');
  if ([...dependencies].some(([relPath, status]) => status !== 'present' && !reported.has(relPath))) {
    refUnknown.add('unresolved manifest entries not confirmed by the parsed HTML');
  }

  checks.push({
    id: 'html_relative_refs',
    status: refErrors ? 'failed' : refUnknown.size ? 'unverified' : 'passed',
    evidence: `Inspected ${refs} static resource path(s) against the revision manifest; ${refErrors} missing, escaping or invalid. ${refUnknown.size ? 'Unverified: ' + [...refUnknown].join(', ') + '.' : ''}`.trimEnd(),
  }, {
    id: 'html_csp',
    status: cspBlocks ? 'failed' : cspUnknown.size ? 'unverified' : 'passed',
    evidence: `Compared static requests with the served HTML sandbox CSP; ${cspBlocks} blocked constructs. ${cspUnknown.size ? 'Unverified: ' + [...cspUnknown].join(', ') + '.' : ''}`.trimEnd(),
  });
  if (cspBlocks && cspUnknown.size) checks.push({ id: 'html_csp_remaining', status: 'unverified', evidence: [...cspUnknown].join(', ') });
  if (refErrors && refUnknown.size) checks.push({ id: 'html_relative_refs_remaining', status: 'unverified', evidence: [...refUnknown].join(', ') });
  return textVerificationReport(checks, issues, { tagCount: sourceTags, relativeRefCount: refs, cspBlockCount: cspBlocks });
}
