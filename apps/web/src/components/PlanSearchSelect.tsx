import { useCallback } from 'react';
import { api } from '../api';
import { AsyncSearchSelect } from './AsyncSearchSelect';

export interface PlanSearchOption {
  id: string;
  title: string;
  description?: string;
  status?: string;
}

interface PlanSearchSelectProps {
  projectId: string;
  value: string;
  onChange: (planId: string) => void;
  initialPlans?: PlanSearchOption[];
  status?: string;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}

/** Server-backed plan picker for surfaces that deliberately carry no plan inventory. */
export function PlanSearchSelect({
  projectId,
  value,
  onChange,
  initialPlans = [],
  status,
  label,
  placeholder = 'Search plans by title or description…',
  disabled = false,
}: PlanSearchSelectProps) {
  const loadOptions = useCallback(async (query: string, signal: AbortSignal) => {
    const { plans } = await api.searchPlans({ projectId, status, text: query, limit: 25 }, signal);
    return plans;
  }, [projectId, status]);

  return (
    <AsyncSearchSelect
      value={value}
      onChange={onChange}
      initialOptions={initialPlans}
      loadOptions={loadOptions}
      optionLabel={(plan) => plan.title}
      renderOption={(plan) => (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {plan.title}
          </div>
          {(plan.description || plan.status) && (
            <div style={{ marginTop: 2, fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[plan.status, plan.description].filter(Boolean).join(' · ')}
            </div>
          )}
        </>
      )}
      label={label}
      placeholder={placeholder}
      emptyMessage="No matching plans."
      disabled={disabled}
    />
  );
}
