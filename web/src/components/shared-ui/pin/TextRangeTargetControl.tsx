import React from 'react';

export interface TextRangeTargetControlProps {
  /** Whether character-range selection is available alongside line-range selection (Code/Text). */
  allowCharRange?: boolean;
  disabled?: boolean;
  onSelectLineRange: () => void;
  onSelectCharRange?: () => void;
}

/**
 * Shared text/line range target control for Code, Markdown, HTML, Diff, and Mermaid.
 */
export const TextRangeTargetControl: React.FC<TextRangeTargetControlProps> = ({
  allowCharRange = false,
  disabled,
  onSelectLineRange,
  onSelectCharRange,
}) => (
  <>
    <button
      type="button"
      className="btn btn-secondary btn-xs shared-pin-action"
      disabled={disabled}
      onClick={onSelectLineRange}
    >
      選択行を対象にする
    </button>
    {allowCharRange && onSelectCharRange && (
      <button
        type="button"
        className="btn btn-secondary btn-xs shared-pin-action"
        disabled={disabled}
        onClick={onSelectCharRange}
      >
        選択文字を対象にする
      </button>
    )}
  </>
);
