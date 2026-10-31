import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorNote, Field, TextArea } from './ui';

export function DirectionMarkerAction({
  projectId,
  taskId,
  sourceType,
  sourceId,
}: {
  projectId: string;
  taskId: string;
  sourceType: 'comment' | 'signal';
  sourceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div style={{ marginTop: 8 }}>
      {!open && (
        <Button variant="ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setOpen(true)}>
          Mark changed direction
        </Button>
      )}
      {open && (
        <form
          style={{
            display: 'grid',
            gap: 10,
            marginTop: 8,
            padding: '12px 14px',
            border: '1px solid var(--w-08)',
            borderRadius: 10,
            background: 'var(--w-02)',
          }}
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api.markChangedDirection(projectId, { taskId, sourceType, sourceId, reason });
              setMessage('Direction marked. Stop implementation; reconcile readiness and reclaim before resuming.');
              setOpen(false);
              setReason('');
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="What changed?" hint="releases claim and locks">
            <TextArea
              aria-label="What changed?"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              minLength={10}
              maxLength={2000}
            />
          </Field>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            This releases the current agent claim and task locks. Resolving the comment alone does not clear this marker.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <ErrorNote>{error}</ErrorNote>
            <div style={{ flex: 1 }} />
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || reason.trim().length < 10}>
              {busy ? 'Marking…' : 'Mark direction and release claim'}
            </Button>
          </div>
        </form>
      )}
      {message && (
        <div role="status" style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--amber)', marginTop: 8, lineHeight: 1.5 }}>
          {message}
        </div>
      )}
    </div>
  );
}
