import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterOperation,
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

const MERMAID_HEADER_RE =
  /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|gitGraph|journey|mindmap|timeline|quadrantChart|sankey-beta|xychart-beta|block-beta)\b/;

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
    return [
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
      {
        operation: 'render_png',
        availability: ctx.runtimeProfile === 'full_runtime' ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_only',
      },
    ];
  }

  create(params: Record<string, unknown>, _meta: AdapterFileMeta): Buffer {
    return Buffer.from(String(params.content ?? 'flowchart TD\n  A[Start] --> B[End]\n'), 'utf8');
  }

  getStructure(buffer: Buffer, _meta: AdapterFileMeta): Record<string, unknown> {
    const text = buffer.toString('utf8');
    const lines = splitLines(text);
    const firstNonComment = lines.find((l) => l.trim() && !l.trim().startsWith('%%')) ?? '';
    const hdr = MERMAID_HEADER_RE.exec(firstNonComment);
    const nodes = parseMermaidNodes(text);
    return {
      format: 'mermaid',
      diagramType: hdr ? hdr[1] : 'unknown',
      lineCount: lines.length,
      nodes,
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
    const first = lines.find((l) => l.trim() && !l.trim().startsWith('%%'));
    if (!first || !MERMAID_HEADER_RE.test(first)) {
      issues.push({
        severity: 'error',
        code: 'MERMAID_INVALID_HEADER',
        message: 'Missing recognized Mermaid diagram declaration header.',
        location: 'line:1',
      });
    }
    let subgraphBalance = 0;
    for (const l of lines) {
      const trimmed = l.trim();
      if (/^subgraph\b/.test(trimmed)) subgraphBalance += 1;
      if (trimmed === 'end') subgraphBalance -= 1;
    }
    if (subgraphBalance !== 0) {
      issues.push({
        severity: 'error',
        code: 'MERMAID_UNBALANCED_SUBGRAPH',
        message: 'Unbalanced subgraph / end blocks.',
      });
    }
    return { ok: !issues.some((i) => i.severity === 'error'), issues };
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    const text = buffer.toString('utf8');
    if (selector.kind === 'mermaid_node') {
      const nodeId = String(selector.nodeId ?? '');
      const expectedKind = selector.expectedNodeKind ? String(selector.expectedNodeKind) : null;
      const expectedLabelHash = selector.expectedLabelHash ? String(selector.expectedLabelHash) : null;
      const matches = parseMermaidNodes(text).filter((n) => n.id === nodeId);
      if (matches.length === 0) return { status: 'stale', reason: 'node_not_found' };
      const exact = matches.filter(
        (n) => (!expectedKind || n.kind === expectedKind) && (!expectedLabelHash || n.labelHash === expectedLabelHash)
      );
      if (exact.length === 1) {
        return {
          status: 'resolved',
          resolvedSnippet: `${exact[0].id}[${exact[0].label}]`,
          resolvedRange: { startLine: exact[0].line, endLine: exact[0].line },
        };
      }
      return { status: 'needs_review', reason: 'node_replaced_or_ambiguous' };
    }

    if (selector.kind === 'mermaid_source_range') {
      return resolveTextSnippetByContext({
        text,
        startLine: Number(selector.startLine ?? 1),
        endLine: Number(selector.endLine ?? 1),
        expectedSnippetHash: selector.expectedSnippetHash ? String(selector.expectedSnippetHash) : undefined,
        contextBeforeHash: selector.contextBeforeHash ? String(selector.contextBeforeHash) : undefined,
        contextAfterHash: selector.contextAfterHash ? String(selector.contextAfterHash) : undefined,
      });
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
