import { describe, expect, it } from 'vitest';
import { createTwoFilesPatch, parsePatch } from 'diff';
import { DiffAdapter } from '../src/artifacts/adapters/diff-adapter.js';
import { HtmlAdapter } from '../src/artifacts/adapters/html-adapter.js';
import { MarkdownAdapter } from '../src/artifacts/adapters/markdown-adapter.js';
import { MermaidAdapter } from '../src/artifacts/adapters/mermaid-adapter.js';
import { SvgAdapter } from '../src/artifacts/adapters/svg-adapter.js';
import { sha256Text, type FormatAdapter } from '../src/artifacts/adapters/base.js';
import type { AdapterOperation } from '../src/artifacts/types.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

const meta = { filename: 'test', relPath: 'test', mimeType: 'text/plain' };
const apply = (adapter: FormatAdapter, source: string, operations: AdapterOperation[]) =>
  adapter.applyOperations(Buffer.from(source), operations, meta).buffer.toString();

describe('Pure-JS artifact structure edits', () => {
  it('edits nested SVG shapes and text using parsed offsets, preserving neighboring source', () => {
    const adapter = new SvgAdapter();
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><!--keep--><g id="wrap"><g id="inner"><rect id="box" x="1" width="2" height="2"/></g></g><g id="next"/></svg>';
    const output = apply(adapter, source, [
      { op: 'svg.set_geometry', elementId: 'box', geometry: { x: 11, transform: 'translate(2 3)' } },
      { op: 'svg.set_style', elementId: 'box', style: 'fill: orange' },
      { op: 'svg.move_element', elementId: 'box', parentId: 'next' },
      { op: 'svg.add_shape', parentId: 'next', tag: 'ellipse', attributes: { id: 'ring', rx: 4, ry: 2 } },
      { op: 'svg.add_text', parentId: 'next', text: 'Safe <message>', attributes: { id: 'label', x: 2 } },
      { op: 'svg.set_attr', elementId: 'label', attr: 'fill', value: 'black' },
      { op: 'svg.remove_element', elementId: 'inner' },
    ]);
    expect(output).toContain('<!--keep--><g id="wrap"></g>');
    expect(output).toContain('<text id="label" x="2" fill="black">Safe &lt;message&gt;</text>');
    expect(adapter.getStructure(Buffer.from(output), meta).elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'box', parentIndex: 2, attrs: expect.objectContaining({ x: '11', style: 'fill: orange' }) }),
      expect.objectContaining({ id: 'ring', parentIndex: 2, tag: 'ellipse' }),
    ]));
    expect(() => apply(adapter, output, [{ op: 'svg.move_element', elementId: 'next', parentId: 'ring' }])).toThrow();
  });

  it('applies a patch and edits parsed HTML elements, including void elements and nested identical tags', () => {
    const adapter = new HtmlAdapter();
    const original = '<!doctype html><main><div id="a"><div id="b">Old</div></div><!--preserve--><section id="c"><img id="pic" src=old.png></section></main>';
    const patch = createTwoFilesPatch('doc.html', 'doc.html', original, original.replace('Old', 'From patch'));
    const output = apply(adapter, original, [
      { op: 'html.apply_patch', patch },
      { op: 'html.move_element', elementId: 'b', parentId: 'c' },
      { op: 'html.insert_element', parentId: 'c', markup: '<footer id="footer">Foot</footer>' },
      { op: 'html.set_attr', elementId: 'pic', attr: 'src', value: 'new.png' },
      { op: 'html.set_text', elementId: 'footer', text: 'Safe <text>' },
      { op: 'html.remove_element', elementId: 'a' },
    ]);
    expect(output).toContain('<main><!--preserve--><section id="c"><img id="pic" src="new.png"><div id="b">From patch</div>');
    expect(output).toContain('<footer id="footer">Safe &lt;text&gt;</footer>');
    expect(adapter.resolveTarget(Buffer.from(output), {
      kind: 'html_text_range', cssSelector: 'main > section > footer', charStart: 5, charEnd: 11,
      expectedSnippetHash: sha256Text('<text>'),
    }, meta)).toMatchObject({ status: 'resolved', resolvedSnippet: '<text>' });
    expect(() => apply(adapter, output, [{ op: 'html.set_text', elementId: 'pic', text: 'invalid' }])).toThrow();
  });

  it('updates Markdown sections and blocks without selecting the same heading inside fences', () => {
    const adapter = new MarkdownAdapter();
    const original = '~~~md\n# Alpha\n~~~\n\nAlpha\n=====\n\nold\n\n# Beta\n\n| A | B |\n| - | - |\n| x | y |\n';
    const replaced = apply(adapter, original, [{ op: 'markdown.replace_section', headingSlug: 'alpha', content: 'section text' }]);
    expect(replaced).toContain('~~~md\n# Alpha\n~~~');
    expect(replaced).toContain('Alpha\n=====\n\nsection text\n\n# Beta');
    const { blocks } = adapter.getStructure(Buffer.from(replaced), meta) as { blocks: { index: number; type: string }[] };
    const tableIndex = blocks.find(({ type }) => type === 'table')!.index;
    const output = apply(adapter, replaced, [
      { op: 'markdown.set_table_cell', blockIndex: tableIndex, row: 1, col: 0, content: 'updated | value' },
      { op: 'markdown.set_heading', headingSlug: 'beta', text: 'Renamed', level: 2 },
      { op: 'markdown.insert_block', content: '> Last block' },
    ]);
    expect(output).toContain('| updated \\| value | y |');
    expect(output).toContain('## Renamed');
    expect(output).toContain('> Last block');
  });

  it('edits a single Diff hunk and shifts downstream new coordinates while retaining original headers', () => {
    const adapter = new DiffAdapter();
    const original = 'diff --git a/x b/x\nindex 0123456..6543210 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@ first\n-old\n+original\n@@ -9 +9 @@ second\n-foo\n+bar\n';
    const output = apply(adapter, original, [
      { op: 'diff.replace_hunk', fileIndex: 0, hunkIndex: 0, lines: ['-old', '+new', '+extra'] },
    ]);
    expect(output).toContain('index 0123456..6543210 100644');
    expect(output).toContain('@@ -1,1 +1,2 @@ first\n-old\n+new\n+extra');
    expect(parsePatch(output)[0].hunks[1]).toMatchObject({ newStart: 10, lines: ['-foo', '+bar'] });
    expect(parsePatch(apply(adapter, output, [{ op: 'diff.remove_hunk', fileIndex: 0, hunkIndex: 0 }]))[0].hunks)
      .toEqual([expect.objectContaining({ newStart: 9 })]);
  });

  it('edits Mermaid nodes, edges and nested flowchart groups', () => {
    const adapter = new MermaidAdapter();
    const source = 'flowchart LR\n  %% keep unrelated comment\n  A["Initial"]-->B["Middle"] --> C["Last"]\n';
    const output = apply(adapter, source, [
      { op: 'mermaid.add_group', groupId: 'clients', title: 'Clients' },
      { op: 'mermaid.add_group', groupId: 'desktop', parentId: 'clients', title: 'Desktop' },
      { op: 'mermaid.add_node', nodeId: 'D', parentId: 'desktop', label: 'New', kind: 'circle' },
      { op: 'mermaid.set_node', nodeId: 'A', label: 'Updated' },
      { op: 'mermaid.set_edge', fromId: 'A', toId: 'B', label: 'request' },
      { op: 'mermaid.remove_edge', fromId: 'B', toId: 'C' },
      { op: 'mermaid.add_edge', fromId: 'D', toId: 'C' },
    ]);
    const structure = adapter.getStructure(Buffer.from(output), meta);
    expect(structure.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'A', label: 'Updated' }), expect.objectContaining({ id: 'D', groupId: 'desktop' }),
    ]));
    expect(structure.edges).toEqual([
      expect.objectContaining({ fromId: 'A', toId: 'B', label: 'request' }),
      expect.objectContaining({ fromId: 'D', toId: 'C' }),
    ]);
    expect(structure.groups).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'desktop', groupId: 'clients' })]));
    expect(output).toContain('%% keep unrelated comment');

    const withFrontmatter = '---\ntitle: "Pipeline"\n---\n%%{init: {"theme": "neutral"}}%%\nflowchart TD\n  subgraph g1["Init"]\n    A[Start] --> B[End]\n  end\n';
    expect(adapter.verify(Buffer.from(withFrontmatter), meta).ok).toBe(true);
    const editedFrontmatter = apply(adapter, withFrontmatter, [
      { op: 'mermaid.add_node', nodeId: 'C', label: 'Done' },
      { op: 'mermaid.set_group', groupId: 'g1', title: 'Updated' },
    ]);
    expect(adapter.getStructure(Buffer.from(editedFrontmatter), meta)).toMatchObject({
      diagramType: 'flowchart',
      nodes: expect.arrayContaining([expect.objectContaining({ id: 'C', label: 'Done' })]),
      groups: expect.arrayContaining([expect.objectContaining({ id: 'g1', title: 'Updated' })]),
    });

    const seqSource = 'sequenceDiagram\n  participant graph\n  graph->>B: hello\n';
    expect(() => apply(adapter, seqSource, [{ op: 'mermaid.add_node', nodeId: 'C', label: 'Nope' }])).toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED_OPERATION',
        statusCode: 422,
        details: expect.objectContaining({ availability: 'unsupported_by_format' }),
      }),
    );
    expect(apply(adapter, seqSource, [{ op: 'search_replace', search: 'hello', replace: 'world' }])).toContain('graph->>B: world');
  });

  it('publishes editable operations and commits through the revision and dependency path', async () => {
    const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
    try {
      const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'structured', 'user:structured');
      const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Structure edits' });
      const { artifact } = await srv.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId: chat.id, relPath: 'document.html',
        content: Buffer.from('<!doctype html><main id="main"></main>'), actorKind: 'user',
      });
      expect(srv.ctx.artifactService.getCapabilities(userId, artifact.id).operations).toContainEqual(
        expect.objectContaining({ operation: 'html.insert_element', availability: 'supported' }),
      );
      const edit = {
        userId, artifactId: artifact.id, expectedRevision: artifact.revision, actorKind: 'user' as const,
        operations: [{ op: 'html.insert_element', parentId: 'main', markup: '<img id="inserted" src="missing.png">' }],
      };
      const updated = await srv.ctx.artifactService.editArtifact(edit);
      expect(updated.artifact.revision).toBe(artifact.revision + 1);
      await expect(srv.ctx.artifactService.editArtifact(edit)).rejects.toMatchObject({ statusCode: 409 });
      expect(await srv.ctx.artifactService.getStructure(userId, artifact.id)).toMatchObject({
        revision: updated.artifact.revision, identifiedElements: expect.arrayContaining([expect.objectContaining({ id: 'inserted' })]),
      });
      expect((await srv.ctx.artifactService.verifyArtifact(userId, artifact.id)).issues).toContainEqual(
        expect.objectContaining({ code: expect.stringMatching(/HTML.*(?:MISSING|DEPENDENCY)/) }),
      );
    } finally {
      await srv.cleanup();
    }
  });
});
