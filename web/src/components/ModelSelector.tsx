import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AcpSelectOption } from '../types';
import { CheckIcon, ChevronIcon } from './Icons';

interface ModelSelectorProps {
  options: AcpSelectOption[];
  value: string;
  disabled?: boolean;
  onChange: (modelId: string) => void;
}

interface PopoverStyleVars extends React.CSSProperties {
  '--model-pop-left'?: string;
  '--model-pop-bottom'?: string;
  '--model-pop-top'?: string;
  '--model-pop-max-h'?: string;
}

export const ModelSelector: React.FC<ModelSelectorProps> = React.memo(({
  options,
  value,
  disabled = false,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<PopoverStyleVars>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const safeOptions = options ?? [];
  const selectedOption = safeOptions.find((o) => o.value === value) ?? safeOptions[0];
  const displayLabel = selectedOption?.name ?? value;

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    const panelWidth = Math.min(312, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - panelWidth - 12));
    const spaceAbove = rect.top - 16;
    const spaceBelow = window.innerHeight - rect.bottom - 16;
    const preferUp = spaceAbove >= 200 || spaceAbove >= spaceBelow;

    if (preferUp) {
      setPopoverStyle({
        '--model-pop-left': `${Math.round(left)}px`,
        '--model-pop-bottom': `${Math.round(window.innerHeight - rect.top + 8)}px`,
        '--model-pop-top': 'auto',
        '--model-pop-max-h': `${Math.max(180, Math.min(380, Math.floor(spaceAbove)))}px`,
      });
    } else {
      setPopoverStyle({
        '--model-pop-left': `${Math.round(left)}px`,
        '--model-pop-top': `${Math.round(rect.bottom + 8)}px`,
        '--model-pop-bottom': 'auto',
        '--model-pop-max-h': `${Math.max(180, Math.min(380, Math.floor(spaceBelow)))}px`,
      });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onViewportChange = () => updatePosition();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const selectedBtn = panelRef.current?.querySelector<HTMLButtonElement>(
        '.model-option-btn.selected'
      );
      const firstBtn = panelRef.current?.querySelector<HTMLButtonElement>('.model-option-btn');
      (selectedBtn ?? firstBtn)?.focus();
    }, 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (safeOptions.length === 0) return null;

  const handleSelect = (nextValue: string) => {
    setOpen(false);
    if (nextValue !== value) {
      onChange(nextValue);
    }
    triggerRef.current?.focus();
  };

  const handleOptionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const items = panelRef.current?.querySelectorAll<HTMLButtonElement>('.model-option-btn');
    if (!items || items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const popoverNode =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="model-popover-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setOpen(false);
              }
            }}
          >
            <div
              ref={panelRef}
              className="model-popover-panel"
              style={popoverStyle}
              role="listbox"
              aria-label="使用モデルを選択"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="model-sheet-handle" aria-hidden="true" />
              <div className="model-popover-head">
                <span>モデルを選択</span>
              </div>
              <div className="model-options-list">
                {safeOptions.map((opt, idx) => {
                  const isSelected = opt.value === selectedOption?.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={`model-option-btn ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleSelect(opt.value)}
                      onKeyDown={(e) => handleOptionKeyDown(e, idx)}
                    >
                      <div className="model-option-text">
                        <div className="model-option-name">{opt.name}</div>
                        {opt.description && (
                          <div className="model-option-desc">{opt.description}</div>
                        )}
                      </div>
                      <span className="model-option-check" aria-hidden="true">
                        {isSelected ? <CheckIcon size={15} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`model-trigger-btn ${open ? 'active' : ''}`}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="モデル選択"
        title={displayLabel ? `モデル: ${displayLabel}` : 'モデル選択'}
      >
        <span className="model-trigger-label">{displayLabel}</span>
        <ChevronIcon size={13} dir={open ? 'up' : 'down'} className="model-trigger-chevron" />
      </button>

      {popoverNode}
    </>
  );
});
