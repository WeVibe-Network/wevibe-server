'use client';

import { useEffect, useId, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
}

export default function Modal({ open, title, children, footer, onClose }: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open || !onClose) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 px-4 py-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-lg border border-wv-line bg-wv-panel shadow-wv-sm"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-wv-line px-5 py-4">
          <h2 id={titleId} className="font-sans text-base font-semibold text-wv-violet">
            {title}
          </h2>
        </div>
        <div className="px-5 py-4 text-sm text-wv-dim">{children}</div>
        {footer ? <div className="border-t border-wv-line px-5 py-4">{footer}</div> : null}
      </div>
    </div>
  );
}
