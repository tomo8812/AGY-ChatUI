import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodeAdapter } from '../src/artifacts/adapters/code-adapter.js';
import { HtmlAdapter } from '../src/artifacts/adapters/html-adapter.js';
import { SvgAdapter } from '../src/artifacts/adapters/svg-adapter.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

describe('CodeAdapter, SvgAdapter, and HtmlAdapter verification (Sec 4.3 / MCP-09)', () => {
  const codeAdapter = new CodeAdapter();
  const svgAdapter = new SvgAdapter();
  const htmlAdapter = new HtmlAdapter();

  describe('CodeAdapter: JSON, YAML, and XML syntax validation', () => {
    it('passes valid JSON, valid complex YAML (including real repo workflow), and valid XML', () => {
      const jsonRes = codeAdapter.verify(Buffer.from('{"name":"agy","count":3,"ok":true}\n', 'utf8'), {
        filename: 'config.json',
        relPath: 'config.json',
        mimeType: 'application/json',
      });
      expect(jsonRes.ok).toBe(true);
      expect(jsonRes.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'code_encoding', status: 'passed' }),
        expect.objectContaining({ id: 'json_syntax', status: 'passed' }),
      ]));

      const validYaml = [
        '---',
        '# Service manifest',
        'name: agy-service',
        'endpoint: https://example.com:8443/v1',
        'schedule: "12:30:00"',
        'env:',
        '  NODE_ENV: production',
        '  inline_map: { host: localhost, port: 8080 }',
        '  inline_list: [alpha, beta, "gamma: delta"]',
        'items:',
        '- id: 1',
        '  script: |',
        '    if [ "a" = "b" ]; then',
        '      echo "unclosed { in literal block is fine: yes"',
        '    fi',
        '- id: 2',
        '  description: >-',
        '    Multi-line folded',
        '    description text.',
        '...',
      ].join('\n');
      const yamlRes = codeAdapter.verify(Buffer.from(validYaml, 'utf8'), {
        filename: 'deploy.yaml',
        relPath: 'deploy.yaml',
        mimeType: 'text/yaml',
      });
      expect(yamlRes.ok).toBe(true);
      expect(yamlRes.issues).toHaveLength(0);
      expect(yamlRes.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'yaml_syntax', status: 'passed' }),
      ]));

      // Validate the repository's own real GitHub Actions YAML workflow to ensure zero false positives
      const realWorkflowPath = path.resolve(import.meta.dirname, '../../.github/workflows/ci-deploy.yml');
      expect(fs.existsSync(realWorkflowPath)).toBe(true);
      const wfRes = codeAdapter.verify(fs.readFileSync(realWorkflowPath), {
        filename: 'ci-deploy.yml',
        relPath: '.github/workflows/ci-deploy.yml',
        mimeType: 'text/yaml',
      });
      expect(wfRes.ok).toBe(true);
      expect(wfRes.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'yaml_syntax', status: 'passed' }),
      ]));

      const validXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- valid XML comment -->',
        '<catalog xmlns:app="https://example.com/ns">',
        '  <item id="1" app:flag=\'true\'>AT&amp;T &#10; <![CDATA[raw <tag> & text]]></item>',
        '  <empty/>',
        '</catalog>',
      ].join('\n');
      const xmlRes = codeAdapter.verify(Buffer.from(validXml, 'utf8'), {
        filename: 'catalog.xml',
        relPath: 'catalog.xml',
        mimeType: 'application/xml',
      });
      expect(xmlRes.ok).toBe(true);
      expect(xmlRes.issues).toHaveLength(0);
      expect(xmlRes.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'xml_syntax', status: 'passed' }),
      ]));
    });

    it('rejects invalid YAML constructs with line-numbered errors', () => {
      const cases: Array<{ name: string; content: string; expectedCode: string }> = [
        {
          name: 'tab indentation',
          content: 'root:\n\tchild: 1\n',
          expectedCode: 'YAML_TAB_INDENT',
        },
        {
          name: 'unclosed double quote',
          content: 'title: "hello world\nother: 1\n',
          expectedCode: 'YAML_UNCLOSED_QUOTE',
        },
        {
          name: 'unbalanced flow brackets',
          content: 'items: [1, 2, 3\n',
          expectedCode: 'YAML_UNBALANCED_FLOW',
        },
        {
          name: 'malformed flow mapping entry',
          content: 'obj: { alpha 1, beta: 2 }\n',
          expectedCode: 'YAML_INVALID_FLOW_MAPPING',
        },
        {
          name: 'bad dedent indentation',
          content: 'a:\n  b:\n    c: 1\n   d: 2\n',
          expectedCode: 'YAML_BAD_INDENTATION',
        },
        {
          name: 'duplicate mapping key',
          content: 'service:\n  port: 80\n  port: 443\n',
          expectedCode: 'YAML_DUPLICATE_KEY',
        },
        {
          name: 'unquoted nested colon-space in scalar',
          content: 'note: foo: bar\n',
          expectedCode: 'YAML_MAPPING_VALUE_NOT_ALLOWED',
        },
        {
          name: 'orphan non-mapping line in mapping',
          content: 'a: 1\nbad_entry_without_colon\n',
          expectedCode: 'YAML_SYNTAX_ERROR',
        },
      ];

      for (const tc of cases) {
        const res = codeAdapter.verify(Buffer.from(tc.content, 'utf8'), {
          filename: 'bad.yml',
          relPath: 'bad.yml',
          mimeType: 'text/yaml',
        });
        expect(res.ok, tc.name).toBe(false);
        expect(res.checks, tc.name).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'yaml_syntax', status: 'failed' }),
        ]));
        expect(res.issues, tc.name).toEqual(expect.arrayContaining([
          expect.objectContaining({ severity: 'error', code: tc.expectedCode }),
        ]));
      }
    });

    it('rejects malformed XML and XXE/external DTD declarations', () => {
      const cases: Array<{ name: string; content: string; expectedCode: string }> = [
        {
          name: 'mismatched closing tag',
          content: '<root><child></other></root>',
          expectedCode: 'XML_MISMATCHED_TAG',
        },
        {
          name: 'unclosed element',
          content: '<root><child>text</root>',
          expectedCode: 'XML_MISMATCHED_TAG',
        },
        {
          name: 'unclosed root at EOF',
          content: '<root><child/>',
          expectedCode: 'XML_UNCLOSED_TAG',
        },
        {
          name: 'duplicate attribute',
          content: '<root id="1" id="2"/>',
          expectedCode: 'XML_DUPLICATE_ATTRIBUTE',
        },
        {
          name: 'unquoted attribute',
          content: '<root id=123/>',
          expectedCode: 'XML_INVALID_ATTRIBUTE',
        },
        {
          name: 'unescaped ampersand',
          content: '<root>Fish & Chips</root>',
          expectedCode: 'XML_UNESCAPED_AMP',
        },
        {
          name: 'multiple root elements',
          content: '<a/><b/>',
          expectedCode: 'XML_MULTIPLE_ROOTS',
        },
        {
          name: 'XXE entity declaration',
          content: '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>',
          expectedCode: 'XML_ENTITY_DECLARATION',
        },
        {
          name: 'external DTD reference',
          content: '<!DOCTYPE foo SYSTEM "http://evil.example/dtd"><foo/>',
          expectedCode: 'XML_EXTERNAL_DTD',
        },
      ];

      for (const tc of cases) {
        const res = codeAdapter.verify(Buffer.from(tc.content, 'utf8'), {
          filename: 'bad.xml',
          relPath: 'bad.xml',
          mimeType: 'application/xml',
        });
        expect(res.ok, tc.name).toBe(false);
        expect(res.checks, tc.name).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'xml_syntax', status: 'failed' }),
        ]));
        expect(res.issues, tc.name).toEqual(expect.arrayContaining([
          expect.objectContaining({ severity: 'error', code: tc.expectedCode }),
        ]));
      }
    });
  });

  describe('SvgAdapter: XML well-formedness, viewBox, XSS, and overlap validation', () => {
    it('passes a clean, well-formed, non-overlapping SVG diagram with labeled boxes', () => {
      const cleanSvg = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">',
        '  <rect id="bg" x="0" y="0" width="400" height="200" fill="#ffffff"/>',
        '  <rect id="box1" x="20" y="40" width="140" height="60" fill="#e0f2fe"/>',
        '  <text id="lbl1" x="90" y="75" font-size="14" text-anchor="middle">Client</text>',
        '  <line x1="160" y1="70" x2="240" y2="70" stroke="#334155" stroke-width="2"/>',
        '  <rect id="box2" x="240" y="40" width="140" height="60" fill="#dcfce7"/>',
        '  <text id="lbl2" x="310" y="75" font-size="14" text-anchor="middle">Server</text>',
        '</svg>',
      ].join('\n');

      const res = svgAdapter.verify(Buffer.from(cleanSvg, 'utf8'), {
        filename: 'arch.svg',
        relPath: 'arch.svg',
        mimeType: 'image/svg+xml',
      });
      expect(res.ok).toBe(true);
      expect(res.coverage).toBe('complete');
      expect(res.issues).toHaveLength(0);
      expect(res.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'svg_xml_syntax', status: 'passed' }),
        expect.objectContaining({ id: 'svg_viewbox', status: 'passed' }),
        expect.objectContaining({ id: 'svg_security', status: 'passed' }),
        expect.objectContaining({ id: 'svg_overlap', status: 'passed' }),
      ]));
    });

    it('rejects malformed SVG XML, invalid viewBox, and XSS payloads', () => {
      const brokenXml = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g><rect x="0" y="0" width="20" height="20"/></svg>';
      const brokenRes = svgAdapter.verify(Buffer.from(brokenXml, 'utf8'), {
        filename: 'broken.svg',
        relPath: 'broken.svg',
        mimeType: 'image/svg+xml',
      });
      expect(brokenRes.ok).toBe(false);
      expect(brokenRes.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'svg_xml_syntax', status: 'failed' }),
        expect.objectContaining({ id: 'svg_overlap', status: 'unverified' }),
      ]));
      expect(brokenRes.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'XML_MISMATCHED_TAG', severity: 'error' }),
      ]));

      const xssSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 -50 100"><script>alert(1)</script><a href="javascript:alert(2)" onload="x()"><rect x="10" y="10" width="20" height="20"/></a></svg>';
      const xssRes = svgAdapter.verify(Buffer.from(xssSvg, 'utf8'), {
        filename: 'xss.svg',
        relPath: 'xss.svg',
        mimeType: 'image/svg+xml',
      });
      expect(xssRes.ok).toBe(false);
      expect(xssRes.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'svg_viewbox', status: 'failed' }),
        expect.objectContaining({ id: 'svg_security', status: 'failed' }),
      ]));
      expect(xssRes.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'SVG_INVALID_VIEWBOX', severity: 'error' }),
        expect.objectContaining({ code: 'SVG_DANGEROUS_SCRIPT', severity: 'error' }),
        expect.objectContaining({ code: 'SVG_DANGEROUS_HANDLER', severity: 'error' }),
      ]));
    });

    it('detects overlapping SVG shapes, overlapping text labels, transformed overlaps, and out-of-viewBox elements', () => {
      const overlappingSvg = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200">',
        '  <rect id="r1" x="20" y="20" width="100" height="80" fill="#93c5fd"/>',
        '  <g transform="translate(50, 40)">',
        '    <rect id="r2" x="0" y="0" width="100" height="80" fill="#fca5a5"/>',
        '  </g>',
        '  <text id="t1" x="40" y="160" font-size="16">Alpha Label</text>',
        '  <text id="t2" x="60" y="162" font-size="16">Beta Label</text>',
        '  <rect id="outside" x="270" y="10" width="80" height="40" fill="#fde047"/>',
        '</svg>',
      ].join('\n');

      const res = svgAdapter.verify(Buffer.from(overlappingSvg, 'utf8'), {
        filename: 'overlap.svg',
        relPath: 'overlap.svg',
        mimeType: 'image/svg+xml',
      });
      expect(res.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'svg_xml_syntax', status: 'passed' }),
        expect.objectContaining({ id: 'svg_overlap', status: 'failed' }),
      ]));
      expect(res.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'SVG_ELEMENT_OVERLAP' }),
        expect.objectContaining({ code: 'SVG_TEXT_OVERLAP' }),
        expect.objectContaining({ code: 'SVG_OUT_OF_VIEWBOX' }),
      ]));
      expect(Number(res.metrics?.overlapPairs)).toBeGreaterThanOrEqual(2);
      expect(Number(res.metrics?.textOverlapPairs)).toBeGreaterThanOrEqual(1);
      expect(Number(res.metrics?.outOfViewBoxCount)).toBeGreaterThanOrEqual(1);
    });
  });

  describe('HtmlAdapter: syntax, relative references, and CSP validation', () => {
    it('passes a clean self-contained HTML5 document compatible with the HTML sandbox CSP', () => {
      const cleanHtml = [
        '<!DOCTYPE html>',
        '<html lang="ja">',
        '<head>',
        '  <meta charset="utf-8">',
        '  <title>Report</title>',
        '  <style>body { font-family: sans-serif; }</style>',
        '</head>',
        '<body>',
        '  <div id="root">',
        '    <p>Paragraph 1',
        '    <p>Paragraph 2<br><img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">',
        '    <svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
        '  </div>',
        '  <script>const ok = 1 < 2 && 3 > 1;</script>',
        '</body>',
        '</html>',
      ].join('\n');

      const res = htmlAdapter.verify(Buffer.from(cleanHtml, 'utf8'), {
        filename: 'report.html',
        relPath: 'report.html',
        mimeType: 'text/html',
        dependencies: [],
      });
      expect(res.ok).toBe(true);
      expect(res.coverage).toBe('complete');
      expect(res.issues).toHaveLength(0);
      expect(res.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'html_syntax', status: 'passed' }),
        expect.objectContaining({ id: 'html_relative_refs', status: 'passed' }),
        expect.objectContaining({ id: 'html_csp', status: 'passed' }),
      ]));
    });

    it('detects HTML syntax errors, workspace-escaping relative refs, sandbox CSP violations, and malformed meta CSP', () => {
      const brokenHtml = [
        '<!DOCTYPE html>',
        '<html><head>',
        '  <meta http-equiv="Content-Security-Policy" content="default-src none; frame-ancestors \'self\'; script-src *">',
        '  <link rel="stylesheet" href="https://cdn.example.com/app.css">',
        '  <script src="../../etc/passwd"></script>',
        '</head>',
        '<body>',
        '  <div id="dup"><span>Mismatch</div>',
        '  <div id="dup"><img src="https://evil.example/a.png"></div>',
        '  <form action="https://evil.example/post"><input type="text"></form>',
        '  <iframe src="https://evil.example/frame"></iframe>',
        '  <script>fetch("https://api.example.com/data");</script>',
        '</body>',
      ].join('\n');

      const res = htmlAdapter.verify(Buffer.from(brokenHtml, 'utf8'), {
        filename: 'broken.html',
        relPath: 'broken.html',
        mimeType: 'text/html',
        dependencies: [],
      });
      expect(res.ok).toBe(false);
      expect(res.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'html_syntax', status: 'failed' }),
        expect.objectContaining({ id: 'html_relative_refs', status: 'failed' }),
        expect.objectContaining({ id: 'html_csp', status: 'failed' }),
      ]));
      expect(res.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'HTML_MISMATCHED_TAG', severity: 'error' }),
        expect.objectContaining({ code: 'HTML_UNCLOSED_ROOT', severity: 'error' }),
        expect.objectContaining({ code: 'HTML_DUPLICATE_ID', severity: 'warning' }),
        expect.objectContaining({ code: 'HTML_RELATIVE_REF_OUTSIDE_ROOT', severity: 'error' }),
        expect.objectContaining({ code: 'HTML_INVALID_META_CSP', severity: 'error' }),
        expect.objectContaining({ code: 'HTML_META_CSP_IGNORED_DIRECTIVE', severity: 'warning' }),
        expect.objectContaining({ code: 'HTML_META_CSP_UNSAFE_DIRECTIVE', severity: 'warning' }),
        expect.objectContaining({ code: 'HTML_CSP_BLOCKED_STYLE', severity: 'warning' }),
        expect.objectContaining({ code: 'HTML_CSP_BLOCKED_SCRIPT', severity: 'warning' }),
        expect.objectContaining({ code: 'HTML_CSP_BLOCKED_IMAGE', severity: 'warning' }),
        expect.objectContaining({ code: 'HTML_CSP_BLOCKED_FORM_ACTION', severity: 'warning' }),
        expect.objectContaining({ code: 'HTML_CSP_BLOCKED_EMBED', severity: 'warning' }),
        expect.objectContaining({ code: 'HTML_CSP_BLOCKED_CONNECT', severity: 'warning' }),
      ]));
    });

    it('verifies real HTML relative dependencies end-to-end via ArtifactService without restricting existing sandbox viewing', async () => {
      const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
      try {
        const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'htmlverify', 'user:htmlverify');
        const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'HTML Verify' });

        // Create a sibling image that exists
        await srv.ctx.artifactService.createArtifact({
          userId,
          scopeKind: 'chat',
          chatId: chat.id,
          relPath: 'assets/logo.png',
          content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          actorKind: 'user',
        });

        // 1. HTML referencing existing relative asset -> html_relative_refs passes
        const { artifact: okHtml } = await srv.ctx.artifactService.createArtifact({
          userId,
          scopeKind: 'chat',
          chatId: chat.id,
          relPath: 'ok.html',
          content: Buffer.from('<!DOCTYPE html><html><body><img src="./assets/logo.png" alt="ok"></body></html>', 'utf8'),
          actorKind: 'user',
        });
        const okVerify = await srv.ctx.artifactService.verifyArtifact(userId, okHtml.id);
        expect(okVerify.ok).toBe(true);
        expect(okVerify.checks).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'html_syntax', status: 'passed' }),
          expect.objectContaining({ id: 'html_relative_refs', status: 'passed' }),
        ]));

        // 2. HTML referencing a missing relative asset -> html_relative_refs fails with HTML_MISSING_RELATIVE_REF
        const { artifact: missingHtml } = await srv.ctx.artifactService.createArtifact({
          userId,
          scopeKind: 'chat',
          chatId: chat.id,
          relPath: 'missing.html',
          content: Buffer.from('<!DOCTYPE html><html><body><img src="./assets/nope.png" alt="missing"></body></html>', 'utf8'),
          actorKind: 'user',
        });
        const missingVerify = await srv.ctx.artifactService.verifyArtifact(userId, missingHtml.id);
        expect(missingVerify.ok).toBe(false);
        expect(missingVerify.checks).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'html_relative_refs', status: 'failed' }),
        ]));
        expect(missingVerify.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'HTML_MISSING_RELATIVE_REF', severity: 'error' }),
        ]));

        // 3. Existing HTML sandbox viewing endpoint remains completely unaffected (no new restrictions)
        const sandboxRes = await client.request('GET', `/api/files/${missingHtml.id}/sandbox`);
        expect(sandboxRes.status).toBe(200);
      } finally {
        await srv.cleanup();
      }
    });
  });
});
