import { expect, it } from 'vitest';
import type { RichDocumentV1, RichNode, RichSvgDef } from '../../shared/rich-schema.js';
import { validateRichDocument } from '../src/rich/rich-validator.js';

const stop = { offset: '50%', color: '#fff' };
const marker: RichSvgDef = { kind: 'marker', id: 'arrow', viewBox: '0 0 10 10', refX: 0, refY: 0, markerWidth: 10, markerHeight: 10, pathD: 'M0 0 L10 10' };
const clip: RichSvgDef = { kind: 'clipPath', id: 'clip', shape: 'rect', attrs: { width: 10, height: 10 } };
const scene = (defs: RichSvgDef[], elements: Extract<RichNode, { type: 'svg_scene' }>['elements'] = []): Extract<RichNode, { type: 'svg_scene' }> =>
  ({ id: 'scene', type: 'svg_scene', viewBox: '0 0 20 20', defs, elements });
const inline = (svgScene: ReturnType<typeof scene>): RichNode =>
  ({ id: 'inline', type: 'media_asset', sourceKind: 'inline_svg', alt: 'Example', svgScene });
const doc = (root: RichNode, state: RichDocumentV1['state'] = {}): RichDocumentV1 => ({ schemaVersion: 1, state, root });

it('counts gradients, stops and the marker/clip child elements in the same block-wide budgets', () => {
  const gradient = (n: number): RichSvgDef => ({ kind: 'linearGradient', id: 'paint', stops: Array.from({ length: n }, () => stop) });
  const block = (n: number) => doc({ id: 'root', type: 'stack', direction: 'col', children: [
    scene([marker, clip]),
    inline({ ...scene([gradient(n)]), id: 'other' }),
  ] });
  expect(validateRichDocument(block(995))).toMatchObject({ valid: true, stats: { staticSvgElements: 1000, expandedSvgElements: 1000 } });
  expect(validateRichDocument(block(996)).primaryErrorCode).toBe('RICH_SVG_LIMIT_EXCEEDED');
  const repeated = (includeLast: boolean) => doc({
    ...inline(scene([gradient(665)], [{ tag: 'rect', visibleWhen: '$state.includeLast || $index < 2' }])),
    repeat: { itemsExpr: '$state.items', as: 'item' },
  }, { items: [1, 2, 3], includeLast });
  expect(validateRichDocument(repeated(false))).toMatchObject({ valid: true, stats: { expandedSvgElements: 2000 } });
  expect(validateRichDocument(repeated(true)).primaryErrorCode).toBe('RICH_EXPANDED_SVG_LIMIT_EXCEEDED');
});

it('applies the same validation to inline SVG attribute definitions before and after expression evaluation', () => {
  const gradient: RichSvgDef = { kind: 'radialGradient', id: 'paint', stops: [{ ...stop, opacity: { expr: '$state.opacity' } }] };
  const dynamicClip: RichSvgDef = { ...clip, attrs: { ...clip.attrs, fill: { expr: '$state.paint' } } };
  const root = inline(scene([gradient, dynamicClip, marker], [{ tag: 'rect', attrs: { clipPath: 'url(#clip)' } }]));
  expect(validateRichDocument(doc(root, { opacity: 0.5, paint: 'url(#paint)' })).valid).toBe(true);
  expect(validateRichDocument(doc(root, { opacity: 1.5, paint: 'url(#paint)' })).primaryErrorCode).toBe('RICH_POST_EVAL_UNSAFE_SVG');
  expect(validateRichDocument(doc(root, { opacity: 1, paint: 'url(#nonexistent)' })).primaryErrorCode).toBe('RICH_POST_EVAL_UNSAFE_SVG');
  expect(validateRichDocument(doc(scene([{ ...marker, pathD: 'M0 0; expression(...)' }]))).primaryErrorCode).toBe('RICH_UNSAFE_SVG_VALUE');
  expect(validateRichDocument(doc(scene([{ ...clip, attrs: { onClick: 'bad' } }]))).primaryErrorCode).toBe('RICH_FORBIDDEN_SVG_ATTR');
});

it('validates SVG action capability against the declared role, including nested SVG shapes', () => {
  const root = scene([], [{ tag: 'g', children: [{ tag: 'rect', onClick: [{ type: 'toggle_state', key: 'flag' }] }] }]);
  expect(validateRichDocument(doc({ ...root, interactiveRole: 'wireframe' }, { flag: false })).primaryErrorCode).toBe('RICH_INVALID_SVG_ROLE');
  expect(validateRichDocument(doc({ ...root, interactiveRole: 'interactive' }, { flag: false })).valid).toBe(true);
  expect(validateRichDocument(doc({ ...root, interactiveRole: 'interactive', elements: [{ tag: 'rect' }] })).primaryErrorCode).toBe('RICH_INVALID_SVG_ROLE');
});
