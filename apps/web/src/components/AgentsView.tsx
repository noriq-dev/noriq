// Actor lifecycle inventory — live work first, durable history on demand.
import { useEffect, useMemo, useState } from 'react';
import {
  api, type ApiAgent, type ApiAgentEvent, type ApiAgentLifecycleSweep, type ApiAgentRoster,
  type ApiRunner, type ApiRunnerRoster, type ApiUser,
} from '../api';
import type { AppStore } from '../store';
import { initials } from '../design';
import { MonoTag, SectionLabel } from './bits';
import { Button } from './ui';
import { alert, confirm } from './Dialog';

const PALETTE = ['#4c9dff', '#b57bff', '#3fd98b', '#ff8a8a', '#c6f24e', '#f5a623'];
const colorOf = (a: ApiAgent) => {
  if (a.role === 'orchestrator') return '#f5a623';
  let h = 0;
  for (let i = 0; i < a.id.length; i++) h = (h * 31 + a.id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
};

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

type Subject = 'agent' | 'copilot' | 'runner';
type LifecycleView = 'active' | 'dormant' | 'history';

const selectStyle = {
  background: 'var(--w-03)', color: 'var(--text-mid)', border: '1px solid var(--w-09)',
  borderRadius: 7, padding: '5px 8px', fontFamily: 'var(--mono)', fontSize: 10,
};

export function AgentsView({ store }: { store: AppStore }) {
  const [subject, setSubject] = useState<Subject>('agent');
  const [view, setView] = useState<LifecycleView>('active');
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [runners, setRunners] = useState<ApiRunner[]>([]);
  const [runnerChoices, setRunnerChoices] = useState<ApiRunner[]>([]);
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [agentCounts, setAgentCounts] = useState<ApiAgentRoster['counts'] | null>(null);
  const [runnerCounts, setRunnerCounts] = useState<ApiRunnerRoster['counts'] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<ApiAgentEvent[]>([]);
  const [projectScope, setProjectScope] = useState<'current' | 'all'>('current');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [runnerId, setRunnerId] = useState('');
  const [olderThanDays, setOlderThanDays] = useState('');
  const [retireReason, setRetireReason] = useState('');
  const [sweep, setSweep] = useState<ApiAgentLifecycleSweep | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const isAdmin = store.user?.role === 'admin';
  const canCleanCurrentProject = Boolean(store.currentPid && store.permissions.canManage && projectScope === 'current');

  const activeBefore = olderThanDays
    ? new Date(Date.now() - Number(olderThanDays) * 86_400_000).toISOString()
    : undefined;
  const scopedProjectId = projectScope === 'current' ? store.currentPid || undefined : undefined;

  const load = async (cursor?: string, append = false) => {
    if (subject === 'runner') {
      const result = await api.runners({
        all: isAdmin, projectId: scopedProjectId, ownerUserId: ownerUserId || undefined,
        view, retireReason: retireReason || undefined, activeBefore, cursor, limit: 50,
      });
      setRunners((current) => append ? [...current, ...result.runners] : result.runners);
      setRunnerCounts(result.counts);
      setNextCursor(result.page.nextCursor);
      return;
    }
    const result = await api.agents(scopedProjectId, subject, {
      view, runnerId: runnerId || undefined, ownerUserId: ownerUserId || undefined,
      retireReason: retireReason || undefined, activeBefore, cursor, limit: 50,
    });
    setAgents((current) => append ? [...current, ...result.agents] : result.agents);
    setAgentCounts(result.counts);
    setNextCursor(result.page.nextCursor);
  };

  useEffect(() => {
    setSelected(null);
    void load().catch(() => {});
    const interval = setInterval(() => void load().catch(() => {}), 15_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.modal, store.currentPid, subject, view, projectScope, ownerUserId, runnerId, olderThanDays, retireReason]);

  useEffect(() => {
    if (isAdmin) void api.users().then((result) => setUsers(result.users)).catch(() => {});
    void api.runners({ all: isAdmin, limit: 100 }).then((result) => setRunnerChoices(result.runners)).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    if (selected && subject !== 'runner') void api.agentEvents(selected).then((r) => setEvents(r.events)).catch(() => setEvents([]));
    else setEvents([]);
  }, [selected, subject]);

  const counts = useMemo(() => subject === 'runner'
    ? {
      active: runnerCounts?.active ?? 0, dormant: runnerCounts?.dormant ?? 0,
      history: runnerCounts?.historical ?? 0, total: runnerCounts?.total ?? 0,
    }
    : {
      active: (agentCounts?.live ?? 0) + (agentCounts?.recent ?? 0),
      dormant: agentCounts?.byLifecycle.dormant ?? 0,
      history: agentCounts?.historical ?? 0, total: agentCounts?.total ?? 0,
    }, [subject, runnerCounts, agentCounts]);
  const sel = agents.find((agent) => agent.id === selected) ?? null;

  const reloadAfter = async (key: string, action: () => Promise<unknown>) => {
    setOperation(key);
    try { await action(); await load(); }
    catch (error) { await alert(error instanceof Error ? error.message : String(error)); }
    finally { setOperation(null); }
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try { await load(nextCursor, true); }
    finally { setLoadingMore(false); }
  };

  const runSweep = async (apply: boolean) => {
    if (!store.currentPid || !canCleanCurrentProject) return;
    if (apply && !(await confirm(
      'Apply one bounded lifecycle sweep batch?\n\nThis can retire inactive actors, archive retained history, and purge only verified-safe expired presence rows. Durable actor history is never deleted.',
    ))) return;
    setOperation('sweep');
    try { setSweep(await api.agentLifecycleSweep(store.currentPid, apply)); await load(); }
    catch (error) { await alert(error instanceof Error ? error.message : String(error)); }
    finally { setOperation(null); }
  };

  return (
    <div className="agents-grid" style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: sel ? '1fr 380px' : '1fr', minHeight: 0 }}>
      <div style={{ overflowY: 'auto', padding: '18px 22px', minWidth: 0 }}>
        <div style={{ maxWidth: 980, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <SectionLabel>Actor lifecycle · {counts.total} recorded</SectionLabel>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
              live state is presence/heartbeat evidence; history remains durable attribution
            </span>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Segmented values={['agent', 'copilot', 'runner']} selected={subject} onSelect={(value) => setSubject(value as Subject)} />
            <Segmented
              values={['active', 'dormant', 'history']}
              labels={{ active: `Active ${counts.active}`, dormant: `Dormant ${counts.dormant}`, history: `History ${counts.history}` }}
              selected={view}
              onSelect={(value) => setView(value as LifecycleView)}
            />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 14 }}>
            {subject !== 'copilot' && (
              <select style={selectStyle} value={projectScope} onChange={(event) => setProjectScope(event.target.value as 'current' | 'all')}>
                <option value="current">current project</option>
                {isAdmin && <option value="all">all projects</option>}
              </select>
            )}
            {isAdmin && (
              <select style={selectStyle} value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)}>
                <option value="">all owners</option>
                {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
              </select>
            )}
            {subject === 'agent' && (
              <select style={selectStyle} value={runnerId} onChange={(event) => setRunnerId(event.target.value)}>
                <option value="">all Runners</option>
                {runnerChoices.map((runner) => <option key={runner.id} value={runner.id}>{runner.label}</option>)}
              </select>
            )}
            <select style={selectStyle} value={olderThanDays} onChange={(event) => setOlderThanDays(event.target.value)}>
              <option value="">any age</option><option value="1">older than 1 day</option><option value="7">older than 7 days</option>
              <option value="30">older than 30 days</option><option value="90">older than 90 days</option>
            </select>
            {view === 'history' && (
              <select style={selectStyle} value={retireReason} onChange={(event) => setRetireReason(event.target.value)}>
                <option value="">all retirement reasons</option><option value="runner_offboarded">offboarded</option>
                <option value="runner_offline_retention">offline retention elapsed</option><option value="run_terminal">run terminal</option>
                <option value="session_inactive">session inactive</option><option value="connection_authorization_ended">authorization ended</option>
                <option value="administrator_revoked">administrator revoked</option>
              </select>
            )}
          </div>

          {canCleanCurrentProject && (
            <div style={{ padding: '10px 12px', marginBottom: 12, borderRadius: 9, border: '1px solid var(--w-07)', background: 'var(--w-02)', fontSize: 11 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b>Project cleanup preview</b><span style={{ color: 'var(--text-dim)' }}>actors and presence rows · bounded and dry-run by default</span><div style={{ flex: 1 }} />
                <Button variant="ghost" disabled={operation === 'sweep'} onClick={() => void runSweep(false)}>dry run</Button>
                <Button variant="danger" disabled={operation === 'sweep'} onClick={() => void runSweep(true)}>apply one batch</Button>
              </div>
              {sweep && (
                <div style={{ marginTop: 7, fontFamily: 'var(--mono)', fontSize: 10, color: sweep.errors.length ? 'var(--amber)' : 'var(--text-dim)' }}>
                  {sweep.dryRun ? 'DRY RUN' : 'APPLIED'} · examined {sweep.examined.actors} actors / {sweep.examined.presences} presences / {sweep.examined.runners} Runners
                  {' '}· {Object.values(sweep.transitions).reduce((sum, count) => sum + count, 0)} transition(s)
                  {' '}· reference probe {sweep.referenceCheck.complete ? 'passed' : 'blocked'} · {sweep.complete ? 'complete' : 'more batches available'}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {subject === 'runner'
              ? runners.map((runner) => <RunnerRow key={runner.id} runner={runner} busy={operation === runner.id} onAction={reloadAfter} />)
              : agents.map((agent) => (
                <ActorRow
                  key={agent.id} agent={agent} allAgents={agents} selected={selected === agent.id} isAdmin={isAdmin}
                  busy={operation === agent.id} onSelect={() => setSelected(selected === agent.id ? null : agent.id)} onAction={reloadAfter}
                />
              ))}
            {((subject === 'runner' && !runners.length) || (subject !== 'runner' && !agents.length)) && (
              <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                no {view} {subject === 'runner' ? 'Runners' : `${subject}s`} in this scope
              </div>
            )}
            {nextCursor && <Button variant="ghost" disabled={loadingMore} onClick={() => void loadMore()} style={{ alignSelf: 'center', marginTop: 6 }}>{loadingMore ? 'loading…' : 'load more'}</Button>}
          </div>
        </div>
      </div>

      {sel && (
        <div style={{ borderLeft: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-raised)' }}>
          <div style={{ padding: '15px 18px 11px', display: 'flex', alignItems: 'center', gap: 9, flex: 'none', borderBottom: '1px solid var(--w-05)' }}>
            <SectionLabel>{sel.name} · activity</SectionLabel><div style={{ flex: 1 }} />
            <button onClick={() => setSelected(null)} className="drawer-x" style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 15, width: 24, height: 24 }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }}>
            {events.map((event) => (
              <div key={event.id} style={{ padding: '8px 18px', display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{new Date(event.createdAt).toLocaleString()}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-soft)' }}>{event.verb} · {event.subjectType}:{event.subjectId}</span>
              </div>
            ))}
            {!events.length && <div style={{ padding: 30, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>no activity yet</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Segmented({ values, labels, selected, onSelect }: { values: string[]; labels?: Record<string, string>; selected: string; onSelect: (value: string) => void }) {
  return <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 9, background: 'var(--w-02)', border: '1px solid var(--w-07)' }}>
    {values.map((value) => <button key={value} onClick={() => onSelect(value)} style={{ fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', padding: '5px 11px', borderRadius: 7, border: 'none', cursor: 'pointer', background: selected === value ? 'var(--w-09)' : 'transparent', color: selected === value ? 'var(--text)' : 'var(--text-dim)' }}>{labels?.[value] ?? value}</button>)}
  </div>;
}

function ActorRow({ agent, allAgents, selected, isAdmin, busy, onSelect, onAction }: {
  agent: ApiAgent; allAgents: ApiAgent[]; selected: boolean; isAdmin: boolean; busy: boolean;
  onSelect: () => void; onAction: (key: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const child = agent.kind === 'copilot' && !!agent.parentAgentId && allAgents.some((parent) => parent.id === agent.parentAgentId);
  const historical = ['retired', 'archived', 'revoked'].includes(agent.lifecycle);
  const why = agent.lifecycle === 'live' ? 'fresh online/working presence'
    : agent.lifecycle === 'recent' ? 'recent activity, no fresh live presence'
      : agent.lifecycle === 'dormant' ? 'activity outside the recent window'
        : agent.lifecycle === 'archived' ? `visibility archived · ${agent.retireReason ?? 'retained history'}`
          : agent.lifecycle === 'revoked' ? `credential revoked · ${agent.retireReason ?? 'operator action'}`
            : `retired · ${agent.retireReason ?? 'lifecycle policy'}`;
  return <div onClick={onSelect} className="hover-border" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px', borderRadius: 11, cursor: 'pointer', marginLeft: child ? 26 : 0, borderLeft: child ? '2px solid var(--w-18)' : undefined, background: selected ? 'var(--w-045)' : 'var(--w-02)', border: `1px solid ${selected ? 'var(--w-18)' : 'var(--w-07)'}`, opacity: historical ? 0.68 : 1 }}>
    <div style={{ position: 'relative', width: 34, height: 34, borderRadius: 9, background: colorOf(agent), display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: '#0a0b0d' }}>
      {initials(agent.name)}<span style={{ position: 'absolute', right: -3, bottom: -3, width: 10, height: 10, borderRadius: '50%', background: agent.live ? '#3fd98b' : agent.lifecycle === 'revoked' ? '#ff5c5c' : '#6b7280', border: '2px solid var(--bg)' }} />
    </div>
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', gap: 7, alignItems: 'center' }}>
        {agent.name}<MonoTag color="var(--text-dim)" bg="var(--w-05)" size={9}>{agent.lifecycle.toUpperCase()}</MonoTag>
        {agent.role === 'orchestrator' && <MonoTag color="var(--accent)" bg="rgba(198,242,78,.12)" size={9}>ORCH</MonoTag>}
        {agent.lineageStatus !== 'complete' && <MonoTag color="var(--amber)" bg="rgba(245,166,35,.10)" size={9}>LINEAGE {agent.lineageStatus.toUpperCase()}</MonoTag>}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>{why} · activity {ago(agent.activityAt)} · {agent.totalClaims} claims · {agent.ownerName ?? 'owner unknown'}{agent.runnerId ? ` · Runner ${agent.runnerId}` : ''}</div>
    </div>
    {agent.heldTasks > 0 && <MonoTag color="var(--blue)" bg="rgba(76,157,255,.12)" size={10}>{agent.heldTasks} held</MonoTag>}
    {isAdmin && agent.lifecycle === 'archived' && <Action busy={busy} label="restore visibility" onClick={() => onAction(agent.id, () => api.restoreAgentVisibility(agent.id))} />}
    {isAdmin && (agent.lifecycle === 'retired' || agent.lifecycle === 'revoked') && <Action busy={busy} label="archive" onClick={() => onAction(agent.id, () => api.archiveAgent(agent.id))} />}
    {isAdmin && !['revoked', 'archived'].includes(agent.lifecycle) && <Action danger busy={busy} label="revoke" onClick={async () => { if (await confirm(`Revoke ${agent.name}? Its credential and live presence will end.`)) await onAction(agent.id, () => api.revokeAgent(agent.id)); }} />}
  </div>;
}

function RunnerRow({ runner, busy, onAction }: { runner: ApiRunner; busy: boolean; onAction: (key: string, action: () => Promise<unknown>) => Promise<void> }) {
  const lifecycle = runner.lifecycle ?? (runner.status === 'online' ? 'active' : runner.status === 'offboarded' ? 'retired' : 'dormant');
  const why = lifecycle === 'active' ? 'fresh heartbeat'
    : lifecycle === 'dormant' ? 'heartbeat is stale or daemon reported offline'
      : lifecycle === 'archived' ? `visibility archived · ${runner.retireReason ?? 'retained history'}`
        : `retired · ${runner.retireReason ?? 'lifecycle policy'}`;
  return <div className="hover-border" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px', borderRadius: 11, background: 'var(--w-02)', border: '1px solid var(--w-07)', opacity: lifecycle === 'active' ? 1 : 0.68 }}>
    <span style={{ width: 10, height: 10, borderRadius: '50%', background: lifecycle === 'active' ? '#3fd98b' : runner.status === 'offboarded' ? '#ff5c5c' : '#6b7280' }} />
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', gap: 7, alignItems: 'center' }}>{runner.label}<MonoTag color="var(--text-dim)" bg="var(--w-05)" size={9}>{lifecycle.toUpperCase()}</MonoTag><MonoTag color="var(--text-faint)" bg="var(--w-04)" size={9}>{runner.version ? `v${runner.version}` : 'version unknown'}</MonoTag></div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>{why} · heartbeat {ago(runner.lastHeartbeatAt)} · {runner.agentCount ?? 0} agents · {runner.liveRuns ?? 0} live runs · {runner.ownerName ?? 'owner unknown'}</div>
    </div>
    {lifecycle === 'archived' && <Action busy={busy} label="restore visibility" onClick={() => onAction(runner.id, () => api.restoreRunnerVisibility(runner.id))} />}
    {lifecycle === 'retired' && <Action busy={busy} label="archive" onClick={() => onAction(runner.id, () => api.archiveRunner(runner.id))} />}
    {(lifecycle === 'active' || lifecycle === 'dormant') && <Action danger busy={busy} label="offboard" onClick={async () => { if (await confirm(`Offboard ${runner.label}? This revokes Noriq access and fails live runs, but cannot stop the process on its machine.`)) await onAction(runner.id, () => api.offboardRunner(runner.id)); }} />}
    {runner.eligiblePurge && <Action danger busy={busy} label="purge unused" onClick={async () => { if (await confirm(`Permanently remove unused Runner identity ${runner.label}? This is allowed only because it has no agents or live runs.`)) await onAction(runner.id, () => api.deleteRunner(runner.id)); }} />}
  </div>;
}

function Action({ label, danger = false, busy, onClick }: { label: string; danger?: boolean; busy: boolean; onClick: () => void | Promise<void> }) {
  return <Button variant={danger ? 'danger' : 'ghost'} disabled={busy} style={{ padding: '5px 10px', fontSize: 10 }} onClick={(event) => { event.stopPropagation(); void onClick(); }}>{label}</Button>;
}
