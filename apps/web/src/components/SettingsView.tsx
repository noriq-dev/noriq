// Settings — user management (admin), group management, own password.
import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api, type ApiUser } from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { Button, ErrorNote, Field, Select, TextInput } from './ui';

export function SettingsView({ store }: { store: AppStore }) {
  // User management moved to the Admin menu (PLNR-83) — Settings is user-level only.
  return (
    <div className="content-pad" style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '20px 26px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
        <PasskeysSection />
        <SessionsSection />
        <PasswordSection />
      </div>
    </div>
  );
}

export function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--w-07)', borderRadius: 14, background: 'var(--w-015)', padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <SectionLabel>{title}</SectionLabel>
        <div style={{ flex: 1 }} />
        {action}
      </div>
      {children}
    </div>
  );
}

export function UsersSection({ store }: { store: AppStore }) {
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tempReveal, setTempReveal] = useState<{ name: string; temp: string } | null>(null);
  const [inviteLink, setInviteLink] = useState<{ name: string; url: string } | null>(null);
  const [editGroupsFor, setEditGroupsFor] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const load = () => api.users().then((r) => setUsers(r.users)).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const me = store.user?.id;
  const toggleGroup = (gid: string) =>
    setGroupIds((ids) => (ids.includes(gid) ? ids.filter((x) => x !== gid) : [...ids, gid]));

  return (
    <Section
      title={`Users · ${users.length}`}
      action={<Button variant="ghost" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={() => setAdding(!adding)}>{adding ? 'cancel' : '+ invite user'}</Button>}
    >
      {adding && (
        <div style={{ border: '1px solid var(--w-08)', borderRadius: 10, padding: 14, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Email"><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Role">
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="member">member</option>
                <option value="admin">admin</option>
              </Select>
            </Field>
            <Field label="Groups" hint="membership">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4 }}>
                {store.groups.length === 0 && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>none defined</span>}
                {store.groups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => toggleGroup(g.id)}
                    style={{
                      cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, padding: '3px 9px', borderRadius: 6,
                      background: groupIds.includes(g.id) ? 'rgba(198,242,78,.12)' : 'var(--w-04)',
                      color: groupIds.includes(g.id) ? 'var(--accent)' : 'var(--text-mid)',
                      border: `1px solid ${groupIds.includes(g.id) ? 'rgba(198,242,78,.35)' : 'var(--w-1)'}`,
                    }}
                  >
                    {g.name}
                  </button>
                ))}
              </div>
            </Field>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 10 }}>
            They'll receive a verification email to create their account (passkey preferred). If email isn't
            configured on this instance, you'll get a link to send them yourself.
          </div>
          <ErrorNote>{error}</ErrorNote>
          <Button
            disabled={inviting || !name.trim() || !/\S+@\S+/.test(email)}
            onClick={async () => {
              setError(null);
              setInviting(true);
              try {
                const r = await api.invite(email.trim(), name.trim(), role, groupIds);
                if (!r.emailed && r.inviteUrl) setInviteLink({ name: name.trim(), url: r.inviteUrl });
                setAdding(false);
                setEmail(''); setName(''); setGroupIds([]);
                load();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setInviting(false);
              }
            }}
          >
            {inviting ? 'Sending invite…' : 'Send invite'}
          </Button>
        </div>
      )}

      {inviteLink && (
        <div
          onClick={async () => { await navigator.clipboard.writeText(inviteLink.url); }}
          title="click to copy"
          style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--accent-ink)', background: 'rgba(198,242,78,.06)', border: '1px solid rgba(198,242,78,.25)', borderRadius: 9, padding: '9px 12px', marginBottom: 12, cursor: 'pointer', wordBreak: 'break-all' }}
        >
          email not configured — send {inviteLink.name} this link (click to copy): {inviteLink.url}
        </div>
      )}

      {tempReveal && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent-ink)', background: 'rgba(198,242,78,.06)', border: '1px solid rgba(198,242,78,.25)', borderRadius: 9, padding: '9px 12px', marginBottom: 12 }}>
          temp password for {tempReveal.name}: <b>{tempReveal.temp}</b> — shown once
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {users.map((u) => (
          <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 9, background: 'var(--w-02)', border: '1px solid var(--w-06)', opacity: u.disabled ? 0.5 : 1 }}>
            <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg,#c6f24e,#3fd98b)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--bg)', fontWeight: 700 }}>
              {u.name.slice(0, 1).toUpperCase()}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                {u.name} {u.id === me && <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-dim)' }}>(you)</span>}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                {u.email} · {u.ownedProjects} project{u.ownedProjects === 1 ? '' : 's'}
              </div>
            </div>
            <MonoTag color={u.role === 'admin' ? 'var(--accent)' : 'var(--text-mid)'} bg={u.role === 'admin' ? 'rgba(198,242,78,.12)' : 'var(--w-06)'} size={9.5}>{u.role}</MonoTag>
            {u.pending ? <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>PENDING</MonoTag> : null}
            {u.passkeys > 0 ? <MonoTag color="var(--green)" bg="rgba(63,217,139,.1)" size={9.5}>🔑 {u.passkeys}</MonoTag> : null}
            {u.disabled ? <MonoTag color="var(--red-soft)" bg="rgba(255,92,92,.12)" size={9.5}>DISABLED</MonoTag> : null}
            {u.id !== me && (
              <div style={{ display: 'flex', gap: 6 }}>
                <SmallAction onClick={async () => { await api.patchUser(u.id, { role: u.role === 'admin' ? 'member' : 'admin' }); load(); }}>
                  {u.role === 'admin' ? 'demote' : 'promote'}
                </SmallAction>
                <SmallAction onClick={async () => { const r = await api.resetPassword(u.id); setTempReveal({ name: u.name, temp: r.tempPassword }); }}>
                  reset pw
                </SmallAction>
                <SmallAction onClick={() => setEditGroupsFor(editGroupsFor === u.id ? null : u.id)}>groups</SmallAction>
                <SmallAction danger onClick={async () => { await api.patchUser(u.id, { disabled: !u.disabled }); load(); }}>
                  {u.disabled ? 'enable' : 'disable'}
                </SmallAction>
                {u.disabled ? (
                  <SmallAction
                    danger
                    onClick={async () => {
                      if (confirm(`Permanently delete ${u.name}? Their sessions, passkeys, invites and tokens are removed; owned projects become unowned. History keeps their name.`)) {
                        await api.deleteUser(u.id);
                        load();
                      }
                    }}
                  >
                    delete
                  </SmallAction>
                ) : null}
              </div>
            )}
            {editGroupsFor === u.id && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {store.groups.map((g) => {
                  const memberOf = (u.groupIds ?? '').split(',').includes(g.id);
                  return (
                    <button
                      key={g.id}
                      onClick={async () => {
                        const current = (u.groupIds ?? '').split(',').filter(Boolean);
                        const next = memberOf ? current.filter((x) => x !== g.id) : [...current, g.id];
                        await api.setUserGroups(u.id, next);
                        load();
                      }}
                      style={{
                        cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9.5, padding: '2px 8px', borderRadius: 6,
                        background: memberOf ? 'rgba(198,242,78,.12)' : 'var(--w-04)',
                        color: memberOf ? 'var(--accent)' : 'var(--text-mid)',
                        border: `1px solid ${memberOf ? 'rgba(198,242,78,.35)' : 'var(--w-1)'}`,
                      }}
                    >
                      {g.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

export function GroupsSection({ store }: { store: AppStore }) {
  const groups = store.groups;
  return (
    <Section
      title={`Groups · ${groups.length}`}
      action={<Button variant="ghost" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={() => store.actions.openModal('group')}>+ new group</Button>}
    >
      {groups.length === 0 && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>no groups — projects are ungrouped</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {groups.map((g) => {
          const count = store.data.projects.filter((p) => p.groupId === g.id).length;
          return (
            <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 9, background: 'var(--w-02)', border: '1px solid var(--w-06)' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{g.name}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>{count} project{count === 1 ? '' : 's'}{g.description ? ` · ${g.description}` : ''}</div>
              </div>
              {/* Only group members (or admins) may rename/delete — PLNR-81. */}
              {g.canEdit ? (
                <>
                  <SmallAction
                    onClick={async () => {
                      const name = window.prompt('Rename group:', g.name)?.trim();
                      if (name && name !== g.name) {
                        await api.patchGroup(g.id, { name });
                        location.reload();
                      }
                    }}
                  >
                    rename
                  </SmallAction>
                  <SmallAction
                    danger
                    onClick={async () => {
                      if (window.confirm(`Delete group "${g.name}"? Projects become ungrouped.`)) {
                        await api.deleteGroup(g.id);
                        location.reload();
                      }
                    }}
                  >
                    delete
                  </SmallAction>
                </>
              ) : (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>member-only</span>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function PasskeysSection() {
  const [passkeys, setPasskeys] = useState<Array<{ id: string; name: string; createdAt: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.passkeys().then((r) => setPasskeys(r.passkeys)).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    setError(null);
    try {
      const options = await api.registerOptions();
      const response = await startRegistration({ optionsJSON: options as never });
      await api.registerVerify(response);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Section
      title={`Your passkeys · ${passkeys.length}`}
      action={<Button variant="ghost" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={add}>+ add passkey</Button>}
    >
      {passkeys.length === 0 && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
          no passkeys — add one to sign in without a password
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {passkeys.map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 11px', borderRadius: 9, background: 'var(--w-02)', border: '1px solid var(--w-06)' }}>
            <span style={{ fontSize: 13 }}>🔑</span>
            <div style={{ flex: 1, fontSize: 12.5, fontWeight: 500 }}>{p.name}</div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>{new Date(p.createdAt).toLocaleDateString()}</span>
            <SmallAction danger onClick={async () => { await api.deletePasskey(p.id); load(); }}>remove</SmallAction>
          </div>
        ))}
      </div>
      <ErrorNote>{error}</ErrorNote>
    </Section>
  );
}

function SessionsSection() {
  const [sessions, setSessions] = useState<Array<{ id: string; clientName: string; createdAt: string; agentCount: number; lastActive: string | null }>>([]);
  const load = () => api.authSessions().then((r) => setSessions(r.sessions)).catch(() => {});
  useEffect(() => { load(); }, []);
  const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

  return (
    <Section
      title={`Agent connections · ${sessions.length}`}
      action={
        sessions.length > 0 ? (
          <SmallAction danger onClick={async () => {
            if (confirm('Revoke ALL agent connections? Every Claude/Codex/Copilot session using this account will need to reconnect via OAuth.')) {
              await api.revokeAllSessions();
              load();
            }
          }}>revoke all</SmallAction>
        ) : undefined
      }
    >
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', marginBottom: 8 }}>
        Each is one OAuth authorization (a `claude mcp add`). Revoking forces that client to reconnect. Individual agents (chats / sub-agents) live under a connection.
      </div>
      {sessions.length === 0 && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
          no active connections — connect an agent from the homepage
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sessions.map((s) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 11px', borderRadius: 9, background: 'var(--w-02)', border: '1px solid var(--w-06)' }}>
            <span style={{ fontSize: 13 }}>🔌</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{s.clientName}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>
                {s.agentCount} agent{s.agentCount === 1 ? '' : 's'} · last active {ago(s.lastActive)}
              </div>
            </div>
            <SmallAction danger onClick={async () => { await api.revokeSession(s.id); load(); }}>revoke</SmallAction>
          </div>
        ))}
      </div>
    </Section>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const valid = current && next.length >= 8 && next === confirm;
  return (
    <Section title="Your password">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <Field label="Current"><TextInput type="password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New" hint="8+ chars"><TextInput type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Confirm"><TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      </div>
      {msg && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: msg.ok ? 'var(--green)' : 'var(--red-soft)', marginBottom: 10 }}>{msg.text}</div>
      )}
      <Button
        disabled={!valid}
        onClick={async () => {
          try {
            await api.changePassword(current, next);
            setMsg({ ok: true, text: 'password changed' });
            setCurrent(''); setNext(''); setConfirm('');
          } catch (e) {
            setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
          }
        }}
      >
        Change password
      </Button>
    </Section>
  );
}

function SmallAction({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, color: danger ? 'var(--red-soft)' : 'var(--text-mid)', border: `1px solid ${danger ? 'rgba(255,92,92,.3)' : 'var(--w-12)'}`, padding: '3px 9px', borderRadius: 6, background: 'transparent' }}
    >
      {children}
    </button>
  );
}
