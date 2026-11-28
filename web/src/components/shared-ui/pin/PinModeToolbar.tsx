import React from 'react';

export interface PinModeOption<T extends string = string> {
  id: T;
  label: string;
  hint?: string;
}

export interface PinModeToolbarProps<T extends string = string> {
  /** Accessible group label for the toolbar. */
  ariaLabel: string;
  /** Accessible label for the mode selector when multiple modes exist. */
  selectLabel?: string;
  /** Registered selection modes available in the current format/view. */
  options: readonly PinModeOption<T>[];
  /** Currently active selection mode. */
  value: T;
  /** Called when the user switches selection mode. */
  onChange: (next: T) => void;
  /** Format-specific primary controls (e.g. "対象にする" button, element picker). */
  children?: React.ReactNode;
  /** Optional extra class name. */
  className?: string;
}

/**
 * Shared target-selection toolbar used by all format modules in `pin` mode.
 * Keeps controls single-line / non-wrapping on PC and iPhone viewports (`UX-02`).
 */
export function PinModeToolbar<T extends string = string>({
  ariaLabel,
  selectLabel = '選択方法',
  options,
  value,
  onChange,
  children,
  className = '',
}: PinModeToolbarProps<T>) {
  const active = options.find((opt) => opt.id === value);
  return (
    <div
      className={`workspace-toolbar workspace-toolbar-fields shared-pin-toolbar ${className}`.trim()}
      role="group"
      aria-label={ariaLabel}
    >
      {options.length > 1 && (
        <label className="shared-pin-mode-label">
          <span>対象</span>
          <select
            aria-label={selectLabel}
            value={value}
            onChange={(event) => onChange(event.target.value as T)}
          >
            {options.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {children}
      {active?.hint && <small className="shared-pin-hint">{active.hint}</small>}
    </div>
  );
}
