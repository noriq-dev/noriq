import { useCallback } from 'react';
import { api } from '../api';
import { AsyncSearchSelect } from './AsyncSearchSelect';

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
  /** When supplied, query each derived status and merge the bounded results. */
  searchStatuses?: string[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
}

/** A reusable task picker that never assumes the current UI snapshot is the full backlog. */
export function TaskSearchSelect({
  projectId,
  boardId = null,
  value,
  onChange,
  initialTasks = [],
  searchStatuses = [],
  label,
  placeholder = 'Search by task key or title…',
  disabled = false,
}: TaskSearchSelectProps) {
  const statusKey = searchStatuses.join('\0');
  const loadOptions = useCallback(async (query: string, signal: AbortSignal) => {
    const statuses = statusKey ? statusKey.split('\0') : [undefined];
    const pages = await Promise.all(statuses.map((status) => api.searchTasks({
      projectId,
      boardId,
      ...(status ? { status } : {}),
      text: query,
      limit: 25,
    }, signal)));
    const unique = new Map<string, TaskSearchOption>();
    for (const page of pages) {
      for (const task of page.tasks) if (!unique.has(task.id)) unique.set(task.id, task);
    }
    return [...unique.values()].slice(0, 25);
  }, [boardId, projectId, statusKey]);

  return (
    <AsyncSearchSelect
      value={value}
      onChange={onChange}
      initialOptions={initialTasks}
      loadOptions={loadOptions}
      optionLabel={(task) => `${task.key} · ${task.title}`}
      renderOption={(task) => (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <strong style={{ color: 'var(--text)' }}>{task.key}</strong> · {task.title}
          </div>
          {task.status && <div style={{ marginTop: 2, fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{task.status}</div>}
        </>
      )}
      label={label}
      placeholder={placeholder}
      emptyMessage="No matching tasks."
      disabled={disabled}
    />
  );
}
