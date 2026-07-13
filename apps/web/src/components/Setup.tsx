// First-run self-install: create the founding admin account.
import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api';
import type { AppStore } from '../store';
import { Button, ErrorNote, Field, TextInput } from './ui';

export function Setup({ store }: { store: AppStore }) {
  const [stage, setStage] = useState<'account' | 'passkey'>('account');
  const [done, setDone] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = name.trim() && /\S+@\S+/.test(email) && password.length >= 8 && password === confirm;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await store.actions.completeSetupDeferred(email.trim(), name.trim(), password);
      setStage('passkey');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'setup failed');
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'passkey') {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ width: 400, padding: 30, background: 'var(--bg-raised)', border: '1px solid var(--line)', borderRadius: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 10 }}>One more thing 🔑</div>
          <div style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6, marginBottom: 20 }}>
            Add a <b style={{ color: 'var(--text)' }}>passkey</b> — sign in with your fingerprint, face, or security
            key instead of the password. Recommended.
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button
            disabled={busy || done}
            style={{ width: '100%', boxSizing: 'border-box', padding: 12, marginBottom: 10 }}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const options = await api.registerOptions();
                const response = await startRegistration({ optionsJSON: options as never });
                await api.registerVerify(response, 'setup passkey');
                setDone(true);
                setTimeout(() => store.actions.finishSetup(), 700);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'passkey setup failed — you can add one later in Settings');
              } finally {
                setBusy(false);
              }
            }}
          >
            {done ? '✓ passkey added' : busy ? 'waiting for authenticator…' : 'Create passkey'}
          </Button>
          <Button variant="ghost" style={{ width: '100%', boxSizing: 'border-box', padding: 12 }} onClick={() => store.actions.finishSetup()}>
            Skip for now
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ width: 400, padding: 30, background: 'var(--bg-raised)', border: '1px solid var(--line)', borderRadius: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 8 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 14, height: 14, background: 'var(--bg)', transform: 'rotate(45deg)' }} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-.01em' }}>Welcome to planar</div>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-mid)', lineHeight: 1.6, marginBottom: 20 }}>
          This instance isn't configured yet. Create the founding <b style={{ color: 'var(--text)' }}>admin account</b> —
          you'll use it to sign in, invite teammates, and supervise projects.
        </div>
        <Field label="Your name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Montana" />
        </Field>
        <Field label="Email">
          <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Password" hint="8+ chars">
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm">
            <TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>
        </div>
        {password && confirm && password !== confirm && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--red-soft)', marginBottom: 10 }}>passwords don't match</div>
        )}
        <ErrorNote>{error}</ErrorNote>
        <Button disabled={!valid || busy} onClick={submit} style={{ width: '100%', boxSizing: 'border-box', padding: 12 }}>
          {busy ? 'setting up…' : 'Create account & enter'}
        </Button>
        <div style={{ marginTop: 14, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.7 }}>
          next: connect Claude Code to /mcp (OAuth — no keys); the connect card on the homepage has the exact command.
        </div>
      </div>
    </div>
  );
}
