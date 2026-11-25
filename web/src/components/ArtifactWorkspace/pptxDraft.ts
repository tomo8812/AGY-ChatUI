import type { EditOperation } from '../../api/workspace';

export function preparePptxOperations(operations: readonly EditOperation[]): EditOperation[] {
  const removed = new Set(operations.filter(op => op.op === 'pptx.remove_shape').map(op => op.slidePart + ':' + op.shapeId));
  const retained = operations.filter(op => !op.op.startsWith('pptx.set_shape_') || !removed.has(op.slidePart + ':' + op.shapeId));
  return [...retained.filter(op => op.op !== 'pptx.set_shape_style'), ...retained.filter(op => op.op === 'pptx.set_shape_style')];
}

export function projectSlides<T>(slides: readonly T[], operations: readonly EditOperation[]): (T | null)[] {
  const result: (T | null)[] = [...slides];
  for (const operation of operations) {
    const index = Number(operation.index);
    if (operation.op === 'pptx.add_slide') result.splice(index, 0, null);
    if (operation.op === 'pptx.remove_slide') result.splice(index, 1);
    if (operation.op === 'pptx.reorder_slide') result.splice(Number(operation.toIndex), 0, result.splice(index, 1)[0]);
  }
  return result;
}
