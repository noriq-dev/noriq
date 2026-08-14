// Runner Jobs — the minimal protocol-v2 control-plane surface. Noriq chooses only
// the immutable task/plan target and a runner repository; the committed project
// configuration remains the authority for models, workflows, budgets, and source control.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ApiRun,
  type ApiRunner,
  type ApiRunnerJobActivityItem,
  type ApiRunnerJobActivityPage,
  type ApiRunnerJobActivityStage,
  type ApiRunnerJobDetail,
  type ApiRunnerJobIntelligenceDetail,
  type ApiRunnerJobMetric,
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
import { LineagePanel } from './LineagePanel';

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
                Dispatch a task or plan. Agent routing, limits, checks, and source-control behavior come from the repository.
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
                  if (!(await confirm('Cancel this Runner job? Accepted checkpoints remain at the retained output location.'))) return;
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
              <EmptyState>select a job to inspect its evidence and retained output</EmptyState>
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
  const [targetTaskStatus, setTargetTaskStatus] = useState<string | null>(null);
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
    setTargetTaskStatus(null);
  }, [kind]);

  const retryingTask = kind === 'task' && targetTaskStatus === 'failed';

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
              onSelect={(task) => setTargetTaskStatus(task?.status ?? null)}
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
          {busy ? 'dispatching…' : retryingTask ? 'retry task' : `dispatch ${kind}`}
        </Button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
          {retryingTask
            ? 'Retry creates a fresh RunnerJob; the prior terminal job remains in history.'
            : 'Only runnerId and repoRef cross the control-plane boundary.'}
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

export function hasMeaningfulLineage(lineage: ApiRunnerJobDetail['job']['lineage']): boolean {
  return lineage.nodeCount > 1 || lineage.relationCount > 0 || lineage.incompleteNodeCount > 0;
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
  const meaningfulLineage = hasMeaningfulLineage(job.lineage);
  const [lineageOpen, setLineageOpen] = useState(
    new URLSearchParams(location.search).get('lineage') === job.lineage.orchestrationId,
  );
  const [lineageNode, setLineageNode] = useState<string | null>(new URLSearchParams(location.search).get('node'));
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    setLineageOpen(query.get('lineage') === job.lineage.orchestrationId);
    setLineageNode(query.get('node'));
  }, [job.id, job.lineage.orchestrationId]);
  const toggleLineage = () => {
    const next = !lineageOpen;
    setLineageOpen(next);
    const query = new URLSearchParams(location.search);
    if (next) {
      query.set('lineage', job.lineage.orchestrationId);
      query.delete('node');
      setLineageNode(null);
    }
    else { query.delete('lineage'); query.delete('node'); setLineageNode(null); }
    history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}`);
  };
  return (
    <div style={{ borderRadius: 11, border: '1px solid var(--w-07)', background: 'var(--w-02)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <MonoTag color={statusStyle.color} bg={statusStyle.bg} size={10}>{job.status}</MonoTag>
        <strong style={{ fontSize: 14 }}>{job.sourceKind} job</strong>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>{job.id}</span>
        <div style={{ flex: 1 }} />
        {canLand && <Button variant="primary" onClick={onLand}>{job.landingStatus === 'failed' ? 'retry landing' : 'accept & land'}</Button>}
        {landingPending && <Button variant="ghost" disabled>landing requested</Button>}
        {meaningfulLineage && <Button variant="ghost" onClick={toggleLineage}>{lineageOpen ? 'hide lineage' : 'view lineage'}</Button>}
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
              {item.checkpointRef && <code aria-label="checkpoint" style={{ fontSize: 10 }}>{shortRevision(item.checkpointRef)}</code>}
            </div>
            {item.summary && <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 5 }}>{item.summary}</div>}
            {item.projectionConflict && <div style={{ color: '#f5a623', fontSize: 11, marginTop: 5 }}>Task status changed by a human; Runner projection was not applied.</div>}
          </div>
        ))}
      </Section>
      {meaningfulLineage && lineageOpen && <Section title="Lineage">
        <LineagePanel
          projectId={projectId}
          orchestrationId={job.lineage.orchestrationId}
          initialExecutionId={lineageNode}
          onSelectionChange={(_, executionId) => {
            setLineageNode(executionId);
            const query = new URLSearchParams(location.search);
            if (executionId) query.set('node', executionId); else query.delete('node');
            history.replaceState(null, '', `${location.pathname}?${query}`);
          }}
        />
      </Section>}
      <JobActivity
        projectId={projectId}
        jobId={job.id}
        items={items}
        terminal={TERMINAL_JOBS.includes(job.status)}
      />
      {output && <RunnerJobOutputSummary output={output} job={job} />}
    </div>
  );
}

function durationText(value: number | null): string {
  if (value == null) return 'unavailable';
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

export function JobActivity({ projectId, jobId, items, terminal }: {
  projectId: string;
  jobId: string;
  items: ApiRunnerJobDetail['items'];
  terminal: boolean;
}) {
  const [filter, setFilter] = useState('all');
  const [follow, setFollow] = useState(true);
  const [activity, setActivity] = useState<ApiRunnerJobActivityItem[]>([]);
  const [page, setPage] = useState<ApiRunnerJobActivityPage | null>(null);
  const [summary, setSummary] = useState<ApiRunnerJobIntelligenceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);
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
      if (reset) cursor.current = null;
      let nextAfter = cursor.current;
      let latest: ApiRunnerJobActivityPage | null = null;
      for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
        const replaceThisPage = reset && pageIndex === 0;
        const response = await api.runnerJobActivity(projectId, jobId, {
          ...(nextAfter ? { cursor: nextAfter } : {}),
          limit: 100,
          ...(filter !== 'all' ? { taskId: filter } : {}),
        });
        if (requestGeneration !== generation.current) return;
        latest = response;
        setActivity((current) => {
          const merged = new Map((replaceThisPage ? [] : current).map((item) => [item.id, item]));
          for (const item of response.items) merged.set(item.id, item);
          return [...merged.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
        });
        nextAfter = response.cursor.next;
        if (!response.cursor.hasMore) break;
      }
      cursor.current = nextAfter;
      if (latest) setPage(latest);
      setError(null);
      if (terminal || latest?.expired) await loadSummary(requestGeneration);
    } catch (cause) {
      if (requestGeneration === generation.current) {
        setError(cause instanceof Error ? cause.message : 'Unable to read job activity');
      }
    } finally {
      if (requestGeneration === generation.current) loading.current = false;
    }
  };

  useEffect(() => {
    generation.current++;
    loading.current = false;
    const requestGeneration = generation.current;
    setActivity([]);
    setPage(null);
    setSummary(null);
    cursor.current = null;
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
  return <Section title="Job activity">
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
      Detailed activity expired after 90 days. The permanent job and task summaries remain below.
    </div>}
    {page?.partial && !page.expired && <div role="status" style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#f5a623', marginBottom: 8 }}>
      LIVE PARTIAL · running work fills in duration and usage when finish evidence arrives
    </div>}
    {timing && <div className="runner-observation-timing">
      <TimingFact label="queue" value={durationText(timing.queueMs)} />
      <TimingFact label="elapsed" value={durationText(timing.elapsedMs)} />
      <TimingFact label="human wait" value={durationText(timing.humanWaitMs)} />
      <TimingFact label="landing" value={durationText(timing.landing.durationMs)} />
    </div>}
    {error && <ErrorNote>{error}</ErrorNote>}
    <ActivityTimeline activity={activity} items={items} follow={follow} />
    {!activity.length && !error && <EmptyState>{page?.expired ? 'detailed activity expired' : 'no activity in this scope yet'}</EmptyState>}
    {summary && <PermanentRunnerJobSummary summary={summary} />}
  </Section>;
}

function TimingFact({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><b>{value}</b></div>;
}

type ActivityStageGroup = {
  kind: 'group'; id: string; stage: ApiRunnerJobActivityStage['stage']; attempt: number;
  occurredAt: string; observations: ApiRunnerJobActivityStage[];
};

function ActivityTimeline({ activity, items, follow }: {
  activity: ApiRunnerJobActivityItem[];
  items: ApiRunnerJobDetail['items'];
  follow: boolean;
}) {
  const scroll = useRef<HTMLDivElement | null>(null);
  const nearNewest = useRef(true);
  const blocks = useMemo(() => {
    const groups = new Map<string, ActivityStageGroup>();
    const result: Array<ActivityStageGroup | Exclude<ApiRunnerJobActivityItem, ApiRunnerJobActivityStage>> = [];
    for (const item of activity) {
      if (item.kind === 'milestone') { result.push(item); continue; }
      const key = `${item.stage}:${item.attempt}`;
      const group = groups.get(key) ?? { kind: 'group' as const, id: key, stage: item.stage, attempt: item.attempt, occurredAt: item.occurredAt, observations: [] };
      group.observations.push(item);
      if (item.occurredAt < group.occurredAt) group.occurredAt = item.occurredAt;
      if (!groups.has(key)) { groups.set(key, group); result.push(group); }
    }
    return result.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  }, [activity]);

  useEffect(() => {
    const element = scroll.current;
    if (!element || !follow || !nearNewest.current || typeof element.scrollTo !== 'function') return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [blocks, follow]);

  if (!blocks.length) return null;
  return <div
    ref={scroll}
    className="runner-activity-scroll"
    aria-live="polite"
    aria-label="Chronological job activity"
    onScroll={(event) => {
      const element = event.currentTarget;
      nearNewest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}
  >
    <div className="runner-activity-timeline">
      {blocks.map((block) => block.kind === 'milestone'
        ? <ActivityMilestone key={block.id} milestone={block} items={items} />
        : <ActivityStage key={block.id} group={block} items={items} />)}
    </div>
  </div>;
}

function statusColor(status: string): string {
  if (status === 'succeeded' || status === 'accepted') return 'var(--green)';
  if (status === 'running' || status === 'assigned') return 'var(--blue)';
  if (status === 'waiting' || status === 'warning' || status === 'partial') return '#f5a623';
  if (status === 'skipped' || status === 'cancelled') return 'var(--text-dim)';
  return 'var(--red-soft)';
}

function ActivityMilestone({ milestone, items }: {
  milestone: Extract<ApiRunnerJobActivityItem, { kind: 'milestone' }>;
  items: ApiRunnerJobDetail['items'];
}) {
  const task = milestone.taskId ? items.find((item) => item.taskId === milestone.taskId) : null;
  return <article className="runner-activity-milestone">
    <span className="runner-activity-dot" style={{ background: statusColor(milestone.status) }} />
    <div>
      <div className="runner-activity-title"><b>{milestone.title}</b>{task && <MonoTag color="var(--text-mid)" bg="var(--w-06)" size={8}>{task.taskKey}</MonoTag>}</div>
      {milestone.detail && <div className="runner-activity-detail">{milestone.detail}</div>}
    </div>
    <time>{new Date(milestone.occurredAt).toLocaleTimeString()}</time>
  </article>;
}

function aggregateMetric(observations: ApiRunnerJobActivityStage[], select: (item: ApiRunnerJobActivityStage) => ApiRunnerJobMetric | null): { value: number | null; partial: boolean } {
  const metrics = observations.map(select).filter((metric): metric is ApiRunnerJobMetric => metric?.value != null);
  return { value: metrics.length ? metrics.reduce((sum, metric) => sum + metric.value!, 0) : null, partial: metrics.some((metric) => metric.status === 'partial') };
}

function ActivityStage({ group, items }: { group: ActivityStageGroup; items: ApiRunnerJobDetail['items'] }) {
  const statuses = group.observations.map((observation) => observation.status);
  const status = statuses.includes('failed') ? 'failed'
    : statuses.includes('cancelled') ? 'cancelled'
      : statuses.includes('running') ? 'running'
        : statuses.every((candidate) => candidate === 'skipped') ? 'skipped' : 'succeeded';
  const noteworthy = status !== 'succeeded' && status !== 'skipped'
    || group.observations.some((observation) => observation.recovery && observation.recovery !== 'none');
  const [expanded, setExpanded] = useState(noteworthy);
  const duration = aggregateMetric(group.observations, (observation) => observation.duration);
  const tokens = aggregateMetric(group.observations, (observation) => observation.usage ? {
    status: observation.usage.inputTokens.status === 'partial' || observation.usage.outputTokens.status === 'partial' ? 'partial' : 'complete',
    value: observation.usage.inputTokens.value == null && observation.usage.outputTokens.value == null
      ? null : (observation.usage.inputTokens.value ?? 0) + (observation.usage.outputTokens.value ?? 0),
    provenance: 'derived',
  } : null);
  const calls = aggregateMetric(group.observations, (observation) => observation.usage?.calls ?? null);
  const cost = aggregateMetric(group.observations, (observation) => observation.usage?.costUsd ?? null);
  const taskCount = new Set(group.observations.map((observation) => observation.taskId).filter(Boolean)).size;
  const orderedScopes: Array<{ id: string | null; label: string; observations: ApiRunnerJobActivityStage[] }> = [];
  const overhead = group.observations.filter((observation) => observation.taskId === null);
  if (overhead.length) orderedScopes.push({ id: null, label: 'Job overhead', observations: overhead });
  for (const item of items) {
    const scoped = group.observations.filter((observation) => observation.taskId === item.taskId);
    if (scoped.length) orderedScopes.push({ id: item.taskId, label: item.taskKey, observations: scoped });
  }
  const known = new Set(orderedScopes.flatMap((scope) => scope.observations.map((observation) => observation.id)));
  for (const observation of group.observations.filter((candidate) => !known.has(candidate.id))) {
    orderedScopes.push({ id: observation.taskId, label: observation.taskId ?? 'Job overhead', observations: [observation] });
  }
  const metrics = [
    duration.value == null ? null : durationText(duration.value),
    tokens.value == null ? null : `${tokens.value.toLocaleString()} tokens${tokens.partial ? ' partial' : ''}`,
    calls.value == null ? null : `${calls.value.toLocaleString()} calls`,
    cost.value == null ? null : `$${cost.value.toFixed(4)}${cost.partial ? ' partial' : ''}`,
  ].filter(Boolean);
  return <article className="runner-activity-stage" data-status={status}>
    <button type="button" className="runner-activity-stage-header" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className="runner-activity-chevron">{expanded ? '▾' : '▸'}</span>
      <MonoTag color={statusColor(status)} bg="var(--w-06)" size={8}>{status}</MonoTag>
      <b>{group.stage}</b>
      <span className="runner-activity-attempt">attempt {group.attempt}</span>
      <span className="runner-activity-stage-summary">{group.observations.length} operation{group.observations.length === 1 ? '' : 's'}{taskCount ? ` · ${taskCount} task${taskCount === 1 ? '' : 's'}` : ''}{metrics.length ? ` · ${metrics.join(' · ')}` : ' · usage not reported'}</span>
    </button>
    {expanded && <div className="runner-activity-stage-body">
      {orderedScopes.map((scope, index) => <section key={`${scope.id ?? 'overhead'}:${index}`} className="runner-activity-scope">
        <h4>{scope.label}</h4>
        {scope.observations.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)).map((observation) => <ActivityOperation key={observation.id} observation={observation} />)}
      </section>)}
    </div>}
  </article>;
}

function ActivityOperation({ observation }: { observation: ApiRunnerJobActivityStage }) {
  const actor = `${observation.actor.role ?? observation.actor.kind} · ${observation.actor.driver}${observation.actor.model ? ` / ${observation.actor.model}` : ''}`;
  const metrics = [
    observation.duration?.value == null ? null : `time ${durationText(observation.duration.value)}`,
    observation.usage?.inputTokens.value == null ? null : `in ${observation.usage.inputTokens.value.toLocaleString()}`,
    observation.usage?.outputTokens.value == null ? null : `out ${observation.usage.outputTokens.value.toLocaleString()}`,
    observation.usage?.calls.value == null ? null : `${observation.usage.calls.value.toLocaleString()} calls`,
    observation.usage?.costUsd.value == null ? null : `$${observation.usage.costUsd.value.toFixed(4)}`,
  ].filter(Boolean);
  const evidence = observation.evidence ? [
    observation.evidence.changedPathCount == null ? null : `${observation.evidence.changedPathCount} paths`,
    observation.evidence.blockerFindings == null ? null : `${observation.evidence.blockerFindings} blockers`,
    observation.evidence.majorFindings == null ? null : `${observation.evidence.majorFindings} major`,
    observation.evidence.minorFindings == null ? null : `${observation.evidence.minorFindings} minor`,
    observation.evidence.exitCode == null ? null : `exit ${observation.evidence.exitCode}`,
    observation.evidence.timedOut ? 'timed out' : null,
    observation.evidence.checkpointRef ? `checkpoint ${shortRevision(observation.evidence.checkpointRef)}` : null,
    observation.evidence.errorCode ? `error ${observation.evidence.errorCode}` : null,
  ].filter(Boolean) : [];
  return <div className="runner-activity-operation">
    <span className="runner-activity-dot" style={{ background: statusColor(observation.status) }} />
    <div className="runner-activity-operation-main"><b>{observation.actor.operation}</b><span>{actor}</span></div>
    <div className="runner-activity-operation-facts">{[...metrics, ...evidence].map((fact) => <span key={fact}>{fact}</span>)}</div>
    {observation.recovery && observation.recovery !== 'none' && <span className="runner-activity-recovery">recovered by {observation.recovery.replace('_', ' ')}</span>}
  </div>;
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

export function RunnerJobOutputSummary({ output, job }: { output: ApiRunnerJobOutput; job: ApiRunnerJobSummary }) {
  const landingMessage = job.landingStatus === 'landed'
    ? `Runner landed this reviewed output into ${job.landingTarget ?? 'the configured target'}.`
    : job.landingStatus === 'failed'
      ? `Landing failed and the reviewed output remains retained: ${job.landingError ?? 'unknown error'}`
      : job.landingPolicy === 'manual'
        ? `Reviewed output is retained. Accept & land will ask Runner to integrate it into ${job.landingTarget ?? 'the configured target'}.`
        : job.landingPolicy === 'auto'
          ? `Runner is configured to land successful reviewed output automatically into ${job.landingTarget ?? 'the configured target'}.`
          : output.workspaceMode === 'direct'
            ? 'Runner applied accepted work directly to the configured target.'
            : 'Human integration required. Runner retained this work and will not integrate it automatically.';
  return (
    <Section title="Retained output">
      <div style={{ padding: 11, borderRadius: 8, background: 'rgba(76,157,255,.06)', border: '1px solid rgba(76,157,255,.18)', fontSize: 11.5, lineHeight: 1.55 }}>
        <strong>Landing: {job.landingStatus}.</strong> {landingMessage}
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: '100px minmax(0, 1fr)', gap: '6px 10px', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
        <dt>mode</dt><dd>{output.workspaceMode}</dd>
        <dt>VCS</dt><dd>{output.retainedLocation.vcs}</dd>
        <dt>location</dt><dd style={{ overflowWrap: 'anywhere' }}>{output.retainedLocation.url ? <a href={output.retainedLocation.url}>{output.retainedLocation.label}</a> : output.retainedLocation.label}</dd>
        <dt>base revision</dt><dd>{shortRevision(output.baseRevision)}</dd>
        <dt>head revision</dt><dd>{shortRevision(output.headRevision)}</dd>
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
