// Runs — the execution plane (RUN-22). Registered runners self-report via the
// daemon; dispatch a Run to an online runner that advertises a repo for THIS
// project, then watch it here. Reads persisted Run state (REST snapshot + a
// short poll) and reuses the store's WS-invalidate signal (store.snapshot) to
// reload on project change. Live token/USD + log tail stream to the daemon and
// are not persisted server-side yet — the view surfaces the budget envelope and
// the terminal exit instead (see the note in the Runs header).
import { useEffect, useMemo, useState } from 'react';
import { api, type ApiRun, type ApiRunner, type DispatchInput, type RunStatus } from '../api';
import type { AppStore } from '../store';
import { LiveDot, MonoTag, SectionLabel } from './bits';
import { Button, ErrorNote, Field, Select, TextArea, TextInput } from './ui';

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const STATUS_STYLE: Record<RunStatus, { color: string; bg: string; live?: boolean }> = {
  queued: { color: 'var(--text-mid)', bg: 'var(--w-06)' },
  dispatched: { color: 'var(--blue)', bg: 'rgba(76,157,255,.12)' },
  running: { color: 'var(--green)', bg: 'rgba(63,217,139,.13)', live: true },
  blocked: { color: '#f5a623', bg: 'rgba(245,166,35,.14)', live: true },
  done: { color: 'var(--green)', bg: 'rgba(63,217,139,.1)' },
  failed: { color: 'var(--red-soft)', bg: 'rgba(255,92,92,.12)' },
  cancelled: { color: 'var(--text-dim)', bg: 'var(--w-05)' },
};

const TERMINAL: RunStatus[] = ['done', 'failed', 'cancelled'];
const KINDS: Array<ApiRun['kind']> = ['scope', 'build', 'verify'];

function fmtBudget(b: ApiRun['budget']): string {
  const parts: string[] = [];
  if (b.maxTokens) parts.push(`${(b.maxTokens / 1000).toLocaleString()}k tok`);
  if (b.maxUsd) parts.push(`$${b.maxUsd}`);
  if (b.maxDurationSeconds) parts.push(`${Math.round(b.maxDurationSeconds / 60)}m`);
  return parts.length ? parts.join(' · ') : 'no ceiling';
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// The live spend readout — tokens burned and USD, each against its ceiling when set.
function fmtSpend(run: ApiRun): string | null {
  const parts: string[] = [];
  if (run.tokensUsed != null) parts.push(`${fmtTokens(run.tokensUsed)}${run.budget.maxTokens ? `/${fmtTokens(run.budget.maxTokens)}` : ''} tok`);
  if (run.usdSpent != null) parts.push(`$${run.usdSpent.toFixed(2)}${run.budget.maxUsd ? `/$${run.budget.maxUsd}` : ''}`);
  return parts.length ? parts.join(' · ') : null;
}

export function RunsView({ store }: { store: AppStore }) {
  const pid = store.currentPid;
  const [runners, setRunners] = useState<ApiRunner[]>([]);
  const [runs, setRuns] = useState<ApiRun[]>([]);
  const [dispatchFor, setDispatchFor] = useState<string | null>(null); // runner id, or null

  const load = async () => {
    try {
      const [rr, ru] = await Promise.all([api.runners(), api.runs(pid)]);
      setRunners(rr.runners);
      setRuns(ru.runs);
    } catch {
      /* transient — the poll will retry */
    }
  };
  useEffect(() => {
    if (!pid) return;
    void load();
    const iv = setInterval(() => void load(), 5000); // Runs are live; poll tighter than the roster
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, store.snapshot]); // reload on project switch + on any WS-driven store refresh

  // A runner can serve this project only via a repo whose committed key resolved here.
  const reposForPid = (r: ApiRunner) => r.repos.filter((repo) => repo.projectId === pid);
  const canDispatch = (r: ApiRunner) => r.status === 'online' && r.freeSlots > 0 && reposForPid(r).length > 0;

  const sortedRuns = useMemo(
    () => [...runs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [runs],
  );
  const liveRuns = sortedRuns.filter((r) => !TERMINAL.includes(r.status));

  if (!pid) return null;

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '18px 22px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 26 }}>
        {/* ---- Runners roster ---- */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <SectionLabel>Runners · {runners.filter((r) => r.status === 'online').length} online</SectionLabel>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
              daemons self-register — run <span style={{ color: 'var(--text-soft)' }}>noriq-runner</span> on a machine
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {runners.map((r) => {
              const repos = reposForPid(r);
              const online = r.status === 'online';
              const offboarded = r.status === 'offboarded';
              const dot = offboarded ? '#ff5c5c' : online ? (r.freeSlots > 0 ? '#3fd98b' : '#f5a623') : '#6b7280';
              return (
                <div key={r.id}>
                  <div
                    className="hover-border"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px', borderRadius: 11,
                      background: 'var(--w-02)', border: '1px solid var(--w-07)', opacity: online ? 1 : 0.55,
                    }}
                  >
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: dot, flex: 'none' }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
                        {r.label}
                        <MonoTag
                          color={offboarded ? 'var(--red-soft)' : 'var(--text-mid)'}
                          bg={offboarded ? 'rgba(255,92,92,.12)' : 'var(--w-05)'}
                          size={9}
                        >
                          {r.status}
                        </MonoTag>
                        {r.capabilities.tools.map((t) => (
                          <MonoTag key={t} color="var(--blue)" bg="rgba(76,157,255,.1)" size={9}>{t}</MonoTag>
                        ))}
                        {/* What code this box runs (RUN-36). You cannot support someone's
                            install without knowing what they are running — and unknown is a
                            different fact from old, so it says so rather than guessing. */}
                        <MonoTag
                          color={r.outdated ? 'var(--amber, #f5a623)' : 'var(--text-faint)'}
                          bg={r.outdated ? 'rgba(245,166,35,.12)' : 'var(--w-04)'}
                          size={9}
                        >
                          {r.version ? `v${r.version}${r.outdated ? ' · update' : ''}` : 'version unknown'}
                        </MonoTag>
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>
                        {offboarded
                          ? `offboarded ${ago(r.offboardedAt)} — token revoked`
                          : `${r.freeSlots}/${r.capabilities.maxConcurrency} slots free · ${repos.length} repo${repos.length === 1 ? '' : 's'} here · heartbeat ${ago(r.lastHeartbeatAt)}`}
                      </div>
                    </div>
                    {/* The kill switch (RUN-35). Confirmed, because it revokes a credential and
                        fails live runs — and honest about its limit: it severs Noriq, it does not
                        reach into the machine. */}
                    {!offboarded && (
                      <Button
                        variant="danger"
                        style={{ padding: '7px 12px', fontSize: 12 }}
                        onClick={async () => {
                          if (!confirm(
                            `Offboard "${r.label}"?\n\nThis revokes its token: no dispatch, no MCP, and its live runs fail.\n\n` +
                            'It does NOT stop the daemon touching that machine\'s repos — stop the process there too.',
                          )) return;
                          const res = await api.offboardRunner(r.id);
                          if (res.warning) alert(res.warning);
                          await load();
                        }}
                      >
                        offboard
                      </Button>
                    )}
                    <Button
                      variant={dispatchFor === r.id ? 'ghost' : 'primary'}
                      disabled={!canDispatch(r)}
                      style={{ padding: '7px 14px', fontSize: 12 }}
                      title={canDispatch(r) ? 'Dispatch a Run to this runner' : 'runner must be online, have a free slot, and advertise a repo for this project'}
                      onClick={() => setDispatchFor(dispatchFor === r.id ? null : r.id)}
                    >
                      {dispatchFor === r.id ? 'cancel' : 'dispatch →'}
                    </Button>
                  </div>
                  {dispatchFor === r.id && (
                    <DispatchForm
                      store={store}
                      runner={r}
                      pid={pid}
                      onDone={() => {
                        setDispatchFor(null);
                        void load();
                      }}
                    />
                  )}
                </div>
              );
            })}
            {!runners.length && (
              <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                no runners registered — start the Noriq Runner daemon on a machine with a checkout of this project
              </div>
            )}
          </div>
        </section>

        {/* ---- Runs ---- */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <SectionLabel>Runs · {liveRuns.length} live</SectionLabel>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
              live token/$ &amp; log tail stream to the daemon — the envelope &amp; exit show here
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sortedRuns.map((run) => (
              <RunRow key={run.id} run={run} runner={runners.find((r) => r.id === run.runnerId) ?? null} onCancel={load} />
            ))}
            {!sortedRuns.length && (
              <div style={{ padding: 40, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                no runs yet — dispatch one to a runner above
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function RunRow({ run, runner, onCancel }: { run: ApiRun; runner: ApiRunner | null; onCancel: () => void }) {
  const [killing, setKilling] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const st = STATUS_STYLE[run.status];
  const repo = runner?.repos.find((r) => r.id === run.repoRef);
  const terminal = TERMINAL.includes(run.status);
  const spend = fmtSpend(run);

  return (
    <div
      className="hover-border"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12, padding: '13px 15px', borderRadius: 11,
        background: 'var(--w-02)', border: '1px solid var(--w-07)',
      }}
    >
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', marginTop: 1,
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
          color: st.color, background: st.bg, padding: '3px 8px', borderRadius: 6, minWidth: 78, justifyContent: 'center',
        }}
      >
        {st.live && <LiveDot color={st.color} size={5} />}
        {run.status}
      </span>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <MonoTag color="var(--accent-ink)" bg="rgba(198,242,78,.12)" size={9}>{run.kind}</MonoTag>
          <MonoTag color="var(--blue)" bg="rgba(76,157,255,.1)" size={9}>{run.agentTool}</MonoTag>
          <span style={{ color: 'var(--text-soft)' }}>{repo?.name ?? run.repoRef}</span>
          {run.anchor && (
            <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9}>
              {run.anchor.type === 'task' ? `task ${run.anchor.taskId.slice(-6)}` : `plan ${run.anchor.planId.slice(-6)}`}
            </MonoTag>
          )}
        </div>
        {run.brief && (
          <div style={{ fontSize: 12, color: 'var(--text-mid)', marginTop: 4, lineHeight: 1.45, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {run.brief}
          </div>
        )}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 5, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {spend
            ? <span style={{ color: st.live ? 'var(--text-soft)' : 'var(--text-dim)' }}>spent {spend}</span>
            : <span>budget {fmtBudget(run.budget)}</span>}
          <span>· {ago(run.startedAt ?? run.dispatchedAt ?? run.createdAt)}</span>
          {run.worktreePath && <span title={run.worktreePath}>· ⌥ {run.worktreePath.split('/').slice(-2).join('/')}</span>}
          {run.logTail && (
            <button
              onClick={() => setShowLog((s) => !s)}
              style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-mid)', background: 'var(--w-05)', border: '1px solid var(--w-08)', borderRadius: 5, padding: '1px 7px' }}
            >
              {showLog ? '▾ log' : '▸ log'}
            </button>
          )}
        </div>
        {showLog && run.logTail && (
          <pre
            style={{
              margin: '8px 0 2px', padding: '9px 11px', borderRadius: 8, maxHeight: 220, overflow: 'auto',
              background: 'var(--bg)', border: '1px solid var(--w-07)',
              fontFamily: 'var(--mono)', fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-soft)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}
          >
            {run.logTail}
          </pre>
        )}
        {terminal && run.exit && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: st.color, marginTop: 5 }}>
            exit: {run.exit.outcome}
            {run.exit.signal ? ` · ${run.exit.signal}` : ''}
            {run.exit.code !== null && run.exit.code !== undefined ? ` · code ${run.exit.code}` : ''}
            {run.exit.reason ? ` — ${run.exit.reason}` : ''}
          </div>
        )}
      </div>

      {!terminal && (
        <Button
          variant="danger"
          disabled={killing}
          style={{ padding: '5px 12px', fontSize: 11, flex: 'none' }}
          onClick={async () => {
            if (!confirm('Kill this Run? The daemon SIGTERMs the agent process; work so far stays on its branch.')) return;
            setKilling(true);
            try {
              await api.cancelRun(run.id, 'cancelled from dashboard');
              onCancel();
            } finally {
              setKilling(false);
            }
          }}
        >
          {killing ? '…' : 'kill'}
        </Button>
      )}
    </div>
  );
}

function DispatchForm({
  store,
  runner,
  pid,
  onDone,
}: {
  store: AppStore;
  runner: ApiRunner;
  pid: string;
  onDone: () => void;
}) {
  const repos = runner.repos.filter((r) => r.projectId === pid);
  const kinds = KINDS.filter((k) => runner.capabilities.kinds.includes(k));
  const tools = runner.capabilities.tools;
  const tasks = store.helpers.tasksOf(pid);

  const [repoRef, setRepoRef] = useState(repos[0]?.id ?? '');
  const [kind, setKind] = useState<ApiRun['kind']>(kinds[0] ?? 'build');
  const [agentTool, setAgentTool] = useState(tools[0] ?? '');
  const [brief, setBrief] = useState('');
  const [anchorTask, setAnchorTask] = useState(''); // '' = no anchor
  const [maxUsd, setMaxUsd] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [maxMinutes, setMaxMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const num = (s: string): number | null => {
    const n = Number(s.trim());
    return s.trim() && Number.isFinite(n) && n > 0 ? n : null;
  };

  const submit = async () => {
    setErr(null);
    if (!repoRef) return setErr('pick a repo');
    if (!kind) return setErr('this runner advertises no run kinds');
    if (!agentTool) return setErr('this runner advertises no agent tools');
    if (!brief.trim() && !anchorTask) return setErr('give a brief or anchor to a task');
    const body: DispatchInput = {
      runnerId: runner.id,
      kind,
      agentTool,
      repoRef,
      brief: brief.trim(),
      anchor: anchorTask ? { type: 'task', id: anchorTask } : null,
      budget: { maxUsd: num(maxUsd), maxTokens: num(maxTokens), maxDurationSeconds: maxMinutes.trim() ? (num(maxMinutes) ?? 0) * 60 : null },
    };
    setBusy(true);
    try {
      await api.dispatchRun(pid, body);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'dispatch failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ margin: '6px 0 2px', padding: '15px 16px', borderRadius: 11, background: 'var(--w-04)', border: '1px solid var(--w-1)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <Field label="repo">
          <Select value={repoRef} onChange={(e) => setRepoRef(e.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>{r.name || r.projectKey}{r.defaultBranch ? ` (${r.defaultBranch})` : ''}</option>
            ))}
          </Select>
        </Field>
        <Field label="kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value as ApiRun['kind'])}>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </Select>
        </Field>
        <Field label="agent">
          <Select value={agentTool} onChange={(e) => setAgentTool(e.target.value)}>
            {tools.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
      </div>

      <Field label="brief" hint="what this Run should do (or anchor to a task below)">
        <TextArea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="e.g. implement the RunsView dispatch form and verify with tsc + tests" />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
        <Field label="anchor task" hint="optional">
          <Select value={anchorTask} onChange={(e) => setAnchorTask(e.target.value)}>
            <option value="">— none —</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.key} · {t.title.slice(0, 40)}</option>)}
          </Select>
        </Field>
        <Field label="max $" hint="optional">
          <TextInput value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} inputMode="decimal" placeholder="—" />
        </Field>
        <Field label="max tokens" hint="optional">
          <TextInput value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} inputMode="numeric" placeholder="—" />
        </Field>
        <Field label="max minutes" hint="optional">
          <TextInput value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} inputMode="numeric" placeholder="—" />
        </Field>
      </div>

      {err && <ErrorNote>{err}</ErrorNote>}

      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <Button variant="primary" disabled={busy} onClick={submit} style={{ padding: '8px 18px' }}>
          {busy ? 'dispatching…' : 'dispatch Run'}
        </Button>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', alignSelf: 'center' }}>
          → {runner.label}
        </span>
      </div>
    </div>
  );
}
