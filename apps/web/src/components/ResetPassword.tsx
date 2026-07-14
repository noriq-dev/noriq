// Password reset via emailed link (PLNR-87). Validates the token, takes a new
// password, and signs the user in on success.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, ErrorNote, Field, TextInput } from './ui';
import { Logo } from './Logo';

export function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ email: string; name: string } | null>(null);
  const [stage, setStage] = useState<'loading' | 'form' | 'done'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.resetInfo(token)
      .then((r) => { setInfo(r); setStage('form'); })
      .catch((e) => setError(e instanceof Error ? e.message : 'invalid reset link'));
  }, [token]);

  const submit = async () => {
    setError(null);
    if (password.length < 8) { setError('password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('passwords do not match'); return; }
    setBusy(true);
    try {
      await api.submitReset(token, password);
      setStage('done');
      setTimeout(onDone, 900); // signed in — land in the app
    } catch (e) {
      setError(e instanceof Error ? e.message : 'reset failed');
      setBusy(false);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ width: 400, padding: 30, background: 'var(--bg-raised)', border: '1px solid var(--line)', borderRadius: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <Logo size={34} radius={9} />
          <div style={{ fontWeight: 700, fontSize: 18 }}>Reset password</div>
        </div>

        {stage === 'loading' && !error && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>checking link…</div>
        )}

        {error && stage !== 'form' && (
          <>
            <ErrorNote>{error}</ErrorNote>
            <div style={{ marginTop: 14 }}>
              <Button variant="ghost" onClick={onDone}>Back to sign in</Button>
            </div>
          </>
        )}

        {stage === 'form' && info && (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text-mid)', lineHeight: 1.6, marginBottom: 18 }}>
              Setting a new password for <b style={{ color: 'var(--text)' }}>{info.email}</b>.
            </div>
            <Field label="New password">
              <TextInput autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8+ characters" />
            </Field>
            <Field label="Confirm password">
              <TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
            </Field>
            <ErrorNote>{error}</ErrorNote>
            <div style={{ marginTop: 8 }}>
              <Button disabled={busy || !password || !confirm} onClick={submit}>{busy ? 'Saving…' : 'Set password & sign in'}</Button>
            </div>
          </>
        )}

        {stage === 'done' && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--accent-ink)' }}>password updated — signing you in…</div>
        )}
      </div>
    </div>
  );
}
