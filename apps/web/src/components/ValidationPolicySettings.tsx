import { useEffect, useState } from 'react';
import { api } from '../api';
import { MonoTag, SectionLabel } from './bits';
import { Button, ErrorNote, Field, TextArea } from './ui';

/**
 * Project validation policy (PLNR-620). Styled to match ProjectSettingsView
 * SettingsSection chrome — not a bare HTML island.
 */
export function ValidationPolicySettings({
  projectId,
  canContribute,
}: {
  projectId: string;
  canContribute: boolean;
}) {
  const [mode, setMode] = useState<'legacy' | 'strict' | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setMode(null);
    setError(null);
    setMessage('');
    api.validationPolicy(projectId)
      .then((policy) => { if (live) setMode(policy.mode); })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [projectId]);

  const strict = mode === 'strict';

  return (
    <section
      aria-label="Validation policy"
      style={{ border: '1px solid var(--w-07)', borderRadius: 14, background: 'var(--w-015)', padding: '18px 20px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
        <SectionLabel>Validation policy</SectionLabel>
        <div style={{ flex: 1 }} />
        {mode && (
          <MonoTag
            color={strict ? 'var(--amber)' : 'var(--text-dim)'}
            bg={strict ? 'rgba(245,166,35,.12)' : 'var(--w-06)'}
            size={9}
          >
            {strict ? 'STRICT' : 'LEGACY'}
          </MonoTag>
        )}
      </div>
      <div style={{ margin: '0 0 16px', color: 'var(--text-mid)', fontSize: 11.5, lineHeight: 1.55 }}>
        Strict mode requires readiness before work and separate implementation evidence before completion.
        Unverified backlog creation remains available. Enabling strict releases all agent claims and task locks;
        holders must stop, reassess, and reclaim. Disabling preserves independently required plan evidence.
      </div>

      {mode == null && !error && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>Loading policy…</div>
      )}

      {mode && (
        <div style={{ fontSize: 12.5, color: 'var(--text-soft)', marginBottom: canContribute ? 14 : 0, lineHeight: 1.45 }}>
          Current policy: <b style={{ color: 'var(--text)' }}>{mode}</b>
          {strict
            ? ' — readiness and implementation evidence are enforced.'
            : ' — legacy attestation rules apply.'}
        </div>
      )}

      {canContribute && mode && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage('');
            setError(null);
            try {
              const result = await api.setValidationPolicy(
                projectId,
                mode === 'strict' ? 'legacy' : 'strict',
                reason,
              );
              setMode(result.mode);
              setReason('');
              const released = result.releasedTaskIds.length
                ? `: ${result.releasedTaskIds.join(', ')}`
                : '';
              setMessage(`Policy saved. Released ${result.releasedTaskIds.length} claims${released}.`);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Reason for changing policy" hint="required · min 10 characters">
            <TextArea
              aria-label="Reason for changing policy"
              required
              minLength={10}
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this project switching policy mode?"
            />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
            <ErrorNote>{error}</ErrorNote>
            <Button type="submit" disabled={busy || reason.trim().length < 10}>
              {busy ? 'Saving…' : strict ? 'Use legacy policy' : 'Enable strict policy'}
            </Button>
          </div>
        </form>
      )}

      {!canContribute && error && <ErrorNote>{error}</ErrorNote>}
      {message && (
        <div role="status" style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--green)', marginTop: 12, lineHeight: 1.5 }}>
          {message}
        </div>
      )}
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', marginTop: 14, lineHeight: 1.55 }}>
        Evidence is actor-reported. Noriq checks recorded context and workflow compliance; it does not establish whether a cited test proves its claim.
      </div>
    </section>
  );
}
