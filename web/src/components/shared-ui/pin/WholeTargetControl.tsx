import React from 'react';

export interface WholeTargetControlProps {
  /** Action label (e.g. "スライド全体を対象にする", "ページを対象にする", "シート全体を対象にする"). */
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * Shared control for whole-document / page / slide / sheet target selection.
 */
export const WholeTargetControl: React.FC<WholeTargetControlProps> = ({
  label,
  disabled,
  onSelect,
}) => (
  <button
    type="button"
    className="btn btn-secondary btn-xs shared-pin-action"
    disabled={disabled}
    onClick={onSelect}
  >
    {label}
  </button>
);
