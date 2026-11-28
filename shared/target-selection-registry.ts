/**
 * Canonical Target Selection Registry (Design Doc §5.2).
 *
 * Single source of truth consumed by:
 * - Frontend UI (`web/src/components/shared-ui/pin/`, `ArtifactWorkspace`)
 * - REST API & `EditRequestService`
 * - Builtin MCP (`artifact_capabilities`, `rich_capabilities`, `edit_request_*`)
 * - Format adapters & `target-selector-schema.ts`
 *
 * Any selector kind outside `TARGET_SELECTOR_REGISTRY` is rejected for new
 * target creation and excluded from capability advertisements. Saved edit
 * requests referencing deprecated kinds remain readable in history and prompt
 * the user to re-select with a registered method.
 */

export type PinSelectionPrimitive =
  | 'whole'
  | 'point'
  | 'rect'
  | 'text_range'
  | 'element'
  | 'grid'
  | 'time_range';

export type TargetSelectionFormat =
  | 'pptx'
  | 'docx'
  | 'xlsx'
  | 'csv'
  | 'pdf'
  | 'image'
  | 'svg'
  | 'html'
  | 'markdown'
  | 'code'
  | 'diff'
  | 'mermaid'
  | 'media'
  | 'rich_block';

export type TargetSelectorKind =
  // PPTX (slide whole, pin, rect, structural element)
  | 'pptx_slide'
  | 'pptx_element'
  | 'pptx_region'
  // DOCX (paragraph)
  | 'docx_paragraph'
  // XLSX (cell/rect range, row/col, sheet)
  | 'xlsx_range'
  | 'xlsx_row_col'
  | 'xlsx_sheet'
  // CSV/TSV (cell/rect range, row/col)
  | 'csv_range'
  | 'csv_row_col'
  // PDF (page whole, pin, rect)
  | 'pdf_page'
  | 'pdf_pin'
  | 'pdf_region'
  // Image (pin, rect)
  | 'image_pin'
  | 'image_rect'
  // SVG (rect)
  | 'svg_region'
  // HTML (source line range)
  | 'html_source_range'
  // Markdown (source line range)
  | 'md_text_range'
  // Code/Text (line range, char range)
  | 'code_line_range'
  | 'code_char_range'
  // Diff (hunk, line range)
  | 'diff_hunk'
  | 'diff_line_range'
  // Mermaid (source line range)
  | 'mermaid_source_range'
  // Video/Audio (time range)
  | 'video_time_range'
  | 'audio_time_range'
  // Lightweight Rich UI (block, node, repeat item, chart series/point, table cell)
  | 'rich_block'
  | 'rich_node'
  | 'rich_repeat_item'
  | 'rich_chart_series'
  | 'rich_table_cell';

export type TargetSelectorView =
  | 'base'
  | 'compact'
  | 'full'
  | 'reading'
  | 'editing'
  | 'source'
  | 'canvas'
  | 'grid'
  | 'player'
  | 'rich_card';

export interface TargetSelectorRegistration {
  readonly kind: TargetSelectorKind;
  readonly format: TargetSelectionFormat;
  /** Optional previewKind filter (used by media to separate video vs audio). */
  readonly previewKind?: 'video' | 'audio';
  readonly primitive: PinSelectionPrimitive;
  /** Concise user-facing label for UI mode pickers. */
  readonly label: string;
  /** Supported views / runtime profiles where this selector operates. */
  readonly supportedViews: readonly TargetSelectorView[];
  /** Whether direct interactive UI selection is wired in the current phase. */
  readonly uiAvailable: boolean;
}

export const TARGET_SELECTOR_REGISTRY: readonly TargetSelectorRegistration[] = [
  // PPTX — slide whole (+ optional pin pointPt), structural element, rect region
  {
    kind: 'pptx_slide',
    format: 'pptx',
    primitive: 'whole',
    label: 'スライド全体・ピン',
    supportedViews: ['base', 'compact', 'full', 'canvas'],
    uiAvailable: true,
  },
  {
    kind: 'pptx_region',
    format: 'pptx',
    primitive: 'rect',
    label: '矩形領域',
    supportedViews: ['base', 'compact', 'full', 'canvas'],
    uiAvailable: true,
  },
  {
    kind: 'pptx_element',
    format: 'pptx',
    primitive: 'element',
    label: '構造要素',
    supportedViews: ['base', 'compact', 'full', 'canvas'],
    uiAvailable: true,
  },

  // DOCX — paragraph
  {
    kind: 'docx_paragraph',
    format: 'docx',
    primitive: 'element',
    label: '段落',
    supportedViews: ['base', 'compact', 'full', 'reading', 'editing'],
    uiAvailable: true,
  },

  // XLSX — cell/rect range, row/col, sheet
  {
    kind: 'xlsx_range',
    format: 'xlsx',
    primitive: 'grid',
    label: 'セル範囲',
    supportedViews: ['base', 'compact', 'full', 'grid'],
    uiAvailable: true,
  },
  {
    kind: 'xlsx_row_col',
    format: 'xlsx',
    primitive: 'grid',
    label: '行・列',
    supportedViews: ['base', 'compact', 'full', 'grid'],
    uiAvailable: true,
  },
  {
    kind: 'xlsx_sheet',
    format: 'xlsx',
    primitive: 'whole',
    label: 'シート全体',
    supportedViews: ['base', 'compact', 'full', 'grid'],
    uiAvailable: true,
  },

  // CSV/TSV — cell/rect range, row/col
  {
    kind: 'csv_range',
    format: 'csv',
    primitive: 'grid',
    label: 'セル範囲',
    supportedViews: ['base', 'compact', 'full', 'grid'],
    uiAvailable: true,
  },
  {
    kind: 'csv_row_col',
    format: 'csv',
    primitive: 'grid',
    label: '行・列',
    supportedViews: ['base', 'compact', 'full', 'grid'],
    uiAvailable: true,
  },

  // PDF — page whole, pin, rect
  {
    kind: 'pdf_page',
    format: 'pdf',
    primitive: 'whole',
    label: 'ページ全体',
    supportedViews: ['base', 'compact', 'full', 'canvas'],
    uiAvailable: true,
  },
  {
    kind: 'pdf_pin',
    format: 'pdf',
    primitive: 'point',
    label: 'ピン',
    supportedViews: ['base', 'compact', 'full', 'canvas'],
    uiAvailable: true,
  },
  {
    kind: 'pdf_region',
    format: 'pdf',
    primitive: 'rect',
    label: '矩形領域',
    supportedViews: ['base', 'compact', 'full', 'canvas'],
    uiAvailable: true,
  },

  // Image — pin, rect (PR3B UI rollout)
  {
    kind: 'image_pin',
    format: 'image',
    primitive: 'point',
    label: 'ピン',
    supportedViews: ['base', 'compact', 'full', 'canvas'],
    uiAvailable: false,
  },
  {
    kind: 'image_rect',
    format: 'image',
    primitive: 'rect',
    label: '矩形領域',
    supportedViews: ['base', 'compact', 'full', 'canvas'],
    uiAvailable: false,
  },

  // SVG — rect (PR3B UI rollout)
  {
    kind: 'svg_region',
    format: 'svg',
    primitive: 'rect',
    label: '矩形領域',
    supportedViews: ['base', 'compact', 'full', 'canvas'],
    uiAvailable: false,
  },

  // HTML — source line range (PR3B UI rollout)
  {
    kind: 'html_source_range',
    format: 'html',
    primitive: 'text_range',
    label: 'ソース行範囲',
    supportedViews: ['base', 'compact', 'full', 'source'],
    uiAvailable: false,
  },

  // Markdown — source line range
  {
    kind: 'md_text_range',
    format: 'markdown',
    primitive: 'text_range',
    label: 'ソース行範囲',
    supportedViews: ['base', 'compact', 'full', 'source'],
    uiAvailable: true,
  },

  // Code/Text — line range, char range
  {
    kind: 'code_line_range',
    format: 'code',
    primitive: 'text_range',
    label: '行範囲',
    supportedViews: ['base', 'compact', 'full', 'source'],
    uiAvailable: true,
  },
  {
    kind: 'code_char_range',
    format: 'code',
    primitive: 'text_range',
    label: '文字範囲',
    supportedViews: ['base', 'compact', 'full', 'source'],
    uiAvailable: true,
  },

  // Diff — hunk, line range (PR3B UI rollout)
  {
    kind: 'diff_hunk',
    format: 'diff',
    primitive: 'element',
    label: 'ハンク',
    supportedViews: ['base', 'compact', 'full', 'source'],
    uiAvailable: false,
  },
  {
    kind: 'diff_line_range',
    format: 'diff',
    primitive: 'text_range',
    label: '行範囲',
    supportedViews: ['base', 'compact', 'full', 'source'],
    uiAvailable: false,
  },

  // Mermaid — source line range (PR3B UI rollout)
  {
    kind: 'mermaid_source_range',
    format: 'mermaid',
    primitive: 'text_range',
    label: 'ソース行範囲',
    supportedViews: ['base', 'compact', 'full', 'source'],
    uiAvailable: false,
  },

  // Video / Audio — time range (PR3B UI rollout)
  {
    kind: 'video_time_range',
    format: 'media',
    previewKind: 'video',
    primitive: 'time_range',
    label: '時間区間',
    supportedViews: ['base', 'compact', 'full', 'player'],
    uiAvailable: false,
  },
  {
    kind: 'audio_time_range',
    format: 'media',
    previewKind: 'audio',
    primitive: 'time_range',
    label: '時間区間',
    supportedViews: ['base', 'compact', 'full', 'player'],
    uiAvailable: false,
  },

  // Lightweight Rich UI — block, node, repeat item, chart series/point, table cell
  {
    kind: 'rich_block',
    format: 'rich_block',
    primitive: 'whole',
    label: 'ブロック全体',
    supportedViews: ['base', 'compact', 'full', 'rich_card'],
    uiAvailable: false,
  },
  {
    kind: 'rich_node',
    format: 'rich_block',
    primitive: 'element',
    label: '表示要素',
    supportedViews: ['base', 'compact', 'full', 'rich_card'],
    uiAvailable: false,
  },
  {
    kind: 'rich_repeat_item',
    format: 'rich_block',
    primitive: 'element',
    label: '繰り返し項目',
    supportedViews: ['base', 'compact', 'full', 'rich_card'],
    uiAvailable: false,
  },
  {
    kind: 'rich_chart_series',
    format: 'rich_block',
    primitive: 'element',
    label: 'グラフ系列・データ点',
    supportedViews: ['base', 'compact', 'full', 'rich_card'],
    uiAvailable: false,
  },
  {
    kind: 'rich_table_cell',
    format: 'rich_block',
    primitive: 'grid',
    label: '表セル',
    supportedViews: ['base', 'compact', 'full', 'rich_card'],
    uiAvailable: false,
  },
] as const;

/**
 * Selector kinds removed in the revised §5.2 specification.
 * Kept only as an identifier set so persisted edit requests created before the
 * revision can be surfaced in history with an explicit re-selection prompt.
 */
export const DEPRECATED_SELECTOR_KINDS: ReadonlySet<string> = new Set([
  'pptx_text_range',
  'pptx_table_cell',
  'pptx_chart',
  'pptx_smartart_node',
  'pptx_notes',
  'docx_text_range',
  'docx_table_cell',
  'docx_image',
  'docx_page_setup',
  'docx_header_footer',
  'docx_page_region',
  'xlsx_chart',
  'xlsx_defined_name',
  'pdf_text_range',
  'pdf_annotation',
  'image_freeform',
  'svg_element',
  'html_dom_element',
  'html_text_range',
  'html_viewport_region',
  'md_heading',
  'md_block',
  'md_code_block',
  'md_table',
  'code_symbol',
  'mermaid_node',
  'mermaid_edge',
  'mermaid_group',
  'video_frame_region',
  'rich_svg_element',
]);

const REGISTRY_BY_KIND = new Map<string, TargetSelectorRegistration>(
  TARGET_SELECTOR_REGISTRY.map((entry) => [entry.kind, entry]),
);

export function isRegisteredSelectorKind(kind: string): kind is TargetSelectorKind {
  return REGISTRY_BY_KIND.has(kind);
}

export function isDeprecatedSelectorKind(kind: string): boolean {
  return DEPRECATED_SELECTOR_KINDS.has(kind);
}

export function getSelectorRegistration(kind: string): TargetSelectorRegistration | undefined {
  return REGISTRY_BY_KIND.get(kind);
}

/**
 * Returns the registered target selectors for a given format, honoring container
 * constraints (e.g. legacy `.ppt`/`.doc`/`.xls` files are not OOXML-resolvable,
 * and media files match only their `video` or `audio` previewKind).
 */
export function getRegisteredSelectorsForFormat(
  format: string,
  options?: { filename?: string; previewKind?: string },
): TargetSelectorRegistration[] {
  if (format === 'binary') return [];
  const filename = options?.filename?.toLowerCase();
  if (filename && (format === 'pptx' || format === 'docx' || format === 'xlsx') && !filename.endsWith('.' + format)) {
    return [];
  }
  const previewKind = options?.previewKind;
  return TARGET_SELECTOR_REGISTRY.filter((entry) => {
    if (entry.format !== format) return false;
    if (entry.previewKind && previewKind && entry.previewKind !== previewKind) return false;
    if (format === 'media' && previewKind !== undefined && previewKind !== 'video' && previewKind !== 'audio') {
      return false;
    }
    return true;
  });
}

export function selectorMatchesRegisteredFormat(kind: string, format: string, previewKind?: string): boolean {
  const entry = REGISTRY_BY_KIND.get(kind);
  if (!entry || entry.format !== format) return false;
  if (entry.previewKind && previewKind && entry.previewKind !== previewKind) return false;
  return true;
}

export function selectorHasRegisteredUi(kind: string): boolean {
  return REGISTRY_BY_KIND.get(kind)?.uiAvailable ?? false;
}
