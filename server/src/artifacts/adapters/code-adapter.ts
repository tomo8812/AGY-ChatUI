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
  isSha256,
  sha256Text,
  splitLines,
  type AdapterCapabilityContext,
  type AdapterFileMeta,
  type FormatAdapter,
} from './base.js';
import { validateXmlWellFormedness } from './xml-validator.js';
import { validateYamlSyntax } from './yaml-validator.js';
import { decodeVerificationText, textVerificationReport, verificationMessage } from './text-verification.js';

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

export function codeVerificationChecks(filename: string): [string, ...string[]] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.json') return ['code_encoding', 'json_syntax'];
  if (YAML_EXTENSIONS.has(ext)) return ['code_encoding', 'yaml_syntax'];
  if (XML_EXTENSIONS.has(ext)) return ['code_encoding', 'xml_syntax'];
  return ['code_encoding'];
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
    const ids = codeVerificationChecks(meta.filename);
    const input = decodeVerificationText(buffer, ids);
    if ('report' in input) return input.report;
    const { text } = input;
    const issues: AdapterVerifyIssue[] = [];
    const checks: AdapterVerifyCheck[] = [{ id: 'code_encoding', status: 'passed', evidence: 'Valid UTF-8 with no NUL bytes.' }];

    if (ids.includes('json_syntax')) {
      try {
        JSON.parse(text);
        checks.push({ id: 'json_syntax', status: 'passed', evidence: 'Parsed JSON successfully.' });
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const message = verificationMessage(error.message);
        checks.push({ id: 'json_syntax', status: 'failed', evidence: message });
        issues.push({ severity: 'error', code: 'JSON_SYNTAX_ERROR', message });
      }
    } else if (ids.includes('yaml_syntax')) {
      const yaml = validateYamlSyntax(text);
      checks.push(...yaml.checks);
      issues.push(...yaml.issues);
    } else if (ids.includes('xml_syntax')) {
      const xml = validateXmlWellFormedness(text);
      checks.push({ id: 'xml_syntax', status: xml.status, evidence: xml.evidence });
      issues.push(...xml.issues);
    }

    let lineCount = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineCount++;
    return textVerificationReport(checks, issues, { lineCount, byteLength: buffer.length });
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    if (selector.kind === 'code_line_range' || selector.kind === 'code_char_range') {
      const charRange = selector.kind === 'code_char_range';
      const { startCol, endCol } = selector;
      if (charRange && (typeof startCol !== 'number' || typeof endCol !== 'number' ||
          !Number.isSafeInteger(startCol) || !Number.isSafeInteger(endCol) || startCol < 1 || endCol < 1 ||
          (selector.startLine === selector.endLine && endCol <= startCol))) {
        return { status: 'stale', reason: 'invalid_column_range' };
      }
      return resolveTextSnippetByContext({
        text,
        startLine: selector.startLine,
        endLine: selector.endLine,
        expectedSnippetHash: selector.expectedSnippetHash,
        contextBeforeHash: selector.contextBeforeHash,
        contextAfterHash: selector.contextAfterHash,
        occurrenceIndex: selector.occurrenceIndex,
        snippetHint: _meta.snippetHint,
        requireOccurrenceIndex: true,
        ...(charRange ? { startCol: startCol as number, endCol: endCol as number } : {}),
      });
    }

    if (selector.kind === 'code_symbol') {
      const symbolName = String(selector.symbolName ?? '');
      const { expectedSignatureHash, expectedBodyHash, symbolKind, startLine, endLine } = selector;
      if (!isSha256(expectedSignatureHash) || !isSha256(expectedBodyHash) || typeof symbolKind !== 'string' ||
          typeof startLine !== 'number' || typeof endLine !== 'number' ||
          !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
        return { status: 'needs_review', reason: 'invalid_symbol_fingerprint' };
      }
      const span = endLine - startLine + 1;
      const lines = splitLines(text);
      const matches: Array<{ line: number; text: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:export\s+)?(?:async\s+)?(function|class|interface|type|def|struct|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
          lines[i]
        );
        if (m && m[1] === symbolKind && m[2] === symbolName && i + span <= lines.length &&
            sha256Text(lines[i].trim()) === expectedSignatureHash) {
          const body = lines.slice(i, i + span).join('\n');
          if (sha256Text(body) === expectedBodyHash) matches.push({ line: i + 1, text: body });
        }
      }
      if (matches.length === 0) return { status: 'stale', reason: 'symbol_not_found' };
      if (matches.length > 1) return { status: 'needs_review', reason: 'ambiguous_multiple_symbols' };
      return { status: 'resolved', resolvedSnippet: matches[0].text, resolvedRange: { startLine: matches[0].line, endLine: matches[0].line + span - 1 } };
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
