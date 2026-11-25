import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { unzipSync } from 'fflate';
import { ArtifactError } from '../errors.js';
import { validateXmlWellFormedness, type XmlParsedElement } from './xml-validator.js';

const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MAX_PACKAGE_XML_BYTES = 32 * 1024 * 1024;

function invalidPackage(): never {
  throw new ArtifactError('INVALID_OFFICE_PACKAGE', '文書の構造を読み取れません。', 422);
}

function readParts(bytes: Buffer, names: ReadonlySet<string>, maximumBytes = MAX_PACKAGE_XML_BYTES) {
  try {
    let remaining = maximumBytes;
    const declared = new Set<string>();
    return unzipSync(bytes, { filter: entry => {
      if (!names.has(entry.name)) return false;
      if (declared.has(entry.name) || !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) invalidPackage();
      declared.add(entry.name);
      remaining -= Math.max(entry.originalSize, entry.size);
      if (remaining < 0) invalidPackage();
      return true;
    } });
  } catch { return invalidPackage(); }
}

function xml(data: Uint8Array | undefined, namespace: string, root: string) {
  if (!data) return invalidPackage();
  const source = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const parsed = validateXmlWellFormedness(source, true);
  if (parsed.status !== 'passed' || parsed.root?.name !== root || parsed.root.namespace !== namespace) return invalidPackage();
  return { source, elements: parsed.elements };
}

function child(elements: XmlParsedElement[], parent: number, namespace: string, name: string) {
  return elements.find(element => element.parentIndex === parent && element.namespace === namespace && element.name === name);
}
function localAttribute(element: XmlParsedElement | undefined, name: string) {
  if (!element) return undefined;
  return element.attrs[name] ?? Object.entries(element.attrs).find(([key]) => key.split(':').at(-1) === name)?.[1];
}
function snippet(source: string, element: XmlParsedElement) {
  return source.slice(element.start, element.end);
}
function digest(...parts: (string | Uint8Array)[]) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(typeof part === 'string' ? Buffer.byteLength(part) : part.length)).update(':').update(part);
  return hash.digest('hex');
}
function decodeXmlText(text: string) {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, token: string) =>
    token[0] === '#' ? String.fromCodePoint(token[1] === 'x' ? parseInt(token.slice(2), 16) : Number(token.slice(1))) : entities[token]);
}
function inside(element: XmlParsedElement, container: XmlParsedElement) {
  return element.start > container.start && element.end < container.end;
}
function textOf(source: string, elements: XmlParsedElement[], element: XmlParsedElement, namespace: string) {
  return elements.filter(part => part.name === 't' && part.namespace === namespace && inside(part, element))
    .map(part => decodeXmlText(source.slice(part.openEnd, part.closeStart))).join('');
}

export function readPptxTargets(bytes: Buffer) {
  const name = 'ppt/presentation.xml', relationName = 'ppt/_rels/presentation.xml.rels';
  const parts = readParts(bytes, new Set([name, relationName]));
  const presentation = xml(parts[name], PRESENTATION, 'presentation');
  const relationships = xml(parts[relationName], PACKAGE_REL, 'Relationships');
  const slidePaths = new Map(relationships.elements.filter(element =>
    element.name === 'Relationship' && element.attrs.Type === OFFICE_REL + '/slide' && element.attrs.TargetMode !== 'External'
  ).map(element => [element.attrs.Id, posix.resolve('/ppt', element.attrs.Target ?? '').slice(1)]));
  const size = child(presentation.elements, 0, PRESENTATION, 'sldSz');
  const slideSize = size ? { widthPt: Number(size.attrs.cx) / 12700, heightPt: Number(size.attrs.cy) / 12700 } : undefined;
  const slideList = child(presentation.elements, 0, PRESENTATION, 'sldIdLst');
  const slides = slideList ? presentation.elements.filter(element =>
    element.parentIndex === presentation.elements.indexOf(slideList) && element.namespace === PRESENTATION && element.name === 'sldId'
  ).flatMap(element => {
    const relationshipId = Object.keys(element.attrs).find(key => key.endsWith(':id'));
    const part = relationshipId && slidePaths.get(element.attrs[relationshipId]);
    return part && /^ppt\/slides\/[^/]+\.xml$/.test(part) ? [{ id: element.attrs.id, part }] : [];
  }) : [];
  if (new Set(slides.map(slide => slide.id)).size !== slides.length) return invalidPackage();
  return { format: 'pptx', slideSize, slides };
}

export function readPptxSlideTargets(bytes: Buffer, part: string) {
  const slide = readPptxTargets(bytes).slides.find(slide => slide.part === part);
  if (!slide) throw new ArtifactError('INVALID_TARGET', 'スライドが見つかりません。', 422);
  const relation = posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
  const parts = readParts(bytes, new Set([part, relation]));
  const { source, elements } = xml(parts[part], PRESENTATION, 'sld');
  const common = child(elements, 0, PRESENTATION, 'cSld');
  const tree = common && child(elements, elements.indexOf(common), PRESENTATION, 'spTree');
  if (!tree) return invalidPackage();
  const relationships = parts[relation] ? xml(parts[relation], PACKAGE_REL, 'Relationships') : undefined;
  const related = new Map(relationships?.elements.filter(element => element.name === 'Relationship' && element.attrs.TargetMode !== 'External')
    .map(element => [element.attrs.Id, posix.resolve('/', posix.dirname(part), element.attrs.Target ?? '').slice(1)]) ?? []);
  const relevant = new Set([...related.values()].filter(name => /^ppt\/(?:media|charts|diagrams|slideLayouts)\//.test(name)));
  const referencedParts = readParts(bytes, relevant, 100 * 1024 * 1024);
  const relationshipsHash = digest(parts[relation] ?? '', ...[...relevant].sort().flatMap(name => [name, referencedParts[name] ?? '']));
  const shapeTypes = new Set(['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp']);
  const shapes = elements.flatMap((element, index) => {
    if (!shapeTypes.has(element.name) || element.namespace !== PRESENTATION || !inside(element, tree)) return [];
    const props = elements.find(prop => prop.name === 'cNvPr' && prop.namespace === PRESENTATION &&
      prop.parentIndex !== null && elements[prop.parentIndex].parentIndex === index);
    if (!props?.attrs.id) return [];
    const groups: string[] = [], geometry: string[] = [];
    for (let parent = element.parentIndex; parent !== null; parent = elements[parent].parentIndex) {
      if (elements[parent].name !== 'grpSp') continue;
      const groupProperties = child(elements, parent, PRESENTATION, 'nvGrpSpPr');
      const id = groupProperties && child(elements, elements.indexOf(groupProperties), PRESENTATION, 'cNvPr')?.attrs.id;
      if (id) groups.unshift(id);
      const groupGeometry = child(elements, parent, PRESENTATION, 'grpSpPr');
      if (groupGeometry) geometry.unshift(snippet(source, groupGeometry));
    }
    return [{ id: props.attrs.id, name: props.attrs.name || props.attrs.id, type: element.name, groupPath: groups,
      text: textOf(source, elements, element, DRAWING),
      fingerprint: digest(snippet(source, element), ...geometry, relationshipsHash) }];
  });
  return { slideId: slide.id, shapes, slideHash: digest(source, relationshipsHash) };
}

export function readDocxParagraphTarget(bytes: Buffer, blockIndex: number) {
  const name = 'word/document.xml';
  const { source, elements } = xml(readParts(bytes, new Set([name]))[name], WORD, 'document');
  const body = child(elements, 0, WORD, 'body');
  const blocks = body ? elements.filter(element => element.parentIndex === elements.indexOf(body)) : [];
  const block = blocks[blockIndex];
  if (!block || block.namespace !== WORD || block.name !== 'p') return null;
  const paraId = localAttribute(block, 'paraId');
  const fingerprint = digest(snippet(source, block));
  return { blockIndex, paraId, fingerprint, text: textOf(source, elements, block, WORD) };
}
