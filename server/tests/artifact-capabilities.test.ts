import { expect, it } from 'vitest';
import { FormatAdapterRegistry } from '../src/artifacts/adapters/registry.js';

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
    expect.objectContaining({ operation: 'render_png', availability: 'disabled_by_resource_tier' }),
  ]));

  const mmdFull = registry.buildCapabilitiesResponse({
    ...common, filename: 'flow.mmd', previewKind: 'mermaid', runtimeProfile: 'full_runtime',
  });
  expect(mmdFull.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'export:svg', availability: 'supported' }),
    expect.objectContaining({ operation: 'export:png', availability: 'supported' }),
    expect.objectContaining({ operation: 'render_png', availability: 'supported' }),
  ]));

  const legacy = registry.buildCapabilitiesResponse({
    ...common, filename: 'legacy.xls', previewKind: 'table', runtimeProfile: 'full_runtime',
  });
  expect(legacy.directEditUiSupported).toBe(false);
  expect(legacy.operations.find(({ operation }) => operation === 'xlsx.set_cell')?.availability).toBe('unsupported_by_format');
  const audio = registry.buildCapabilitiesResponse({
    ...common, filename: 'audio.wav', previewKind: 'audio', runtimeProfile: 'full_runtime',
  });
  expect(audio.operations.find(({ operation }) => operation === 'render_png')?.availability).toBe('unsupported_by_format');
});
