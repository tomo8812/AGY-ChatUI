import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeBwrapSandbox } from '../acp/env-isolation.js';
import type { AppConfig } from '../config.js';
import { openContainedRegularFileNoFollow } from '../files/workspace.js';
import { ArtifactError } from './errors.js';
import type { DocWorkerKind, ResourceGovernor } from './resource-governor.js';
import type { SandboxIsolationKind } from './types.js';

export const WORKER_RSS_LIMIT_MB: Record<DocWorkerKind, number> = {
  libreoffice: 768,
  chromium: 512,
  python: 512,
  ffmpeg: 512,
  resvg: 512,
};

export const WORKER_MAX_OUTPUT_BYTES = 100 * 1024 * 1024; // 100MB

export interface DocWorkerRlimits {
  /** RLIMIT_CPU in seconds (soft=hard). */
  cpuSeconds: number;
  /** RLIMIT_FSIZE in bytes (soft=hard). */
  fsizeBytes: number;
  /** RLIMIT_NOFILE open file descriptor cap (soft=hard). */
  nofile: number;
  /** RLIMIT_NPROC per-UID process/thread cap (soft=hard). */
  nproc: number;
}

export const WORKER_DEFAULT_RLIMITS: Record<DocWorkerKind, Omit<DocWorkerRlimits, 'cpuSeconds'>> = {
  libreoffice: { fsizeBytes: 128 * 1024 * 1024, nofile: 512, nproc: 1024 },
  chromium: { fsizeBytes: 128 * 1024 * 1024, nofile: 512, nproc: 1024 },
  python: { fsizeBytes: 128 * 1024 * 1024, nofile: 512, nproc: 512 },
  ffmpeg: { fsizeBytes: 128 * 1024 * 1024, nofile: 512, nproc: 512 },
  resvg: { fsizeBytes: 128 * 1024 * 1024, nofile: 512, nproc: 512 },
};

export interface SandboxWorkerRequest {
  kind: DocWorkerKind;
  command: string;
  args: string[];
  inputFiles?: Array<{ hostPath: string; sandboxName: string }>;
  expectedOutputRelPath?: string;
  timeoutMs?: number;
  rssLimitMb?: number;
  rlimits?: Partial<DocWorkerRlimits>;
  env?: Record<string, string>;
}

export interface SandboxWorkerResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputBuffer?: Buffer;
  isolation: SandboxIsolationKind;
  appliedRlimits: DocWorkerRlimits;
}

function resolvePrlimitBinary(): string | null {
  for (const candidate of ['/usr/bin/prlimit', '/bin/prlimit']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function wrapCommandWithRlimits(
  command: string,
  args: string[],
  rlimits: DocWorkerRlimits
): { command: string; args: string[] } {
  const prlimitBin = resolvePrlimitBinary();
  if (prlimitBin) {
    return {
      command: prlimitBin,
      args: [
        `--cpu=${rlimits.cpuSeconds}`,
        `--fsize=${rlimits.fsizeBytes}`,
        `--nofile=${rlimits.nofile}`,
        `--nproc=${rlimits.nproc}`,
        '--',
        command,
        ...args,
      ],
    };
  }
  // Fallback when prlimit binary is unavailable: bash ulimit (-f is in 512-byte blocks)
  const fsizeBlocks512 = Math.max(1, Math.ceil(rlimits.fsizeBytes / 512));
  const shellBin = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return {
    command: shellBin,
    args: [
      '-c',
      'ulimit -H -t "$1" -f "$2" -n "$3" -u "$4" 2>/dev/null; ulimit -S -t "$1" -f "$2" -n "$3" -u "$4" && shift 4 && exec "$@"',
      '--',
      String(rlimits.cpuSeconds),
      String(fsizeBlocks512),
      String(rlimits.nofile),
      String(rlimits.nproc),
      command,
      ...args,
    ],
  };
}

function readProcessTreeRssMb(rootPid: number): number {
  let totalKb = 0;
  const readOne = (pid: number) => {
    try {
      let measured = false;
      try {
        const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
        const pss = /^Pss:\s+(\d+)\s+kB$/m.exec(rollup);
        if (pss) {
          totalKb += Number(pss[1]);
          measured = true;
        }
      } catch {
        // smaps_rollup unavailable on older kernels or restricted procfs; fall back to VmRSS
      }
      if (!measured) {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        if (m) totalKb += Number(m[1]);
      }
    } catch {
      // process may have exited
    }
    try {
      const tasksDir = `/proc/${pid}/task`;
      for (const tid of fs.readdirSync(tasksDir)) {
        const childrenFile = path.join(tasksDir, tid, 'children');
        if (!fs.existsSync(childrenFile)) continue;
        const childrenRaw = fs.readFileSync(childrenFile, 'utf8').trim();
        if (!childrenRaw) continue;
        for (const childPidStr of childrenRaw.split(/\s+/)) {
          const childPid = Number.parseInt(childPidStr, 10);
          if (Number.isFinite(childPid) && childPid > 0) {
            readOne(childPid);
          }
        }
      }
    } catch {
      // ignore
    }
  };
  readOne(rootPid);
  return Math.floor(totalKb / 1024);
}

/**
 * Isolated external document/media worker runner (`SEC-04`, `PERF-02`, `ARCH-13`).
 * - Applies `bwrap --unshare-net --unshare-pid --die-with-parent`, manifest-limited `--ro-bind`, private out dir.
 * - Enforces kernel `RLIMIT_CPU`, `RLIMIT_FSIZE`, `RLIMIT_NOFILE`, and `RLIMIT_NPROC` strictly on this worker process.
 * - Enforces timeout and 250ms RSS watchdog with SIGKILL cleanup.
 * - Validates output via `openContainedRegularFileNoFollow` (full intermediate O_NOFOLLOW) and 100MB cap.
 * - Never affects normal ACP processes, Pure-JS operations, or legacy read-only PPTX->PDF viewing fallback.
 */
export class DocWorkerSandbox {
  constructor(
    private readonly config: AppConfig,
    private readonly governor: ResourceGovernor
  ) {}

  getIsolationStatus(): SandboxIsolationKind {
    const status = probeBwrapSandbox(this.config);
    if (status.active && status.backend === 'bwrap') {
      return 'bwrap';
    }
    if (this.config.allowUnsandboxedDocWorkers) {
      return 'unsandboxed_explicit';
    }
    return 'sandbox_required_blocked';
  }

  resolveRlimits(kind: DocWorkerKind, timeoutMs: number, overrides?: Partial<DocWorkerRlimits>): DocWorkerRlimits {
    const defaults = WORKER_DEFAULT_RLIMITS[kind];
    return {
      cpuSeconds: Math.max(1, Math.floor(overrides?.cpuSeconds ?? Math.ceil(timeoutMs / 1000))),
      fsizeBytes: Math.max(1024, Math.floor(overrides?.fsizeBytes ?? defaults.fsizeBytes)),
      nofile: Math.max(32, Math.floor(overrides?.nofile ?? defaults.nofile)),
      nproc: Math.max(32, Math.floor(overrides?.nproc ?? defaults.nproc)),
    };
  }

  async run(req: SandboxWorkerRequest): Promise<SandboxWorkerResult> {
    const isolation = this.getIsolationStatus();
    if (isolation === 'sandbox_required_blocked') {
      throw new ArtifactError(
        'SANDBOX_REQUIRED',
        '外部ドキュメントワーカーの実行には bubblewrap (bwrap) サンドボックスが必要です。開発/CI環境で明示許可する場合のみ ALLOW_UNSANDBOXED_DOC_WORKERS=1 を設定してください。',
        503
      );
    }

    return this.governor.runWithBudget(req.kind, async () => {
      const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), `agy-doc-worker-${crypto.randomUUID().slice(0, 8)}-`));
      const inputDir = path.join(workRoot, 'in');
      const outputDir = path.join(workRoot, 'out');
      const tmpDir = path.join(workRoot, 'tmp');
      fs.mkdirSync(inputDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

      try {
        const timeoutMs = req.timeoutMs ?? this.config.docWorkerTimeoutMs;
        const rssLimitMb = req.rssLimitMb ?? WORKER_RSS_LIMIT_MB[req.kind];
        const appliedRlimits = this.resolveRlimits(req.kind, timeoutMs, req.rlimits);
        const rlimited = wrapCommandWithRlimits(req.command, req.args, appliedRlimits);

        let spawnCmd = rlimited.command;
        let spawnArgs = rlimited.args;
        const env: Record<string, string> = {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: tmpDir,
          TMPDIR: tmpDir,
          AGY_WORKER_IN_DIR: isolation === 'bwrap' ? '/work/in' : inputDir,
          AGY_WORKER_OUT_DIR: isolation === 'bwrap' ? '/work/out' : outputDir,
          ...(req.env ?? {}),
        };

        if (isolation === 'bwrap') {
          const bwrapArgs: string[] = [
            '--unshare-all',
            '--unshare-net',
            '--die-with-parent',
            '--new-session',
            '--proc', '/proc',
            '--dev', '/dev',
            '--tmpfs', '/tmp',
            '--ro-bind', '/usr', '/usr',
          ];
          for (const sysDir of ['/bin', '/lib', '/lib64', '/etc/fonts', '/etc/alternatives', '/etc/libreoffice', '/etc/ld.so.cache']) {
            if (fs.existsSync(sysDir)) {
              bwrapArgs.push('--ro-bind', sysDir, sysDir);
            }
          }
          if (fs.existsSync(this.config.docRuntimeDir)) {
            bwrapArgs.push('--ro-bind', this.config.docRuntimeDir, '/opt/agy-doc-runtime');
          }
          bwrapArgs.push('--dir', '/work', '--dir', '/work/in', '--bind', outputDir, '/work/out', '--bind', tmpDir, '/work/tmp');
          for (const inp of req.inputFiles ?? []) {
            const safeName = path.basename(inp.sandboxName);
            bwrapArgs.push('--ro-bind', inp.hostPath, `/work/in/${safeName}`);
          }
          bwrapArgs.push('--chdir', '/work/tmp', '--', rlimited.command, ...rlimited.args);
          spawnCmd = this.config.bwrapBin;
          spawnArgs = bwrapArgs;
          env.HOME = '/work/tmp';
          env.TMPDIR = '/work/tmp';
        } else {
          // Explicit unsandboxed dev/CI mode: copy manifest inputs into isolated inputDir
          for (const inp of req.inputFiles ?? []) {
            const safeName = path.basename(inp.sandboxName);
            fs.copyFileSync(inp.hostPath, path.join(inputDir, safeName));
          }
        }

        const result = await new Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(spawnCmd, spawnArgs, {
              cwd: tmpDir,
              env,
              stdio: ['ignore', 'pipe', 'pipe'],
              detached: isolation !== 'bwrap',
            });

            const killWorker = () => {
              try {
                if (isolation === 'bwrap') child.kill('SIGKILL');
                else if (child.pid) process.kill(-child.pid, 'SIGKILL');
              } catch {
                // The process may have already exited.
              }
            };

            let stdout = '';
            let stderr = '';
            let killedReason: ArtifactError | null = null;
            let settled = false;

            child.stdout?.on('data', (chunk: Buffer) => {
              if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8');
            });
            child.stderr?.on('data', (chunk: Buffer) => {
              if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8');
            });

            const timer = setTimeout(() => {
              killedReason = new ArtifactError(
                'DOC_WORKER_TIMEOUT',
                `ドキュメント処理が制限時間（${timeoutMs}ms）を超過しました。`,
                504
              );
              killWorker();
            }, timeoutMs);

            const rssWatchdog = setInterval(() => {
              if (!child.pid) return;
              const rssMb = readProcessTreeRssMb(child.pid);
              if (rssMb > rssLimitMb) {
                killedReason = new ArtifactError(
                  'DOC_WORKER_RSS_EXCEEDED',
                  `ドキュメント処理がメモリ上限（${rssLimitMb}MB）を超過しました（${rssMb}MB）。`,
                  503
                );
                killWorker();
              }
            }, 250);
            rssWatchdog.unref();

            const finish = () => {
              clearTimeout(timer);
              clearInterval(rssWatchdog);
            };

            child.on('error', (err) => {
              if (settled) return;
              settled = true;
              finish();
              reject(new ArtifactError('DOC_WORKER_SPAWN_FAILED', err.message, 500));
            });

            child.on('close', (code, signal) => {
              if (settled) return;
              settled = true;
              finish();
              if (killedReason) {
                reject(killedReason);
                return;
              }
              resolve({ exitCode: code ?? (signal ? 128 : 1), signal, stdout, stderr });
            });
          }
        );

        let outputBuffer: Buffer | undefined;
        if (req.expectedOutputRelPath && result.exitCode === 0) {
          // Validate output strictly after worker exit via full-intermediate O_NOFOLLOW + 100MB cap
          const opened = openContainedRegularFileNoFollow(outputDir, req.expectedOutputRelPath, {
            maxBytes: WORKER_MAX_OUTPUT_BYTES,
          });
          try {
            outputBuffer = fs.readFileSync(opened.fd);
          } finally {
            fs.closeSync(opened.fd);
          }
        }

        return {
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          outputBuffer,
          isolation,
          appliedRlimits,
        };
      } finally {
        fs.rmSync(workRoot, { recursive: true, force: true });
      }
    });
  }
}
