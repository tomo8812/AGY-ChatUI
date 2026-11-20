import { useLayoutEffect, useRef, type ReactNode } from 'react';

interface ModalDialogProps {
  label: string;
  size: string;
  onClose: () => void;
  children: ReactNode;
}

export function ModalDialog({ label, size, onClose, children }: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal-backdrop native-dialog"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className={`modal-card ${size}`}>{children}</div>
    </dialog>
  );
}
