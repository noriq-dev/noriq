// Admin menu (PLNR-83) — the admin-wide surface, separate from personal Settings.
// A table overview of every project (admins default to their own elsewhere) plus
// user management, moved out of Settings.
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppStore } from '../store';
import { LiveDot, MonoTag } from './bits';
import { GroupsSection, Section, UsersSection } from './SettingsView';
import { confirm } from './Dialog';
import { Select } from './ui';

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
                      onClick={async () => {
                        if (!(await confirm(`Open ${p.key} using the system administrator override? This access is audited.`))) return;
                        await api.beginAdminProjectOverride(p.id);
                        store.actions.selectProject(p.id);
                      }}
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

        <AuthorizationSection />

        <OAuthSection />

        <UsersSection store={store} />
        <GroupsSection store={store} all />
      </div>
    </div>
  );
}

function AuthorizationSection() {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.adminAuthorization>> | null>(null);
  const [parity, setParity] = useState<Awaited<ReturnType<typeof api.authorizationParityAudit>> | null>(null);
  const load = () => api.adminAuthorization().then(setState).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!state) return <Section title="Authorization policy"><div style={{ color: 'var(--text-dim)' }}>loading…</div></Section>;
  const updateAccount = async (id: string, patch: Parameters<typeof api.patchUser>[1]) => {
    await api.patchUser(id, patch);
    load();
  };
  return (
    <>
      <Section title="Authorization defaults">
        <div style={{ display: 'flex', gap: 20, fontSize: 12.5 }}>
          <label><input type="checkbox" checked={!!state.settings.defaultCanCreateProjects} onChange={async (e) => { await api.setAuthorizationDefaults({ defaultCanCreateProjects: e.target.checked }); load(); }} /> Accounts may create projects by default</label>
          <label><input type="checkbox" checked={!!state.settings.defaultCanCreateGroups} onChange={async (e) => { await api.setAuthorizationDefaults({ defaultCanCreateGroups: e.target.checked }); load(); }} /> Accounts may create groups by default</label>
        </div>
      </Section>
      <Section title="Migration parity gate">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
          <button onClick={() => void api.authorizationParityAudit(false).then(setParity)}>Run shadow audit</button>
          <button onClick={async () => {
            if (!(await confirm('Reconcile missing compatibility grants, then rerun the parity audit?'))) return;
            setParity(await api.authorizationParityAudit(true));
            load();
          }}>Reconcile lost access</button>
          {parity && <span style={{ color: parity.readyToRetireLegacy ? 'var(--green)' : 'var(--amber)', fontFamily: 'var(--mono)' }}>
            {parity.rolloutGate.toUpperCase()} · {parity.compared} pairs · {parity.broadened} broadened · {parity.lost} lost · {parity.inserted} inserted
          </span>}
        </div>
        {parity && !parity.readyToRetireLegacy && <div style={{ marginTop: 8, color: 'var(--text-mid)', fontSize: 11 }}>{parity.rollback}</div>}
      </Section>
      <Section title={`Account policy · ${state.accounts.length}`}>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr><Th>Account</Th><Th>Access</Th><Th>Project creation</Th><Th>Group creation</Th></tr></thead>
          <tbody>{state.accounts.map((u) => <tr key={u.id} style={{ borderTop: '1px solid var(--w-05)' }}>
            <Td><b>{u.name}</b> <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9.5 }}>{u.email}</span></Td>
            <Td><Select variant="micro" aria-label={`Access mode for ${u.name}`} value={u.accessMode ?? 'read_write'} onChange={(e) => void updateAccount(u.id, { accessMode: e.target.value as 'read_write' | 'read_only' })}><option value="read_write">Read/write</option><option value="read_only">Read-only</option></Select></Td>
            <Td><PolicySelect label={`Project creation policy for ${u.name}`} value={u.canCreateProjectsOverride} onChange={(v) => updateAccount(u.id, { canCreateProjects: v })} /></Td>
            <Td><PolicySelect label={`Group creation policy for ${u.name}`} value={u.canCreateGroupsOverride} onChange={(v) => updateAccount(u.id, { canCreateGroups: v })} /></Td>
          </tr>)}</tbody>
        </table></div>
      </Section>
      <Section title={`Access inventory · ${state.projects.length} projects · ${state.groups.length} groups`}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, fontSize: 11.5 }}>
          <div>{state.projects.map((p) => <div key={p.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--w-05)' }}><b>{p.key}</b> · {p.ownerName} · {p.grantCount} grant(s){p.legacyGroupId ? ' · legacy group link' : ''}</div>)}</div>
          <div>{state.groups.map((g) => <div key={g.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--w-05)' }}><b>{g.name}</b> · {g.ownerCount} owner(s) · {g.memberCount} member(s) · {g.projectGrantCount} project grant(s)</div>)}</div>
        </div>
      </Section>
      <Section title={`Authorization audit · latest ${state.audit.length}`}>
        <div style={{ maxHeight: 260, overflowY: 'auto', fontFamily: 'var(--mono)', fontSize: 10 }}>
          {state.audit.map((e) => <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 90px 1fr', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--w-04)' }}>
            <span style={{ color: 'var(--text-faint)' }}>{new Date(e.createdAt).toLocaleString()}</span><span>{e.action}</span><span>{e.decision} · {e.reason}</span><span style={{ color: 'var(--text-dim)' }}>{e.resourceType}:{e.resourceId ?? '—'}</span>
          </div>)}
        </div>
      </Section>
    </>
  );
}

function PolicySelect({ label, value, onChange }: { label: string; value?: number | null; onChange: (value: boolean | null) => Promise<void> }) {
  return <Select variant="micro" aria-label={label} value={value == null ? 'inherit' : value ? 'allow' : 'deny'} onChange={(e) => void onChange(e.target.value === 'inherit' ? null : e.target.value === 'allow')}>
    <option value="inherit">Inherit default</option><option value="allow">Allow</option><option value="deny">Deny</option>
  </Select>;
}

type AdminClient = Awaited<ReturnType<typeof api.adminClients>>['clients'][number];
type AdminConnection = Awaited<ReturnType<typeof api.adminConnections>>['connections'][number];
type ClientFilter = 'all' | 'in_use' | 'idle';

/** Parse redirect_uris JSON from DCR / admin list into host labels for the table. */
export function redirectHosts(redirectUris: string): string[] {
  try {
    const uris = JSON.parse(redirectUris) as unknown;
    if (!Array.isArray(uris)) return [];
    const hosts: string[] = [];
    for (const u of uris) {
      if (typeof u !== 'string') continue;
      try {
        hosts.push(new URL(u).host || new URL(u).hostname);
      } catch {
        hosts.push(u);
      }
    }
    return [...new Set(hosts)];
  } catch {
    return redirectUris ? [redirectUris] : [];
  }
}

const checkStyle: React.CSSProperties = { width: 15, height: 15, accentColor: 'var(--accent)', cursor: 'pointer' };
const bulkBtn: React.CSSProperties = {
  background: 'var(--w-06)', border: '1px solid var(--w-1)', borderRadius: 7,
  color: 'var(--text)', fontSize: 11.5, padding: '5px 10px', fontFamily: 'inherit', cursor: 'pointer',
};

/** Admin OAuth management (PLNR-160 / PLNR-642): live connections + DCR clients with
 *  checkbox multi-select bulk actions and calmer idle-vs-in-use labeling. */
function OAuthSection() {
  const [connections, setConnections] = useState<AdminConnection[]>([]);
  const [clients, setClients] = useState<AdminClient[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connSelected, setConnSelected] = useState<Set<string>>(new Set());
  const [clientSelected, setClientSelected] = useState<Set<string>>(new Set());
  const [clientFilter, setClientFilter] = useState<ClientFilter>('all');
  const load = () => {
    api.adminConnections().then((r) => setConnections(r.connections)).catch(() => {});
    api.adminClients().then((r) => setClients(r.clients)).catch(() => {});
  };
  useEffect(load, []);

  const scopeOf = (c: AdminConnection) =>
    c.bound ? 'run-bound' : c.scopeAll ? 'all projects' : c.scoped ? (c.projectKeys ?? 'none') : 'unscoped (legacy)';

  const idleCount = clients.filter((c) => c.liveTokens === 0).length;
  const inUseCount = clients.length - idleCount;
  const visibleClients = clients
    .filter((c) => clientFilter === 'all' || (clientFilter === 'idle' ? c.liveTokens === 0 : c.liveTokens > 0))
    // Idle first within the filter so DCR residue is easy to clean; then newest.
    .slice()
    .sort((a, b) => {
      if (clientFilter === 'all' && (a.liveTokens === 0) !== (b.liveTokens === 0)) {
        return a.liveTokens === 0 ? -1 : 1;
      }
      return b.createdAt.localeCompare(a.createdAt);
    });

  const toggleSet = (prev: Set<string>, id: string) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const setAll = (ids: string[], on: boolean) => (on ? new Set(ids) : new Set<string>());

  const connIds = connections.map((c) => c.id);
  const visibleClientIds = visibleClients.map((c) => c.id);
  const allConnSelected = connIds.length > 0 && connIds.every((id) => connSelected.has(id));
  const allClientsSelected = visibleClientIds.length > 0 && visibleClientIds.every((id) => clientSelected.has(id));

  const deleteClient = async (cl: AdminClient) => {
    setError(null);
    try {
      await api.adminDeleteClient(cl.id);
      setClientSelected((prev) => {
        const next = new Set(prev);
        next.delete(cl.id);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete failed');
    }
  };

  return (
    <>
      <Section title={`OAuth connections · ${connections.length}`}>
        <div style={{ fontSize: 11.5, color: 'var(--text-mid)', marginBottom: 10, lineHeight: 1.45 }}>
          Live authorizations instance-wide. Select rows to revoke several at once.
        </div>
        {connections.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>no live connections</div>
        ) : (
          <div style={{ overflowX: 'auto', position: 'relative' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }} data-testid="oauth-connections-table">
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  <Th>
                    <input
                      type="checkbox"
                      aria-label="Select all connections"
                      checked={allConnSelected}
                      onChange={(e) => setConnSelected(setAll(connIds, e.target.checked))}
                      style={checkStyle}
                    />
                  </Th>
                  <Th>User</Th><Th>Client</Th><Th>Reaches</Th><Th right>Agents</Th><Th>Last active</Th><Th>Expires</Th><Th />
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--w-05)', background: connSelected.has(c.id) ? 'var(--w-04)' : undefined }}>
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`Select connection ${c.clientName}`}
                        checked={connSelected.has(c.id)}
                        onChange={() => setConnSelected((prev) => toggleSet(prev, c.id))}
                        style={checkStyle}
                      />
                    </Td>
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
                            setConnSelected((prev) => { const n = new Set(prev); n.delete(c.id); return n; });
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
            {connSelected.size > 0 && (
              <div className="bulk-bar" data-testid="oauth-connections-bulk" style={{
                position: 'sticky', bottom: 8, margin: '12px auto 0', width: 'fit-content',
                display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px',
                background: 'var(--bg-raised)', border: '1px solid var(--w-18)', borderRadius: 12,
                boxShadow: '0 8px 28px rgba(0,0,0,.45)', zIndex: 5,
              }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--accent)', fontWeight: 700 }}>{connSelected.size} selected</span>
                <button
                  style={{ ...bulkBtn, color: 'var(--red-soft)' }}
                  onClick={async () => {
                    if (!(await confirm(`Revoke ${connSelected.size} connection(s)? Their agents go offline.`))) return;
                    for (const id of connSelected) await api.adminRevokeConnection(id).catch(() => {});
                    setConnSelected(new Set());
                    load();
                  }}
                >
                  revoke selected
                </button>
                <button style={{ ...bulkBtn, color: 'var(--text-dim)', border: 'none', background: 'transparent' }} onClick={() => setConnSelected(new Set())}>✕</button>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title={`OAuth clients · ${clients.length}`}>
        <div style={{ fontSize: 11.5, color: 'var(--text-mid)', marginBottom: 10, lineHeight: 1.45 }}>
          Dynamic Client Registration (DCR) adds a row whenever a tool registers. <b style={{ fontWeight: 600 }}>Idle</b> clients have no live connections and are safe to delete; <b style={{ fontWeight: 600 }}>In use</b> ones need their connections revoked first.
        </div>
        {error && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--red-soft)', marginBottom: 8 }}>{error}</div>}
        {clients.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }} data-testid="oauth-clients-filters">
            {([
              ['all', `All · ${clients.length}`],
              ['idle', `Idle · ${idleCount}`],
              ['in_use', `In use · ${inUseCount}`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setClientFilter(key); setClientSelected(new Set()); }}
                style={{
                  cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, padding: '3px 8px', borderRadius: 8,
                  color: clientFilter === key ? 'var(--accent-ink)' : 'var(--text-dim)',
                  background: clientFilter === key ? 'rgba(198,242,78,.06)' : 'var(--w-03)',
                  border: `1px solid ${clientFilter === key ? 'rgba(198,242,78,.35)' : 'var(--w-08)'}`,
                }}
              >
                {label}
              </button>
            ))}
            {idleCount > 0 && (
              <button
                type="button"
                data-testid="oauth-select-idle"
                onClick={() => setClientSelected(new Set(clients.filter((c) => c.liveTokens === 0).map((c) => c.id)))}
                style={{ ...bulkBtn, marginLeft: 'auto', fontSize: 10.5, padding: '3px 8px' }}
              >
                Select idle
              </button>
            )}
          </div>
        )}
        {clients.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>no registered clients</div>
        ) : visibleClients.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>no clients in this filter</div>
        ) : (
          <div style={{ overflowX: 'auto', position: 'relative' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }} data-testid="oauth-clients-table">
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  <Th>
                    <input
                      type="checkbox"
                      aria-label="Select all visible clients"
                      checked={allClientsSelected}
                      onChange={(e) => setClientSelected(setAll(visibleClientIds, e.target.checked))}
                      style={checkStyle}
                    />
                  </Th>
                  <Th>Client</Th><Th>Redirects</Th><Th>Status</Th><Th right>Live</Th><Th>Registered</Th><Th />
                </tr>
              </thead>
              <tbody>
                {visibleClients.map((cl) => {
                  const idle = cl.liveTokens === 0;
                  const hosts = redirectHosts(cl.redirectUris);
                  return (
                    <tr key={cl.id} style={{ borderTop: '1px solid var(--w-05)', background: clientSelected.has(cl.id) ? 'var(--w-04)' : undefined }}>
                      <Td>
                        <input
                          type="checkbox"
                          aria-label={`Select client ${cl.name}`}
                          checked={clientSelected.has(cl.id)}
                          onChange={() => setClientSelected((prev) => toggleSet(prev, cl.id))}
                          style={checkStyle}
                        />
                      </Td>
                      <Td>
                        <div style={{ fontWeight: 600 }}>{cl.name}</div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>{cl.id.length > 28 ? `${cl.id.slice(0, 28)}…` : cl.id}</div>
                      </Td>
                      <Td>
                        {hosts.length === 0 ? (
                          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>—</span>
                        ) : (
                          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                            {hosts.map((h) => (
                              <span key={h} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', background: 'var(--w-04)', border: '1px solid var(--w-08)', borderRadius: 5, padding: '1px 6px' }}>{h}</span>
                            ))}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <MonoTag color={idle ? 'var(--text-dim)' : 'var(--accent-ink)'} bg="var(--w-04)" size={9.5}>
                          {idle ? 'idle' : 'in use'}
                        </MonoTag>
                      </Td>
                      <Td right><span style={{ fontFamily: 'var(--mono)', color: idle ? 'var(--text-faint)' : 'var(--accent-ink)' }}>{cl.liveTokens}</span></Td>
                      <Td><span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>{new Date(cl.createdAt).toLocaleDateString()}</span></Td>
                      <Td right>
                        <button
                          disabled={!idle}
                          title={idle ? 'delete this client registration' : 'revoke its live connections first'}
                          onClick={async () => {
                            if (!(await confirm(`Delete client "${cl.name}"? Historical tokens are removed; agents survive.`))) return;
                            await deleteClient(cl);
                            load();
                          }}
                          style={{
                            cursor: idle ? 'pointer' : 'default', fontSize: 11,
                            color: idle ? 'var(--red-soft)' : 'var(--text-faint)',
                            background: 'transparent', border: '1px solid var(--w-1)', borderRadius: 6, padding: '3px 10px',
                            opacity: idle ? 1 : 0.5,
                          }}
                        >
                          delete
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {clientSelected.size > 0 && (
              <div className="bulk-bar" data-testid="oauth-clients-bulk" style={{
                position: 'sticky', bottom: 8, margin: '12px auto 0', width: 'fit-content',
                display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px',
                background: 'var(--bg-raised)', border: '1px solid var(--w-18)', borderRadius: 12,
                boxShadow: '0 8px 28px rgba(0,0,0,.45)', zIndex: 5,
              }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--accent)', fontWeight: 700 }}>{clientSelected.size} selected</span>
                <button
                  style={{ ...bulkBtn, color: 'var(--red-soft)' }}
                  onClick={async () => {
                    const selected = clients.filter((c) => clientSelected.has(c.id));
                    const idle = selected.filter((c) => c.liveTokens === 0);
                    const busy = selected.length - idle.length;
                    if (idle.length === 0) {
                      setError(busy > 0 ? `${busy} selected client(s) still have live connections — revoke those first` : null);
                      return;
                    }
                    const msg = busy > 0
                      ? `Delete ${idle.length} idle client(s)? ${busy} in-use selection(s) will be skipped.`
                      : `Delete ${idle.length} client(s)? Historical tokens are removed; agents survive.`;
                    if (!(await confirm(msg))) return;
                    setError(null);
                    let failed = 0;
                    for (const cl of idle) {
                      try {
                        await api.adminDeleteClient(cl.id);
                      } catch {
                        failed += 1;
                      }
                    }
                    if (failed > 0 || busy > 0) {
                      setError([
                        failed > 0 ? `${failed} delete(s) failed` : null,
                        busy > 0 ? `${busy} in-use skipped` : null,
                      ].filter(Boolean).join(' · '));
                    }
                    setClientSelected(new Set());
                    load();
                  }}
                >
                  delete idle in selection
                </button>
                <button style={{ ...bulkBtn, color: 'var(--text-dim)', border: 'none', background: 'transparent' }} onClick={() => setClientSelected(new Set())}>✕</button>
              </div>
            )}
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
