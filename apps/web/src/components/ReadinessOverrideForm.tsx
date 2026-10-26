import { useState } from 'react';
import { api } from '../api';
import { Button } from './ui';

export function ReadinessOverrideForm({ projectId, subjectId, onSaved, onCancel }: {
  projectId: string; subjectId: string; onSaved: () => void | Promise<void>; onCancel: () => void;
}) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <form aria-label="Explicit override" style={{ display: 'grid', gap: 8, padding: 12 }} onSubmit={async e => {
    e.preventDefault(); const data = new FormData(e.currentTarget); setError(''); setBusy(true);
    try {
      const baseId = String(data.get('baseId') ?? '').trim();
      await api.recordReadinessOverride(projectId, { subjectId, scope: data.get('scope') as 'readiness' | 'implementation',
        reason: String(data.get('reason')), durationSeconds: Number(data.get('duration')), ...(baseId ? { baseId, repositoryKey: String(data.get('repositoryKey') || '').trim() || undefined, branch: String(data.get('branch') || '').trim() || undefined } : {}) });
      await onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }}>
    <strong>Explicit exception</strong>
    <span>This records who accepted the risk and why. It expires and stops applying when the task, dependencies, phase context, or assessments change. Plan approval and unfinished dependencies still apply.</span>
    <label>Scope <select name="scope"><option value="readiness">Start work</option><option value="implementation">Complete work</option></select></label>
    <label>Reason <textarea name="reason" required minLength={10} maxLength={2000} /></label>
    <label>Repository (when accepting a revision) <input name="repositoryKey" /></label>
    <label>Branch <input name="branch" /></label>
    <label>Revision accepted (optional) <input name="baseId" /></label>
    <label>Expires in <select name="duration"><option value="3600">1 hour</option><option value="86400">1 day</option></select></label>
    {error && <div role="alert">{error}</div>}
    <div><Button type="submit" disabled={busy}>Record override</Button> <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button></div>
  </form>;
}
