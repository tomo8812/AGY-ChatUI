import { expect, it } from 'vitest';
import { MERMAID_STRUCTURE_OPS } from '../src/artifacts/adapters/mermaid-structure.js';
import { FormatAdapterRegistry } from '../src/artifacts/adapters/registry.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

function makeGif(frames: number): Buffer {
  const header = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // 1x1, 2-color GCT
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // GCT entries
  ]);
  const frame = Buffer.from([
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // Image Descriptor
    0x02, 0x02, 0x44, 0x01, 0x00, // LZW min=2, 2-byte sub-block, terminator
  ]);
  return Buffer.concat([header, ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
}

function makeApng(frames: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(12 + 13);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  const actl = Buffer.alloc(12 + 8);
  actl.writeUInt32BE(8, 0);
  actl.write('acTL', 4, 'ascii');
  actl.writeUInt32BE(frames, 8);
  const iend = Buffer.alloc(12);
  iend.write('IEND', 4, 'ascii');
  return Buffer.concat([sig, ihdr, actl, iend]);
}

function makeAnimatedWebp(): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32BE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[20] = 0x02; // animation flag
  return buf;
}

it('distinguishes direct editing, partial feature support, runtime limits and incompatible formats', () => {
  const registry = new FormatAdapterRegistry();
  const common = { sandboxIsolation: 'bwrap', stagingIsolation: 'bwrap_mount_isolated' } as const;
  const pptx = registry.buildCapabilitiesResponse({
    ...common, filename: 'main.pptx', previewKind: 'pptx', runtimeProfile: 'compact_doc_runtime',
  });
  expect(pptx.directEditUiSupported).toBe(true);
  expect(pptx.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'pptx.set_shape_style', availability: 'supported', scope: 'mcp_and_ui' }),
    expect.objectContaining({ operation: 'pptx.set_shape_text', availability: 'supported', scope: 'mcp_and_ui' }),
    expect.objectContaining({ operation: 'pptx.set_notes', availability: 'supported', scope: 'mcp_only' }),
    expect.objectContaining({ operation: 'pptx.smartart.add_or_remove_node', availability: 'partial', scope: 'mcp_only' }),
  ]));
  const base = registry.buildCapabilitiesResponse({
    ...common, sandboxIsolation: 'sandbox_required_blocked',
    filename: 'main.pptx', previewKind: 'pptx', runtimeProfile: 'base_chatui',
  });
  expect(base.directEditUiSupported).toBe(false);
  expect(base.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'structure', availability: 'partial' }),
    expect.objectContaining({ operation: 'pptx.set_shape_text', availability: 'disabled_by_resource_tier' }),
  ]));

  const csvBase = registry.buildCapabilitiesResponse({
    ...common, sandboxIsolation: 'sandbox_required_blocked',
    filename: 'data.csv', previewKind: 'table', runtimeProfile: 'base_chatui',
  });
  expect(csvBase.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'export:xlsx', availability: 'supported' }),
    expect.objectContaining({ operation: 'render_png', availability: 'disabled_by_resource_tier' }),
  ]));
  const csvCompact = registry.buildCapabilitiesResponse({
    ...common, filename: 'data.csv', previewKind: 'table', runtimeProfile: 'compact_doc_runtime',
  });
  expect(csvCompact.operations.find(({ operation }) => operation === 'render_png')?.availability).toBe('supported');

  const mdCompact = registry.buildCapabilitiesResponse({
    ...common, filename: 'doc.md', previewKind: 'markdown', runtimeProfile: 'compact_doc_runtime',
  });
  expect(mdCompact.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'export:html', availability: 'supported' }),
    expect.objectContaining({ operation: 'export:pdf', availability: 'supported' }),
    expect.objectContaining({ operation: 'export:docx', availability: 'supported' }),
    expect.objectContaining({
      operation: 'export:png',
      availability: 'disabled_by_resource_tier',
      remediation: expect.stringContaining('INSTALL_DOC_RUNTIME=full'),
    }),
    expect.objectContaining({
      operation: 'render_png',
      availability: 'disabled_by_resource_tier',
      remediation: expect.stringContaining('INSTALL_DOC_RUNTIME=full'),
    }),
  ]));
  const mdFull = registry.buildCapabilitiesResponse({
    ...common, filename: 'doc.md', previewKind: 'markdown', runtimeProfile: 'full_runtime',
  });
  expect(mdFull.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'export:png', availability: 'supported' }),
    expect.objectContaining({ operation: 'render_png', availability: 'supported' }),
  ]));

  const mmdFull = registry.buildCapabilitiesResponse({
    ...common, filename: 'flow.mmd', previewKind: 'mermaid', runtimeProfile: 'full_runtime',
  });
  expect(mmdFull.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'export:svg', availability: 'supported' }),
    expect.objectContaining({ operation: 'export:png', availability: 'supported' }),
    expect.objectContaining({ operation: 'render_png', availability: 'supported' }),
    expect.objectContaining({
      operation: 'mermaid.add_node',
      availability: 'partial',
      notes: expect.stringContaining('flowchart / graph'),
    }),
  ]));

  const htmlNoSandbox = registry.buildCapabilitiesResponse({
    ...common, sandboxIsolation: 'sandbox_required_blocked',
    filename: 'index.html', previewKind: 'html', runtimeProfile: 'full_runtime',
  });
  expect(htmlNoSandbox.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({
      operation: 'render_png',
      availability: 'disabled_by_resource_tier',
      remediation: expect.stringContaining('bubblewrap'),
    }),
    expect.objectContaining({
      operation: 'export:png',
      availability: 'disabled_by_resource_tier',
      remediation: expect.stringContaining('bubblewrap'),
    }),
  ]));
  const svgNoSandbox = registry.buildCapabilitiesResponse({
    ...common, sandboxIsolation: 'sandbox_required_blocked',
    filename: 'icon.svg', previewKind: 'svg', runtimeProfile: 'compact_doc_runtime',
  });
  expect(svgNoSandbox.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({
      operation: 'export:png',
      availability: 'disabled_by_resource_tier',
      remediation: expect.stringContaining('bubblewrap'),
    }),
    expect.objectContaining({
      operation: 'render_png',
      availability: 'disabled_by_resource_tier',
      remediation: expect.stringContaining('bubblewrap'),
    }),
  ]));

  const legacyXls = registry.buildCapabilitiesResponse({
    ...common, filename: 'legacy.xls', previewKind: 'table', runtimeProfile: 'full_runtime',
  });
  expect(legacyXls.directEditUiSupported).toBe(false);
  expect(legacyXls.operations.find(({ operation }) => operation === 'xlsx.set_cell')?.availability).toBe('unsupported_by_format');

  for (const legacyDeck of ['legacy.ppt', 'slides.odp']) {
    const ppt = registry.buildCapabilitiesResponse({
      ...common, filename: legacyDeck, previewKind: 'pptx', runtimeProfile: 'full_runtime',
    });
    expect(ppt.directEditUiSupported).toBe(false);
    expect(ppt.operations.find(({ operation }) => operation === 'structure')?.availability).toBe('partial');
    expect(ppt.operations.find(({ operation }) => operation === 'pptx.set_shape_text')?.availability).toBe('unsupported_by_format');
  }

  const audio = registry.buildCapabilitiesResponse({
    ...common, filename: 'audio.wav', previewKind: 'audio', runtimeProfile: 'full_runtime',
  });
  expect(audio.operations.find(({ operation }) => operation === 'render_png')?.availability).toBe('unsupported_by_format');
  expect(audio.operations.find(({ operation }) => operation === 'create')?.availability).toBe('unsupported_by_format');

  const staticGif = registry.buildCapabilitiesResponse({
    ...common, filename: 'static.gif', previewKind: 'image', runtimeProfile: 'compact_doc_runtime', content: makeGif(1),
  });
  expect(staticGif.directEditUiSupported).toBe(true);
  expect(staticGif.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'image.crop', availability: 'supported' }),
    expect.objectContaining({ operation: 'image.rotate', availability: 'partial', notes: expect.stringContaining('90') }),
    expect.objectContaining({ operation: 'create', availability: 'unsupported_by_format' }),
  ]));

  for (const [filename, content] of [
    ['anim.gif', makeGif(2)],
    ['anim.png', makeApng(3)],
    ['anim.webp', makeAnimatedWebp()],
  ] as const) {
    const animated = registry.buildCapabilitiesResponse({
      ...common, filename, previewKind: 'image', runtimeProfile: 'compact_doc_runtime', content,
    });
    expect(animated.directEditUiSupported).toBe(false);
    expect(animated.operations.find(({ operation }) => operation === 'image.crop')).toMatchObject({
      availability: 'unsupported_by_format',
      notes: expect.stringContaining('アニメーション'),
    });
    expect(animated.operations.find(({ operation }) => operation === 'render_png')?.availability).toBe('supported');
  }

  const binary = registry.buildCapabilitiesResponse({
    ...common, filename: 'archive.bin', previewKind: 'binary', runtimeProfile: 'base_chatui',
  });
  expect(binary.directEditUiSupported).toBe(false);
  expect(binary.targetPinSupported).toBe(false);
  expect(binary.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' }),
    expect.objectContaining({ operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' }),
    expect.objectContaining({ operation: 'read_range', availability: 'unsupported_by_format' }),
    expect.objectContaining({ operation: 'edit', availability: 'unsupported_by_format' }),
  ]));
});

it('reports Mermaid structure edit capabilities accurately per diagram type', () => {
  const registry = new FormatAdapterRegistry();
  const base = {
    filename: 'diagram.mmd',
    previewKind: 'mermaid' as const,
    runtimeProfile: 'full_runtime' as const,
    sandboxIsolation: 'bwrap' as const,
    stagingIsolation: 'bwrap_mount_isolated' as const,
  };

  for (const [diagramType, source] of [
    ['flowchart', '---\ntitle: Demo\n---\n%%{init: {"theme": "default"}}%%\nflowchart TD\n  A[Start] --> B[End]\n'],
    ['graph', '%% header comment\ngraph LR\n  A --> B\n'],
  ] as const) {
    const caps = registry.buildCapabilitiesResponse({ ...base, content: Buffer.from(source, 'utf8') });
    for (const op of MERMAID_STRUCTURE_OPS) {
      expect(caps.operations.find(({ operation }) => operation === `mermaid.${op}`)).toMatchObject({
        availability: 'supported',
        scope: 'mcp_and_ui',
        notes: expect.stringContaining(diagramType),
      });
    }
    expect(caps.operations.find(({ operation }) => operation === 'edit')?.availability).toBe('supported');
  }

  for (const [diagramType, source] of [
    ['sequenceDiagram', 'sequenceDiagram\n  participant graph\n  graph->>B: hello\n'],
    ['classDiagram', 'classDiagram\n  Animal <|-- Duck\n'],
    ['erDiagram', 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n'],
    ['pie', 'pie title Pets\n  "Dogs" : 50\n'],
    ['stateDiagram-v2', 'stateDiagram-v2\n  [*] --> Active\n'],
  ] as const) {
    const caps = registry.buildCapabilitiesResponse({ ...base, content: Buffer.from(source, 'utf8') });
    for (const op of MERMAID_STRUCTURE_OPS) {
      expect(caps.operations.find(({ operation }) => operation === `mermaid.${op}`)).toMatchObject({
        availability: 'unsupported_by_format',
        scope: 'mcp_and_ui',
        notes: expect.stringContaining(diagramType),
      });
    }
    expect(caps.operations.find(({ operation }) => operation === 'edit')?.availability).toBe('supported');
  }

  const unknown = registry.buildCapabilitiesResponse({ ...base, content: Buffer.from('not a mermaid diagram\n', 'utf8') });
  for (const op of MERMAID_STRUCTURE_OPS) {
    expect(unknown.operations.find(({ operation }) => operation === `mermaid.${op}`)).toMatchObject({
      availability: 'unsupported_by_format',
      notes: expect.stringContaining('flowchart / graph'),
    });
  }
});

it('reflects committed revision content in ArtifactService.getCapabilities for Mermaid and animated images', async () => {
  const srv = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
  try {
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'caps', 'user:caps');
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Capabilities' });

    const { artifact: flow } = await srv.ctx.artifactService.createArtifact({
      userId, scopeKind: 'chat', chatId: chat.id, relPath: 'diagram.mmd',
      content: Buffer.from('flowchart TD\n  A[Start] --> B[End]\n', 'utf8'), actorKind: 'user',
    });
    expect(srv.ctx.artifactService.getCapabilities(userId, flow.id).operations.find(({ operation }) => operation === 'mermaid.add_node')).toMatchObject({
      availability: 'supported',
      notes: expect.stringContaining('flowchart'),
    });

    const seqUpdated = await srv.ctx.artifactService.editArtifact({
      userId, artifactId: flow.id, expectedRevision: flow.revision, actorKind: 'user',
      operations: [{ op: 'replace_source', content: 'sequenceDiagram\n  Alice->>Bob: Hello\n' }],
    });
    expect(srv.ctx.artifactService.getCapabilities(userId, flow.id).operations.find(({ operation }) => operation === 'mermaid.add_node')).toMatchObject({
      availability: 'unsupported_by_format',
      notes: expect.stringContaining('sequenceDiagram'),
    });
    await expect(srv.ctx.artifactService.editArtifact({
      userId, artifactId: flow.id, expectedRevision: seqUpdated.artifact.revision, actorKind: 'user',
      operations: [{ op: 'mermaid.add_node', nodeId: 'C', label: 'Blocked' }],
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      statusCode: 422,
      details: expect.objectContaining({ availability: 'unsupported_by_format' }),
    });

    const { artifact: animGif } = await srv.ctx.artifactService.createArtifact({
      userId, scopeKind: 'chat', chatId: chat.id, relPath: 'spinner.gif',
      content: makeGif(2), actorKind: 'user',
    });
    const gifCaps = srv.ctx.artifactService.getCapabilities(userId, animGif.id);
    expect(gifCaps.directEditUiSupported).toBe(false);
    expect(gifCaps.operations.find(({ operation }) => operation === 'image.crop')).toMatchObject({
      availability: 'unsupported_by_format',
      notes: expect.stringContaining('アニメーション'),
    });
  } finally {
    await srv.cleanup();
  }
});
