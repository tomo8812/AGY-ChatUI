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
    'pptx.set_shape_text', 'pptx.move_shape', 'pptx.smartart.get_structure', 'pptx.smartart.update_node_text', ...CHART_EDITS],
  docx: ['create', 'structure', 'read_range', 'verify', 'render_png', 'export:pdf', 'export:md', 'export:html',
    'docx.set_paragraph_text', 'docx.set_page_size', 'docx.set_page_layout'],
  xlsx: ['create', 'structure', 'read_range', 'verify', 'render_png', 'export:pdf', 'export:png', 'export:csv', 'xlsx.set_cell', 'xlsx.set_cell_style', 'xlsx.set_formula', 'xlsx.mutate_rows', 'xlsx.mutate_columns', ...CHART_EDITS],
  pdf: ['create', 'structure', 'read_range', 'verify', 'render_png', 'export:png', 'export:txt',
    'pdf.rotate_page', 'pdf.reorder_pages', 'pdf.remove_page', 'pdf.add_note', 'pdf.add_overlay'],
  image: ['create', 'structure', 'verify', 'render_png', 'export:png', 'export:jpg', 'export:jpeg', 'export:webp',
    'image.crop', 'image.resize', 'image.rotate', 'image.brightness', 'image.annotate', 'image.composite'],
  media: ['structure', 'verify', 'render_png', 'media.trim'],
} satisfies Partial<Record<ArtifactFormat, string[]>>;

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
    const operations: OperationCapability[] = [
      { operation: 'view', availability: 'supported', scope: 'ui_view_only' },
      { operation: 'target_pin', availability: 'supported', scope: 'mcp_and_ui' },
      ...DOCUMENT_ACTIONS[this.format].map((operation): OperationCapability => ({
        operation,
        availability: workerReady ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_only',
        ...(!workerReady ? {
          remediation: ctx.runtimeProfile === 'base_chatui'
            ? 'ドキュメントランタイムをインストールしてください。'
            : 'bubblewrap サンドボックスを有効化してください。',
        } : {}),
      })),
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
    return { ok: buffer.length > 0, issues: [], metrics: { sizeBytes: buffer.length, sha256: sha256Buffer(buffer) } };
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
      adapter.directEditUiSupported &&
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
        sandboxAvailable: params.sandboxIsolation !== 'sandbox_required_blocked',
      }),
    };
  }
}
