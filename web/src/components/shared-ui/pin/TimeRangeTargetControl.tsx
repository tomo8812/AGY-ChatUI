import React from 'react';

export interface TimeRangeTargetControlProps {
  startSec: number;
  endSec: number;
  durationSec: number;
  onChangeStart: (sec: number) => void;
  onChangeEnd: (sec: number) => void;
  disabled?: boolean;
  onConfirm: () => void;
}

/**
 * Shared playback time-range target control for Video/Audio (`video_time_range` / `audio_time_range`).
 */
export const TimeRangeTargetControl: React.FC<TimeRangeTargetControlProps> = ({
  startSec,
  endSec,
  durationSec,
  onChangeStart,
  onChangeEnd,
  disabled,
  onConfirm,
}) => {
  const valid =
    Number.isFinite(durationSec) &&
    durationSec > 0 &&
    Number.isFinite(startSec) &&
    Number.isFinite(endSec) &&
    startSec >= 0 &&
    endSec > startSec &&
    endSec <= durationSec;

  return (
    <div className="workspace-toolbar workspace-toolbar-fields shared-pin-toolbar" role="group" aria-label="時間区間の対象指定">
      <label className="workspace-bound">
        開始(秒)
        <input
          type="number"
          aria-label="開始秒"
          min={0}
          max={durationSec || undefined}
          step={0.1}
          value={Number.isFinite(startSec) ? startSec : ''}
          onChange={(event) => onChangeStart(event.target.valueAsNumber)}
        />
      </label>
      <label className="workspace-bound">
        終了(秒)
        <input
          type="number"
          aria-label="終了秒"
          min={0}
          max={durationSec || undefined}
          step={0.1}
          value={Number.isFinite(endSec) ? endSec : ''}
          onChange={(event) => onChangeEnd(event.target.valueAsNumber)}
        />
      </label>
      <button
        type="button"
        className="btn btn-secondary btn-xs shared-pin-action"
        disabled={disabled || !valid}
        onClick={onConfirm}
      >
        時間区間を対象にする
      </button>
    </div>
  );
};
