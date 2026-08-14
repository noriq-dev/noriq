// Runner Jobs — the minimal protocol-v2 control-plane surface. Noriq chooses only
// the immutable task/plan target and a runner repository; the committed project
// configuration remains the authority for models, workflows, budgets, and Git mode.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ApiRun,
  type ApiRunner,
  type ApiRunnerJobDetail,
  type ApiRunnerJobIntelligenceDetail,
  type ApiRunnerJobMetric,
  type ApiRunnerJobObservation,
  type ApiRunnerJobObservationPage,
  type ApiRunnerJobOutput,
  type ApiRunnerJobSummary,
  type RunnerJobStatus,
  type RunStatus,
} from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { Button, ErrorNote, Field, Select, TextArea } from './ui';
import { confirm } from './Dialog';
import { TaskSearchSelect } from './TaskSearchSelect';
import { PlanSearchSelect } from './PlanSearchSelect';

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

  useEffect(() => {
    const requestedJob = new URLSearchParams(window.location.search).get('job');
    if (requestedJob) setSelectedId(requestedJob);
  }, [pid]);

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

        <section className="runner-job-layout">
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
                projectId={pid}
                onRefresh={load}
                onCancel={async () => {
                  if (!(await confirm('Cancel this Runner job? Accepted commits remain on its local output branch.'))) return;
                  await api.cancelRunnerJob(pid, detail.job.id);
                  await load();
                }}
                onLand={async () => {
                  const target = detail.job.landingTarget ?? 'the configured target';
                  if (!(await confirm(`Accept this reviewed output and ask Runner to land it into ${target}?`))) return;
                  await api.landRunnerJob(pid, detail.job.id);
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

export function RunnerJobDispatchForm({
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
  const plans = (store.snapshot?.plans ?? []).filter((plan) => !plan.archivedAt && plan.status === 'active');

  useEffect(() => {
    const selected = candidates.find((candidate) => candidate.id === runnerId);
    setRepoRef(selected?.repos.find((repo) => repo.projectId === pid)?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnerId, pid]);
  useEffect(() => {
    setTargetId('');
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
          {kind === 'task' ? (
            <TaskSearchSelect
              projectId={pid}
              value={targetId}
              onChange={setTargetId}
              initialTasks={tasks}
              searchStatuses={['todo', 'failed']}
              label="Task"
              placeholder="Search todo or failed tasks…"
              disabled={busy}
            />
          ) : (
            <PlanSearchSelect
              projectId={pid}
              value={targetId}
              onChange={setTargetId}
              initialPlans={plans}
              status="active"
              label="Plan"
              placeholder="Search active plans…"
              disabled={busy}
            />
          )}
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

function JobDetail({ detail, projectId, onRefresh, onCancel, onLand }: {
  detail: ApiRunnerJobDetail;
  projectId: string;
  onRefresh: () => Promise<void>;
  onCancel: () => Promise<void>;
  onLand: () => Promise<void>;
}) {
  const { job, items, questions } = detail;
  const output = job.finalResult;
  const statusStyle = JOB_STATUS_STYLE[job.status];
  const canLand = job.status === 'succeeded'
    && ['manual', 'auto'].includes(job.landingPolicy)
    && ['retained', 'failed'].includes(job.landingStatus);
  const landingPending = ['requested', 'landing'].includes(job.landingStatus);
  return (
    <div style={{ borderRadius: 11, border: '1px solid var(--w-07)', background: 'var(--w-02)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <MonoTag color={statusStyle.color} bg={statusStyle.bg} size={10}>{job.status}</MonoTag>
        <strong style={{ fontSize: 14 }}>{job.sourceKind} job</strong>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>{job.id}</span>
        <div style={{ flex: 1 }} />
        {canLand && <Button variant="primary" onClick={onLand}>{job.landingStatus === 'failed' ? 'retry landing' : 'accept & land'}</Button>}
        {landingPending && <Button variant="ghost" disabled>landing requested</Button>}
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
      <ObservationInspector
        projectId={projectId}
        jobId={job.id}
        items={items}
        terminal={TERMINAL_JOBS.includes(job.status)}
      />
      {output && <Output output={output} job={job} />}
    </div>
  );
}

function metricText(metric: ApiRunnerJobMetric | null, suffix = ''): string {
  if (!metric || metric.value == null) return metric?.status?.replace('_', ' ') ?? 'pending';
  return `${metric.value.toLocaleString()}${suffix}${metric.status === 'partial' ? ' partial' : ''}`;
}

function durationText(value: number | null): string {
  if (value == null) return 'unavailable';
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function observationLabel(observation: ApiRunnerJobObservation, items: ApiRunnerJobDetail['items']): string {
  if (!observation.taskId) return 'job overhead';
  return items.find((item) => item.taskId === observation.taskId)?.taskKey ?? observation.taskId;
}

export function ObservationInspector({ projectId, jobId, items, terminal }: {
  projectId: string;
  jobId: string;
  items: ApiRunnerJobDetail['items'];
  terminal: boolean;
}) {
  const [filter, setFilter] = useState('all');
  const [follow, setFollow] = useState(true);
  const [observations, setObservations] = useState<ApiRunnerJobObservation[]>([]);
  const [page, setPage] = useState<ApiRunnerJobObservationPage | null>(null);
  const [summary, setSummary] = useState<ApiRunnerJobIntelligenceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(0);
  const loading = useRef(false);
  const generation = useRef(0);

  const loadSummary = async (requestGeneration = generation.current) => {
    try {
      const result = await api.runnerJobIntelligence(projectId, jobId);
      if (requestGeneration === generation.current) setSummary(result);
    }
    catch { /* Projection can legitimately still be pending while the job runs. */ }
  };
  const pull = async (reset = false, requestGeneration = generation.current) => {
    if (loading.current) return;
    loading.current = true;
    try {
      if (reset) cursor.current = 0;
      let nextAfter = cursor.current;
      let latest: ApiRunnerJobObservationPage | null = null;
      for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
        const replaceThisPage = reset && pageIndex === 0;
        const response = await api.runnerJobObservations(projectId, jobId, {
          afterSeq: nextAfter,
          limit: 100,
          ...(filter !== 'all' && filter !== 'overhead' ? { taskId: filter } : {}),
        });
        if (requestGeneration !== generation.current) return;
        latest = response;
        const visible = filter === 'overhead'
          ? response.observations.filter((observation) => observation.taskId === null)
          : response.observations;
        setObservations((current) => {
          const merged = new Map((replaceThisPage ? [] : current).map((observation) => [observation.observationId, observation]));
          for (const observation of visible) merged.set(observation.observationId, observation);
          return [...merged.values()].sort((left, right) => left.cursorSeq - right.cursorSeq);
        });
        nextAfter = response.cursor.nextSeq;
        if (!response.cursor.hasMore) break;
      }
      cursor.current = nextAfter;
      if (latest) setPage(latest);
      setError(null);
      if (terminal || latest?.expired) await loadSummary(requestGeneration);
    } catch (cause) {
      if (requestGeneration === generation.current) {
        setError(cause instanceof Error ? cause.message : 'Unable to read RunnerJob observations');
      }
    } finally {
      if (requestGeneration === generation.current) loading.current = false;
    }
  };

  useEffect(() => {
    generation.current++;
    loading.current = false;
    const requestGeneration = generation.current;
    setObservations([]);
    setPage(null);
    setSummary(null);
    cursor.current = 0;
    void pull(true, requestGeneration);
    void loadSummary(requestGeneration);
    // Reset only when the selected job or observation scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, jobId, filter]);
  useEffect(() => {
    if (!follow) return;
    const timer = window.setInterval(() => void pull(), 2_000);
    return () => window.clearInterval(timer);
    // Cursor lives in a ref so pausing and resuming never resets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, jobId, filter, follow, terminal]);

  const timing = page?.timing.server;
  return <Section title="Stage observations">
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginBottom: 10 }}>
      <label style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', flex: '1 1 180px' }}>
        Scope
        <Select
          aria-label="Observation scope"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          style={{ marginTop: 4, width: '100%' }}
        >
          <option value="all">all tasks + job overhead</option>
          <option value="overhead">job overhead only</option>
          {items.map((item) => <option key={item.taskId} value={item.taskId}>{item.taskKey}</option>)}
        </Select>
      </label>
      <Button variant={follow ? 'primary' : 'ghost'} onClick={() => setFollow((value) => !value)}>
        {follow ? 'following' : 'resume follow'}
      </Button>
      <Button variant="ghost" onClick={() => void pull()}>{follow ? 'refresh now' : 'refresh paused view'}</Button>
    </div>
    {page?.expired && <div role="status" style={{ padding: 10, borderRadius: 8, border: '1px solid var(--amber)', color: 'var(--text-mid)', fontSize: 11.5, marginBottom: 10 }}>
      Detailed stage evidence expired after 90 days. The permanent job and task summaries remain below.
    </div>}
    {page?.partial && !page.expired && <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#f5a623', marginBottom: 8 }}>
      LIVE PARTIAL · running stages do not have duration or usage until their finish evidence arrives
    </div>}
    {timing && <div className="runner-observation-timing">
      <TimingFact label="queue" value={durationText(timing.queueMs)} />
      <TimingFact label="elapsed" value={durationText(timing.elapsedMs)} />
      <TimingFact label="human wait" value={durationText(timing.humanWaitMs)} />
      <TimingFact label="landing" value={durationText(timing.landing.durationMs)} />
    </div>}
    {error && <ErrorNote>{error}</ErrorNote>}
    <div className="runner-observation-grid">
      {[...observations].reverse().map((observation) => <ObservationCard
        key={observation.observationId}
        observation={observation}
        scope={observationLabel(observation, items)}
      />)}
    </div>
    {!observations.length && !error && <EmptyState>{page?.expired ? 'detailed evidence expired' : 'no observations in this scope yet'}</EmptyState>}
    {summary && <PermanentRunnerJobSummary summary={summary} />}
  </Section>;
}

function TimingFact({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><b>{value}</b></div>;
}

function ObservationCard({ observation, scope }: { observation: ApiRunnerJobObservation; scope: string }) {
  const color = observation.status === 'succeeded' ? 'var(--green)'
    : observation.status === 'running' ? 'var(--blue)'
      : observation.status === 'skipped' ? 'var(--text-dim)' : 'var(--red-soft)';
  const usage = observation.usage;
  return <article style={{ border: '1px solid var(--w-07)', borderRadius: 9, padding: 11, background: 'var(--w-02)', minWidth: 0 }}>
    <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
      <MonoTag color={color} bg="var(--w-06)" size={8}>{observation.status}</MonoTag>
      <b style={{ fontSize: 12 }}>{observation.stage}</b>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>attempt {observation.attempt}</span>
      <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9.5, color: observation.taskId ? 'var(--text-mid)' : '#f5a623' }}>{scope}</span>
    </div>
    <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)', marginTop: 7, overflowWrap: 'anywhere' }}>
      {observation.actor.role ?? observation.actor.kind} · {observation.actor.driver}
      {observation.actor.model ? ` / ${observation.actor.model}` : ''} · {observation.actor.operation}
    </div>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8, fontFamily: 'var(--mono)', fontSize: 9.5 }}>
      <span>time <b>{metricText(observation.duration, 'ms')}</b></span>
      {usage ? <>
        <span>in <b>{metricText(usage.inputTokens)}</b></span>
        <span>out <b>{metricText(usage.outputTokens)}</b></span>
        <span>cache r/w <b>{metricText(usage.cacheReadTokens)} / {metricText(usage.cacheWriteTokens)}</b></span>
        <span>calls <b>{metricText(usage.calls)}</b></span>
        <span>cost <b>{usage.costUsd.value == null ? usage.costUsd.status.replace('_', ' ') : `$${usage.costUsd.value.toFixed(4)}${usage.costUsd.status === 'partial' ? ' partial' : ''}`}</b></span>
      </> : <span style={{ color: 'var(--text-dim)' }}>usage pending</span>}
    </div>
    {observation.recovery && observation.recovery !== 'none' && <div style={{ marginTop: 7, fontFamily: 'var(--mono)', fontSize: 9.5, color: '#f5a623' }}>
      recovered by {observation.recovery.replace('_', ' ')}
    </div>}
  </article>;
}

function PermanentRunnerJobSummary({ summary }: { summary: ApiRunnerJobIntelligenceDetail }) {
  if (summary.state === 'pending' || !summary.job) {
    return <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>Permanent summary projection pending.</div>;
  }
  const job = summary.job;
  const tokens = (job.usage.total.inputTokens.value ?? 0)
    + (job.usage.total.outputTokens.value ?? 0)
    + (job.usage.total.cacheReadTokens.value ?? 0)
    + (job.usage.total.cacheWriteTokens.value ?? 0);
  return <div style={{ marginTop: 14, borderTop: '1px solid var(--w-07)', paddingTop: 12 }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <b style={{ fontSize: 12 }}>Permanent job summary</b>
      <MonoTag color="var(--green)" bg="rgba(63,217,139,.1)" size={8}>PROJECTED</MonoTag>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>{new Date(job.projectedAt).toLocaleString()}</span>
    </div>
    <div className="runner-observation-timing" style={{ marginTop: 8 }}>
      <TimingFact label="tasks" value={`${job.taskEpisodeCount}/${job.taskCount}`} />
      <TimingFact label="tokens" value={`${tokens.toLocaleString()} · ${job.usage.total.inputTokens.status}`} />
      <TimingFact label="cost" value={job.usage.total.costUsd.value == null ? job.usage.total.costUsd.status : `$${job.usage.total.costUsd.value.toFixed(4)} · ${job.usage.total.costUsd.status}`} />
      <TimingFact label="overhead" value={`${job.overhead.observations.observationCount} observations`} />
    </div>
    <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 5 }}>
      {summary.tasks.map((task) => <div key={task.taskId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
        <MonoTag color="var(--text-mid)" bg="var(--w-06)" size={8}>{task.outcome}</MonoTag>
        <b>{task.taskKey}</b><span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.taskTitle}</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9.5 }}>{task.usage.inputTokens.status}</span>
      </div>)}
    </div>
  </div>;
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

function Output({ output, job }: { output: ApiRunnerJobOutput; job: ApiRunnerJobSummary }) {
  const landingMessage = job.landingStatus === 'landed'
    ? `Runner landed this reviewed output into ${job.landingTarget ?? 'the configured target'}.`
    : job.landingStatus === 'failed'
      ? `Landing failed and the reviewed output remains retained: ${job.landingError ?? 'unknown error'}`
      : job.landingPolicy === 'manual'
        ? `Reviewed output is retained. Accept & land will ask Runner to integrate it into ${job.landingTarget ?? 'the configured target'}.`
        : job.landingPolicy === 'auto'
          ? `Runner is configured to land successful reviewed output automatically into ${job.landingTarget ?? 'the configured target'}.`
          : output.workspaceMode === 'direct'
            ? 'Runner committed accepted work directly to the configured target.'
            : 'Human merge required. Runner retained this work locally and will not integrate it automatically.';
  return (
    <Section title="Retained output">
      <div style={{ padding: 11, borderRadius: 8, background: 'rgba(76,157,255,.06)', border: '1px solid rgba(76,157,255,.18)', fontSize: 11.5, lineHeight: 1.55 }}>
        <strong>Landing: {job.landingStatus}.</strong> {landingMessage}
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
