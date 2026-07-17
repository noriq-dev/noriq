// Admin menu (PLNR-83) — the admin-wide surface, separate from personal Settings.
// A table overview of every project (admins default to their own elsewhere) plus
// user management, moved out of Settings.
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppStore } from '../store';
import { LiveDot, MonoTag } from './bits';
import { GroupsSection, Section, UsersSection } from './SettingsView';
import { confirm } from './Dialog';

export function AdminView({ store }: { store: AppStore }) {
  useEffect(() => {
    void store.actions.refreshAdmin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const projects = store.adminProjects;
  const groupName = new Map(store.groups.map((g) => [g.id, g.name]));

  return (
    <div className="content-pad" style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '20px 26px' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-.01em' }}>Admin</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-mid)', marginTop: 4 }}>
            Instance-wide view. Your own projects live in the sidebar; this is everything.
          </div>
        </div>

        <Section title={`All projects · ${projects.length}`}>
          {projects.length === 0 ? (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>no active projects</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                    <Th>Key</Th><Th>Project</Th><Th>Owner</Th><Th>Group</Th><Th right>Open</Th><Th right>Done/Total</Th><Th right>Agents</Th><Th />
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => store.actions.selectProject(p.id)}
                      className="hover-bright"
                      style={{ cursor: 'pointer', borderTop: '1px solid var(--w-05)' }}
                    >
                      <Td><span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent-ink)' }}>{p.key}</span></Td>
                      <Td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                          {p.hasLive && <LiveDot />}
                          <span style={{ fontWeight: 600 }}>{p.name}</span>
                        </span>
                      </Td>
                      <Td><span style={{ color: p.ownerName ? 'var(--text-mid)' : 'var(--text-faint)' }}>{p.ownerName ?? '— shared —'}</span></Td>
                      <Td><span style={{ color: 'var(--text-dim)' }}>{p.groupId ? groupName.get(p.groupId) ?? '—' : '—'}</span></Td>
                      <Td right><span style={{ fontFamily: 'var(--mono)' }}>{p.openTasks}</span></Td>
                      <Td right><span style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>{p.doneTasks}/{p.totalTasks}</span></Td>
                      <Td right><span style={{ fontFamily: 'var(--mono)', color: (p.agentCount ?? 0) > 0 ? 'var(--accent-ink)' : 'var(--text-faint)' }}>{p.agentCount ?? 0}</span></Td>
                      <Td right><span style={{ color: 'var(--text-faint)', fontSize: 14 }}>›</span></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <OAuthSection />

        <UsersSection store={store} />
        <GroupsSection store={store} all />
      </div>
    </div>
  );
}

/** Admin OAuth management (PLNR-160): every live connection instance-wide, revocable,
 *  plus the registered clients with cleanup for stale registrations. */
function OAuthSection() {
  const [connections, setConnections] = useState<Awaited<ReturnType<typeof api.adminConnections>>['connections']>([]);
  const [clients, setClients] = useState<Awaited<ReturnType<typeof api.adminClients>>['clients']>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    api.adminConnections().then((r) => setConnections(r.connections)).catch(() => {});
    api.adminClients().then((r) => setClients(r.clients)).catch(() => {});
  };
  useEffect(load, []);

  const scopeOf = (c: (typeof connections)[number]) =>
    c.bound ? 'run-bound' : c.scopeAll ? 'all projects' : c.scoped ? (c.projectKeys ?? 'none') : 'unscoped (legacy)';

  return (
    <>
      <Section title={`OAuth connections · ${connections.length}`}>
        {connections.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>no live connections</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  <Th>User</Th><Th>Client</Th><Th>Reaches</Th><Th right>Agents</Th><Th>Last active</Th><Th>Expires</Th><Th />
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--w-05)' }}>
                    <Td>
                      <span style={{ fontWeight: 600 }}>{c.userName ?? '—'}</span>{' '}
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>{c.userEmail ?? ''}</span>
                    </Td>
                    <Td>{c.clientName}</Td>
                    <Td>
                      <MonoTag
                        color={c.bound ? 'var(--blue)' : c.scopeAll ? 'var(--amber)' : c.scoped ? 'var(--text-mid)' : 'var(--red-soft)'}
                        bg="var(--w-04)" size={9.5}
                      >
                        {scopeOf(c)}
                      </MonoTag>
                    </Td>
                    <Td right><span style={{ fontFamily: 'var(--mono)' }}>{c.agentCount}</span></Td>
                    <Td><span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>{c.lastActive ? new Date(c.lastActive).toLocaleString() : 'never'}</span></Td>
                    <Td><span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>{new Date(c.expiresAt).toLocaleDateString()}</span></Td>
                    <Td right>
                      <button
                        onClick={async () => {
                          if (await confirm(`Revoke ${c.userName ?? 'this user'}'s ${c.clientName} connection? Its agents go offline.`)) {
                            await api.adminRevokeConnection(c.id);
                            load();
                          }
                        }}
                        style={{ cursor: 'pointer', fontSize: 11, color: 'var(--red-soft)', background: 'rgba(255,92,92,.08)', border: '1px solid rgba(255,92,92,.3)', borderRadius: 6, padding: '3px 10px' }}
                      >
                        revoke
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={`OAuth clients · ${clients.length}`}>
        {error && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--red-soft)', marginBottom: 8 }}>{error}</div>}
        {clients.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>no registered clients</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  <Th>Client</Th><Th>Id</Th><Th right>Live connections</Th><Th>Registered</Th><Th />
                </tr>
              </thead>
              <tbody>
                {clients.map((cl) => (
                  <tr key={cl.id} style={{ borderTop: '1px solid var(--w-05)' }}>
                    <Td><span style={{ fontWeight: 600 }}>{cl.name}</span></Td>
                    <Td><span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>{cl.id.length > 34 ? `${cl.id.slice(0, 34)}…` : cl.id}</span></Td>
                    <Td right><span style={{ fontFamily: 'var(--mono)', color: cl.liveTokens > 0 ? 'var(--accent-ink)' : 'var(--text-faint)' }}>{cl.liveTokens}</span></Td>
                    <Td><span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>{new Date(cl.createdAt).toLocaleDateString()}</span></Td>
                    <Td right>
                      <button
                        disabled={cl.liveTokens > 0}
                        title={cl.liveTokens > 0 ? 'revoke its live connections first' : 'delete this client registration'}
                        onClick={async () => {
                          if (!(await confirm(`Delete client "${cl.name}"? Historical tokens are removed; agents survive.`))) return;
                          setError(null);
                          try {
                            await api.adminDeleteClient(cl.id);
                          } catch (e) {
                            setError(e instanceof Error ? e.message : 'delete failed');
                          }
                          load();
                        }}
                        style={{
                          cursor: cl.liveTokens > 0 ? 'default' : 'pointer', fontSize: 11,
                          color: cl.liveTokens > 0 ? 'var(--text-faint)' : 'var(--red-soft)',
                          background: 'transparent', border: '1px solid var(--w-1)', borderRadius: 6, padding: '3px 10px',
                          opacity: cl.liveTokens > 0 ? 0.5 : 1,
                        }}
                      >
                        delete
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th style={{ padding: '4px 10px 8px', textAlign: right ? 'right' : 'left', fontWeight: 500, whiteSpace: 'nowrap' }}>{children}</th>;
}
function Td({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <td style={{ padding: '9px 10px', textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap' }}>{children}</td>;
}
