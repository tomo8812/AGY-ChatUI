import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ArtifactError } from './errors.js';
import { MAX_INSPECTION_INPUT_BYTES, MAX_INSPECTION_RSS_KIB } from './target-inspection-limits.js';
import type { InspectionJob } from './target-inspection-worker.js';

type InspectionError = { code: string; message: string; statusCode: number; details?: Record<string, unknown> };

// One child at a time, independent of ACP and the document renderer. A separate
// process lets the watchdog measure RSS, including native allocations and Buffers.
let tail: Promise<unknown> = Promise.resolve();
let pending = 0;

export function inspectArtifactTarget<T>(job: InspectionJob): Promise<T> {
  if (pending >= 16) return Promise.reject(new ArtifactError('RESOURCE_BUSY', '対象の解析が混み合っています。', 503));
  const maxBytes = Math.min(job.maxBytes ?? MAX_INSPECTION_INPUT_BYTES, MAX_INSPECTION_INPUT_BYTES);
  pending++;
  const run = tail.then(() => new Promise<T>((resolve, reject) => {
    const isSource = import.meta.url.endsWith('.ts');
    const entry = new URL(isSource ? './target-inspection-worker.ts' : './target-inspection-worker.js', import.meta.url);
    const child = fork(entry, [], {
      execArgv: ['--max-old-space-size=256', ...(isSource ? [
        '--experimental-transform-types', '--import', new URL('./target-inspection-source.mjs', import.meta.url).href,
      ] : [])],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let response: { result: T; error?: never } | { error: InspectionError; result?: never } | undefined;
    let limitError: ArtifactError | undefined;
    const stop = (error: ArtifactError) => {
      limitError ??= error;
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(() => stop(new ArtifactError('RESOURCE_BUSY', '対象の解析が制限時間を超えました。', 503)), 30_000);
    const watchdog = setInterval(() => {
      if (!child.pid) return;
      try {
        const status = readFileSync(`/proc/${child.pid}/status`, 'utf8');
        const rss = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]);
        if (rss > MAX_INSPECTION_RSS_KIB) {
          stop(new ArtifactError('TARGET_INSPECTION_MEMORY_LIMIT', '対象の解析がメモリ上限を超えました。', 413));
        }
      } catch {
        // The child may have exited before the status file could be read.
      }
    }, 100);
    child.once('message', value => { response = value as typeof response; });
    child.on('error', () => { child.kill('SIGKILL'); });
    child.once('close', code => {
      clearTimeout(timeout);
      clearInterval(watchdog);
      if (limitError) reject(limitError);
      else if (code !== 0 || !response) reject(new ArtifactError('TARGET_INSPECTION_FAILED', '対象の構造を読み取れません。', 422));
      else if (response.error) {
        const { code, message, statusCode, details } = response.error;
        reject(new ArtifactError(code, message, statusCode, details));
      } else resolve(response.result);
    });
    child.send({ ...job, maxBytes });
  }));
  tail = run.catch(() => {}).finally(() => { pending--; });
  return run;
}
