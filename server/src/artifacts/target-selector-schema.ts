import { z } from 'zod';
import {
  getRegisteredSelectorsForFormat,
  isDeprecatedSelectorKind,
  isRegisteredSelectorKind,
  selectorHasRegisteredUi,
  selectorMatchesRegisteredFormat,
  type TargetSelectorKind,
} from '../../../shared/target-selection-registry.js';
import type { TargetSelector } from './types.js';

const id = z.union([z.string().trim().min(1), z.number().int().nonnegative()]);
const text = z.string().trim().min(1);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const num = z.number().finite();
const nonnegative = num.nonnegative();
const norm = nonnegative.max(1);
const index = nonnegative.int().safe();
const positive = index.min(1);
const revision = positive.safe();
const rect = z.tuple([num, num, num.positive(), num.positive()]);
const lineRange = { startLine: positive, endLine: positive };
const context = { contextBeforeHash: hash, contextAfterHash: hash };
const snippet = { ...context, expectedSnippetHash: hash, occurrenceIndex: index };
const cell = { row: index, col: index, expectedCellHash: hash };
const slice = { axis: z.enum(['row', 'col']), start: index, end: index };
const slide = { slideId: id };
const shape = { ...slide, shapeId: id };
const page = { pageIndex: index, expectedPageCount: positive, expectedPageContentHash: hash };
const image = { expectedWidthPx: positive, expectedHeightPx: positive, expectedImageSha256: hash, expectedRegionSha256: hash };
const media = { startSec: nonnegative, endSec: num.positive(), expectedDurationSec: num.positive(), expectedMediaSha256: hash };
const sheet = { sheetId: id, expectedSheetStructHash: hash };
const rich = { blockId: text };
const duplicateInfo = { occurrenceIndex: index.optional(), duplicateCount: positive.optional() };

const fields = {
  // PPTX
  pptx_slide: {
    ...slide,
    expectedSlideHash: hash,
    pointPt: z.object({
      xPt: nonnegative,
      yPt: nonnegative,
      widthPt: num.positive(),
      heightPt: num.positive(),
    }).strict().optional(),
  },
  pptx_element: { ...shape, groupPath: z.array(id).optional(), expectedElementFingerprint: hash },
  pptx_region: { ...slide, rectPt: rect, expectedSlideHash: hash },

  // DOCX
  docx_paragraph: {
    paraId: text.optional(),
    blockIndex: index.optional(),
    expectedBlockHash: hash,
    contextBeforeHash: hash.optional(),
    contextAfterHash: hash.optional(),
    ...duplicateInfo,
  },

  // XLSX
  xlsx_range: { ...sheet, rangeA1: text, expectedRangeValuesHash: hash, expectedOrderKeysHash: hash.optional() },
  xlsx_row_col: { ...sheet, ...slice, expectedRangeValuesHash: hash },
  xlsx_sheet: { ...sheet, expectedSheetContentHash: hash },

  // CSV / TSV
  csv_range: {
    startRow: index,
    endRow: index,
    startCol: index,
    endCol: index,
    expectedRowCount: positive,
    expectedColCount: positive,
    expectedRangeValuesHash: hash,
    expectedHeaderHash: hash,
  },
  csv_row_col: {
    ...slice,
    expectedRowCount: positive,
    expectedColCount: positive,
    expectedRangeValuesHash: hash,
    expectedHeaderHash: hash,
  },

  // PDF
  pdf_page: page,
  pdf_pin: { ...page, expectedRegionDigest: hash, xPt: nonnegative, yPt: nonnegative },
  pdf_region: { ...page, expectedRegionDigest: hash, rectPt: rect },

  // Image
  image_pin: { ...image, xNorm: norm, yNorm: norm },
  image_rect: { ...image, xNorm: norm, yNorm: norm, wNorm: norm.positive(), hNorm: norm.positive() },

  // SVG
  svg_region: { rectViewBox: rect, expectedViewBox: text, expectedSvgSha256: hash },

  // HTML
  html_source_range: { ...lineRange, ...snippet },

  // Markdown
  md_text_range: { ...lineRange, ...snippet },

  // Code / Text
  code_line_range: { ...lineRange, ...snippet },
  code_char_range: { ...lineRange, startCol: positive, endCol: positive, contextVersion: z.literal(2).optional(), ...snippet },

  // Diff
  diff_hunk: { filePath: text, hunkHeader: text, expectedHunkHash: hash },
  diff_line_range: { filePath: text, hunkHeader: text, ...lineRange, ...snippet },

  // Mermaid
  mermaid_source_range: { ...lineRange, ...snippet },

  // Video / Audio
  video_time_range: media,
  audio_time_range: media,

  // Lightweight Rich UI
  rich_block: { ...rich, expectedDocHash: hash },
  rich_node: { ...rich, nodeId: text, expectedNodeType: text, expectedNodeFingerprint: hash, expectedDisplayFingerprint: hash.optional() },
  rich_repeat_item: {
    ...rich,
    repeatNodeId: text,
    itemKey: id.optional(),
    itemIndex: index,
    expectedItemHash: hash,
    expectedListOrderHash: hash,
    expectedDisplayFingerprint: hash.optional(),
  },
  rich_chart_series: {
    ...rich,
    chartNodeId: text,
    seriesKey: text,
    dataIndex: index.optional(),
    expectedSeriesFingerprint: hash,
    expectedDisplayFingerprint: hash.optional(),
  },
  rich_table_cell: {
    ...rich,
    tableNodeId: text,
    ...cell,
    col: text,
    expectedRowKey: id.optional(),
    expectedRowHash: hash.optional(),
    expectedRowOrderHash: hash.optional(),
    expectedDisplayFingerprint: hash.optional(),
  },
} satisfies Record<TargetSelectorKind, z.ZodRawShape>;

const schemas = new Map(Object.entries(fields).map(([kind, shape]) =>
  [kind, z.object({ ...shape, kind: z.literal(kind), baseRevision: revision }).strict()]));

export const targetSelectorSchema = z.custom<TargetSelector>((value: unknown) => {
  if (!value || typeof value !== 'object' || !('kind' in value) || typeof value.kind !== 'string') return false;
  const selector = value as TargetSelector;
  if (!schemas.get(selector.kind)?.safeParse(selector).success) return false;
  const pairs = [
    ['startLine', 'endLine'], ['startRow', 'endRow'], ['startCol', 'endCol'], ['start', 'end'],
    ['startSec', 'endSec'],
  ] as const;
  for (const [start, end] of pairs) {
    if (start === 'startCol' && selector.kind === 'code_char_range' && selector.startLine !== selector.endLine) continue;
    const from = selector[start];
    const to = selector[end];
    if (typeof from === 'number' && typeof to === 'number' &&
        (from > to || (start === 'startSec' && from === to))) return false;
  }
  if (selector.kind === 'docx_paragraph' && selector.paraId === undefined &&
      (selector.blockIndex === undefined || !selector.contextBeforeHash || !selector.contextAfterHash)) return false;
  if (selector.kind === 'audio_time_range' || selector.kind === 'video_time_range') {
    if (Number(selector.endSec) > Number(selector.expectedDurationSec)) return false;
  }
  if (selector.kind === 'image_rect') {
    const { xNorm, yNorm, wNorm, hNorm } = z.object({ xNorm: norm, yNorm: norm, wNorm: norm, hNorm: norm }).parse(selector);
    if (xNorm + wNorm > 1 || yNorm + hNorm > 1) return false;
  }
  return true;
}, 'Invalid TargetSelector');

export function selectorIsAvailable(selector: TargetSelector): boolean {
  return selectorKindIsAvailable(selector.kind);
}

export function selectorIsDeprecated(selector: TargetSelector): boolean {
  return isDeprecatedSelectorKind(selector.kind);
}

export function selectorMatchesFormat(selector: TargetSelector, format: string, previewKind?: string): boolean {
  return selectorMatchesRegisteredFormat(selector.kind, format, previewKind);
}

export function selectorsForFormat(format: string, filename: string, previewKind: string): TargetSelectorKind[] {
  return getRegisteredSelectorsForFormat(format, { filename, previewKind }).map((entry) => entry.kind);
}

export function selectorHasDirectUi(kind: string): boolean {
  return selectorHasRegisteredUi(kind);
}

export function selectorKindIsAvailable(kind: string): boolean {
  return isRegisteredSelectorKind(kind);
}
