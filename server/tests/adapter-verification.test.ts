import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { CodeAdapter } from '../src/artifacts/adapters/code-adapter.js';
import { CsvAdapter } from '../src/artifacts/adapters/csv-adapter.js';
import { HtmlAdapter } from '../src/artifacts/adapters/html-adapter.js';
import { MarkdownAdapter } from '../src/artifacts/adapters/markdown-adapter.js';
import { SvgAdapter } from '../src/artifacts/adapters/svg-adapter.js';
import { MAX_TEXT_VERIFY_BYTES, MAX_VERIFY_DIAGNOSTICS } from '../src/artifacts/adapters/text-verification.js';
import type { AdapterVerifyResult } from '../src/artifacts/types.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

const code = new CodeAdapter();
const html = new HtmlAdapter();
const svg = new SvgAdapter();
const meta = (filename: string, mimeType = 'text/plain') => ({ filename, relPath: filename, mimeType });
const xml = (source: string) => code.verify(Buffer.from(source), meta('example.xml', 'application/xml'));
const yaml = (source: string) => code.verify(Buffer.from(source), meta('example.yaml', 'application/yaml'));
const svgSource = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;
const verifySvg = (source: string) => svg.verify(Buffer.from(source), meta('example.svg', 'image/svg+xml'));
const verifyHtml = (source: string) => html.verify(Buffer.from(source), meta('example.html', 'text/html'));
const check = (result: AdapterVerifyResult, id: string, status: 'passed' | 'failed' | 'unverified') => {
  expect(result.checks).toContainEqual(expect.objectContaining({ id, status }));
};

describe('Verification reports with failed warning-level checks', () => {
  it.each([['example.csv', ','], ['example.tsv', '\t']])('fails the overall report on inconsistent columns in %s', (filename, delimiter) => {
    const report = new CsvAdapter().verify(Buffer.from(`first${delimiter}second\none\n`), meta(filename));
    expect(report).toMatchObject({ ok: false, coverage: 'complete' });
    check(report, 'csv_column_consistency', 'failed');
    expect(report.issues).toEqual([expect.objectContaining({ severity: 'warning', code: 'CSV_COLUMN_COUNT_MISMATCH' })]);
  });

  it.each([
    ['# Title\n### Skipped level\n', 'markdown_headings', 'MD_HEADING_LEVEL_SKIP'],
    ['# Title\n[Missing](#absent)\n', 'markdown_links', 'MD_BROKEN_ANCHOR_LINK'],
  ])('fails the overall Markdown report for %s', (source, id, issueCode) => {
    const report = new MarkdownAdapter().verify(Buffer.from(source), meta('example.md'));
    expect(report).toMatchObject({ ok: false, coverage: 'complete' });
    check(report, id, 'failed');
    expect(report.issues).toEqual([expect.objectContaining({ severity: 'warning', code: issueCode })]);
  });
});

describe('Code adapter syntax verification', () => {
  it('parses JSON, YAML streams and the repository workflow', () => {
    const json = code.verify(Buffer.from('\ufeff{"answer": 42}'), meta('example.json'));
    expect(json).toMatchObject({ ok: true, coverage: 'complete' });
    check(json, 'json_syntax', 'passed');

    const validYaml = [
      '%YAML 1.2', '---', '名前: &host example.test', 'alias: *host',
      'flow: {a null-valued key, nested: [a,', '  "b c", {key: value}]}',
      'summary: >-', '  A valid folded scalar with { and :',
      'list:', '- name: basic', '- script: |', '    echo "a [ b"',
      '...', '---', "'quoted'':scalar': https://example.test:8443/v1",
    ].join('\n');
    expect(yaml(validYaml)).toMatchObject({ ok: true, coverage: 'complete', issues: [] });
    const workflow = path.resolve(import.meta.dirname, '../../.github/workflows/ci-deploy.yml');
    expect(code.verify(fs.readFileSync(workflow), meta('ci-deploy.yml'))).toMatchObject({ ok: true });
  });

  it.each([
    'root:\n\tchild: 1', 'title: "unterminated', 'items: [1, 2', 'note: foo: bar',
    'a: 1\na: 2', 'a: *missing', 'a: *later\nb: &later 1',
    'defaults: &same 1\n---\nvalue: *same', 'value: "\\q"',
  ])('fails malformed YAML %s', (source) => {
    const result = yaml(source);
    expect(result.ok).toBe(false);
    check(result, 'yaml_syntax', 'failed');
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: 'error', location: expect.stringMatching(/^line:\d+$/) }));
  });

  it('recognizes complex YAML keys and custom tags with explicit limits', () => {
    expect(yaml('? [one, two]\n: value')).toMatchObject({ ok: false, coverage: 'partial' });
    const tagged = yaml('template: !app/custom value');
    check(tagged, 'yaml_syntax', 'unverified');
    expect(tagged.issues).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'YAML_TAG_RESOLVE_FAILED' }));
    // Verify anchor order on the AST without resolving or expanding even self aliases.
    expect(yaml('root: &node [*node]')).toMatchObject({ ok: true });
  });

  it('parses Unicode XML names, namespaces, numeric/predefined entities, comments and CDATA', () => {
    const result = xml('<?xml version="1.0" encoding="UTF-8"?><名前 xmlns:a="urn:app"><a:子 value="AT&amp;T &#10; &#x1F600;">'
      + '<!-- &unknown; --><![CDATA[raw <tag> &unknown;]]>&apos;&quot;&lt;&gt;</a:子></名前>');
    expect(result).toMatchObject({ ok: true, coverage: 'complete', issues: [] });
    check(result, 'xml_syntax', 'passed');
  });

  it.each([
    '<root>&unknown;</root>', '<root a="&unknown;"/>', '<root>&#0;</root>', '<root>&#xD800;</root>',
    '<root>&#x110000;</root>', '<root>Fish & Chips</root>', '<root>abc]]>bad</root>',
    '<root><child></other></root>', '<root><child/>', '<a/><b/>', '<a id="1" id="2"/>',
    '<a id=123/>', '<p:root/>', '<r xmlns:a="u" xmlns:b="u" a:key="1" b:key="2"/>',
  ])('fails malformed XML %s', (source) => {
    const result = xml(source);
    expect(result).toMatchObject({ ok: false, coverage: 'complete' });
    check(result, 'xml_syntax', 'failed');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'XML_SYNTAX_ERROR', location: 'line:1' }));
  });

  it.each([
    '<!DOCTYPE root><root/>',
    '<!DOCTYPE root [<!ENTITY local "valid internal entity">]><root>&local;</root>',
    '<!DOCTYPE root SYSTEM "https://example.test/root.dtd"><root/>',
  ])('declares DTD-dependent XML unverified %s', (source) => {
    const result = xml(source);
    expect(result).toMatchObject({ ok: false, coverage: 'partial', issues: [] });
    check(result, 'xml_syntax', 'unverified');
    expect(result.checks?.find(({ id }) => id === 'xml_syntax')?.evidence).toContain('No DTD was loaded or expanded');
  });
});

describe('SVG verification', () => {
  it('passes disjoint rectangles under nested transforms, and skips truly inert definitions/hidden subtrees', () => {
    const result = verifySvg(svgSource([
      '<rect width="100" height="100" fill="white"/>',
      '<defs><path d="M0 0 L130 130"/><symbol id="symbol"><circle r="8"/></symbol></defs>',
      '<g display="none"><use href="#symbol"/></g>',
      '<g transform="translate(30, 10)"><g transform="skewX(15) scale(2)">',
      '<rect width="10" height="10"/>',
      '</g></g>',
      '<rect width="8" height="8" transform="matrix(1 0 0 1 3 3)"/>',
    ].join('')));
    expect(result).toMatchObject({ ok: true, coverage: 'complete', issues: [] });
    check(result, 'svg_overlap', 'passed');
    check(result, 'svg_bounds', 'passed');
  });

  it('distinguishes rotated intersections from overlapping AABBs and detects skewed out-of-bounds shapes', () => {
    const disjoint = verifySvg(svgSource('<g transform="translate(30, 10) rotate(45)">'
      + '<rect width="40" height="2"/><rect y="4" width="40" height="2"/></g>'));
    check(disjoint, 'svg_overlap', 'passed');
    expect(disjoint.metrics?.overlapPairs).toBe(0);
    const intersecting = verifySvg(svgSource('<g transform="translate(30, 10) rotate(45)">'
      + '<rect width="40" height="4"/><rect y="2" width="40" height="4"/></g>'
      + '<rect x="85" y="20" width="10" height="20" transform="skewX(45)"/>'));
    expect(intersecting).toMatchObject({ ok: false, coverage: 'complete' });
    check(intersecting, 'svg_overlap', 'failed');
    check(intersecting, 'svg_bounds', 'failed');
    expect(intersecting.metrics).toMatchObject({ overlapPairs: 1, outOfViewBoxCount: 1 });
  });

  it('measures convex polygons and treats a root transform as moving the viewport itself', () => {
    const result = verifySvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" transform="translate(900)">'
      + '<polygon points="0,0 10,0 0,10" transform="translate(5 5)"/>'
      + '<rect x="8" y="8" width="3" height="3"/></svg>');
    check(result, 'svg_overlap', 'failed');
    check(result, 'svg_bounds', 'passed');
    expect(result.metrics).toMatchObject({ measuredElements: 2, overlapPairs: 1, outOfViewBoxCount: 0 });
  });

  it.each([
    '<use href="#shape"/>', '<polygon points="0,0 9,0 6,5 9,9 0,9"/>', '<text x="20" y="30">label</text>', '<svg viewBox="0 0 5 5"><rect width="5" height="5"/></svg>',
    '<rect width="20%" height="20"/>', '<rect transform="not-a-transform translate(10)" width="20" height="20"/>',
    '<g clip-path="url(#c)"><rect width="20" height="20"/></g>',
    '<defs><style>rect { transform: translateX(80px); }</style></defs><rect width="20" height="20"/>',
  ])('reports unmeasured SVG geometry as partial %s', (source) => {
    const result = verifySvg(svgSource(source));
    expect(result).toMatchObject({ ok: false, coverage: 'partial' });
    check(result, 'svg_xml_syntax', 'passed');
    check(result, 'svg_overlap', 'unverified');
    check(result, 'svg_bounds', 'unverified');
  });

  it('honors child visibility overrides and discloses exclusions even with definitive findings', () => {
    const result = verifySvg(svgSource('<g visibility="hidden"><rect visibility="visible" width="20" height="20"/>'
      + '<rect visibility="visible" width="10" height="10"/><rect width="15" height="15"/></g><circle r="9"/>'));
    expect(result).toMatchObject({ ok: false, coverage: 'partial' });
    check(result, 'svg_overlap', 'failed');
    check(result, 'svg_overlap_remaining', 'unverified');
    expect(result.metrics).toMatchObject({ measuredElements: 2, overlapPairs: 1 });
  });

  it('handles missing and zero viewBox separately from syntax errors', () => {
    const missing = verifySvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>');
    check(missing, 'svg_xml_syntax', 'passed');
    check(missing, 'svg_viewbox', 'unverified');
    const zero = verifySvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 100"/>');
    check(zero, 'svg_viewbox', 'passed');
    check(zero, 'svg_overlap', 'unverified');
    const bad = verifySvg(svgSource('<g>&unknown;</g>'));
    check(bad, 'svg_xml_syntax', 'failed');
    check(bad, 'svg_security', 'unverified');
    check(bad, 'svg_overlap', 'unverified');
    check(verifySvg('<svg xmlns="urn:wrong"/>'), 'svg_xml_syntax', 'failed');
  });

  it('uses decoded XML attribute values for static active-content indicators', () => {
    const result = verifySvg(svgSource('<script/><a href="java&#x09;script:example" onload="doSomething()"/>'));
    expect(result.ok).toBe(false);
    check(result, 'svg_security', 'failed');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'SVG_DANGEROUS_HANDLER' }));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'SVG_DANGEROUS_SCRIPT' }));
    check(verifySvg(svgSource('<rect id="javascript:label" width="10" height="10"/>')), 'svg_security', 'passed');
  });
});

describe('HTML syntax, revision references and viewer CSP', () => {
  it('supports optional HTML end tags, foreign content and inert template resources', () => {
    const result = verifyHtml('<!doctype html><title>A &copy; B</title><style>body{font-family:sans-serif}</style>'
      + '<ul><li>First<li>Second</ul><table><tr><td>One<td>Two</table>'
      + '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'
      + '<template><img src="elsewhere.png"></template><script type="application/json">{"a":1}</script>'
      + '<img src="data:image/png;base64,abc" alt="">');
    expect(result).toMatchObject({ ok: true, coverage: 'complete', issues: [] });
    check(result, 'html_syntax', 'passed');
    check(result, 'html_csp', 'passed');
  });

  it.each(['<p id=x id=y>hello', '<div><span>mismatch</div>', '<div/>', '<p>&unknown;</p>', '<!-- unterminated'])(
    'detects parser or required end-tag errors %s', (source) => {
      const result = verifyHtml(source);
      expect(result).toMatchObject({ ok: false, coverage: 'partial' });
      check(result, 'html_syntax', 'failed');
      check(result, 'html_csp', 'unverified');
    }
  );

  it('distinguishes local dependencies, URL decoding, external style/script/image limits and inline JS', () => {
    const result = html.verify(Buffer.from('<!doctype html><link rel="stylesheet" href="https://example.test/app.css">'
      + '<img src="logo&#46;png"><img src="../../bad.png"><img src="&#x68;ttps://example.test/remote.png">'
      + '<script>const text = "fetch("; // not a network request\n</script><iframe src="child.html"></iframe>'
      + '<video src="data:video/mp4,AA"></video><form></form>'), {
      ...meta('index.html'), dependencies: [{ relPath: 'logo.png', status: 'present' }],
    });
    expect(result).toMatchObject({ ok: false, coverage: 'partial' });
    check(result, 'html_syntax', 'passed');
    check(result, 'html_relative_refs', 'failed');
    check(result, 'html_csp', 'failed');
    check(result, 'html_csp_remaining', 'unverified');
    expect(result.issues.map((i) => i.code)).toEqual(expect.arrayContaining([
      'HTML_RELATIVE_REF_OUTSIDE_ROOT', 'HTML_CSP_BLOCKED_STYLE', 'HTML_CSP_BLOCKED_IMAGE',
      'HTML_CSP_BLOCKED_EMBED', 'HTML_CSP_BLOCKED_MEDIA', 'HTML_CSP_BLOCKED_FORM_ACTION',
    ]));
    expect(result.issues.map((i) => i.code)).not.toContain('HTML_CSP_BLOCKED_CONNECT');
  });

  it('checks CSS resource types and escapes without matching comments or local SVG fragments', () => {
    const result = verifyHtml(String.raw`<style>
      /* .comment { background: url(https://example.test/ignored) } */
      @import 'https://example.test/theme.css';
      @font-face { font-family: demo; src: url(https://example.test/font.woff); }
      p { background: url(\68 ttps://example.test/img.png); filter: url(#local); }
    </style><p style="background:url(data:image/png;base64,abc)">Sample</p>`);
    check(result, 'html_csp', 'failed');
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'HTML_CSP_BLOCKED_STYLE', 'HTML_CSP_BLOCKED_FONT', 'HTML_CSP_BLOCKED_IMAGE',
    ]);
  });

  it('leaves active meta CSP, srcset/data mixtures and base-URL resolution unverified', () => {
    const result = verifyHtml('<!doctype html><head>'
      + '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; frame-ancestors \'none\'">'
      + '<base href="./resources/"></head><img src="a.png" srcset="data:image/png;base64,abc 1x, b.png 2x">');
    check(result, 'html_relative_refs', 'unverified');
    check(result, 'html_csp', 'failed');
    check(result, 'html_csp_remaining', 'unverified');
    expect(result.issues.map((issue) => issue.code)).toContain('HTML_META_CSP_IGNORED_DIRECTIVE');
    const onlyMeta = verifyHtml('<meta http-equiv="Content-Security-Policy" content="default-src *"><p>ok');
    check(onlyMeta, 'html_csp', 'unverified');
    expect(onlyMeta.ok).toBe(false);
  });

  it('keeps revision manifest results separate from what the sandbox will load', async () => {
    const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
    try {
      const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'htmlverify', 'user:htmlverify');
      const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'HTML Verify' });
      const create = (relPath: string, content: Buffer) => srv.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId: chat.id, relPath, content, actorKind: 'user',
      });
      await create('assets/pixel.png', Buffer.from('image'));
      for (const [name, context, status] of [['existing.html', 'pixel.png', 'passed'], ['missing.html', 'nope.png', 'failed']] as const) {
        const { artifact } = await create(name, Buffer.from(`<img src="./assets/${context}">`));
        const report = await srv.ctx.artifactService.verifyArtifact(userId, artifact.id);
        expect(report).toMatchObject({ ok: false, revision: artifact.revision, sha256: artifact.sha256 });
        check(report, 'html_relative_refs', status);
        check(report, 'html_csp', 'failed');
        const view = await client.request('GET', `/api/files/${artifact.id}/sandbox`);
        expect(view.status).toBe(200);
        expect(view.headers.get('Content-Security-Policy')).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self';");
        expect(view.data).toContain('agy-sandbox-zoom');
      }
      const { artifact } = await create('large.html', Buffer.from(' '.repeat(MAX_TEXT_VERIFY_BYTES + 1)));
      const report = await srv.ctx.artifactService.verifyArtifact(userId, artifact.id);
      expect(report).toMatchObject({ ok: false, coverage: 'partial', revision: artifact.revision, sha256: artifact.sha256 });
      expect(report.checks?.every(({ status }) => status === 'unverified')).toBe(true);
      expect((await client.request('GET', `/api/files/${artifact.id}/sandbox`)).status).toBe(200);
    } finally {
      await srv.cleanup();
    }
  });

  it.skipIf(!process.env.PLAYWRIGHT_EXECUTABLE_PATH)('agrees with actual Chromium on sandbox requests and inline execution', async () => {
    const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
      const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'browserverify', 'user:browserverify');
      const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'CSP' });
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLj0AAAAASUVORK5CYII=';
      const { artifact } = await srv.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId: chat.id, relPath: 'probe.html', actorKind: 'user',
        content: Buffer.from(`<!doctype html><html><head><script>
          window.violations = [];
          document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective));
        </script><script src="./probe.js"></script><link rel="stylesheet" href="./probe.css"></head><body>
        <style>#allowed { color: rgb(1, 2, 3); }</style><p id="allowed">Probe</p>
        <img id="local" src="./probe.png"><img id="data" src="data:image/png;base64,${png}">
        <script>fetch('./probe.json').catch(() => {}); document.body.dataset.inline = 'yes';</script></body></html>`),
      });
      const report = await srv.ctx.artifactService.verifyArtifact(userId, artifact.id);
      check(report, 'html_csp', 'failed');
      check(report, 'html_csp_remaining', 'unverified');
      expect(report.issues.map((i) => i.code)).toEqual(expect.arrayContaining([
        'HTML_CSP_BLOCKED_IMAGE', 'HTML_CSP_BLOCKED_STYLE', 'HTML_CSP_BLOCKED_SCRIPT',
      ]));

      const context = await browser.newContext();
      await context.addCookies(client.cookieHeader.split('; ').map((header) => {
        const eq = header.indexOf('=');
        return { name: header.slice(0, eq), value: header.slice(eq + 1), url: srv.baseUrl };
      }));
      const page = await context.newPage();
      const viewUrl = `${srv.baseUrl}/api/files/${artifact.id}/sandbox`;
      const parentUrl = `${srv.baseUrl}/csp-probe-parent`;
      await page.route(parentUrl, (route) => route.fulfill({
        contentType: 'text/html', body: `<iframe sandbox="allow-scripts" src="${viewUrl}"></iframe>`,
      }));
      await page.goto(parentUrl);
      const frame = page.frames().find((child) => child.url() === viewUrl)!;
      await frame.waitForFunction(() => (window as unknown as { violations?: string[] }).violations?.length === 4);
      expect(await frame.evaluate(() => ({
        violations: (window as unknown as { violations: string[] }).violations.sort(),
        inline: document.body.dataset.inline,
        color: getComputedStyle(document.getElementById('allowed')!).color,
        dataImageWidth: (document.getElementById('data') as HTMLImageElement).naturalWidth,
        localImageWidth: (document.getElementById('local') as HTMLImageElement).naturalWidth,
        origin: window.origin,
      }))).toEqual({
        violations: ['connect-src', 'img-src', 'script-src-elem', 'style-src-elem'],
        inline: 'yes', color: 'rgb(1, 2, 3)', dataImageWidth: 1, localImageWidth: 0, origin: 'null',
      });
    } finally {
      await browser?.close();
      await srv.cleanup();
    }
  }, 20_000);
});

describe('Verification resource budgets and coverage', () => {
  it('caps source bytes before decoding and avoids syntax success on invalid UTF-8', () => {
    for (const [adapter, name, encoding, syntax] of [
      [code, 'a.yaml', 'code_encoding', 'yaml_syntax'],
      [svg, 'a.svg', 'svg_encoding', 'svg_xml_syntax'],
      [html, 'a.html', 'html_encoding', 'html_syntax'],
    ] as const) {
      const oversized = adapter.verify(Buffer.alloc(MAX_TEXT_VERIFY_BYTES + 1, 0x20), meta(name));
      expect(oversized).toMatchObject({ ok: false, coverage: 'partial' });
      expect(oversized.checks?.every(({ status }) => status === 'unverified')).toBe(true);
      for (const bytes of [Buffer.from([0xff]), Buffer.from([0x00])]) {
        const report = adapter.verify(bytes, meta(name));
        expect(report).toMatchObject({ ok: false, coverage: 'partial' });
        check(report, encoding, 'failed');
        check(report, syntax, 'unverified');
      }
    }
  });

  it('caps YAML entries and depth, HTML/XML depth and node counts, and SVG pairwise work', () => {
    check(yaml(Array.from({ length: 2_000 }, (_, i) => `key${i}: ${i}`).join('\n')), 'yaml_syntax', 'unverified');
    check(yaml('['.repeat(2_000) + '0' + ']'.repeat(2_000)), 'yaml_syntax', 'unverified');
    check(xml('<a>'.repeat(200) + '</a>'.repeat(200)), 'xml_syntax', 'unverified');
    check(xml(`<root>${'<a/>'.repeat(15_000)}</root>`), 'xml_syntax', 'unverified');
    check(verifyHtml('<div>'.repeat(200) + '</div>'.repeat(200)), 'html_syntax', 'unverified');
    check(verifyHtml('<br>'.repeat(15_000)), 'html_syntax', 'unverified');
    check(verifyHtml('<!---->'.repeat(15_000)), 'html_syntax', 'unverified');
    const result = verifySvg(svgSource('<rect width="10" height="10"/>'.repeat(401)));
    check(result, 'svg_overlap', 'unverified');
    check(result, 'svg_bounds', 'passed');
    expect(result.metrics).not.toHaveProperty('overlapPairs');
  });

  it('caps emitted diagnostics while retaining known failures', () => {
    const result = verifySvg(svgSource('<rect width="10" height="10"/>'.repeat(30)));
    check(result, 'svg_overlap', 'failed');
    expect(result).toMatchObject({ ok: false, coverage: 'complete', metrics: { overlapPairs: 435 } });
    expect(result.issues).toHaveLength(MAX_VERIFY_DIAGNOSTICS);
  });
});
