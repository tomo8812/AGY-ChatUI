import type { RichChartDatum } from './rich-schema.js';

/** The logical point used by the renderer and the target selector. */
export function resolveRichChartPoint(
  value: number | null | RichChartDatum,
  categories: readonly (string | number)[],
  index: number,
): RichChartDatum & { x: string | number; y: number | null } {
  const datum = value && typeof value === 'object' ? value : { y: value };
  const x = 'x' in datum && (typeof datum.x === 'string' || typeof datum.x === 'number')
    ? datum.x : categories[index] ?? index + 1;
  return { ...datum, x, y: typeof datum.y === 'number' && Number.isFinite(datum.y) ? datum.y : null };
}
