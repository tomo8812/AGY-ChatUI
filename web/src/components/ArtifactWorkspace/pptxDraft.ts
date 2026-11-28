import type { EditOperation } from '../../api/workspace';

export function preparePptxOperations(operations: readonly EditOperation[]): EditOperation[] {
  const removed = new Set(operations.filter(op => op.op === 'pptx.remove_shape').map(op => op.slidePart + ':' + op.shapeId));
  const retained = operations.filter(op => !(op.op.startsWith('pptx.set_shape_') || op.op === 'pptx.set_table_cell') || !removed.has(op.slidePart + ':' + op.shapeId));
  return [...retained.filter(op => op.op !== 'pptx.set_shape_style'), ...retained.filter(op => op.op === 'pptx.set_shape_style')];
}

export type ProjectedSlide = { id: string; part: string; baseIndex?: number; draftSlideKey?: string };

export function projectSlides(slides: readonly Pick<ProjectedSlide, 'id' | 'part'>[], operations: readonly EditOperation[]): ProjectedSlide[] {
  const result: ProjectedSlide[] = slides.map((slide, baseIndex) => ({ ...slide, baseIndex }));
  for (const operation of operations) {
    const index = Number(operation.index);
    if (operation.op === 'pptx.add_slide' && typeof operation.draftSlideKey === 'string') {
      const key = operation.draftSlideKey;
      result.splice(index, 0, { id: key, part: key, draftSlideKey: key });
    }
    if (operation.op === 'pptx.remove_slide') result.splice(index, 1);
    if (operation.op === 'pptx.reorder_slide') result.splice(Number(operation.toIndex), 0, result.splice(index, 1)[0]);
  }
  return result;
}
