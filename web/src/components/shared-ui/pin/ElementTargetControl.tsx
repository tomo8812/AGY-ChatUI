import React from 'react';

export interface SelectableElementOption {
  id: string;
  label: string;
}

export interface ElementTargetControlProps {
  ariaLabel: string;
  placeholder?: string;
  elements: readonly SelectableElementOption[];
  selectedId: string;
  onSelectId: (id: string) => void;
  actionLabel?: string;
  actionDisabled?: boolean;
  onConfirm: () => void;
}

/**
 * Shared structural element picker + confirm action (PPTX shapes, DOCX paragraphs, etc.).
 */
export const ElementTargetControl: React.FC<ElementTargetControlProps> = ({
  ariaLabel,
  placeholder = '要素を選択',
  elements,
  selectedId,
  onSelectId,
  actionLabel = '要素を対象にする',
  actionDisabled,
  onConfirm,
}) => (
  <>
    <select
      aria-label={ariaLabel}
      value={selectedId}
      onChange={(event) => onSelectId(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {elements.map((item) => (
        <option key={item.id} value={item.id}>
          {item.label}
        </option>
      ))}
    </select>
    <button
      type="button"
      className="btn btn-secondary btn-xs shared-pin-action"
      disabled={actionDisabled || !selectedId}
      onClick={onConfirm}
    >
      {actionLabel}
    </button>
  </>
);
