import type { ReactNode } from 'react';
import type { RichTone } from '../../../../../shared/rich-schema';

export function toneClass(tone: unknown): string {
  return ['muted', 'info', 'success', 'warning', 'danger'].includes(String(tone)) ? ' rich-tone-' + String(tone) : '';
}

export function RichBadge({ tone, dot, children }: { tone?: RichTone; dot?: boolean; children: ReactNode }) {
  return <span className={'rich-status' + toneClass(tone)}>{dot && <i />}{children}</span>;
}
