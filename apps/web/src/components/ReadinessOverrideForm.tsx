import { useState, type CSSProperties } from 'react';
import { api } from '../api';
import { Button, ErrorNote, Field, TextArea, TextInput } from './ui';

const controlStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  background: 'var(--w-05)',
  border: '1px solid var(--w-1)',
  borderRadius: 9,
  padding: '9px 12px',
  color: 'var(--text)',
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
};

export function ReadinessOverrideForm({
  projectId,
  subjectId,
  onSaved,
  onCancel,
}: {
  projectId: string;
  subjectId: string;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      aria-label="Explicit override"
      style={{
        display: 'grid',
        gap: 4,
        marginTop: 8,
        padding: '12px 14px',
        border: '1px solid var(--w-08)',
        borderRadius: 10,
        background: 'var(--w-02)',
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError('');
        setBusy(true);
        try {
          const baseId = String(data.get('baseId') ?? '').trim();
          await api.recordReadinessOverride(projectId, {
            subjectId,
            scope: data.get('scope') as 'readiness' | 'implementation',
            reason: String(data.get('reason')),
            durationSeconds: Number(data.get('duration')),
            ...(baseId
              ? {
                  baseId,
                  repositoryKey: String(data.get('repositoryKey') || '').trim() || undefined,
                  branch: String(data.get('branch') || '').trim() || undefined,
                }
              : {}),
          });
          await onSaved();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
        Explicit exception
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 10 }}>
        This records who accepted the risk and why. It expires and stops applying when the task, dependencies,
        phase context, or assessments change. Plan approval and unfinished dependencies still apply.
      </div>

      <Field label="Scope">
        <select name="scope" defaultValue="readiness" style={controlStyle}>
          <option value="readiness">Start work</option>
          <option value="implementation">Complete work</option>
        </select>
      </Field>

      <Field label="Reason">
        <TextArea name="reason" required minLength={10} maxLength={2000} aria-label="Override reason" />
      </Field>

      <Field label="Repository" hint="when accepting a revision">
        <TextInput name="repositoryKey" aria-label="Repository" />
      </Field>
      <Field label="Branch">
        <TextInput name="branch" aria-label="Branch" />
      </Field>
      <Field label="Revision accepted" hint="optional">
        <TextInput name="baseId" aria-label="Revision accepted" />
      </Field>

      <Field label="Expires in">
        <select name="duration" defaultValue="3600" style={controlStyle}>
          <option value="3600">1 hour</option>
          <option value="86400">1 day</option>
        </select>
      </Field>

      {error && <div role="alert" style={{ marginBottom: 10 }}><ErrorNote>{error}</ErrorNote></div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Record override'}</Button>
      </div>
    </form>
  );
}
