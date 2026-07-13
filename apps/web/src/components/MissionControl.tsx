// Mission Control — agent roster | live event feed | agent detail or who-holds-what.
import { useState } from 'react';
import type { AppStore } from '../store';
import { agentFg, fmtTtl, initials, isGhostColor, statusMeta, verbColors, YOU_GRADIENT } from '../design';
import { AvatarChip, MonoTag, SectionLabel, WaveBars } from './bits';
import { Composer } from './Composer';

export function MissionControl({ store }: { store: AppStore }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: '272px 1fr 328px', minHeight: 0 }}>
      <Roster store={store} />
      <EventFeed store={store} />
      {store.selectedAgentId ? <AgentPanel store={store} /> : <Holds store={store} />}
    </div>
  );
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function AgentPanel({ store }: { store: AppStore }) {
  const { data, currentPid, helpers, actions, selectedAgentId } = store;
  const agent = (data.agents[currentPid] ?? []).find((a) => a.id === selectedAgentId);
  const tasks = helpers.tasksOf(currentPid);
  const events = (data.events[currentPid] ?? []).filter((e) => e.actor === agent?.name).slice(0, 12);
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  if (!agent) return <Holds store={store} />;

  const held = tasks.filter((t) => t.claimedBy === agent.id && !['done', 'cancelled'].includes(t.status));
  const agents = data.agents[currentPid] ?? [];
  const parent = agent.parentAgentId ? agents.find((a) => a.id === agent.parentAgentId) : null;
  const children = agents.filter((a) => a.parentAgentId === agent.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 16px 12px', display: 'flex', alignItems: 'center', gap: 10, flex: 'none', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
        <AvatarChip name={agent.name} color={agent.color} size={34} radius={9} fontSize={12.5} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            {agent.name}
            {agent.role === 'orch' && <MonoTag color="var(--accent)" bg="rgba(198,242,78,.12)" size={9}>ORCH</MonoTag>}
            {parent && <MonoTag color="var(--blue)" bg="rgba(76,157,255,.12)" size={9}>SUB</MonoTag>}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>
            {parent && (
              <>
                sub-agent of{' '}
                <button onClick={() => actions.selectAgent(parent.id)} style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--blue)', padding: 0, font: 'inherit' }}>{parent.name}</button>
                {' · '}
              </>
            )}
            {!parent && children.length > 0 && `${children.length} sub-agent${children.length === 1 ? '' : 's'} · `}
            {agent.ownerName ? `delegated by ${agent.ownerName} · ` : ''}seen {ago(agent.lastSeenAt)}
          </div>
        </div>
        <button
          onClick={() => actions.selectAgent(null)}
          className="drawer-x"
          style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 15, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <SectionLabel>Holding · {held.length}</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {held.length === 0 && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>no live claims</div>
            )}
            {held.map((t) => {
              const eff = helpers.effStatus(currentPid, t);
              const mm = statusMeta(eff);
              return (
                <div
                  key={t.id}
                  onClick={() => actions.openTask(t.id)}
                  className="hover-border"
                  style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', borderRadius: 8, background: 'var(--card)', border: '1px solid rgba(255,255,255,.07)', cursor: 'pointer' }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: mm.dot, flex: 'none' }} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: mm.color, flex: 'none' }}>{t.key}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  <div style={{ flex: 1 }} />
                  {t.status === 'in_progress' && typeof t.ttl === 'number' && (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--green)' }}>{fmtTtl(t.ttl)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <SectionLabel>Message {agent.name}</SectionLabel>
          <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
            <input
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && msg.trim()) {
                  await store.actions.sendMessage(msg, agent.id);
                  setMsg('');
                  setSent(true);
                  setTimeout(() => setSent(false), 1500);
                }
              }}
              placeholder={`Direct to ${agent.name} — no task needed…`}
              style={{
                flex: 1, minWidth: 0, background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.09)',
                borderRadius: 8, padding: '8px 11px', color: 'var(--text)', fontSize: 12, outline: 'none',
              }}
            />
            <button
              onClick={async () => {
                if (msg.trim()) {
                  await store.actions.sendMessage(msg, agent.id);
                  setMsg('');
                  setSent(true);
                  setTimeout(() => setSent(false), 1500);
                }
              }}
              className="hover-bright"
              style={{ cursor: 'pointer', background: 'var(--accent)', color: 'var(--bg)', fontWeight: 600, fontSize: 11.5, padding: '8px 12px', borderRadius: 8 }}
            >
              {sent ? '✓' : 'Send'}
            </button>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)', marginTop: 6 }}>
            delivered via my_updates + notices on their next call
          </div>
        </div>

        <div>
          <SectionLabel>Recent activity</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
            {events.length === 0 && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>nothing yet</div>
            )}
            {events.map((ev) => {
              const vc = verbColors(ev.verb);
              return (
                <div key={ev.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)', flex: 'none' }}>{ev.t}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: vc.color, flex: 'none' }}>{ev.verb}</span>
                  <span style={{ color: 'var(--text-mid)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.subject}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Roster({ store }: { store: AppStore }) {
  const { data, currentPid, helpers, actions } = store;
  const agents = data.agents[currentPid] ?? [];
  const tasks = helpers.tasksOf(currentPid);

  return (
    <div style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 16px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 'none' }}>
        <SectionLabel>Agents · {agents.length}</SectionLabel>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--green)' }}>
          {agents.filter((a) => a.role === 'orch' || tasks.some((t) => t.claimedBy === a.id && t.status === 'in_progress')).length} active
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {agents.map((a) => {
          const claim = tasks.find((t) => t.claimedBy === a.id && ['in_progress', 'claimed', 'review'].includes(t.status));
          const working = claim?.status === 'in_progress';
          const isOrch = a.role === 'orch';
          let statusText: string, statusColor: string, dot: string;
          if (isOrch) {
            statusText = `decomposing · ${tasks.filter((t) => t.status === 'todo').length} open`;
            statusColor = 'var(--text-mid)';
            dot = '#c6f24e';
          } else if (claim) {
            const m = statusMeta(claim.status);
            statusText = `${claim.key} · ${m.label}`;
            statusColor = m.color;
            dot = working ? '#3fd98b' : m.dot;
          } else {
            statusText = 'idle · awaiting claim';
            statusColor = 'var(--text-dim)';
            dot = '#6b7280';
          }
          return (
            <div
              key={a.id}
              onClick={() => actions.selectAgent(store.selectedAgentId === a.id ? null : a.id)}
              className="hover-border"
              style={{
                padding: '11px 12px',
                borderRadius: 10,
                background: store.selectedAgentId === a.id ? 'rgba(198,242,78,.07)' : isOrch ? 'rgba(198,242,78,.04)' : claim ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.02)',
                border: `1px solid ${store.selectedAgentId === a.id ? 'rgba(198,242,78,.35)' : isOrch ? 'rgba(198,242,78,.22)' : claim ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.05)'}`,
                cursor: 'pointer',
                opacity: claim || isOrch ? 1 : 0.72,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <AvatarChip name={a.name} color={a.color} size={30} radius={8} fontSize={11} dot={dot} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {a.name}
                    {isOrch && <MonoTag color="var(--accent)" bg="rgba(198,242,78,.12)" size={9}>ORCH</MonoTag>}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: statusColor }}>{statusText}</div>
                </div>
                {working && <WaveBars />}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--line)', flex: 'none', display: 'flex', alignItems: 'center', gap: 9 }}>
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: YOU_GRADIENT,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            color: 'var(--bg)',
            fontWeight: 700,
          }}
        >
          Y
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-mid)' }}>
          {store.user?.name ?? 'you'} · <span style={{ color: 'var(--text)' }}>supervisor</span>
        </div>
      </div>
    </div>
  );
}

function EventFeed({ store }: { store: AppStore }) {
  const { data, currentPid, helpers, actions, selectedTaskId } = store;
  const events = data.events[currentPid] ?? [];
  const tasks = helpers.tasksOf(currentPid);
  const selTask = selectedTaskId != null ? tasks.find((t) => t.id === selectedTaskId) : null;
  const holderName = selTask?.claimedBy ? helpers.agentById(currentPid, selTask.claimedBy)?.name : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, borderRight: '1px solid var(--line)' }}>
      <div
        style={{
          padding: '14px 20px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid rgba(255,255,255,.05)',
          flex: 'none',
        }}
      >
        <SectionLabel>Event feed</SectionLabel>
        <span style={{ position: 'relative', width: 6, height: 6 }}>
          <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--accent)', animation: 'pl-blink 1.4s infinite' }} />
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
          append-only · {1200 + events.length}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '8px 0' }}>
        {events.map((ev) => {
          const ag = (data.agents[currentPid] ?? []).find((a) => a.name === ev.actor || a.id === ev.actor) ?? null;
          const isYou = ev.actorKind === 'human';
          const isSystem = ev.actorKind === 'system';
          const vc = verbColors(ev.verb);
          return (
            <div
              key={ev.id}
              onClick={ev.taskId != null ? () => actions.openTask(ev.taskId!) : undefined}
              className="event-row"
              style={{
                padding: '9px 20px',
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                cursor: ev.taskId != null ? 'pointer' : 'default',
                animation: 'pl-stream .45s ease both',
                borderLeft: '2px solid transparent',
              }}
            >
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)', paddingTop: 2, whiteSpace: 'nowrap' }}>
                {ev.t}
              </span>
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 5,
                  background: isYou ? YOU_GRADIENT : isSystem ? '#3fd98b' : ag ? (isGhostColor(ag.color) ? 'rgba(255,255,255,.16)' : ag.color) : 'rgba(255,255,255,.16)',
                  flex: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  fontWeight: 700,
                  color: isYou || isSystem ? '#0a0b0d' : ag ? agentFg(ag.color) : '#e6e8ec',
                }}
              >
                {isYou ? 'Y' : isSystem ? '✓' : initials(ev.actor)}
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-soft)', minWidth: 0 }}>
                <b style={{ color: 'var(--text)' }}>{ev.actor}</b>{' '}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: vc.color, background: vc.bg, padding: '1px 6px', borderRadius: 4 }}>
                  {ev.verb}
                </span>{' '}
                <span style={{ color: 'var(--text-mid)' }}>{ev.subject}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          borderTop: '1px solid var(--line)',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'var(--bg-raised)',
          flex: 'none',
        }}
      >
        <Composer store={store} placeholder={selTask ? `Steer ${holderName ?? 'the agent'}…` : 'Broadcast to all agents — anyone picks it up…'} />
      </div>
    </div>
  );
}

function Holds({ store }: { store: AppStore }) {
  const { currentPid, helpers, actions } = store;
  const tasks = helpers.tasksOf(currentPid);
  const rank = (s: string) => ({ in_progress: 0, review: 1, blocked: 2, todo: 3 })[s] ?? 4;
  const holds = tasks
    .filter((t) => t.status !== 'done')
    .sort((a, b) => rank(helpers.effStatus(currentPid, a)) - rank(helpers.effStatus(currentPid, b)))
    .slice(0, 6);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 16px 10px', flex: 'none' }}>
        <SectionLabel>Who holds what</SectionLabel>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {holds.map((t) => {
          const eff = helpers.effStatus(currentPid, t);
          const m = statusMeta(eff);
          const ag = t.claimedBy ? helpers.agentById(currentPid, t.claimedBy) : null;
          const blocked = eff === 'blocked';
          const depNames = t.deps.map((d) => tasks.find((x) => x.id === d)?.key ?? `#${d}`);
          const hasTtl = t.status === 'in_progress' && typeof t.ttl === 'number';
          return (
            <div
              key={t.id}
              onClick={() => actions.openTask(t.id)}
              className="hover-border"
              style={{
                border: `1px solid ${blocked ? 'rgba(255,92,92,.28)' : 'rgba(255,255,255,.09)'}`,
                borderRadius: 11,
                padding: 12,
                background: blocked ? 'rgba(255,92,92,.05)' : 'rgba(255,255,255,.02)',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                {ag && <AvatarChip name={ag.name} color={ag.color} size={22} radius={6} fontSize={9.5} />}
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  {ag ? ag.name : blocked ? 'blocked' : t.status === 'review' ? 'in review' : 'unclaimed'}
                </span>
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: m.color }}>{t.key}</span>
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.4, color: 'var(--text-soft)', marginBottom: 9 }}>{t.title}</div>
              {hasTtl && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>claim TTL</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--green)' }}>renews in {fmtTtl(t.ttl!)}</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: 'var(--green)', width: `${Math.round((t.ttl! / (t.ttlMax ?? 90)) * 100)}%` }} />
                  </div>
                </>
              )}
              {blocked && (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red-soft)' }}>
                  ⟂ depends on {depNames.join(', ')} · not claimable
                </div>
              )}
              {!ag && !blocked && t.status === 'todo' && (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>unclaimed · claimable now</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
