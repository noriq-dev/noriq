import { RunnerJobAgentRoute } from '@noriq-dev/shared';

type ActivityOptions = { cursor?: string; limit?: number; taskId?: string };

type JobRow = {
  status: string; phase: string; lastEventSeq: number; createdAt: string; assignedAt: string | null;
  startedAt: string | null; finishedAt: string | null; cancelRequestedAt: string | null;
  detailPrunedAt: string | null; intelligenceStartedReceivedAt: string | null;
  intelligenceFinishedReceivedAt: string | null; humanWaitStartedReceivedAt: string | null;
  humanWaitMs: number; landingStatus: string; landingRequestedAt: string | null;
  landingStartedAt: string | null; landingFinishedAt: string | null;
};

type ObservationRow = Record<string, unknown> & {
  observationId: string; taskId: string | null; stage: string; attempt: number; status: string;
  actor: string; startedAt: string; finishedAt: string | null; duration: string | null;
  usage: string | null; evidence: string | null; cursorSeq: number;
  costBasis: string | null;
  recovery: string | null; startSeq: number | null; finishSeq: number | null;
  startReceivedAt: string; finishReceivedAt: string | null;
};

type EventRow = { seq: number; eventType: string; payload: string; observedAt: string; receivedAt: string };

const terminalStatuses = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

function parseJson<T>(value: string | null, fallback: T): T {
  if (value == null) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

type ActivityCursor = { seq: number; durableOffset: number };

function encodeCursor(cursor: ActivityCursor): string {
  return btoa(JSON.stringify(cursor));
}

function decodeCursor(cursor: string | undefined): ActivityCursor {
  if (!cursor) return { seq: 0, durableOffset: 0 };
  try {
    const parsed = JSON.parse(atob(cursor)) as { seq?: unknown; durableOffset?: unknown };
    if (!Number.isSafeInteger(parsed.seq) || Number(parsed.seq) < 0) throw new Error();
    if (!Number.isSafeInteger(parsed.durableOffset) || Number(parsed.durableOffset) < 0) throw new Error();
    return { seq: Number(parsed.seq), durableOffset: Number(parsed.durableOffset) };
  } catch {
    throw new Error('invalid activity cursor');
  }
}

function elapsed(start: string | null, end: string | null): number | null {
  return start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;
}

function text(value: unknown, maximum = 500): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function sanitizedEvidence(value: string | null) {
  const evidence = parseJson<Record<string, unknown>>(value, {});
  const number = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
  return {
    changedPathCount: number(evidence.changedPathCount),
    blockerFindings: number(evidence.blockerFindings),
    majorFindings: number(evidence.majorFindings),
    minorFindings: number(evidence.minorFindings),
    exitCode: number(evidence.exitCode),
    timedOut: typeof evidence.timedOut === 'boolean' ? evidence.timedOut : null,
    checkpointRef: text(evidence.checkpointRef, 256),
    errorCode: text(evidence.errorCode, 100),
  };
}

function milestone(input: {
  id: string; type: string; status: string; occurredAt: string; updatedAt?: string;
  taskId?: string | null; title: string; detail?: string | null; cursorSeq?: number;
}) {
  return {
    kind: 'milestone' as const,
    id: input.id,
    type: input.type,
    status: input.status,
    occurredAt: input.occurredAt,
    updatedAt: input.updatedAt ?? input.occurredAt,
    taskId: input.taskId ?? null,
    title: input.title,
    detail: input.detail ?? null,
    cursorSeq: input.cursorSeq ?? null,
  };
}

function eventMilestone(row: EventRow, taskScope: string | null) {
  const payload = parseJson<Record<string, unknown>>(row.payload, {});
  const parsedRoute = row.eventType === 'agent.route'
    ? RunnerJobAgentRoute.safeParse(payload.route)
    : null;
  const route = parsedRoute?.success ? parsedRoute.data : null;
  const taskId = route?.taskId ?? (typeof payload.taskId === 'string' ? payload.taskId : null);
  if (taskScope === 'overhead' && taskId) return null;
  if (taskScope && taskScope !== 'overhead' && taskId && taskId !== taskScope) return null;
  const common = { id: `event:${row.seq}`, occurredAt: row.observedAt, updatedAt: row.receivedAt, cursorSeq: row.seq, taskId };
  switch (row.eventType) {
    case 'agent.route':
      if (!route) return null;
      return {
        ...milestone({
          ...common, type: 'agent_route',
          status: route.decision === 'invoke' ? 'succeeded' : 'skipped',
          title: route.decision === 'invoke' ? 'Agent route selected' : 'Agent invocation skipped',
        }),
        route,
      };
    case 'job.context':
      return milestone({ ...common, type: 'workspace_prepared', status: 'succeeded', title: 'Workspace prepared', detail: [text(payload.vcs, 100), text(payload.workspaceMode, 100)].filter(Boolean).join(' · ') || null });
    case 'progress':
      return milestone({ ...common, type: 'phase_changed', status: 'running', title: `Phase: ${text(payload.phase, 100) ?? 'running'}` });
    case 'task.result':
      return milestone({ ...common, type: 'task_result', status: text(payload.status, 100) ?? 'running', title: `Task ${text(payload.status, 100) ?? 'updated'}`, detail: text(payload.summary) });
    case 'question':
      return milestone({ ...common, type: 'question_opened', status: 'waiting', title: 'Human input requested' });
    case 'warning':
      return milestone({ ...common, type: 'warning', status: 'warning', title: text(payload.code, 100) ?? 'Runner warning' });
    case 'terminal': {
      const output = payload.output && typeof payload.output === 'object' ? payload.output as Record<string, unknown> : {};
      const status = text(payload.status, 100) ?? 'failed';
      return milestone({ ...common, type: 'terminal', status, title: `Job ${status}`, detail: text(output.summary) });
    }
    default:
      return null;
  }
}

export async function readRunnerJobActivity(
  db: D1Database,
  projectId: string,
  jobId: string,
  options: ActivityOptions = {},
) {
  const cursor = decodeCursor(options.cursor);
  const afterSeq = cursor.seq;
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100)));
  const taskScope = options.taskId?.trim() || null;
  if (taskScope && taskScope.length > 128) throw new Error('taskId is too long');

  const job = await db.prepare(
    `SELECT status, phase, last_event_seq AS lastEventSeq, created_at AS createdAt,
            assigned_at AS assignedAt, started_at AS startedAt, finished_at AS finishedAt,
            cancel_requested_at AS cancelRequestedAt, detail_pruned_at AS detailPrunedAt,
            intelligence_started_received_at AS intelligenceStartedReceivedAt,
            intelligence_finished_received_at AS intelligenceFinishedReceivedAt,
            human_wait_started_received_at AS humanWaitStartedReceivedAt, human_wait_ms AS humanWaitMs,
            landing_status AS landingStatus, landing_requested_at AS landingRequestedAt,
            landing_started_at AS landingStartedAt, landing_finished_at AS landingFinishedAt
       FROM runner_jobs WHERE id = ? AND project_id = ?`,
  ).bind(jobId, projectId).first<JobRow>();
  if (!job) throw new Error('RunnerJob not found');

  const observationScope = taskScope === 'overhead' ? 'task_id IS NULL' : taskScope ? 'task_id = ?' : '1 = 1';
  const observationBinds: unknown[] = [jobId];
  if (taskScope && taskScope !== 'overhead') observationBinds.push(taskScope);
  observationBinds.push(afterSeq, limit + 1);
  const [observations, events, answeredQuestions] = await Promise.all([
    db.prepare(
      `SELECT observation_id AS observationId, task_id AS taskId, stage, attempt, actor, status,
              started_at AS startedAt, finished_at AS finishedAt, duration, usage,
              cost_basis AS costBasis, recovery, evidence,
              start_seq AS startSeq, finish_seq AS finishSeq, start_received_at AS startReceivedAt,
              finish_received_at AS finishReceivedAt, COALESCE(finish_seq, start_seq) AS cursorSeq
         FROM runner_job_observations
        WHERE job_id = ? AND ${observationScope} AND COALESCE(finish_seq, start_seq) > ?
        ORDER BY COALESCE(finish_seq, start_seq), observation_id LIMIT ?`,
    ).bind(...observationBinds).all<ObservationRow>(),
    db.prepare(
      `SELECT seq, event_type AS eventType, payload, observed_at AS observedAt, received_at AS receivedAt
         FROM runner_job_events
        WHERE job_id = ? AND seq > ?
          AND event_type IN ('job.context','agent.route','progress','task.result','question','warning','terminal')
        ORDER BY seq LIMIT ?`,
    ).bind(jobId, afterSeq, limit + 1).all<EventRow>(),
    db.prepare(
      `SELECT question_id AS questionId, answered_at AS answeredAt
         FROM runner_job_questions WHERE job_id = ? AND answered_at IS NOT NULL ORDER BY answered_at, question_id`,
    ).bind(jobId).all<{ questionId: string; answeredAt: string }>(),
  ]);

  const sequencedCandidates = [
    ...observations.results.map((row) => ({
      seq: row.cursorSeq,
      item: {
        kind: 'stage' as const,
        id: `stage:${row.observationId}`,
        observationId: row.observationId,
        taskId: row.taskId,
        stage: row.stage,
        attempt: row.attempt,
        actor: parseJson(row.actor, null),
        status: row.status,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        occurredAt: row.startedAt,
        updatedAt: row.finishReceivedAt ?? row.startReceivedAt,
        duration: parseJson(row.duration, null),
        usage: parseJson(row.usage, null),
        costBasis: parseJson(row.costBasis, null),
        recovery: row.recovery,
        evidence: row.evidence === null ? null : sanitizedEvidence(row.evidence),
        startSeq: row.startSeq,
        finishSeq: row.finishSeq,
        cursorSeq: row.cursorSeq,
      },
    })),
    ...events.results.map((row) => ({ seq: row.seq, item: eventMilestone(row, taskScope) })),
  ].sort((left, right) => left.seq - right.seq);

  const durable = [
    milestone({ id: 'job:commissioned', type: 'commissioned', status: 'succeeded', occurredAt: job.createdAt, title: 'Job commissioned' }),
    ...(job.assignedAt ? [milestone({ id: 'job:assigned', type: 'assigned', status: 'succeeded', occurredAt: job.assignedAt, title: 'Runner assigned' })] : []),
    ...(job.cancelRequestedAt ? [milestone({ id: 'job:cancel-requested', type: 'cancel_requested', status: 'cancelled', occurredAt: job.cancelRequestedAt, title: 'Cancellation requested' })] : []),
    ...answeredQuestions.results.map((question) => milestone({ id: `question:${question.questionId}:answered`, type: 'question_answered', status: 'succeeded', occurredAt: question.answeredAt, title: 'Human input received' })),
    ...(job.landingRequestedAt ? [milestone({ id: 'job:landing-requested', type: 'landing_requested', status: 'running', occurredAt: job.landingRequestedAt, title: 'Landing requested' })] : []),
    ...(job.landingStartedAt ? [milestone({ id: 'job:landing-started', type: 'landing_started', status: 'running', occurredAt: job.landingStartedAt, title: 'Landing started' })] : []),
    ...(job.landingFinishedAt ? [milestone({
      id: 'job:landing-finished',
      type: job.landingStatus === 'landed' ? 'landing_succeeded' : 'landing_failed',
      status: job.landingStatus === 'landed' ? 'succeeded' : 'failed',
      occurredAt: job.landingFinishedAt,
      title: job.landingStatus === 'landed' ? 'Landing succeeded' : 'Landing failed',
    })] : []),
  ];
  const durablePage = durable.slice(cursor.durableOffset, cursor.durableOffset + limit);
  const nextDurableOffset = cursor.durableOffset + durablePage.length;
  const sequenced = sequencedCandidates.slice(0, limit - durablePage.length);
  const returnedSeq = sequenced.at(-1)?.seq ?? afterSeq;
  const journalHasMore = observations.results.some((row) => row.cursorSeq > returnedSeq)
    || events.results.some((row) => row.seq > returnedSeq);
  const hasMore = nextDurableOffset < durable.length || journalHasMore;
  const nextSeq = journalHasMore ? returnedSeq : Math.max(returnedSeq, job.lastEventSeq);

  const asOf = new Date().toISOString();
  const taskTiming = taskScope && taskScope !== 'overhead' ? await db.prepare(
    `SELECT intelligence_started_received_at AS startedAt, intelligence_finished_received_at AS finishedAt
       FROM runner_job_items WHERE job_id = ? AND task_id = ?`,
  ).bind(jobId, taskScope).first<{ startedAt: string | null; finishedAt: string | null }>() : null;
  const currentHumanWaitMs = job.humanWaitStartedReceivedAt
    ? Math.max(0, Date.parse(asOf) - Date.parse(job.humanWaitStartedReceivedAt)) : 0;

  const items = [...durablePage, ...sequenced.map(({ item }) => item).filter((item) => item !== null)]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  return {
    items,
    cursor: { next: encodeCursor({ seq: nextSeq, durableOffset: nextDurableOffset }), hasMore },
    scope: { taskId: taskScope },
    timing: {
      runner: { startedAt: job.startedAt, finishedAt: job.finishedAt },
      server: {
        asOf, commissionedAt: job.createdAt,
        workStartedAt: job.intelligenceStartedReceivedAt,
        workFinishedAt: job.intelligenceFinishedReceivedAt,
        queueMs: elapsed(job.createdAt, job.intelligenceStartedReceivedAt),
        elapsedMs: elapsed(job.intelligenceStartedReceivedAt, job.intelligenceFinishedReceivedAt),
        humanWaitMs: job.humanWaitMs + currentHumanWaitMs,
        humanWaitStartedAt: job.humanWaitStartedReceivedAt,
        landing: {
          requestedAt: job.landingRequestedAt, startedAt: job.landingStartedAt,
          finishedAt: job.landingFinishedAt,
          durationMs: elapsed(job.landingRequestedAt, job.landingFinishedAt),
        },
        task: taskTiming ? {
          startedAt: taskTiming.startedAt, finishedAt: taskTiming.finishedAt,
          durationMs: elapsed(taskTiming.startedAt, taskTiming.finishedAt),
        } : null,
      },
    },
    partial: !terminalStatuses.has(job.status),
    expired: job.detailPrunedAt !== null,
  };
}
