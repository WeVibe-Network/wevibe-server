'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface SearchableModelOption {
  id: string;
  name: string;
}

interface SearchableModelComboboxProps {
  id: string;
  value: string;
  options: SearchableModelOption[];
  onChange: (nextValue: string) => void;
  placeholder?: string;
  className?: string;
}

export default function SearchableModelCombobox({
  id,
  value,
  options,
  onChange,
  placeholder,
  className = 'mt-1 w-full rounded-lg border border-wv-line-2 bg-wv-panel-2 px-3 py-2 text-sm text-wv-text shadow-wv-sm placeholder:text-wv-faint focus:border-wv-violet focus:outline-none focus:ring-2 focus:ring-[rgba(124,92,255,0.22)]',
}: SearchableModelComboboxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    document.addEventListener('keydown', handleDocumentKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
    };
  }, [open]);

  const query = value.trim().toLowerCase();

  const filteredOptions = useMemo(() => {
    if (query.length === 0) {
      return options;
    }

    return options.filter((option) => (
      option.id.toLowerCase().includes(query) || option.name.toLowerCase().includes(query)
    ));
  }, [options, query]);

  const hasExactMatch = useMemo(
    () => options.some((option) => option.id === value),
    [options, value],
  );

  return (
    <div ref={containerRef}>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        autoComplete="off"
        placeholder={placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={`${id}-options`}
        aria-expanded={open}
        className={className}
      />

      {open && options.length > 0 ? (
        <div
          id={`${id}-options`}
          role="listbox"
          className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-wv-line-2 bg-wv-panel-2 shadow-wv-sm"
        >
          {!hasExactMatch && value.trim().length > 0 ? (
            <button
              type="button"
              onClick={() => {
                onChange(value.trim());
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 border-b border-wv-line px-3 py-2 text-left text-xs text-wv-dim transition hover:bg-wv-panel"
            >
              Use custom model:
              <span className="font-mono text-[11px] text-wv-text">{value.trim()}</span>
            </button>
          ) : null}

          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                className={`w-full px-3 py-2 text-left text-sm transition hover:bg-wv-panel ${
                  option.id === value ? 'bg-wv-panel text-wv-violet' : 'text-wv-text'
                }`}
              >
                {option.name !== option.id ? (
                  <>
                    <span>{option.name}</span>
                    <span className="ml-2 font-mono text-xs text-wv-dim">{option.id}</span>
                  </>
                ) : (
                  <span className="font-mono text-xs">{option.id}</span>
                )}
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-xs text-wv-dim">No matching models. Keep typing to use a custom id.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
