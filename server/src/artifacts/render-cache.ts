import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';
import { fsyncDir } from '../files/workspace.js';
import { canonicalJson } from './idempotency-coordinator.js';

const execFileAsync = promisify(execFile);

export interface RenderCacheKeyInput {
  artifactId: string;
  revision: number;
  sha256: string;
  dependencyManifestHash: string | null;
  variant: string;
  pageOrSlide?: number | string | null;
  dpi?: number | null;
  viewportW?: number | null;
  viewportH?: number | null;
  theme?: string | null;
  engineVersion?: string;
  fontConfigHash?: string;
  renderOptions?: Record<string, unknown>;
}

export type PptxPdfConverterFn = (params: {
  stagedInputPath: string;
  sourceAbsPath: string;
  sourceFilename: string;
  revision: number;
  sourceSha256: string;
  dependencyManifestHash: string | null;
  cacheKey: string;
  tmpTargetPath: string;
}) => Promise<boolean>;

/**
 * Single-flight, atomic-rename, LRU-bounded render cache manager (`ARCH-08`, `ARCH-13`).
 * Also preserves existing read-only PPTX->PDF viewing conversion even when `bwrap` is absent in `auto`/`off` mode.
 */
export class RenderCacheManager {
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private pptxConverterOverride: PptxPdfConverterFn | null = null;

  constructor(private readonly config: AppConfig) {
    fs.mkdirSync(config.artifactsCacheRoot, { recursive: true, mode: 0o700 });
  }

  /**
   * Test-only hook to deterministically inspect PPTX->PDF render cache inputs & cache keys
   * without requiring LibreOffice in CI/unit tests.
   */
  setPptxConverterOverrideForTest(fn: PptxPdfConverterFn | null): void {
    this.pptxConverterOverride = fn;
  }

  computeCacheKey(input: RenderCacheKeyInput): string {
    return crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          artifactId: input.artifactId,
          revision: input.revision,
          sha256: input.sha256,
          dependencyManifestHash: input.dependencyManifestHash ?? null,
          variant: input.variant,
          pageOrSlide: input.pageOrSlide ?? null,
          dpi: input.dpi ?? null,
          viewportW: input.viewportW ?? null,
          viewportH: input.viewportH ?? null,
          theme: input.theme ?? null,
          engineVersion: input.engineVersion ?? 'v1',
          fontConfigHash: input.fontConfigHash ?? 'default',
          renderOptions: input.renderOptions ?? {},
        })
      )
      .digest('hex');
  }

  getCacheEntryPath(cacheKey: string, ext: string): string {
    const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
    return path.join(this.config.artifactsCacheRoot, cacheKey.slice(0, 2), `${cacheKey}${cleanExt}`);
  }

  async getOrRender(params: {
    keyInput: RenderCacheKeyInput;
    ext: string;
    produce: (tmpTargetPath: string) => Promise<boolean>;
  }): Promise<string | null> {
    const cacheKey = this.computeCacheKey(params.keyInput);
    const finalPath = this.getCacheEntryPath(cacheKey, params.ext);
    if (fs.existsSync(finalPath)) {
      try {
        const now = new Date();
        fs.utimesSync(finalPath, now, now);
      } catch {
        // ignore touch failure
      }
      return finalPath;
    }

    const existingFlight = this.inFlight.get(finalPath);
    if (existingFlight) {
      return existingFlight;
    }

    const promise = (async (): Promise<string | null> => {
      const parentDir = path.dirname(finalPath);
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
      const tmpPath = path.join(parentDir, `.render-${crypto.randomUUID()}${params.ext.startsWith('.') ? params.ext : `.${params.ext}`}`);
      try {
        const ok = await params.produce(tmpPath);
        if (!ok || !fs.existsSync(tmpPath)) {
          fs.rmSync(tmpPath, { force: true });
          return null;
        }
        fs.renameSync(tmpPath, finalPath);
        fsyncDir(parentDir);
        this.enforceLruBudget();
        return finalPath;
      } catch {
        fs.rmSync(tmpPath, { force: true });
        return null;
      }
    })();

    this.inFlight.set(finalPath, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(finalPath);
    }
  }

  /**
   * Read-only PPTX->PDF viewing conversion preserving existing compatibility on hosts without bwrap (`ARCH-08`, `ARCH-13`).
   * When `sourceAbsPath` is a revision-pinned immutable `.blob` file, stages a copy with the original `.pptx` extension
   * inside the temporary conversion directory so LibreOffice reliably identifies the presentation format.
   */
  async renderPresentationToPdf(params: {
    artifactId: string;
    revision: number;
    sourceAbsPath: string;
    sourceFilename?: string;
    sourceSha256: string;
    dependencyManifestHash?: string | null;
  }): Promise<string | null> {
    const keyInput: RenderCacheKeyInput = {
      artifactId: params.artifactId,
      revision: params.revision,
      sha256: params.sourceSha256,
      dependencyManifestHash: params.dependencyManifestHash ?? null,
      variant: 'pptx_view_pdf',
      engineVersion: 'libreoffice-view-v1',
    };
    const cacheKey = this.computeCacheKey(keyInput);
    const rawName = path.basename(params.sourceFilename || params.sourceAbsPath).replace(/[^a-zA-Z0-9._-]/g, '_');
    const stagedName = /\.(pptx|ppt|odp)$/i.test(rawName) ? rawName : `${rawName || 'presentation'}.pptx`;

    return this.getOrRender({
      keyInput,
      ext: '.pdf',
      produce: async (tmpTargetPath) => {
        const workDir = fs.mkdtempSync(path.join(this.config.artifactsCacheRoot, '.lo-view-'));
        const loProfileDir = path.join(workDir, 'profile');
        fs.mkdirSync(loProfileDir, { recursive: true, mode: 0o700 });
        try {
          const inputDir = path.join(workDir, 'input');
          fs.mkdirSync(inputDir, { recursive: true, mode: 0o700 });
          const stagedInputPath = path.join(inputDir, stagedName);
          fs.copyFileSync(params.sourceAbsPath, stagedInputPath);

          if (this.pptxConverterOverride) {
            return await this.pptxConverterOverride({
              stagedInputPath,
              sourceAbsPath: params.sourceAbsPath,
              sourceFilename: stagedName,
              revision: params.revision,
              sourceSha256: params.sourceSha256,
              dependencyManifestHash: params.dependencyManifestHash ?? null,
              cacheKey,
              tmpTargetPath,
            });
          }

          await execFileAsync(
            this.config.libreOfficeBin,
            [
              `-env:UserInstallation=file://${loProfileDir}`,
              '--headless',
              '--norestore',
              '--convert-to',
              'pdf',
              '--outdir',
              workDir,
              stagedInputPath,
            ],
            {
              timeout: 30_000,
              env: { ...process.env, SAL_USE_VCLPLUGIN: 'svp' },
            }
          );
          const base = path.basename(stagedInputPath, path.extname(stagedInputPath));
          const expected = path.join(workDir, `${base}.pdf`);
          const found = fs.existsSync(expected)
            ? expected
            : (() => {
                const match = fs.readdirSync(workDir).find((f) => f.toLowerCase().endsWith('.pdf'));
                return match ? path.join(workDir, match) : null;
              })();
          if (!found) return false;
          fs.copyFileSync(found, tmpTargetPath);
          return true;
        } catch {
          return false;
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
      },
    });
  }

  enforceLruBudget(maxBytesOverride?: number): { deletedFiles: number; reclaimedBytes: number } {
    const maxBytes = maxBytesOverride ?? this.config.artifactCacheMaxMb * 1024 * 1024;
    const entries: Array<{ fullPath: string; size: number; atimeMs: number }> = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!e.name.startsWith('.lo-view-')) walk(full);
        } else if (e.isFile() && !e.name.startsWith('.render-')) {
          try {
            const st = fs.statSync(full);
            entries.push({ fullPath: full, size: st.size, atimeMs: st.atimeMs || st.mtimeMs });
          } catch {
            // ignore
          }
        }
      }
    };
    walk(this.config.artifactsCacheRoot);

    let totalBytes = entries.reduce((acc, e) => acc + e.size, 0);
    if (totalBytes <= maxBytes) return { deletedFiles: 0, reclaimedBytes: 0 };

    entries.sort((a, b) => a.atimeMs - b.atimeMs);
    let deletedFiles = 0;
    let reclaimedBytes = 0;
    for (const item of entries) {
      if (totalBytes <= maxBytes) break;
      try {
        fs.unlinkSync(item.fullPath);
        totalBytes -= item.size;
        deletedFiles += 1;
        reclaimedBytes += item.size;
      } catch {
        // ignore
      }
    }
    return { deletedFiles, reclaimedBytes };
  }
}
