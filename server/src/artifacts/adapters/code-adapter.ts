import path from 'node:path';
import { applyPatch } from 'diff';
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
  sha256Text,
  splitLines,
  type AdapterCapabilityContext,
  type AdapterFileMeta,
  type FormatAdapter,
} from './base.js';
import { validateXmlWellFormedness } from './xml-validator.js';

const XML_EXTENSIONS = new Set([
  '.xml',
  '.xhtml',
  '.xsd',
  '.xsl',
  '.xslt',
  '.plist',
  '.rss',
  '.atom',
  '.csproj',
  '.pom',
]);

const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);

const BLOCK_SCALAR_HEADER_RE = /^[|>](?:[+-]?\d+|\d+[+-]?|[+-])?(?:\s+#.*)?$/;

function stripYamlComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote === '"') {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
        return raw.slice(0, i);
      }
    }
  }
  return raw;
}

function findYamlMappingColon(trimmed: string): number {
  let quote: '"' | "'" | null = null;
  let flowDepth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote === '"') {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") {
        if (trimmed[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '[' || ch === '{') {
        flowDepth += 1;
      } else if (ch === ']' || ch === '}') {
        flowDepth = Math.max(0, flowDepth - 1);
      } else if (ch === '#' && (i === 0 || /\s/.test(trimmed[i - 1]))) {
        break;
      } else if (ch === ':' && flowDepth === 0) {
        const next = trimmed[i + 1];
        if (next === undefined || next === ' ' || next === '\t') {
          return i;
        }
      }
    }
  }
  return -1;
}

function hasInlinePlainColonSpace(value: string): boolean {
  const noComment = stripYamlComment(value).trim();
  if (!noComment || noComment.startsWith('"') || noComment.startsWith("'")) return false;
  if (noComment.startsWith('{') || noComment.startsWith('[')) return false;
  let quote: '"' | "'" | null = null;
  let flowDepth = 0;
  for (let i = 0; i < noComment.length; i++) {
    const ch = noComment[i];
    if (quote === '"') {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") {
        if (noComment[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{' || ch === '[') {
      flowDepth += 1;
    } else if (ch === '}' || ch === ']') {
      flowDepth = Math.max(0, flowDepth - 1);
    } else if (ch === ':' && flowDepth === 0) {
      const next = noComment[i + 1];
      if (next === ' ' || next === '\t' || next === undefined) {
        return true;
      }
    }
  }
  return false;
}

function validateFlowMappingBody(body: string, lineNo: number, issues: AdapterVerifyIssue[]): void {
  const inner = body.trim();
  if (!inner) return;
  const entries: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote === '"') {
      current += ch;
      if (ch === '\\' && i + 1 < inner.length) {
        current += inner[++i];
      } else if (ch === '"') {
        quote = null;
      }
    } else if (quote === "'") {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          current += inner[++i];
        } else {
          quote = null;
        }
      }
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === '{' || ch === '[') {
        depth += 1;
        current += ch;
      } else if (ch === '}' || ch === ']') {
        depth = Math.max(0, depth - 1);
        current += ch;
      } else if (ch === ',' && depth === 0) {
        entries.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  if (current.trim()) entries.push(current.trim());
  for (const entry of entries) {
    if (!entry) continue;
    const colonIdx = findYamlMappingColon(entry);
    const jsonStyleColon =
      colonIdx === -1 && /^"(?:[^"\\]|\\.)*"\s*:/.test(entry)
        ? entry.indexOf(':', entry.indexOf('"', 1) + 1)
        : colonIdx;
    if (jsonStyleColon === -1) {
      issues.push({
        severity: 'error',
        code: 'YAML_INVALID_FLOW_MAPPING',
        message: `Malformed YAML flow mapping entry '${entry.slice(0, 40)}' (missing ':' separator).`,
        location: `line:${lineNo}`,
      });
    }
  }
}

/**
 * Pure-JS YAML 1.2 syntax validator.
 * Checks tab indentation, balanced quotes and flow collections, flow mapping entries,
 * block scalar boundaries, indentation consistency, duplicate mapping keys, and illegal nested colons.
 */
function validateYamlSyntax(text: string): AdapterVerifyIssue[] {
  const issues: AdapterVerifyIssue[] = [];
  const pushIssue = (issue: AdapterVerifyIssue) => {
    if (issues.length < 100) issues.push(issue);
  };

  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = splitLines(normalized);

  type Scope = { indent: number; kind: 'map' | 'seq'; keys?: Set<string> };
  let scopes: Scope[] = [];
  let blockScalar: { parentIndent: number; contentIndent: number | null } | null = null;
  const quoteState: { open: { ch: '"' | "'"; line: number } | null } = { open: null };
  const flowStack: Array<{ ch: '{' | '['; line: number; startOffset: number; buf: string }> = [];
  let expectingNestedValue = false;
  let lastKeyIndent = -1;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const rawLine = lines[idx];

    if (blockScalar !== null) {
      if (rawLine.trim().length === 0) {
        continue;
      }
      let leadingSpaces = 0;
      while (leadingSpaces < rawLine.length && rawLine[leadingSpaces] === ' ') leadingSpaces += 1;
      const isStillInside =
        blockScalar.contentIndent !== null
          ? leadingSpaces >= blockScalar.contentIndent
          : leadingSpaces > blockScalar.parentIndent;
      if (isStillInside) {
        if (blockScalar.contentIndent === null) {
          blockScalar.contentIndent = leadingSpaces;
        }
        continue;
      }
      blockScalar = null;
    }

    const wasInFlowOrQuote = quoteState.open !== null || flowStack.length > 0;

    let indent = 0;
    let hasTabIndent = false;
    while (indent < rawLine.length && (rawLine[indent] === ' ' || rawLine[indent] === '\t')) {
      if (rawLine[indent] === '\t') hasTabIndent = true;
      indent += 1;
    }

    const trimmed = rawLine.slice(indent).trimEnd();
    if (!quoteState.open && (trimmed.length === 0 || trimmed.startsWith('#'))) {
      continue;
    }

    if (hasTabIndent && !quoteState.open) {
      pushIssue({
        severity: 'error',
        code: 'YAML_TAB_INDENT',
        message: 'Tab character is not allowed for YAML indentation.',
        location: `line:${lineNo}`,
      });
    }

    if (!wasInFlowOrQuote && indent === 0 && (/^---(?:\s|$)/.test(trimmed) || /^\.\.\.(?:\s|$)/.test(trimmed))) {
      scopes = [];
      expectingNestedValue = false;
      lastKeyIndent = -1;
      continue;
    }

    const scanLineForQuotesAndFlow = (segment: string) => {
      for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (quoteState.open) {
          if (flowStack.length > 0) flowStack[flowStack.length - 1].buf += ch;
          if (quoteState.open.ch === '"') {
            if (ch === '\\') {
              if (i + 1 < segment.length && flowStack.length > 0) {
                flowStack[flowStack.length - 1].buf += segment[i + 1];
              }
              i += 1;
              continue;
            }
            if (ch === '"') quoteState.open = null;
          } else {
            if (ch === "'") {
              if (segment[i + 1] === "'") {
                if (flowStack.length > 0) flowStack[flowStack.length - 1].buf += "'";
                i += 1;
                continue;
              }
              quoteState.open = null;
            }
          }
          continue;
        }

        if (ch === '#' && (i === 0 || /\s/.test(segment[i - 1]))) {
          break;
        }
        if (ch === '"' || ch === "'") {
          quoteState.open = { ch, line: lineNo };
          if (flowStack.length > 0) flowStack[flowStack.length - 1].buf += ch;
          continue;
        }
        if (ch === '{' || ch === '[') {
          if (flowStack.length > 0) flowStack[flowStack.length - 1].buf += ch;
          flowStack.push({ ch, line: lineNo, startOffset: i, buf: '' });
          continue;
        }
        if (ch === '}' || ch === ']') {
          const expectedOpen = ch === '}' ? '{' : '[';
          const top = flowStack[flowStack.length - 1];
          if (!top || top.ch !== expectedOpen) {
            pushIssue({
              severity: 'error',
              code: 'YAML_UNBALANCED_FLOW',
              message: `Unexpected closing '${ch}' in YAML flow collection.`,
              location: `line:${lineNo}`,
            });
          } else {
            const popped = flowStack.pop()!;
            if (popped.ch === '{') {
              validateFlowMappingBody(popped.buf, popped.line, issues);
            }
            if (flowStack.length > 0) {
              flowStack[flowStack.length - 1].buf += popped.buf + ch;
            }
          }
          continue;
        }
        if (flowStack.length > 0) {
          flowStack[flowStack.length - 1].buf += ch;
        }
      }
    };

    if (wasInFlowOrQuote) {
      scanLineForQuotesAndFlow(rawLine);
      continue;
    }

    if (indent === 0 && trimmed.startsWith('%')) {
      continue;
    }

    const isSeqItem = trimmed === '-' || trimmed.startsWith('- ') || trimmed.startsWith('-\t');
    let workText = trimmed;
    let effectiveIndent = indent;

    while (scopes.length > 0 && scopes[scopes.length - 1].indent > indent) {
      scopes.pop();
    }

    if (scopes.length > 0 && scopes[scopes.length - 1].indent < indent) {
      if (!expectingNestedValue) {
        const topScope = scopes[scopes.length - 1];
        const isPlainContinuation =
          lastKeyIndent >= 0 &&
          indent > lastKeyIndent &&
          !isSeqItem &&
          findYamlMappingColon(workText) === -1 &&
          topScope.kind === 'map';
        if (!isPlainContinuation) {
          pushIssue({
            severity: 'error',
            code: 'YAML_BAD_INDENTATION',
            message: `Unexpected indentation level (${indent} spaces).`,
            location: `line:${lineNo}`,
          });
        }
      }
    } else if (scopes.length > 0 && scopes[scopes.length - 1].indent !== indent) {
      pushIssue({
        severity: 'error',
        code: 'YAML_BAD_INDENTATION',
        message: `Indentation (${indent} spaces) does not align with any enclosing YAML block.`,
        location: `line:${lineNo}`,
      });
    }

    if (isSeqItem) {
      const top = scopes[scopes.length - 1];
      if (!top || top.indent < indent) {
        scopes.push({ indent, kind: 'seq' });
      } else if (top.indent === indent && top.kind === 'map') {
        if (expectingNestedValue) {
          scopes.push({ indent, kind: 'seq' });
        } else {
          pushIssue({
            severity: 'error',
            code: 'YAML_SYNTAX_ERROR',
            message: 'Sequence item cannot appear at the same indentation as a mapping key without a nested context.',
            location: `line:${lineNo}`,
          });
        }
      }

      const afterDashRaw = trimmed.slice(1);
      let dashSpaces = 0;
      while (dashSpaces < afterDashRaw.length && afterDashRaw[dashSpaces] === ' ') dashSpaces += 1;
      workText = afterDashRaw.slice(dashSpaces);
      effectiveIndent = indent + 1 + dashSpaces;
      expectingNestedValue = workText.length === 0;
      lastKeyIndent = indent;

      if (workText.length === 0) {
        continue;
      }

      if (BLOCK_SCALAR_HEADER_RE.test(workText)) {
        const expMatch = /[|>](\d+)/.exec(workText);
        blockScalar = {
          parentIndent: indent,
          contentIndent: expMatch ? indent + Number(expMatch[1]) : null,
        };
        expectingNestedValue = false;
        continue;
      }
    }

    const colonIdx = findYamlMappingColon(workText);
    if (colonIdx !== -1) {
      const rawKey = workText.slice(0, colonIdx).trim();
      if (!rawKey && !workText.startsWith('?')) {
        pushIssue({
          severity: 'error',
          code: 'YAML_SYNTAX_ERROR',
          message: 'Empty mapping key before colon.',
          location: `line:${lineNo}`,
        });
      }

      let mapScope = scopes[scopes.length - 1];
      if (!mapScope || mapScope.indent < effectiveIndent || (mapScope.indent === effectiveIndent && mapScope.kind === 'seq')) {
        mapScope = { indent: effectiveIndent, kind: 'map', keys: new Set<string>() };
        scopes.push(mapScope);
      }

      if (rawKey && mapScope.keys && rawKey !== '<<') {
        const normalizedKey =
          (rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))
            ? rawKey.slice(1, -1)
            : rawKey;
        if (mapScope.keys.has(normalizedKey)) {
          pushIssue({
            severity: 'error',
            code: 'YAML_DUPLICATE_KEY',
            message: `Duplicate YAML mapping key '${normalizedKey}'.`,
            location: `line:${lineNo}`,
          });
        } else {
          mapScope.keys.add(normalizedKey);
        }
      }

      const rawValue = workText.slice(colonIdx + 1).trim();
      const valNoComment = stripYamlComment(rawValue).trim();
      lastKeyIndent = effectiveIndent;

      if (valNoComment.length === 0) {
        expectingNestedValue = true;
      } else if (BLOCK_SCALAR_HEADER_RE.test(rawValue)) {
        const expMatch = /[|>](\d+)/.exec(rawValue);
        blockScalar = {
          parentIndent: effectiveIndent,
          contentIndent: expMatch ? effectiveIndent + Number(expMatch[1]) : null,
        };
        expectingNestedValue = false;
      } else {
        expectingNestedValue = false;
        if (hasInlinePlainColonSpace(rawValue)) {
          pushIssue({
            severity: 'error',
            code: 'YAML_MAPPING_VALUE_NOT_ALLOWED',
            message: 'Nested mapping value (`: `) is not allowed inside an unquoted scalar value.',
            location: `line:${lineNo}`,
          });
        }
        const valueAfterPrefix = rawValue.replace(/^(?:(?:![^\s]*|&[^\s]*)\s+)+/, '');
        const firstValCh = valueAfterPrefix[0];
        if (firstValCh === '"' || firstValCh === "'" || firstValCh === '{' || firstValCh === '[' || firstValCh === '}' || firstValCh === ']') {
          scanLineForQuotesAndFlow(valueAfterPrefix);
        }
      }
    } else {
      if (!isSeqItem) {
        const top = scopes[scopes.length - 1];
        if (top && top.kind === 'map' && top.indent === indent && !workText.startsWith('{') && !workText.startsWith('[')) {
          pushIssue({
            severity: 'error',
            code: 'YAML_SYNTAX_ERROR',
            message: `Expected a YAML mapping key ('key: value') at indentation ${indent}, found '${workText.slice(0, 40)}'.`,
            location: `line:${lineNo}`,
          });
        }
      }
      expectingNestedValue = false;
      const itemAfterPrefix = workText.replace(/^(?:(?:![^\s]*|&[^\s]*)\s+)+/, '');
      const firstItemCh = itemAfterPrefix[0];
      if (firstItemCh === '"' || firstItemCh === "'" || firstItemCh === '{' || firstItemCh === '[' || firstItemCh === '}' || firstItemCh === ']') {
        scanLineForQuotesAndFlow(itemAfterPrefix);
      }
    }
  }

  if (quoteState.open !== null) {
    pushIssue({
      severity: 'error',
      code: 'YAML_UNCLOSED_QUOTE',
      message: `Unclosed YAML ${quoteState.open.ch === '"' ? 'double' : 'single'}-quoted string opened at line ${quoteState.open.line}.`,
      location: `line:${quoteState.open.line}`,
    });
  }

  for (let i = flowStack.length - 1; i >= 0; i--) {
    const entry = flowStack[i];
    pushIssue({
      severity: 'error',
      code: 'YAML_UNBALANCED_FLOW',
      message: `Unclosed YAML flow collection '${entry.ch}' opened at line ${entry.line}.`,
      location: `line:${entry.line}`,
    });
  }

  return issues;
}

export class CodeAdapter implements FormatAdapter {
  readonly format = 'code' as const;
  readonly previewKind = 'code' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(_ctx: AdapterCapabilityContext): OperationCapability[] {
    return [
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
    ];
  }

  create(params: Record<string, unknown>, _meta: AdapterFileMeta): Buffer {
    return Buffer.from(String(params.content ?? ''), 'utf8');
  }

  getStructure(buffer: Buffer, meta: AdapterFileMeta): Record<string, unknown> {
    const text = buffer.toString('utf8');
    const lines = splitLines(text);
    const ext = path.extname(meta.filename).toLowerCase().replace(/^\./, '') || 'txt';
    const symbols: Array<{ kind: string; name: string; line: number; signatureHash: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:export\s+)?(?:async\s+)?(function|class|interface|type|def|struct|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
        lines[i]
      );
      if (m) {
        symbols.push({
          kind: m[1],
          name: m[2],
          line: i + 1,
          signatureHash: sha256Text(lines[i].trim()),
        });
      }
    }

    return {
      format: 'code',
      language: ext,
      lineCount: lines.length,
      byteLength: buffer.length,
      symbols,
    };
  }

  readRange(buffer: Buffer, range: Record<string, unknown>, _meta: AdapterFileMeta): Record<string, unknown> {
    const lines = splitLines(buffer.toString('utf8'));
    const startLine = Math.max(1, Number(range.startLine ?? 1));
    const endLine = Math.min(lines.length, Math.max(startLine, Number(range.endLine ?? Math.min(lines.length, startLine + 199))));
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
          throw new ArtifactError('SEARCH_NOT_FOUND', 'Search target not found in file.', 409);
        }
        text = op.all ? text.split(op.search).join(op.replace) : text.replace(op.search, op.replace);
      } else if (op.op === 'apply_patch' && typeof op.patch === 'string') {
        const patched = applyPatch(text, op.patch);
        if (patched === false) {
          throw new ArtifactError('PATCH_CONFLICT', 'Unified diff patch could not be cleanly applied.', 409);
        }
        text = patched;
      } else {
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `Code adapter does not support op '${op.op}'.`);
      }
    }
    return {
      buffer: Buffer.from(text, 'utf8'),
      summary: `Updated source (${operations.length} op${operations.length === 1 ? '' : 's'})`,
    };
  }

  verify(buffer: Buffer, meta: AdapterFileMeta): AdapterVerifyResult {
    const ext = path.extname(meta.filename).toLowerCase();
    const issues: AdapterVerifyIssue[] = [];
    const checks: AdapterVerifyCheck[] = [];

    let validUtf8 = true;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      validUtf8 = false;
      issues.push({
        severity: 'error',
        code: 'INVALID_UTF8',
        message: 'Invalid UTF-8 byte sequence detected in text/code file.',
      });
    }
    const hasNullByte = buffer.includes(0);
    if (hasNullByte) {
      issues.push({ severity: 'error', code: 'BINARY_NULL_BYTE', message: 'NUL byte detected in text/code file.' });
    }
    const encodingProblems: string[] = [];
    if (!validUtf8) encodingProblems.push('invalid UTF-8 byte sequences');
    if (hasNullByte) encodingProblems.push('NUL byte(s)');
    checks.push({
      id: 'code_encoding',
      status: encodingProblems.length === 0 ? 'passed' : 'failed',
      evidence:
        encodingProblems.length === 0
          ? 'Valid UTF-8 with no NUL bytes.'
          : `Detected ${encodingProblems.join(' and ')}.`,
    });

    const text = buffer.toString('utf8');
    const lineCount = splitLines(text).length;

    if (ext === '.json') {
      let jsonError: string | null = null;
      try {
        JSON.parse(text);
      } catch (err) {
        jsonError = err instanceof Error ? err.message : 'Invalid JSON';
        issues.push({
          severity: 'error',
          code: 'JSON_SYNTAX_ERROR',
          message: jsonError,
        });
      }
      checks.push({
        id: 'json_syntax',
        status: jsonError === null ? 'passed' : 'failed',
        evidence: jsonError === null ? 'Parsed JSON cleanly.' : jsonError,
      });
    } else if (YAML_EXTENSIONS.has(ext)) {
      const yamlIssues = validateYamlSyntax(text);
      issues.push(...yamlIssues);
      const yamlErrorCount = yamlIssues.filter((i) => i.severity === 'error').length;
      checks.push({
        id: 'yaml_syntax',
        status: yamlErrorCount === 0 ? 'passed' : 'failed',
        evidence:
          yamlErrorCount === 0
            ? `Validated YAML syntax across ${lineCount} line(s) with 0 errors.`
            : `Detected ${yamlErrorCount} YAML syntax error(s).`,
      });
    } else if (XML_EXTENSIONS.has(ext)) {
      const xmlResult = validateXmlWellFormedness(text);
      issues.push(...xmlResult.issues);
      const xmlErrorCount = xmlResult.issues.filter((i) => i.severity === 'error').length;
      checks.push({
        id: 'xml_syntax',
        status: xmlResult.ok ? 'passed' : 'failed',
        evidence: xmlResult.ok
          ? `Validated well-formed XML (<${xmlResult.rootTag}>, ${xmlResult.elementCount} element(s)).`
          : `Detected ${xmlErrorCount} XML well-formedness/security error(s).`,
      });
    }

    return {
      ok: !issues.some((i) => i.severity === 'error'),
      coverage: 'complete',
      checks,
      issues,
      metrics: { extension: ext, lineCount, byteLength: buffer.length },
    };
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    if (selector.kind === 'code_line_range' || selector.kind === 'code_char_range') {
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

    if (selector.kind === 'code_symbol') {
      const symbolName = String(selector.symbolName ?? '');
      const expectedSigHash = selector.expectedSignatureHash ? String(selector.expectedSignatureHash) : '';
      const lines = splitLines(text);
      const matches: Array<{ line: number; text: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:export\s+)?(?:async\s+)?(function|class|interface|type|def|struct|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
          lines[i]
        );
        if (m && m[2] === symbolName && (!expectedSigHash || sha256Text(lines[i].trim()) === expectedSigHash)) {
          matches.push({ line: i + 1, text: lines[i] });
        }
      }
      if (matches.length === 0) return { status: 'stale', reason: 'symbol_not_found' };
      if (matches.length > 1) return { status: 'needs_review', reason: 'ambiguous_multiple_symbols' };
      return { status: 'resolved', resolvedSnippet: matches[0].text, resolvedRange: { startLine: matches[0].line, endLine: matches[0].line } };
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
