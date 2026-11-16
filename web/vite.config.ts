import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function resolveWebBuildVersion(): string {
  const fromEnv = (process.env.VITE_APP_VERSION || process.env.APP_VERSION || '').trim();
  if (fromEnv) return fromEnv.replace(/^v/, '');
  try {
    const rootPkg = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')
    ) as { version?: string };
    if (rootPkg.version) return rootPkg.version;
  } catch {
    // ignore
  }
  return '1.0.0';
}

function resolveWebCommitSha(): string {
  const fromEnv = (process.env.VITE_APP_COMMIT_SHA || process.env.GITHUB_SHA || '').trim();
  if (fromEnv) return fromEnv.slice(0, 8);
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(resolveWebBuildVersion()),
    __APP_COMMIT_SHA__: JSON.stringify(resolveWebCommitSha()),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api/ws': {
        target: 'ws://127.0.0.1:3000',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
