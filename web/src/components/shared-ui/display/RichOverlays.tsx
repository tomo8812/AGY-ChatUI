import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';

const interactive = 'button,input,select,textarea,a[href],summary,[contenteditable=true],[tabindex],[role=button],[role=tab]';

export function originatesInControl(target: EventTarget | null, boundary: Element): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(interactive);
  return control !== null && control !== boundary && boundary.contains(control);
}

export interface RichPopoverTrigger {
  ref: React.Ref<HTMLButtonElement>;
  expanded: boolean;
  controls: string;
  toggle: () => void;
}

export function RichPopover({ trigger, children }: {
  trigger: ReactNode | ((binding: RichPopoverTrigger) => ReactNode);
  children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const toggle = () => setOpen(value => !value);
  return <div ref={root} className="rich-popover" onKeyDown={event => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      handle.current?.focus();
    }
  }}>
    {typeof trigger === 'function' ? trigger({ ref: handle, expanded: open, controls: id, toggle }) :
      <div className="rich-overlay-trigger" onClick={event => {
        if (event.defaultPrevented || originatesInControl(event.target, event.currentTarget)) return;
        event.stopPropagation();
        toggle();
      }}>
        {trigger}
        <button ref={handle} type="button" className="btn btn-ghost btn-xs rich-popover-toggle"
          aria-label={open ? 'ポップオーバーを閉じる' : 'ポップオーバーを開く'} aria-expanded={open} aria-controls={id}
          onClick={toggle}>{open ? '▴' : '▾'}</button>
      </div>}
    <div id={id} className="rich-overlay-panel" role="region" aria-label="ポップオーバー" hidden={!open} onClick={event=>event.stopPropagation()}>{open && children}</div>
  </div>;
}

export function RichTooltip({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const described = useRef<Element | null>(null);
  useEffect(() => {
    if (dismissed || (!hover && !focused)) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setDismissed(true); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [dismissed, hover, focused]);
  const removeDescription = () => {
    const element = described.current;
    if (!element) return;
    const ids = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(token => token && token !== id);
    if (ids.length) element.setAttribute('aria-describedby', ids.join(' '));
    else element.removeAttribute('aria-describedby');
    described.current = null;
  };
  return <div className="rich-tooltip" onPointerEnter={event => {
    if (event.pointerType !== 'touch') { setHover(true); setDismissed(false); }
  }} onPointerLeave={() => setHover(false)} onKeyDown={event => {
    if (event.key === 'Escape' && !dismissed && (hover || focused)) {
      event.stopPropagation();
      setDismissed(true);
    }
  }}>
    <div className="rich-overlay-trigger" tabIndex={0} aria-describedby={id}
      onFocus={event => {
        setFocused(true);
        setDismissed(false);
        removeDescription();
        if (event.target !== event.currentTarget) {
          const previous = event.target.getAttribute('aria-describedby');
          if (!previous?.split(/\s+/).includes(id)) {
            event.target.setAttribute('aria-describedby', previous ? previous + ' ' + id : id);
            described.current = event.target;
          }
        }
      }} onBlur={event => {
        removeDescription();
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}>{trigger}</div>
    <div className="rich-overlay-panel" id={id} role="tooltip" hidden={dismissed || (!hover && !focused)}>{children}</div>
  </div>;
}
