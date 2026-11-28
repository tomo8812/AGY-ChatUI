import React from 'react';
import type { RegisteredUiMode } from '../../../../../shared/target-selection-registry';
import { PinModeToolbar } from './PinModeToolbar';

export interface GridTargetControlProps {
  /** Registered grid selection modes derived from `shared/target-selection-registry.ts`. */
  modes: readonly RegisteredUiMode[];
  activeModeId: string;
  onModeChange: (modeId: string) => void;
  /** Human-readable summary of the active selection (e.g. "A1:B3", "行 1–2", "列 A–B", "Sheet1"). */
  selectionSummary: string;
  disabled?: boolean;
  onConfirm: () => void;
}

/**
 * Shared cell / row / column / sheet target selection control for XLSX and CSV/TSV.
 * Modes and action labels are driven exclusively by the shared registry.
 */
export const GridTargetControl: React.FC<GridTargetControlProps> = ({
  modes,
  activeModeId,
  onModeChange,
  selectionSummary,
  disabled,
  onConfirm,
}) => {
  const active = modes.find((m) => m.id === activeModeId) ?? modes[0];
  if (!active) return null;

  return (
    <PinModeToolbar
      ariaLabel="表の対象指定"
      selectLabel="表の選択方法"
      options={modes}
      value={active.id}
      onChange={onModeChange}
    >
      <button
        type="button"
        className="btn btn-secondary btn-xs shared-pin-action"
        disabled={disabled}
        title={selectionSummary}
        onClick={onConfirm}
      >
        {active.actionLabel ?? `${active.label}を対象にする`}
      </button>
    </PinModeToolbar>
  );
};
