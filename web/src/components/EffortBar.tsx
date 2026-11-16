import React from 'react';
import type { AcpSelectOption } from '../types';

interface EffortBarProps {
  options: AcpSelectOption[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export const EffortBar: React.FC<EffortBarProps> = ({
  options,
  value,
  disabled = false,
  onChange,
}) => {
  if (!options || options.length === 0) return null;

  const foundIndex = options.findIndex((o) => o.value === value);
  const activeIndex = foundIndex >= 0 ? foundIndex : 0;
  const activeOption = options[activeIndex];
  const maxIndex = Math.max(1, options.length - 1);
  const fillPercent = options.length <= 1 ? 100 : (activeIndex / maxIndex) * 100;

  return (
    <div
      className={`effort-bar-control ${disabled ? 'is-disabled' : ''}`}
      title={activeOption?.description || `推論レベル: ${activeOption?.name ?? value}`}
    >
      <span className="effort-bar-meta">
        <span className="effort-bar-key">推論</span>
        <span className="effort-bar-val">{activeOption?.name ?? value}</span>
      </span>

      <div className="effort-slider-wrap">
        <div className="effort-track">
          <div className="effort-track-fill" style={{ width: `${fillPercent}%` }} />
          <div className="effort-stops" aria-hidden="true">
            {options.map((opt, idx) => {
              const reached = idx <= activeIndex;
              const isActive = idx === activeIndex;
              return (
                <span
                  key={opt.value}
                  className={`effort-stop-dot ${reached ? 'reached' : ''} ${isActive ? 'active' : ''}`}
                />
              );
            })}
          </div>
        </div>

        <input
          type="range"
          className="effort-range-input"
          aria-label="推論レベル (Effort)"
          aria-valuetext={activeOption?.name ?? value}
          min={0}
          max={Math.max(0, options.length - 1)}
          step={1}
          value={activeIndex}
          disabled={disabled || options.length <= 1}
          onChange={(e) => {
            const nextIdx = Number.parseInt(e.target.value, 10);
            const target = options[nextIdx];
            if (target && target.value !== activeOption?.value) {
              onChange(target.value);
            }
          }}
        />
      </div>
    </div>
  );
};
