// Runs — the execution plane (RUN-22). Registered runners self-report via the
// daemon; dispatch a Run to an online runner that advertises a repo for THIS
// project, then watch it here. Reads persisted Run state (REST snapshot + a
// short poll) and reuses the store's WS-invalidate signal (store.snapshot) to
// reload on project change. Live token/USD + log tail stream to the daemon and
// are not persisted server-side yet — the view surfaces the budget envelope and
// the terminal exit instead (see the note in the Runs header).
import { useEffect, useMemo, useState } from 'react';
import { api, type ApiRun, type ApiRunLogSegment, type ApiRunner, type DispatchInput, type RunEffort, type RunStatus } from '../api';
import type { AppStore } from '../store';
import { Markdown } from './Markdown';
import { LiveDot, MonoTag, SectionLabel } from './bits';
import { Button, ErrorNote, Field, Select, TextArea, TextInput } from './ui';
import { alert, confirm } from './Dialog';

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
/** Tool-agnostic intent (RUN-33) — each driver maps it. Codex tops out at 'high' and clamps
 *  the last two; the daemon does that translation, so this list stays what we MEAN. */
const EFFORTS: RunEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * What the pill says (RUN-31). A running Run spends its last 60–90s in the verify gate and then
 * the landing rebase — agent process already gone, spend frozen — so a blanket "running" made a
 * gate doing its job read as a hung agent.
 *
 * This replaces the WORD, not the status: it stays styled live because it genuinely is live.
 * 'agent' gets no special label — "running" already means that to a reader.
 */
const runLabel = (run: ApiRun): string =>
  run.status === 'running' && run.phase && run.phase !== 'agent' ? run.phase : run.status;

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
                            different fact from old, so it says so rather than guessing.
                            Whether it is CURRENT is the runner's business: it checks its own
                            repo and says so on that box (RUN-37). */}
                        <MonoTag color="var(--text-faint)" bg="var(--w-04)" size={9}>
                          {r.version ? `v${r.version}` : 'version unknown'}
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
                          if (!(await confirm(
                            `Offboard "${r.label}"?\n\nThis revokes its token: no dispatch, no MCP, and its live runs fail.\n\n` +
                            'It does NOT stop the daemon touching that machine\'s repos — stop the process there too.',
                          ))) return;
                          const res = await api.offboardRunner(r.id);
                          if (res.warning) await alert(res.warning);
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
        {runLabel(run)}
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
          <button
            onClick={() => setShowLog((s) => !s)}
            style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-mid)', background: 'var(--w-05)', border: '1px solid var(--w-08)', borderRadius: 5, padding: '1px 7px' }}
          >
            {showLog ? '▾ transcript' : '▸ transcript'}
          </button>
        </div>
        {showLog && <RunTranscript run={run} live={!terminal} />}
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
            if (!(await confirm('Kill this Run? The daemon SIGTERMs the agent process; work so far stays on its branch.'))) return;
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

/** Who said each part of the transcript (RUN-74). `agent` is labeled by the run's own kind. */
const ROLE_STYLE: Record<string, { color: string; bg: string }> = {
  agent: { color: 'var(--blue)', bg: 'rgba(76,157,255,.1)' },
  reviewer: { color: '#f5a623', bg: 'rgba(245,166,35,.14)' },
  verify: { color: 'var(--green)', bg: 'rgba(63,217,139,.1)' },
  system: { color: 'var(--text-dim)', bg: 'var(--w-05)' },
};

/**
 * The run's transcript stream (RUN-74): build → reviewer round 1 → fix → reviewer round 2 → …
 * Exists because the old log box showed only the core agent's tail — after a reviewer
 * refusal, the WHY was invisible. Falls back to logTail for runs predating segments.
 */
function RunTranscript({ run, live }: { run: ApiRun; live: boolean }) {
  const [segments, setSegments] = useState<ApiRunLogSegment[] | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const { segments } = await api.runLog(run.id);
        if (!stop) setSegments(segments);
      } catch {
        /* transient — poll retries */
      }
    };
    void load();
    if (!live) return;
    const iv = setInterval(() => void load(), 5000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, live]);

  // Merge consecutive segments from the same voice into one block, so the stream reads as
  // turns, not as the daemon's flush cadence.
  const blocks: Array<{ role: string; round: number | null; text: string }> = [];
  for (const s of segments ?? []) {
    const last = blocks.at(-1);
    if (last && last.role === s.role && last.round === s.round) last.text += s.text;
    else blocks.push({ role: s.role, round: s.round, text: s.text });
  }

  if (!blocks.length) {
    // Nothing streamed (old daemon, or nothing said yet) — the rolling tail is still honest.
    if (!run.logTail) return null;
    return (
      <div style={{ margin: '8px 0 2px', padding: '9px 11px', borderRadius: 8, maxHeight: 220, overflow: 'auto', background: 'var(--bg)', border: '1px solid var(--w-07)', fontSize: 11.5, wordBreak: 'break-word' }}>
        <Markdown source={run.logTail} compact breaks />
      </div>
    );
  }

  return (
    <div style={{ margin: '8px 0 2px', maxHeight: 380, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {blocks.map((b, i) => {
        const st = ROLE_STYLE[b.role] ?? ROLE_STYLE.system!;
        const label =
          b.role === 'agent' ? run.kind
          : b.role === 'reviewer' ? `reviewer${b.round ? ` · round ${b.round}` : ''}`
          : b.role === 'verify' ? 'verify cmd'
          : 'runner';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only and stable by position
          <div key={i} style={{ borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--w-07)' }}>
            <div style={{ padding: '5px 10px 0' }}>
              <span
                style={{
                  fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
                  color: st.color, background: st.bg, padding: '2px 7px', borderRadius: 5,
                }}
              >
                {label}
              </span>
            </div>
            <div style={{ padding: '4px 11px 9px', fontSize: 11.5, wordBreak: 'break-word' }}>
              {/* Streamed conversational output — one newline = one line break (PLNR-172). */}
              <Markdown source={b.text} compact breaks />
            </div>
          </div>
        );
      })}
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

  const [repoRef, setRepoRef] = useState(repos[0]?.id ?? '');
  // The board lock (RUN-71): a locked repo's anchor list shows its own board's tasks —
  // anchoring it to work that lives elsewhere is almost always a mis-click, and the lock
  // exists precisely so this repo's work stays on its board.
  const lockedBoard = repos.find((r) => r.id === repoRef)?.boardId ?? null;
  const tasks = store.helpers.tasksOf(pid).filter((t) => !lockedBoard || t.boardId === lockedBoard);
  const [kind, setKind] = useState<ApiRun['kind']>(kinds[0] ?? 'build');
  const [agentTool, setAgentTool] = useState(tools[0] ?? '');
  const [brief, setBrief] = useState('');
  const [anchorTask, setAnchorTask] = useState(''); // '' = no anchor
  const [targetBranch, setTargetBranch] = useState(''); // '' = the repo's own choice (RUN-41)
  // '' = don't override (RUN-33): the repo's [defaults] for this kind, then the tool's own.
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<RunEffort | ''>('');
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
      // Empty = don't override. Sending '' would be an override to a branch named "".
      targetBranch: targetBranch.trim() || null,
      // Same rule (RUN-33): blank means "whatever the repo/tool would have picked", so it must
      // travel as null. Sending '' would be a request for a model named "".
      model: model.trim() || null,
      effort: effort || null,
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
              <option key={r.id} value={r.id}>
                {r.name || r.projectKey}{r.defaultBranch ? ` (${r.defaultBranch})` : ''}{r.board ? ` · board ${r.board}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="branch (optional)">
          {/* Blank = wherever the repo lands runs by default — its working branch, or the
              per-plan one (RUN-28). Naming something else only works if the repo opted in via
              [land].allowedBranches; the daemon refuses otherwise rather than quietly using the
              default, since silently landing an agent's diff somewhere nobody asked for is how it
              ends up somewhere nobody looks. */}
          <TextInput
            value={targetBranch}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTargetBranch(e.target.value)}
            placeholder="repo default"
          />
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
        <Field label="model (optional)">
          {/* Free text, not a dropdown: model names belong to the vendor and change constantly,
              so a hardcoded list would go stale and would reject a model the operator's own CLI
              supports. Blank = the repo's [defaults] for this kind, then the tool's own. */}
          <TextInput
            value={model}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setModel(e.target.value)}
            placeholder="repo default"
          />
        </Field>
        <Field label="effort (optional)">
          <Select value={effort} onChange={(e) => setEffort(e.target.value as RunEffort | '')}>
            <option value="">repo default</option>
            {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
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
