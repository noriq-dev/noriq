import { useEffect, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from '../api';
import type { AppStore } from '../store';
import { Logo } from './Logo';

export function Login({ store }: { store: AppStore }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  // Demo mode (PLNR-146): the server says whether one-click demo login exists here.
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    fetch('/api/demo/status').then((r) => r.json()).then((d: { enabled: boolean }) => setDemo(!!d.enabled)).catch(() => {});
  }, []);
  const demoLogin = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/demo/login', { method: 'POST', credentials: 'same-origin' });
      if (r.ok) location.reload();
      else setError('demo unavailable right now');
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    if (!email.trim()) { setError('enter your email above, then tap “Forgot password?”'); return; }
    setError(null);
    try { await api.forgotPassword(email.trim()); } catch { /* uniform — never reveal existence */ }
    setResetSent(true);
  };

  const passkeySignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await api.loginOptions();
      const response = await startAuthentication({ optionsJSON: options as never });
      await api.loginVerify(response);
      location.reload(); // pick up the fresh session everywhere
    } catch (e) {
      setError(e instanceof Error ? e.message : 'passkey sign-in failed');
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await store.actions.login(email, password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'login failed');
    } finally {
      setBusy(false);
    }
  };

  const field = {
    boxSizing: 'border-box' as const,
    width: '100%',
    background: 'var(--w-05)',
    border: '1px solid var(--w-1)',
    borderRadius: 9,
    padding: '10px 12px',
    color: 'var(--text)',
    fontSize: 13.5,
    outline: 'none',
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ width: 340, padding: 28, background: 'var(--bg-raised)', border: '1px solid var(--line)', borderRadius: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 22 }}>
          <Logo size={34} radius={9} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-.01em' }}>Noriq</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>mission control</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input style={field} type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            style={field}
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -4 }}>
            <button
              onClick={forgot}
              style={{ cursor: 'pointer', background: 'transparent', border: 'none', padding: 0, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}
              className="hover-bright"
            >
              Forgot password?
            </button>
          </div>
          {resetSent && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--accent-ink)', background: 'rgba(198,242,78,.06)', border: '1px solid rgba(198,242,78,.25)', borderRadius: 8, padding: '8px 11px', lineHeight: 1.5 }}>
              If an account exists for <b>{email.trim()}</b>, a reset link is on its way. It expires in 1 hour.
            </div>
          )}
          {error && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red-soft)' }}>{error}</div>}
          <button
            onClick={submit}
            className="hover-bright"
            style={{
              cursor: 'pointer',
              textAlign: 'center',
              background: 'var(--accent)',
              color: 'var(--bg)',
              fontWeight: 600,
              fontSize: 13.5,
              padding: 11,
              borderRadius: 9,
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'signing in…' : 'Sign in'}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0' }}>
            <span style={{ flex: 1, height: 1, background: 'var(--w-08)' }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>or</span>
            <span style={{ flex: 1, height: 1, background: 'var(--w-08)' }} />
          </div>
          <button
            onClick={passkeySignIn}
            className="hover-bright"
            style={{
              cursor: 'pointer', textAlign: 'center', background: 'var(--w-05)',
              color: 'var(--text)', border: '1px solid var(--w-12)', fontWeight: 600,
              fontSize: 13, padding: 11, borderRadius: 9, opacity: busy ? 0.6 : 1,
            }}
          >
            🔑 Sign in with a passkey
          </button>
          {demo && (
            <button
              onClick={demoLogin}
              className="hover-bright"
              style={{
                cursor: 'pointer', textAlign: 'center', background: 'rgba(198,242,78,.08)',
                color: 'var(--accent-ink)', border: '1px solid rgba(198,242,78,.35)', fontWeight: 600,
                fontSize: 13, padding: 11, borderRadius: 9, opacity: busy ? 0.6 : 1,
              }}
            >
              ▶ Try the demo — no account needed
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
