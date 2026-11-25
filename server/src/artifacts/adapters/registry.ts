import path from 'node:path';
import type { PreviewKind } from '../../types.js';
import { unsupportedOperationError } from '../errors.js';
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
import { sha256Buffer, type AdapterCapabilityContext, type AdapterFileMeta, type FormatAdapter } from './base.js';
import { BinaryAdapter } from './binary-adapter.js';
import { CodeAdapter } from './code-adapter.js';
import { CsvAdapter } from './csv-adapter.js';
import { DiffAdapter } from './diff-adapter.js';
import { HtmlAdapter } from './html-adapter.js';
import { MarkdownAdapter } from './markdown-adapter.js';
import { MermaidAdapter } from './mermaid-adapter.js';
import { SvgAdapter } from './svg-adapter.js';

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
  'chart.create': '棒・縦棒・折線・円・ドーナツ・面・散布・複合/第 2 軸に対応（3D 特殊曲面・ピボットグラフ等は非対応）。',
  'chart.update_title_and_legend': '対応グラフ種別でタイトル・凡例を更新。',
  'chart.update_series_data': 'ローカル範囲または埋め込み XLSX とキャッシュを同時同期。',
  'chart.update_series_style': '対応グラフ種別の系列スタイルを更新。',
  'chart.add_or_remove_series': '対応グラフ種別の系列を追加・削除。',
};

export function documentFormatConstraint(format: ArtifactFormat, filename: string, operation: string, previewKind?: PreviewKind): string | undefined {
  const extension = path.extname(filename).toLowerCase();
  if (format === 'xlsx' && extension === '.xls' && operation !== 'structure') {
    return '編集ワーカーは OOXML の XLSX に対応します。';
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
    const metadataOnly = Boolean(documentFormatConstraint(this.format, ctx.filename ?? '', 'input'));
    const operations: OperationCapability[] = [
      { operation: 'view', availability: 'supported', scope: 'ui_view_only' },
      { operation: 'target_pin', availability: 'supported', scope: 'mcp_and_ui' },
      ...DOCUMENT_ACTIONS[this.format].map((operation): OperationCapability => {
        const scope = DIRECT_EDITOR_OPERATIONS.has(operation) || operation === 'structure' || operation === 'read_range'
          ? 'mcp_and_ui' : 'mcp_only';
        const constraint = documentFormatConstraint(this.format, ctx.filename ?? '', operation, ctx.previewKind);
        if (constraint) return { operation, availability: 'unsupported_by_format', scope, notes: constraint };
        const notes = LIMITED_OPERATIONS[operation];
        if (!workerReady || metadataOnly) {
          if (operation === 'structure' || operation === 'verify' ||
              (operation === 'render_png' && this.format === 'image' && /\.png$/i.test(ctx.filename ?? ''))) {
            return { operation, availability: 'partial', scope, notes: operation === 'render_png'
              ? '既存の PNG を取得できます。' : 'ファイルのメタデータのみ。' };
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
    return operations;
  }

  getStructure(buffer: Buffer, meta: AdapterFileMeta): Record<string, unknown> {
    return {
      format: this.format,
      filename: meta.filename,
      sizeBytes: buffer.length,
      sha256: sha256Buffer(buffer),
    };
  }

  readRange(_buffer: Buffer, _range: Record<string, unknown>, _meta: AdapterFileMeta): Record<string, unknown> {
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
    const currentSha = sha256Buffer(buffer);

    if (this.format === 'image') {
      const expectedSha = selector.expectedImageSha256 ? String(selector.expectedImageSha256) : null;
      if (!expectedSha || expectedSha !== currentSha) {
        return { status: 'needs_review', reason: 'image_content_changed' };
      }
      return { status: 'resolved', resolvedCoords: { selector } };
    }

    if (this.format === 'media') {
      const expectedSha = selector.expectedMediaSha256 ? String(selector.expectedMediaSha256) : null;
      if (!expectedSha || expectedSha !== currentSha) {
        return { status: 'needs_review', reason: 'media_content_changed' };
      }
      return { status: 'resolved', resolvedCoords: { selector } };
    }

    if (this.format === 'pdf') {
      const expectedPageContentHash = selector.expectedPageContentHash ? String(selector.expectedPageContentHash) : null;
      const currentPageHash = currentSha;
      if (!expectedPageContentHash || expectedPageContentHash !== currentPageHash) {
        return { status: 'needs_review', reason: 'pdf_page_content_changed' };
      }
      return { status: 'resolved', resolvedCoords: { pageIndex: selector.pageIndex } };
    }

    if (this.format === 'xlsx') {
      const expectedValuesHash = selector.expectedRangeValuesHash ? String(selector.expectedRangeValuesHash) : null;
      const currentValuesHash = currentSha;
      if (!expectedValuesHash || expectedValuesHash !== currentValuesHash) {
        return { status: 'needs_review', reason: 'TARGET_CONTENT_DRIFT' };
      }
      return { status: 'resolved', resolvedRange: { sheetId: selector.sheetId, rangeA1: selector.rangeA1 } };
    }

    if (this.format === 'pptx' || this.format === 'docx') {
      const expectedFp =
        selector.expectedElementFingerprint ??
        selector.expectedBlockHash ??
        selector.expectedSlideHash ??
        selector.expectedCellHash;
      const currentFp = currentSha;
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
  }): ArtifactCapabilitiesResponse {
    const adapter = this.resolve(params.filename, params.previewKind);
    const directEditSupported =
      adapter.directEditUiSupported && !documentFormatConstraint(adapter.format, params.filename, 'input') &&
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
      }),
    };
  }
}
