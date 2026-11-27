import path from 'node:path';
import ts from 'typescript';

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

/** Inspect static literals in first-party modules that actually entered the bundle. */
export function assertProductionModuleContent(filename: string, source: string): void {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const violations = new Set<number>();
  const reject = (node: ts.Node) => violations.add(parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1);
  const literalKeys = (object: ts.ObjectLiteralExpression) => new Map(object.properties.flatMap(property =>
    ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? [[property.name.text.toLowerCase(), property.initializer] as const] : []));
  const staticValue = (node: ts.Node): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return staticValue(node.expression);
    }
    if (ts.isObjectLiteralExpression(node)) return node.properties.every(property =>
      ts.isPropertyAssignment(property) && staticValue(property.initializer));
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(staticValue);
    return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        /^(?:demo|mock|fixture|synthetic)(?:Data|Rows|Series|Document|Content|Assets|Widgets|Scenario)/i.test(node.name.text) &&
        node.initializer && staticValue(node.initializer)) reject(node);
    if (ts.isObjectLiteralExpression(node)) {
      const fields = literalKeys(node);
      const has = (...names: string[]) => names.every(name => fields.has(name));
      const containsDemoShape =
        (has('city', 'temperature', 'condition') || has('ticker', 'price', 'change') ||
          has('symbol', 'price', 'change') || has('schemaversion', 'root')) &&
        [...fields.values()].every(staticValue);
      if (containsDemoShape) reject(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (violations.size) throw new Error(`Production bundle includes fixed demo data at ${filename}:${[...violations].join(', ')}`);
}
