import React from 'react';
import { PinModeToolbar, type PinModeOption } from './PinModeToolbar';

export type GridPinMode = 'range' | 'row' | 'col' | 'sheet';

export interface GridTargetControlProps {
  /** Whether whole-sheet selection is registered (true for XLSX, false for CSV/TSV). */
  allowSheet: boolean;
  mode: GridPinMode;
  onModeChange: (mode: GridPinMode) => void;
  /** Human-readable summary of the active selection (e.g. "A1:B3", "行 1–2", "列 A–B", "Sheet1"). */
  selectionSummary: string;
  disabled?: boolean;
  onConfirm: () => void;
}

/**
 * Shared cell / row / column / sheet target selection control for XLSX and CSV/TSV.
 */
export const GridTargetControl: React.FC<GridTargetControlProps> = ({
  allowSheet,
  mode,
  onModeChange,
  selectionSummary,
  disabled,
  onConfirm,
}) => {
  const options: PinModeOption<GridPinMode>[] = [
    { id: 'range', label: 'セル範囲' },
    { id: 'row', label: '行' },
    { id: 'col', label: '列' },
    ...(allowSheet ? [{ id: 'sheet' as const, label: 'シート全体' }] : []),
  ];
  const buttonLabel =
    mode === 'row'
      ? '行を対象にする'
      : mode === 'col'
        ? '列を対象にする'
        : mode === 'sheet'
          ? 'シートを対象にする'
          : 'セルを対象にする';

  return (
    <PinModeToolbar
      ariaLabel="表の対象指定"
      selectLabel="表の選択方法"
      options={options}
      value={mode}
      onChange={onModeChange}
    >
      <button
        type="button"
        className="btn btn-secondary btn-xs shared-pin-action"
        disabled={disabled}
        title={selectionSummary}
        onClick={onConfirm}
      >
        {buttonLabel}
      </button>
    </PinModeToolbar>
  );
};
