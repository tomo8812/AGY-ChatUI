import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { ArtifactError } from '../errors.js';
import type { AdapterOperation } from '../types.js';
import { sha256Text } from './base.js';

export const MARKDOWN_STRUCTURE_OPS = [
  'replace_section', 'insert_block', 'replace_block', 'remove_block', 'move_block', 'set_heading', 'set_code_block', 'set_table_cell',
] as const;

export function markdownStructure(source: string, slugify: (text: string) => string) {
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return tree.children.flatMap((node, index) => {
    const pos = node.position;
    if (pos?.start.offset === undefined || pos.end.offset === undefined) return [];
    const start = pos.start.offset;
    const end = pos.end.offset;
    const raw = source.slice(start, end);
    const plainText = (part: { value?: string; children?: unknown[] }): string =>
      part.value ?? part.children?.map((child) => plainText(child as typeof part)).join('') ?? '';
    const heading = node.type === 'heading' ? plainText(node) : null;
    return [{
      index, type: node.type, start, end, startLine: pos.start.line, endLine: pos.end.line, hash: sha256Text(raw), node,
      slug: heading === null ? null : slugify(heading),
    }];
  });
}

export function editMarkdownStructure(source: string, op: AdapterOperation, slugify: (text: string) => string): string | undefined {
  const action = op.op.replace(/^markdown\./, '');
  if (!MARKDOWN_STRUCTURE_OPS.some((name) => name === action)) return;
  const blocks = markdownStructure(source, slugify);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const separator = eol + eol;
  const replace = (start: number, end: number, value: string) => source.slice(0, start) + value + source.slice(end);
  const content = () => {
    if (typeof op.content !== 'string') throw new ArtifactError('INVALID_MARKDOWN_CONTENT', 'Provide Markdown content.', 400);
    return op.content;
  };
  if (action === 'insert_block' && op.blockIndex === undefined) {
    return source + (source && !source.endsWith(separator) ? separator : '') + content() + eol;
  }
  const matching = typeof op.headingSlug === 'string' ? blocks.filter((block) => block.slug === op.headingSlug)
    : blocks.filter((block) => block.index === op.blockIndex);
  if (matching.length !== 1 || (op.expectedHash !== undefined && matching[0].hash !== op.expectedHash)) {
    throw new ArtifactError('MARKDOWN_BLOCK_CONFLICT', 'Select a unique Markdown block from the current structure.', 409);
  }
  const block = matching[0];
  const { node, start, end } = block;
  switch (action) {
    case 'insert_block': return replace(start, start, content() + separator);
    case 'replace_block': return replace(start, end, content());
    case 'remove_block': return replace(start, end, '');
    case 'move_block': {
      const before = blocks.find(({ index }) => index === op.beforeBlockIndex);
      if (before === block || (op.beforeBlockIndex !== undefined && !before)) {
        throw new ArtifactError('INVALID_MARKDOWN_MOVE', 'Choose a different destination block.', 422);
      }
      const removed = replace(start, end, '');
      const raw = source.slice(start, end);
      if (!before) return removed + separator + raw + eol;
      const offset = before.start < start ? before.start : before.start - (end - start);
      return removed.slice(0, offset) + raw + separator + removed.slice(offset);
    }
    case 'replace_section': {
      if (node.type !== 'heading') break;
      const next = blocks.find((candidate) => candidate.start > start && candidate.node.type === 'heading' && candidate.node.depth <= node.depth);
      return replace(end, next?.start ?? source.length, separator + content() + (next ? separator : eol));
    }
    case 'set_heading': {
      if (node.type !== 'heading' || typeof op.text !== 'string' || !op.text.trim() || /[\r\n]/.test(op.text)) break;
      const level = op.level ?? node.depth;
      if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) break;
      return replace(start, end, '#'.repeat(level) + ' ' + op.text);
    }
    case 'set_code_block': {
      if (node.type !== 'code' || (op.language !== undefined && (typeof op.language !== 'string' || !/^[\w.+-]*$/.test(op.language)))) break;
      const value = content();
      const length = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length + 1), 3);
      const fence = '`'.repeat(length);
      return replace(start, end, fence + (op.language ?? node.lang ?? '') + eol + value + eol + fence);
    }
    case 'set_table_cell': {
      if (node.type !== 'table' || typeof op.row !== 'number' || typeof op.col !== 'number') break;
      const cell = node.children[op.row]?.children[op.col];
      const pos = cell?.position;
      if (pos?.start.offset === undefined || pos.end.offset === undefined) break;
      const value = content();
      if (/[\r\n]/.test(value)) break;
      const raw = source.slice(pos.start.offset, pos.end.offset);
      const leading = raw.startsWith('|') ? '|' : '';
      const trailing = raw.endsWith('|') && !raw.endsWith('\\|') ? '|' : '';
      return replace(pos.start.offset, pos.end.offset, leading + ' ' + value.replace(/\|/g, '\\|') + ' ' + trailing);
    }
  }
  throw new ArtifactError('INVALID_MARKDOWN_BLOCK_EDIT', 'The operation parameters do not match the selected Markdown block.', 422);
}
