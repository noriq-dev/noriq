import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';

export interface AsyncSearchOption { id: string }

interface AsyncSearchSelectProps<T extends AsyncSearchOption> {
  value: string;
  onChange: (id: string) => void;
  initialOptions?: T[];
  loadOptions: (query: string, signal: AbortSignal) => Promise<T[]>;
  optionLabel: (option: T) => string;
  renderOption: (option: T) => ReactNode;
  label: string;
  placeholder: string;
  emptyMessage: string;
  disabled?: boolean;
}

const SEARCH_DELAY_MS = 200;

/** Reusable server-backed combobox for inventories that are intentionally absent from UI snapshots. */
export function AsyncSearchSelect<T extends AsyncSearchOption>({
  value,
  onChange,
  initialOptions = [],
  loadOptions,
  optionLabel,
  renderOption,
  label,
  placeholder,
  emptyMessage,
  disabled = false,
}: AsyncSearchSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<T[]>(initialOptions);
  const [selected, setSelected] = useState<T | null>(initialOptions.find((option) => option.id === value) ?? null);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<'top' | 'bottom'>('bottom');
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const requestSerial = useRef(0);
  const listId = useId();

  const options = useMemo(() => {
    if (!selected || results.some((option) => option.id === selected.id)) return results;
    return [selected, ...results];
  }, [results, selected]);

  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    const option = [...initialOptions, ...results].find((candidate) => candidate.id === value);
    if (option && option.id !== selected?.id) setSelected(option);
  }, [initialOptions, results, selected?.id, value]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const request = ++requestSerial.current;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setError(null);
      void loadOptions(query, controller.signal)
        .then((next) => {
          if (requestSerial.current !== request) return;
          setResults(next);
          setActive(0);
        })
        .catch((cause: unknown) => {
          if (requestSerial.current !== request) return;
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          setError(cause instanceof Error ? cause.message : `${label} search failed`);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (requestSerial.current === request) requestSerial.current += 1;
    };
  }, [label, loadOptions, open, query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const root = rootRef.current;
      const menu = menuRef.current;
      if (!root || !menu) return;
      const trigger = root.getBoundingClientRect();
      const menuHeight = menu.getBoundingClientRect().height;
      const below = window.innerHeight - trigger.bottom - 16;
      const above = trigger.top - 16;
      setSide(menuHeight > below && above > below ? 'top' : 'bottom');
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, options.length]);

  const choose = (option: T | null) => {
    setSelected(option);
    onChange(option?.id ?? '');
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(Math.max(0, options.length - 1), index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && open && options[active]) {
      event.preventDefault();
      choose(options[active]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%' }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <input
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          disabled={disabled}
          value={open ? query : selected ? optionLabel(selected) : ''}
          placeholder={placeholder}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onClick={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onKeyDown={onKeyDown}
          style={{
            boxSizing: 'border-box', width: '100%', minWidth: 0, padding: '9px 34px 9px 12px',
            borderRadius: 9, border: `1px solid ${error ? 'rgba(255,92,92,.4)' : 'var(--w-1)'}`,
            background: 'var(--w-05)', color: 'var(--text)', fontSize: 13, outline: 'none',
          }}
        />
        {value && !open && (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => choose(null)}
            style={{ position: 'absolute', right: 8, border: 0, background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer' }}
          >×</button>
        )}
      </div>
      {open && (
        <div
          ref={menuRef}
          id={listId}
          role="listbox"
          aria-label={`${label} results`}
          style={{
            position: 'absolute', zIndex: 70, [side === 'top' ? 'bottom' : 'top']: 'calc(100% + 8px)', left: 0, right: 0,
            maxHeight: 280, overflowY: 'auto', padding: 6, borderRadius: 12,
            border: '1px solid var(--w-12)', background: 'var(--bg-raised)', boxShadow: '0 18px 55px rgba(0,0,0,.5)',
          }}
        >
          {searching && <div style={{ padding: 8, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>searching…</div>}
          {!searching && error && <div style={{ padding: 8, fontSize: 11, color: 'var(--red-soft)' }}>{error}</div>}
          {!searching && !error && options.length === 0 && <div style={{ padding: 12, fontSize: 11, color: 'var(--text-faint)' }}>{emptyMessage}</div>}
          {options.map((option, index) => (
            <div
              key={option.id}
              id={`${listId}-${index}`}
              role="option"
              data-value={option.id}
              aria-selected={option.id === value}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(option)}
              style={{
                padding: '7px 9px', borderRadius: 7, cursor: 'pointer',
                background: index === active ? 'var(--w-06)' : option.id === value ? 'var(--w-08)' : 'transparent',
              }}
            >
              {renderOption(option)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
