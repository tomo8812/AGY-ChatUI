import path from 'node:path';

/**
 * Ensures the production web bundle never pulls in test-only assets,
 * Playwright fixtures, or test specs outside node_modules.
 */
export function assertProductionModulePaths(moduleIds: readonly string[], repoRoot: string): void {
  const root = path.resolve(repoRoot);
  const forbidden: string[] = [];
  for (const rawId of moduleIds) {
    if (!rawId || rawId.startsWith('\0')) continue;
    const cleanId = rawId.split('?')[0].split('#')[0];
    if (!path.isAbsolute(cleanId)) continue;
    const rel = path.relative(root, cleanId).split(path.sep).join('/');
    if (rel.startsWith('..') || rel.startsWith('node_modules/') || rel.includes('/node_modules/')) {
      continue;
    }
    if (
      rel.startsWith('e2e/') ||
      rel.startsWith('server/tests/') ||
      rel.includes('/__tests__/') ||
      /\.(test|spec)\.[jt]sx?$/.test(rel)
    ) {
      forbidden.push(rel);
    }
  }
  if (forbidden.length > 0) {
    throw new Error(`Production bundle imported test-only modules: ${forbidden.join(', ')}`);
  }
}
