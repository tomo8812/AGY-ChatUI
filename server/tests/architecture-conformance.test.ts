import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { ArtifactService } from '../src/artifacts/artifact-service.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_SRC = path.join(REPO_ROOT, 'server', 'src');

interface Violation {
  rule: string;
  file: string;
  line: number;
  message: string;
  chain?: string[];
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
  const normalizedOverrides = new Map<string, string>();
  for (const [k, v] of virtualOverrides) {
    normalizedOverrides.set(path.resolve(k), v);
  }
  const allFiles = [...new Set([...realFiles, ...normalizedOverrides.keys()])];
  const baseHost = ts.createCompilerHost({
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
  });

  const customHost: ts.CompilerHost = {
    ...baseHost,
    fileExists: (fileName) => normalizedOverrides.has(path.resolve(fileName)) || baseHost.fileExists(fileName),
    readFile: (fileName) => normalizedOverrides.get(path.resolve(fileName)) ?? baseHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const abs = path.resolve(fileName);
      const virtual = normalizedOverrides.get(abs);
      if (virtual !== undefined) {
        return ts.createSourceFile(abs, virtual, languageVersion, true);
      }
      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
  };

  return ts.createProgram(
    allFiles,
    {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
    },
    customHost
  );
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function relToRepo(absFile: string): string {
  return path.relative(REPO_ROOT, absFile).split(path.sep).join('/');
}

/**
 * Permitted single gateway (`ArtifactService`) and its owned internal sub-modules.
 * Removed from the dependency graph during `ARCH-01` gateway-removal reachability analysis.
 */
const GATEWAY_MODULES = new Set([
  'server/src/artifacts/artifact-service.ts',
  'server/src/artifacts/batch-restore.ts',
  'server/src/artifacts/blob-store.ts',
  'server/src/artifacts/commit-recovery.ts',
  'server/src/artifacts/dep-propagation.ts',
  'server/src/artifacts/idempotency-coordinator.ts',
  'server/src/artifacts/render-cache.ts',
  'server/src/artifacts/sandbox-worker.ts',
  'server/src/artifacts/undo-service.ts',
]);

/**
 * Non-artifact infrastructure leaf modules whose internal implementation is outside
 * the ArtifactService responsibility boundary (profile settings, skills, MCP config JSON,
 * SQLite repository class, low-level workspace FS primitives, SyncHub implementation, OAuth/push).
 * Note: CALLERS of mutating methods on `database.ts`, `workspace.ts`, or `sync/hub.ts` ARE inspected.
 */
const NON_ARTIFACT_INFRA_LEAVES = new Set([
  'server/src/db/database.ts',
  'server/src/files/workspace.ts',
  'server/src/sync/hub.ts',
  'server/src/skills/skill-service.ts',
  'server/src/skills/builtin-skills.ts',
  'server/src/mcp/mcp-service.ts',
  'server/src/acp/env-isolation.ts',
  'server/src/acp/profile-settings.ts',
  'server/src/acp/quota-service.ts',
  'server/src/auth/agy-auth.ts',
  'server/src/notifications/web-push.ts',
  'server/src/acp/mock-acp-agent.ts',
  'server/src/acp/mock-artifact-fixtures.ts',
]);

function resolveRelativeModule(fromRel: string, specifier: string, knownRelFiles: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const fromDir = path.posix.dirname(fromRel);
  const rawJoined = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates: string[] = [];
  if (rawJoined.endsWith('.js') || rawJoined.endsWith('.mjs')) {
    candidates.push(rawJoined.replace(/\.(?:m?js)$/, '.ts'));
  }
  candidates.push(rawJoined);
  candidates.push(`${rawJoined}.ts`);
  candidates.push(path.posix.join(rawJoined, 'index.ts'));
  for (const c of candidates) {
    if (knownRelFiles.has(c)) return c;
  }
  return null;
}

function extractValueImportEdges(sf: ts.SourceFile, fromRel: string, knownRelFiles: Set<string>): string[] {
  const targets = new Set<string>();
  const addSpec = (spec: string) => {
    const resolved = resolveRelativeModule(fromRel, spec, knownRelFiles);
    if (resolved) targets.add(resolved);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) {
        addSpec(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) {
        addSpec(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node)) {
      // Dynamic import('./foo.js') or require('./foo.js')
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        addSpec(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...targets];
}

function isInsideNativeAcpWriteTextFileHandler(node: ts.Node, sf: ts.SourceFile): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      cur.expression.name.text === 'onRequest' &&
      cur.arguments.length >= 2 &&
      cur.arguments[0].getText(sf).includes('methods.client.fs.writeTextFile')
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

/**
 * ARCH-01 / NEG-01: Gateway-removal static dependency & reachability graph inspection.
 *
 * 1. Builds the complete module import graph across all `server/src/**\/*.ts`.
 * 2. Removes `ArtifactService` and its owned internal modules (`GATEWAY_MODULES`) from the graph.
 * 3. Runs BFS reachability from all application entry points (server bootstrap, routes, ACP bridge,
 *    files/link helpers, rich, edit-requests) to discover EVERY reachable module regardless of directory name.
 * 4. Verifies that NO reachable module in `G \ GATEWAY_MODULES` contains a direct or helper-mediated
 *    sink for (a) file mutation/deletion, (b) artifact/project_file/project/chat-deletion DB mutation,
 *    or (c) `artifact.*`/`project.deleted`/`chat.deleted` SyncHub notifications.
 */
function checkGatewayRemovalConformance(program: ts.Program): Violation[] {
  // Ensure parent pointers are bound on every AST node in the TypeScript program
  program.getTypeChecker();

  const sourceByRel = new Map<string, ts.SourceFile>();
  for (const sf of program.getSourceFiles()) {
    const rel = relToRepo(sf.fileName);
    if (rel.startsWith('server/src/') && rel.endsWith('.ts') && !rel.endsWith('.d.ts')) {
      sourceByRel.set(rel, sf);
    }
  }
  const knownRelFiles = new Set(sourceByRel.keys());

  // Build adjacency list with GATEWAY_MODULES removed
  const adj = new Map<string, string[]>();
  for (const [rel, sf] of sourceByRel) {
    if (GATEWAY_MODULES.has(rel)) continue;
    const edges = extractValueImportEdges(sf, rel, knownRelFiles).filter((target) => !GATEWAY_MODULES.has(target));
    adj.set(rel, edges);
  }

  // Application entry points (roots of the gateway-removed reachability graph)
  const roots: string[] = [];
  for (const rel of knownRelFiles) {
    if (GATEWAY_MODULES.has(rel) || NON_ARTIFACT_INFRA_LEAVES.has(rel)) continue;
    if (
      rel === 'server/src/index.ts' ||
      rel === 'server/src/app.ts' ||
      rel.startsWith('server/src/routes/') ||
      rel === 'server/src/acp/client-manager.ts' ||
      rel === 'server/src/files/artifacts.ts' ||
      rel === 'server/src/files/link-resolver.ts' ||
      rel.startsWith('server/src/rich/') ||
      rel.startsWith('server/src/edit-requests/')
    ) {
      roots.push(rel);
    }
  }

  // BFS reachability on G \ GATEWAY_MODULES keeping shortest chain for every reachable module
  const reachableChain = new Map<string, string[]>();
  const queue: string[] = [];
  for (const root of roots) {
    if (!reachableChain.has(root)) {
      reachableChain.set(root, [root]);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (NON_ARTIFACT_INFRA_LEAVES.has(cur)) continue;
    const curChain = reachableChain.get(cur)!;
    for (const next of adj.get(cur) ?? []) {
      if (GATEWAY_MODULES.has(next) || NON_ARTIFACT_INFRA_LEAVES.has(next)) continue;
      if (!reachableChain.has(next)) {
        reachableChain.set(next, [...curChain, next]);
        queue.push(next);
      }
    }
  }

  const forbiddenDbMethods = new Set([
    'upsertArtifact',
    'upsertProjectFile',
    'upsertProjectFileInTx',
    'deleteProjectFile',
    'deleteProject',
    'deleteChat',
  ]);
  const forbiddenFsMutationMethods = new Set([
    'writeFile',
    'writeFileSync',
    'copyFile',
    'copyFileSync',
    'appendFile',
    'appendFileSync',
    'rename',
    'renameSync',
    'unlink',
    'unlinkSync',
    'rm',
    'rmSync',
    'truncate',
    'truncateSync',
    'createWriteStream',
  ]);
  const forbiddenWorkspaceWriteHelpers = new Set([
    'atomicWriteFileNoFollow',
    'unlinkContainedRegularFileNoFollow',
    'removeContainedSubtreeNoFollow',
    'writeWorkspaceTextFile',
  ]);
  const forbiddenSyncEventTypes = new Set([
    'artifact.created',
    'artifact.updated',
    'artifact.deleted',
    'project.deleted',
    'chat.deleted',
  ]);
  const forbiddenSqlTablesRe =
    /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:artifacts|artifact_revisions|artifact_commit_journal|artifact_dependencies|artifact_restore_batches|artifact_restore_batch_items|project_files)\b/i;

  const violations: Violation[] = [];

  for (const [rel, chain] of reachableChain) {
    if (NON_ARTIFACT_INFRA_LEAVES.has(rel) || GATEWAY_MODULES.has(rel)) continue;
    const sf = sourceByRel.get(rel);
    if (!sf) continue;
    const chainStr = chain.join(' -> ');

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;

        // 1. Direct or helper-mediated DB artifact/project/chat-deletion mutation
        if (ts.isPropertyAccessExpression(expr) && forbiddenDbMethods.has(expr.name.text)) {
          const receiverText = expr.expression.getText(sf);
          if (!receiverText.endsWith('artifactService')) {
            violations.push({
              rule: 'ARCH-01',
              file: rel,
              line: lineOf(sf, node),
              chain,
              message: `Bypass DB mutation '${expr.name.text}' reachable without ArtifactService (${chainStr}).`,
            });
          }
        }

        // 2a. Direct or helper-mediated node:fs file mutation / deletion
        if (ts.isPropertyAccessExpression(expr) && forbiddenFsMutationMethods.has(expr.name.text)) {
          violations.push({
            rule: 'ARCH-01',
            file: rel,
            line: lineOf(sf, node),
            chain,
            message: `Bypass filesystem mutation '${expr.name.text}' reachable without ArtifactService (${chainStr}).`,
          });
        }

        // 2b. Direct or helper-mediated call to low-level workspace write/delete primitives
        if (ts.isIdentifier(expr) && forbiddenWorkspaceWriteHelpers.has(expr.text)) {
          const allowedNativeAcpWrite =
            rel === 'server/src/acp/client-manager.ts' &&
            expr.text === 'writeWorkspaceTextFile' &&
            isInsideNativeAcpWriteTextFileHandler(node, sf);
          if (!allowedNativeAcpWrite) {
            violations.push({
              rule: 'ARCH-01',
              file: rel,
              line: lineOf(sf, node),
              chain,
              message: `Bypass workspace primitive '${expr.text}' reachable without ArtifactService (${chainStr}).`,
            });
          }
        }

        // 3. Direct or helper-mediated SyncHub artifact/project/chat-deletion notification
        if (
          ts.isPropertyAccessExpression(expr) &&
          (expr.name.text === 'emitDurable' || expr.name.text === 'insertSyncEventInTx') &&
          node.arguments.length > 0 &&
          ts.isObjectLiteralExpression(node.arguments[0])
        ) {
          for (const prop of node.arguments[0].properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === 'type' &&
              ts.isStringLiteral(prop.initializer) &&
              forbiddenSyncEventTypes.has(prop.initializer.text)
            ) {
              violations.push({
                rule: 'ARCH-01',
                file: rel,
                line: lineOf(sf, node),
                chain,
                message: `Bypass SyncHub '${prop.initializer.text}' emission reachable without ArtifactService (${chainStr}).`,
              });
            }
          }
        }

        // 4. Direct or helper-mediated SQL mutation against artifact / project_files tables
        if (
          ts.isPropertyAccessExpression(expr) &&
          (expr.name.text === 'prepare' || expr.name.text === 'exec') &&
          node.arguments.length > 0 &&
          (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
        ) {
          const sql = node.arguments[0].text;
          if (forbiddenSqlTablesRe.test(sql)) {
            violations.push({
              rule: 'ARCH-01',
              file: rel,
              line: lineOf(sf, node),
              chain,
              message: `Bypass direct SQL mutation on artifact/project_files tables reachable without ArtifactService (${chainStr}).`,
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

const tempDirs: string[] = [];

function makeTempConfig(): Partial<AppConfig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-arch-rt-'));
  tempDirs.push(root);
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    agyMode: 'mock',
    dataRoot: root,
    builtinSkillsDir: path.join(root, '.empty-builtin-skills'),
    docRuntimeDir: path.join(root, '.empty-doc-runtime'),
    allowUnsandboxedDocWorkers: true,
    sandboxMode: 'off',
    allowPublicSignup: true,
    secureCookies: 'never',
  };
}

function extractCookies(setCookies: string | string[] | undefined): { cookieHeader: string; csrf: string } {
  const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  const pairs: string[] = [];
  let csrf = '';
  for (const raw of list) {
    const kv = raw.split(';')[0];
    pairs.push(kv);
    if (kv.startsWith('agy_chat_csrf=')) csrf = decodeURIComponent(kv.slice('agy_chat_csrf='.length));
  }
  return { cookieHeader: pairs.join('; '), csrf };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Architecture Conformance & Negative Self-Tests (ARCH-01, ARCH-10, ARCH-15, NEG-01, NEG-02, NEG-05, NEG-11)', () => {
  it('passes all static gateway-removal reachability and isolation checks on the real codebase with 0 violations', () => {
    const program = createInMemoryProgram();
    expect(checkGatewayRemovalConformance(program)).toEqual([]);
    expect(checkAdapterIsolationConformance(program)).toEqual([]);
    expect(checkRichCodeExecutionBan(program)).toEqual([]);
    expect(checkNoTestFixtureLeakage(program)).toEqual([]);

    // ARCH-15: Verify --disable-telemetry is preserved in ACP process launch
    const envIsoSrc = fs.readFileSync(path.join(SERVER_SRC, 'acp', 'env-isolation.ts'), 'utf8');
    expect(envIsoSrc).toContain('--disable-telemetry');
  });

  it('NEG-01 (direct): fails gateway-removal check when a route bypasses ArtifactService with direct DB/FS/SyncHub calls', () => {
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

  it('NEG-01 (indirect helper chain): catches multi-hop route -> utils helper -> misc sink bypasses outside checked directories', () => {
    const routeFile = path.join(SERVER_SRC, 'routes', '__neg01_indirect_route.ts');
    const midHelperFile = path.join(SERVER_SRC, 'utils', '__neg01_mid_helper.ts');
    const leafSinkFile = path.join(SERVER_SRC, 'misc', '__neg01_leaf_sink.ts');

    const program = createInMemoryProgram(
      new Map([
        [
          routeFile,
          `
            import { delegateWrite } from '../utils/__neg01_mid_helper.js';
            export async function indirectRoute(db: any, hub: any) {
              return delegateWrite(db, hub);
            }
          `,
        ],
        [
          midHelperFile,
          `
            import { performHiddenBypass } from '../misc/__neg01_leaf_sink.js';
            export async function delegateWrite(db: any, hub: any) {
              return performHiddenBypass(db, hub);
            }
          `,
        ],
        [
          leafSinkFile,
          `
            import fs from 'node:fs';
            export async function performHiddenBypass(db: any, hub: any) {
              fs.rmSync('/tmp/project-dir', { recursive: true, force: true });
              db.deleteProject('u', 'p');
              hub.emitDurable({ userId: 'u', type: 'artifact.deleted', payload: {} });
            }
          `,
        ],
      ])
    );

    const violations = checkGatewayRemovalConformance(program);
    expect(violations.length).toBeGreaterThanOrEqual(3);
    expect(violations.some((v) => v.message.includes('rmSync'))).toBe(true);
    expect(violations.some((v) => v.message.includes('deleteProject'))).toBe(true);
    expect(violations.some((v) => v.message.includes('artifact.deleted'))).toBe(true);
    for (const v of violations) {
      expect(v.chain).toEqual([
        'server/src/routes/__neg01_indirect_route.ts',
        'server/src/utils/__neg01_mid_helper.ts',
        'server/src/misc/__neg01_leaf_sink.ts',
      ]);
    }
  });

  it('ARCH-01 (runtime instrumentation): verifies live REST artifact/project/chat mutations execute exclusively inside ArtifactService and detects direct bypasses', async () => {
    const ctx = await createApp(makeTempConfig());
    const gatewayAls = new AsyncLocalStorage<number>();
    let gatewayEntries = 0;
    let observedSinkCalls = 0;
    const runtimeBypassViolations: string[] = [];

    // Wrap ArtifactService public mutation methods to mark active gateway execution context
    const gatewayMethods = [
      'createArtifact',
      'editArtifact',
      'replaceArtifactBytes',
      'restoreRevision',
      'restoreBundle',
      'undo',
      'redo',
      'exportArtifact',
      'ingestWorkspaceFile',
      'saveInlineGeneratedAsset',
      'uploadChatAttachment',
      'uploadProjectFile',
      'deleteProjectFile',
      'deleteProject',
      'deleteChat',
      'copyArtifactToProject',
      'createProjectWorkingCopyInChat',
      'reflectWorkingCopyToProject',
      'syncProjectFilesToChat',
    ] as const;

    const svcAny = ctx.artifactService as unknown as Record<string, (...args: unknown[]) => unknown>;
    const originals = new Map<string, (...args: unknown[]) => unknown>();
    for (const name of gatewayMethods) {
      const orig = ArtifactService.prototype[name as keyof ArtifactService] as (...args: unknown[]) => unknown;
      originals.set(name, orig);
      svcAny[name] = function (...args: unknown[]) {
        gatewayEntries++;
        const depth = gatewayAls.getStore() ?? 0;
        return gatewayAls.run(depth + 1, () => orig.apply(ctx.artifactService, args));
      };
    }

    // Instrument DB mutation sinks
    const dbAny = ctx.db as unknown as Record<string, (...args: unknown[]) => unknown>;
    const monitoredDbSinks = [
      'upsertArtifact',
      'upsertProjectFile',
      'upsertProjectFileInTx',
      'deleteProjectFile',
      'deleteProject',
      'deleteChat',
    ] as const;
    for (const sink of monitoredDbSinks) {
      const orig = dbAny[sink].bind(ctx.db);
      dbAny[sink] = (...args: unknown[]) => {
        observedSinkCalls++;
        if ((gatewayAls.getStore() ?? 0) <= 0) {
          runtimeBypassViolations.push(`db.${sink}`);
        }
        return orig(...args);
      };
    }

    // Instrument SyncHub notification sinks for artifact/project/chat-deletion events
    const monitoredSyncTypes = new Set([
      'artifact.created',
      'artifact.updated',
      'artifact.deleted',
      'project.deleted',
      'chat.deleted',
    ]);
    const origEmit = ctx.hub.emitDurable.bind(ctx.hub);
    ctx.hub.emitDurable = ((params: Parameters<typeof ctx.hub.emitDurable>[0]) => {
      if (monitoredSyncTypes.has(params.type)) {
        observedSinkCalls++;
        if ((gatewayAls.getStore() ?? 0) <= 0) {
          runtimeBypassViolations.push(`hub.emitDurable(${params.type})`);
        }
      }
      return origEmit(params);
    }) as typeof ctx.hub.emitDurable;

    try {
      const regRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'arch_rt_user', password: 'password123', displayName: 'Arch RT' },
      });
      expect(regRes.statusCode).toBe(201);
      const { cookieHeader, csrf } = extractCookies(regRes.headers['set-cookie']);
      const headers = { cookie: cookieHeader, 'x-csrf-token': csrf };

      // Bind mock AGY auth so chat creation succeeds
      await ctx.app.inject({
        method: 'POST',
        url: '/api/agy/login/start',
        headers,
        payload: { accountLabel: 'arch-rt-code' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: '/api/agy/login/code',
        headers,
        payload: { code: 'arch-rt-code' },
      });

      // 1. Create project & upload project file
      const projRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: 'Arch Project' },
      });
      expect(projRes.statusCode).toBe(201);
      const projectId = projRes.json().project.id as string;

      const boundary = '----archTestBoundary';
      const uploadBody = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="spec.md"',
        'Content-Type: text/markdown',
        '',
        '# Spec v1',
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const pfRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/files`,
        headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: uploadBody,
      });
      expect(pfRes.statusCode).toBe(201);
      const fileId = pfRes.json().uploaded[0].id as string;

      // 2. Create chat under project (triggers syncProjectFilesToChat)
      const chatRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers,
        payload: { title: 'Arch Chat', projectId },
      });
      expect(chatRes.statusCode).toBe(201);
      const chatId = chatRes.json().chat.id as string;

      // 3. Create, edit, and restore artifact via REST
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/chats/${chatId}/artifacts`,
        headers,
        payload: { relPath: 'notes.md', content: '# v1\nhello\n' },
      });
      expect(createRes.statusCode).toBe(201);
      const artifactId = createRes.json().artifact.id as string;

      const editRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/files/${artifactId}/edit`,
        headers,
        payload: { expectedRevision: 1, operations: [{ op: 'replace_source', content: '# v2\nupdated\n' }] },
      });
      expect(editRes.statusCode).toBe(200);

      const restoreRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/files/${artifactId}/restore`,
        headers,
        payload: { targetRevision: 1 },
      });
      expect(restoreRes.statusCode).toBe(200);

      // 4. Create working copy & reflect back to project
      const wcRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/files/${fileId}/working-copy`,
        headers,
        payload: { chatId },
      });
      expect(wcRes.statusCode).toBe(201);
      const wcId = wcRes.json().artifact.id as string;

      await ctx.app.inject({
        method: 'POST',
        url: `/api/files/${wcId}/edit`,
        headers,
        payload: { expectedRevision: 1, operations: [{ op: 'replace_source', content: '# Spec v2' }] },
      });
      const reflectRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/files/${wcId}/reflect-to-project`,
        headers,
        payload: {},
      });
      expect(reflectRes.statusCode).toBe(200);

      // 5. Delete project file, sync project to chat, delete chat, delete project
      const delFileRes = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectId}/files/${fileId}`,
        headers,
      });
      expect(delFileRes.statusCode).toBe(200);

      const syncRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/chats/${chatId}/sync-project`,
        headers,
      });
      expect(syncRes.statusCode).toBe(200);

      const delChatRes = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/chats/${chatId}`,
        headers,
      });
      expect(delChatRes.statusCode).toBe(200);

      const delProjRes = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectId}`,
        headers,
      });
      expect(delProjRes.statusCode).toBe(200);

      // All real REST operations must pass through ArtifactService with ZERO bypasses
      expect(gatewayEntries).toBeGreaterThanOrEqual(10);
      expect(observedSinkCalls).toBeGreaterThan(0);
      expect(runtimeBypassViolations).toEqual([]);

      // Negative runtime self-test: calling a DB sink outside ArtifactService is immediately flagged
      ctx.db.deleteProject('nonexistent-user', 'nonexistent-proj');
      expect(runtimeBypassViolations).toEqual(['db.deleteProject']);
    } finally {
      await ctx.shutdown();
    }
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
