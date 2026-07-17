// Agents — roster: agents self-register via OAuth; revoke and inspect activity here.
import { useEffect, useState } from 'react';
import { api, type ApiAgent, type ApiAgentEvent } from '../api';
import type { AppStore } from '../store';
import { initials } from '../design';
import { MonoTag, SectionLabel } from './bits';
import { Button } from './ui';
import { confirm } from './Dialog';

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
  // The two kinds have opposite lifecycles (RUN-43), so they get separate views rather than
  // one list that means two things. Agents are the project's runner-spawned processes;
  // copilots are YOUR sessions and aren't project-local at all (PLNR-156).
  const [kind, setKind] = useState<'agent' | 'copilot'>('agent');
  const isAdmin = store.user?.role === 'admin';

  const load = () => api.agents(store.currentPid, kind).then((r) => setAgents(r.agents)).catch(() => {});
  useEffect(() => {
    setSelected(null); // a selection from the other tab isn't in this list
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.modal, store.currentPid, kind]); // reload on project switch, tab switch, modal close

  useEffect(() => {
    if (selected) api.agentEvents(selected).then((r) => setEvents(r.events)).catch(() => setEvents([]));
    else setEvents([]);
  }, [selected]);

  const sel = agents.find((a) => a.id === selected) ?? null;

  return (
    <div className="agents-grid" style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: selected ? '1fr 380px' : '1fr', minHeight: 0 }}>
      <div style={{ overflowY: 'auto', padding: '18px 22px', minWidth: 0 }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <SectionLabel>
              {kind === 'agent' ? 'Agents' : 'Copilots'} · {agents.filter((a) => a.status !== 'revoked').length}
            </SectionLabel>
            <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 9, background: 'var(--w-02)', border: '1px solid var(--w-07)' }}>
              {(['agent', 'copilot'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.04em', textTransform: 'uppercase',
                    padding: '5px 11px', borderRadius: 7, border: 'none', cursor: 'pointer',
                    background: kind === k ? 'var(--w-09)' : 'transparent',
                    color: kind === k ? 'var(--text)' : 'var(--text-dim)',
                  }}
                >
                  {k === 'agent' ? 'Agents' : 'Copilots'}
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
              {kind === 'agent'
                ? 'runner-spawned — one run each, pinned to this project'
                : 'your sessions — registered when you authorize a client'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {agents.map((a) => {
              const revoked = a.status === 'revoked';
              const online = a.lastSeenAt !== null && Date.now() - new Date(a.lastSeenAt).getTime() < 5 * 60 * 1000;
              // Copilots read as a tree: one named connection with its chats beneath it —
              // otherwise a busy day is a wall of anonymous rows, which is the thing PLNR-155
              // set out to fix. A session whose parent isn't in view (a token minted before
              // that existed) just sits at top level rather than being faked into the tree.
              const isChild = kind === 'copilot' && !!a.parentAgentId && agents.some((p) => p.id === a.parentAgentId);
              return (
                <div
                  key={a.id}
                  onClick={() => setSelected(selected === a.id ? null : a.id)}
                  className="hover-border"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px',
                    borderRadius: 11, cursor: 'pointer',
                    marginLeft: isChild ? 26 : 0,
                    borderLeft: isChild ? '2px solid var(--w-18)' : undefined,
                    background: selected === a.id ? 'var(--w-045)' : 'var(--w-02)',
                    border: `1px solid ${selected === a.id ? 'var(--w-18)' : 'var(--w-07)'}`,
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
                      {/* The split, made visible (RUN-43): the roster used to render a human's
                          chat session and a runner-spawned process identically. */}
                      {a.kind === 'agent' ? (
                        <MonoTag color="var(--blue)" bg="rgba(76,157,255,.12)" size={9}>AGENT</MonoTag>
                      ) : (
                        <MonoTag color="var(--text-dim)" bg="rgba(255,255,255,.06)" size={9}>COPILOT</MonoTag>
                      )}
                      {a.role === 'orchestrator' && <MonoTag color="var(--accent)" bg="rgba(198,242,78,.12)" size={9}>ORCH</MonoTag>}
                      {revoked && <MonoTag color="var(--red-soft)" bg="rgba(255,92,92,.12)" size={9}>REVOKED</MonoTag>}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>
                      {/* "last seen" means opposite things for the two kinds, so only one of
                          them gets it. A quiet copilot is a human who stepped away — normal.
                          A quiet agent has no human behind it, and liveness is the signal. */}
                      {a.kind === 'agent'
                        ? `runner-spawned · last seen ${ago(a.lastSeenAt)} · `
                        : a.clientName
                          // Only a connection copilot has a token pointing at it, so only it
                          // can name the client it was authorized from (PLNR-155).
                          ? `connection · authorized from ${a.clientName} · `
                          : isChild
                            ? 'session · '
                            : a.ownerName
                              ? `${a.ownerName}’s session · `
                              : 'unowned (legacy) · '}
                      {a.totalClaims} claims lifetime
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
                        if (await confirm(`Revoke ${a.name}'s key? Its claims will expire and requeue.`)) {
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
          <div style={{ padding: '15px 18px 11px', display: 'flex', alignItems: 'center', gap: 9, flex: 'none', borderBottom: '1px solid var(--w-05)' }}>
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
