import React, { useId } from 'react';

interface ToggleSwitchProps {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  description?: string;
  onChange: (nextChecked: boolean) => void;
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  id,
  checked,
  disabled = false,
  label,
  description,
  onChange,
}) => {
  const autoId = useId();
  const switchId = id ?? `toggle-${autoId}`;

  return (
    <div className={`toggle-setting-row ${disabled ? 'is-disabled' : ''}`}>
      <label htmlFor={switchId} className="toggle-setting-text">
        <span className="toggle-setting-title">{label}</span>
        {description && <span className="muted-xs toggle-setting-desc">{description}</span>}
      </label>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`toggle-switch ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-switch-thumb" aria-hidden="true" />
      </button>
    </div>
  );
};
