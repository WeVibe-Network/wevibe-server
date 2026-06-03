'use client';

import { type JSX, type ReactNode, useId, useState } from 'react';

interface InfoTooltipProps {
  children: ReactNode;
  label?: string;
  className?: string;
}

export default function InfoTooltip({
  children,
  label = 'More info',
  className,
}: InfoTooltipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  return (
    <span
      className={`relative inline-flex ${className ?? ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? tooltipId : undefined}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            event.currentTarget.blur();
          }
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-wv-line-2 font-mono text-[10px] leading-none text-wv-dim transition hover:border-wv-line hover:text-wv-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(124,92,255,0.35)]"
      >
        i
      </button>
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          className="absolute left-0 top-full z-20 mt-2 w-64 rounded-lg border border-wv-line bg-wv-panel-2 p-3 text-xs text-wv-dim shadow-wv-md"
        >
          {children}
        </span>
      )}
    </span>
  );
}
