import React from 'react';

export interface SelectableElementOption {
  id: string;
  label: string;
}

export interface ElementTargetControlProps {
  /** Accessible label for the element dropdown (used when `elements` is provided). */
  ariaLabel?: string;
  placeholder?: string;
  /** Optional list of selectable elements for dropdown picking (e.g. PPTX shapes). When omitted, selection is driven directly from the document/canvas (e.g. DOCX paragraphs). */
  elements?: readonly SelectableElementOption[];
  selectedId?: string;
  onSelectId?: (id: string) => void;
  actionLabel?: string;
  actionDisabled?: boolean;
  onConfirm: () => void;
}

/**
 * Shared structural element selection control reused by PPTX (shapes) and
 * DOCX (paragraphs). Supports both dropdown picking and direct canvas/document
 * element confirmation while unifying action controls and disabled semantics.
 */
export const ElementTargetControl: React.FC<ElementTargetControlProps> = ({
  ariaLabel = '対象要素',
  placeholder = '要素を選択',
  elements,
  selectedId = '',
  onSelectId,
  actionLabel = '要素を対象にする',
  actionDisabled,
  onConfirm,
}) => {
  const hasPicker = elements !== undefined && onSelectId !== undefined;
  return (
    <>
      {hasPicker && (
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
      )}
      <button
        type="button"
        className="btn btn-secondary btn-xs shared-pin-action"
        disabled={actionDisabled || (hasPicker && !selectedId)}
        onClick={onConfirm}
      >
        {actionLabel}
      </button>
    </>
  );
};
