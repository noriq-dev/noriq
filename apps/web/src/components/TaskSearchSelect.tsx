import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from '../api';

export interface TaskSearchOption {
  id: string;
  key: string;
  title: string;
  status?: string;
  boardId?: string | null;
}

interface TaskSearchSelectProps {
  projectId: string;
  boardId?: string | null;
  value: string;
  onChange: (taskId: string) => void;
  initialTasks?: TaskSearchOption[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
}

const SEARCH_DELAY_MS = 200;

/**
 * A reusable, bounded task picker. It intentionally searches the authorized task endpoint
 * instead of assuming any project snapshot contains the complete task inventory.
 */
export function TaskSearchSelect({
  projectId,
  boardId = null,
  value,
  onChange,
  initialTasks = [],
  label,
  placeholder = 'Search by task key or title…',
  disabled = false,
}: TaskSearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TaskSearchOption[]>(initialTasks);
  const [selected, setSelected] = useState<TaskSearchOption | null>(
    initialTasks.find((task) => task.id === value) ?? null,
  );
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<'top' | 'bottom'>('bottom');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const requestSerial = useRef(0);
  const listId = useId();

  const options = useMemo(() => {
    if (!selected || results.some((task) => task.id === selected.id)) return results;
    return [selected, ...results];
  }, [results, selected]);

  useEffect(() => {
    const task = initialTasks.find((candidate) => candidate.id === value);
    if (task) setSelected(task);
    if (!value) setSelected(null);
  }, [initialTasks, value]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const request = ++requestSerial.current;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setError(null);
      void api.searchTasks({ projectId, boardId, text: query, limit: 25 }, controller.signal)
        .then(({ tasks }) => {
          if (requestSerial.current !== request) return;
          setResults(tasks);
          setActive(0);
        })
        .catch((cause: unknown) => {
          if (requestSerial.current !== request) return;
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          setError(cause instanceof Error ? cause.message : 'Task search failed');
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
  }, [boardId, open, projectId, query]);

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

  const choose = (task: TaskSearchOption | null) => {
    setSelected(task);
    onChange(task?.id ?? '');
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(options.length - 1, index + 1));
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
          ref={inputRef}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          disabled={disabled}
          value={open ? query : selected ? `${selected.key} · ${selected.title}` : ''}
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
          {!searching && !error && options.length === 0 && <div style={{ padding: 12, fontSize: 11, color: 'var(--text-faint)' }}>No matching tasks.</div>}
          {options.map((task, index) => (
            <div
              key={task.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={task.id === value}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(task)}
              style={{
                padding: '7px 9px', borderRadius: 7, cursor: 'pointer',
                background: index === active ? 'var(--w-06)' : task.id === value ? 'var(--w-08)' : 'transparent',
              }}
            >
              <div style={{ fontSize: 12.5, color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <strong style={{ color: 'var(--text)' }}>{task.key}</strong> · {task.title}
              </div>
              {task.status && <div style={{ marginTop: 2, fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{task.status}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
