import { ArtifactError } from '../errors.js';
import type { AdapterOperation } from '../types.js';
import { sha256Text } from './base.js';

export const MERMAID_STRUCTURE_OPS = [
  'add_node', 'set_node', 'remove_node', 'move_node', 'add_edge', 'set_edge', 'remove_edge',
  'add_group', 'set_group', 'remove_group', 'move_group',
] as const;

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_-]*$/u;
const EDGE_PATTERN = /^(?:<?--+>|<?-\.+->|<?==+>|---+|~~~+|--[ox]|[ox]--[ox]?|==+)(?:[ \t]*\|("[^"]*"|[^|]*)\|)?/;
const NODE_START = /^[\p{L}_][\p{L}\p{N}_-]*/u;
const RESERVED = /^(?:end|subgraph|direction|style|classDef|class|click|linkStyle)$/;
const shapes = { rect: ['[', ']'], round: ['(', ')'], diamond: ['{', '}'], circle: ['((', '))'], stadium: ['([', '])'] };

interface Statement { start: number; end: number; text: string; groupId: string | null }
interface Occurrence { id: string; start: number; end: number; label: string; kind: string; defined: boolean; statement: Statement }

function statements(source: string): Statement[] {
  const found: Statement[] = [];
  let start = 0;
  let quote = false;
  let inComment = false;
  let depth = 0;
  for (let i = 0; i <= source.length; i++) {
    const c = source[i];
    if (!inComment && !quote && c === '%' && source[i + 1] === '%' && depth === 0) inComment = true;
    if (!inComment && c === '"' && source[i - 1] !== '\\') quote = !quote;
    if (!inComment && !quote) {
      if ('[({'.includes(c)) depth++;
      else if (']})'.includes(c)) depth = Math.max(0, depth - 1);
    }
    if (i !== source.length && (c !== '\n' || (!inComment && (quote || depth > 0))) && (c !== ';' || inComment || quote || depth > 0)) continue;
    const raw = source.slice(start, i);
    const value = raw.trim();
    if (value) found.push({ start: start + raw.length - raw.trimStart().length, end: start + raw.trimEnd().length, text: value, groupId: null });
    start = i + 1;
    inComment = false;
  }
  return found;
}

function readNode(statement: Statement, offset: number): Occurrence | undefined {
  const raw = statement.text.slice(offset);
  let id = NODE_START.exec(raw)?.[0];
  if (!id) return;
  // A compact A-->B joins the operator's hyphens to the ID token.
  const withoutEdge = id.replace(/-{3,}[^]*$|-+$/, '');
  if (withoutEdge !== id && EDGE_PATTERN.test(raw.slice(withoutEdge.length))) id = withoutEdge;
  if (RESERVED.test(id)) return;
  const rest = raw.slice(id.length).trimStart();
  const prefix = raw.length - rest.length;
  const first = rest[0];
  let end = id.length;
  let label = id;
  let kind = 'rect';
  if (first === '[' || first === '(' || first === '{') {
    let depth = 0;
    let quote = false;
    let finished = false;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === '"' && rest[i - 1] !== '\\') quote = !quote;
      if (quote) continue;
      if ('[({'.includes(c)) depth++;
      else if (']})'.includes(c) && --depth === 0) {
        const rawLabel = rest.slice(1, i);
        label = rawLabel.replace(/^[\[({]+|[\])}]+$/g, '').replace(/^"|"$/g, '');
        kind = rest.startsWith('((') ? 'circle' : rest.startsWith('([') ? 'stadium' : first === '[' ? 'rect' : first === '(' ? 'round' : 'diamond';
        end = prefix + i + 1;
        finished = true;
        break;
      }
    }
    if (!finished) return;
  }
  return { id, start: statement.start + offset, end: statement.start + offset + end, label, kind, defined: end > id.length, statement };
}

export function flowchartStructure(source: string) {
  const statementsInSource = statements(source);
  const header = statementsInSource.find((statement) => /^(?:flowchart|graph)\b/.test(statement.text));
  if (!header) return null;
  const groups: Array<{ id: string; title: string; start: number; end: number; bodyEnd: number; groupId: string | null; fingerprint: string }> = [];
  const context: typeof groups = [];
  const occurrences: Occurrence[] = [];
  const edges: Array<{ fromId: string; toId: string; operator: string; label: string; start: number; end: number; statement: Statement; members: Occurrence[]; fingerprint: string }> = [];
  for (const statement of statementsInSource.filter((item) => item.start > header.start)) {
    statement.groupId = context.at(-1)?.id ?? null;
    const group = /^subgraph\s+([\p{L}_][\p{L}\p{N}_-]*)(?:\s*\[(.*)\])?$/u.exec(statement.text);
    if (group) {
      const entry = { id: group[1], title: (group[2] ?? group[1]).replace(/^"|"$/g, ''), start: statement.start, end: 0,
        bodyEnd: 0, groupId: statement.groupId, fingerprint: '' };
      groups.push(entry);
      context.push(entry);
      continue;
    }
    if (statement.text === 'end') {
      const entry = context.pop();
      if (entry) {
        entry.end = statement.end;
        entry.bodyEnd = statement.start;
        entry.fingerprint = sha256Text(source.slice(entry.start, entry.end));
      }
      continue;
    }
    const first = readNode(statement, 0);
    if (!first) continue;
    const members = [first];
    const chain: typeof edges = [];
    let position = first.end - statement.start;
    while (position < statement.text.length) {
      position += statement.text.slice(position).match(/^\s*/)?.[0].length ?? 0;
      const arrow = EDGE_PATTERN.exec(statement.text.slice(position));
      if (!arrow) break;
      const start = statement.start + position;
      position += arrow[0].length;
      position += statement.text.slice(position).match(/^\s*/)?.[0].length ?? 0;
      const next = readNode(statement, position);
      if (!next) break;
      chain.push({ fromId: members.at(-1)!.id, toId: next.id, operator: arrow[0].split('|')[0].trim(), label: (arrow[1] ?? '').replace(/^"|"$/g, ''),
        start, end: next.start, statement, members, fingerprint: sha256Text(source.slice(members.at(-1)!.start, next.end)) });
      members.push(next);
      position = next.end - statement.start;
    }
    if (statement.text.slice(position).trim() && !/^:::[\w-]+\s*$/.test(statement.text.slice(position).trim())) continue;
    occurrences.push(...members);
    edges.push(...chain);
  }
  const nodes = new Map<string, Occurrence>();
  for (const item of occurrences) if (!nodes.has(item.id) || item.defined) nodes.set(item.id, item);
  return { nodes: [...nodes.values()], occurrences, edges, groups: groups.filter(({ end }) => end > 0) };
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || RESERVED.test(value)) {
    throw new ArtifactError('INVALID_MERMAID_ID', 'Provide a valid Mermaid identifier.', 400);
  }
  return value;
}

const labelText = (value: unknown) => String(value ?? '').replace(/"/g, '#quot;').replace(/[\r\n]/g, ' ');
const conflict = () => new ArtifactError('MERMAID_STRUCTURE_CONFLICT', 'Select one current Mermaid node, edge or group.', 409);

export function editMermaidStructure(source: string, op: AdapterOperation): string | undefined {
  const action = op.op.replace(/^mermaid\./, '');
  if (!MERMAID_STRUCTURE_OPS.some((name) => name === action)) return;
  const model = flowchartStructure(source);
  if (!model) throw new ArtifactError('MERMAID_STRUCTURE_FORMAT', 'Use flowchart or graph syntax for this operation.', 422);
  const replace = (start: number, end: number, value: string) => source.slice(0, start) + value + source.slice(end);
  const uniqueGroup = (id: unknown) => {
    const matches = model.groups.filter((group) => group.id === id);
    if (matches.length !== 1) throw conflict();
    return matches[0];
  };
  const target = op.parentId === undefined ? undefined : uniqueGroup(op.parentId);
  const insertion = (value: string) => {
    const offset = target?.bodyEnd ?? source.length;
    return replace(offset, offset, '\n  ' + value + '\n');
  };

  if (action.endsWith('_group')) {
    const id = identifier(op.groupId);
    if (action === 'add_group') {
      if (model.groups.some((group) => group.id === id) || model.nodes.some((node) => node.id === id)) throw conflict();
      return insertion(`subgraph ${id}["${labelText(op.title ?? id)}"]\n  end`);
    }
    const group = uniqueGroup(id);
    if (op.expectedFingerprint !== undefined && op.expectedFingerprint !== group.fingerprint) throw conflict();
    const headerEnd = statements(source).find((item) => item.start === group.start)!.end;
    if (action === 'set_group') return replace(group.start, headerEnd, `subgraph ${id}["${labelText(op.title)}"]`);
    if (action === 'remove_group') return replace(group.start, group.end, source.slice(headerEnd, group.bodyEnd));
    if (target && target.start >= group.start && target.start < group.end) throw conflict();
    const inserted = insertion(source.slice(group.start, group.end));
    const shift = target && target.bodyEnd <= group.start ? inserted.length - source.length : 0;
    return inserted.slice(0, group.start + shift) + inserted.slice(group.end + shift);
  }

  if (action.endsWith('_edge')) {
    const from = identifier(op.fromId);
    const to = identifier(op.toId);
    const arrow = String(op.operator ?? '-->');
    if (arrow.includes('|') || EDGE_PATTERN.exec(arrow)?.[0] !== arrow) throw new ArtifactError('INVALID_MERMAID_EDGE', 'Invalid Mermaid edge operator.', 400);
    const link = (type: string) => ` ${type}${op.label === undefined ? '' : `|"${labelText(op.label)}"|`} `;
    if (action === 'add_edge') {
      if (![from, to].every((id) => model.nodes.some((node) => node.id === id) || model.groups.some((group) => group.id === id))) throw conflict();
      return insertion(from + link(arrow) + to);
    }
    const edges = model.edges.filter((edge) => edge.fromId === from && edge.toId === to);
    const edge = op.edgeIndex === undefined && edges.length === 1 ? edges[0] : edges[Number(op.edgeIndex)];
    if (!edge || (op.expectedFingerprint !== undefined && edge.fingerprint !== op.expectedFingerprint)) throw conflict();
    if (action === 'set_edge') {
      const type = op.operator === undefined ? edge.operator : arrow;
      const label = op.label ?? edge.label;
      return replace(edge.start, edge.end, type + (label ? `|"${labelText(label)}"| ` : ' '));
    }
    const newLeft = source.slice(edge.statement.start, edge.start).trimEnd();
    const newRight = source.slice(edge.end, edge.statement.end).trimStart();
    return replace(edge.statement.start, edge.statement.end, newLeft + '\n  ' + newRight);
  }

  const id = identifier(op.nodeId);
  const node = model.nodes.find((item) => item.id === id);
  const kind = String(op.kind ?? node?.kind ?? 'rect');
  if (!Object.hasOwn(shapes, kind)) throw new ArtifactError('INVALID_MERMAID_SHAPE', 'Invalid Mermaid node shape.', 400);
  const [open, close] = shapes[kind as keyof typeof shapes];
  const label = `${id}${open}"${labelText(op.label ?? node?.label ?? id)}"${close}`;
  if (action === 'add_node') {
    if (node || model.groups.some((group) => group.id === id)) throw conflict();
    return insertion(label);
  }
  if (!node || (op.expectedLabelHash !== undefined && op.expectedLabelHash !== sha256Text(node.label))) throw conflict();
  if (action === 'set_node') return replace(node.start, node.end, label);
  if (action === 'move_node') {
    if (model.edges.some((edge) => edge.statement === node.statement)) {
      const changed = replace(node.start, node.end, id);
      const offset = (target?.bodyEnd ?? source.length) + (node.end <= (target?.bodyEnd ?? source.length) ? id.length - (node.end - node.start) : 0);
      return changed.slice(0, offset) + '\n  ' + label + '\n' + changed.slice(offset);
    }
    const inserted = insertion(source.slice(node.statement.start, node.statement.end));
    const shift = target && target.bodyEnd <= node.statement.start ? inserted.length - source.length : 0;
    return inserted.slice(0, node.statement.start + shift) + inserted.slice(node.statement.end + shift);
  }
  const affected = [...new Set(model.occurrences.filter((item) => item.id === id).map((item) => item.statement))];
  let revised = source;
  for (const statement of affected.sort((a, b) => b.start - a.start)) {
    const members = model.occurrences.filter((item) => item.statement === statement);
    const retained = members.filter((item) => item.id !== id);
    const fragments: string[] = [];
    for (const member of retained) {
      const previous = members[members.indexOf(member) - 1];
      const prefix = previous && previous.id !== id ? source.slice(previous.end, member.start) : '\n  ';
      fragments.push(prefix + source.slice(member.start, member.end));
    }
    revised = revised.slice(0, statement.start) + fragments.join('').trimStart() + revised.slice(statement.end);
  }
  return revised;
}
