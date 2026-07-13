import { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from '../api';
import type { AppStore } from '../store';

export function Login({ store }: { store: AppStore }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    background: 'rgba(255,255,255,.05)',
    border: '1px solid rgba(255,255,255,.1)',
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
          <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 14, height: 14, background: 'var(--bg)', transform: 'rotate(45deg)' }} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-.01em' }}>planar</div>
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
            <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.08)' }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>or</span>
            <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.08)' }} />
          </div>
          <button
            onClick={passkeySignIn}
            className="hover-bright"
            style={{
              cursor: 'pointer', textAlign: 'center', background: 'rgba(255,255,255,.05)',
              color: 'var(--text)', border: '1px solid rgba(255,255,255,.12)', fontWeight: 600,
              fontSize: 13, padding: 11, borderRadius: 9, opacity: busy ? 0.6 : 1,
            }}
          >
            🔑 Sign in with a passkey
          </button>
        </div>
      </div>
    </div>
  );
}
