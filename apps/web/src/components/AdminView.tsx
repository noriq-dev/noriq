// Admin menu (PLNR-83) — the admin-wide surface, separate from personal Settings.
// A table overview of every project (admins default to their own elsewhere) plus
// user management, moved out of Settings.
import { useEffect } from 'react';
import type { AppStore } from '../store';
import { LiveDot } from './bits';
import { GroupsSection, Section, UsersSection } from './SettingsView';

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

        <UsersSection store={store} />
        <GroupsSection store={store} all />
      </div>
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th style={{ padding: '4px 10px 8px', textAlign: right ? 'right' : 'left', fontWeight: 500, whiteSpace: 'nowrap' }}>{children}</th>;
}
function Td({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <td style={{ padding: '9px 10px', textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap' }}>{children}</td>;
}
