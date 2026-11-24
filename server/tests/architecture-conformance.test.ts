import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_SRC = path.join(REPO_ROOT, 'server', 'src');

interface Violation {
  rule: string;
  file: string;
  line: number;
  message: string;
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Creates a TypeScript Program over `server/src` with optional virtual file overlays
 * so negative self-tests (`NEG-01`, `NEG-02`, `NEG-05`, `NEG-11`) run the exact same compiler AST analyzer.
 */
function createInMemoryProgram(virtualOverrides: Map<string, string> = new Map()): ts.Program {
  const realFiles = collectTsFiles(SERVER_SRC);
  const allFiles = [...new Set([...realFiles, ...virtualOverrides.keys()])];
  const baseHost = ts.createCompilerHost({
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
  });

  const customHost: ts.CompilerHost = {
    ...baseHost,
    fileExists: (fileName) => virtualOverrides.has(path.resolve(fileName)) || baseHost.fileExists(fileName),
    readFile: (fileName) => virtualOverrides.get(path.resolve(fileName)) ?? baseHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const abs = path.resolve(fileName);
      const virtual = virtualOverrides.get(abs);
      if (virtual !== undefined) {
        return ts.createSourceFile(abs, virtual, languageVersion, true);
      }
      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
  };

  return ts.createProgram(allFiles, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
  }, customHost);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function relToRepo(absFile: string): string {
  return path.relative(REPO_ROOT, absFile).split(path.sep).join('/');
}

/**
 * ARCH-01 / NEG-01: Gateway-removal static graph & AST inspection.
 * With `ArtifactService` removed from the graph, routes, link-resolver, files/artifacts, MCP, rich, and edit-requests
 * must have ZERO direct artifact/project_file DB mutations, ZERO bypass workspace/project file writes,
 * and ZERO direct `artifact.created`/`artifact.updated` SyncHub emissions outside `ArtifactService` & `client-manager.ts`.
 */
function checkGatewayRemovalConformance(program: ts.Program): Violation[] {
  const violations: Violation[] = [];
  const forbiddenDbMethods = new Set([
    'upsertArtifact',
    'upsertProjectFile',
    'upsertProjectFileInTx',
    'deleteProjectFile',
  ]);
  const forbiddenFsWriteMethods = new Set([
    'writeFile',
    'writeFileSync',
    'copyFile',
    'copyFileSync',
    'appendFile',
    'appendFileSync',
  ]);

  const checkedDirs = [
    'server/src/routes/',
    'server/src/files/',
    'server/src/mcp/',
    'server/src/rich/',
    'server/src/edit-requests/',
  ];
  const allowedLowLevelFiles = new Set([
    'server/src/files/workspace.ts',
    'server/src/mcp/mcp-service.ts', // manages mcp_config.json inside profile dir
  ]);

  for (const sf of program.getSourceFiles()) {
    const rel = relToRepo(sf.fileName);
    if (!checkedDirs.some((d) => rel.startsWith(d))) continue;
    if (allowedLowLevelFiles.has(rel)) continue;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        // 1. Direct DB mutation bypass (upsertArtifact / upsertProjectFile / deleteProjectFile on db, not artifactService)
        if (ts.isPropertyAccessExpression(expr) && forbiddenDbMethods.has(expr.name.text)) {
          const receiverText = expr.expression.getText(sf);
          if (!receiverText.endsWith('artifactService')) {
            violations.push({
              rule: 'ARCH-01',
              file: rel,
              line: lineOf(sf, node),
              message: `Forbidden direct DB mutation '${expr.name.text}' bypassing ArtifactService.`,
            });
          }
        }
        // 2. Direct fs.writeFile / fs.promises.writeFile / fs.copyFile inside routes or files helpers
        if (
          (rel.startsWith('server/src/routes/') || rel.startsWith('server/src/files/')) &&
          ts.isPropertyAccessExpression(expr) &&
          forbiddenFsWriteMethods.has(expr.name.text)
        ) {
          violations.push({
            rule: 'ARCH-01',
            file: rel,
            line: lineOf(sf, node),
            message: `Forbidden direct filesystem write '${expr.name.text}' bypassing ArtifactService.`,
          });
        }
        // 3. Direct SyncHub artifact.created / artifact.updated emission in routes/files/rich/edit-requests
        if (
          ts.isPropertyAccessExpression(expr) &&
          expr.name.text === 'emitDurable' &&
          node.arguments.length > 0 &&
          ts.isObjectLiteralExpression(node.arguments[0])
        ) {
          for (const prop of node.arguments[0].properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === 'type' &&
              ts.isStringLiteral(prop.initializer) &&
              (prop.initializer.text === 'artifact.created' || prop.initializer.text === 'artifact.updated')
            ) {
              violations.push({
                rule: 'ARCH-01',
                file: rel,
                line: lineOf(sf, node),
                message: `Forbidden direct SyncHub '${prop.initializer.text}' emission bypassing ArtifactService.`,
              });
            }
          }
        }
        // 4. Direct SQL mutation against artifacts or project_files outside ArtifactService / database.ts
        if (
          ts.isPropertyAccessExpression(expr) &&
          (expr.name.text === 'prepare' || expr.name.text === 'exec') &&
          node.arguments.length > 0 &&
          (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
        ) {
          const sql = node.arguments[0].text;
          if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:artifacts|project_files)\b/i.test(sql)) {
            violations.push({
              rule: 'ARCH-01',
              file: rel,
              line: lineOf(sf, node),
              message: `Forbidden direct SQL mutation on artifacts/project_files bypassing ArtifactService.`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}

/**
 * ARCH-10 / NEG-02: Format adapter strict isolation.
 * Individual adapters under `server/src/artifacts/adapters/` (excluding `base.ts` and `registry.ts`)
 * must NOT import other adapters, `node:fs`, `database`, `hub`, or `artifact-service`.
 */
function checkAdapterIsolationConformance(program: ts.Program): Violation[] {
  const violations: Violation[] = [];
  for (const sf of program.getSourceFiles()) {
    const rel = relToRepo(sf.fileName);
    if (!rel.startsWith('server/src/artifacts/adapters/')) continue;
    const base = path.basename(rel);
    if (base === 'base.ts' || base === 'registry.ts') continue;

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (spec === 'node:fs' || spec === 'fs' || spec === 'node:fs/promises') {
          violations.push({
            rule: 'ARCH-10',
            file: rel,
            line: lineOf(sf, node),
            message: `Adapter must not import filesystem module '${spec}'.`,
          });
        }
        if (spec.includes('database') || spec.includes('sync/hub') || spec.includes('artifact-service')) {
          violations.push({
            rule: 'ARCH-10',
            file: rel,
            line: lineOf(sf, node),
            message: `Adapter must not import persistence/notification module '${spec}'.`,
          });
        }
        if (spec.startsWith('./') && spec !== './base.js' && spec.endsWith('-adapter.js')) {
          violations.push({
            rule: 'ARCH-10',
            file: rel,
            line: lineOf(sf, node),
            message: `Adapter must not directly import another adapter '${spec}'.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}

/**
 * RICH-ARCH-07 / NEG-05: Strict ban on dynamic code execution (eval / new Function / vm) inside `server/src/rich/`.
 * Scoped strictly to Rich UI modules (never restricts existing HTML sandbox or ACP).
 */
function checkRichCodeExecutionBan(program: ts.Program): Violation[] {
  const violations: Violation[] = [];
  for (const sf of program.getSourceFiles()) {
    const rel = relToRepo(sf.fileName);
    if (!rel.startsWith('server/src/rich/')) continue;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && (node.expression.text === 'eval' || node.expression.text === 'Function')) {
          violations.push({
            rule: 'RICH-ARCH-07',
            file: rel,
            line: lineOf(sf, node),
            message: `Forbidden dynamic code execution '${node.expression.text}()' inside rich UI module.`,
          });
        }
      }
      if (ts.isNewExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
          violations.push({
            rule: 'RICH-ARCH-07',
            file: rel,
            line: lineOf(sf, node),
            message: `Forbidden 'new Function()' inside rich UI module.`,
          });
        }
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (spec === 'node:vm' || spec === 'vm' || spec === 'node:child_process' || spec === 'child_process') {
          violations.push({
            rule: 'RICH-ARCH-07',
            file: rel,
            line: lineOf(sf, node),
            message: `Forbidden runtime module '${spec}' inside Pure-JS rich UI module.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}

/**
 * UX-10 / NEG-11: Ensure production server code does not reference test fixtures or test helpers.
 */
function checkNoTestFixtureLeakage(program: ts.Program): Violation[] {
  const violations: Violation[] = [];
  for (const sf of program.getSourceFiles()) {
    const rel = relToRepo(sf.fileName);
    if (!rel.startsWith('server/src/')) continue;
    if (rel.includes('mock-acp-agent') || rel.includes('mock-artifact-fixtures')) continue;

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (/(?:^|\/)(?:tests|__fixtures__|fixtures)\//.test(spec)) {
          violations.push({
            rule: 'UX-10',
            file: rel,
            line: lineOf(sf, node),
            message: `Production module imports test/fixture path '${spec}'.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}

describe('Architecture Conformance & Negative Self-Tests (ARCH-01, ARCH-10, ARCH-15, NEG-01, NEG-02, NEG-05, NEG-11)', () => {
  it('passes all conformance checks on the real codebase with 0 violations', () => {
    const program = createInMemoryProgram();
    expect(checkGatewayRemovalConformance(program)).toEqual([]);
    expect(checkAdapterIsolationConformance(program)).toEqual([]);
    expect(checkRichCodeExecutionBan(program)).toEqual([]);
    expect(checkNoTestFixtureLeakage(program)).toEqual([]);

    // ARCH-15: Verify --disable-telemetry is preserved in ACP process launch
    const envIsoSrc = fs.readFileSync(path.join(SERVER_SRC, 'acp', 'env-isolation.ts'), 'utf8');
    expect(envIsoSrc).toContain('--disable-telemetry');
  });

  it('NEG-01: fails gateway-removal check when a route bypasses ArtifactService with direct DB/FS/SyncHub calls', () => {
    const injectedFile = path.join(SERVER_SRC, 'routes', '__neg01_bypass_route.ts');
    const program = createInMemoryProgram(
      new Map([
        [
          injectedFile,
          `
            import fs from 'node:fs';
            export async function badRoute(db: any, hub: any) {
              await fs.promises.writeFile('/tmp/x', 'bypass');
              db.upsertArtifact({ id: 'x' });
              hub.emitDurable({ userId: 'u', type: 'artifact.updated', payload: {} });
            }
          `,
        ],
      ])
    );
    const violations = checkGatewayRemovalConformance(program);
    expect(violations.length).toBeGreaterThanOrEqual(3);
    expect(violations.some((v) => v.message.includes('writeFile'))).toBe(true);
    expect(violations.some((v) => v.message.includes('upsertArtifact'))).toBe(true);
    expect(violations.some((v) => v.message.includes('artifact.updated'))).toBe(true);
  });

  it('NEG-02: fails adapter isolation check when an adapter imports another adapter, fs, or SyncHub', () => {
    const injectedAdapter = path.join(SERVER_SRC, 'artifacts', 'adapters', '__neg02_bad-adapter.ts');
    const program = createInMemoryProgram(
      new Map([
        [
          injectedAdapter,
          `
            import fs from 'node:fs';
            import { CsvAdapter } from './csv-adapter.js';
            import { SyncHub } from '../../sync/hub.js';
            export { fs, CsvAdapter, SyncHub };
          `,
        ],
      ])
    );
    const violations = checkAdapterIsolationConformance(program);
    expect(violations.length).toBe(3);
  });

  it('NEG-05: fails rich UI code-execution ban when eval or new Function is introduced under server/src/rich/', () => {
    const injectedRich = path.join(SERVER_SRC, 'rich', '__neg05_evil_eval.ts');
    const program = createInMemoryProgram(
      new Map([
        [
          injectedRich,
          `
            export function badEval(code: string) {
              const a = eval(code);
              const b = new Function('return 1')();
              return a + b;
            }
          `,
        ],
      ])
    );
    const violations = checkRichCodeExecutionBan(program);
    expect(violations.length).toBe(2);
    expect(violations.some((v) => v.message.includes('eval'))).toBe(true);
    expect(violations.some((v) => v.message.includes('new Function'))).toBe(true);
  });

  it('NEG-11: fails fixture-hygiene check when production code imports a test fixture', () => {
    const injectedProd = path.join(SERVER_SRC, 'routes', '__neg11_fixture_leak.ts');
    const program = createInMemoryProgram(
      new Map([
        [
          injectedProd,
          `
            import { demoData } from '../../tests/fixtures/demo-data.js';
            export const leaked = demoData;
          `,
        ],
      ])
    );
    const violations = checkNoTestFixtureLeakage(program);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('UX-10');
  });
});
