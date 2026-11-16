export type HapticEventType = 'send' | 'stop' | 'complete' | 'error' | 'permission';

export const VIBRATION_PATTERNS: Record<HapticEventType, number[]> = {
  send: [16],
  stop: [38, 45, 38],
  complete: [14, 55, 16, 55, 42],
  error: [65, 65, 65, 65, 65],
  permission: [24, 60, 24],
};

export const HAPTIC_META: Array<{
  type: HapticEventType;
  label: string;
  patternLabel: string;
  description: string;
}> = [
  {
    type: 'send',
    label: 'メッセージ送信',
    patternLabel: '短 × 1（軽快）',
    description: 'プロンプトを送信した瞬間の短い1タップ振動',
  },
  {
    type: 'stop',
    label: '生成停止',
    patternLabel: '中 × 2（中断）',
    description: '実行をキャンセルしたときの2連続ショック振動',
  },
  {
    type: 'complete',
    label: '応答完了',
    patternLabel: 'ト・ト・ツー（完了）',
    description: 'AIの回答が完了したときのリズミカルな3拍子振動',
  },
  {
    type: 'error',
    label: 'エラー終了',
    patternLabel: '強 × 3（警告）',
    description: '実行エラー時に注意を促す連続振動',
  },
  {
    type: 'permission',
    label: 'ツール承認待ち',
    patternLabel: '中 × 2（確認）',
    description: 'コマンド実行やファイル操作の許可を求められたときの振動',
  },
];

export function isVibrationApiSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return (
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * iPhone/iPad Safari & PWA do not expose navigator.vibrate(); instead native
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
