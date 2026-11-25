import { selectAll, type Options } from 'css-select';
import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import { ArtifactError } from '../errors.js';
import { markupElements } from './markup-edit.js';

function children(node: Tree.Node): Tree.ChildNode[] {
  return 'childNodes' in node ? node.childNodes : [];
}

function textContent(node: Tree.Node): string {
  const pending = [node];
  const text: string[] = [];
  while (pending.length) {
    const current = pending.pop()!;
    if ('value' in current) text.push(current.value);
    else {
      const nodes = children(current);
      for (let i = nodes.length - 1; i >= 0; i--) pending.push(nodes[i]);
    }
  }
  return text.join('');
}

const adapter: NonNullable<Options<Tree.Node, Tree.Element>['adapter']> = {
  isTag: (node): node is Tree.Element => 'tagName' in node,
  getAttributeValue: (node, name) => node.attrs.find((attr) => attr.name === name)?.value,
  getChildren: children,
  getName: (node) => node.tagName,
  getParent: (node) => node.parentNode,
  getSiblings: (node) => 'parentNode' in node && node.parentNode ? children(node.parentNode) : [node],
  getText: textContent,
  hasAttrib: (node, name) => node.attrs.some((attr) => attr.name === name),
  removeSubsets: (nodes) => [...new Set(nodes)],
};

export function selectHtmlElements(source: string, selector: string, elements = markupElements(source, 'html')) {
  if (!selector || selector.length > 512) throw new ArtifactError('INVALID_DOM_SELECTOR', 'Provide a bounded CSS selector.', 400);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const byOffset = new Map(elements.map((element) => [element.start, element]));
  try {
    return selectAll<Tree.Node, Tree.Element>(selector, document, { adapter, cacheResults: false }).flatMap((node) => {
      const offset = node.sourceCodeLocation?.startTag?.startOffset;
      const element = offset === undefined ? undefined : byOffset.get(offset);
      return element ? [{ ...element, textContent: textContent(node) }] : [];
    });
  } catch {
    throw new ArtifactError('INVALID_DOM_SELECTOR', 'The CSS selector cannot be resolved.', 422);
  }
}
