import { Worker } from 'node:worker_threads';
import { ArtifactError } from './errors.js';
import type { InspectionJob, InspectionResponse } from './target-inspection-parsers.js';

// Pure-JS target parsing runs in a Node isolate in this process. Its queue and
// execution limits are independent of ACP and the external document workers.
let tail: Promise<unknown> = Promise.resolve();
let pending = 0;

export function inspectArtifactTarget<T>(job: InspectionJob): Promise<T> {
  if (pending >= 16) return Promise.reject(new ArtifactError('RESOURCE_BUSY', '対象の解析が混み合っています。', 503));
  pending++;
  const run = tail.then(() => new Promise<T>((resolve, reject) => {
    const fromSource = import.meta.url.endsWith('.ts');
    const source = new URL(fromSource ? './target-inspection-parsers.ts' : './target-inspection-parsers.js', import.meta.url);
    const worker = new Worker(source, {
      workerData: job,
      execArgv: fromSource ? [
        '--experimental-transform-types', '--import', new URL('./target-inspection-source.mjs', import.meta.url).href,
      ] : [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    let response: InspectionResponse | undefined;
    let failure: ArtifactError | undefined;
    const timeout = setTimeout(() => {
      failure = new ArtifactError('RESOURCE_BUSY', '対象の解析が制限時間を超えました。', 503);
      void worker.terminate();
    }, 30_000);
    worker.once('message', result => { response = result as InspectionResponse; });
    worker.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY') {
        failure = new ArtifactError('TARGET_INSPECTION_MEMORY_LIMIT', '対象の解析がメモリ上限を超えました。', 413);
      }
    });
    worker.once('exit', code => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0 || !response) reject(new ArtifactError('TARGET_INSPECTION_FAILED', '対象の構造を読み取れません。', 422));
      else if ('error' in response) {
        const { code, message, statusCode, details } = response.error;
        reject(new ArtifactError(code, message, statusCode, details));
      } else resolve(response.result as T);
    });
  }));
  tail = run.catch(() => {}).finally(() => { pending--; });
  return run;
}
