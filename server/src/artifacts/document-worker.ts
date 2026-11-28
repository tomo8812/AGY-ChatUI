import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTML_SANDBOX_CSP, injectSandboxZoomBridge } from '../files/sandbox-bridge.js';
import type { AppConfig } from '../config.js';
import { documentFormatConstraint } from './adapters/registry.js';
import { ArtifactError, unsupportedOperationError } from './errors.js';
import type { ResourceGovernor } from './resource-governor.js';
import type { DocWorkerSandbox } from './sandbox-worker.js';
import type { AdapterOperation, ArtifactFormat, RenderRegion } from './types.js';

export type DocumentFormat = Extract<ArtifactFormat, 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'image' | 'media'>;

export function isDocumentFormat(format: ArtifactFormat): format is DocumentFormat {
  return ['docx', 'pptx', 'xlsx', 'pdf', 'image', 'media'].includes(format);
}

export function isWebRenderFormat(format: ArtifactFormat): format is 'html' | 'markdown' | 'mermaid' {
  return format === 'html' || format === 'markdown' || format === 'mermaid';
}

export const WEB_VERIFY_MAX_INPUT_BYTES = 1_000_000;
export const WEB_VERIFY_ASSET_BUDGET = 24 * 1024 * 1024;

export const DOCUMENT_WORKER_MAX_INPUT_BYTES = 100 * 1024 * 1024;

export interface DocumentVerifyOptions {
  slideIndices?: number[];
  maxSlides?: number;
  maxShapesPerSlide?: number;
  selector?: string;
  elementOffset?: number;
  maxElements?: number;
}

type WorkerAction =
  | { action: 'structure' }
  | { action: 'verify'; options?: DocumentVerifyOptions }
  | { action: 'range'; range: Record<string, unknown> }
  | { action: 'edit'; operations: AdapterOperation[] }
  | { action: 'pptx_draft_layer'; operations: AdapterOperation[]; pageIndex: number; variant: 'background' | 'sprite'; draftShapeKey?: string }
  | { action: 'xlsx_draft_range'; operations: AdapterOperation[]; sheetName: string; rangeA1: string }
  | { action: 'create'; params: Record<string, unknown> }
  | { action: 'render'; pageIndex?: number; timeSeconds?: number; frameSample?: {timestampSec: number; sha256: string}; variant?: 'background' | 'sprite'; shapeId?: number; cropSprite?: boolean; region?: RenderRegion }
  | { action: 'export'; targetFormat: string; region?: RenderRegion };

export type DocumentInputSource = Buffer | { path: string; sizeBytes: number };

const docWorkerScript = fileURLToPath(new URL('../../scripts/artifact_doc_worker.py', import.meta.url));

const webVerifyScript = fileURLToPath(new URL('../../scripts/artifact_web_verify.mjs', import.meta.url));
const webWorkerScript = fileURLToPath(new URL('../../scripts/artifact_web_renderer.mjs', import.meta.url));

export class DocumentWorker {
  constructor(
    private readonly config: AppConfig,
    private readonly governor: ResourceGovernor,
    private readonly sandbox: DocWorkerSandbox
  ) {}

  get available(): boolean {
    return this.governor.getRuntimeProfile() !== 'base_chatui' &&
      this.sandbox.getIsolationStatus() !== 'sandbox_required_blocked';
  }

  get fullWebRuntimeAvailable(): boolean {
    return this.governor.getRuntimeProfile() === 'full_runtime' &&
      this.sandbox.getIsolationStatus() !== 'sandbox_required_blocked';
  }

  get browserVerificationAvailable(): boolean {
    return this.fullWebRuntimeAvailable && this.sandbox.getIsolationStatus() === 'bwrap';
  }

  async run(
    format: DocumentFormat | 'html' | 'mermaid' | 'markdown' | 'svg' | 'csv',
    filename: string,
    document: DocumentInputSource | undefined,
    request: WorkerAction,
    mergeSources: readonly Buffer[] = [],
    renderSnapshot?: {
      entry: string;
      dependencies: ReadonlyArray<{ relPath: string; mimeType: string; bytes: Buffer }>;
      compareDocument?: Buffer;
    }
  ): Promise<Buffer> {
    const operation = request.action === 'export' ? `export:${request.targetFormat}` : request.action;
    const constraint = documentFormatConstraint(format, filename, operation);
    if (constraint) throw unsupportedOperationError(operation, 'unsupported_by_format', constraint);
    const profile = this.governor.getRuntimeProfile();
    const markdownDocExport = format === 'markdown' && request.action === 'export' &&
      (request.targetFormat === 'docx' || (request.targetFormat === 'pdf' && profile !== 'full_runtime'));
    const browserVerification = request.action === 'verify' && (format === 'html' || format === 'svg');
    if (browserVerification && !this.browserVerificationAvailable) {
      throw unsupportedOperationError(operation, 'disabled_by_resource_tier', 'Browser verification requires Full Runtime with bwrap.');
    }
    const web = browserVerification || (isWebRenderFormat(format) && !markdownDocExport);
    if (profile === 'base_chatui' || (web && profile !== 'full_runtime')) {
      throw unsupportedOperationError(operation, 'disabled_by_resource_tier', 'Document runtime is unavailable.');
    }
    const compareBytes = renderSnapshot?.compareDocument;
    const docSizeBytes = document ? (Buffer.isBuffer(document) ? document.length : document.sizeBytes) : 0;
    if (docSizeBytes + (compareBytes?.length ?? 0) +
        mergeSources.reduce((total, bytes) => total + bytes.length, 0) > DOCUMENT_WORKER_MAX_INPUT_BYTES) {
      throw new ArtifactError('DOC_WORKER_INPUT_TOO_LARGE', 'Document input exceeds the worker size limit.', 413);
    }
    const sandboxed = this.sandbox.getIsolationStatus() === 'bwrap';
    const runtimeDir = sandboxed ? '/opt/agy-doc-runtime' : this.config.docRuntimeDir;
    const workerScript = web ? webWorkerScript : docWorkerScript;
    const scriptName = path.basename(workerScript);
    const smartartRecalc = format === 'pptx' && request.action === 'edit' &&
      request.operations.some((op) => op.op === 'pptx.smartart.add_or_remove_node');
    const officeConversion = request.action === 'pptx_draft_layer' || ((format === 'docx' || format === 'pptx' || format === 'xlsx') &&
      (request.action === 'render' ||
        (request.action === 'export' && ['png', 'pdf'].includes(request.targetFormat)))) ||
      smartartRecalc ||
      (format === 'markdown' && request.action === 'export' && request.targetFormat === 'pdf') ||
      (format === 'xlsx' && (request.action === 'xlsx_draft_range' || request.action === 'range' && request.range.evaluate === true)) ||
      ((format === 'pptx' || format === 'docx' || format === 'xlsx') && request.action === 'verify');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-document-'));
    try {
      let inputHostPath: string | undefined;
      if (document) {
        if (Buffer.isBuffer(document)) {
          inputHostPath = path.join(directory, 'document');
          fs.writeFileSync(inputHostPath, document, { mode: 0o600 });
        } else {
          inputHostPath = document.path;
        }
      }
      const manifest = path.join(directory, 'request.json');
      const compareInput = compareBytes ? path.join(directory, 'compare') : undefined;
      if (compareBytes && compareInput) fs.writeFileSync(compareInput, compareBytes, { mode: 0o600 });
      const sourceInputs = mergeSources.map((bytes, index) => {
        const sandboxName = `merge-${index}.pdf`;
        const hostPath = path.join(directory, sandboxName);
        fs.writeFileSync(hostPath, bytes, { mode: 0o600 });
        return { hostPath, sandboxName };
      });
      const assets = (renderSnapshot?.dependencies ?? []).map(({ relPath, mimeType, bytes }, index) => {
        const sandboxName = `asset-${index}`;
        const hostPath = path.join(directory, sandboxName);
        fs.writeFileSync(hostPath, bytes, { mode: 0o600 });
        return { relPath, mimeType, sandboxName, hostPath };
      });
      const browserViewerInput = browserVerification && format === 'html' && Buffer.isBuffer(document) ? path.join(directory, 'viewer') : undefined;
      if (browserViewerInput && Buffer.isBuffer(document)) {
        fs.writeFileSync(browserViewerInput, injectSandboxZoomBridge(document.toString('utf8')), { mode: 0o600 });
      }
      fs.writeFileSync(manifest, JSON.stringify({
        ...request, format, filename, mergeSourceCount: sourceInputs.length,
        hasCompareDocument: Boolean(compareInput),
        entry: renderSnapshot?.entry,
        ...(browserViewerInput ? { viewerPolicy: HTML_SANDBOX_CSP } : {}),
        assets: assets.map(({ relPath, mimeType, sandboxName }) => ({ relPath, mimeType, sandboxName })),
      }), { mode: 0o600 });
      const webEnv: Record<string, string> = {
        AGY_DOC_RUNTIME_DIR: runtimeDir,
        PLAYWRIGHT_BROWSERS_PATH: path.join(runtimeDir, 'playwright'),
      };
      if (!sandboxed && process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
        webEnv.PLAYWRIGHT_EXECUTABLE_PATH = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
      }
      // The configured runtime is trusted deployment content, mounted read-only.
      const portableBin = path.join(this.config.docRuntimeDir, 'bin');
      const workerPath = fs.existsSync(portableBin) ? `${runtimeDir}/bin:/usr/local/bin:/usr/bin:/bin` : undefined;
      const portableNode = fs.existsSync(path.join(portableBin, 'node')) ? `${runtimeDir}/bin/node` : '/usr/bin/node';
      const result = await this.sandbox.run({
        kind: web ? 'chromium' : officeConversion ? 'libreoffice' : format === 'media' ? 'ffmpeg' : 'python',
        command: web ? (sandboxed ? portableNode : process.execPath) : path.join(runtimeDir, 'venv/bin/python3'),
        args: [sandboxed ? `/work/in/${scriptName}` : workerScript],
        env: { ...(web ? webEnv : {}), ...(workerPath ? { PATH: workerPath } : {}) },
        inputFiles: [
          ...(inputHostPath ? [{ hostPath: inputHostPath, sandboxName: 'document' }] : []),
          ...(compareInput ? [{ hostPath: compareInput, sandboxName: 'compare' }] : []),
          ...sourceInputs,
          ...assets.map(({ hostPath, sandboxName }) => ({ hostPath, sandboxName })),
          { hostPath: manifest, sandboxName: 'request.json' },
          { hostPath: workerScript, sandboxName: scriptName },
          ...(web ? [{ hostPath: webVerifyScript, sandboxName: path.basename(webVerifyScript) }] : []),
          ...(browserViewerInput ? [{ hostPath: browserViewerInput, sandboxName: 'viewer' }] : []),
        ],
        expectedOutputRelPath: 'result',
        timeoutMs: request.action === 'export' || smartartRecalc || (officeConversion && request.action === 'verify')
          ? this.config.docWorkerExportTimeoutMs
          : undefined,
      });
      if (result.exitCode === 3) {
        throw new ArtifactError('UNSUPPORTED_STRUCTURAL_MUTATION', 'The workbook contains protected structures or references.', 422);
      }
      if (result.exitCode === 4) {
        const detail = result.stderr.trim().split('\n')[0] || 'This operation is not supported for this document layout or format.';
        throw unsupportedOperationError(operation, 'unsupported_by_format', detail);
      }
      if (result.exitCode !== 0 || !result.outputBuffer) {
        throw new ArtifactError('DOCUMENT_WORKER_REJECTED', 'Document processing rejected the input or operation.', 422);
      }
      return result.outputBuffer;
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
