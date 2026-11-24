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

/**
 * Capability + baseline fingerprint target-resolution adapter for Rich 6 formats
 * (full external worker edit/render implementations are added in PR 2).
 */
class DeferredRichFormatAdapter implements FormatAdapter {
  readonly requiresExternalWorker = true;
  readonly targetPinSupported = true;

  constructor(
    public readonly format: 'pptx' | 'docx' | 'xlsx' | 'pdf' | 'image' | 'media',
    public readonly previewKind: PreviewKind,
    public readonly directEditUiSupported: boolean
  ) {}

  getOperations(ctx: AdapterCapabilityContext): OperationCapability[] {
    const workerAvail = ctx.runtimeProfile === 'base_chatui' ? 'disabled_by_resource_tier' : 'partial';
    const remediation =
      ctx.runtimeProfile === 'base_chatui'
        ? 'ドキュメントランタイムを有効化するには deploy/setup-doc-runtime.sh を実行してください。'
        : undefined;

    if (this.format === 'pdf') {
      return [
        { operation: 'view', availability: 'supported', scope: 'ui_view_only' },
        { operation: 'target_pin', availability: 'supported', scope: 'mcp_and_ui' },
        {
          operation: 'edit_body_reflow',
          availability: 'unsupported_by_format',
          scope: 'mcp_only',
          notes: 'PDF direct body text reflow/deletion is unsupported; use annotations or overlays.',
        },
        { operation: 'mcp_edit', availability: workerAvail, scope: 'mcp_only', remediation },
      ];
    }

    return [
      { operation: 'view', availability: 'supported', scope: 'ui_view_only' },
      { operation: 'target_pin', availability: 'supported', scope: 'mcp_and_ui' },
      {
        operation: 'edit',
        availability: workerAvail,
        scope: this.directEditUiSupported ? 'mcp_and_ui' : 'mcp_only',
        remediation,
      },
      { operation: 'render_png', availability: workerAvail, scope: 'mcp_only', remediation },
    ];
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
      const currentPageHash = selector._currentPageContentHash ? String(selector._currentPageContentHash) : currentSha;
      if (!expectedPageContentHash || expectedPageContentHash !== currentPageHash) {
        return { status: 'needs_review', reason: 'pdf_page_content_changed' };
      }
      return { status: 'resolved', resolvedCoords: { pageIndex: selector.pageIndex } };
    }

    if (this.format === 'xlsx') {
      const expectedValuesHash = selector.expectedRangeValuesHash ? String(selector.expectedRangeValuesHash) : null;
      const currentValuesHash = selector._currentRangeValuesHash ? String(selector._currentRangeValuesHash) : currentSha;
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
      const currentFp = selector._currentFingerprint ? String(selector._currentFingerprint) : currentSha;
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
      // Deferred Rich 6 format capability & fingerprint resolvers (full workers added in PR 2)
      new DeferredRichFormatAdapter('pptx', 'pptx', true),
      new DeferredRichFormatAdapter('docx', 'docx', true),
      new DeferredRichFormatAdapter('xlsx', 'table', true),
      new DeferredRichFormatAdapter('pdf', 'pdf', false),
      new DeferredRichFormatAdapter('image', 'image', true),
      new DeferredRichFormatAdapter('media', 'video', true),
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
      (!adapter.requiresExternalWorker || params.runtimeProfile !== 'base_chatui');
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
        sandboxAvailable: params.sandboxIsolation === 'bwrap',
      }),
    };
  }
}
