// Mission Control — agent roster | live event feed | agent detail or who-holds-what.
import { useLayoutEffect, useRef, useState } from 'react';
import type { AppStore } from '../store';
import { agentFg, fmtTtl, initials, isGhostColor, statusMeta, verbColors, YOU_GRADIENT } from '../design';
import { QuestionForm, SignalThreadHistory } from './QuestionForm';
import { Markdown } from './Markdown';
import { AvatarChip, MonoTag, SectionLabel, WaveBars } from './bits';
import { Composer } from './Composer';

export function MissionControl({ store }: { store: AppStore }) {
  return (
    <div className="mc-grid" style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: '272px 1fr 328px', minHeight: 0 }}>
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
      <div style={{ padding: '14px 16px 12px', display: 'flex', alignItems: 'center', gap: 10, flex: 'none', borderBottom: '1px solid var(--w-05)' }}>
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
                  style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--w-07)', cursor: 'pointer' }}
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
                flex: 1, minWidth: 0, background: 'var(--w-05)', border: '1px solid var(--w-09)',
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
                  {ev.dot && <span style={{ width: 7, height: 7, borderRadius: '50%', background: ev.dot, flex: 'none', alignSelf: 'center' }} />}
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
          // Derived status (PLNR-121): the states that actually matter beat the naive
          // last-seen dot — parked on a decision first, then a claim about to lapse.
          const decision = (store.snapshot?.signals ?? []).find((s) => s.agentId === a.id && s.type === 'input_request');
          const stalling = !!claim && claim.ttl !== undefined && claim.ttl < 300;
          let statusText: string, statusColor: string, dot: string;
          if (decision) {
            statusText = `⏸ blocked on decision${decision.taskKey ? ` · ${decision.taskKey}` : ''}`;
            statusColor = 'var(--amber)';
            dot = '#f5a623';
          } else if (stalling) {
            statusText = `${claim!.key} · claim expiring — stalled?`;
            statusColor = 'var(--red-soft)';
            dot = '#ff5c5c';
          } else if (isOrch) {
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
                background: store.selectedAgentId === a.id ? 'rgba(198,242,78,.07)' : isOrch ? 'rgba(198,242,78,.04)' : claim ? 'var(--w-03)' : 'var(--w-02)',
                border: `1px solid ${store.selectedAgentId === a.id ? 'rgba(198,242,78,.35)' : isOrch ? 'rgba(198,242,78,.22)' : claim ? 'var(--w-06)' : 'var(--w-05)'}`,
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
    </div>
  );
}

const SEV_COLOR: Record<string, string> = { critical: 'var(--red-soft)', warning: 'var(--amber)', info: 'var(--blue)' };

function AttentionInbox({ store }: { store: AppStore }) {
  const { snapshot, actions } = store;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const signals = snapshot?.signals ?? [];
  if (signals.length === 0) return null;

  return (
    <div style={{ flex: 'none', maxHeight: '46%', overflowY: 'auto', borderBottom: '1px solid var(--line)', background: 'rgba(245,166,35,.03)' }}>
      <div style={{ padding: '10px 20px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionLabel>Needs attention</SectionLabel>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)' }}>{signals.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 16px 12px' }}>
        {signals.map((s) => {
          const gate = s.type === 'input_request';
          const accent = gate ? 'var(--accent)' : SEV_COLOR[s.severity] ?? 'var(--blue)';
          return (
            <div key={s.id} style={{ border: `1px solid ${accent}44`, borderLeft: `3px solid ${accent}`, borderRadius: 9, background: 'var(--card)', padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                <MonoTag color={accent} bg={`${accent}1a`} size={9}>{gate ? 'DECISION' : s.severity.toUpperCase()}</MonoTag>
                {s.taskKey && (
                  <button onClick={() => s.taskId && actions.openTask(s.taskId)} style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--text-mid)', fontFamily: 'var(--mono)', fontSize: 10, padding: 0 }}>{s.taskKey}</button>
                )}
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{s.agentName}</span>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4 }}>{s.title}</div>
              {s.body && <div style={{ fontSize: 11.5, color: 'var(--text-mid)', marginTop: 4, lineHeight: 1.5 }}><Markdown source={s.body} compact /></div>}

              {gate && s.followUpTo && <SignalThreadHistory pid={store.currentPid} signalId={s.id} />}
              {gate && s.questions && s.questions.length > 0 ? (
                <QuestionForm questions={s.questions} onSubmit={(r, a) => actions.answerSignal(s.id, r, a)} />
              ) : gate ? (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {s.options && s.options.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {s.options.map((opt) => (
                        <button key={opt} onClick={() => void actions.answerSignal(s.id, opt)}
                          className="hover-bright"
                          style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 500, color: 'var(--accent-ink)', background: 'rgba(198,242,78,.08)', border: '1px solid rgba(198,242,78,.35)', borderRadius: 7, padding: '4px 10px' }}>
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={answers[s.id] ?? ''}
                      onChange={(e) => setAnswers((a) => ({ ...a, [s.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (answers[s.id] ?? '').trim()) { void actions.answerSignal(s.id, answers[s.id]!); } }}
                      placeholder={s.options?.length ? 'or type a decision…' : 'your decision…'}
                      style={{ flex: 1, minWidth: 0, background: 'var(--w-03)', border: '1px solid var(--w-1)', borderRadius: 7, padding: '5px 9px', color: 'var(--text)', fontSize: 12 }}
                    />
                    <button disabled={!(answers[s.id] ?? '').trim()} onClick={() => void actions.answerSignal(s.id, answers[s.id]!)}
                      style={{ cursor: (answers[s.id] ?? '').trim() ? 'pointer' : 'default', fontSize: 12, fontWeight: 600, color: '#0a0b0d', background: 'var(--accent)', border: 'none', borderRadius: 7, padding: '5px 12px', opacity: (answers[s.id] ?? '').trim() ? 1 : 0.4 }}>
                      Answer
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button onClick={() => void actions.acknowledgeSignal(s.id)} style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 500, color: 'var(--text-soft)', background: 'var(--w-04)', border: '1px solid var(--w-1)', borderRadius: 7, padding: '4px 11px' }}>Acknowledge</button>
                  <button onClick={() => void actions.acknowledgeSignal(s.id, true)} style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-faint)', background: 'transparent', border: 'none', padding: '4px 4px' }}>dismiss</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** How close to the bottom (px) still counts as "pinned" for auto-scroll. */
const STICK_THRESHOLD = 60;

function EventFeed({ store }: { store: AppStore }) {
  const { data, currentPid, actions } = store;
  // Direction toggle (PLNR-149): 'bottom' = chat-style (oldest top, newest arriving at
  // the bottom — the default); 'top' = classic activity feed (newest first). Sticky per
  // browser via localStorage.
  const [dir, setDir] = useState<'bottom' | 'top'>(
    () => (localStorage.getItem('noriq.feedDir') === 'top' ? 'top' : 'bottom'),
  );
  const flip = () => {
    const next = dir === 'bottom' ? 'top' : 'bottom';
    setDir(next);
    localStorage.setItem('noriq.feedDir', next);
  };
  // The store keeps events newest-first (Graph and the agent detail rely on that).
  const events = dir === 'bottom' ? [...(data.events[currentPid] ?? [])].reverse() : data.events[currentPid] ?? [];

  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the user is pinned to the bottom, so incoming events don't yank
  // the viewport while they're reading back through history. (Bottom mode only —
  // newest-first mode reads from the top and never needs to follow.)
  const stuckToBottom = useRef(true);
  const newestId = dir === 'bottom' ? events[events.length - 1]?.id ?? null : null;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || dir !== 'bottom') return;
    stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
  };

  // Jump (no animation) to the newest end when the project or direction changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    stuckToBottom.current = true;
    el.scrollTop = dir === 'bottom' ? el.scrollHeight : 0;
  }, [currentPid, dir]);

  // Follow new events only while pinned to the bottom. Layout effect so the feed
  // lands at the newest row before paint instead of visibly jumping after it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || dir !== 'bottom' || !stuckToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [newestId, dir]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, borderRight: '1px solid var(--line)' }}>
      <div
        style={{
          padding: '14px 20px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid var(--w-05)',
          flex: 'none',
        }}
      >
        <SectionLabel>Event feed</SectionLabel>
        <span style={{ position: 'relative', width: 6, height: 6 }}>
          <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--accent)', animation: 'pl-blink 1.4s infinite' }} />
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={flip}
          title={dir === 'bottom' ? 'newest at the bottom (chat) — click for newest first' : 'newest first — click for chat style'}
          style={{
            cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)',
            background: 'var(--w-04)', border: '1px solid var(--w-08)', borderRadius: 6, padding: '2px 8px',
          }}
        >
          {dir === 'bottom' ? '↓ newest last' : '↑ newest first'}
        </button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
          append-only · {1200 + events.length}
        </span>
      </div>
      <AttentionInbox store={store} />
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '8px 0' }}>
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
                animation: 'pl-stream-up .45s ease both',
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
                  background: isYou ? YOU_GRADIENT : isSystem ? '#3fd98b' : ag ? (isGhostColor(ag.color) ? 'var(--w-16)' : ag.color) : 'var(--w-16)',
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
                {ev.dot && (
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: ev.dot, marginRight: 5 }} />
                )}
                <span style={{ color: 'var(--text-mid)' }}>{ev.subject}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Holds({ store }: { store: AppStore }) {
  const { currentPid, helpers, actions } = store;
  const tasks = helpers.tasksOf(currentPid);
  // Only LIVE claims (PLNR-198): a hold is a task an agent currently owns — unclaimed,
  // review, and blocked-but-unheld tasks belong to the board, not this panel.
  const rank = (s: string) => ({ in_progress: 0, review: 1, blocked: 2, todo: 3 })[s] ?? 4;
  const holds = tasks
    .filter((t) => !!t.claimedBy && t.status !== 'done' && t.status !== 'cancelled')
    .sort((a, b) => rank(helpers.effStatus(currentPid, a)) - rank(helpers.effStatus(currentPid, b)))
    .slice(0, 6);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 16px 10px', flex: 'none' }}>
        <SectionLabel>Who holds what</SectionLabel>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {holds.length === 0 && (
          <div style={{ padding: '18px 6px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
            no live claims — nobody is holding a task right now
          </div>
        )}
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
                border: `1px solid ${blocked ? 'rgba(255,92,92,.28)' : 'var(--w-09)'}`,
                borderRadius: 11,
                padding: 12,
                background: blocked ? 'rgba(255,92,92,.05)' : 'var(--w-02)',
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
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--w-08)', overflow: 'hidden' }}>
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
        <FileLocksSection store={store} />
      </div>
    </div>
  );
}

// PLNR-212/213: live file locks — who holds which paths, for which task, and a human force-release
// for a stuck hold. Reads store.snapshot.locks (refetched on every lock.* WS event).
function FileLocksSection({ store }: { store: AppStore }) {
  const snap = store.snapshot;
  const enabled = !!snap?.project?.fileLockingEnabled;
  const locks = snap?.locks ?? [];
  const secLeft = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--w-05)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9 }}>
        <SectionLabel>File locks</SectionLabel>
        <div style={{ flex: 1 }} />
        {enabled && (
          <button
            onClick={() => { if (confirm('Disable file locking? This releases every held lock.')) void store.actions.setFileLocking(false); }}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}
          >disable</button>
        )}
      </div>
      {!enabled && (
        <div style={{ padding: '14px 6px', textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', marginBottom: 9 }}>
            file locking is off for this project
          </div>
          <button
            onClick={() => void store.actions.setFileLocking(true)}
            className="hover-border"
            style={{ border: '1px solid var(--w-09)', borderRadius: 8, background: 'var(--w-02)', padding: '5px 12px', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-soft)' }}
          >enable file locking</button>
        </div>
      )}
      {enabled && locks.length === 0 && (
        <div style={{ padding: '14px 6px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
          no files locked right now
        </div>
      )}
      {enabled && locks.map((l) => {
        const left = secLeft(l.expiresAt);
        const soon = left < 300; // < 5 min left → near expiry / possibly a stuck hold
        return (
          <div
            key={l.id}
            style={{
              border: `1px solid ${soon ? 'rgba(255,176,32,.30)' : 'var(--w-09)'}`,
              borderRadius: 10, padding: 10, marginBottom: 8,
              background: soon ? 'rgba(255,176,32,.05)' : 'var(--w-02)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-soft)', wordBreak: 'break-all', flex: 1 }}>
                {l.kind === 'dir' ? `${l.path}/` : l.path}
              </span>
              <button
                onClick={() => { if (confirm(`Force-release the lock on ${l.path}?`)) void store.actions.forceReleaseLock(l.id); }}
                title="Force-release (a dead agent's hold)"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', fontSize: 13, lineHeight: 1, padding: '0 2px' }}
              >×</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>
              <span>{l.holderName ?? l.agentId}</span>
              {l.taskKey && <MonoTag color="var(--blue)" bg="rgba(76,157,255,.12)" size={9}>{l.taskKey}</MonoTag>}
              <span>· {l.allBranches ? 'all branches' : l.branch ?? 'no branch'}</span>
              <div style={{ flex: 1 }} />
              <span style={{ color: soon ? '#ffb020' : 'var(--text-dim)' }}>
                {left === 0 ? 'expiring' : `${fmtTtl(left)} left`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
