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
    expect.objectContaining({ operation: 'pptx.set_shape_style', availability: 'partial', scope: 'mcp_and_ui' }),
    expect.objectContaining({ operation: 'pptx.set_notes', availability: 'partial', scope: 'mcp_only' }),
    expect.objectContaining({ operation: 'pptx.smartart.add_or_remove_node', availability: 'unsupported_by_format' }),
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
