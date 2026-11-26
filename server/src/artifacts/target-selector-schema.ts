import { z } from 'zod';
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
const rectNorm = z.tuple([norm, norm, norm.positive(), norm.positive()])
  .refine(([x, y, w, h]) => x + w <= 1 && y + h <= 1);
const point = z.tuple([norm, norm]);
const lineRange = { startLine: positive, endLine: positive };
const chars = { charStart: index, charEnd: positive };
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
  pptx_slide: { ...slide, expectedSlideHash: hash },
  pptx_element: { ...shape, groupPath: z.array(id).optional(), expectedElementFingerprint: hash },
  pptx_text_range: { ...shape, ...chars, ...context, expectedTextHash: hash },
  pptx_table_cell: { ...shape, ...cell },
  pptx_chart: { ...shape, chartRelId: text, expectedChartFingerprint: hash },
  pptx_smartart_node: { ...shape, nodeModelId: text, expectedNodeFingerprint: hash },
  pptx_notes: { ...slide, expectedNotesHash: hash },
  pptx_region: { ...slide, rectPt: rect, expectedSlideRenderHash: hash },
  docx_paragraph: { paraId: text.optional(), blockIndex: index.optional(), expectedBlockHash: hash,
    contextBeforeHash: hash.optional(), contextAfterHash: hash.optional(), ...duplicateInfo },
  docx_text_range: { paraId: text.optional(), expectedBlockHash: hash, ...chars, ...snippet },
  docx_table_cell: { tableId: id, ...cell, expectedTableFingerprint: hash },
  docx_image: { relId: text, paraId: text.optional(), expectedImageSha256: hash },
  docx_page_setup: { sectionIndex: index, expectedSetupHash: hash },
  docx_header_footer: { sectionIndex: index, headerFooterKind: z.enum(['header', 'footer']), expectedHash: hash },
  docx_page_region: { ...page, expectedRegionDigest: hash, rectPt: rect },
  xlsx_range: { ...sheet, rangeA1: text, expectedRangeValuesHash: hash, expectedOrderKeysHash: hash.optional() },
  xlsx_row_col: { ...sheet, ...slice, expectedRangeValuesHash: hash },
  xlsx_sheet: { ...sheet, expectedSheetContentHash: hash },
  xlsx_chart: { sheetId: id, chartRelId: text, expectedChartFingerprint: hash },
  xlsx_defined_name: { name: text, expectedFormulaHash: hash },
  csv_range: { startRow: index, endRow: index, startCol: index, endCol: index,
    expectedRowCount: positive, expectedColCount: positive, expectedRangeValuesHash: hash, expectedHeaderHash: hash },
  csv_row_col: { ...slice, expectedRowCount: positive, expectedColCount: positive, expectedRangeValuesHash: hash },
  pdf_page: page,
  pdf_text_range: { ...page, ...snippet, textOffsetStart: index, textOffsetEnd: positive,
    quadsPt: z.array(z.tuple([num, num, num, num, num, num, num, num])).min(1) },
  pdf_pin: { ...page, expectedRegionDigest: hash, xPt: nonnegative, yPt: nonnegative },
  pdf_region: { ...page, expectedRegionDigest: hash, rectPt: rect },
  pdf_annotation: { ...page, annotUid: text, expectedAnnotFingerprint: hash },
  image_pin: { ...image, xNorm: norm, yNorm: norm },
  image_rect: { ...image, xNorm: norm, yNorm: norm, wNorm: norm.positive(), hNorm: norm.positive() },
  image_freeform: { ...image, pointsNorm: z.array(point).min(3).max(10_000) },
  svg_element: { elementId: text.optional(), structuralPath: z.array(index).min(1).optional(), expectedTag: text, expectedElementFingerprint: hash },
  svg_region: { rectViewBox: rect, expectedViewBox: text, expectedSvgSha256: hash },
  html_dom_element: { cssSelector: text, expectedTag: text, expectedElementFingerprint: hash, matchCountInDoc: z.literal(1) },
  html_text_range: { cssSelector: text, ...chars, ...snippet },
  html_viewport_region: { viewportW: positive, viewportH: positive, rectNorm, expectedDocSha256: hash },
  html_source_range: { ...lineRange, ...snippet },
  md_heading: { headingSlug: text, headingLevel: positive.max(6), expectedHeadingHash: hash, occurrenceIndex: index },
  md_block: { blockIndex: index, blockKind: text, ...lineRange, expectedBlockHash: hash, ...context },
  md_text_range: { ...lineRange, ...snippet },
  md_code_block: { fenceIndex: index, lang: text.optional(), ...lineRange, expectedCodeHash: hash, contextBeforeHash: hash },
  md_table: { tableIndex: index, row: index.optional(), col: index.optional(), expectedCellHash: hash, expectedTableHash: hash },
  code_line_range: { ...lineRange, ...snippet },
  code_char_range: { ...lineRange, startCol: positive, endCol: positive, ...snippet },
  code_symbol: { symbolKind: text, symbolName: text, ...lineRange, expectedSignatureHash: hash, expectedBodyHash: hash },
  diff_hunk: { filePath: text, hunkHeader: text, expectedHunkHash: hash },
  diff_line_range: { filePath: text, hunkHeader: text, ...lineRange, ...snippet },
  mermaid_node: { nodeId: text, expectedNodeKind: text, expectedLabelHash: hash },
  mermaid_edge: { fromId: text, toId: text, edgeIndex: index, expectedEdgeFingerprint: hash },
  mermaid_group: { groupId: text, expectedGroupFingerprint: hash },
  mermaid_source_range: { ...lineRange, ...snippet },
  video_time_range: media,
  video_frame_region: { timestampSec: nonnegative, rectNorm, expectedDurationSec: num.positive(),
    expectedWidthPx: positive, expectedHeightPx: positive, expectedFrameSha256: hash },
  audio_time_range: media,
  rich_block: { ...rich, expectedDocHash: hash },
  rich_node: { ...rich, nodeId: text, expectedNodeType: text, expectedNodeFingerprint: hash },
  rich_repeat_item: { ...rich, repeatNodeId: text, itemKey: id.optional(), itemIndex: index, expectedItemHash: hash, expectedListOrderHash: hash },
  rich_svg_element: { ...rich, svgNodeId: text, elementId: text.optional(), expectedTag: text, expectedElementFingerprint: hash },
  rich_chart_series: { ...rich, chartNodeId: text, seriesKey: text, dataIndex: index.optional(), expectedSeriesFingerprint: hash },
  rich_table_cell: { ...rich, tableNodeId: text, ...cell, col: text, expectedRowKey: id.optional() },
} satisfies Record<string, z.ZodRawShape>;

const schemas = new Map(Object.entries(fields).map(([kind, shape]) =>
  [kind, z.object({ ...shape, kind: z.literal(kind), baseRevision: revision }).strict()]));

export const targetSelectorSchema = z.custom<TargetSelector>((value: unknown) => {
  if (!value || typeof value !== 'object' || !('kind' in value) || typeof value.kind !== 'string') return false;
  const selector = value as TargetSelector;
  if (!schemas.get(selector.kind)?.safeParse(selector).success) return false;
  const pairs = [
    ['startLine', 'endLine'], ['startRow', 'endRow'], ['startCol', 'endCol'], ['start', 'end'],
    ['charStart', 'charEnd'], ['textOffsetStart', 'textOffsetEnd'], ['startSec', 'endSec'],
  ] as const;
  for (const [start, end] of pairs) {
    if (start === 'startCol' && selector.kind === 'code_char_range' && selector.startLine !== selector.endLine) continue;
    const from = selector[start];
    const to = selector[end];
    if (typeof from === 'number' && typeof to === 'number' &&
        (from > to || (['charStart', 'textOffsetStart', 'startSec'].includes(start) && from === to))) return false;
  }
  if (selector.kind === 'docx_paragraph' && selector.paraId === undefined &&
      (selector.blockIndex === undefined || !selector.contextBeforeHash || !selector.contextAfterHash)) return false;
  if (selector.kind === 'svg_element' && selector.elementId === undefined && selector.structuralPath === undefined) return false;
  if (selector.kind === 'audio_time_range' || selector.kind === 'video_time_range') {
    if (Number(selector.endSec) > Number(selector.expectedDurationSec)) return false;
  }
  if (selector.kind === 'video_frame_region' && Number(selector.timestampSec) > Number(selector.expectedDurationSec)) return false;
  if (selector.kind === 'image_rect') {
    const { xNorm, yNorm, wNorm, hNorm } = z.object({xNorm:norm,yNorm:norm,wNorm:norm,hNorm:norm}).parse(selector);
    if (xNorm + wNorm > 1 || yNorm + hNorm > 1) return false;
  }
  return true;
}, 'Invalid TargetSelector');

export function selectorMatchesFormat(selector: TargetSelector, format: string): boolean {
  const prefix = selector.kind.split('_')[0];
  if (format === 'markdown') return prefix === 'md';
  if (format === 'media') return prefix === 'audio' || prefix === 'video';
  if (format === 'rich_block') return prefix === 'rich';
  return prefix === format;
}
