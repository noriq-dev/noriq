// Invite acceptance — passkey-first onboarding.
import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api';
import { Button, ErrorNote, Field, TextInput } from './ui';

export function Invite({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ name: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<'loading' | 'choose' | 'password' | 'accepted'>('loading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.inviteInfo(token)
      .then((r) => {
        setInfo(r);
        setStage('choose');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'invalid invite'));
  }, [token]);

  const acceptWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      // Token proves identity → session; then enroll the passkey on that session.
      await api.acceptInvite(token);
      const options = await api.registerOptions();
      const response = await startRegistration({ optionsJSON: options as never });
      await api.registerVerify(response, 'onboarding passkey');
      setStage('accepted');
      setTimeout(onDone, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'passkey setup failed — you can use a password instead');
    } finally {
      setBusy(false);
    }
  };

  const acceptWithPassword = async () => {
    if (password.length < 8 || password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api.acceptInvite(token, password);
      setStage('accepted');
      setTimeout(onDone, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ width: 400, padding: 30, background: 'var(--bg-raised)', border: '1px solid var(--line)', borderRadius: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 14, height: 14, background: 'var(--bg)', transform: 'rotate(45deg)' }} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>Join planar</div>
        </div>

        {stage === 'loading' && !error && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>checking invite…</div>
        )}

        {stage === 'accepted' && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--green)' }}>✓ account ready — entering…</div>
        )}

        {info && stage === 'choose' && (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6, marginBottom: 20 }}>
              Welcome, <b style={{ color: 'var(--text)' }}>{info.name}</b> ({info.email}). Choose how you'll sign in:
            </div>
            <Button disabled={busy} onClick={acceptWithPasskey} style={{ width: '100%', boxSizing: 'border-box', padding: 12, marginBottom: 10 }}>
              🔑 Create a passkey (recommended)
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setStage('password')} style={{ width: '100%', boxSizing: 'border-box', padding: 12 }}>
              Use a password instead
            </Button>
          </>
        )}

        {info && stage === 'password' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Password" hint="8+ chars">
                <TextInput autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Field label="Confirm">
                <TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && acceptWithPassword()} />
              </Field>
            </div>
            {password && confirm && password !== confirm && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--red-soft)', marginBottom: 10 }}>passwords don't match</div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="ghost" onClick={() => setStage('choose')}>back</Button>
              <div style={{ flex: 1 }} />
              <Button disabled={busy || password.length < 8 || password !== confirm} onClick={acceptWithPassword}>
                Create account
              </Button>
            </div>
          </>
        )}

        <ErrorNote>{error}</ErrorNote>
      </div>
    </div>
  );
}
