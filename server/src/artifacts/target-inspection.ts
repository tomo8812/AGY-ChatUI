import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ArtifactError } from './errors.js';
import { readMemAvailableMb } from './resource-governor.js';
import { MAX_INSPECTION_INPUT_BYTES, MAX_INSPECTION_RSS_MB } from './target-inspection-limits.js';
import type { InspectionJob, InspectionResponse } from './target-inspection-parsers.js';

// Keep one parser process at a time. Native buffers and decompression belong
// to that process, so terminating it also releases heap-external memory.
let tail: Promise<unknown> = Promise.resolve();
let pending = 0;

export function inspectArtifactTarget<T>(job: InspectionJob): Promise<T> {
  if (pending >= 16) return Promise.reject(new ArtifactError('RESOURCE_BUSY', '対象の解析が混み合っています。', 503));
  pending++;
  const run = tail.then(() => new Promise<T>((resolve, reject) => {
    const maxInput = Math.min(job.maxBytes ?? MAX_INSPECTION_INPUT_BYTES, MAX_INSPECTION_INPUT_BYTES);
    const sourceBytes = 'snapshot' in job ? job.snapshot.sizeBytes : job.file.sizeBytes ?? maxInput;
    const baseBytes = 'baseSnapshot' in job ? job.baseSnapshot?.sizeBytes ?? 0 : 0;
    const totalInputMb = (Math.min(sourceBytes, maxInput) + Math.min(baseBytes, maxInput)) / 1024 ** 2;
    const document = /\.(pdf|docx|pptx|xlsx)$/i.test(job.file.filename);
    const media = ['audio', 'video', 'image'].includes(job.file.previewKind);
    // Small documents remain inspectable on Base hosts. The archive/parser
    // budgets still apply independently of this per-job RSS allowance.
    const rssLimit = Math.min(MAX_INSPECTION_RSS_MB, Math.ceil((document || media ? 256 : 192) + totalInputMb * (document ? 100 : 24)));
    const physicalAvailable = readMemAvailableMb() ?? Infinity;
    const processAvailable = process.availableMemory() / 1024 ** 2;
    if (Math.min(physicalAvailable, processAvailable) < rssLimit + 128) {
      reject(new ArtifactError('RESOURCE_BUSY', '対象の解析に必要なメモリが不足しています。', 503));
      return;
    }
    const fromSource = import.meta.url.endsWith('.ts');
    const source = new URL(fromSource ? './target-inspection-parsers.ts' : './target-inspection-parsers.js', import.meta.url);
    const child = fork(fileURLToPath(source), [], {
      execArgv: [
        '--max-old-space-size=256', '--max-semi-space-size=10',
        ...(fromSource ? [
          '--experimental-transform-types', '--import', new URL('./target-inspection-source.mjs', import.meta.url).href,
        ] : []),
      ],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    let response: InspectionResponse | undefined;
    let failure: ArtifactError | undefined;
    const terminate = (error: ArtifactError) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(() => terminate(new ArtifactError(
      'RESOURCE_BUSY', '対象の解析が制限時間を超えました。', 503,
    )), 30_000);
    const watchdog = setInterval(() => {
      if (process.platform !== 'linux' || child.pid === undefined) return;
      try {
        const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'));
        if (rss && Number(rss[1]) > rssLimit * 1024) {
          terminate(new ArtifactError('TARGET_INSPECTION_MEMORY_LIMIT', '対象の解析がメモリ上限を超えました。', 413));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          terminate(new ArtifactError('TARGET_INSPECTION_FAILED', '対象の解析プロセスを監視できません。', 503));
        }
      }
    }, 100);
    child.once('message', result => { response = result as InspectionResponse; });
    child.once('error', () => {
      failure ??= new ArtifactError('TARGET_INSPECTION_FAILED', '対象の解析プロセスを開始できません。', 503);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      clearInterval(watchdog);
      if (failure) reject(failure);
      else if (code !== 0 || !response) reject(new ArtifactError('TARGET_INSPECTION_FAILED', '対象の構造を読み取れません。', 422));
      else if ('error' in response) {
        const { code, message, statusCode, details } = response.error;
        reject(new ArtifactError(code, message, statusCode, details));
      } else resolve(response.result as T);
    });
    child.send(job, error => {
      if (error) terminate(new ArtifactError('TARGET_INSPECTION_FAILED', '対象の解析を開始できません。', 503));
    });
  }));
  tail = run.catch(() => {}).finally(() => { pending--; });
  return run;
}
