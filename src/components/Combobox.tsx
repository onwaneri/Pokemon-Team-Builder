'use client';

import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';

export type ComboboxOption = string | { header: string };

/**
 * Searchable select. Supports section headers — pass `{ header: string }` entries in `options`
 * to render non-selectable dividers. Headers are hidden during search mode.
 *
 * Focus/click shows the full option list; typing switches to filter mode.
 * Keyboard: ↑/↓ to move through selectable items, Enter to pick, Esc to close.
 *
 * Optional: `renderOption` customizes how each selectable option renders (e.g. type badges);
 * `onAfterSelect` fires after a value is picked (e.g. to advance focus); `inputRef` exposes the
 * underlying input so a parent can focus it.
 */
export default function Combobox({
  value,
  onChange,
  options,
  placeholder,
  renderOption,
  onAfterSelect,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  renderOption?: (opt: string) => ReactNode;
  onAfterSelect?: () => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null); // null = browsing; string = searching
  const [highlight, setHighlight] = useState(0); // index into navigable (string) items
  const rootRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  const isHeader = (o: ComboboxOption): o is { header: string } => typeof o === 'object';

  // When searching: only matching strings (no headers)
  // When browsing: full list including headers
  const displayItems: ComboboxOption[] =
    query && query.trim()
      ? options.filter((o): o is string => !isHeader(o) && o.toLowerCase().includes(query.toLowerCase()))
      : options;

  const navigable = displayItems.filter((o): o is string => !isHeader(o));

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(null);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  function browseAll() {
    setOpen(true);
    setQuery(null);
    const idx = navigable.indexOf(value);
    setHighlight(idx >= 0 ? idx : 0);
  }

  function select(opt: string) {
    onChange(opt);
    setQuery(null);
    setOpen(false);
    onAfterSelect?.();
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        value={query !== null ? query : value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onFocus={(e) => {
          browseAll();
          e.currentTarget.select();
          e.currentTarget.style.borderColor = 'rgba(99,102,241,0.5)';
        }}
        onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.2)'; }}
        onClick={browseAll}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(navigable.length - 1, h + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(0, h - 1));
          } else if (e.key === 'Enter') {
            if (open && navigable[highlight]) {
              e.preventDefault();
              select(navigable[highlight]);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
            setQuery(null);
          }
        }}
        style={{
          width: '100%',
          borderRadius: 8,
          border: '1px solid rgba(99,102,241,0.2)',
          background: 'rgba(4,4,14,0.85)',
          padding: '7px 10px',
          fontSize: 12,
          fontWeight: 600,
          color: '#c0c0e4',
          outline: 'none',
          colorScheme: 'dark',
        } as React.CSSProperties}
      />
      {open && displayItems.length > 0 && (
        <ul
          style={{
            position: 'absolute',
            zIndex: 30,
            marginTop: 3,
            maxHeight: 220,
            width: '100%',
            overflowY: 'auto',
            borderRadius: 9,
            border: '1px solid rgba(99,102,241,0.22)',
            background: 'rgba(10,10,24,0.98)',
            padding: '4px 0',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
        >
          {(() => {
            let navIdx = 0;
            return displayItems.map((o, i) => {
              if (isHeader(o)) {
                return (
                  <li
                    key={`h-${i}`}
                    style={{ padding: '6px 10px 2px', fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1, color: '#40406a', userSelect: 'none' }}
                  >
                    {o.header}
                  </li>
                );
              }
              const idx = navIdx++;
              const active = idx === highlight;
              return (
                <li
                  key={o}
                  ref={active ? activeRef : undefined}
                  onMouseDown={(e) => { e.preventDefault(); select(o); }}
                  onMouseEnter={() => setHighlight(idx)}
                  style={{
                    cursor: 'pointer',
                    padding: '5px 10px',
                    fontSize: 12,
                    fontWeight: o === value ? 700 : 500,
                    background: active ? '#6366f1' : 'transparent',
                    color: active ? 'white' : '#c0c0e4',
                  }}
                >
                  {renderOption ? renderOption(o) : o}
                </li>
              );
            });
          })()}
        </ul>
      )}
    </div>
  );
}
