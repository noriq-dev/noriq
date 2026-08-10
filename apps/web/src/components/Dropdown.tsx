// Dropdown.tsx — the one dropdown for Noriq.
import {
  useEffect, useId, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';

export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
  /** One line, shown under the label. Either every option has one or none do. */
  description?: string;
  /** Right-aligned mono hint (‘default’, ‘admin’, a count). Hidden on the selected row — the ✓ takes that slot. */
  meta?: string;
  /** Mono line under the description — for ids people paste into issues (Ask model ids). */
  mono?: string;
  disabled?: boolean;
  /** Options sharing a section render under one uppercase mono label, in first-seen order. */
  section?: string;
}

export type DropdownVariant = 'field' | 'inline' | 'micro';

export interface DropdownProps<T extends string = string> {
  value: T | null;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  variant?: DropdownVariant;
  /** Accessible purpose of the control, not merely its current value. */
  label: string;
  placeholder?: string;
  /** Keeps navigation/category triggers stable while their selected option still gets a check. */
  displayValue?: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  /** Message shown under the trigger; also borders it red. */
  invalid?: string;
  emptyNote?: string;
  footer?: ReactNode;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  menuWidth?: CSSProperties['width'];
  containerStyle?: CSSProperties;
  triggerStyle?: CSSProperties;
  autoFocus?: boolean;
  title?: string;
}

/** Options count at which the filter box appears (spec §3). */
const FILTER_THRESHOLD = 8;

const MENU: CSSProperties = {
  position: 'absolute', zIndex: 70, padding: 6,
  border: '1px solid var(--w-12)', borderRadius: 12,
  background: 'var(--bg-raised)', boxShadow: '0 18px 55px rgba(0,0,0,.5)',
  maxHeight: 320, overflowY: 'auto', animation: 'pl-stream .25s ease both',
};

const VARIANTS: Record<DropdownVariant, { trigger: CSSProperties; caret: number; menuWidth: number }> = {
  field: {
    trigger: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      boxSizing: 'border-box', width: '100%', background: 'var(--w-05)',
      border: '1px solid var(--w-1)', borderRadius: 9, padding: '9px 12px',
      fontSize: 13, color: 'var(--text)',
    },
    caret: 9,
    menuWidth: 300,
  },
  inline: {
    trigger: {
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
      borderRadius: 6, fontSize: 12.5, fontWeight: 500, color: 'var(--text-mid)',
      border: '1px solid transparent', background: 'transparent',
    },
    caret: 8,
    menuWidth: 260,
  },
  micro: {
    trigger: {
      display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--w-04)',
      border: '1px solid var(--w-1)', borderRadius: 6, padding: '3px 7px',
      fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)', maxWidth: 260,
    },
    caret: 8,
    menuWidth: 248,
  },
};

/** Open face per variant — the filled state the trigger holds while its menu is up. */
const OPEN_FACE: Record<DropdownVariant, CSSProperties> = {
  field: { background: 'var(--w-06)', border: '1px solid var(--w-18)', color: 'var(--text)' },
  inline: { background: 'var(--w-06)', border: '1px solid var(--w-1)', color: 'var(--text)' },
  micro: { background: 'var(--w-06)', border: '1px solid var(--w-18)', color: 'var(--text-soft)' },
};

export function Dropdown<T extends string = string>({
  value, options, onChange,
  variant = 'field',
  label,
  placeholder = 'Select…',
  displayValue,
  disabled = false,
  loading = false,
  invalid,
  emptyNote = 'Nothing to choose from.',
  footer,
  align = 'start',
  side = 'bottom',
  menuWidth,
  containerStyle,
  triggerStyle,
  autoFocus,
  title,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const errorId = useId();
  const spec = VARIANTS[variant];
  const showFilter = options.length >= FILTER_THRESHOLD;
  const selected = options.find((option) => option.value === value) ?? null;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => `${option.label} ${option.description ?? ''} ${option.mono ?? ''}`.toLowerCase().includes(needle));
  }, [options, query]);

  const enabledIndexes = visible.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);
  const selectedIndex = visible.findIndex((option) => option.value === value && !option.disabled);
  const initialActive = selectedIndex >= 0 ? selectedIndex : enabledIndexes[0] ?? -1;

  useEffect(() => {
    if (!open) return;
    setActive((current) => enabledIndexes.includes(current) ? current : initialActive);
    (showFilter ? filterRef.current : listRef.current)?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    const closeEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      setQuery('');
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
    // Opening is the event; re-running on every filter keystroke would fight arrow navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!enabledIndexes.includes(active)) setActive(initialActive);
  }, [active, enabledIndexes, initialActive, open]);

  useEffect(() => {
    if (disabled || loading) {
      setOpen(false);
      setQuery('');
    }
  }, [disabled, loading]);

  const commit = (option: DropdownOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus();
  };

  const step = (delta: number) => {
    if (enabledIndexes.length === 0) return;
    const position = enabledIndexes.indexOf(active);
    const nextPosition = position < 0
      ? 0
      : Math.min(enabledIndexes.length - 1, Math.max(0, position + delta));
    setActive(enabledIndexes[nextPosition]!);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        setQuery('');
        setActive(event.key === 'ArrowUp' ? enabledIndexes.at(-1) ?? -1 : initialActive);
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setQuery(''); triggerRef.current?.focus(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); step(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1); }
    else if (event.key === 'Home') { event.preventDefault(); setActive(enabledIndexes[0] ?? -1); }
    else if (event.key === 'End') { event.preventDefault(); setActive(enabledIndexes.at(-1) ?? -1); }
    else if (event.key === 'Tab') { setOpen(false); setQuery(''); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      const option = visible[active];
      if (option) commit(option);
    } else if (!showFilter && event.key.length === 1 && /\S/.test(event.key)) {
      // Type-ahead for short menus (long ones get the filter box instead).
      const index = visible.findIndex((option) => !option.disabled && option.label.toLowerCase().startsWith(event.key.toLowerCase()));
      if (index >= 0) setActive(index);
    }
  };

  const triggerText = loading ? 'Loading…' : displayValue ?? selected?.label ?? placeholder;
  const activeOptionId = active >= 0 && visible[active] ? `${listId}-${active}` : undefined;
  const sections = visible.reduce<string[]>((list, option) => {
    const key = option.section ?? '';
    return list.includes(key) ? list : [...list, key];
  }, []);

  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 'none', width: variant === 'field' ? '100%' : undefined, ...containerStyle }}>
      <button
        ref={triggerRef}
        type="button"
        className={`dd-trigger dd-trigger-${variant}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : undefined}
        disabled={disabled || loading}
        autoFocus={autoFocus}
        title={title}
        onClick={() => {
          if (open) {
            setOpen(false);
            setQuery('');
          } else {
            setQuery('');
            setActive(initialActive);
            setOpen(true);
          }
        }}
        onKeyDown={onKeyDown}
        style={{
          cursor: disabled || loading ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          ...spec.trigger,
          ...(open ? OPEN_FACE[variant] : null),
          ...(invalid ? { background: 'rgba(255,92,92,.05)', border: '1px solid rgba(255,92,92,.4)' } : null),
          ...(!selected && !loading ? { color: 'var(--text-faint)' } : null),
          ...triggerStyle,
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{triggerText}</span>
        <span aria-hidden="true" style={{ fontFamily: 'var(--mono)', fontSize: spec.caret, color: open ? 'var(--text-soft)' : 'var(--text-faint)' }}>
          {open ? '▴' : '▾'}
        </span>
      </button>

      {invalid && <div id={errorId} style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--red-soft)', marginTop: 6 }}>{invalid}</div>}

      {open && (
        <div
          className="dd-menu"
          style={{
            ...MENU,
            width: menuWidth ?? (variant === 'field' ? '100%' : spec.menuWidth),
            [side === 'top' ? 'bottom' : 'top']: 'calc(100% + 8px)',
            [align === 'end' ? 'right' : 'left']: 0,
          }}
          onKeyDown={onKeyDown}
        >
          {showFilter && (
            <input
              ref={filterRef}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              placeholder="Filter…"
              aria-label={`Filter ${label}`}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeOptionId}
              style={{
                boxSizing: 'border-box', width: '100%', margin: '2px 0 6px', padding: '6px 8px',
                borderRadius: 8, background: 'var(--w-04)', border: '1px solid var(--w-07)',
                color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 10, outline: 'none',
              }}
            />
          )}

          <div
            ref={listRef}
            role="listbox"
            id={listId}
            aria-label={label}
            aria-activedescendant={activeOptionId}
            tabIndex={showFilter ? undefined : -1}
            style={{ outline: 'none' }}
          >
            {visible.length === 0 && (
              <div style={{ padding: '16px 8px', textAlign: 'center', fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                {options.length === 0 ? emptyNote : 'No match.'}
              </div>
            )}
            {sections.map((section) => (
              <div key={section || 'default'}>
                {section && sections.length > 1 && (
                  <div style={{ padding: '5px 8px 4px', fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
                    {section}
                  </div>
                )}
                {visible.map((option, index) => {
                  if ((option.section ?? '') !== section) return null;
                  const isSelected = option.value === value;
                  return (
                    <div
                      key={option.value}
                      id={`${listId}-${index}`}
                      role="option"
                      data-value={option.value}
                      aria-selected={isSelected}
                      aria-disabled={option.disabled || undefined}
                      className={option.disabled ? undefined : 'dd-row'}
                      onPointerEnter={() => !option.disabled && setActive(index)}
                      onClick={() => commit(option)}
                      style={{
                        position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 9,
                        padding: '7px 8px', borderRadius: 7,
                        cursor: option.disabled ? 'default' : 'pointer',
                        opacity: option.disabled ? 0.45 : 1,
                        background: isSelected ? 'var(--w-08)' : index === active ? 'var(--w-06)' : 'transparent',
                      }}
                    >
                      {isSelected && <span style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 2, borderRadius: 2, background: 'var(--accent)' }} />}
                      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 4 }}>
                        <span style={{ fontSize: 12.5, fontWeight: isSelected ? 650 : 500, color: isSelected ? 'var(--text)' : 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {option.label}
                        </span>
                        {option.description && <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{option.description}</span>}
                        {option.mono && <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--text-faint)', opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.mono}</span>}
                      </span>
                      {isSelected
                        ? <span aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 10, lineHeight: '16px' }}>✓</span>
                        : option.meta
                          ? <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', lineHeight: '16px' }}>{option.meta}</span>
                          : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {footer && (
            <div style={{ borderTop: '1px solid var(--w-07)', margin: '5px 2px 3px', padding: '5px 6px 2px', fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
              {footer}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
