import type { RichChartDatum } from './rich-schema.js';

export function isRichChartCoordinate(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

export function parseRichChartTime(value: string | number): number {
  if (typeof value === 'number') return new Date(value).getTime();
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00' : value).getTime();
}

export function richChartAxisPosition(value: string | number, axisType: 'number' | 'time'): number {
  if (axisType === 'time') return parseRichChartTime(value);
  return typeof value === 'number' || value.trim() ? Number(value) : NaN;
}

export function isRichChartPoint(value: unknown): value is number | null | RichChartDatum {
  if (value === null || typeof value === 'number' && Number.isFinite(value)) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return (point.y === null || (typeof point.y === 'number' && Number.isFinite(point.y))) &&
    (point.x === undefined || isRichChartCoordinate(point.x)) &&
    ['label', 'missingReason', 'sourceId', 'asOf'].every(key => point[key] === undefined || typeof point[key] === 'string');
}

/** The logical point used by the renderer and the target selector. */
export function resolveRichChartPoint(
  value: number | null | RichChartDatum,
  categories: readonly (string | number)[],
  index: number,
): RichChartDatum & { x: string | number; y: number | null } {
  if (!isRichChartPoint(value)) throw new TypeError('Invalid chart point.');
  const datum = value && typeof value === 'object' ? value : { y: value };
  const x = 'x' in datum && (typeof datum.x === 'string' || typeof datum.x === 'number')
    ? datum.x : categories[index] ?? index + 1;
  return { ...datum, x, y: datum.y };
}
