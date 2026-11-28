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
import {
  detectMermaidDiagramType,
  editMermaidStructure,
  findMermaidHeaderLine,
  flowchartStructure,
  isMermaidFlowchartDiagramType,
  MERMAID_HEADER_RE,
  MERMAID_STRUCTURE_OPS,
} from './mermaid-structure.js';

interface ParsedMermaidNode {
  id: string;
  kind: string;
  label: string;
  labelHash: string;
  line: number;
}

function parseMermaidNodes(text: string): ParsedMermaidNode[] {
  const lines = splitLines(text);
  const found: ParsedMermaidNode[] = [];
  const seen = new Set<string>();
  const nodeRe = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*(\[[^\]]+\]|\([^)]+\)|\{[^}]+\})/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('%%')) continue;
    for (const m of line.matchAll(nodeRe)) {
      const id = m[1];
      const rawShape = m[2];
      const kind = rawShape.startsWith('[') ? 'rect' : rawShape.startsWith('(') ? 'round' : 'diamond';
      const label = rawShape.slice(1, -1).replace(/^["']|["']$/g, '').trim();
      const key = `${id}|${kind}|${label}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ id, kind, label, labelHash: sha256Text(label), line: i + 1 });
      }
    }
  }
  return found;
}

export class MermaidAdapter implements FormatAdapter {
  readonly format = 'mermaid' as const;
  readonly previewKind = 'mermaid' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(ctx: AdapterCapabilityContext): OperationCapability[] {
    const webReady = ctx.runtimeProfile === 'full_runtime' && ctx.sandboxAvailable;
    const remediation =
      ctx.runtimeProfile === 'full_runtime'
        ? 'bubblewrap サンドボックスを有効化してください。'
        : 'Full Runtime（deploy/setup-doc-runtime.sh, INSTALL_DOC_RUNTIME=full）を有効化してください。';
    const diagramType = ctx.content !== undefined ? detectMermaidDiagramType(ctx.content.toString('utf8')) : null;
    const structureCapability: Pick<OperationCapability, 'availability' | 'notes'> =
      diagramType === null
        ? {
            availability: 'partial',
            notes: 'flowchart / graph 図種のみ対応します（その他の図種は replace_source / replace_range / search_replace でソース編集してください）。',
          }
        : isMermaidFlowchartDiagramType(diagramType)
          ? {
              availability: 'supported',
              notes: `図種 '${diagramType}' は flowchart / graph 構造編集に対応しています。`,
            }
          : {
              availability: 'unsupported_by_format',
              notes:
                diagramType === 'unknown'
                  ? 'flowchart / graph の図種宣言が確認できないため構造編集は非対応です（flowchart / graph のみ対応）。replace_source / replace_range / search_replace でソース編集してください。'
                  : `図種 '${diagramType}' は構造編集に非対応です（flowchart / graph のみ対応）。replace_source / replace_range / search_replace でソース編集してください。`,
            };
    return [
      ...MERMAID_STRUCTURE_OPS.map((operation): OperationCapability => ({
        operation: `mermaid.${operation}`,
        ...structureCapability,
        scope: 'mcp_and_ui',
      })),
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      {
        operation: 'edit',
        availability: 'supported',
        scope: 'mcp_and_ui',
        notes: '全図種で replace_source / replace_range / search_replace のソース編集に対応します。',
      },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
      {
        operation: 'export:svg',
        availability: webReady ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_and_ui',
        remediation: webReady ? undefined : remediation,
      },
      {
        operation: 'export:png',
        availability: webReady ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_and_ui',
        remediation: webReady ? undefined : remediation,
      },
      {
        operation: 'render_png',
        availability: webReady ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_only',
        remediation: webReady ? undefined : remediation,
      },
    ];
  }

  create(params: Record<string, unknown>, _meta: AdapterFileMeta): Buffer {
    return Buffer.from(String(params.content ?? 'flowchart TD\n  A[Start] --> B[End]\n'), 'utf8');
  }

  getStructure(buffer: Buffer, _meta: AdapterFileMeta): Record<string, unknown> {
    const text = buffer.toString('utf8');
    const lines = splitLines(text);
    const diagramType = detectMermaidDiagramType(text);
    const model = flowchartStructure(text);
    const nodes = model ? model.nodes.map(({ id, kind, label, statement }) => ({
      id, kind, label, labelHash: sha256Text(label), groupId: statement.groupId, line: text.slice(0, statement.start).split('\n').length,
    })) : parseMermaidNodes(text);
    return {
      format: 'mermaid',
      diagramType,
      lineCount: lines.length,
      nodes,
      edges: model?.edges.map(({ fromId, toId, operator, label, fingerprint }) => ({ fromId, toId, operator, label, fingerprint })) ?? [],
      groups: model?.groups ?? [],
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
        lines.splice(startLine - 1, endLine - startLine + 1, ...splitLines(String(op.content ?? '')));
        text = lines.join('\n');
      } else if (op.op === 'search_replace' && typeof op.search === 'string' && typeof op.replace === 'string') {
        if (!text.includes(op.search)) {
          throw new ArtifactError('SEARCH_NOT_FOUND', 'Mermaid search target not found.', 409);
        }
        text = text.replace(op.search, op.replace);
      } else {
        const edited = editMermaidStructure(text, op);
        if (edited !== undefined) {
          text = edited;
          continue;
        }
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `Mermaid adapter does not support op '${op.op}'.`);
      }
    }
    return {
      buffer: Buffer.from(text, 'utf8'),
      summary: `Updated Mermaid (${operations.length} op${operations.length === 1 ? '' : 's'})`,
    };
  }

  verify(buffer: Buffer, _meta: AdapterFileMeta): AdapterVerifyResult {
    const text = buffer.toString('utf8');
    const lines = splitLines(text);
    const issues: AdapterVerifyIssue[] = [];
    const checks: AdapterVerifyCheck[] = [];

    const { line: first, lineNo: headerLineNo } = findMermaidHeaderLine(text);
    const hdr = MERMAID_HEADER_RE.exec(first);
    if (!first || !hdr) {
      issues.push({
        severity: 'error',
        code: 'MERMAID_INVALID_HEADER',
        message: 'Missing recognized Mermaid diagram declaration header.',
        location: `line:${headerLineNo}`,
      });
    } else if (hdr[1] === 'graph' || hdr[1] === 'flowchart') {
      const rest = first.trim().slice(hdr[1].length).trim();
      if (rest && !/^(TB|TD|BT|RL|LR)\b/.test(rest)) {
        issues.push({
          severity: 'error',
          code: 'MERMAID_INVALID_DIRECTION',
          message: `Invalid ${hdr[1]} direction '${rest.split(/\s+/)[0]}'. Expected TB, TD, BT, RL, or LR.`,
          location: `line:${headerLineNo}`,
        });
      }
    }

    const firstIndex = headerLineNo - 1;
    const blockStack: number[] = [];
    const diagramType = hdr?.[1] ?? '';
    for (let i = firstIndex; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('%%')) continue;
      const lineNo = i + 1;

      if (/^(subgraph|loop|alt|opt|par|critical|break|rect)\b/.test(trimmed)) {
        blockStack.push(lineNo);
      } else if (trimmed === 'end') {
        if (blockStack.length === 0) {
          issues.push({
            severity: 'error',
            code: 'MERMAID_UNEXPECTED_END',
            message: "Unexpected 'end' without a matching block start.",
            location: `line:${lineNo}`,
          });
        } else {
          blockStack.pop();
        }
      }

      if (i > firstIndex) {
        // Check unclosed double quotes on a single line
        let inQuotes = false;
        const bracketStack: string[] = [];
        const closeMap: Record<string, string> = { '[': ']', '(': ')', '{': '}' };
        for (let c = 0; c < trimmed.length; c++) {
          const ch = trimmed[c];
          if (ch === '"' && trimmed[c - 1] !== '\\') {
            inQuotes = !inQuotes;
            continue;
          }
          if (inQuotes) continue;
          if (ch in closeMap) {
            bracketStack.push(closeMap[ch]);
          } else if (ch === ']' || ch === ')' || ch === '}') {
            if (bracketStack.length > 0 && bracketStack[bracketStack.length - 1] === ch) {
              bracketStack.pop();
            }
          }
        }
        if (inQuotes) {
          issues.push({
            severity: 'error',
            code: 'MERMAID_UNCLOSED_QUOTE',
            message: 'Unclosed double quote in Mermaid statement.',
            location: `line:${lineNo}`,
          });
        }
        if (
          (diagramType === 'flowchart' || diagramType === 'graph') &&
          bracketStack.length > 0 &&
          !/-->|---|-\.-|==>/.test(trimmed.slice(trimmed.lastIndexOf(bracketStack[0]) + 1))
        ) {
          issues.push({
            severity: 'error',
            code: 'MERMAID_UNBALANCED_BRACKETS',
            message: `Unclosed delimiter (expected '${bracketStack[bracketStack.length - 1]}').`,
            location: `line:${lineNo}`,
          });
        }
        if (
          (diagramType === 'flowchart' || diagramType === 'graph') &&
          (/(?:-->|---|==>|<-->|-\.->)\s*$/.test(trimmed) || /^(?:-->|---|==>|<-->|-\.->)\b/.test(trimmed))
        ) {
          issues.push({
            severity: 'error',
            code: 'MERMAID_MALFORMED_EDGE',
            message: 'Edge arrow is missing a source or target node.',
            location: `line:${lineNo}`,
          });
        }
      }
    }

    for (const openLine of blockStack) {
      issues.push({
        severity: 'error',
        code: 'MERMAID_UNBALANCED_SUBGRAPH',
        message: `Unclosed block opened at line ${openLine} (missing 'end').`,
        location: `line:${openLine}`,
      });
    }

    const ok = !issues.some((i) => i.severity === 'error');
    checks.push({
      id: 'mermaid_static_syntax',
      status: ok ? 'passed' : 'failed',
      evidence: ok
        ? `Static syntax check passed across ${lines.length} lines (${diagramType || 'unknown'}).`
        : `Static syntax check found ${issues.length} issue(s).`,
    });
    checks.push({
      id: 'mermaid_parser_syntax',
      status: 'unverified',
      evidence: 'Full Mermaid parser verification requires Full Runtime (Chromium + mermaid.parse).',
    });

    return { ok, coverage: 'partial', checks, issues };
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    if (selector.kind === 'mermaid_source_range') {
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
      });
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
