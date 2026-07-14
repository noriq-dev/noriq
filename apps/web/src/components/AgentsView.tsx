// Agents — roster: agents self-register via OAuth; revoke and inspect activity here.
import { useEffect, useState } from 'react';
import { api, type ApiAgent, type ApiAgentEvent } from '../api';
import type { AppStore } from '../store';
import { initials } from '../design';
import { MonoTag, SectionLabel } from './bits';
import { Button } from './ui';

const PALETTE = ['#4c9dff', '#b57bff', '#3fd98b', '#ff8a8a', '#c6f24e', '#f5a623'];
const colorOf = (a: ApiAgent) => {
  if (a.role === 'orchestrator') return '#f5a623';
  let h = 0;
  for (let i = 0; i < a.id.length; i++) h = (h * 31 + a.id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
};

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function AgentsView({ store }: { store: AppStore }) {
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<ApiAgentEvent[]>([]);
  const isAdmin = store.user?.role === 'admin';

  const load = () => api.agents(store.currentPid).then((r) => setAgents(r.agents)).catch(() => {});
  useEffect(() => {
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.modal, store.currentPid]); // reload on project switch + after the new-agent modal closes

  useEffect(() => {
    if (selected) api.agentEvents(selected).then((r) => setEvents(r.events)).catch(() => setEvents([]));
    else setEvents([]);
  }, [selected]);

  const sel = agents.find((a) => a.id === selected) ?? null;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: selected ? '1fr 380px' : '1fr', minHeight: 0 }}>
      <div style={{ overflowY: 'auto', padding: '18px 22px', minWidth: 0 }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
            <SectionLabel>Agents · {agents.filter((a) => a.status !== 'revoked').length}</SectionLabel>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
              agents join via OAuth — connect a client from the homepage
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {agents.map((a) => {
              const revoked = a.status === 'revoked';
              const online = a.lastSeenAt !== null && Date.now() - new Date(a.lastSeenAt).getTime() < 5 * 60 * 1000;
              return (
                <div
                  key={a.id}
                  onClick={() => setSelected(selected === a.id ? null : a.id)}
                  className="hover-border"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px',
                    borderRadius: 11, cursor: 'pointer',
                    background: selected === a.id ? 'rgba(255,255,255,.045)' : 'rgba(255,255,255,.02)',
                    border: `1px solid ${selected === a.id ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.07)'}`,
                    opacity: revoked ? 0.45 : 1,
                  }}
                >
                  <div style={{ position: 'relative', width: 34, height: 34, borderRadius: 9, background: colorOf(a), display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: '#0a0b0d' }}>
                    {initials(a.name)}
                    <span style={{ position: 'absolute', right: -3, bottom: -3, width: 10, height: 10, borderRadius: '50%', background: revoked ? '#ff5c5c' : online ? '#3fd98b' : '#6b7280', border: '2px solid var(--bg)' }} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
                      {a.name}
                      {a.role === 'orchestrator' && <MonoTag color="var(--accent)" bg="rgba(198,242,78,.12)" size={9}>ORCH</MonoTag>}
                      {revoked && <MonoTag color="var(--red-soft)" bg="rgba(255,92,92,.12)" size={9}>REVOKED</MonoTag>}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>
                      {a.ownerName ? `delegated by ${a.ownerName} · ` : 'unowned (legacy) · '}last seen {ago(a.lastSeenAt)} · {a.totalClaims} claims lifetime
                    </div>
                  </div>
                  {a.heldTasks > 0 && (
                    <MonoTag color="var(--blue)" bg="rgba(76,157,255,.12)" size={10}>{a.heldTasks} held</MonoTag>
                  )}
                  {isAdmin && !revoked && (
                    <Button
                      variant="danger"
                      style={{ padding: '5px 11px', fontSize: 11 }}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (confirm(`Revoke ${a.name}'s key? Its claims will expire and requeue.`)) {
                          await api.revokeAgent(a.id);
                          load();
                        }
                      }}
                    >
                      revoke
                    </Button>
                  )}
                </div>
              );
            })}
            {!agents.length && (
              <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                no agents yet — connect an MCP client via OAuth from the homepage
              </div>
            )}
          </div>
        </div>
      </div>

      {/* per-agent activity */}
      {sel && (
        <div style={{ borderLeft: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-raised)' }}>
          <div style={{ padding: '15px 18px 11px', display: 'flex', alignItems: 'center', gap: 9, flex: 'none', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
            <SectionLabel>{sel.name} · activity</SectionLabel>
            <div style={{ flex: 1 }} />
            <button onClick={() => setSelected(null)} className="drawer-x" style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 15, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }}>
            {events.map((e) => (
              <div key={e.id} style={{ padding: '8px 18px', display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                  {new Date(e.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-soft)', minWidth: 0 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-mid)' }}>{e.verb}</span>{' '}
                  <span style={{ color: 'var(--text-mid)' }}>
                    {String((e.payload as { key?: string; taskKey?: string; title?: string }).key ?? (e.payload as { taskKey?: string }).taskKey ?? '')}
                    {(e.payload as { title?: string }).title ? ` · ${(e.payload as { title?: string }).title}` : ''}
                  </span>
                </div>
              </div>
            ))}
            {!events.length && (
              <div style={{ padding: 30, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>no activity yet</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
