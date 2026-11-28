import React from 'react';
import type { RegisteredUiMode } from '../../../../../shared/target-selection-registry';

export interface TextRangeTargetControlProps {
  /** Registered text-range selection modes derived from `shared/target-selection-registry.ts`. */
  modes: readonly RegisteredUiMode[];
  disabled?: boolean;
  onSelectMode: (mode: RegisteredUiMode) => void;
}

/**
 * Shared text/line range target control for Code, Markdown, HTML, Diff, and Mermaid.
 * Renders only the text-range actions registered for the current format.
 */
export const TextRangeTargetControl: React.FC<TextRangeTargetControlProps> = ({
  modes,
  disabled,
  onSelectMode,
}) => (
  <>
    {modes.map((mode) => (
      <button
        key={mode.id}
        type="button"
        className="btn btn-secondary btn-xs shared-pin-action"
        disabled={disabled}
        onClick={() => onSelectMode(mode)}
      >
        {mode.actionLabel ?? `${mode.label}を対象にする`}
      </button>
    ))}
  </>
);
