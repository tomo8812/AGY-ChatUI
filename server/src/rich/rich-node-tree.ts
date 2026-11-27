import type { RichNode } from '../../../shared/rich-schema.js';

/** Visits the child slots defined by RichNode and preserves each slot's shape. */
export function mapRichNodeChildren(node: RichNode, map: (child: RichNode, path: string) => RichNode): RichNode {
  switch (node.type) {
    case 'card':
      return {
        ...node,
        ...(Array.isArray(node.children) && { children: node.children.map((child, i) => map(child, `children[${i}]`)) }),
        ...(node.headerAction && { headerAction: map(node.headerAction, 'headerAction') }),
        ...(node.footer && { footer: map(node.footer, 'footer') }),
      };
    case 'tabs':
      if (!Array.isArray(node.items)) return node;
      return { ...node, items: node.items.map((item, i) => item && ({
        ...item, content: Array.isArray(item.content) ? item.content.map((child, j) => map(child, `items[${i}].content[${j}]`)) : item.content,
      })) };
    case 'tooltip':
    case 'popover':
      return {
        ...node, ...(node.trigger && { trigger: map(node.trigger, 'trigger') }),
        content: Array.isArray(node.content) ? node.content.map((child, i) => map(child, `content[${i}]`)) : node.content,
      };
    case 'media_asset': {
      if (node.svgScene?.type !== 'svg_scene' || node.sourceKind !== 'inline_svg') return node;
      const svgScene = map(node.svgScene, 'svgScene');
      if (svgScene.type !== 'svg_scene') throw new TypeError('The inline media slot requires an svg_scene node.');
      return { ...node, svgScene };
    }
    default:
      return 'children' in node && Array.isArray(node.children)
        ? { ...node, children: node.children.map((child, i) => map(child, `children[${i}]`)) }
        : node;
  }
}
