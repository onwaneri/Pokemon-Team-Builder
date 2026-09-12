'use client';

import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';

/**
 * A selectable name, or a section header. A header applies to every option after it up to the
 * next header. `searchOnly` sections stay hidden while browsing and only surface once the user
 * types something that matches (Showdown's "illegal moves" behaviour).
 */
export type ComboboxHeader = { header: string; searchOnly?: boolean; hint?: string };
export type ComboboxOption = string | ComboboxHeader;

interface Section {
  header: ComboboxHeader | null;
  items: string[];
}

const isHeader = (o: ComboboxOption): o is ComboboxHeader => typeof o === 'object';

function toSections(options: ComboboxOption[]): Section[] {
  const sections: Section[] = [];
  let current: Section = { header: null, items: [] };
  for (const o of options) {
    if (isHeader(o)) {
      if (current.header || current.items.length) sections.push(current);
      current = { header: o, items: [] };
    } else {
      current.items.push(o);
    }
  }
  if (current.header || current.items.length) sections.push(current);
  return sections;
}

/** Substring match, with prefix / word-start matches ranked ahead of mid-word ones. */
function rankMatches(items: string[], query: string): string[] {
  const q = query.toLowerCase();
  const starts: string[] = [];
  const words: string[] = [];
  const rest: string[] = [];
  for (const it of items) {
    const lower = it.toLowerCase();
    const at = lower.indexOf(q);
    if (at < 0) continue;
    if (at === 0) starts.push(it);
    else if (/[\s-]/.test(lower[at - 1])) words.push(it);
    else rest.push(it);
  }
  return [...starts, ...words, ...rest];
}

/**
 * Searchable select. Focus/click shows the full option list; typing switches to filter mode.
 * Keyboard: ↑/↓ to move through selectable items, Enter to pick, Esc to close.
 *
 * Optional: `renderOption(name, active)` customizes how each option renders (type badges,
 * descriptions); `onAfterSelect` fires after a value is picked (e.g. to advance focus);
 * `inputRef` exposes the underlying input; `title` is the tooltip on the input itself.
 */
export default function Combobox({
  value,
  onChange,
  options,
  placeholder,
  renderOption,
  onAfterSelect,
  inputRef,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  renderOption?: (opt: string, active: boolean) => ReactNode;
  onAfterSelect?: () => void;
  inputRef?: Ref<HTMLInputElement>;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null); // null = browsing; string = searching
  const [highlight, setHighlight] = useState(0); // index into navigable (string) items
  const rootRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  const searching = !!(query && query.trim());
  const sections = toSections(options)
    .filter((s) => searching || !s.header?.searchOnly)
    .map((s) => (searching ? { ...s, items: rankMatches(s.items, query!.trim()) } : s))
    .filter((s) => s.items.length > 0);
  const navigable = sections.flatMap((s) => s.items);

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
    const all = toSections(options).filter((s) => !s.header?.searchOnly).flatMap((s) => s.items);
    const idx = all.indexOf(value);
    setHighlight(idx >= 0 ? idx : 0);
  }

  function select(opt: string) {
    onChange(opt);
    setQuery(null);
    setOpen(false);
    onAfterSelect?.();
  }

  let navIdx = 0;

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        value={query !== null ? query : value}
        placeholder={placeholder}
        title={title || undefined}
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
      {open && (
        <ul
          style={{
            position: 'absolute',
            zIndex: 30,
            marginTop: 3,
            maxHeight: 300,
            width: '100%',
            minWidth: 240,
            overflowY: 'auto',
            borderRadius: 9,
            border: '1px solid rgba(99,102,241,0.22)',
            background: 'rgba(10,10,24,0.98)',
            padding: '4px 0',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
        >
          {navigable.length === 0 && (
            <li style={{ padding: '8px 10px', fontSize: 11, color: '#50507a' }}>No matches</li>
          )}
          {sections.map((s, si) => (
            <li key={si} style={{ listStyle: 'none' }}>
              {s.header && (
                <div
                  title={s.header.hint}
                  style={{ padding: '7px 10px 3px', fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1, color: '#50507a', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  {s.header.header}
                  {s.header.hint && <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0, color: '#3a3a5e' }}>· {s.header.hint}</span>}
                </div>
              )}
              <ul style={{ padding: 0, margin: 0 }}>
                {s.items.map((o) => {
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
                        listStyle: 'none',
                      }}
                    >
                      {renderOption ? renderOption(o, active) : o}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
