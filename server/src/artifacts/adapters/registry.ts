import path from 'node:path';
import type { PreviewKind } from '../../types.js';
import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterOperation,
  AdapterVerifyResult,
  ArtifactCapabilitiesResponse,
  ArtifactFormat,
  OperationCapability,
  RuntimeProfile,
  SandboxIsolationKind,
  StagingIsolationKind,
  TargetResolutionResult,
  TargetSelector,
} from '../types.js';
import { isSha256, sha256Buffer, type AdapterCapabilityContext, type AdapterFileMeta, type FormatAdapter } from './base.js';
import { BinaryAdapter } from './binary-adapter.js';
import { CodeAdapter } from './code-adapter.js';
import { CsvAdapter } from './csv-adapter.js';
import { DiffAdapter } from './diff-adapter.js';
import { HtmlAdapter } from './html-adapter.js';
import { MarkdownAdapter } from './markdown-adapter.js';
import { MermaidAdapter } from './mermaid-adapter.js';
import { SvgAdapter } from './svg-adapter.js';
import {
  readDocxAllParagraphTargets,
  readDocxParagraphTarget,
  readPptxSlideTargets,
  readPptxTargets,
  readXlsxRangeTarget,
  readXlsxRowColTarget,
  readXlsxSheetTarget,
  readXlsxWorkbookTargets,
} from './ooxml-target.js';
import { computePdfRegionDigest, inspectPdfDocument, readPdfPageTarget } from './pdf-target.js';

const CHART_EDITS = ['chart.create', 'chart.update_title_and_legend', 'chart.update_series_data', 'chart.update_series_style', 'chart.add_or_remove_series'];

export const DOCUMENT_ACTIONS = {
  pptx: ['create', 'structure', 'read_range', 'verify', 'render_png', 'export:pdf', 'export:png',
    'pptx.set_shape_text', 'pptx.move_shape', 'pptx.set_shape_style', 'pptx.set_shape_bounds', 'pptx.add_shape', 'pptx.remove_shape', 'pptx.add_image',
    'pptx.add_table', 'pptx.set_table_cell', 'pptx.group_shapes', 'pptx.ungroup_shapes', 'pptx.add_slide', 'pptx.reorder_slide',
    'pptx.remove_slide', 'pptx.set_notes', 'pptx.smartart.get_structure', 'pptx.smartart.update_node_text', 'pptx.smartart.add_or_remove_node', ...CHART_EDITS],
  docx: ['create', 'structure', 'read_range', 'verify', 'render_png', 'export:pdf', 'export:md', 'export:html',
    'docx.set_paragraph_text', 'docx.set_page_size', 'docx.set_page_layout', 'docx.add_paragraph', 'docx.remove_paragraph',
    'docx.set_paragraph_style', 'docx.set_run_style', 'docx.set_list', 'docx.add_table', 'docx.set_table_cell', 'docx.add_image',
    'docx.patch_xml_text', 'docx.add_header_footer', 'docx.edit_header_footer', 'docx.add_footnote', 'docx.edit_footnote'],
  xlsx: ['create', 'structure', 'read_range', 'verify', 'render_png', 'export:pdf', 'export:png', 'export:csv', 'xlsx.set_cell', 'xlsx.set_cell_style', 'xlsx.set_formula', 'xlsx.mutate_rows', 'xlsx.mutate_columns',
    'xlsx.set_merge', 'xlsx.add_conditional_format', 'xlsx.set_data_validation', 'xlsx.set_auto_filter',
    'xlsx.add_sheet', 'xlsx.duplicate_sheet', 'xlsx.reorder_sheet', 'xlsx.rename_sheet', 'xlsx.remove_sheet', 'xlsx.remove_empty_sheet', 'xlsx.set_sheet_visibility', 'xlsx.set_defined_name', 'xlsx.set_page_setup',
    'xlsx.set_column_width', 'xlsx.set_row_height', 'xlsx.set_freeze_panes', ...CHART_EDITS],
  pdf: ['create', 'structure', 'read_range', 'verify', 'render_png', 'export:png', 'export:txt',
    'pdf.rotate_page', 'pdf.reorder_pages', 'pdf.remove_page', 'pdf.add_note', 'pdf.add_overlay'],
  image: ['create', 'structure', 'verify', 'render_png', 'export:png', 'export:jpg', 'export:jpeg', 'export:webp',
    'image.crop', 'image.resize', 'image.rotate', 'image.brightness', 'image.annotate', 'image.composite'],
  media: ['structure', 'verify', 'render_png', 'media.trim'],
} satisfies Partial<Record<ArtifactFormat, string[]>>;

// Operations exposed to the direct editor through the REST gateway.
const DIRECT_EDITOR_OPERATIONS = new Set([
  'pptx.set_shape_text', 'pptx.move_shape', 'pptx.set_shape_style', 'pptx.set_shape_bounds', 'pptx.add_shape', 'pptx.remove_shape', 'pptx.add_image',
  'pptx.add_table', 'pptx.set_table_cell', 'pptx.add_slide', 'pptx.reorder_slide', 'pptx.remove_slide',
  'docx.set_paragraph_text', 'docx.add_paragraph', 'docx.remove_paragraph', 'docx.set_paragraph_style', 'docx.set_run_style', 'docx.set_list',
  'docx.add_table', 'docx.set_table_cell', 'docx.add_image',
  'xlsx.set_cell', 'xlsx.set_cell_style', 'xlsx.set_formula', 'xlsx.mutate_rows', 'xlsx.mutate_columns',
  'xlsx.add_sheet', 'xlsx.duplicate_sheet', 'xlsx.reorder_sheet', 'xlsx.rename_sheet', 'xlsx.remove_sheet', 'xlsx.remove_empty_sheet',
  'xlsx.set_sheet_visibility', 'xlsx.set_column_width', 'xlsx.set_row_height', 'xlsx.set_freeze_panes',
  'image.crop', 'image.rotate', 'image.resize', 'image.annotate', 'media.trim',
]);

// Operations with genuine structural/sub-type constraints per format specification.
const LIMITED_OPERATIONS: Record<string, string> = {
  'pptx.add_image': 'PNG または JPEG。',
  'pptx.smartart.update_node_text': 'データモデルと描画キャッシュが対応付けできる既存ノードラベル。',
  'pptx.smartart.add_or_remove_node': 'LibreOffice の layoutDef 再計算と描画キャッシュ同期により、線形リスト・線形プロセス・Venn・循環・ピラミッド・マトリクス・階層図等の主要図種に対応（layoutDef の chMax 上限や LibreOffice 非対応レイアウトは unsupported_by_format を返却）。',
  'docx.set_paragraph_text': '複数ラン・書式指定に対応。フィールド・図形・ハイパーリンク・脚注参照等の保護ノードを含む段落は破壊的上書きを拒否。',
  'docx.add_image': 'PNG または JPEG。',
  'xlsx.mutate_rows': 'ブック横断参照を書き換え。ピボット・構造化テーブル・配列数式交差時は 422 で保護拒否。',
  'xlsx.mutate_columns': 'ブック横断参照を書き換え。ピボット・構造化テーブル・配列数式交差時は 422 で保護拒否。',
  'xlsx.rename_sheet': 'ブック横断参照を書き換え。動的参照や保護された構造への安全でない変更を拒否。',
  'xlsx.remove_sheet': '他シート参照や図形・テーブル依存がないシートを削除（最低 1 枚の可視シートを保持）。',
  'xlsx.remove_empty_sheet': '参照と内容を持たない空のワークシートを削除。',
  'media.trim': '一度の操作で一つの連続区間を抽出。',
  'image.rotate': '90 度単位の回転に対応。',
  'chart.create': '棒・縦棒・折線・円・ドーナツ・面・散布・複合/第 2 軸に対応（3D 特殊曲面・ピボットグラフ等は非対応）。',
  'chart.update_title_and_legend': '対応グラフ種別でタイトル・凡例を更新。',
  'chart.update_series_data': 'ローカル範囲または埋め込み XLSX とキャッシュを同時同期。',
  'chart.update_series_style': '対応グラフ種別の系列スタイルを更新。',
  'chart.add_or_remove_series': '対応グラフ種別の系列を追加・削除。',
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isAnimatedImage(content: Buffer): boolean {
  if (content.length >= 13) {
    const header = content.toString('ascii', 0, 6);
    if (header === 'GIF87a' || header === 'GIF89a') {
      const packed = content[10];
      let pos = 13 + ((packed & 0x80) !== 0 ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
      let frames = 0;
      while (pos < content.length) {
        const introducer = content[pos++];
        if (introducer === 0x3b) break;
        if (introducer === 0x2c) {
          if (++frames >= 2) return true;
          if (pos + 9 > content.length) break;
          const imgPacked = content[pos + 8];
          pos += 9 + ((imgPacked & 0x80) !== 0 ? 3 * (1 << ((imgPacked & 0x07) + 1)) : 0);
          if (pos >= content.length) break;
          pos += 1; // LZW minimum code size
          while (pos < content.length) {
            const subLen = content[pos++];
            if (subLen === 0) break;
            pos += subLen;
          }
        } else if (introducer === 0x21) {
          if (pos >= content.length) break;
          pos += 1; // extension label
          while (pos < content.length) {
            const subLen = content[pos++];
            if (subLen === 0) break;
            pos += subLen;
          }
        } else {
          break;
        }
      }
      return false;
    }
  }
  if (content.length >= 24 && content.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let pos = 8;
    while (pos + 12 <= content.length) {
      const length = content.readUInt32BE(pos);
      const type = content.toString('ascii', pos + 4, pos + 8);
      if (type === 'IDAT' || type === 'IEND') break;
      if (type === 'acTL' && length >= 4 && pos + 12 <= content.length) {
        return content.readUInt32BE(pos + 8) > 1;
      }
      pos += 12 + length;
    }
    return false;
  }
  if (
    content.length >= 30 &&
    content.toString('ascii', 0, 4) === 'RIFF' &&
    content.toString('ascii', 8, 12) === 'WEBP' &&
    content.toString('ascii', 12, 16) === 'VP8X'
  ) {
    return (content[20] & 0x02) !== 0;
  }
  return false;
}

export function documentFormatConstraint(
  format: ArtifactFormat,
  filename: string,
  operation: string,
  previewKind?: PreviewKind,
  content?: Buffer
): string | undefined {
  const extension = path.extname(filename).toLowerCase();
  if (format === 'xlsx' && extension === '.xls' && operation !== 'structure') {
    return '編集ワーカーは OOXML の XLSX に対応します。';
  }
  if (format === 'pptx' && ['.ppt', '.odp'].includes(extension) && operation !== 'structure') {
    return '編集ワーカーは OOXML の PPTX に対応します。';
  }
  if (format === 'docx' && extension === '.doc' && operation !== 'structure') {
    return '編集ワーカーは OOXML の DOCX に対応します。';
  }
  if (format === 'media' && extension && !['.mp4', '.webm', '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.mov', '.mkv'].includes(extension) &&
      operation !== 'structure') {
    return 'このメディアコンテナは外部ワーカーの処理対象外です。';
  }
  if (format === 'media' && previewKind === 'audio' && ['render', 'render_png'].includes(operation)) {
    return '音声のみのファイルに映像フレームはありません。';
  }
  if (format === 'image' && operation === 'create' && extension && !['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    return '画像の新規作成は PNG、JPEG、WebP に対応します。';
  }
  if (format === 'image' && content && isAnimatedImage(content) && (operation === 'input_edit' || operation.startsWith('image.'))) {
    return 'アニメーション画像（GIF / APNG / WebP）の編集は非対応です。';
  }
}

class DocumentFormatAdapter implements FormatAdapter {
  readonly requiresExternalWorker = true;
  readonly targetPinSupported = true;

  constructor(
    public readonly format: 'pptx' | 'docx' | 'xlsx' | 'pdf' | 'image' | 'media',
    public readonly previewKind: PreviewKind,
    public readonly directEditUiSupported: boolean
  ) {}

  getOperations(ctx: AdapterCapabilityContext): OperationCapability[] {
    const workerReady = ctx.runtimeProfile !== 'base_chatui' && ctx.sandboxAvailable;
    const metadataOnly = Boolean(documentFormatConstraint(this.format, ctx.filename ?? '', 'input', ctx.previewKind, ctx.content));
    const operations: OperationCapability[] = [
      { operation: 'view', availability: 'supported', scope: 'ui_view_only' },
      { operation: 'target_pin', availability: 'supported', scope: 'mcp_and_ui' },
      ...DOCUMENT_ACTIONS[this.format].map((operation): OperationCapability => {
        const scope = DIRECT_EDITOR_OPERATIONS.has(operation) || operation === 'structure' || operation === 'read_range'
          ? 'mcp_and_ui' : 'mcp_only';
        const constraint = documentFormatConstraint(this.format, ctx.filename ?? '', operation, ctx.previewKind, ctx.content);
        if (constraint) return { operation, availability: 'unsupported_by_format', scope, notes: constraint };
        const notes = LIMITED_OPERATIONS[operation];
        if (!workerReady || metadataOnly) {
          if (operation === 'structure' || operation === 'verify' ||
              (operation === 'render_png' && this.format === 'image' && /\.png$/i.test(ctx.filename ?? ''))) {
            return { operation, availability: 'partial', scope, notes: operation === 'render_png'
              ? '既存の PNG を取得できます。' : operation === 'structure' && this.format === 'pptx'
                ? 'スライドの構造と編集依頼の対象を取得できます。' : 'ファイルのメタデータのみ。' };
          }
          return {
            operation, availability: 'disabled_by_resource_tier', scope, notes,
            remediation: ctx.runtimeProfile === 'base_chatui' ? 'deploy/setup-doc-runtime.sh を実行してください。'
              : 'bubblewrap サンドボックスを有効化してください。',
          };
        }
        return { operation, availability: notes ? 'partial' : 'supported', scope, notes };
      }),
    ];
    if (this.format === 'pdf') operations.push({
      operation: 'edit_body_reflow', availability: 'unsupported_by_format', scope: 'mcp_only',
      notes: 'PDF の既存本文削除・リフロー編集は形式方針により非対応です。注釈および新規オーバーレイを追加できます。',
    });
    if (this.format === 'media') operations.push({
      operation: 'create', availability: 'unsupported_by_format', scope: 'mcp_only',
      notes: '動画・音声の新規作成は非対応です。',
    });
    return operations;
  }

  getStructure(buffer: Buffer, meta: AdapterFileMeta): Record<string, unknown> {
    if (this.format === 'pptx' && /\.pptx$/i.test(meta.filename)) return readPptxTargets(buffer);
    return {
      format: this.format,
      filename: meta.filename,
      sizeBytes: buffer.length,
      sha256: sha256Buffer(buffer),
    };
  }

  readRange(buffer: Buffer, range: Record<string, unknown>, _meta: AdapterFileMeta): Record<string, unknown> {
    const isTargetMeta = range.targetMetadata === true || range.targetMetadata === 'true';
    if (this.format === 'pptx' && isTargetMeta && typeof range.part === 'string') {
      return readPptxSlideTargets(buffer, range.part);
    }
    if (this.format === 'docx' && range.targetBlockIndex !== undefined) {
      const index = Number(range.targetBlockIndex);
      return { target: Number.isSafeInteger(index) && index >= 0 ? readDocxParagraphTarget(buffer, index) : null };
    }
    if (this.format === 'xlsx' && isTargetMeta && typeof range.rangeA1 === 'string') {
      const sheetSel = String(range.sheetId ?? range.sheetName ?? range.sheetPart ?? '');
      const target = readXlsxRangeTarget(buffer, sheetSel, range.rangeA1);
      return { target };
    }
    if (this.format === 'pdf' && isTargetMeta && range.pageIndex !== undefined) {
      const pageIndex = Number(range.pageIndex);
      let rectPt: [number, number, number, number] | undefined;
      if (range.rectPt !== undefined) {
        let parsed: unknown = range.rectPt;
        try {
          if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        } catch {
          parsed = undefined;
        }
        if (!Array.isArray(parsed) || parsed.length !== 4 ||
            !parsed.every((n) => typeof n === 'number' && Number.isFinite(n))) {
          throw new ArtifactError('INVALID_INPUT', 'PDF の領域は 4 個の有限な座標で指定してください。', 400);
        }
        rectPt = [parsed[0], parsed[1], parsed[2], parsed[3]];
      } else if (range.xPt !== undefined && range.yPt !== undefined) {
        const x = Number(range.xPt), y = Number(range.yPt);
        if (Number.isFinite(x) && Number.isFinite(y)) rectPt = [x, y, 0, 0];
      }
      const target = Number.isInteger(pageIndex) && pageIndex >= 0 ? readPdfPageTarget(buffer, pageIndex, rectPt) : null;
      return { target };
    }
    throw unsupportedOperationError(
      'read_range',
      'disabled_by_resource_tier',
      `Structured range reading for '${this.format}' requires the document worker runtime.`
    );
  }

  applyOperations(_buffer: Buffer, operations: AdapterOperation[], _meta: AdapterFileMeta): AdapterEditResult {
    const opName = operations[0]?.op ?? 'edit';
    if (this.format === 'pdf' && [
      'delete_text', 'reflow_text', 'edit_body_reflow',
      'pdf.delete_text', 'pdf.reflow_text', 'pdf.edit_body_reflow',
    ].includes(opName)) {
      throw unsupportedOperationError(
        opName,
        'unsupported_by_format',
        'PDF existing body text deletion/reflow is not supported by format policy.'
      );
    }
    throw unsupportedOperationError(
      opName,
      'disabled_by_resource_tier',
      `Editing '${this.format}' requires the external document worker runtime.`
    );
  }

  verify(buffer: Buffer, _meta: AdapterFileMeta): AdapterVerifyResult {
    return { ok: buffer.length > 0, coverage: 'partial', issues: [],
      checks: [{ id: 'document_validation', status: 'unverified', evidence: 'Document runtime unavailable; byte metadata only.' }],
      metrics: { sizeBytes: buffer.length, sha256: sha256Buffer(buffer) } };
  }

  /**
   * Strict content-fingerprint verification for PIN-02 cases across rich formats
   * (same-dimension image replacement, same-page-count PDF page swap, same-structure XLSX value/order change,
   *  same-ID element replacement, media hash change).
   */
  resolveTarget(buffer: Buffer, selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    if (this.format === 'image') {
      const expectedSha = selector.expectedImageSha256 ? String(selector.expectedImageSha256) : null;
      if (!expectedSha || expectedSha !== sha256Buffer(buffer)) {
        return { status: 'needs_review', reason: 'image_content_changed' };
      }
      return { status: 'resolved', resolvedCoords: { selector } };
    }

    if (this.format === 'media') {
      const expectedSha = selector.expectedMediaSha256 ? String(selector.expectedMediaSha256) : null;
      if (!expectedSha || expectedSha !== sha256Buffer(buffer)) {
        return { status: 'needs_review', reason: 'media_content_changed' };
      }
      return { status: 'resolved', resolvedCoords: { selector } };
    }

    if (this.format === 'pdf') {
      const hex64 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
      const pageIndex = Number(selector.pageIndex);
      const expectedPageCount = Number(selector.expectedPageCount);
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || !Number.isInteger(expectedPageCount) || expectedPageCount <= 0) {
        return { status: 'stale', reason: 'invalid_page_selection' };
      }
      const doc = inspectPdfDocument(buffer, pageIndex);
      if (!doc) return { status: 'needs_review', reason: 'pdf_page_content_changed' };
      if (expectedPageCount !== doc.pageCount) {
        return { status: 'needs_review', reason: 'pdf_page_count_changed' };
      }
      if (pageIndex >= doc.pageCount) {
        return { status: 'stale', reason: 'invalid_page_selection' };
      }
      const page = doc.pages[0];
      if (!hex64(selector.expectedPageContentHash) || selector.expectedPageContentHash !== page.pageContentHash) {
        return { status: 'needs_review', reason: 'pdf_page_content_changed' };
      }

      if (selector.kind === 'pdf_page') {
        return {
          status: 'resolved',
          resolvedCoords: { pageIndex, widthPt: page.widthPt, heightPt: page.heightPt, rotate: page.rotate },
          resolvedSnippet: page.text,
        };
      }

      if (selector.kind === 'pdf_pin' || selector.kind === 'pdf_region') {
        const coords = selector.kind === 'pdf_pin' ? [selector.xPt, selector.yPt] : selector.rectPt;
        if (
          !hex64(selector.expectedRegionDigest) ||
          !Array.isArray(coords) ||
          coords.length !== (selector.kind === 'pdf_pin' ? 2 : 4) ||
          !coords.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        ) {
          return { status: 'stale', reason: 'invalid_page_selection' };
        }
        const rectangle: [number, number, number, number] =
          selector.kind === 'pdf_pin'
            ? [coords[0], coords[1], 0, 0]
            : [coords[0], coords[1], coords[2], coords[3]];
        if (selector.kind === 'pdf_region' && (rectangle[2] <= 0 || rectangle[3] <= 0)) {
          return { status: 'stale', reason: 'invalid_page_selection' };
        }
        if (
          rectangle[0] > page.widthPt + 2 ||
          rectangle[1] > page.heightPt + 2 ||
          rectangle[0] + rectangle[2] > page.widthPt + 4 ||
          rectangle[1] + rectangle[3] > page.heightPt + 4
        ) {
          return { status: 'needs_review', reason: 'pdf_region_out_of_bounds' };
        }
        const actualDigest = computePdfRegionDigest(page, rectangle);
        if (actualDigest !== selector.expectedRegionDigest) {
          return { status: 'needs_review', reason: 'pdf_region_digest_changed' };
        }
        return {
          status: 'resolved',
          resolvedCoords: { pageIndex, selector },
          resolvedSnippet: page.text,
        };
      }

      if (selector.kind === 'pdf_text_range') {
        const start = Number(selector.textOffsetStart);
        const end = Number(selector.textOffsetEnd);
        const expectedSnippetHash = hex64(selector.expectedSnippetHash) ? String(selector.expectedSnippetHash) : null;
        const expectedBeforeHash = hex64(selector.contextBeforeHash) ? String(selector.contextBeforeHash) : null;
        const expectedAfterHash = hex64(selector.contextAfterHash) ? String(selector.contextAfterHash) : null;
        const expectedOccurrence = selector.occurrenceIndex;
        const quads = selector.quadsPt;
        if (!Array.isArray(quads) || quads.length === 0 || !quads.every(quad =>
          Array.isArray(quad) && quad.length === 8 && quad.every(value => typeof value === 'number' && Number.isFinite(value)))) {
          return { status: 'needs_review', reason: 'invalid_pdf_text_geometry' };
        }
        if (!expectedSnippetHash || !expectedBeforeHash || !expectedAfterHash ||
            !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start < 0 || end <= start || end > page.text.length ||
            typeof expectedOccurrence !== 'number' || !Number.isSafeInteger(expectedOccurrence) || expectedOccurrence < 0) {
          return { status: 'needs_review', reason: 'pdf_text_range_changed' };
        }
        const slice = page.text.slice(start, end);
        if (sha256Buffer(Buffer.from(slice)) !== expectedSnippetHash) {
          return { status: 'needs_review', reason: 'pdf_text_range_changed' };
        }
        const contextMatches = (offset: number) => {
          const limit = offset + slice.length;
          return sha256Buffer(Buffer.from(page.text.slice(Math.max(0, offset - 64), offset))) === expectedBeforeHash &&
            sha256Buffer(Buffer.from(page.text.slice(limit, limit + 64))) === expectedAfterHash;
        };
        if (!contextMatches(start)) return { status: 'needs_review', reason: 'pdf_text_context_changed' };
        let actualOcc = -1;
        let occurrence = 0;
        for (let offset = page.text.indexOf(slice); offset !== -1; offset = page.text.indexOf(slice, offset + 1)) {
          if (offset === start) actualOcc = occurrence;
          else if (contextMatches(offset)) return { status: 'needs_review', reason: 'ambiguous_multiple_matches' };
          occurrence++;
        }
        if (actualOcc !== expectedOccurrence) return { status: 'needs_review', reason: 'pdf_text_occurrence_changed' };
        return {
          status: 'resolved',
          resolvedCoords: { pageIndex, textOffsetStart: start, textOffsetEnd: end, occurrenceIndex: actualOcc, quadsPt: quads },
          resolvedSnippet: slice,
        };
      }

      if (selector.kind === 'pdf_annotation') {
        const annotUid = typeof selector.annotUid === 'string' ? selector.annotUid : '';
        const expectedAnnotFp = typeof selector.expectedAnnotFingerprint === 'string' ? selector.expectedAnnotFingerprint : '';
        const matches = page.annotations.filter((a) => a.uid === annotUid);
        if (!matches.length) return { status: 'stale', reason: 'pdf_annotation_not_found' };
        if (matches.length !== 1 || !expectedAnnotFp || matches[0].fingerprint !== expectedAnnotFp) {
          return { status: 'needs_review', reason: 'pdf_annotation_changed' };
        }
        return { status: 'resolved', resolvedCoords: { pageIndex, annotUid }, resolvedSnippet: matches[0].contents };
      }

      return { status: 'needs_review', reason: 'unsupported_pdf_selector' };
    }

    if (this.format === 'xlsx') {
      const sheetId = typeof selector.sheetId === 'string' && selector.sheetId ? selector.sheetId : null;
      const expectedStructHash =
        typeof selector.expectedSheetStructHash === 'string' && selector.expectedSheetStructHash
          ? selector.expectedSheetStructHash
          : null;

      if (selector.kind === 'xlsx_sheet') {
        if (!sheetId || !expectedStructHash || !isSha256(selector.expectedSheetContentHash)) {
          return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
        }
        try {
          const wb = readXlsxWorkbookTargets(buffer);
          const sheetExists = wb.sheets.some((s) => s.id === sheetId || s.name === sheetId || s.part === sheetId);
          if (!sheetExists) return { status: 'stale', reason: 'sheet_not_found' };
          const target = readXlsxSheetTarget(buffer, sheetId);
          if (!target) return { status: 'stale', reason: 'sheet_not_found' };
          if (target.expectedSheetStructHash !== expectedStructHash ||
              target.expectedSheetContentHash !== selector.expectedSheetContentHash) {
            return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
          }
          return {
            status: 'resolved',
            resolvedRange: { sheetId: target.sheetId, sheetName: target.sheetName },
            resolvedSnippet: target.sheetName,
          };
        } catch {
          return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
        }
      }

      if (selector.kind === 'xlsx_row_col') {
        const axis = selector.axis === 'row' || selector.axis === 'col' ? selector.axis : null;
        const idx = Number(selector.index);
        const expectedSliceHash =
          typeof selector.expectedSliceHash === 'string' && selector.expectedSliceHash ? selector.expectedSliceHash : null;
        if (!sheetId || !axis || !Number.isInteger(idx) || idx < 0 || !expectedStructHash || !expectedSliceHash) {
          return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
        }
        try {
          const wb = readXlsxWorkbookTargets(buffer);
          const sheetExists = wb.sheets.some((s) => s.id === sheetId || s.name === sheetId || s.part === sheetId);
          if (!sheetExists) return { status: 'stale', reason: 'sheet_not_found' };
          const target = readXlsxRowColTarget(buffer, sheetId, axis, idx);
          if (!target) return { status: 'stale', reason: 'invalid_range' };
          if (target.expectedSheetStructHash !== expectedStructHash || target.expectedSliceHash !== expectedSliceHash) {
            return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
          }
          return {
            status: 'resolved',
            resolvedRange: { sheetId: target.sheetId, sheetName: target.sheetName, axis: target.axis, index: target.index },
            resolvedSnippet: target.snippet,
          };
        } catch {
          return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
        }
      }

      if (selector.kind !== 'xlsx_range') {
        return { status: 'needs_review', reason: 'unsupported_xlsx_selector' };
      }
      const rangeA1 = typeof selector.rangeA1 === 'string' && selector.rangeA1 ? selector.rangeA1 : null;
      const expectedValuesHash =
        typeof selector.expectedRangeValuesHash === 'string' && selector.expectedRangeValuesHash
          ? selector.expectedRangeValuesHash
          : null;
      const expectedOrderKeysHash =
        typeof selector.expectedOrderKeysHash === 'string' && selector.expectedOrderKeysHash
          ? selector.expectedOrderKeysHash
          : null;
      if (!sheetId || !rangeA1 || !expectedStructHash || !expectedValuesHash) {
        return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
      }
      try {
        const wb = readXlsxWorkbookTargets(buffer);
        const sheetExists = wb.sheets.some((s) => s.id === sheetId || s.name === sheetId || s.part === sheetId);
        if (!sheetExists) {
          return { status: 'stale', reason: 'sheet_not_found' };
        }
        const target = readXlsxRangeTarget(buffer, sheetId, rangeA1);
        if (!target) {
          return { status: 'stale', reason: 'invalid_range' };
        }
        if (target.expectedSheetStructHash !== expectedStructHash) {
          return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
        }
        if (target.expectedRangeValuesHash !== expectedValuesHash) {
          return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
        }
        if (expectedOrderKeysHash && target.expectedOrderKeysHash !== expectedOrderKeysHash) {
          return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
        }
        return {
          status: 'resolved',
          resolvedRange: { sheetId: target.sheetId, sheetName: target.sheetName, rangeA1: target.rangeA1 },
          resolvedSnippet: target.snippet,
        };
      } catch {
        return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
      }
    }

    if (this.format === 'pptx' && ['pptx_slide', 'pptx_element'].includes(selector.kind)) {
      try {
        const slide = readPptxTargets(buffer).slides.find(slide => slide.id === String(selector.slideId));
        if (!slide) return { status: 'stale', reason: 'slide_not_found' };
        const metadata = readPptxSlideTargets(buffer, slide.part);
        const element = selector.kind === 'pptx_element'
          ? metadata.shapes.filter(shape => shape.id === String(selector.shapeId) &&
            JSON.stringify(shape.groupPath) === JSON.stringify(selector.groupPath ?? []))
          : null;
        const fingerprint = element ? (element.length === 1 ? element[0].fingerprint : null) : metadata.slideHash;
        const expected = element ? selector.expectedElementFingerprint : selector.expectedSlideHash;
        return fingerprint && fingerprint === expected
          ? { status: 'resolved', resolvedRange: { selector } }
          : { status: 'needs_review', reason: 'element_fingerprint_changed' };
      } catch {
        return { status: 'needs_review', reason: 'target_structure_unavailable' };
      }
    }

    if (this.format === 'docx' && selector.kind === 'docx_paragraph') {
      const expectedBlockHash =
        typeof selector.expectedBlockHash === 'string' && selector.expectedBlockHash
          ? selector.expectedBlockHash
          : null;
      const paraId = typeof selector.paraId === 'string' && selector.paraId ? selector.paraId : null;
      const hasBlockIndex = selector.blockIndex !== undefined && selector.blockIndex !== null;
      const blockIndex = hasBlockIndex ? Number(selector.blockIndex) : -1;
      if (!expectedBlockHash) {
        return { status: 'needs_review', reason: 'element_fingerprint_changed' };
      }
      if (!paraId && (!hasBlockIndex || !Number.isInteger(blockIndex) || blockIndex < 0)) {
        return { status: 'needs_review', reason: 'element_fingerprint_changed' };
      }
      try {
        const { paragraphs, byBlockIndex } = readDocxAllParagraphTargets(buffer);

        if (paraId) {
          const byId = paragraphs.filter((p) => p.paraId === paraId);
          if (byId.length === 0) return { status: 'stale', reason: 'word_block_not_found' };
          if (byId.length > 1) return { status: 'needs_review', reason: 'ambiguous_para_id' };
          const match = byId[0];
          if (match.fingerprint !== expectedBlockHash) {
            return { status: 'needs_review', reason: 'element_fingerprint_changed' };
          }
          return {
            status: 'resolved',
            resolvedRange: { selector, resolvedBlockIndex: match.blockIndex },
            resolvedSnippet: match.text,
          };
        }

        const matches = paragraphs.filter((p) => p.fingerprint === expectedBlockHash);
        if (!matches.length) {
          return byBlockIndex.has(blockIndex)
            ? { status: 'needs_review', reason: 'element_fingerprint_changed' }
            : { status: 'stale', reason: 'word_block_not_found' };
        }

        const { contextBeforeHash, contextAfterHash, duplicateCount, occurrenceIndex } = selector;
        if (!isSha256(contextBeforeHash) || !isSha256(contextAfterHash)) {
          return { status: 'needs_review', reason: 'invalid_context_hash' };
        }
        const contextual = matches.filter(p =>
          p.contextBeforeHash === contextBeforeHash && p.contextAfterHash === contextAfterHash);
        const match = contextual.length === 1 ? contextual[0] : undefined;
        if (!match || (duplicateCount !== undefined && duplicateCount !== matches.length) ||
            (occurrenceIndex !== undefined && occurrenceIndex !== match.occurrenceIndex) ||
            (matches.length > 1 && match.blockIndex !== blockIndex)) {
          return { status: 'needs_review', reason: 'ambiguous_duplicate_paragraph' };
        }
        return {
          status: 'resolved',
          resolvedRange: { selector, resolvedBlockIndex: match.blockIndex },
          resolvedSnippet: match.text,
        };
      } catch {
        return { status: 'needs_review', reason: 'target_structure_unavailable' };
      }
    }

    if (this.format === 'pptx' || this.format === 'docx') {
      const expectedFp =
        selector.expectedElementFingerprint ??
        selector.expectedBlockHash ??
        selector.expectedSlideHash ??
        selector.expectedCellHash;
      const currentFp = sha256Buffer(buffer);
      if (!expectedFp || String(expectedFp) !== currentFp) {
        return { status: 'needs_review', reason: 'element_fingerprint_changed' };
      }
      return { status: 'resolved', resolvedRange: { selector } };
    }

    return { status: 'needs_review', reason: 'unverified_rich_target' };
  }
}

export function detectArtifactFormat(filename: string, previewKind: PreviewKind): ArtifactFormat {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (previewKind === 'table') return ext === '.xlsx' ? 'xlsx' : 'csv';
  if (previewKind === 'pptx') return 'pptx';
  if (previewKind === 'docx') return 'docx';
  if (previewKind === 'pdf') return 'pdf';
  if (previewKind === 'image') return 'image';
  if (previewKind === 'svg') return 'svg';
  if (previewKind === 'html') return 'html';
  if (previewKind === 'markdown') return 'markdown';
  if (previewKind === 'code') return 'code';
  if (previewKind === 'diff') return 'diff';
  if (previewKind === 'mermaid') return 'mermaid';
  if (previewKind === 'audio' || previewKind === 'video') return 'media';
  return 'binary';
}

export class FormatAdapterRegistry {
  private readonly adapters = new Map<ArtifactFormat, FormatAdapter>();

  constructor() {
    // Basic 8 Pure-JS adapters (always available even in Base ChatUI without bwrap)
    const coreAdapters: FormatAdapter[] = [
      new CsvAdapter(),
      new SvgAdapter(),
      new HtmlAdapter(),
      new MarkdownAdapter(),
      new CodeAdapter(),
      new DiffAdapter(),
      new MermaidAdapter(),
      new BinaryAdapter(),
      new DocumentFormatAdapter('pptx', 'pptx', true),
      new DocumentFormatAdapter('docx', 'docx', true),
      new DocumentFormatAdapter('xlsx', 'table', true),
      new DocumentFormatAdapter('pdf', 'pdf', false),
      new DocumentFormatAdapter('image', 'image', true),
      new DocumentFormatAdapter('media', 'video', true),
    ];
    for (const adapter of coreAdapters) {
      this.adapters.set(adapter.format, adapter);
    }
  }

  register(adapter: FormatAdapter): void {
    this.adapters.set(adapter.format, adapter);
  }

  getByFormat(format: ArtifactFormat): FormatAdapter {
    return this.adapters.get(format) ?? this.adapters.get('binary')!;
  }

  resolve(filename: string, previewKind: PreviewKind): FormatAdapter {
    const format = detectArtifactFormat(filename, previewKind);
    return this.getByFormat(format);
  }

  buildCapabilitiesResponse(params: {
    filename: string;
    previewKind: PreviewKind;
    runtimeProfile: RuntimeProfile;
    sandboxIsolation: SandboxIsolationKind;
    stagingIsolation: StagingIsolationKind;
    content?: Buffer;
  }): ArtifactCapabilitiesResponse {
    const adapter = this.resolve(params.filename, params.previewKind);
    const directEditSupported =
      adapter.directEditUiSupported &&
      !documentFormatConstraint(adapter.format, params.filename, 'input', params.previewKind, params.content) &&
      !documentFormatConstraint(adapter.format, params.filename, 'input_edit', params.previewKind, params.content) &&
      (!adapter.requiresExternalWorker || (params.runtimeProfile !== 'base_chatui' && params.sandboxIsolation !== 'sandbox_required_blocked'));
    return {
      format: adapter.format,
      previewKind: params.previewKind,
      runtimeProfile: params.runtimeProfile,
      sandboxIsolation: params.sandboxIsolation,
      stagingIsolation: params.stagingIsolation,
      directEditUiSupported: directEditSupported,
      targetPinSupported: adapter.targetPinSupported,
      operations: adapter.getOperations({
        runtimeProfile: params.runtimeProfile,
        filename: params.filename,
        previewKind: params.previewKind,
        sandboxAvailable: params.sandboxIsolation !== 'sandbox_required_blocked',
        strictSandbox: params.sandboxIsolation === 'bwrap',
        content: params.content,
      }),
    };
  }
}
