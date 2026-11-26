import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { ArtifactError } from '../errors.js';
import { validateXmlWellFormedness, type XmlParsedElement } from './xml-validator.js';

const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MAX_PACKAGE_XML_BYTES = 32 * 1024 * 1024;
const MAX_XLSX_TARGET_CELLS = 50_000;
const MAX_SAX_ELEMENTS = 1_000_000;

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

export interface DocxParagraphTargetInfo {
  blockIndex: number;
  paraId?: string;
  fingerprint: string;
  contextBeforeHash: string;
  contextAfterHash: string;
  occurrenceIndex: number;
  duplicateCount: number;
  text: string;
}

export function readDocxAllParagraphTargets(bytes: Buffer): {
  totalBlocks: number;
  paragraphs: DocxParagraphTargetInfo[];
  byBlockIndex: Map<number, DocxParagraphTargetInfo>;
} {
  const name = 'word/document.xml';
  const { source, elements } = xml(readParts(bytes, new Set([name]))[name], WORD, 'document');
  const body = child(elements, 0, WORD, 'body');
  const bodyIndex = body ? elements.indexOf(body) : -1;
  const blocks = bodyIndex >= 0 ? elements.filter(element => element.parentIndex === bodyIndex) : [];
  const blockFingerprints = blocks.map(block => digest(snippet(source, block)));

  const counts = new Map<string, number>();
  const rawParagraphs: Array<{ blockIndex: number; paraId?: string; fingerprint: string; text: string }> = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.namespace !== WORD || block.name !== 'p') continue;
    const fp = blockFingerprints[i];
    counts.set(fp, (counts.get(fp) ?? 0) + 1);
    rawParagraphs.push({
      blockIndex: i,
      paraId: localAttribute(block, 'paraId'),
      fingerprint: fp,
      text: textOf(source, elements, block, WORD),
    });
  }

  const seen = new Map<string, number>();
  const paragraphs: DocxParagraphTargetInfo[] = [];
  const byBlockIndex = new Map<number, DocxParagraphTargetInfo>();
  for (const item of rawParagraphs) {
    const occ = seen.get(item.fingerprint) ?? 0;
    seen.set(item.fingerprint, occ + 1);
    const i = item.blockIndex;
    const beforeSlice = blockFingerprints.slice(Math.max(0, i - 2), i);
    const afterSlice = blockFingerprints.slice(i + 1, Math.min(blocks.length, i + 3));
    const entry: DocxParagraphTargetInfo = {
      blockIndex: i,
      paraId: item.paraId,
      fingerprint: item.fingerprint,
      contextBeforeHash: digest(...beforeSlice),
      contextAfterHash: digest(...afterSlice),
      occurrenceIndex: occ,
      duplicateCount: counts.get(item.fingerprint) ?? 1,
      text: item.text,
    };
    paragraphs.push(entry);
    byBlockIndex.set(i, entry);
  }
  return { totalBlocks: blocks.length, paragraphs, byBlockIndex };
}

export function readDocxParagraphTarget(bytes: Buffer, blockIndex: number): DocxParagraphTargetInfo | null {
  if (!Number.isInteger(blockIndex) || blockIndex < 0) return null;
  const { byBlockIndex } = readDocxAllParagraphTargets(bytes);
  return byBlockIndex.get(blockIndex) ?? null;
}

// ---------------------------------------------------------------------------
// Pure-JS XLSX workbook & range target inspection (no external worker needed)
// ---------------------------------------------------------------------------

export interface XlsxSheetTargetSummary {
  id: string;
  name: string;
  part: string;
}

export interface XlsxRangeTargetResult {
  sheetId: string;
  sheetName: string;
  sheetPart: string;
  rangeA1: string;
  expectedSheetStructHash: string;
  expectedRangeValuesHash: string;
  expectedOrderKeysHash: string;
  cells: Array<{ address: string; value: string; formula?: string; type?: string }>;
  snippet: string;
}

export interface XlsxSheetTargetResult {
  sheetId: string;
  sheetName: string;
  sheetPart: string;
  expectedSheetStructHash: string;
}

export interface XlsxRowColTargetResult {
  sheetId: string;
  sheetName: string;
  sheetPart: string;
  axis: 'row' | 'col';
  index: number;
  expectedSheetStructHash: string;
  expectedSliceHash: string;
  snippet: string;
}

function colLettersToIndex(letters: string): number {
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    const code = letters.charCodeAt(i);
    if (code < 65 || code > 90) return -1;
    col = col * 26 + (code - 64);
  }
  return col - 1;
}

function colIndexToLetters(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,4})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) return null;
  const col = colLettersToIndex(m[1].toUpperCase());
  const row = Number(m[2]) - 1;
  if (col < 0 || !Number.isSafeInteger(row) || row < 0) return null;
  return { row, col };
}

export function parseA1Range(rangeA1: string): { row0: number; row1: number; col0: number; col1: number; canonical: string } | null {
  const parts = rangeA1.trim().split(':');
  if (parts.length < 1 || parts.length > 2) return null;
  const a = parseCellRef(parts[0]);
  const b = parts.length === 2 ? parseCellRef(parts[1]) : a;
  if (!a || !b) return null;
  const row0 = Math.min(a.row, b.row);
  const row1 = Math.max(a.row, b.row);
  const col0 = Math.min(a.col, b.col);
  const col1 = Math.max(a.col, b.col);
  const startA1 = `${colIndexToLetters(col0)}${row0 + 1}`;
  const endA1 = `${colIndexToLetters(col1)}${row1 + 1}`;
  return { row0, row1, col0, col1, canonical: startA1 === endA1 ? startA1 : `${startA1}:${endA1}` };
}

function parseSharedStringsXml(data: Uint8Array | undefined): string[] {
  if (!data) return [];
  const source = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const parser = new SaxesParser({ xmlns: true, position: false });
  const strings: string[] = [];
  let inSi = false;
  let inT = false;
  let inPhonetic = false;
  let current = '';
  let count = 0;

  parser.on('doctype', () => invalidPackage());
  parser.on('error', () => invalidPackage());
  parser.on('opentag', (tag) => {
    if (++count > MAX_SAX_ELEMENTS) invalidPackage();
    if (tag.local === 'si') {
      inSi = true;
      current = '';
    } else if (tag.local === 'rPh') {
      inPhonetic = true;
    } else if (inSi && !inPhonetic && tag.local === 't') {
      inT = true;
    }
  });
  parser.on('text', (text) => {
    if (inSi && inT && !inPhonetic) current += text;
  });
  parser.on('closetag', (tag) => {
    if (tag.local === 't') inT = false;
    else if (tag.local === 'rPh') inPhonetic = false;
    else if (tag.local === 'si') {
      inSi = false;
      strings.push(current);
      current = '';
    }
  });
  parser.write(source).close();
  return strings;
}

export function readXlsxWorkbookTargets(bytes: Buffer): { format: 'xlsx'; sheets: XlsxSheetTargetSummary[] } {
  const wbPath = 'xl/workbook.xml';
  const relPath = 'xl/_rels/workbook.xml.rels';
  const parts = readParts(bytes, new Set([wbPath, relPath]));
  const workbook = xml(parts[wbPath], SPREADSHEET, 'workbook');
  const relationships = xml(parts[relPath], PACKAGE_REL, 'Relationships');

  const sheetPaths = new Map<string, string>();
  for (const el of relationships.elements) {
    if (el.name !== 'Relationship' || el.attrs.TargetMode === 'External') continue;
    const relType = el.attrs.Type ?? '';
    if (!relType.endsWith('/worksheet') && relType !== OFFICE_REL + '/worksheet') continue;
    const rawTarget = el.attrs.Target ?? '';
    const resolved = rawTarget.startsWith('/')
      ? posix.normalize(rawTarget).slice(1)
      : posix.resolve('/xl', rawTarget).slice(1);
    if (resolved.startsWith('xl/') && !resolved.includes('..')) {
      sheetPaths.set(el.attrs.Id, resolved);
    }
  }

  const sheetsNode = child(workbook.elements, 0, SPREADSHEET, 'sheets');
  const sheetsIndex = sheetsNode ? workbook.elements.indexOf(sheetsNode) : -1;
  const sheets: XlsxSheetTargetSummary[] = [];
  if (sheetsIndex >= 0) {
    for (const el of workbook.elements) {
      if (el.parentIndex !== sheetsIndex || el.namespace !== SPREADSHEET || el.name !== 'sheet') continue;
      const rId = Object.entries(el.attrs).find(([k]) => k === 'r:id' || k.endsWith(':id'))?.[1];
      const part = rId ? sheetPaths.get(rId) : undefined;
      const id = el.attrs.sheetId ?? String(sheets.length + 1);
      const name = el.attrs.name ?? `Sheet${sheets.length + 1}`;
      if (part) sheets.push({ id, name, part });
    }
  }
  if (sheets.length === 0) invalidPackage();
  return { format: 'xlsx', sheets };
}

export function readXlsxRangeTarget(
  bytes: Buffer,
  sheetSelector: string,
  rangeA1: string,
): XlsxRangeTargetResult | null {
  const wb = readXlsxWorkbookTargets(bytes);
  const sheet =
    wb.sheets.find((s) => s.id === sheetSelector) ??
    wb.sheets.find((s) => s.name === sheetSelector) ??
    wb.sheets.find((s) => s.part === sheetSelector);
  if (!sheet) return null;

  const parsedRange = parseA1Range(rangeA1);
  if (!parsedRange) return null;
  const totalRangeCells = (parsedRange.row1 - parsedRange.row0 + 1) * (parsedRange.col1 - parsedRange.col0 + 1);
  if (totalRangeCells <= 0 || totalRangeCells > MAX_XLSX_TARGET_CELLS) {
    throw new ArtifactError('INVALID_TARGET', '選択範囲が大きすぎます。', 422);
  }

  const sharedStringsPath = 'xl/sharedStrings.xml';
  const parts = readParts(bytes, new Set([sheet.part, sharedStringsPath]));
  const sheetBytes = parts[sheet.part];
  if (!sheetBytes) return null;
  const sharedStrings = parseSharedStringsXml(parts[sharedStringsPath]);
  const sheetXml = new TextDecoder('utf-8', { fatal: true }).decode(sheetBytes);

  // Stream-parse worksheet XML for structure hash + target range cell map
  const structHash = createHash('sha256');
  structHash.update(`sheet:${sheet.id}:${sheet.name}\n`);

  interface CellEntry {
    t: string;
    v: string;
    f: string | null;
    fAttrs: string;
  }
  const rangeCells = new Map<string, CellEntry>();

  const parser = new SaxesParser({ xmlns: true, position: false });
  let elemCount = 0;
  let currentRowNum = 0;
  let autoColIdx = 0;

  let inCell = false;
  let cellRef = '';
  let cellRow = -1;
  let cellCol = -1;
  let cellType = '';
  let cellInRange = false;

  let inV = false;
  let inF = false;
  let inIs = false;
  let inIsT = false;
  let vBuf = '';
  let fBuf = '';
  let fAttrs = '';
  let hasFormula = false;
  let isBuf = '';

  const attrStr = (attrs: Record<string, { value: string }>, key: string) => attrs[key]?.value ?? '';

  parser.on('doctype', () => invalidPackage());
  parser.on('error', () => invalidPackage());
  parser.on('opentag', (tag) => {
    if (++elemCount > MAX_SAX_ELEMENTS) invalidPackage();
    const local = tag.local;
    const attrs = tag.attributes as Record<string, { value: string }>;

    if (local === 'dimension') {
      structHash.update(`dim:${attrStr(attrs, 'ref')}\n`);
    } else if (local === 'col') {
      structHash.update(`col:${attrStr(attrs, 'min')}:${attrStr(attrs, 'max')}:${attrStr(attrs, 'hidden')}\n`);
    } else if (local === 'mergeCell') {
      structHash.update(`merge:${attrStr(attrs, 'ref')}\n`);
    } else if (local === 'autoFilter') {
      structHash.update(`filter:${attrStr(attrs, 'ref')}\n`);
    } else if (local === 'pane') {
      structHash.update(`pane:${attrStr(attrs, 'xSplit')}:${attrStr(attrs, 'ySplit')}:${attrStr(attrs, 'topLeftCell')}\n`);
    } else if (local === 'tablePart') {
      const rId = Object.entries(attrs).find(([k]) => k === 'r:id' || k.endsWith(':id'))?.[1]?.value ?? '';
      structHash.update(`table:${rId}\n`);
    } else if (local === 'row') {
      const rAttr = Number(attrStr(attrs, 'r'));
      currentRowNum = Number.isInteger(rAttr) && rAttr > 0 ? rAttr : currentRowNum + 1;
      autoColIdx = 0;
      structHash.update(`row:${currentRowNum}:${attrStr(attrs, 'hidden')}\n`);
    } else if (local === 'c') {
      inCell = true;
      cellRef = attrStr(attrs, 'r');
      cellType = attrStr(attrs, 't');
      const parsed = cellRef ? parseCellRef(cellRef) : null;
      if (parsed) {
        cellRow = parsed.row;
        cellCol = parsed.col;
        autoColIdx = parsed.col + 1;
      } else {
        cellRow = Math.max(0, currentRowNum - 1);
        cellCol = autoColIdx++;
        cellRef = `${colIndexToLetters(cellCol)}${cellRow + 1}`;
      }
      structHash.update(`c:${cellRef}\n`);
      cellInRange =
        cellRow >= parsedRange.row0 &&
        cellRow <= parsedRange.row1 &&
        cellCol >= parsedRange.col0 &&
        cellCol <= parsedRange.col1;
      vBuf = '';
      fBuf = '';
      fAttrs = '';
      hasFormula = false;
      isBuf = '';
    } else if (inCell && cellInRange) {
      if (local === 'v') {
        inV = true;
      } else if (local === 'f') {
        inF = true;
        hasFormula = true;
        fAttrs = `${attrStr(attrs, 't')}|${attrStr(attrs, 'ref')}|${attrStr(attrs, 'si')}`;
      } else if (local === 'is') {
        inIs = true;
      } else if (inIs && local === 't') {
        inIsT = true;
      }
    }
  });

  parser.on('text', (text) => {
    if (!inCell || !cellInRange) return;
    if (inV) vBuf += text;
    else if (inF) fBuf += text;
    else if (inIs && inIsT) isBuf += text;
  });

  parser.on('closetag', (tag) => {
    const local = tag.local;
    if (local === 'v') inV = false;
    else if (local === 'f') inF = false;
    else if (local === 't') inIsT = false;
    else if (local === 'is') inIs = false;
    else if (local === 'c' && inCell) {
      if (cellInRange) {
        let resolvedValue = vBuf;
        if (cellType === 's') {
          const idx = Number(vBuf);
          resolvedValue = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : vBuf;
        } else if (cellType === 'inlineStr') {
          resolvedValue = isBuf;
        }
        rangeCells.set(`${cellRow}:${cellCol}`, {
          t: cellType || (hasFormula ? 'formula' : 'n'),
          v: resolvedValue,
          f: hasFormula ? fBuf : null,
          fAttrs: hasFormula ? fAttrs : '',
        });
      }
      inCell = false;
      cellInRange = false;
    }
  });

  parser.write(sheetXml).close();

  // Build ordered row-major hash of values, formulas, types, and order across the exact range
  const rangeHash = createHash('sha256');
  rangeHash.update(`range:${sheet.id}:${parsedRange.canonical}\n`);
  const orderKeysHash = createHash('sha256');
  orderKeysHash.update(`order:${sheet.id}:${parsedRange.canonical}\n`);
  const snippetCells: Array<{ address: string; value: string; formula?: string; type?: string }> = [];

  for (let r = parsedRange.row0; r <= parsedRange.row1; r++) {
    const firstKeyEntry = rangeCells.get(`${r}:${parsedRange.col0}`);
    orderKeysHash.update(JSON.stringify([r, firstKeyEntry?.v ?? '', firstKeyEntry?.f ?? null])).update('\n');
    for (let c = parsedRange.col0; c <= parsedRange.col1; c++) {
      const a1 = `${colIndexToLetters(c)}${r + 1}`;
      const entry = rangeCells.get(`${r}:${c}`);
      const serialized = entry
        ? JSON.stringify([a1, entry.t, entry.v, entry.f, entry.fAttrs])
        : JSON.stringify([a1, '', '', null, '']);
      rangeHash.update(serialized).update('\n');
      if (entry && snippetCells.length < 1000) {
        snippetCells.push({
          address: a1,
          value: entry.v,
          ...(entry.f !== null ? { formula: entry.f } : {}),
          type: entry.t,
        });
      }
    }
  }

  const snippetText = snippetCells
    .map((c) => `${c.address} ${c.formula !== undefined ? '=' + c.formula : c.value}`)
    .join('\n');

  return {
    sheetId: sheet.id,
    sheetName: sheet.name,
    sheetPart: sheet.part,
    rangeA1: parsedRange.canonical,
    expectedSheetStructHash: structHash.digest('hex'),
    expectedRangeValuesHash: rangeHash.digest('hex'),
    expectedOrderKeysHash: orderKeysHash.digest('hex'),
    cells: snippetCells,
    snippet: snippetText,
  };
}

export function readXlsxSheetTarget(
  bytes: Buffer,
  sheetSelector: string,
): XlsxSheetTargetResult | null {
  const single = readXlsxRangeTarget(bytes, sheetSelector, 'A1');
  if (!single) return null;
  return {
    sheetId: single.sheetId,
    sheetName: single.sheetName,
    sheetPart: single.sheetPart,
    expectedSheetStructHash: single.expectedSheetStructHash,
  };
}

export function readXlsxRowColTarget(
  bytes: Buffer,
  sheetSelector: string,
  axis: 'row' | 'col',
  index: number,
): XlsxRowColTargetResult | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const wb = readXlsxWorkbookTargets(bytes);
  const sheet =
    wb.sheets.find((s) => s.id === sheetSelector) ??
    wb.sheets.find((s) => s.name === sheetSelector) ??
    wb.sheets.find((s) => s.part === sheetSelector);
  if (!sheet) return null;

  const sharedStringsPath = 'xl/sharedStrings.xml';
  const parts = readParts(bytes, new Set([sheet.part, sharedStringsPath]));
  const sheetBytes = parts[sheet.part];
  if (!sheetBytes) return null;
  const sharedStrings = parseSharedStringsXml(parts[sharedStringsPath]);
  const sheetXml = new TextDecoder('utf-8', { fatal: true }).decode(sheetBytes);

  const structHash = createHash('sha256');
  structHash.update(`sheet:${sheet.id}:${sheet.name}\n`);

  const sliceEntries: Array<{ pos: number; a1: string; t: string; v: string; f: string | null; fAttrs: string }> = [];
  const parser = new SaxesParser({ xmlns: true, position: false });
  let elemCount = 0;
  let currentRowNum = 0;
  let autoColIdx = 0;
  let inCell = false;
  let cellRef = '';
  let cellRow = -1;
  let cellCol = -1;
  let cellType = '';
  let inSlice = false;
  let inV = false;
  let inF = false;
  let inIs = false;
  let inIsT = false;
  let vBuf = '';
  let fBuf = '';
  let fAttrs = '';
  let hasFormula = false;
  let isBuf = '';
  const attrStr = (attrs: Record<string, { value: string }>, key: string) => attrs[key]?.value ?? '';

  parser.on('doctype', () => invalidPackage());
  parser.on('error', () => invalidPackage());
  parser.on('opentag', (tag) => {
    if (++elemCount > MAX_SAX_ELEMENTS) invalidPackage();
    const local = tag.local;
    const attrs = tag.attributes as Record<string, { value: string }>;
    if (local === 'dimension') {
      structHash.update(`dim:${attrStr(attrs, 'ref')}\n`);
    } else if (local === 'col') {
      structHash.update(`col:${attrStr(attrs, 'min')}:${attrStr(attrs, 'max')}:${attrStr(attrs, 'hidden')}\n`);
    } else if (local === 'mergeCell') {
      structHash.update(`merge:${attrStr(attrs, 'ref')}\n`);
    } else if (local === 'autoFilter') {
      structHash.update(`filter:${attrStr(attrs, 'ref')}\n`);
    } else if (local === 'pane') {
      structHash.update(`pane:${attrStr(attrs, 'xSplit')}:${attrStr(attrs, 'ySplit')}:${attrStr(attrs, 'topLeftCell')}\n`);
    } else if (local === 'tablePart') {
      const rId = Object.entries(attrs).find(([k]) => k === 'r:id' || k.endsWith(':id'))?.[1]?.value ?? '';
      structHash.update(`table:${rId}\n`);
    } else if (local === 'row') {
      const rAttr = Number(attrStr(attrs, 'r'));
      currentRowNum = Number.isInteger(rAttr) && rAttr > 0 ? rAttr : currentRowNum + 1;
      autoColIdx = 0;
      structHash.update(`row:${currentRowNum}:${attrStr(attrs, 'hidden')}\n`);
    } else if (local === 'c') {
      inCell = true;
      cellRef = attrStr(attrs, 'r');
      cellType = attrStr(attrs, 't');
      const parsed = cellRef ? parseCellRef(cellRef) : null;
      if (parsed) {
        cellRow = parsed.row;
        cellCol = parsed.col;
        autoColIdx = parsed.col + 1;
      } else {
        cellRow = Math.max(0, currentRowNum - 1);
        cellCol = autoColIdx++;
        cellRef = `${colIndexToLetters(cellCol)}${cellRow + 1}`;
      }
      structHash.update(`c:${cellRef}\n`);
      inSlice = axis === 'row' ? cellRow === index : cellCol === index;
      vBuf = '';
      fBuf = '';
      fAttrs = '';
      hasFormula = false;
      isBuf = '';
    } else if (inCell && inSlice) {
      if (local === 'v') inV = true;
      else if (local === 'f') {
        inF = true;
        hasFormula = true;
        fAttrs = `${attrStr(attrs, 't')}|${attrStr(attrs, 'ref')}|${attrStr(attrs, 'si')}`;
      } else if (local === 'is') inIs = true;
      else if (inIs && local === 't') inIsT = true;
    }
  });
  parser.on('text', (text) => {
    if (!inCell || !inSlice) return;
    if (inV) vBuf += text;
    else if (inF) fBuf += text;
    else if (inIs && inIsT) isBuf += text;
  });
  parser.on('closetag', (tag) => {
    const local = tag.local;
    if (local === 'v') inV = false;
    else if (local === 'f') inF = false;
    else if (local === 't') inIsT = false;
    else if (local === 'is') inIs = false;
    else if (local === 'c' && inCell) {
      if (inSlice) {
        let resolvedValue = vBuf;
        if (cellType === 's') {
          const idx = Number(vBuf);
          resolvedValue = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : vBuf;
        } else if (cellType === 'inlineStr') {
          resolvedValue = isBuf;
        }
        sliceEntries.push({
          pos: axis === 'row' ? cellCol : cellRow,
          a1: cellRef,
          t: cellType || (hasFormula ? 'formula' : 'n'),
          v: resolvedValue,
          f: hasFormula ? fBuf : null,
          fAttrs: hasFormula ? fAttrs : '',
        });
      }
      inCell = false;
      inSlice = false;
    }
  });

  parser.write(sheetXml).close();
  sliceEntries.sort((a, b) => a.pos - b.pos);

  const sliceHash = createHash('sha256');
  sliceHash.update(`slice:${sheet.id}:${axis}:${index}\n`);
  for (const e of sliceEntries) {
    sliceHash.update(JSON.stringify([e.a1, e.t, e.v, e.f, e.fAttrs])).update('\n');
  }
  const snippet = sliceEntries
    .slice(0, 200)
    .map((e) => `${e.a1} ${e.f !== null ? '=' + e.f : e.v}`)
    .join('\n');

  return {
    sheetId: sheet.id,
    sheetName: sheet.name,
    sheetPart: sheet.part,
    axis,
    index,
    expectedSheetStructHash: structHash.digest('hex'),
    expectedSliceHash: sliceHash.digest('hex'),
    snippet,
  };
}

