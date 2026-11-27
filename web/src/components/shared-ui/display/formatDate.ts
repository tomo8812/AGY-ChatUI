const defaultFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
const shortMonth = new Intl.DateTimeFormat(undefined, { month: 'short' });

export { parseRichChartTime as parseDisplayDate } from '../../../../../shared/rich-chart-display';

export function formatDisplayDate(value: number, format?: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  if (format && /%[YymdbHMS]|YYYY|MM|DD/.test(format)) {
    const pad = (number: number) => String(number).padStart(2, '0');
    const parts: Record<string, string> = {
      '%Y': String(date.getFullYear()), '%y': pad(date.getFullYear() % 100), '%m': pad(date.getMonth() + 1),
      '%d': pad(date.getDate()), '%b': shortMonth.format(date),
      '%H': pad(date.getHours()), '%M': pad(date.getMinutes()), '%S': pad(date.getSeconds()),
    };
    return format.replace(/%[YymdbHMS]|YYYY|MM|DD/g, token => parts[token] ?? parts[{ YYYY: '%Y', MM: '%m', DD: '%d' }[token]!]);
  }
  const dateStyle = format === 'long' || format === 'medium' || format === 'short' || format === 'full' ? format : undefined;
  return dateStyle ? new Intl.DateTimeFormat(undefined, { dateStyle }).format(date) : defaultFormat.format(date);
}
