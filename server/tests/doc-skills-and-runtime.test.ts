import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
import {
  applySandboxLayeredRuntime,
  buildAgyCommandSpec,
  detectHostPythonVersionDir,
  ensurePerChatHomeDir,
  ensurePerChatRuntimeDir,
  probeBwrapSandbox,
  resolveDocRuntimeLayout,
  SANDBOX_CHAT_RUNTIME_MOUNT,
  SANDBOX_DOC_RUNTIME_MOUNT,
  SANDBOX_HOME_MOUNT,
} from '../src/acp/env-isolation.js';
import type { AppConfig } from '../src/config.js';
import { resolveAuthorizedChatFileReference } from '../src/files/link-resolver.js';
import {
  BUILTIN_STATE_FILENAME,
  computeSkillDirectoryDigest,
  LEGACY_BUILTIN_SYNC_MARKER,
  listCustomGlobalSkillSlugs,
  migrateLegacySyncedBuiltins,
  readProfileDisabledBuiltins,
  resolveActiveBuiltinSkillsForProfile,
} from '../src/skills/builtin-skills.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

function writeSkillDir(
  parentDir: string,
  slug: string,
  opts: {
    name?: string;
    description?: string;
    instructions?: string;
    files?: Record<string, string>;
    legacyMarker?: boolean | 'auto' | { sha256?: string };
  } = {},
): string {
  const dir = path.join(parentDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const name = opts.name ?? slug;
  const description = opts.description ?? `${slug} skill description`;
  const instructions = opts.instructions ?? `# ${slug}\nUse this skill for ${slug}.`;
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`,
    'utf8',
  );
  if (opts.files) {
    for (const [rel, content] of Object.entries(opts.files)) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }
  if (opts.legacyMarker === 'auto') {
    const sha256 = computeSkillDirectoryDigest(dir);
    fs.writeFileSync(
      path.join(dir, LEGACY_BUILTIN_SYNC_MARKER),
      JSON.stringify({ slug, sha256 }) + '\n',
      'utf8',
    );
  } else if (typeof opts.legacyMarker === 'object' && opts.legacyMarker !== null) {
    fs.writeFileSync(
      path.join(dir, LEGACY_BUILTIN_SYNC_MARKER),
      JSON.stringify({ slug, ...opts.legacyMarker }) + '\n',
      'utf8',
    );
  } else if (opts.legacyMarker) {
    fs.writeFileSync(path.join(dir, LEGACY_BUILTIN_SYNC_MARKER), 'builtin-sync-v1', 'utf8');
  }
  return dir;
}

function seedBuiltinCatalog(rootDir: string, versionTag = 'v1'): string {
  const builtinDir = path.join(rootDir, 'builtin-skills');
  fs.mkdirSync(builtinDir, { recursive: true });
  for (const slug of ['docx', 'pptx', 'xlsx', 'pdf']) {
    writeSkillDir(builtinDir, slug, {
      name: `${slug}-${versionTag}`,
      description: `Anthropic ${slug} (${versionTag})`,
      instructions: `# ${slug} (${versionTag})\nOfficial built-in workflow (${versionTag}).`,
      files: slug === 'docx' ? { 'scripts/render.py': `print("docx-${versionTag}")\n` } : undefined,
    });
  }
  fs.writeFileSync(
    path.join(builtinDir, '.builtin-skills-manifest.json'),
    JSON.stringify({
      version: 1,
      skills: {
        docx: { sha256: `sha-docx-${versionTag}` },
        pptx: { sha256: `sha-pptx-${versionTag}` },
        xlsx: { sha256: `sha-xlsx-${versionTag}` },
        pdf: { sha256: `sha-pdf-${versionTag}` },
      },
    }),
    'utf8',
  );
  return builtinDir;
}

type ApiSkillsList = {
  global: Array<{
    slug: string;
    origin?: string;
    hasBuiltinConflict?: boolean;
    storageKind?: string;
    enabled: boolean;
  }>;
  commands: Array<{ name: string; source?: string }>;
};

describe('Anthropic doc skills and runtime isolation', () => {
  test('Built-in vs Custom skills: read-only enforcement, per-user state across updates, and collision protection', async () => {
    const builtinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-builtin-catalog-'));
    const builtinSkillsDir = seedBuiltinCatalog(builtinRoot, 'v1');
    const srv = await createTestServer({ builtinSkillsDir });

    try {
      const alice = await registerAndBindAgy(srv.baseUrl, 'alice_doc', 'alice-doc');
      const bob = await registerAndBindAgy(srv.baseUrl, 'bob_doc', 'bob-doc');

      // 1. Both users see Built-in skills with origin='builtin', zero files copied to profileDir
      const aliceList1 = await alice.client.request<ApiSkillsList>('GET', '/api/skills');
      expect(aliceList1.status).toBe(200);
      for (const slug of ['docx', 'pptx', 'xlsx', 'pdf']) {
        const found = aliceList1.data.global.find((i) => i.slug === slug);
        expect(found, `Expected built-in skill ${slug}`).toBeTruthy();
        expect(found?.origin).toBe('builtin');
        expect(Boolean(found?.hasBuiltinConflict)).toBe(false);
        expect(found?.storageKind).toBe('builtin');
        expect(found?.enabled).toBe(true);
      }

      const aliceProfile = srv.ctx.db.getAgyProfile(alice.userId)!;
      expect(
        fs.existsSync(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills', 'docx')),
      ).toBe(false);

      // 2. Built-in detail & resource reads succeed
      const docxDetail = await alice.client.request<{
        skill: {
          origin?: string;
          hasBuiltinConflict?: boolean;
          resources: Array<{ relPath: string }>;
          instructions: string;
        };
      }>('GET', '/api/skills/global/docx');
      expect(docxDetail.status).toBe(200);
      expect(docxDetail.data.skill.origin).toBe('builtin');
      expect(docxDetail.data.skill.resources.some((r) => r.relPath === 'scripts/render.py')).toBe(true);

      const resRead = await alice.client.request<{ relPath: string; content: string }>(
        'GET',
        '/api/skills/global/docx/files?path=scripts%2Frender.py',
      );
      expect(resRead.status).toBe(200);
      expect(resRead.data.content).toContain('docx-v1');

      // 3. Built-in edits, deletes, resource writes/deletes, and duplicate creation are rejected
      const putEdit = await alice.client.request<{ error: string }>('PUT', '/api/skills/global/docx', {
        description: 'Tampered description',
        instructions: 'Tampered instructions',
      });
      expect(putEdit.status).toBe(403);
      expect(putEdit.data.error).toBe('BUILTIN_SKILL_READONLY');

      const deleteBuiltin = await alice.client.request<{ error: string }>('DELETE', '/api/skills/global/docx');
      expect(deleteBuiltin.status).toBe(403);
      expect(deleteBuiltin.data.error).toBe('BUILTIN_SKILL_READONLY');

      const postResourceJson = await alice.client.request<{ error: string }>(
        'POST',
        '/api/skills/global/docx/files',
        { relPath: 'scripts/evil.py', content: 'print("evil")' },
      );
      expect(postResourceJson.status).toBe(403);
      expect(postResourceJson.data.error).toBe('BUILTIN_SKILL_READONLY');

      const form = new FormData();
      form.append('file', new Blob(['x'], { type: 'text/plain' }), 'note.txt');
      const postResourceMultipart = await alice.client.request<{ error: string }>(
        'POST',
        '/api/skills/global/docx/files?folder=resources',
        form,
      );
      expect(postResourceMultipart.status).toBe(403);
      expect(postResourceMultipart.data.error).toBe('BUILTIN_SKILL_READONLY');

      const deleteResource = await alice.client.request<{ error: string }>(
        'DELETE',
        '/api/skills/global/docx/files?path=scripts%2Frender.py',
      );
      expect(deleteResource.status).toBe(403);
      expect(deleteResource.data.error).toBe('BUILTIN_SKILL_READONLY');

      const createCollision = await alice.client.request<{ error: string }>('POST', '/api/skills', {
        scope: 'global',
        slug: 'docx',
        description: 'Trying to shadow built-in via POST',
        instructions: 'Blocked',
      });
      expect(createCollision.status).toBe(409);
      expect(createCollision.data.error).toBe('BUILTIN_SKILL_CONFLICT');

      // Verify Built-in files on disk stayed completely untouched
      expect(fs.readFileSync(path.join(builtinSkillsDir, 'docx', 'scripts', 'render.py'), 'utf8')).toContain(
        'docx-v1',
      );

      // 4. Separate per-user enable/disable state survives Built-in updates
      const disableDocx = await alice.client.request<{
        skill: { origin?: string; enabled: boolean };
      }>('PUT', '/api/skills/global/docx', { enabled: false });
      expect(disableDocx.status).toBe(200);
      expect(disableDocx.data.skill.origin).toBe('builtin');
      expect(disableDocx.data.skill.enabled).toBe(false);

      expect(
        fs.existsSync(path.join(aliceProfile.profileDir, '.gemini', 'config', BUILTIN_STATE_FILENAME)),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills-disabled', 'docx')),
      ).toBe(false);

      // Bob still has docx enabled
      const bobDocx = await bob.client.request<{ skill: { enabled: boolean; origin?: string } }>(
        'GET',
        '/api/skills/global/docx',
      );
      expect(bobDocx.status).toBe(200);
      expect(bobDocx.data.skill.origin).toBe('builtin');
      expect(bobDocx.data.skill.enabled).toBe(true);

      // Simulate Built-in bundle update v1 -> v2
      seedBuiltinCatalog(builtinRoot, 'v2');

      // Alice keeps docx disabled across update, sees v2 content on pptx and docx
      const aliceList2 = await alice.client.request<ApiSkillsList>('GET', '/api/skills');
      expect(aliceList2.data.global.find((i) => i.slug === 'docx')?.enabled).toBe(false);
      expect(aliceList2.data.global.find((i) => i.slug === 'pptx')?.enabled).toBe(true);
      expect(aliceList2.data.commands.some((c) => c.name === 'docx')).toBe(false);

      const alicePptxV2 = await alice.client.request<{ skill: { instructions: string } }>(
        'GET',
        '/api/skills/global/pptx',
      );
      expect(alicePptxV2.data.skill.instructions).toContain('v2');

      // Re-enabling docx succeeds cleanly
      const reenableDocx = await alice.client.request<{ skill: { enabled: boolean } }>(
        'PUT',
        '/api/skills/global/docx',
        { enabled: true },
      );
      expect(reenableDocx.status).toBe(200);
      expect(reenableDocx.data.skill.enabled).toBe(true);

      // 5. Custom skill collision across canonical and legacy paths is detected & preserved
      writeSkillDir(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills'), 'xlsx', {
        name: 'Alice Custom XLSX',
        description: 'Custom xlsx skill',
        instructions: 'Custom xlsx instructions',
      });
      writeSkillDir(path.join(aliceProfile.profileDir, '.gemini', 'antigravity', 'skills'), 'pdf', {
        name: 'Alice Legacy PDF',
        description: 'Legacy antigravity pdf skill',
        instructions: 'Legacy pdf instructions',
      });
      writeSkillDir(path.join(aliceProfile.profileDir, '.gemini', 'skills'), 'pptx', {
        name: 'Alice Legacy PPTX',
        description: 'Legacy skills pptx skill',
        instructions: 'Legacy pptx instructions',
      });

      const aliceListCollision = await alice.client.request<ApiSkillsList>('GET', '/api/skills');

      const aliceXlsx = aliceListCollision.data.global.find((i) => i.slug === 'xlsx');
      expect(aliceXlsx?.origin).toBe('custom');
      expect(aliceXlsx?.hasBuiltinConflict).toBe(true);
      expect(aliceXlsx?.storageKind).toBe('canonical');

      const alicePdf = aliceListCollision.data.global.find((i) => i.slug === 'pdf');
      expect(alicePdf?.origin).toBe('custom');
      expect(alicePdf?.hasBuiltinConflict).toBe(true);
      expect(alicePdf?.storageKind).toBe('legacy');

      const alicePptx = aliceListCollision.data.global.find((i) => i.slug === 'pptx');
      expect(alicePptx?.origin).toBe('custom');
      expect(alicePptx?.hasBuiltinConflict).toBe(true);
      expect(alicePptx?.storageKind).toBe('legacy');

      // Alice can still edit and delete her colliding Custom skill
      const editCustomXlsx = await alice.client.request<{
        skill: { origin?: string; hasBuiltinConflict?: boolean; instructions: string };
      }>('PUT', '/api/skills/global/xlsx', {
        description: 'Updated custom xlsx',
        instructions: 'Updated custom xlsx body',
      });
      expect(editCustomXlsx.status).toBe(200);
      expect(editCustomXlsx.data.skill.origin).toBe('custom');
      expect(editCustomXlsx.data.skill.hasBuiltinConflict).toBe(true);
      expect(editCustomXlsx.data.skill.instructions).toContain('Updated custom xlsx body');

      // Bob is completely unaffected by Alice's colliding skills
      const bobList = await bob.client.request<ApiSkillsList>('GET', '/api/skills');
      const bobXlsx = bobList.data.global.find((i) => i.slug === 'xlsx');
      expect(bobXlsx?.origin).toBe('builtin');
      expect(Boolean(bobXlsx?.hasBuiltinConflict)).toBe(false);

      // Deleting Alice's colliding Custom xlsx immediately reveals Built-in xlsx
      const deleteCustomXlsx = await alice.client.request('DELETE', '/api/skills/global/xlsx');
      expect(deleteCustomXlsx.status).toBe(200);

      const aliceAfterDelete = await alice.client.request<ApiSkillsList>('GET', '/api/skills');
      const restoredBuiltinXlsx = aliceAfterDelete.data.global.find((i) => i.slug === 'xlsx');
      expect(restoredBuiltinXlsx?.origin).toBe('builtin');
      expect(Boolean(restoredBuiltinXlsx?.hasBuiltinConflict)).toBe(false);

      // 6. Regular custom skills remain editable and deletable
      const createCustom = await alice.client.request<{ skill: { slug: string; origin?: string } }>(
        'POST',
        '/api/skills',
        {
          scope: 'global',
          slug: 'my-team-notes',
          description: 'Custom non-conflicting skill',
          instructions: 'Custom notes',
        },
      );
      expect(createCustom.status).toBe(201);
      expect(createCustom.data.skill.origin).toBe('custom');
      expect((await alice.client.request('DELETE', '/api/skills/global/my-team-notes')).status).toBe(200);
    } finally {
      await srv.cleanup();
      fs.rmSync(builtinRoot, { recursive: true, force: true });
    }
  });

  test('Legacy .agy-builtin-skill migration verifies digest, preserves modified SKILL.md and attachment-only edits as Custom with backups, and resolves active Built-in links', async () => {
    const builtinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-builtin-migrate-'));
    const builtinSkillsDir = seedBuiltinCatalog(builtinRoot, 'v1');
    const srv = await createTestServer({ builtinSkillsDir });

    try {
      const alice = await registerAndBindAgy(srv.baseUrl, 'alice_migrate', 'alice-mig');
      const aliceProfile = srv.ctx.db.getAgyProfile(alice.userId)!;
      const enabledDir = path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills');
      const disabledDir = path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills-disabled');

      // 1. Unmodified disabled legacy copy with matching digest -> deleted & disabled state persisted
      writeSkillDir(disabledDir, 'docx', { legacyMarker: 'auto' });

      // 2. Unmodified enabled legacy copy with matching digest -> deleted & served from read-only catalog
      writeSkillDir(enabledDir, 'pptx', { legacyMarker: 'auto' });

      // 3. SKILL.md edited directly on disk after legacy sync -> preserved as Custom + backed up
      const editedSkillMdDir = writeSkillDir(enabledDir, 'xlsx', { legacyMarker: 'auto' });
      fs.appendFileSync(path.join(editedSkillMdDir, 'SKILL.md'), '\n# User local edits\n', 'utf8');

      // 4. SKILL.md untouched, ONLY an attached file modified/added directly on disk -> preserved as Custom + backed up
      const editedAttachDir = writeSkillDir(enabledDir, 'pdf', {
        files: { 'scripts/helper.py': 'print("v1")\n' },
        legacyMarker: 'auto',
      });
      fs.writeFileSync(path.join(editedAttachDir, 'scripts', 'helper.py'), 'print("user-custom")\n', 'utf8');

      // 5. Legacy marker with missing/unverifiable digest -> must NOT be deleted
      writeSkillDir(enabledDir, 'legacy-no-digest', { legacyMarker: true });

      const migration = migrateLegacySyncedBuiltins(aliceProfile.profileDir);

      // Unmodified copies are removed
      expect(fs.existsSync(path.join(disabledDir, 'docx'))).toBe(false);
      expect(fs.existsSync(path.join(enabledDir, 'pptx'))).toBe(false);
      expect(migration.removed.sort()).toEqual(['docx', 'pptx']);

      // Modified (SKILL.md or attachment-only) and unverifiable copies stay as Custom with marker stripped
      expect(fs.existsSync(path.join(enabledDir, 'xlsx', 'SKILL.md'))).toBe(true);
      expect(fs.readFileSync(path.join(enabledDir, 'xlsx', 'SKILL.md'), 'utf8')).toContain('# User local edits');
      expect(fs.existsSync(path.join(enabledDir, 'xlsx', LEGACY_BUILTIN_SYNC_MARKER))).toBe(false);

      expect(fs.existsSync(path.join(enabledDir, 'pdf', 'scripts', 'helper.py'))).toBe(true);
      expect(fs.readFileSync(path.join(enabledDir, 'pdf', 'scripts', 'helper.py'), 'utf8')).toContain('user-custom');
      expect(fs.existsSync(path.join(enabledDir, 'pdf', LEGACY_BUILTIN_SYNC_MARKER))).toBe(false);

      expect(fs.existsSync(path.join(enabledDir, 'legacy-no-digest', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(enabledDir, 'legacy-no-digest', LEGACY_BUILTIN_SYNC_MARKER))).toBe(false);

      // Backups and migration notices were generated for all preserved skills
      expect(migration.preservedCustom.map((p) => p.slug).sort()).toEqual([
        'legacy-no-digest',
        'pdf',
        'xlsx',
      ]);
      for (const notice of migration.preservedCustom) {
        expect(fs.existsSync(path.join(notice.backupDir, 'SKILL.md'))).toBe(true);
      }
      const persistedState = JSON.parse(
        fs.readFileSync(path.join(aliceProfile.profileDir, '.gemini', 'config', BUILTIN_STATE_FILENAME), 'utf8'),
      ) as { disabled: string[]; migratedCustomNotices?: Array<{ slug: string }> };
      expect(persistedState.disabled).toEqual(['docx']);
      expect(persistedState.migratedCustomNotices?.map((n) => n.slug).sort()).toEqual([
        'legacy-no-digest',
        'pdf',
        'xlsx',
      ]);

      const disabledSet = readProfileDisabledBuiltins(aliceProfile.profileDir);
      const customSlugs = listCustomGlobalSkillSlugs(aliceProfile.profileDir);
      const resolvedState = resolveActiveBuiltinSkillsForProfile(aliceProfile.profileDir, builtinSkillsDir);
      expect(disabledSet.has('docx')).toBe(true);
      expect(customSlugs.has('xlsx')).toBe(true);
      expect(customSlugs.has('pdf')).toBe(true);
      expect(resolvedState.conflicts.sort()).toEqual(['pdf', 'xlsx']);
      expect(resolvedState.active.map((entry) => entry.slug)).toEqual(['pptx']);

      // API reports preserved xlsx & pdf as editable Custom skills with conflict badge
      const apiList = await alice.client.request<ApiSkillsList>('GET', '/api/skills');
      const apiPdf = apiList.data.global.find((s) => s.slug === 'pdf');
      expect(apiPdf?.origin).toBe('custom');
      expect(apiPdf?.hasBuiltinConflict).toBe(true);

      // Chat file link resolution resolves active Built-in files read-only (but not disabled/custom-shadowed ones)
      const projRes = await alice.client.request<{ project: { id: string } }>('POST', '/api/projects', {
        name: 'Link Proj',
      });
      const chatRes = await alice.client.request<{ chat: { id: string } }>('POST', '/api/chats', {
        title: 'Link Chat',
        projectId: projRes.data.project.id,
      });

      const activeBuiltinLink = resolveAuthorizedChatFileReference({
        artifactService: srv.ctx.artifactService,
        db: srv.ctx.db,
        userId: alice.userId,
        chatId: chatRes.data.chat.id,
        reference: `${SANDBOX_HOME_MOUNT}/.gemini/config/skills/pptx/SKILL.md`,
        builtinSkillsDir,
      });
      expect(activeBuiltinLink).toBeTruthy();

      const disabledBuiltinLink = resolveAuthorizedChatFileReference({
        artifactService: srv.ctx.artifactService,
        db: srv.ctx.db,
        userId: alice.userId,
        chatId: chatRes.data.chat.id,
        reference: `${SANDBOX_HOME_MOUNT}/.gemini/config/skills/docx/scripts/render.py`,
        builtinSkillsDir,
      });
      expect(disabledBuiltinLink).toBeNull();
    } finally {
      await srv.cleanup();
      fs.rmSync(builtinRoot, { recursive: true, force: true });
    }
  });

  test('Sandbox bwrap mounts shared read-only base + persistent per-chat diff runtime with normal python/pip/node CJS+ESM and explicit non-isolated warnings', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bwrap-mount-'));
    const pyVerDir = detectHostPythonVersionDir();
    const docRuntimeDir = path.join(tmpRoot, 'doc-runtime');
    try {
      const builtinSkillsDir = seedBuiltinCatalog(tmpRoot, 'v1');
      fs.mkdirSync(path.join(docRuntimeDir, 'venv', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(docRuntimeDir, 'venv', 'lib', pyVerDir, 'site-packages'), { recursive: true });
      fs.mkdirSync(path.join(docRuntimeDir, 'node', 'node_modules', '.bin'), { recursive: true });
      fs.writeFileSync(path.join(docRuntimeDir, 'venv', 'bin', 'python3'), '#!/bin/sh\nexec /usr/bin/python3 "$@"\n', {
        mode: 0o755,
      });

      // Seed base document Python libraries (docx, pptx, openpyxl, pypdf)
      const baseSite = path.join(docRuntimeDir, 'venv', 'lib', pyVerDir, 'site-packages');
      for (const [modName, version] of [
        ['docx', '1.0'],
        ['pptx', '1.0'],
        ['openpyxl', '1.0'],
        ['pypdf', '1.0'],
      ]) {
        fs.mkdirSync(path.join(baseSite, modName), { recursive: true });
        fs.writeFileSync(path.join(baseSite, modName, '__init__.py'), `SOURCE = "base-${modName}-${version}"\n`);
        fs.mkdirSync(path.join(baseSite, `${modName}-${version}.dist-info`), { recursive: true });
        fs.writeFileSync(
          path.join(baseSite, `${modName}-${version}.dist-info`, 'METADATA'),
          `Metadata-Version: 2.1\nName: ${modName}\nVersion: ${version}\n`,
        );
        fs.writeFileSync(
          path.join(baseSite, `${modName}-${version}.dist-info`, 'RECORD'),
          `${modName}/__init__.py,,\n`,
        );
      }

      // Seed base document Node libraries (docx, pptxgenjs, pdf-lib, @myscope/doc-scoped) with BOTH CJS and ESM exports
      const baseNodeModules = path.join(docRuntimeDir, 'node', 'node_modules');
      for (const pkgName of ['docx', 'pptxgenjs', 'pdf-lib']) {
        const pkgDir = path.join(baseNodeModules, pkgName);
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
          path.join(pkgDir, 'package.json'),
          JSON.stringify({
            name: pkgName,
            version: '1.0.0',
            main: './index.cjs',
            exports: { '.': { import: './index.mjs', require: './index.cjs' } },
          }),
        );
        fs.writeFileSync(path.join(pkgDir, 'index.cjs'), `module.exports = { source: 'base-${pkgName}-cjs' };\n`);
        fs.writeFileSync(path.join(pkgDir, 'index.mjs'), `export default { source: 'base-${pkgName}-esm' };\n`);
      }
      const scopedPkgDir = path.join(baseNodeModules, '@myscope', 'doc-scoped');
      fs.mkdirSync(scopedPkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(scopedPkgDir, 'package.json'),
        JSON.stringify({ name: '@myscope/doc-scoped', version: '1.0.0', type: 'module', main: './index.mjs' }),
      );
      fs.writeFileSync(path.join(scopedPkgDir, 'index.mjs'), `import pdf from 'pdf-lib'; export default { source: 'base-scoped-' + pdf.source };\n`);
      fs.writeFileSync(path.join(docRuntimeDir, 'manifest.json'), JSON.stringify({ version: 1 }), 'utf8');

      // Lock base doc-runtime strictly read-only to prove immutability
      const chmodTreeReadOnly = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) chmodTreeReadOnly(full);
          else fs.chmodSync(full, (fs.statSync(full).mode & 0o111) ? 0o555 : 0o444);
        }
        fs.chmodSync(dir, 0o555);
      };
      chmodTreeReadOnly(docRuntimeDir);

      const profileDir = path.join(tmpRoot, 'profile');
      const workspaceA = path.join(tmpRoot, 'workspace-a');
      const workspaceB = path.join(tmpRoot, 'workspace-b');
      fs.mkdirSync(path.join(profileDir, '.gemini', 'config'), { recursive: true });
      fs.mkdirSync(path.join(profileDir, '.gemini', 'antigravity-cli'), { recursive: true });
      fs.mkdirSync(path.join(profileDir, '.config'), { recursive: true });
      fs.writeFileSync(path.join(profileDir, '.gemini', 'oauth_creds.json'), '{"access_token":"shared"}\n', 'utf8');
      fs.writeFileSync(path.join(profileDir, '.gemini', 'antigravity-cli', 'settings.json'), '{"theme":"dark"}\n', 'utf8');
      fs.writeFileSync(path.join(profileDir, '.config', 'profile-only-xdg.txt'), 'must-not-leak-via-home-bind\n', 'utf8');
      fs.mkdirSync(workspaceA, { recursive: true });
      fs.mkdirSync(workspaceB, { recursive: true });

      // Disable pdf; collide xlsx with a Custom skill; add my-custom skill
      fs.writeFileSync(
        path.join(profileDir, '.gemini', 'config', BUILTIN_STATE_FILENAME),
        JSON.stringify({ disabled: ['pdf'] }),
        'utf8',
      );
      writeSkillDir(path.join(profileDir, '.gemini', 'config', 'skills'), 'my-custom');
      writeSkillDir(path.join(profileDir, '.gemini', 'config', 'skills'), 'xlsx', {
        name: 'User Custom XLSX',
      });

      const mockBinDir = path.join(tmpRoot, 'bin');
      fs.mkdirSync(mockBinDir, { recursive: true });
      const fakeBwrap = path.join(mockBinDir, 'bwrap');
      const fakeAgy = path.join(mockBinDir, 'agy');
      fs.writeFileSync(fakeBwrap, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(fakeAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const chatHome = ensurePerChatHomeDir(profileDir, workspaceA, builtinSkillsDir);
      expect(fs.readlinkSync(path.join(chatHome, '.gemini', 'config', 'skills', 'docx'))).toBe(
        path.join(builtinSkillsDir, 'docx'),
      );
      expect(fs.readlinkSync(path.join(chatHome, '.gemini', 'config', 'skills', 'my-custom'))).toBe(
        path.join(profileDir, '.gemini', 'config', 'skills', 'my-custom'),
      );
      expect(fs.existsSync(path.join(chatHome, '.gemini', 'config', 'skills', 'pdf'))).toBe(false);

      const baseCfg: AppConfig = {
        nodeEnv: 'test',
        host: '127.0.0.1',
        port: 0,
        dataRoot: tmpRoot,
        sessionSecret: 'test-secret',
        agyMode: 'cli',
        agyBin: fakeAgy,
        mockAgentPath: '',
        builtinSkillsDir,
        docRuntimeDir,
        maxConcurrentAcp: 2,
        maxAcpPerUser: 1,
        idleWorkerMs: 60_000,
        allowPublicSignup: true,
        secureCookies: 'never',
        sandboxMode: 'bwrap',
        bwrapBin: fakeBwrap,
        libreOfficeBin: null,
        artifactsCacheRoot: path.join(tmpRoot, 'cache'),
      };

      const spec = buildAgyCommandSpec({
        config: baseCfg,
        subcommandArgs: ['acp'],
        profileDir,
        workspaceDir: workspaceA,
        enableSandboxBwrap: true,
      });

      expect(spec.sandboxed).toBe(true);
      expect(spec.layeredRuntimeIsolated).toBe(true);
      const argsStr = spec.args.join('\n');
      const chatHomeA = path.join(profileDir, '.chat-homes', 'workspace-a');
      expect(argsStr).toContain(`--bind\n${chatHomeA}\n${SANDBOX_HOME_MOUNT}`);
      expect(argsStr).not.toContain(`--bind\n${profileDir}\n${SANDBOX_HOME_MOUNT}`);
      expect(argsStr).toContain(`--tmpfs\n${SANDBOX_HOME_MOUNT}/.gemini/config/skills`);
      expect(argsStr).not.toContain(`.chat-runtime\n${SANDBOX_HOME_MOUNT}`);
      expect(argsStr).toContain('--tmpfs\n/usr/local');
      expect(argsStr).toContain(`--ro-bind\n${fs.realpathSync(docRuntimeDir)}\n${SANDBOX_DOC_RUNTIME_MOUNT}`);
      expect(argsStr).toContain(
        `--bind\n${path.join(profileDir, '.chat-runtime', 'workspace-a')}\n${SANDBOX_CHAT_RUNTIME_MOUNT}`,
      );
      expect(argsStr.indexOf(`--bind\n${chatHomeA}\n${SANDBOX_HOME_MOUNT}`)).toBeLessThan(
        argsStr.indexOf(`--bind\n${path.join(profileDir, '.chat-runtime', 'workspace-a')}\n${SANDBOX_CHAT_RUNTIME_MOUNT}`),
      );
      expect(argsStr).toContain(
        `--bind\n${fs.realpathSync(path.join(profileDir, '.gemini', 'oauth_creds.json'))}\n${SANDBOX_HOME_MOUNT}/.gemini/oauth_creds.json`,
      );
      expect(argsStr).toContain(
        `--bind\n${fs.realpathSync(path.join(profileDir, '.gemini', 'antigravity-cli', 'settings.json'))}\n${SANDBOX_HOME_MOUNT}/.gemini/antigravity-cli/settings.json`,
      );
      expect(argsStr).not.toContain('profile-only-xdg.txt');
      expect(argsStr).toContain(
        `--bind\n${fs.realpathSync(path.join(profileDir, '.gemini', 'config', 'skills', 'my-custom'))}\n${SANDBOX_HOME_MOUNT}/.gemini/config/skills/my-custom`,
      );
      expect(argsStr).toContain(
        `--ro-bind\n${fs.realpathSync(path.join(builtinSkillsDir, 'docx'))}\n${SANDBOX_HOME_MOUNT}/.gemini/config/skills/docx`,
      );
      expect(argsStr).not.toContain(`${SANDBOX_HOME_MOUNT}/.gemini/config/skills/pdf`);
      expect(argsStr).not.toContain(`--ro-bind\n${fs.realpathSync(path.join(builtinSkillsDir, 'xlsx'))}`);

      // Inside sandbox, zero custom NODE_OPTIONS hooks; standard env resolves ~/.cache runtime -> /usr/local doc runtime
      expect(spec.env.VIRTUAL_ENV).toBe(`${SANDBOX_CHAT_RUNTIME_MOUNT}/venv`);
      expect(spec.env.PYTHONNOUSERSITE).toBe('1');
      expect(spec.env.NPM_CONFIG_PREFIX).toBe(`${SANDBOX_CHAT_RUNTIME_MOUNT}/node`);
      expect(spec.env.NODE_OPTIONS).toBeUndefined();
      expect(spec.env.PATH).toContain(`${SANDBOX_CHAT_RUNTIME_MOUNT}/venv/bin:${SANDBOX_CHAT_RUNTIME_MOUNT}/node/bin:${SANDBOX_CHAT_RUNTIME_MOUNT}/bin`);
      expect(
        spec.env.PATH!.indexOf(`${SANDBOX_CHAT_RUNTIME_MOUNT}/venv/bin`),
      ).toBeLessThan(spec.env.PATH!.indexOf(`${SANDBOX_DOC_RUNTIME_MOUNT}/venv/bin`));
      expect(spec.env.NODE_PATH).toContain(`${SANDBOX_CHAT_RUNTIME_MOUNT}/node/lib/node_modules`);
      expect(spec.env.NODE_PATH).toContain(`${SANDBOX_DOC_RUNTIME_MOUNT}/node/node_modules`);

      // When docRuntime is unavailable (null), inject NO doc mounts, NO node wrapper/hooks, and NO NODE_OPTIONS/NODE_PATH
      const noDocSpec = buildAgyCommandSpec({
        config: { ...baseCfg, docRuntimeDir: null },
        subcommandArgs: ['acp'],
        profileDir,
        workspaceDir: workspaceA,
        enableSandboxBwrap: true,
      });
      expect(noDocSpec.env.NODE_OPTIONS).toBeUndefined();
      expect(noDocSpec.env.NODE_PATH).toBeUndefined();
      expect(noDocSpec.env.AGY_NODE_LAYER_PATHS).toBeUndefined();
      expect(noDocSpec.env.SAL_USE_VCLPLUGIN).toBeUndefined();
      const noDocArgsStr = noDocSpec.args.join('\n');
      expect(noDocArgsStr).not.toContain(SANDBOX_DOC_RUNTIME_MOUNT);
      expect(noDocArgsStr).not.toContain('--tmpfs\n/usr/local');
      // Normal agy acp launch and standard Node ESM execution stay unaffected without docRuntime
      const fakeEsmAgy = path.join(mockBinDir, 'agy-esm.mjs');
      fs.writeFileSync(
        fakeEsmAgy,
        '#!/usr/bin/env node\nimport path from "node:path";\nconst hasHook = Boolean(process.env.NODE_OPTIONS) || process.execArgv.some((a) => a.includes("esm-register"));\nconsole.log("AGY_ESM_OK", hasHook ? "HOOKED" : "NO_HOOK", path.basename("/a/b"), process.argv.slice(2).join(","));\n',
        { mode: 0o755 },
      );
      const cleanNodeRes = execFileSync(
        fakeEsmAgy,
        ['acp', '--disable-telemetry'],
        { cwd: workspaceA, env: { ...process.env, ...noDocSpec.env }, encoding: 'utf8' },
      );
      expect(cleanNodeRes.trim()).toBe('AGY_ESM_OK NO_HOOK b acp,--disable-telemetry');

      // Per-chat persistent HOME isolation test: Chat A writes stay persistent in Chat A and invisible in Chat B
      ensurePerChatHomeDir(profileDir, workspaceA, builtinSkillsDir);
      const chatHomeB = ensurePerChatHomeDir(profileDir, workspaceB, builtinSkillsDir);
      expect(fs.existsSync(path.join(chatHome, '.config', 'profile-only-xdg.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(chatHome, '.gemini', 'oauth_creds.json'), 'utf8')).toContain('shared');
      expect(fs.readFileSync(path.join(chatHomeB, '.gemini', 'oauth_creds.json'), 'utf8')).toContain('shared');
      expect(fs.readFileSync(path.join(chatHome, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).toContain('dark');
      execFileSync(
        'sh',
        [
          '-c',
          'mkdir -p "$HOME/.config" "$HOME/.local/share" && printf "A" > "$HOME/.config/example" && printf "persist-A" > "$HOME/chat-note.txt" && printf "db-A" > "$HOME/.local/share/tool.db"',
        ],
        { cwd: workspaceA, env: { ...process.env, HOME: chatHome }, encoding: 'utf8' },
      );
      // Re-running ensurePerChatHomeDir & buildAgyCommandSpec preserves Chat A's HOME files
      ensurePerChatHomeDir(profileDir, workspaceA, builtinSkillsDir);
      buildAgyCommandSpec({
        config: baseCfg,
        subcommandArgs: ['acp'],
        profileDir,
        workspaceDir: workspaceA,
        enableSandboxBwrap: true,
      });
      const homeIsolationCheck = execFileSync(
        'sh',
        [
          '-c',
          [
            'cat "$CHAT_A_HOME/.config/example"',
            'cat "$CHAT_A_HOME/chat-note.txt"',
            'test ! -e "$CHAT_B_HOME/.config/example" && echo B_CONFIG_ISOLATED',
            'test ! -e "$CHAT_B_HOME/chat-note.txt" && echo B_HOME_ISOLATED',
            'test ! -e "$CHAT_B_HOME/.local/share/tool.db" && echo B_LOCAL_ISOLATED',
            'test ! -e "$PROFILE_DIR/.config/example" && echo PROFILE_UNTOUCHED',
          ].join(' && '),
        ],
        {
          cwd: tmpRoot,
          env: {
            ...process.env,
            CHAT_A_HOME: chatHome,
            CHAT_B_HOME: chatHomeB,
            PROFILE_DIR: profileDir,
          },
          encoding: 'utf8',
        },
      );
      expect(homeIsolationCheck).toContain('A');
      expect(homeIsolationCheck).toContain('persist-A');
      expect(homeIsolationCheck).toContain('B_CONFIG_ISOLATED');
      expect(homeIsolationCheck).toContain('B_HOME_ISOLATED');
      expect(homeIsolationCheck).toContain('B_LOCAL_ISOLATED');
      expect(homeIsolationCheck).toContain('PROFILE_UNTOUCHED');

      // Live execution acceptance test: Chat A & Chat B with real python, pip, node CJS & ESM, npm, and shell subshells
      // Specifically verify workspaces with NO ancestor node_modules (matching agy CLI inner sandbox) and ZERO NODE_OPTIONS
      const layout = resolveDocRuntimeLayout(docRuntimeDir);
      expect(layout).toBeTruthy();
      const expectedChatRuntimeA = path.join(profileDir, '.chat-runtime', 'workspace-a');
      const expectedChatRuntimeB = path.join(profileDir, '.chat-runtime', 'workspace-b');
      const chatRuntimeA = ensurePerChatRuntimeDir(profileDir, workspaceA, layout, docRuntimeDir, expectedChatRuntimeA);
      const chatRuntimeB = ensurePerChatRuntimeDir(profileDir, workspaceB, layout, docRuntimeDir, expectedChatRuntimeB);
      const simRootA = path.join(tmpRoot, 'sim-root-a');
      const simRootB = path.join(tmpRoot, 'sim-root-b');
      const simWorkspaceA = path.join(simRootA, 'workspace');
      const simWorkspaceB = path.join(simRootB, 'workspace');
      fs.mkdirSync(simWorkspaceA, { recursive: true });
      fs.mkdirSync(simWorkspaceB, { recursive: true });

      const buildTestLayerEnv = (chatRuntime: string): NodeJS.ProcessEnv => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.NODE_OPTIONS;
        delete env.NODE_PATH;
        delete env.PYTHONPATH;
        applySandboxLayeredRuntime(env, layout, null, {
          chatRuntimeMount: chatRuntime,
          docRuntimeMount: docRuntimeDir,
        });
        return env;
      };

      const envA = buildTestLayerEnv(chatRuntimeA);
      const envB = buildTestLayerEnv(chatRuntimeB);
      expect(envA.NODE_OPTIONS).toBeUndefined();

      // Even when docRuntime IS present and #!/usr/bin/env node hits chatRuntime/bin/node, agy acp bypasses ESM hooks
      const agyBypassCheck = execFileSync(
        fakeEsmAgy,
        ['acp', '--disable-telemetry'],
        { cwd: simWorkspaceA, env: envA, encoding: 'utf8' },
      );
      expect(agyBypassCheck.trim()).toBe('AGY_ESM_OK NO_HOOK b acp,--disable-telemetry');
      const regularNodeHookCheck = execFileSync(
        'node',
        ['-e', 'console.log(process.execArgv.some((a) => a.includes("esm-register")))'],
        { cwd: simWorkspaceA, env: envA, encoding: 'utf8' },
      );
      expect(regularNodeHookCheck.trim()).toBe('true');

      fs.writeFileSync(
        path.join(simWorkspaceA, 'check-base.mjs'),
        [
          "import d from 'docx';",
          "import p from 'pptxgenjs';",
          "import l from 'pdf-lib';",
          "import s from '@myscope/doc-scoped';",
          "console.log('ESM_FILE:', d.source, p.source, l.source, s.source);",
        ].join('\n'),
      );

      // 1. Standard python import + Node CJS require() + Node ESM import (stdin & .mjs file + scoped) resolve base packages with ZERO NODE_OPTIONS and ZERO ancestor node_modules
      const baseCheckA = execFileSync(
        'sh',
        [
          '-c',
          [
            'test -z "${NODE_OPTIONS:-}"',
            'python -c "import docx, pptx, openpyxl, pypdf; print(docx.SOURCE, pptx.SOURCE, openpyxl.SOURCE, pypdf.SOURCE)"',
            'node -e "const d = require(\'docx\'); const p = require(\'pptxgenjs\'); const l = require(\'pdf-lib\'); console.log(\'CJS:\', d.source, p.source, l.source)"',
            'node --input-type=module -e "import d from \'docx\'; import p from \'pptxgenjs\'; import l from \'pdf-lib\'; import s from \'@myscope/doc-scoped\'; console.log(\'ESM:\', d.source, p.source, l.source, s.source)"',
            'node check-base.mjs',
          ].join(' && '),
        ],
        { cwd: simWorkspaceA, env: envA, encoding: 'utf8' },
      );
      expect(baseCheckA).toContain('base-docx-1.0 base-pptx-1.0 base-openpyxl-1.0 base-pypdf-1.0');
      expect(baseCheckA).toContain('CJS: base-docx-cjs base-pptxgenjs-cjs base-pdf-lib-cjs');
      expect(baseCheckA).toContain('ESM: base-docx-esm base-pptxgenjs-esm base-pdf-lib-esm base-scoped-base-pdf-lib-esm');
      expect(baseCheckA).toContain('ESM_FILE: base-docx-esm base-pptxgenjs-esm base-pdf-lib-esm base-scoped-base-pdf-lib-esm');

      // 2. Chat A installs a custom Python package and overrides base openpyxl via standard `pip install`,
      //    and installs Node packages globally (both new & base override) via `npm install -g`
      const pyAddonSrc = path.join(tmpRoot, 'py-addon-src');
      fs.mkdirSync(path.join(pyAddonSrc, 'chat_only_py'), { recursive: true });
      fs.writeFileSync(
        path.join(pyAddonSrc, 'setup.py'),
        'from setuptools import setup\nsetup(name="chat-only-py", version="1.0", packages=["chat_only_py"])\n',
      );
      fs.writeFileSync(path.join(pyAddonSrc, 'chat_only_py', '__init__.py'), 'TAG = "chat-a-addon"\n');

      const pyOverrideSrc = path.join(tmpRoot, 'py-override-src');
      fs.mkdirSync(path.join(pyOverrideSrc, 'openpyxl'), { recursive: true });
      fs.writeFileSync(
        path.join(pyOverrideSrc, 'setup.py'),
        'from setuptools import setup\nsetup(name="openpyxl", version="2.0", packages=["openpyxl"])\n',
      );
      fs.writeFileSync(path.join(pyOverrideSrc, 'openpyxl', '__init__.py'), 'SOURCE = "chat-a-openpyxl-2.0"\n');

      const hasPip = (() => {
        try {
          execFileSync('sh', ['-c', 'python -m pip --version'], { env: envA, stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      })();
      if (hasPip) {
        execFileSync(
          'sh',
          ['-c', `pip install --no-build-isolation --no-deps "${pyAddonSrc}" "${pyOverrideSrc}"`],
          { cwd: simWorkspaceA, env: envA, encoding: 'utf8' },
        );
      } else {
        const sp = path.join(chatRuntimeA, 'venv', 'lib', pyVerDir, 'site-packages');
        fs.mkdirSync(path.join(sp, 'chat_only_py'), { recursive: true });
        fs.writeFileSync(path.join(sp, 'chat_only_py', '__init__.py'), 'TAG = "chat-a-addon"\n');
        fs.mkdirSync(path.join(sp, 'openpyxl'), { recursive: true });
        fs.writeFileSync(path.join(sp, 'openpyxl', '__init__.py'), 'SOURCE = "chat-a-openpyxl-2.0"\n');
      }

      const nodeAddonSrc = path.join(tmpRoot, 'node-addon-src');
      fs.mkdirSync(nodeAddonSrc, { recursive: true });
      fs.writeFileSync(
        path.join(nodeAddonSrc, 'package.json'),
        JSON.stringify({
          name: 'chat-only-node',
          version: '1.0.0',
          main: './index.cjs',
          exports: { '.': { import: './index.mjs', require: './index.cjs' } },
        }),
      );
      fs.writeFileSync(path.join(nodeAddonSrc, 'index.cjs'), 'module.exports = { tag: "chat-a-node-cjs" };\n');
      fs.writeFileSync(path.join(nodeAddonSrc, 'index.mjs'), 'export default { tag: "chat-a-node-esm" };\n');

      const nodeOverrideSrc = path.join(tmpRoot, 'node-override-src');
      fs.mkdirSync(nodeOverrideSrc, { recursive: true });
      fs.writeFileSync(
        path.join(nodeOverrideSrc, 'package.json'),
        JSON.stringify({
          name: 'pptxgenjs',
          version: '2.0.0',
          main: './index.cjs',
          exports: { '.': { import: './index.mjs', require: './index.cjs' } },
        }),
      );
      fs.writeFileSync(path.join(nodeOverrideSrc, 'index.cjs'), 'module.exports = { source: "chat-a-pptx-2.0-cjs" };\n');
      fs.writeFileSync(path.join(nodeOverrideSrc, 'index.mjs'), 'export default { source: "chat-a-pptx-2.0-esm" };\n');
      const pptxOverrideTgz = execFileSync('npm', ['pack', '--silent', nodeOverrideSrc], {
        cwd: tmpRoot,
        encoding: 'utf8',
      }).trim();

      execFileSync(
        'sh',
        ['-c', `npm install -g --no-audit --no-fund "${nodeAddonSrc}" "${path.join(tmpRoot, pptxOverrideTgz)}"`],
        {
          cwd: simWorkspaceA,
          env: envA,
          encoding: 'utf8',
        },
      );

      // Simulate worker restart: re-run ensurePerChatRuntimeDir + fresh env
      const chatRuntimeAAfterRestart = ensurePerChatRuntimeDir(profileDir, workspaceA, layout, docRuntimeDir, expectedChatRuntimeA);
      const envAAfterRestart = buildTestLayerEnv(chatRuntimeAAfterRestart);

      // Chat A keeps its additions/overrides after restart across subshell python + node CJS/ESM
      const checkAAfterRestart = execFileSync(
        'bash',
        [
          '-c',
          [
            'python -c "import chat_only_py, openpyxl, pptx; print(chat_only_py.TAG, openpyxl.SOURCE, pptx.SOURCE)"',
            'node -e "console.log(require(\'chat-only-node\').tag, require(\'pptxgenjs\').source)"',
            'node --input-type=module -e "import n from \'chat-only-node\'; import p from \'pptxgenjs\'; import d from \'docx\'; console.log(n.tag, p.source, d.source)"',
          ].join(' && '),
        ],
        { cwd: simWorkspaceA, env: envAAfterRestart, encoding: 'utf8' },
      );
      expect(checkAAfterRestart).toContain('chat-a-addon chat-a-openpyxl-2.0 base-pptx-1.0');
      expect(checkAAfterRestart).toContain('chat-a-node-cjs chat-a-pptx-2.0-cjs');
      expect(checkAAfterRestart).toContain('chat-a-node-esm chat-a-pptx-2.0-esm base-docx-esm');

      // Chat B cannot see Chat A's installed pip or npm packages and still gets untouched base v1
      const checkB = execFileSync(
        'bash',
        [
          '-c',
          [
            'python -c "import openpyxl; print(openpyxl.SOURCE)"',
            'python -c "import chat_only_py" 2>/dev/null && echo LEAK_PY || echo ISOLATED_PY',
            'node -e "console.log(require(\'pptxgenjs\').source)"',
            'node --input-type=module -e "import p from \'pptxgenjs\'; console.log(p.source)"',
            'node -e "try { require(\'chat-only-node\'); console.log(\'LEAK_CJS\'); } catch { console.log(\'ISOLATED_CJS\'); }"',
            'node --input-type=module -e "try { await import(\'chat-only-node\'); console.log(\'LEAK_ESM\'); } catch { console.log(\'ISOLATED_ESM\'); }"',
          ].join(' && '),
        ],
        { cwd: simWorkspaceB, env: envB, encoding: 'utf8' },
      );
      expect(checkB).toContain('base-openpyxl-1.0');
      expect(checkB).toContain('base-pptxgenjs-cjs');
      expect(checkB).toContain('base-pptxgenjs-esm');
      expect(checkB).toContain('ISOLATED_PY');
      expect(checkB).toContain('ISOLATED_CJS');
      expect(checkB).toContain('ISOLATED_ESM');

      // Reconcile when docRuntime becomes null cleans base symlinks, node wrapper, and hooks without deleting per-chat packages
      ensurePerChatRuntimeDir(profileDir, workspaceA, null, docRuntimeDir, expectedChatRuntimeA);
      expect(fs.existsSync(path.join(chatRuntimeA, 'bin', 'node'))).toBe(false);
      expect(fs.existsSync(path.join(chatRuntimeA, 'hooks'))).toBe(false);
      expect(fs.existsSync(path.join(chatRuntimeA, 'node', 'lib', 'node_modules', 'docx'))).toBe(false);
      expect(fs.existsSync(path.join(chatRuntimeA, 'node', 'lib', 'node_modules', 'chat-only-node'))).toBe(true);
      expect(fs.existsSync(path.join(chatRuntimeA, 'node', 'lib', 'node_modules', 'pptxgenjs'))).toBe(true);

      // Upgrade regression test: legacy /opt/agy-doc-runtime symlinks from PR #29 are migrated/cleaned
      // while user-installed real packages and non-managed symlinks are preserved
      const legacyChatWs = path.join(tmpRoot, 'workspace-legacy');
      fs.mkdirSync(legacyChatWs, { recursive: true });
      const legacyNodeModules = path.join(profileDir, '.chat-runtime', 'workspace-legacy', 'node', 'lib', 'node_modules');
      fs.mkdirSync(path.join(legacyNodeModules, '@myscope'), { recursive: true });
      fs.mkdirSync(path.join(legacyNodeModules, '@legacy-scope'), { recursive: true });
      fs.symlinkSync('/opt/agy-doc-runtime/node/node_modules/docx', path.join(legacyNodeModules, 'docx'));
      fs.symlinkSync('/opt/agy-doc-runtime/node/node_modules/removed-base', path.join(legacyNodeModules, 'removed-base'));
      fs.symlinkSync('/opt/agy-doc-runtime/node/node_modules/@myscope/doc-scoped', path.join(legacyNodeModules, '@myscope', 'doc-scoped'));
      fs.symlinkSync('/opt/agy-doc-runtime/node/node_modules/@legacy-scope/stale', path.join(legacyNodeModules, '@legacy-scope', 'stale'));

      // User-installed custom real package & custom symlink must survive migration untouched
      const userRealPkgDir = path.join(legacyNodeModules, 'pptxgenjs');
      fs.mkdirSync(userRealPkgDir, { recursive: true });
      fs.writeFileSync(path.join(userRealPkgDir, 'index.cjs'), 'module.exports = { source: "user-custom-pptx" };\n');
      const userLinkTarget = path.join(tmpRoot, 'user-custom-link-target');
      fs.mkdirSync(userLinkTarget, { recursive: true });
      fs.symlinkSync(userLinkTarget, path.join(legacyNodeModules, 'user-custom-link'));
      fs.symlinkSync(userLinkTarget, path.join(legacyNodeModules, '@myscope', 'user-scoped-link'));

      ensurePerChatRuntimeDir(profileDir, legacyChatWs, layout);
      expect(fs.readlinkSync(path.join(legacyNodeModules, 'docx'))).toBe(
        `${SANDBOX_DOC_RUNTIME_MOUNT}/node/node_modules/docx`,
      );
      expect(fs.readlinkSync(path.join(legacyNodeModules, '@myscope', 'doc-scoped'))).toBe(
        `${SANDBOX_DOC_RUNTIME_MOUNT}/node/node_modules/@myscope/doc-scoped`,
      );
      expect(fs.readdirSync(legacyNodeModules)).not.toContain('removed-base');
      expect(fs.readdirSync(legacyNodeModules)).not.toContain('@legacy-scope');
      expect(fs.lstatSync(userRealPkgDir).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(userRealPkgDir, 'index.cjs'), 'utf8')).toContain('user-custom-pptx');
      expect(fs.readlinkSync(path.join(legacyNodeModules, 'user-custom-link'))).toBe(userLinkTarget);
      expect(fs.readlinkSync(path.join(legacyNodeModules, '@myscope', 'user-scoped-link'))).toBe(userLinkTarget);

      // Re-seeding a legacy symlink and reconciling with docRuntime=null also cleans it without touching user installs
      fs.symlinkSync('/opt/agy-doc-runtime/node/node_modules/pdf-lib', path.join(legacyNodeModules, 'legacy-pdf-lib'));
      ensurePerChatRuntimeDir(profileDir, legacyChatWs, null);
      expect(fs.readdirSync(legacyNodeModules)).not.toContain('legacy-pdf-lib');
      expect(fs.readdirSync(legacyNodeModules)).not.toContain('docx');
      expect(fs.lstatSync(userRealPkgDir).isDirectory()).toBe(true);
      expect(fs.readlinkSync(path.join(legacyNodeModules, 'user-custom-link'))).toBe(userLinkTarget);

      // 3. Non-isolated mode explicitly refuses equivalence guarantees
      const offSpec = buildAgyCommandSpec({
        config: { ...baseCfg, sandboxMode: 'off' },
        subcommandArgs: ['acp'],
        profileDir,
        workspaceDir: workspaceA,
        enableSandboxBwrap: false,
      });
      expect(offSpec.sandboxed).toBe(false);
      expect(offSpec.layeredRuntimeIsolated).toBe(false);
      expect(offSpec.env.NODE_OPTIONS).toBeUndefined();

      const offProbe = probeBwrapSandbox({ ...baseCfg, sandboxMode: 'off' }, false);
      expect(offProbe.active).toBe(false);
      expect(offProbe.layeredRuntimeIsolated).toBe(false);
      expect(offProbe.reason).toContain('保証されません');

      const missingBwrapProbe = probeBwrapSandbox(
        { ...baseCfg, sandboxMode: 'auto', bwrapBin: '/nonexistent/bwrap-bin' },
        false,
      );
      expect(missingBwrapProbe.active).toBe(false);
      expect(missingBwrapProbe.layeredRuntimeIsolated).toBe(false);
      expect(missingBwrapProbe.reason).toContain('保証されません');
    } finally {
      const restoreWriteTree = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        try {
          fs.chmodSync(dir, 0o755);
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) restoreWriteTree(full);
            else fs.chmodSync(full, 0o644);
          }
        } catch {
          // ignore
        }
      };
      restoreWriteTree(docRuntimeDir);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test('Deploy scripts unify under INSTALL_DOC_RUNTIME=auto|0|1 and auto-update swaps read-only builtin-skills safely without hiding failures', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');

    // Ensure legacy split flags are completely gone from deploy scripts & README
    for (const rel of [
      'deploy/setup-doc-runtime.sh',
      'deploy/ubuntu-setup.sh',
      'deploy/apply-bundle.sh',
      'deploy/auto-update.sh',
      'README.md',
    ]) {
      const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      expect(content).not.toContain('INSTALL_LIBREOFFICE');
      expect(content).not.toContain('AUTO_SETUP_DOC_RUNTIME');
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-doc-runtime-script-'));
    let tarballServer: http.Server | null = null;
    try {
      const setupScript = path.join(repoRoot, 'deploy', 'setup-doc-runtime.sh');
      const emptyEnvFile = path.join(tmpRoot, 'missing-env');

      // INSTALL_DOC_RUNTIME=0 always skips cleanly regardless of RAM
      const skipExplicit = execFileSync('bash', [setupScript], {
        env: { ...process.env, INSTALL_DOC_RUNTIME: '0', ENV_FILE: emptyEnvFile },
        encoding: 'utf8',
      });
      expect(skipExplicit).toMatch(/Skipping setup \(INSTALL_DOC_RUNTIME=0\)/);

      // INSTALL_DOC_RUNTIME=auto skips on low-RAM host (<2.2GB)
      const lowMeminfo = path.join(tmpRoot, 'meminfo-low');
      fs.writeFileSync(lowMeminfo, 'MemTotal:        1500000 kB\n', 'utf8');
      const skipAutoLow = execFileSync('bash', [setupScript], {
        env: {
          ...process.env,
          INSTALL_DOC_RUNTIME: 'auto',
          ENV_FILE: emptyEnvFile,
          MEMINFO_FILE: lowMeminfo,
        },
        encoding: 'utf8',
      });
      expect(skipAutoLow).toMatch(/Skipping automatic setup on low-RAM host/);

      // ENV_FILE (/etc/antigravity-chat/env equivalent) can disable setup consistently
      const disabledEnvFile = path.join(tmpRoot, 'chat-env');
      fs.writeFileSync(disabledEnvFile, 'INSTALL_DOC_RUNTIME=0\n', 'utf8');
      const skipViaEnvFile = execFileSync('bash', [setupScript], {
        env: { ...process.env, INSTALL_DOC_RUNTIME: 'auto', ENV_FILE: disabledEnvFile },
        encoding: 'utf8',
      });
      expect(skipViaEnvFile).toMatch(/Skipping setup \(INSTALL_DOC_RUNTIME=0\)/);

      // apply-bundle.sh preserves read-only go-w on builtin-skills
      const appDir = path.join(tmpRoot, 'app');
      const bundleSrc = path.join(tmpRoot, 'bundle-src');
      const bundleTar = path.join(tmpRoot, 'antigravity-chat-bundle.tar.gz');
      const binDir = path.join(tmpRoot, 'bin');
      fs.mkdirSync(path.join(bundleSrc, 'server', 'dist'), { recursive: true });
      fs.mkdirSync(path.join(bundleSrc, 'web', 'dist'), { recursive: true });
      fs.mkdirSync(path.join(bundleSrc, 'builtin-skills', 'docx'), { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(bundleSrc, 'package.json'), '{"name":"agy-chatui"}\n');
      fs.writeFileSync(
        path.join(bundleSrc, 'builtin-skills', 'docx', 'SKILL.md'),
        '---\nname: docx\ndescription: x\n---\n',
        { mode: 0o666 },
      );
      fs.writeFileSync(path.join(bundleSrc, 'setup-doc-runtime.sh'), fs.readFileSync(setupScript, 'utf8'), {
        mode: 0o755,
      });
      execFileSync('tar', ['-czf', bundleTar, '-C', bundleSrc, '.']);

      const fakeAgy = path.join(binDir, 'agy');
      fs.writeFileSync(fakeAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const fakeSystemctl = path.join(binDir, 'systemctl');
      fs.writeFileSync(fakeSystemctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const unitFile = path.join(tmpRoot, 'antigravity-chat.service');
      fs.writeFileSync(
        unitFile,
        `[Service]\nExecStart=/usr/bin/node ${appDir}/server/dist/index.js\n`,
        'utf8',
      );

      const applyOut = execFileSync('bash', [path.join(repoRoot, 'deploy', 'apply-bundle.sh'), bundleTar], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          APP_DIR: appDir,
          SYSTEMD_UNIT_FILE: unitFile,
          CANONICAL_AGY_BIN: fakeAgy,
          DOC_RUNTIME_DIR: path.join(tmpRoot, 'doc-runtime'),
          INSTALL_DOC_RUNTIME: '0',
          ENV_FILE: emptyEnvFile,
        },
        encoding: 'utf8',
      });
      expect(applyOut).toMatch(/Bundle deployed cleanly/);
      const skillMode = fs.statSync(path.join(appDir, 'builtin-skills', 'docx', 'SKILL.md')).mode & 0o777;
      expect(skillMode & 0o022).toBe(0);

      // auto-update.sh git-fallback stages Built-in skills via unprivileged user, replaces read-only existing builtin-skills cleanly, and propagates errors
      const gitRemoteDir = path.join(tmpRoot, 'remote.git');
      const gitSeedDir = path.join(tmpRoot, 'seed');
      const gitAppDir = path.join(tmpRoot, 'git-app');
      fs.mkdirSync(path.join(gitSeedDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(gitSeedDir, '.gitignore'), 'node_modules/\nbuiltin-skills/\n');
      fs.writeFileSync(
        path.join(gitSeedDir, 'package.json'),
        JSON.stringify({ name: 'agy-chatui-test', version: '1.2.3', scripts: { build: 'true' } }) + '\n',
      );
      fs.copyFileSync(
        path.join(repoRoot, 'scripts', 'fetch-anthropic-skills.mjs'),
        path.join(gitSeedDir, 'scripts', 'fetch-anthropic-skills.mjs'),
      );
      execFileSync('git', ['init', '--bare', gitRemoteDir]);
      execFileSync('git', ['init', '-b', 'main', gitSeedDir]);
      execFileSync('git', ['-C', gitSeedDir, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', gitSeedDir, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', gitSeedDir, 'add', '.']);
      execFileSync('git', ['-C', gitSeedDir, 'commit', '-m', 'init']);
      execFileSync('git', ['-C', gitSeedDir, 'remote', 'add', 'origin', gitRemoteDir]);
      execFileSync('git', ['-C', gitSeedDir, 'push', 'origin', 'main']);

      execFileSync('git', ['clone', '--branch', 'main', gitRemoteDir, gitAppDir]);
      fs.mkdirSync(path.join(gitAppDir, 'node_modules'), { recursive: true });
      // Seed pre-existing read-only builtin-skills (simulating root-owned protected install)
      const oldBuiltin = seedBuiltinCatalog(gitAppDir, 'v1');
      fs.chmodSync(path.join(oldBuiltin, 'docx', 'SKILL.md'), 0o444);
      fs.chmodSync(path.join(oldBuiltin, 'docx'), 0o555);

      // Push a new commit to remote so git pull advances
      fs.writeFileSync(path.join(gitSeedDir, 'CHANGELOG.md'), 'v2\n');
      execFileSync('git', ['-C', gitSeedDir, 'add', '.']);
      execFileSync('git', ['-C', gitSeedDir, 'commit', '-m', 'update']);
      execFileSync('git', ['-C', gitSeedDir, 'push', 'origin', 'main']);

      // Build skills-v2 tarball served over local HTTP
      const skillsV2Src = path.join(tmpRoot, 'skills-v2-tar-src', 'anthropics-skills-main');
      fs.mkdirSync(path.join(skillsV2Src, 'skills'), { recursive: true });
      const crypto = await import('node:crypto');
      for (const slug of ['docx', 'pptx', 'xlsx', 'pdf']) {
        writeSkillDir(path.join(skillsV2Src, 'skills'), slug, {
          name: `${slug}-v2`,
          description: `v2 ${slug}`,
          instructions: `Updated v2 ${slug}`,
          files: slug === 'docx' ? { 'references/data.txt': crypto.randomBytes(2048).toString('base64') } : undefined,
        });
      }
      const skillsTarPath = path.join(tmpRoot, 'skills-v2.tar.gz');
      execFileSync('tar', ['-czf', skillsTarPath, '-C', path.dirname(skillsV2Src), 'anthropics-skills-main']);
      const skillsTarBytes = fs.readFileSync(skillsTarPath);

      let serveOk = true;
      tarballServer = http.createServer((_req, res) => {
        if (!serveOk) {
          res.writeHead(500);
          res.end('fail');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': skillsTarBytes.byteLength });
        res.end(skillsTarBytes);
      });
      await new Promise<void>((resolve) => tarballServer!.listen(0, '127.0.0.1', () => resolve()));
      const addr = tarballServer.address() as { port: number };
      const tarballUrl = `http://127.0.0.1:${addr.port}/skills.tar.gz`;

      // Success case: updates read-only builtin-skills to v2 cleanly with go-w permissions
      const { stdout: updateOkOut } = await execFileAsync(
        'bash',
        [path.join(repoRoot, 'deploy', 'auto-update.sh')],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
            APP_DIR: gitAppDir,
            DEPLOY_MODE: 'git',
            GITHUB_REPO: '',
            ENV_FILE: emptyEnvFile,
            LOCK_FILE: path.join(tmpRoot, 'git-update.lock'),
            AGY_AUTO_UPDATE: 'false',
            SYSTEMCTL_BIN: fakeSystemctl,
            ANTHROPIC_SKILLS_TARBALL_URL: tarballUrl,
          },
          encoding: 'utf8',
        },
      );
      expect(updateOkOut).toContain('Updated successfully');
      expect(fs.readFileSync(path.join(gitAppDir, 'builtin-skills', 'docx', 'SKILL.md'), 'utf8')).toContain(
        'Updated v2 docx',
      );
      expect((fs.statSync(path.join(gitAppDir, 'builtin-skills', 'docx', 'SKILL.md')).mode & 0o022)).toBe(0);

      // Failure case: push another commit while tarball endpoint returns 500 -> auto-update must fail (not mask error)
      fs.writeFileSync(path.join(gitSeedDir, 'CHANGELOG.md'), 'v3\n');
      execFileSync('git', ['-C', gitSeedDir, 'add', '.']);
      execFileSync('git', ['-C', gitSeedDir, 'commit', '-m', 'update3']);
      execFileSync('git', ['-C', gitSeedDir, 'push', 'origin', 'main']);
      serveOk = false;

      let failedAsExpected = false;
      try {
        await execFileAsync('bash', [path.join(repoRoot, 'deploy', 'auto-update.sh')], {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
            APP_DIR: gitAppDir,
            DEPLOY_MODE: 'git',
            GITHUB_REPO: '',
            ENV_FILE: emptyEnvFile,
            LOCK_FILE: path.join(tmpRoot, 'git-update.lock'),
            AGY_AUTO_UPDATE: 'false',
            SYSTEMCTL_BIN: fakeSystemctl,
            ANTHROPIC_SKILLS_TARBALL_URL: tarballUrl,
          },
          encoding: 'utf8',
        });
      } catch (err) {
        failedAsExpected = true;
        const stderr = (err as { stderr?: string }).stderr ?? '';
        const stdout = (err as { stdout?: string }).stdout ?? '';
        expect(stdout).not.toContain('Updated successfully');
        expect(stderr).toContain('Failed to fetch Built-in Anthropic document skills');
      }
      expect(failedAsExpected).toBe(true);
      // Existing v2 builtin-skills remains intact on failure
      expect(fs.readFileSync(path.join(gitAppDir, 'builtin-skills', 'docx', 'SKILL.md'), 'utf8')).toContain(
        'Updated v2 docx',
      );
    } finally {
      if (tarballServer) {
        await new Promise<void>((resolve) => tarballServer!.close(() => resolve()));
      }
      // Restore write bits so rmSync cleans up read-only test dirs smoothly
      const oldDocx = path.join(tmpRoot, 'git-app', 'builtin-skills', 'docx');
      if (fs.existsSync(oldDocx)) {
        try {
          fs.chmodSync(oldDocx, 0o755);
        } catch {
          // ignore
        }
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
