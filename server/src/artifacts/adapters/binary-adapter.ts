import { unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterOperation,
  AdapterVerifyResult,
  OperationCapability,
  TargetResolutionResult,
  TargetSelector,
} from '../types.js';
import { sha256Buffer, type AdapterCapabilityContext, type AdapterFileMeta, type FormatAdapter } from './base.js';

export class BinaryAdapter implements FormatAdapter {
  readonly format = 'binary' as const;
  readonly previewKind = 'binary' as const;
  readonly directEditUiSupported = false;
  readonly targetPinSupported = false;
  readonly requiresExternalWorker = false;

  getOperations(_ctx: AdapterCapabilityContext): OperationCapability[] {
    return [
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui', notes: 'サイズ・SHA-256・MIME 等のメタデータのみ。' },
      { operation: 'read_range', availability: 'unsupported_by_format', scope: 'mcp_only', notes: 'バイナリファイルは範囲読取に非対応です。' },
      { operation: 'create', availability: 'unsupported_by_format', scope: 'mcp_only', notes: 'バイナリファイルの新規作成は非対応です。' },
      { operation: 'edit', availability: 'unsupported_by_format', scope: 'mcp_only', notes: 'バイナリファイルの編集は非対応です。' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui', notes: 'サイズ・SHA-256・MIME のみ。' },
      { operation: 'target_pin', availability: 'unsupported_by_format', scope: 'ui_view_only', notes: 'バイナリファイルは対象指定に非対応です。' },
    ];
  }

  getStructure(buffer: Buffer, meta: AdapterFileMeta): Record<string, unknown> {
    return {
      format: 'binary',
      filename: meta.filename,
      mimeType: meta.mimeType,
      sizeBytes: buffer.length,
      sha256: sha256Buffer(buffer),
    };
  }

  readRange(_buffer: Buffer, _range: Record<string, unknown>, _meta: AdapterFileMeta): Record<string, unknown> {
    throw unsupportedOperationError('read_range', 'unsupported_by_format', 'Binary files do not support structured range reading.');
  }

  applyOperations(_buffer: Buffer, operations: AdapterOperation[], _meta: AdapterFileMeta): AdapterEditResult {
    throw unsupportedOperationError(
      operations[0]?.op ?? 'edit',
      'unsupported_by_format',
      'Binary files cannot be edited directly.'
    );
  }

  verify(buffer: Buffer, meta: AdapterFileMeta): AdapterVerifyResult {
    return {
      ok: true,
      issues: [],
      metrics: { sizeBytes: buffer.length, sha256: sha256Buffer(buffer), mimeType: meta.mimeType },
    };
  }

  resolveTarget(_buffer: Buffer, _selector: TargetSelector, _meta: AdapterFileMeta): TargetResolutionResult {
    throw unsupportedOperationError('target_pin', 'unsupported_by_format', 'Binary files do not support target-pinned edit requests.');
  }
}
