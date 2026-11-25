import { defaultTreeAdapter, parse, parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { ArtifactError } from '../errors.js';
import type { AdapterOperation, OperationCapability } from '../types.js';
import { editCapabilities, sha256Text } from './base.js';
import { validateXmlWellFormedness } from './xml-validator.js';

type MarkupFormat = 'svg' | 'html';
export interface MarkupElement {
  index: number;
  parentIndex: number | null;
  tag: string;
  namespace: string;
  id: string | null;
  attrs: Record<string, string>;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  selfClosing: boolean;
  fingerprint: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const ELEMENT_OPS = ['set_attr', 'set_text', 'insert_element', 'replace_element', 'remove_element', 'move_element'] as const;
const SVG_OPS = ['set_style', 'set_geometry', 'add_shape', 'add_text'] as const;

export function markupCapabilities(format: MarkupFormat): OperationCapability[] {
  return editCapabilities(format, format === 'svg' ? [...ELEMENT_OPS, ...SVG_OPS] : [...ELEMENT_OPS, 'apply_patch']);
}

export function markupElements(source: string, format: MarkupFormat): MarkupElement[] {
  const elements: MarkupElement[] = [];
  const add = (data: Omit<MarkupElement, 'index' | 'id' | 'fingerprint'>) => {
    const element = {
      ...data, index: elements.length, id: data.attrs.id ?? null,
      fingerprint: sha256Text(`${data.tag}|${source.slice(data.start, data.end).trim()}`),
    };
    elements.push(element);
    return element.index;
  };
  if (format === 'svg') {
    const xml = validateXmlWellFormedness(source, true);
    if (xml.status !== 'passed' || xml.root?.namespace !== SVG_NS || xml.root.name !== 'svg') {
      throw new ArtifactError('INVALID_SVG_STRUCTURE', xml.status === 'passed' ? 'Expected an SVG root.' : xml.evidence, 422);
    }
    for (const node of xml.elements) add({
      parentIndex: node.parentIndex, tag: node.qualifiedName, namespace: node.namespace, attrs: node.attrs, start: node.start,
      openEnd: node.openEnd, closeStart: node.closeStart, end: node.end, selfClosing: node.openEnd === node.end,
    });
  } else {
    type Node = DefaultTreeAdapterTypes.ChildNode;
    const pending = parse(source, { sourceCodeLocationInfo: true }).childNodes.map((node) => ({ node, parentIndex: null as number | null })).reverse();
    while (pending.length) {
      const { node, parentIndex } = pending.pop()!;
      if (!('tagName' in node)) continue;
      const loc = node.sourceCodeLocation;
      const index = loc?.startTag ? add({
        parentIndex, tag: node.tagName, namespace: node.namespaceURI,
        attrs: Object.fromEntries(node.attrs.map(({ name, prefix, value }) => [prefix ? `${prefix}:${name}` : name, value])),
        start: loc.startTag.startOffset, openEnd: loc.startTag.endOffset, closeStart: loc.endTag?.startOffset ?? loc.endOffset,
        end: loc.endOffset, selfClosing: HTML_VOID.has(node.tagName) || /\/\s*>$/.test(source.slice(loc.startTag.startOffset, loc.startTag.endOffset)) &&
          node.namespaceURI !== 'http://www.w3.org/1999/xhtml',
      }) : parentIndex;
      const children: Node[] = 'content' in node ? node.content.childNodes : node.childNodes;
      for (let i = children.length - 1; i >= 0; i--) pending.push({ node: children[i], parentIndex: index });
    }
  }
  return elements;
}

export function elementMetadata(elements: MarkupElement[]) {
  return elements.map(({ index, parentIndex, tag, id, attrs, fingerprint }) => ({ index, parentIndex, tag, id, attrs, fingerprint }));
}

function findElement(elements: MarkupElement[], id: unknown, index: unknown, fingerprint?: unknown): MarkupElement {
  const matches = typeof id === 'string' ? elements.filter((node) => node.id === id)
    : Number.isInteger(index) && typeof index === 'number' && elements[index] ? [elements[index]] : [];
  if (matches.length !== 1 || (fingerprint !== undefined && matches[0].fingerprint !== fingerprint)) {
    throw new ArtifactError('ELEMENT_CONFLICT', 'Select one element by unique ID or structure index and refresh a changed fingerprint.', 409);
  }
  return matches[0];
}

const xmlName = /^[A-Za-z_][\w.:-]*$/;
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

function attribute(name: string, value: unknown, format: MarkupFormat): string {
  if (!xmlName.test(name) || /^on/i.test(name) || /^xmlns(?::|$)/i.test(name) ||
      (format === 'svg' && /^(?:href|xlink:href)$/i.test(name) &&
      /^\s*(?:javascript|vbscript):/i.test(String(value).replace(/[\r\n\t]/g, '')))) {
    throw new ArtifactError('INVALID_MARKUP_ATTRIBUTE', `Invalid or protected attribute: ${name}.`, 422);
  }
  if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new ArtifactError('INVALID_MARKUP_ATTRIBUTE', `Expected a scalar value for ${name}.`, 400);
  }
  return value === null ? '' : ` ${name}="${escapeAttr(String(value))}"`;
}

function editAttributes(openTag: string, changes: Record<string, unknown>, format: MarkupFormat): string {
  const values = new Map(Object.entries(changes).map(([name, value]) => [
    format === 'html' ? name.toLowerCase() : name, attribute(name, value, format),
  ]));
  const changed = openTag.replace(/\s+([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g, (raw, attr: string) => {
    const name = format === 'html' ? attr.toLowerCase() : attr;
    if (!values.has(name)) return raw;
    const replacement = values.get(name)!;
    values.delete(name);
    return replacement;
  });
  return changed.replace(/\s*(\/?>)$/, (_raw, end: string) => `${[...values.values()].join('')}${end}`);
}

function insertMarkup(source: string, parent: MarkupElement, content: string, format: MarkupFormat): string {
  if (!parent.selfClosing) return source.slice(0, parent.closeStart) + content + source.slice(parent.closeStart);
  if (format === 'html' && HTML_VOID.has(parent.tag)) throw new ArtifactError('VOID_MARKUP_ELEMENT', 'A void element cannot contain children.', 422);
  return source.slice(0, parent.openEnd).replace(/\/>$/, '>') + content + `</${parent.tag}>` + source.slice(parent.end);
}

const SVG_SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'image', 'g']);

function objectChanges(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArtifactError('INVALID_MARKUP_ATTRIBUTES', 'Expected an attributes object.', 400);
  }
  return value as Record<string, unknown>;
}

export function editMarkup(source: string, op: AdapterOperation, format: MarkupFormat): string | undefined {
  const action = op.op.startsWith(`${format}.`) ? op.op.slice(format.length + 1) : op.op;
  if (!markupCapabilities(format).some(({ operation }) => operation === `${format}.${action}`) || action === 'apply_patch') return;
  const elements = markupElements(source, format);
  let result: string;
  if (action === 'insert_element' || action === 'add_shape' || action === 'add_text') {
    const parent = findElement(elements, op.parentId, op.parentIndex ?? (format === 'svg' && op.parentId === undefined ? 0 : undefined));
    const attributes = op.attributes === undefined ? {} : objectChanges(op.attributes);
    let content = typeof op.markup === 'string' ? op.markup : '';
    if (action !== 'insert_element') {
      const tag = action === 'add_text' ? 'text' : String(op.tag ?? '');
      if (action === 'add_shape' && !SVG_SHAPES.has(tag)) throw new ArtifactError('INVALID_SVG_SHAPE', 'Choose a supported SVG shape.', 400);
      const attrs = Object.entries(attributes).map(([name, value]) => attribute(name, value, format)).join('');
      content = action === 'add_text' ? `<text${attrs}>${escapeText(String(op.text ?? ''))}</text>` : `<${tag}${attrs}/>`;
    }
    if (!content) throw new ArtifactError('MISSING_MARKUP', 'Provide markup to insert.', 400);
    if (format === 'html' && parseFragment(defaultTreeAdapter.createElement(parent.tag, parent.namespace as DefaultTreeAdapterTypes.Element['namespaceURI'], []), content, {}).childNodes.length === 0) throw new ArtifactError('MISSING_MARKUP', 'No fragment content.', 422);
    result = insertMarkup(source, parent, content, format);
  } else {
    const element = findElement(elements, op.elementId, op.elementIndex, op.expectedFingerprint);
    const { start, end, openEnd, closeStart } = element;
    if (action === 'remove_element' || action === 'replace_element') {
      if (action === 'replace_element' && typeof op.markup !== 'string') throw new ArtifactError('MISSING_MARKUP', 'Provide replacement markup.', 400);
      result = source.slice(0, start) + (action === 'replace_element' ? String(op.markup) : '') + source.slice(end);
    } else if (action === 'move_element') {
      const parent = findElement(elements, op.parentId, op.parentIndex);
      if (parent.start >= start && parent.start < end) throw new ArtifactError('MARKUP_CYCLE', 'Cannot move an element into its own subtree.', 422);
      const raw = source.slice(start, end);
      const removed = source.slice(0, start) + source.slice(end);
      const adjust = (offset: number) => offset >= end ? offset - (end - start) : offset;
      result = insertMarkup(removed, { ...parent, openEnd: adjust(parent.openEnd), closeStart: adjust(parent.closeStart), end: adjust(parent.end) }, raw, format);
    } else if (action === 'set_text') {
      if (typeof op.text !== 'string') throw new ArtifactError('MISSING_MARKUP_TEXT', 'Provide text content.', 400);
      result = element.selfClosing ? insertMarkup(source, element, escapeText(op.text), format)
        : source.slice(0, openEnd) + escapeText(op.text) + source.slice(closeStart);
    } else {
      const attrs = action === 'set_attr' ? op.attributes === undefined ? { [String(op.attr ?? '')]: op.value ?? null } : objectChanges(op.attributes)
        : action === 'set_style' ? { style: op.style }
        : objectChanges(op.geometry);
      result = source.slice(0, start) + editAttributes(source.slice(start, openEnd), attrs, format) + source.slice(openEnd);
    }
  }
  if (format === 'svg') markupElements(result, format);
  return result;
}
