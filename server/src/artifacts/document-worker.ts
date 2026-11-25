import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config.js';
import { ArtifactError, unsupportedOperationError } from './errors.js';
import type { ResourceGovernor } from './resource-governor.js';
import type { DocWorkerSandbox } from './sandbox-worker.js';
import type { AdapterOperation, ArtifactFormat } from './types.js';

export type DocumentFormat = Extract<ArtifactFormat, 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'image' | 'media'>;

export function isDocumentFormat(format: ArtifactFormat): format is DocumentFormat {
  return ['docx', 'pptx', 'xlsx', 'pdf', 'image', 'media'].includes(format);
}

export function isWebRenderFormat(format: ArtifactFormat): format is 'html' | 'markdown' | 'mermaid' {
  return format === 'html' || format === 'markdown' || format === 'mermaid';
}

export const DOCUMENT_WORKER_MAX_INPUT_BYTES = 100 * 1024 * 1024;

type WorkerAction =
  | { action: 'structure' | 'verify' }
  | { action: 'range'; range: Record<string, unknown> }
  | { action: 'edit'; operations: AdapterOperation[] }
  | { action: 'create'; params: Record<string, unknown> }
  | { action: 'render'; pageIndex?: number; timeSeconds?: number; variant?: 'background' | 'sprite'; shapeId?: number }
  | { action: 'export'; targetFormat: string };

const docWorkerScript = fileURLToPath(new URL('../../scripts/artifact_doc_worker.py', import.meta.url));

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

  async run(
    format: DocumentFormat | 'html' | 'mermaid' | 'markdown' | 'svg',
    filename: string,
    document: Buffer | undefined,
    request: WorkerAction,
    mergeSources: readonly Buffer[] = []
  ): Promise<Buffer> {
    const profile = this.governor.getRuntimeProfile();
    const web = isWebRenderFormat(format);
    if (profile === 'base_chatui' || (web && profile !== 'full_runtime')) {
      throw unsupportedOperationError(request.action, 'disabled_by_resource_tier', 'Document runtime is unavailable.');
    }
    if ((document?.length ?? 0) + mergeSources.reduce((total, bytes) => total + bytes.length, 0) > DOCUMENT_WORKER_MAX_INPUT_BYTES) {
      throw new ArtifactError('DOC_WORKER_INPUT_TOO_LARGE', 'Document input exceeds the worker size limit.', 413);
    }
    const sandboxed = this.sandbox.getIsolationStatus() === 'bwrap';
    const runtimeDir = sandboxed ? '/opt/agy-doc-runtime' : this.config.docRuntimeDir;
    const workerScript = web ? webWorkerScript : docWorkerScript;
    const scriptName = path.basename(workerScript);
    const officeConversion = ((format === 'docx' || format === 'pptx' || format === 'xlsx') &&
      (request.action === 'render' || request.action === 'export')) ||
      (format === 'xlsx' && request.action === 'range' && request.range.evaluate === true);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-document-'));
    try {
      const input = path.join(directory, 'document');
      const manifest = path.join(directory, 'request.json');
      if (document) fs.writeFileSync(input, document, { mode: 0o600 });
      const sourceInputs = mergeSources.map((bytes, index) => {
        const sandboxName = `merge-${index}.pdf`;
        const hostPath = path.join(directory, sandboxName);
        fs.writeFileSync(hostPath, bytes, { mode: 0o600 });
        return { hostPath, sandboxName };
      });
      fs.writeFileSync(manifest, JSON.stringify({ ...request, format, filename, mergeSourceCount: sourceInputs.length }), { mode: 0o600 });
      const result = await this.sandbox.run({
        kind: web ? 'chromium' : officeConversion ? 'libreoffice' : format === 'media' ? 'ffmpeg' : 'python',
        command: web ? (sandboxed ? '/usr/bin/node' : process.execPath) : path.join(runtimeDir, 'venv/bin/python3'),
        args: [sandboxed ? `/work/in/${scriptName}` : workerScript],
        env: web ? {
          AGY_DOC_RUNTIME_DIR: runtimeDir,
          PLAYWRIGHT_BROWSERS_PATH: path.join(runtimeDir, 'playwright'),
        } : undefined,
        inputFiles: [
          ...(document ? [{ hostPath: input, sandboxName: 'document' }] : []),
          ...sourceInputs,
          { hostPath: manifest, sandboxName: 'request.json' },
          { hostPath: workerScript, sandboxName: scriptName },
        ],
        expectedOutputRelPath: 'result',
        timeoutMs: request.action === 'export' ? this.config.docWorkerExportTimeoutMs : undefined,
      });
      if (result.exitCode === 3) {
        throw new ArtifactError('UNSUPPORTED_STRUCTURAL_MUTATION', 'The workbook contains protected structures or references.', 422);
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
