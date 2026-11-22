export type HapticEventType = 'stop';

export const VIBRATION_PATTERNS: Record<HapticEventType, number[]> = {
  stop: [38, 45, 38],
};

export const HAPTIC_META: Array<{
  type: HapticEventType;
  label: string;
  patternLabel: string;
  description: string;
}> = [
  {
    type: 'stop',
    label: '生成停止',
    patternLabel: '中 × 2（中断）',
    description: '実行をキャンセルしたときの振動',
  },
];

export function isVibrationApiSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPhone|iPod/i.test(ua);
}

/**
 * iPhone Safari & PWA do not expose navigator.vibrate(); instead native
 * `<input type="checkbox" switch>` wrapped around a genuine user-tap emits system Taptic feedback.
 */
export function isAppleTouchHapticsFallback(): boolean {
  return !isVibrationApiSupported() && isAppleTouchDevice();
}

export function triggerHaptic(eventType: HapticEventType, enabled: boolean): boolean {
  if (!enabled) return false;
  if (!isVibrationApiSupported()) return false;
  try {
    return navigator.vibrate(VIBRATION_PATTERNS[eventType]);
  } catch {
    return false;
  }
}
