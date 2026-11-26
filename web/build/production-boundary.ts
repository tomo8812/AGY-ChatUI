import path from 'node:path';

const FORBIDDEN_ROOT_PREFIXES = ['e2e/', 'tests/', '__tests__/', 'playwright-report/', 'test-results/'];
const FORBIDDEN_SEGMENT_RE = /(?:^|\/)(?:__tests__|__mocks__|fixtures|mock-acp-agent|mock-artifact-fixtures|syntheticAssets)(?:\/|\.[jt]sx?$|$)/i;
const FORBIDDEN_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Verifies that no test-only fixtures, specs, or mock harnesses enter the
 * production web bundle graph (`NEG-11` / Spec §8).
 * External third-party modules inside `node_modules/` are permitted.
 */
export function assertProductionModulePaths(moduleIds: readonly string[], rootDir: string): void {
  const resolvedRoot = path.resolve(rootDir);
  const violations: string[] = [];

  for (const rawId of moduleIds) {
    if (!rawId || rawId.startsWith('\0') || rawId.startsWith('virtual:')) continue;
    const cleanId = rawId.split('?')[0].split('#')[0];
    if (!cleanId) continue;

    const abs = path.isAbsolute(cleanId) ? path.resolve(cleanId) : path.resolve(resolvedRoot, cleanId);
    const rel = path.relative(resolvedRoot, abs).split(path.sep).join('/');

    // Ignore external dependencies under node_modules or outside workspace root
    if (rel.startsWith('..') || rel.startsWith('node_modules/') || rel.includes('/node_modules/')) {
      continue;
    }

    if (
      FORBIDDEN_ROOT_PREFIXES.some((prefix) => rel.startsWith(prefix)) ||
      FORBIDDEN_SEGMENT_RE.test(rel) ||
      FORBIDDEN_FILE_RE.test(rel)
    ) {
      violations.push(rel);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Production bundle must not include test-only modules: ${violations.join(', ')}`,
    );
  }
}
