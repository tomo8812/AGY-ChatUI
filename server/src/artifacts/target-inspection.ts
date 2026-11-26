import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { ArtifactError } from './errors.js';
import type { InspectionJob } from './target-inspection-worker.js';

// Target parsing has its own single execution slot, independent of ACP and the external renderer.
let tail: Promise<unknown> = Promise.resolve();
let pending = 0;

export function inspectArtifactTarget<T>(job: InspectionJob): Promise<T> {
  if (pending >= 16) return Promise.reject(new ArtifactError('RESOURCE_BUSY', '対象の解析が混み合っています。', 503));
  pending++;
  const run = tail.then(() => new Promise<T>((resolve, reject) => {
    const isSource = import.meta.url.endsWith('.ts');
    const entry = new URL(isSource ? './target-inspection-worker.ts' : './target-inspection-worker.js', import.meta.url);
    const options = { workerData: job, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 384 } };
    const worker = isSource
      ? new Worker(`import(require('node:url').pathToFileURL(${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))}).href)
          .then(({ tsImport }) => tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)}))
          .catch(error => { throw error; })`, { ...options, eval: true })
      : new Worker(entry, options);

    let response: { result: T; error?: never } | { error: { code: string; message: string; statusCode: number; details?: Record<string, unknown> } } | undefined;
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      void worker.terminate();
    }, 30_000);
    worker.once('message', value => { response = value; });
    worker.once('error', () => { /* The exit handler releases the execution slot. */ });
    worker.once('exit', code => {
      clearTimeout(timeout);
      if (expired) reject(new ArtifactError('RESOURCE_BUSY', '対象の解析が制限時間を超えました。', 503));
      else if (code !== 0 || !response) reject(new ArtifactError('TARGET_INSPECTION_FAILED', '対象の構造を読み取れません。', 422));
      else if (response.error) {
        const { code, message, statusCode, details } = response.error;
        reject(new ArtifactError(code, message, statusCode, details));
      } else resolve(response.result);
    });
  }));
  tail = run.catch(() => {}).finally(() => { pending--; });
  return run;
}
