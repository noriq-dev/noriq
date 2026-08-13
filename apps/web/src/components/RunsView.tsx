// Runner Jobs — the minimal protocol-v2 control-plane surface. Noriq chooses only
// the immutable task/plan target and a runner repository; the committed project
// configuration remains the authority for models, workflows, budgets, and Git mode.
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type ApiRun,
  type ApiRunner,
  type ApiRunnerJobDetail,
  type ApiRunnerJobOutput,
  type ApiRunnerJobSummary,
  type RunnerJobStatus,
  type RunStatus,
} from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { Button, ErrorNote, Field, Select, TextArea } from './ui';
import { confirm } from './Dialog';

// Retained for the read-only legacy-history renderer and its regression test.
export const RUN_STATUS_STYLE: Record<RunStatus, { color: string; bg: string; live?: boolean }> = {
  queued: { color: 'var(--text-mid)', bg: 'var(--w-06)' },
  dispatched: { color: 'var(--blue)', bg: 'rgba(76,157,255,.12)' },
  running: { color: 'var(--green)', bg: 'rgba(63,217,139,.13)', live: true },
  blocked: { color: '#f5a623', bg: 'rgba(245,166,35,.14)', live: true },
  done: { color: 'var(--green)', bg: 'rgba(63,217,139,.1)' },
  gated: { color: '#f5a623', bg: 'rgba(245,166,35,.14)' },
  failed: { color: 'var(--red-soft)', bg: 'rgba(255,92,92,.12)' },
  cancelled: { color: 'var(--text-dim)', bg: 'var(--w-05)' },
};

export const JOB_STATUS_STYLE: Record<RunnerJobStatus, { color: string; bg: string }> = {
  queued: { color: 'var(--text-mid)', bg: 'var(--w-06)' },
  assigned: { color: 'var(--blue)', bg: 'rgba(76,157,255,.12)' },
  running: { color: 'var(--green)', bg: 'rgba(63,217,139,.13)' },
  waiting: { color: '#f5a623', bg: 'rgba(245,166,35,.14)' },
  succeeded: { color: 'var(--green)', bg: 'rgba(63,217,139,.1)' },
  partial: { color: '#f5a623', bg: 'rgba(245,166,35,.14)' },
  failed: { color: 'var(--red-soft)', bg: 'rgba(255,92,92,.12)' },
  cancelled: { color: 'var(--text-dim)', bg: 'var(--w-05)' },
};

const TERMINAL_JOBS: RunnerJobStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function shortRevision(revision: string | null | undefined): string {
  return revision ? (revision.length > 18 ? `${revision.slice(0, 18)}…` : revision) : '—';
}

function jobTarget(job: ApiRunnerJobSummary, store: AppStore): string {
  if (job.sourceKind === 'task') {
    const task = store.helpers.allTasksOf(store.currentPid).find((candidate) => candidate.id === job.sourceId);
    return task ? `${task.key} · ${task.title}` : job.sourceId;
  }
  const plan = store.snapshot?.plans.find((candidate) => candidate.id === job.sourceId);
  return plan?.title ?? job.sourceId;
}

export function RunsView({ store }: { store: AppStore }) {
  const pid = store.currentPid;
  const [runners, setRunners] = useState<ApiRunner[]>([]);
  const [jobs, setJobs] = useState<ApiRunnerJobSummary[]>([]);
  const [legacyRuns, setLegacyRuns] = useState<ApiRun[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApiRunnerJobDetail | null>(null);
  const [showDispatch, setShowDispatch] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!pid) return;
    try {
      const [runnerResult, jobResult] = await Promise.all([
        api.runners({ view: 'active', projectId: pid, limit: 100 }),
        api.runnerJobs(pid),
      ]);
      setRunners(runnerResult.runners);
      setJobs(jobResult.jobs);
      if (selectedId) setDetail(await api.runnerJob(pid, selectedId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load Runner jobs');
    }
  };

  useEffect(() => {
    if (!pid) return;
    void load();
    const interval = setInterval(() => void load(), 5000);
    return () => clearInterval(interval);
    // Store snapshots change when the project event stream invalidates this read model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, store.snapshot, selectedId]);

  const sortedJobs = useMemo(
    () => [...jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [jobs],
  );
  const liveCount = sortedJobs.filter((job) => !TERMINAL_JOBS.includes(job.status)).length;
  if (!pid) return null;

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '18px 22px' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <div>
              <SectionLabel>Runner jobs · {liveCount} live</SectionLabel>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                Dispatch a task or plan. Agent routing, limits, checks, and Git behavior come from the repository.
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <Button variant={showDispatch ? 'ghost' : 'primary'} onClick={() => setShowDispatch(!showDispatch)}>
              {showDispatch ? 'close' : 'dispatch job'}
            </Button>
          </div>
          {showDispatch && (
            <RunnerJobDispatchForm
              store={store}
              runners={runners}
              onDone={async (jobId) => {
                setShowDispatch(false);
                setSelectedId(jobId);
                await load();
              }}
            />
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
        </section>

        <section style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, .9fr) minmax(0, 1.5fr)', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sortedJobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                title={jobTarget(job, store)}
                selected={selectedId === job.id}
                onClick={() => setSelectedId(job.id)}
              />
            ))}
            {!sortedJobs.length && (
              <EmptyState>no Runner jobs yet</EmptyState>
            )}
          </div>
          <div>
            {detail ? (
              <JobDetail
                detail={detail}
                onRefresh={load}
                onCancel={async () => {
                  if (!(await confirm('Cancel this Runner job? Accepted commits remain on its local output branch.'))) return;
                  await api.cancelRunnerJob(pid, detail.job.id);
                  await load();
                }}
              />
            ) : (
              <EmptyState>select a job to inspect its evidence and retained Git result</EmptyState>
            )}
          </div>
        </section>

        <section style={{ borderTop: '1px solid var(--w-06)', paddingTop: 14 }}>
          <Button
            variant="ghost"
            onClick={async () => {
              if (legacyRuns === null) setLegacyRuns((await api.runs(pid)).runs);
              else setLegacyRuns(null);
            }}
          >
            {legacyRuns === null ? 'show legacy Run history' : 'hide legacy Run history'}
          </Button>
          {legacyRuns !== null && <LegacyHistory runs={legacyRuns} />}
        </section>
      </div>
    </div>
  );
}

function RunnerJobDispatchForm({
  store,
  runners,
  onDone,
}: {
  store: AppStore;
  runners: ApiRunner[];
  onDone: (jobId: string) => Promise<void>;
}) {
  const pid = store.currentPid;
  const candidates = runners.filter((runner) => runner.status === 'online' && runner.repos.some((repo) => repo.projectId === pid));
  const [kind, setKind] = useState<'task' | 'plan'>('task');
  const [targetId, setTargetId] = useState('');
  const [runnerId, setRunnerId] = useState(candidates[0]?.id ?? '');
  const runner = candidates.find((candidate) => candidate.id === runnerId) ?? null;
  const repos = runner?.repos.filter((repo) => repo.projectId === pid) ?? [];
  const [repoRef, setRepoRef] = useState(repos[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tasks = store.helpers.allTasksOf(pid).filter((task) => task.status === 'todo' || task.status === 'failed');
  const plans = (store.snapshot?.plans ?? []).filter((plan) => !plan.archivedAt && plan.status !== 'proposed');

  useEffect(() => {
    const selected = candidates.find((candidate) => candidate.id === runnerId);
    setRepoRef(selected?.repos.find((repo) => repo.projectId === pid)?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnerId, pid]);
  useEffect(() => {
    setTargetId(kind === 'task' ? (tasks[0]?.id ?? '') : (plans[0]?.id ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const submit = async () => {
    if (!runnerId || !repoRef || !targetId) return setError('Select a target, runner, and repository.');
    setBusy(true);
    setError(null);
    try {
      const result = kind === 'task'
        ? await api.dispatchTaskJob(pid, targetId, { runnerId, repoRef })
        : await api.dispatchPlanJob(pid, targetId, { runnerId, repoRef });
      await onDone(result.job.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Dispatch failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 15, marginBottom: 16, borderRadius: 11, background: 'var(--w-03)', border: '1px solid var(--w-08)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
        <Field label="source">
          <Select value={kind} onChange={(event) => setKind(event.target.value as 'task' | 'plan')}>
            <option value="task">individual task</option>
            <option value="plan">entire plan</option>
          </Select>
        </Field>
        <Field label={kind}>
          <Select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            {(kind === 'task' ? tasks : plans).map((target) => (
              <option key={target.id} value={target.id}>
                {'key' in target ? `${target.key} · ${target.title}` : target.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="runner">
          <Select value={runnerId} onChange={(event) => setRunnerId(event.target.value)}>
            {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            {!candidates.length && <option value="">— no protocol-v2 runner online —</option>}
          </Select>
        </Field>
        <Field label="repository">
          <Select value={repoRef} onChange={(event) => setRepoRef(event.target.value)}>
            {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name || repo.projectKey}</option>)}
          </Select>
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
        <Button variant="primary" disabled={busy || !targetId || !runnerId || !repoRef} onClick={submit}>
          {busy ? 'dispatching…' : `dispatch ${kind}`}
        </Button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
          Only runnerId and repoRef cross the control-plane boundary.
        </span>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

function JobRow({ job, title, selected, onClick }: { job: ApiRunnerJobSummary; title: string; selected: boolean; onClick: () => void }) {
  const style = JOB_STATUS_STYLE[job.status];
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%', textAlign: 'left', color: 'inherit', cursor: 'pointer', padding: '12px 13px', borderRadius: 10,
        border: `1px solid ${selected ? 'var(--blue)' : 'var(--w-07)'}`, background: selected ? 'rgba(76,157,255,.05)' : 'var(--w-02)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <MonoTag color={style.color} bg={style.bg} size={9}>{job.status}</MonoTag>
        <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 7, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>
        <span>{job.phase}</span><span>·</span><span>{Math.round(job.progress * 100)}%</span><span>·</span><span>{ago(job.updatedAt)}</span>
      </div>
    </button>
  );
}

function JobDetail({ detail, onRefresh, onCancel }: { detail: ApiRunnerJobDetail; onRefresh: () => Promise<void>; onCancel: () => Promise<void> }) {
  const { job, items, questions } = detail;
  const output = job.finalResult;
  const statusStyle = JOB_STATUS_STYLE[job.status];
  return (
    <div style={{ borderRadius: 11, border: '1px solid var(--w-07)', background: 'var(--w-02)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <MonoTag color={statusStyle.color} bg={statusStyle.bg} size={10}>{job.status}</MonoTag>
        <strong style={{ fontSize: 14 }}>{job.sourceKind} job</strong>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>{job.id}</span>
        <div style={{ flex: 1 }} />
        {!TERMINAL_JOBS.includes(job.status) && <Button variant="danger" onClick={onCancel}>cancel</Button>}
      </div>
      <div style={{ height: 4, borderRadius: 4, background: 'var(--w-07)', margin: '14px 0' }}>
        <div style={{ width: `${Math.max(1, job.progress * 100)}%`, height: '100%', borderRadius: 4, background: statusStyle.color }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 8, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
        <span>phase <b>{job.phase}</b></span>
        <span>events <b>{job.lastEventSeq}</b></span>
        <span>warnings <b>{job.warningCount}</b></span>
        <span>updated <b>{ago(job.updatedAt)}</b></span>
      </div>

      {questions.filter((question) => question.state === 'open').map((question) => (
        <Question key={question.questionId} pid={job.id} question={question} onAnswered={onRefresh} projectId={job.snapshot && typeof job.snapshot === 'object' && 'projectId' in job.snapshot ? String((job.snapshot as { projectId: unknown }).projectId) : ''} />
      ))}

      <Section title="Tasks">
        {items.map((item) => (
          <div key={item.taskId} style={{ padding: '9px 0', borderBottom: '1px solid var(--w-05)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <MonoTag color="var(--text-mid)" bg="var(--w-06)" size={9}>{item.status}</MonoTag>
              <strong style={{ fontSize: 12 }}>{item.taskKey}</strong>
              {item.checkpointRef && <code style={{ fontSize: 10 }}>{shortRevision(item.checkpointRef)}</code>}
            </div>
            {item.summary && <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 5 }}>{item.summary}</div>}
            {item.projectionConflict && <div style={{ color: '#f5a623', fontSize: 11, marginTop: 5 }}>Task status changed by a human; Runner projection was not applied.</div>}
          </div>
        ))}
      </Section>
      {output && <Output output={output} />}
    </div>
  );
}

function Question({ projectId, pid: jobId, question, onAnswered }: { projectId: string; pid: string; question: ApiRunnerJobDetail['questions'][number]; onAnswered: () => Promise<void> }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 14, padding: 12, border: '1px solid rgba(245,166,35,.25)', borderRadius: 9, background: 'rgba(245,166,35,.05)' }}>
      <div style={{ fontSize: 12, marginBottom: 8 }}>{question.prompt}</div>
      <TextArea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Answer the Runner" />
      <Button
        variant="primary"
        disabled={busy || !answer.trim() || !projectId}
        style={{ marginTop: 8 }}
        onClick={async () => {
          setBusy(true);
          try { await api.answerRunnerJobQuestion(projectId, jobId, question.questionId, answer.trim()); await onAnswered(); }
          finally { setBusy(false); }
        }}
      >
        {busy ? 'sending…' : 'send answer'}
      </Button>
    </div>
  );
}

function Output({ output }: { output: ApiRunnerJobOutput }) {
  return (
    <Section title="Retained output">
      <div style={{ padding: 11, borderRadius: 8, background: 'rgba(76,157,255,.06)', border: '1px solid rgba(76,157,255,.18)', fontSize: 11.5, lineHeight: 1.55 }}>
        <strong>Human merge required.</strong> Runner retained this work locally and did not push, merge another branch, or open a pull request.
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: '100px minmax(0, 1fr)', gap: '6px 10px', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
        <dt>mode</dt><dd>{output.workspaceMode}</dd>
        <dt>VCS</dt><dd>{output.retainedLocation.vcs}</dd>
        <dt>location</dt><dd style={{ overflowWrap: 'anywhere' }}>{output.retainedLocation.url ? <a href={output.retainedLocation.url}>{output.retainedLocation.label}</a> : output.retainedLocation.label}</dd>
        <dt>base</dt><dd>{shortRevision(output.baseRevision)}</dd>
        <dt>head</dt><dd>{shortRevision(output.headRevision)}</dd>
      </dl>
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>{output.summary}</div>
      <div style={{ marginTop: 9, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
        {output.usage.calls} calls · {(output.usage.inputTokens + output.usage.outputTokens).toLocaleString()} tokens
        {output.usage.costUsd != null ? ` · $${output.usage.costUsd.toFixed(4)}` : ''}
      </div>
      {output.checks.map((check, index) => (
        <details key={`${check.command}-${index}`} style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: check.exitCode === 0 && !check.timedOut ? 'var(--green)' : 'var(--red-soft)' }}>
            check: {check.command} ({check.timedOut ? 'timed out' : `exit ${check.exitCode ?? 'none'}`})
          </summary>
          <pre style={{ overflowX: 'auto', whiteSpace: 'pre-wrap', fontSize: 10 }}>{check.output}</pre>
        </details>
      ))}
      {output.findings.map((finding, index) => (
        <div key={`${finding.title}-${index}`} style={{ marginTop: 8, fontSize: 11.5 }}>
          <MonoTag color={finding.severity === 'minor' ? '#f5a623' : 'var(--red-soft)'} bg="var(--w-06)" size={9}>{finding.severity}</MonoTag>{' '}
          <strong>{finding.title}</strong> — {finding.body}
        </div>
      ))}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={{ marginTop: 16 }}><SectionLabel>{title}</SectionLabel><div style={{ marginTop: 7 }}>{children}</div></section>;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 34, textAlign: 'center', border: '1px dashed var(--w-08)', borderRadius: 10, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>{children}</div>;
}

function LegacyHistory({ runs }: { runs: ApiRun[] }) {
  if (!runs.length) return <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-faint)' }}>No legacy Runs.</div>;
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {runs.map((run) => {
        const style = RUN_STATUS_STYLE[run.status];
        return (
          <div key={run.id} style={{ padding: '9px 11px', border: '1px solid var(--w-06)', borderRadius: 8, opacity: .72 }}>
            <MonoTag color={style.color} bg={style.bg} size={9}>{run.status}</MonoTag>{' '}
            <span style={{ fontSize: 11.5 }}>{run.brief}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', marginLeft: 8 }}>{ago(run.updatedAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
