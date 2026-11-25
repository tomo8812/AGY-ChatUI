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
    'pptx.set_shape_text', 'pptx.move_shape', 'pptx.set_shape_style', 'pptx.set_shape_bounds', 'pptx.add_shape', 'pptx.add_image',
    'pptx.add_table', 'pptx.set_table_cell', 'pptx.group_shapes', 'pptx.ungroup_shapes', 'pptx.add_slide', 'pptx.reorder_slide',
    'pptx.remove_slide', 'pptx.set_notes', 'pptx.smartart.get_structure', 'pptx.smartart.update_node_text', ...CHART_EDITS],
  docx: ['create', 'structure', 'read_range', 'verify', 'render_png', 'export:pdf', 'export:md', 'export:html',
    'docx.set_paragraph_text', 'docx.set_page_size', 'docx.set_page_layout', 'docx.add_paragraph',
    'docx.set_paragraph_style', 'docx.set_run_style', 'docx.set_list', 'docx.add_table', 'docx.set_table_cell', 'docx.add_image',
    'docx.patch_xml_text', 'docx.add_header_footer', 'docx.edit_header_footer', 'docx.add_footnote', 'docx.edit_footnote'],
  xlsx: ['create', 'structure', 'read_range', 'verify', 'render_png', 'export:pdf', 'export:png', 'export:csv', 'xlsx.set_cell', 'xlsx.set_cell_style', 'xlsx.set_formula', 'xlsx.mutate_rows', 'xlsx.mutate_columns',
    'xlsx.set_merge', 'xlsx.add_conditional_format', 'xlsx.set_data_validation', 'xlsx.set_auto_filter',
    'xlsx.add_sheet', 'xlsx.reorder_sheet', 'xlsx.rename_sheet', 'xlsx.remove_empty_sheet', 'xlsx.set_sheet_visibility', 'xlsx.set_defined_name', 'xlsx.set_page_setup', ...CHART_EDITS],
  pdf: ['create', 'structure', 'read_range', 'verify', 'render_png', 'export:png', 'export:txt',
    'pdf.rotate_page', 'pdf.reorder_pages', 'pdf.remove_page', 'pdf.add_note', 'pdf.add_overlay'],
  image: ['create', 'structure', 'verify', 'render_png', 'export:png', 'export:jpg', 'export:jpeg', 'export:webp',
    'image.crop', 'image.resize', 'image.rotate', 'image.brightness', 'image.annotate', 'image.composite'],
  media: ['structure', 'verify', 'render_png', 'media.trim'],
} satisfies Partial<Record<ArtifactFormat, string[]>>;

// Operations exposed to the direct editor through the REST gateway.
const DIRECT_EDITOR_OPERATIONS = new Set([
  'pptx.set_shape_text', 'pptx.move_shape', 'pptx.set_shape_style', 'pptx.set_shape_bounds', 'pptx.add_shape', 'pptx.add_image',
  'pptx.add_table', 'pptx.set_table_cell', 'pptx.add_slide', 'pptx.reorder_slide', 'pptx.remove_slide',
  'docx.set_paragraph_text', 'docx.add_paragraph', 'docx.set_paragraph_style', 'docx.set_run_style', 'docx.set_list',
  'docx.add_table', 'docx.set_table_cell', 'docx.add_image',
  'xlsx.set_cell', 'xlsx.set_cell_style', 'xlsx.set_formula', 'xlsx.mutate_rows', 'xlsx.mutate_columns',
  'xlsx.add_sheet', 'xlsx.reorder_sheet', 'xlsx.rename_sheet', 'xlsx.remove_empty_sheet', 'xlsx.set_sheet_visibility',
  'image.crop', 'image.rotate', 'image.resize', 'image.annotate', 'media.trim',
]);

const LIMITED_OPERATIONS: Record<string, string> = {
  'pptx.set_shape_text': '単一段落・単一ランのテキスト。',
  'pptx.set_shape_style': '基本図形の文字書式、塗り、透明度、回転、外側の影。',
  'pptx.move_shape': '最上位図形の重ね順。',
  'pptx.set_shape_bounds': '明示的な変形を持つ最上位図形の位置と寸法。',
  'pptx.add_shape': '四角形、角丸四角形、楕円。',
  'pptx.add_image': 'PNG または JPEG。',
  'pptx.set_table_cell': '編集可能なテキストノードが一つのセル。',
  'pptx.group_shapes': '連続する最上位の図形・画像・コネクタ・グループ。',
  'pptx.ungroup_shapes': '座標変換が恒等のグループ。',
  'pptx.add_slide': '既存レイアウトを使用した新規スライド。',
  'pptx.set_notes': 'ノート本文のプレーンテキスト。',
  'pptx.smartart.update_node_text': 'データモデルと描画キャッシュで対応付けできる既存ラベル。',
  'docx.set_paragraph_text': '保護ノードを含まない単一ランの段落。',
  'docx.set_paragraph_style': '既存の段落スタイルを適用。',
  'docx.set_run_style': '保護ノードを含まない文字ランに書体・サイズ・色・太字・斜体を適用。',
  'docx.set_list': '既存の番号定義を段落に適用。',
  'docx.set_table_cell': '編集可能なテキストノードが一つのセル。',
  'docx.add_image': 'PNG または JPEG。',
  'docx.add_header_footer': '文末セクションに新規のヘッダーまたはフッターを追加。',
  'docx.edit_header_footer': '既存のヘッダー・フッターの直接テキスト。',
  'docx.edit_footnote': '既存脚注の直接テキスト。',
  'docx.patch_xml_text': '期待値が一致する段落内の直接テキストノード。',
  'xlsx.set_cell_style': '既存のセルスタイルを適用。',
  'xlsx.mutate_rows': '対応する参照を更新。保護された構造への変更は不可。',
  'xlsx.mutate_columns': '対応する参照を更新。保護された構造への変更は不可。',
  'xlsx.add_conditional_format': '2 色スケール。',
  'xlsx.set_data_validation': 'リスト、整数、小数、テキスト長。',
  'xlsx.set_auto_filter': '範囲および列の値フィルター。',
  'xlsx.rename_sheet': '直接参照を更新。動的参照や保護された構造を持つブックには適用不可。',
  'xlsx.remove_empty_sheet': '参照と内容を持たない空のワークシート。',
  'xlsx.set_defined_name': 'ブック範囲の名前と、単一ワークシート内のセル範囲。',
  'xlsx.set_page_setup': '用紙、向き、縮尺、ページ収め。',
  'media.trim': '一度の操作で一つの連続区間を抽出。',
  'chart.create': '対応グラフと参照を持つパッケージ。',
  'chart.update_title_and_legend': '対応グラフで既存のデータ参照を維持。',
  'chart.update_series_data': '編集可能なローカル範囲または埋め込み XLSX を使用。',
  'chart.update_series_style': '対応グラフの系列色。',
  'chart.add_or_remove_series': '対応グラフの既存系列を基に追加または削除。',
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
        let notes = LIMITED_OPERATIONS[operation];
        if (operation === 'verify' && ['pptx', 'docx', 'xlsx'].includes(this.format)) {
          notes = '検証済み項目と未検証項目を返します。';
        }
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
        if (this.format === 'pdf' && operation === 'read_range') notes = 'ページ単位の抽出。';
        return { operation, availability: notes ? 'partial' : 'supported', scope, notes };
      }),
    ];
    if (this.format === 'pptx') operations.push({
      operation: 'pptx.smartart.add_or_remove_node', availability: 'unsupported_by_format', scope: 'mcp_only',
      notes: 'ノード追加・削除に必要な図形配置の再計算に対応していません。',
    });
    if (this.format === 'pdf') operations.push({
      operation: 'edit_body_reflow', availability: 'unsupported_by_format', scope: 'mcp_only',
      notes: 'PDF の既存本文は変更できません。注釈を追加できます。',
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
    if (this.format === 'pdf' && (opName === 'delete_text' || opName === 'reflow_text' || opName === 'edit_body_reflow')) {
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
      }),
    };
  }
}
