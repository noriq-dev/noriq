import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import type { Actor } from './ProjectRoom';
import {
  ORCHESTRATION_CAPABILITY,
  MISSION_CAPABILITY,
  MISSION_HANDOFF_CAPABILITY,
  RunnerRepo,
  RunnerJobRunnerMessage,
  RunnerClientMessage,
  RUNNER_PROTOCOL_CAPABILITIES,
  RUNNER_PROTOCOL_VERSION,
  type ExecutionReportAck,
  type MissionAdoptionResult,
  type MissionHandoffAck,
  type MissionQuestionAck,
  type MissionLeaseRef,
  type MissionTaskAck,
  type RunnerProtocolCapability,
} from '@noriq-dev/shared';
import { projectRoleAllows, resolveAccountCapabilities, resolveProjectAccess } from '../lib/authorization';
import { tokenCanReachProject } from '../lib/visibility';
import {
  declareRunnerExecution,
  ensureRunExecution,
  reconcileRunnerExecution,
  reportRunnerExecutionEvent,
  reportRunnerExecutionRelation,
} from '../lib/orchestration-store';

/**
 * RunnerHub — one instance per runner (idFromName(runnerId)).
 *
 * Holds the daemon's live /ws/runner/:id socket (RUN-7). The control plane pushes
 * run.assigned / run.cancel down this socket via deliver(); the daemon pushes
 * hello / heartbeat / run.status / steer.ack up. Run *authority* stays in
 * ProjectRoom — this hub only transports and forwards run.status transitions to
 * the owning project's DO. Auth is done by the Worker route before the upgrade is
 * forwarded here (token → runner owner), mirroring /ws/projects.
 */
const SYS: Actor = { kind: 'system', id: 'system', name: 'system' };
type RunnerSocketAuth = { userId: string; tokenId: string; capabilities?: RunnerProtocolCapability[] };
type RunnerSocketAttachment = RunnerSocketAuth & { jobProtocol?: 2 };

export class RunnerHub extends DurableObject<Env> {
  private _runnerId?: string;

  private async setRunnerId(id: string) {
    if (this._runnerId === id) return;
    this._runnerId = id;
    await this.ctx.storage.put('runnerId', id);
  }

  private async loadRunnerId(): Promise<string | undefined> {
    if (!this._runnerId) this._runnerId = (await this.ctx.storage.get<string>('runnerId')) ?? undefined;
    return this._runnerId;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'expected websocket' }, { status: 426 });
    }
    const m = new URL(request.url).pathname.match(/\/ws\/runner\/([^/]+)/);
    if (m) await this.setRunnerId(decodeURIComponent(m[1]!));
    const userId = request.headers.get('X-Noriq-Authorized-User');
    const tokenId = request.headers.get('X-Noriq-Authorized-Token');
    if (!userId || !tokenId) return Response.json({ error: 'authorization required' }, { status: 401 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ userId, tokenId } satisfies RunnerSocketAuth);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Push a server→daemon message onto the live socket. Returns whether anyone got it. */
  async deliver(json: string): Promise<{ delivered: boolean }> {
    let delivered = false;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const auth = await this.authorizeSocket(ws);
        if (!auth) continue;
        if ((auth as RunnerSocketAttachment).jobProtocol === 2) continue;
        ws.send(await this.messageForSocket(ws, json));
        delivered = true;
      } catch { /* socket gone */ }
    }
    return { delivered };
  }

  /** Assign or replay one durable protocol-v2 job to a negotiated socket. */
  async deliverRunnerJob(jobId: string): Promise<{ delivered: boolean }> {
    const runnerId = await this.loadRunnerId();
    if (!runnerId) return { delivered: false };
    const row = await this.env.DB.prepare(
      'SELECT project_id AS pid FROM runner_jobs WHERE id = ? AND runner_id = ?',
    ).bind(jobId, runnerId).first<{ pid: string }>();
    if (!row) return { delivered: false };
    const assignment = await this.room(row.pid).assignRunnerJob(row.pid, jobId, runnerId);
    if (!assignment) return { delivered: false };
    let delivered = false;
    for (const ws of this.ctx.getWebSockets()) {
      const auth = await this.authorizeSocket(ws);
      if (!auth || (auth as RunnerSocketAttachment).jobProtocol !== 2) continue;
      if (!(await this.authorizeProject(ws, auth, row.pid))) continue;
      delivered = this.sendIfOpen(ws, JSON.stringify({ type: 'job.assign', assignment })) || delivered;
    }
    return { delivered };
  }

  async deliverRunnerJobAnswer(
    jobId: string,
    assignmentId: string,
    questionId: string,
    answer: string,
  ): Promise<{ delivered: boolean }> {
    let delivered = false;
    for (const ws of this.ctx.getWebSockets()) {
      const auth = await this.authorizeSocket(ws);
      if (!auth || (auth as RunnerSocketAttachment).jobProtocol !== 2) continue;
      delivered = this.sendIfOpen(ws, JSON.stringify({
        type: 'job.answer', jobId, assignmentId, questionId, answer,
      })) || delivered;
    }
    return { delivered };
  }

  async deliverRunnerJobCancellation(
    jobId: string,
    assignmentId: string,
    reason: string,
  ): Promise<{ delivered: boolean }> {
    let delivered = false;
    for (const ws of this.ctx.getWebSockets()) {
      const auth = await this.authorizeSocket(ws);
      if (!auth || (auth as RunnerSocketAttachment).jobProtocol !== 2) continue;
      delivered = this.sendIfOpen(ws, JSON.stringify({
        type: 'job.cancel', jobId, assignmentId, reason,
      })) || delivered;
    }
    return { delivered };
  }

  /** Capability-scoped fast path. Durable state remains the source of replay; this prevents an
   * additive frame from being sent to an older socket that never negotiated its parser. */
  async deliverCapability(
    json: string,
    capability: RunnerProtocolCapability,
  ): Promise<{ delivered: boolean }> {
    let delivered = false;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const auth = await this.authorizeSocket(ws);
        if (!auth?.capabilities?.includes(capability)) continue;
        ws.send(await this.messageForSocket(ws, json));
        delivered = true;
      } catch { /* socket gone */ }
    }
    return { delivered };
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message !== 'string') return;
    const runnerId = await this.loadRunnerId();
    if (!runnerId) return;
    const auth = await this.authorizeSocket(ws);
    if (!auth) return;
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch { return; }
    const jobMessage = RunnerJobRunnerMessage.safeParse(raw);
    if (jobMessage.success) {
      await this.handleRunnerJobMessage(ws, auth, runnerId, jobMessage.data);
      return;
    }
    const parsed = RunnerClientMessage.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;

    if (await this.handleLegacyCutoverFrame(ws, auth, runnerId, msg)) return;

    switch (msg.type) {
      case 'ping':
        this.sendIfOpen(ws, JSON.stringify({ type: 'pong' }));
        return;

      case 'hello': {
        const acceptedCapabilities = RUNNER_PROTOCOL_CAPABILITIES.filter((capability) =>
          msg.protocolCapabilities.includes(capability));
        ws.serializeAttachment({ ...auth, capabilities: acceptedCapabilities } satisfies RunnerSocketAuth);
        await this.refreshExecutionProfiles(runnerId, msg.repos);
        if (!this.sendIfOpen(ws, JSON.stringify({
          type: 'registered', runnerId, protocol: RUNNER_PROTOCOL_VERSION,
          serverTime: new Date().toISOString(), acceptedCapabilities,
        }))) return;
        // Consumption is a durable control-plane fact, not a best-effort notification. A Runner
        // that missed the fast path receives every consumed handoff again after negotiating the
        // additive capability; applying the stable consumptionId is idempotent daemon-side.
        if (acceptedCapabilities.includes(MISSION_HANDOFF_CAPABILITY)) {
          const { results: consumed } = await this.env.DB.prepare(
            `SELECT root_run_id AS runId, project_id AS pid, handoff_id AS handoffId,
                    backend, repository_key AS repositoryKey, checkpoint, revision, reference,
                    consumption_id AS consumptionId, consumed_at AS consumedAt
               FROM mission_handoffs
              WHERE runner_id = ? AND consumed_at IS NOT NULL ORDER BY consumed_at`,
          ).bind(runnerId).all<{
            runId: string; pid: string; handoffId: string; backend: string; repositoryKey: string;
            checkpoint: string; revision: string; reference: string;
            consumptionId: string; consumedAt: string;
          }>();
          for (const item of consumed) {
            if (!(await this.authorizeProject(ws, auth, item.pid))) return;
            if (!this.sendIfOpen(ws, JSON.stringify({
              type: 'mission.handoff.consumed',
              consumed: {
                runId: item.runId,
                handoff: {
                  schemaVersion: 1, handoffId: item.handoffId, backend: item.backend,
                  repositoryKey: item.repositoryKey, checkpoint: item.checkpoint,
                  revision: item.revision, reference: item.reference,
                },
                consumptionId: item.consumptionId,
                consumedAt: item.consumedAt,
              },
            }))) return;
          }
        }
        // Mission questions use stable question/answer ids, so reconnect delivery may repeat
        // safely: the Runner applies each durable identity once rather than inferring from text.
        if (acceptedCapabilities.includes(MISSION_CAPABILITY)) {
          const { results: questions } = await this.env.DB.prepare(
            `SELECT q.project_id AS pid, q.root_run_id AS runId, q.attempt_id AS attemptId,
                    q.question_id AS questionId, q.signal_id AS signalId, q.state,
                    q.sitting, q.execution_id AS executionId, q.lease_epoch AS epoch,
                    q.answer_id AS answerId, q.answer, q.answered_at AS answeredAt
               FROM mission_questions q JOIN runs r ON r.id = q.root_run_id
              WHERE q.runner_id = ? AND q.state IN ('open','answered') AND r.reconciliation_pending = 0
                AND r.status IN ('dispatched','running','blocked') ORDER BY q.published_at`,
          ).bind(runnerId).all<{
            pid: string; runId: string; attemptId: string | null; questionId: string; signalId: string;
            state: 'open' | 'answered'; sitting: number; executionId: string; epoch: number;
            answerId: string | null; answer: string | null; answeredAt: string | null;
          }>();
          for (const item of questions) {
            if (!(await this.authorizeProject(ws, auth, item.pid))) return;
            const lease = { sitting: item.sitting, executionId: item.executionId, epoch: item.epoch };
            const frame = item.state === 'answered'
              ? {
                  type: 'mission.question.answer',
                  answer: {
                    answerId: item.answerId!, runId: item.runId, questionId: item.questionId,
                    attemptId: item.attemptId, lease, answer: item.answer!, answeredAt: item.answeredAt!,
                  },
                }
              : {
                  type: 'mission.question.ack', runId: item.runId, lease,
                  ack: {
                    reportId: `replay:${item.questionId}`, questionId: item.questionId,
                    attemptId: item.attemptId, accepted: true, state: 'open',
                    signalId: item.signalId, error: null,
                  },
                };
            if (!this.sendIfOpen(ws, JSON.stringify(frame))) return;
          }
        }
        // REST re-registration records only `reconciliation_pending`. The response window starts
        // here, after hello has actually negotiated mission.v2 on a socket that can answer.
        const { results: pendingProjects } = await this.env.DB.prepare(
          `SELECT DISTINCT project_id AS pid FROM runs
            WHERE runner_id = ? AND reconciliation_pending = 1
              AND reconciliation_deadline IS NULL
              AND status IN ('dispatched','running','blocked')`,
        ).bind(runnerId).all<{ pid: string }>();
        if (acceptedCapabilities.includes(MISSION_CAPABILITY)) {
          for (const { pid } of pendingProjects) {
            if (!(await this.authorizeProject(ws, auth, pid))) return;
            await this.room(pid).openRunnerMissionReconciliation(pid, runnerId, 30_000, true);
          }
          // A socket can reconnect after the request was durably opened but before its reply was
          // applied. Re-send the same deadline rather than restarting the bounded window.
          const { results: openedProjects } = await this.env.DB.prepare(
            `SELECT DISTINCT project_id AS pid FROM runs
              WHERE runner_id = ? AND reconciliation_pending = 1
                AND reconciliation_deadline IS NOT NULL
                AND status IN ('dispatched','running','blocked')`,
          ).bind(runnerId).all<{ pid: string }>();
          for (const { pid } of openedProjects) {
            if (!(await this.authorizeProject(ws, auth, pid))) return;
            const reconciliation = await this.room(pid).currentRunnerMissionReconciliation(pid, runnerId);
            if (reconciliation.deadline && reconciliation.items.length > 0
                && !this.sendIfOpen(ws, JSON.stringify({
                  type: 'mission.reconcile.request', deadline: reconciliation.deadline,
                  items: reconciliation.items,
                }))) return;
          }
        } else {
          // REST capability claims are advisory until hello. A peer that cannot negotiate the
          // mission channel gets the established fail-closed restart outcome, not an endless hold.
          for (const { pid } of pendingProjects) {
            if (!(await this.authorizeProject(ws, auth, pid))) return;
            await this.room(pid).reconcileRunnerRuns(pid, SYS, runnerId);
          }
        }
        // Redeliver Runs already dispatched to this runner but not yet started — they
        // may have been assigned while the socket was down (dispatch-before-connect).
        const { results } = await this.env.DB.prepare(
          `SELECT r.id, r.project_id AS pid FROM runs r
             LEFT JOIN plan_dispatches pd ON pd.id = r.plan_dispatch_id
            WHERE r.runner_id = ? AND r.status = 'dispatched'
              AND ((pd.strategy IS NULL OR pd.strategy <> 'single_root') AND r.mission_mode IS NULL
                   OR r.reconciliation_deadline IS NULL)`,
        ).bind(runnerId).all<{ id: string; pid: string }>();
        for (const r of results) {
          if (!(await this.authorizeProject(ws, auth, r.pid))) return;
          const run = await this.runView(r.id);
          if (run && !this.sendIfOpen(ws, await this.messageForSocket(ws, JSON.stringify({ type: 'run.assigned', run })))) return;
        }
        return;
      }

      case 'heartbeat': {
        if (msg.repos) await this.refreshExecutionProfiles(runnerId, msg.repos);
        await this.env.DB.prepare("UPDATE runners SET free_slots = ?, status = 'online', last_heartbeat_at = ? WHERE id = ?")
          .bind(msg.freeSlots, new Date().toISOString(), runnerId).run();
        // The plan-dispatch reconcile (PLNR-170). A shared runner's slots can free from
        // ANOTHER project's runs — an event the waiting project's room never hears — so the
        // periodic heartbeat is the wake-up that closes that gap. Best-effort: the rooms'
        // pumps are idempotent and the next heartbeat asks again.
        if (msg.freeSlots > 0 || msg.repos) {
          const { results } = await this.env.DB.prepare(
            "SELECT DISTINCT project_id AS pid FROM plan_dispatches WHERE runner_id = ? AND status IN ('active','stalled')",
          ).bind(runnerId).all<{ pid: string }>();
          for (const r of results) {
            try {
              await this.room(r.pid).pumpProjectDispatches(r.pid);
            } catch (err) {
              console.warn(`plan dispatch pump via heartbeat failed for ${r.pid}: ${String(err)}`);
            }
          }
        }
        return;
      }

      case 'run.status': {
        // Forward to the owning project's ProjectRoom (the Run authority). The runner
        // may only transition its OWN runs.
        const row = await this.env.DB.prepare('SELECT project_id AS pid, runner_id AS rid FROM runs WHERE id = ?')
          .bind(msg.runId).first<{ pid: string; rid: string | null }>();
        if (!row || row.rid !== runnerId) return;
        if (!(await this.authorizeProject(ws, auth, row.pid))) return;
        if (!(await this.missionFrameAccepted(auth, row.pid, msg.runId, msg.missionLease))) return;
        try {
          await this.room(row.pid).transitionRun(row.pid, SYS, msg.runId, {
            status: msg.status,
            agentId: msg.agentId ?? undefined,
            exit: msg.exit ?? undefined,
            worktreePath: msg.worktreePath ?? undefined,
            missionLease: msg.missionLease,
            observedAt: msg.at,
          });
        } catch (err) {
          // The DO is authoritative, so a rejected frame is dropped — but LOUDLY (RUN-45): this
          // exact catch silently ate every same-status report for the whole life of RUN-43,
          // which is how a dead frame kept looking load-bearing.
          console.warn(`run.status rejected for ${msg.runId}: ${String(err)}`);
        }
        return;
      }

      case 'execution.declare': {
        const pid = await this.authorizeRun(ws, auth, runnerId, msg.runId);
        if (!pid) return;
        if (!(await this.missionFrameAccepted(auth, pid, msg.runId, msg.missionLease))) return;
        try {
          const result = await declareRunnerExecution(this.env, msg.runId, msg.declaration);
          this.sendExecutionAck(ws, {
            reportId: msg.declaration.reportId, accepted: true, executionId: result.id,
            status: null, expectedRevision: null, error: null,
          });
        } catch (error) {
          this.sendExecutionAck(ws, this.rejectedAck(msg.declaration.reportId, error));
        }
        return;
      }

      case 'execution.relation': {
        const pid = await this.authorizeRun(ws, auth, runnerId, msg.runId);
        if (!pid) return;
        if (!(await this.missionFrameAccepted(auth, pid, msg.runId, msg.missionLease))) return;
        try {
          await reportRunnerExecutionRelation(this.env, msg.runId, msg.relation);
          this.sendExecutionAck(ws, {
            reportId: msg.relation.reportId, accepted: true, executionId: msg.relation.fromExecutionId,
            status: null, expectedRevision: null, error: null,
          });
        } catch (error) {
          this.sendExecutionAck(ws, this.rejectedAck(msg.relation.reportId, error));
        }
        return;
      }

      case 'execution.event': {
        const pid = await this.authorizeRun(ws, auth, runnerId, msg.runId);
        if (!pid) return;
        if (!(await this.missionFrameAccepted(auth, pid, msg.runId, msg.missionLease))) return;
        try {
          const result = await reportRunnerExecutionEvent(this.env, msg.runId, msg.event);
          this.sendExecutionAck(ws, {
            reportId: msg.event.reportId, accepted: true, executionId: msg.event.executionId,
            status: result.status, expectedRevision: result.expectedRevision, error: null,
          });
        } catch (error) {
          this.sendExecutionAck(ws, this.rejectedAck(msg.event.reportId, error, msg.event.executionId));
        }
        return;
      }

      case 'execution.reconcile': {
        const pid = await this.authorizeRun(ws, auth, runnerId, msg.runId);
        if (!pid) return;
        if (!(await this.missionFrameAccepted(auth, pid, msg.runId, msg.missionLease))) return;
        try {
          const result = await reconcileRunnerExecution(this.env, msg.runId, msg.reconciliation);
          for (const ack of result.acknowledgements) this.sendExecutionAck(ws, ack);
        } catch (error) {
          this.sendExecutionAck(ws, this.rejectedAck(msg.reconciliation.reportId, error));
        }
        return;
      }

      case 'mission.task.begin': {
        const pid = await this.authorizeMissionRun(ws, auth, runnerId, msg.runId);
        if (!pid) return;
        if (!(await this.missionFrameAccepted(auth, pid, msg.runId, msg.lease))) {
          this.sendMissionAck(ws, this.rejectedMissionAck(
            msg.begin.reportId, msg.begin.attemptId, 'begin', new Error('stale mission lease epoch'),
          ));
          return;
        }
        try {
          const ack = await this.room(pid).beginMissionTask(pid, msg.runId, msg.begin, msg.lease);
          this.sendMissionAck(ws, ack);
        } catch (error) {
          this.sendMissionAck(ws, this.rejectedMissionAck(
            msg.begin.reportId, msg.begin.attemptId, 'begin', error,
          ));
        }
        return;
      }

      case 'mission.task.settle': {
        const pid = await this.authorizeMissionRun(ws, auth, runnerId, msg.runId);
        if (!pid) return;
        if (!(await this.missionFrameAccepted(auth, pid, msg.runId, msg.lease))) {
          this.sendMissionAck(ws, this.rejectedMissionAck(
            msg.settle.reportId, msg.settle.attemptId, 'settle', new Error('stale mission lease epoch'),
          ));
          return;
        }
        try {
          const ack = await this.room(pid).settleMissionTask(pid, msg.runId, msg.settle, msg.lease);
          this.sendMissionAck(ws, ack);
        } catch (error) {
          this.sendMissionAck(ws, this.rejectedMissionAck(
            msg.settle.reportId, msg.settle.attemptId, 'settle', error,
          ));
        }
        return;
      }

      case 'mission.question.publish': {
        const pid = await this.authorizeMissionRun(ws, auth, runnerId, msg.runId);
        if (!pid) return;
        if (!(await this.missionFrameAccepted(auth, pid, msg.runId, msg.lease))) {
          this.sendMissionQuestionAck(ws, msg.runId, msg.lease, {
            reportId: msg.question.reportId, questionId: msg.question.questionId,
            attemptId: msg.question.attemptId, accepted: false, state: null, signalId: null,
            error: 'stale mission lease epoch',
          });
          return;
        }
        try {
          const ack = await this.room(pid).publishMissionQuestion(pid, msg.runId, msg.question, msg.lease);
          this.sendMissionQuestionAck(ws, msg.runId, msg.lease, ack);
        } catch (error) {
          this.sendMissionQuestionAck(ws, msg.runId, msg.lease, {
            reportId: msg.question.reportId, questionId: msg.question.questionId,
            attemptId: msg.question.attemptId, accepted: false, state: null, signalId: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case 'mission.handoff.publish': {
        if (!auth.capabilities?.includes(MISSION_HANDOFF_CAPABILITY)) return;
        const pid = await this.authorizeMissionRun(ws, auth, runnerId, msg.runId);
        if (!pid) return;
        if (!(await this.missionFrameAccepted(auth, pid, msg.runId, msg.lease))) {
          this.sendMissionHandoffAck(ws, this.rejectedMissionHandoffAck(
            msg.publication.reportId, new Error('stale mission lease epoch'),
          ));
          return;
        }
        try {
          const ack = await this.room(pid).publishMissionHandoff(
            pid, msg.runId, msg.publication.reportId, msg.publication.handoff, msg.lease,
          );
          this.sendMissionHandoffAck(ws, ack);
        } catch (error) {
          this.sendMissionHandoffAck(ws, this.rejectedMissionHandoffAck(msg.publication.reportId, error));
        }
        return;
      }

      case 'mission.reconcile': {
        if (!auth.capabilities?.includes(MISSION_CAPABILITY)) return;
        const results: MissionAdoptionResult[] = [];
        const adoptedRunIds: string[] = [];
        for (const inventory of msg.inventory) {
          const row = await this.env.DB.prepare(
            'SELECT project_id AS pid, runner_id AS rid FROM runs WHERE id = ?',
          ).bind(inventory.runId).first<{ pid: string; rid: string | null }>();
          if (!row || row.rid !== runnerId) {
            results.push({
              runId: inventory.runId, decision: 'unknown', lease: null,
              reason: 'mission root not found',
            });
            continue;
          }
          if (!(await this.authorizeProject(ws, auth, row.pid))) return;
          const result = await this.room(row.pid).adoptRunnerMission(row.pid, runnerId, inventory);
          results.push(result);
          if (result.decision === 'adopt') adoptedRunIds.push(inventory.runId);
        }
        this.sendIfOpen(ws, JSON.stringify({ type: 'mission.reconcile.result', results }));
        for (const runId of adoptedRunIds) {
          const { results: questions } = await this.env.DB.prepare(
            `SELECT attempt_id AS attemptId, question_id AS questionId, signal_id AS signalId, state,
                    sitting, execution_id AS executionId, lease_epoch AS epoch,
                    answer_id AS answerId, answer, answered_at AS answeredAt
               FROM mission_questions WHERE root_run_id = ? AND state IN ('open','answered')
              ORDER BY published_at`,
          ).bind(runId).all<{
            attemptId: string | null; questionId: string; signalId: string; state: 'open' | 'answered';
            sitting: number; executionId: string; epoch: number;
            answerId: string | null; answer: string | null; answeredAt: string | null;
          }>();
          for (const item of questions) {
            const lease = { sitting: item.sitting, executionId: item.executionId, epoch: item.epoch };
            const frame = item.state === 'answered'
              ? {
                  type: 'mission.question.answer',
                  answer: {
                    answerId: item.answerId!, runId, questionId: item.questionId,
                    attemptId: item.attemptId, lease, answer: item.answer!, answeredAt: item.answeredAt!,
                  },
                }
              : {
                  type: 'mission.question.ack', runId, lease,
                  ack: {
                    reportId: `replay:${item.questionId}`, questionId: item.questionId,
                    attemptId: item.attemptId, accepted: true, state: 'open', signalId: item.signalId, error: null,
                  },
                };
            if (!this.sendIfOpen(ws, JSON.stringify(frame))) return;
          }
        }
        return;
      }

      case 'run.telemetry': {
        // Non-transitional spend/log-tail/phase tick (RUN-22, RUN-31). Persist on the run row
        // via the owning project's authority; the runner may only report its OWN runs.
        const row = await this.env.DB.prepare('SELECT project_id AS pid, runner_id AS rid FROM runs WHERE id = ?')
          .bind(msg.runId).first<{ pid: string; rid: string | null }>();
        if (!row || row.rid !== runnerId) return;
        if (!(await this.authorizeProject(ws, auth, row.pid))) return;
        if (!(await this.missionFrameAccepted(auth, row.pid, msg.runId, msg.missionLease))) return;
        try {
          await this.room(row.pid).recordRunTelemetry(row.pid, msg.runId, {
            tokensUsed: msg.tokensUsed,
            usdSpent: msg.usdSpent,
            logTail: msg.logTail,
            phase: msg.phase,
            modelUsage: msg.modelUsage,
            executedSpec: msg.executedSpec,
            executedConfiguration: msg.executedConfiguration,
          });
        } catch { /* best-effort telemetry — never fatal */ }
        return;
      }

      case 'run.log': {
        // Transcript segments (RUN-74): append-only, idempotent on (run_id, seq). Same
        // ownership rule and same best-effort posture as telemetry — a transcript must
        // never gate a run's lifecycle.
        const row = await this.env.DB.prepare('SELECT project_id AS pid, runner_id AS rid FROM runs WHERE id = ?')
          .bind(msg.runId).first<{ pid: string; rid: string | null }>();
        if (!row || row.rid !== runnerId) return;
        if (!(await this.authorizeProject(ws, auth, row.pid))) return;
        try {
          await this.room(row.pid).appendRunLog(row.pid, msg.runId, msg.segments);
        } catch { /* best-effort — never fatal */ }
        return;
      }

      case 'steer.ack': {
        // The runtime-channel dedup ack (RUN-17). Look up the steer we sent to map
        // steerId → (agent, source id); on a live runtime delivery, record it in
        // runtime_deliveries so computeUpdates suppresses the notices fallback for
        // that source (dedup by the stable source id).
        const steer = await this.env.DB.prepare(
          `SELECT s.agent_id AS agentId, s.source_id AS sourceId, s.run_id AS runId, r.project_id AS pid
             FROM steers s JOIN runs r ON r.id = s.run_id WHERE s.id = ?`,
        ).bind(msg.steerId).first<{ agentId: string | null; sourceId: string | null; runId: string; pid: string }>();
        if (!steer || !(await this.authorizeProject(ws, auth, steer.pid))) return;
        await this.env.DB.prepare('UPDATE steers SET delivered_via = ?, acked_at = ? WHERE id = ?')
          .bind(msg.via, new Date().toISOString(), msg.steerId).run();
        if (steer && msg.via === 'runtime' && msg.delivered && steer.agentId && steer.sourceId) {
          await this.env.DB.prepare(
            'INSERT OR IGNORE INTO runtime_deliveries (agent_id, message_id, run_id) VALUES (?, ?, ?)',
          ).bind(steer.agentId, steer.sourceId, steer.runId).run();
        }
        return;
      }
    }
  }

  override async webSocketClose(ws: WebSocket) {
    ws.close();
  }

  /**
   * Every schema-valid v1 frame terminates here. Keeping this as a boolean guard (rather than
   * leaving an unconditional return above the old switch) lets TypeScript continue checking
   * the retained migration-reference code without making any of it reachable at runtime.
   */
  private async handleLegacyCutoverFrame(
    ws: WebSocket,
    auth: RunnerSocketAuth,
    runnerId: string,
    message: RunnerClientMessage,
  ): Promise<boolean> {
    if (message.type === 'ping') {
      this.sendIfOpen(ws, JSON.stringify({ type: 'pong' }));
      return true;
    }
    if (message.type === 'hello') {
      ws.serializeAttachment({ ...auth, capabilities: [] } satisfies RunnerSocketAuth);
      this.sendIfOpen(ws, JSON.stringify({
        type: 'registered', runnerId, protocol: RUNNER_PROTOCOL_VERSION,
        serverTime: new Date().toISOString(), acceptedCapabilities: [],
      }));
      return true;
    }
    if (message.type === 'heartbeat') {
      await this.env.DB.prepare("UPDATE runners SET free_slots = ?, status = 'online', last_heartbeat_at = ? WHERE id = ?")
        .bind(message.freeSlots, new Date().toISOString(), runnerId).run();
      return true;
    }
    console.warn(`ignored legacy Runner frame after RunnerJob cutover: ${message.type}`);
    return true;
  }

  private async handleRunnerJobMessage(
    ws: WebSocket,
    auth: RunnerSocketAuth,
    runnerId: string,
    message: RunnerJobRunnerMessage,
  ): Promise<void> {
    if (message.type === 'hello') {
      if (message.runnerId !== runnerId) {
        ws.close(1008, 'runner identity mismatch');
        return;
      }
      ws.serializeAttachment({ ...auth, jobProtocol: 2 } satisfies RunnerSocketAttachment);
      await this.refreshRunnerJobRepositories(runnerId, message.repositories);
      await this.env.DB.prepare(
        "UPDATE runners SET free_slots = ?, status = 'online', last_heartbeat_at = ? WHERE id = ?",
      ).bind(message.capacity, new Date().toISOString(), runnerId).run();
      const { results: jobs } = await this.env.DB.prepare(
        `SELECT id, project_id AS pid, status, assignment_id AS assignmentId,
                cancel_requested_at AS cancelRequestedAt
           FROM runner_jobs
          WHERE runner_id = ? AND status IN ('queued','assigned','running','waiting')
          ORDER BY created_at`,
      ).bind(runnerId).all<{
        id: string; pid: string; status: string; assignmentId: string; cancelRequestedAt: string | null;
      }>();
      let free = message.capacity - jobs.filter((job) => ['assigned', 'running', 'waiting'].includes(job.status)).length;
      for (const job of jobs) {
        if (!(await this.authorizeProject(ws, auth, job.pid))) return;
        if (job.cancelRequestedAt) {
          if (!this.sendIfOpen(ws, JSON.stringify({
            type: 'job.cancel', jobId: job.id, assignmentId: job.assignmentId,
            reason: 'cancellation requested while disconnected',
          }))) return;
          continue;
        }
        if (job.status === 'queued' && free <= 0) continue;
        const assignment = await this.room(job.pid).assignRunnerJob(job.pid, job.id, runnerId);
        if (assignment) {
          if (!this.sendIfOpen(ws, JSON.stringify({ type: 'job.assign', assignment }))) return;
          if (job.status === 'queued') free -= 1;
        }
      }
      const { results: answers } = await this.env.DB.prepare(
        `SELECT q.job_id AS jobId, j.assignment_id AS assignmentId,
                q.question_id AS questionId, q.answer
           FROM runner_job_questions q JOIN runner_jobs j ON j.id = q.job_id
          WHERE j.runner_id = ? AND q.state = 'answered'
            AND j.status IN ('assigned','running','waiting') ORDER BY q.answered_at`,
      ).bind(runnerId).all<{
        jobId: string; assignmentId: string; questionId: string; answer: string;
      }>();
      for (const answer of answers) {
        if (!this.sendIfOpen(ws, JSON.stringify({ type: 'job.answer', ...answer }))) return;
      }
      return;
    }

    if ((auth as RunnerSocketAttachment).jobProtocol !== 2) {
      ws.close(1002, 'protocol v2 hello required');
      return;
    }

    if (message.type === 'heartbeat') {
      await this.env.DB.prepare(
        "UPDATE runners SET free_slots = ?, status = 'online', last_heartbeat_at = ? WHERE id = ?",
      ).bind(message.freeSlots, new Date().toISOString(), runnerId).run();
      if (message.freeSlots > 0) {
        const { results } = await this.env.DB.prepare(
          "SELECT id FROM runner_jobs WHERE runner_id = ? AND status = 'queued' ORDER BY created_at LIMIT ?",
        ).bind(runnerId, message.freeSlots).all<{ id: string }>();
        for (const job of results) await this.deliverRunnerJob(job.id);
      }
      return;
    }

    const row = await this.env.DB.prepare(
      'SELECT project_id AS pid, runner_id AS runnerId FROM runner_jobs WHERE id = ?',
    ).bind(message.jobId).first<{ pid: string; runnerId: string }>();
    if (!row || row.runnerId !== runnerId || !(await this.authorizeProject(ws, auth, row.pid))) {
      ws.close(1008, 'RunnerJob is outside this runner');
      return;
    }
    if (message.type === 'job.accept') {
      const accepted = await this.room(row.pid).acceptRunnerJob(
        row.pid, message.jobId, runnerId, message.assignmentId,
      );
      if (!accepted) ws.close(1008, 'stale assignment');
      return;
    }
    if (message.type === 'job.event') {
      const result = await this.room(row.pid).recordRunnerJobEvent(
        row.pid, message.jobId, runnerId, message.assignmentId, message.seq, message.payload,
      );
      if (!result.accepted) {
        ws.close(1008, result.error ?? 'RunnerJob event rejected');
        return;
      }
      this.sendIfOpen(ws, JSON.stringify({
        type: 'job.event.ack', jobId: message.jobId,
        assignmentId: message.assignmentId, seq: result.ack,
      }));
      return;
    }
    const action = await this.room(row.pid).reconcileRunnerJob(
      row.pid, message.jobId, runnerId, message.assignmentId, message.lastLocalSeq,
    );
    this.sendIfOpen(ws, JSON.stringify({
      type: 'job.reconcile.result', jobId: message.jobId,
      assignmentId: message.assignmentId, action,
    }));
  }

  private room(projectId: string) {
    return this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId));
  }

  /** WebSocket liveness refreshes only nested secret-free profile offers. Project/repository
   * resolution remains the REST registration authority; a daemon cannot rewrite it in hello. */
  private async refreshExecutionProfiles(runnerId: string, advertised: RunnerRepo[]): Promise<void> {
    if (advertised.length === 0) return;
    const row = await this.env.DB.prepare('SELECT repos FROM runners WHERE id = ?')
      .bind(runnerId).first<{ repos: string }>();
    if (!row) return;
    let stored: Array<Record<string, unknown> & { id: string; executionProfiles?: unknown }>;
    try {
      stored = (JSON.parse(row.repos || '[]') as Array<Record<string, unknown> & { id: string }>);
    } catch { return; }
    const incoming = new Map(advertised.map((repo) => [repo.id, repo.executionProfiles]));
    let changed = false;
    const merged = stored.map((repo) => {
      const profiles = incoming.get(repo.id);
      if (!profiles) return repo;
      changed = true;
      return { ...repo, executionProfiles: profiles };
    });
    if (changed) {
      await this.env.DB.prepare('UPDATE runners SET repos = ? WHERE id = ?')
        .bind(JSON.stringify(merged), runnerId).run();
    }
  }

  /** V2 hello may refresh only the base revision and opaque repoRef of an already-authorized
   * registration. Project association remains the REST registration authority. */
  private async refreshRunnerJobRepositories(
    runnerId: string,
    advertised: Array<{ repositoryKey: string; repoRef: string; baseRevision: string }>,
  ): Promise<void> {
    const row = await this.env.DB.prepare('SELECT repos FROM runners WHERE id = ?')
      .bind(runnerId).first<{ repos: string }>();
    if (!row) return;
    let stored: Array<Record<string, unknown> & { id?: string; repositoryKey?: string | null }>;
    try { stored = JSON.parse(row.repos || '[]') as typeof stored; } catch { return; }
    const merged = stored.map((repository) => {
      const incoming = advertised.find((candidate) =>
        candidate.repoRef === repository.id || candidate.repositoryKey === repository.repositoryKey,
      );
      return incoming ? { ...repository, repoRef: incoming.repoRef, baseRevision: incoming.baseRevision } : repository;
    });
    await this.env.DB.prepare('UPDATE runners SET repos = ? WHERE id = ?')
      .bind(JSON.stringify(merged), runnerId).run();
  }

  /** Async authorization/redelivery work may outlive a peer-initiated close. Treat that as an
   * ordinary disconnected socket, not an unhandled Durable Object exception. */
  private sendIfOpen(ws: WebSocket, message: string): boolean {
    try {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(message);
      return true;
    } catch {
      return false;
    }
  }

  private sendExecutionAck(ws: WebSocket, ack: ExecutionReportAck): void {
    this.sendIfOpen(ws, JSON.stringify({ type: 'execution.ack', ack }));
  }

  private rejectedAck(reportId: string, error: unknown, executionId: string | null = null): ExecutionReportAck {
    return {
      reportId, accepted: false, executionId, status: null, expectedRevision: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  private sendMissionAck(ws: WebSocket, ack: MissionTaskAck): void {
    this.sendIfOpen(ws, JSON.stringify({ type: 'mission.task.ack', ack }));
  }

  private rejectedMissionAck(
    reportId: string,
    attemptId: string,
    phase: 'begin' | 'settle',
    error: unknown,
  ): MissionTaskAck {
    return {
      reportId, attemptId, phase, accepted: false, taskId: null, claimId: null,
      executionId: null, taskStatus: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  private sendMissionHandoffAck(ws: WebSocket, ack: MissionHandoffAck): void {
    this.sendIfOpen(ws, JSON.stringify({ type: 'mission.handoff.ack', ack }));
  }

  private sendMissionQuestionAck(
    ws: WebSocket, runId: string, lease: MissionLeaseRef, ack: MissionQuestionAck,
  ): void {
    this.sendIfOpen(ws, JSON.stringify({ type: 'mission.question.ack', runId, lease, ack }));
  }

  private rejectedMissionHandoffAck(reportId: string, error: unknown): MissionHandoffAck {
    return {
      reportId, accepted: false, handoffId: null, state: null, preservedAt: null,
      consumedAt: null, consumptionId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  private async authorizeRun(
    ws: WebSocket, auth: RunnerSocketAuth, runnerId: string, runId: string,
  ): Promise<string | null> {
    if (!auth.capabilities?.includes(ORCHESTRATION_CAPABILITY)) return null;
    const row = await this.env.DB.prepare('SELECT project_id AS pid, runner_id AS rid FROM runs WHERE id = ?')
      .bind(runId).first<{ pid: string; rid: string | null }>();
    if (!row || row.rid !== runnerId) return null;
    return await this.authorizeProject(ws, auth, row.pid) ? row.pid : null;
  }

  private async authorizeMissionRun(
    ws: WebSocket, auth: RunnerSocketAuth, runnerId: string, runId: string,
  ): Promise<string | null> {
    if (!auth.capabilities?.includes(MISSION_CAPABILITY)) return null;
    const row = await this.env.DB.prepare(
      `SELECT r.project_id AS pid, r.runner_id AS rid
         FROM runs r LEFT JOIN plan_dispatches pd ON pd.id = r.plan_dispatch_id
        WHERE r.id = ? AND (pd.strategy = 'single_root' OR r.mission_mode = 'task_root')`,
    ).bind(runId).first<{ pid: string; rid: string | null }>();
    if (!row || row.rid !== runnerId) return null;
    return await this.authorizeProject(ws, auth, row.pid) ? row.pid : null;
  }

  /** Mission roots are fenced by a server-issued sitting/execution/epoch tuple. Ordinary Runs
   * keep accepting the legacy frame shape; a mission frame without the negotiated lease is
   * deliberately ignored before it can mutate lifecycle or orchestration state. */
  private async missionFrameAccepted(
    auth: RunnerSocketAuth,
    projectId: string,
    runId: string,
    lease: MissionLeaseRef | null,
  ): Promise<boolean> {
    const mission = await this.env.DB.prepare(
      `SELECT 1 AS ok FROM runs r LEFT JOIN plan_dispatches pd ON pd.id = r.plan_dispatch_id
        WHERE r.id = ? AND r.project_id = ?
          AND (pd.strategy = 'single_root' OR r.mission_mode = 'task_root')`,
    ).bind(runId, projectId).first<{ ok: number }>();
    if (!mission) return true;
    if (!auth.capabilities?.includes(MISSION_CAPABILITY)) return false;
    const accepted = await this.room(projectId).validateMissionLease(projectId, runId, lease);
    if (!accepted) console.warn(`stale mission lease rejected for ${runId}`);
    return accepted;
  }

  /** Strip orchestration from legacy sockets and derive it server-side for negotiated peers. */
  private async messageForSocket(ws: WebSocket, json: string): Promise<string> {
    let parsed: { type?: string; run?: Record<string, unknown> };
    try { parsed = JSON.parse(json) as typeof parsed; } catch { return json; }
    if (parsed.type !== 'run.assigned' || !parsed.run || typeof parsed.run.id !== 'string') return json;
    const auth = ws.deserializeAttachment() as RunnerSocketAuth | null;
    const run = { ...parsed.run };
    if (auth?.capabilities?.includes(ORCHESTRATION_CAPABILITY)) {
      run.execution = await ensureRunExecution(this.env, parsed.run.id);
    } else {
      delete run.execution;
    }
    if (auth?.capabilities?.includes(MISSION_CAPABILITY)) {
      const mission = await this.env.DB.prepare(
        `SELECT r.project_id AS pid, r.sitting, r.lease_epoch AS epoch
           FROM runs r LEFT JOIN plan_dispatches pd ON pd.id = r.plan_dispatch_id
          WHERE r.id = ? AND (pd.strategy = 'single_root' OR r.mission_mode = 'task_root')`,
      ).bind(parsed.run.id).first<{ pid: string; sitting: number; epoch: number }>();
      if (mission) {
        const assignment = await ensureRunExecution(this.env, parsed.run.id);
        let commission = await this.env.DB.prepare(
          'SELECT digest, snapshot FROM mission_commissions WHERE root_run_id = ?',
        ).bind(parsed.run.id).first<{ digest: string; snapshot: string }>();
        commission ??= await this.env.DB.prepare(
          'SELECT digest, snapshot FROM mission_task_root_commissions WHERE root_run_id = ?',
        ).bind(parsed.run.id).first<{ digest: string; snapshot: string }>();
        return JSON.stringify({
          ...parsed,
          run,
          missionLease: {
            sitting: mission.sitting,
            executionId: assignment.executionId,
            epoch: mission.epoch,
          },
          missionCommission: commission
            ? { digest: commission.digest, snapshot: JSON.parse(commission.snapshot) }
            : null,
        });
      }
    }
    return JSON.stringify({ ...parsed, run });
  }

  /** A runner credential never inherits a human administrator override. Re-check the OAuth
   * connection and account ceiling for every frame so revocation/read-only changes take effect
   * without waiting for the socket to reconnect. */
  private async authorizeSocket(ws: WebSocket): Promise<RunnerSocketAuth | null> {
    const auth = ws.deserializeAttachment() as RunnerSocketAuth | null;
    if (!auth?.userId || !auth.tokenId) {
      ws.close(1008, 'authorization required');
      return null;
    }
    const [token, account] = await Promise.all([
      this.env.DB.prepare(
        `SELECT 1 AS ok FROM oauth_tokens
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL
            AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).bind(auth.tokenId, auth.userId).first<{ ok: number }>(),
      resolveAccountCapabilities(this.env.DB, auth.userId),
    ]);
    if (!token || account.disabled || account.accessMode !== 'read_write') {
      ws.close(1008, 'runner authorization revoked');
      return null;
    }
    return auth;
  }

  private async authorizeProject(ws: WebSocket, auth: RunnerSocketAuth, projectId: string): Promise<boolean> {
    const [access, tokenReach] = await Promise.all([
      resolveProjectAccess(this.env.DB, auth.userId, projectId),
      tokenCanReachProject(this.env, auth.tokenId, projectId),
    ]);
    if (!projectRoleAllows(access.role, 'contribute') || !tokenReach) {
      ws.close(1008, 'project authorization revoked');
      return false;
    }
    return true;
  }

  /** Fetch a Run as the wire shape via its project's authority. */
  private async runView(runId: string) {
    const row = await this.env.DB.prepare('SELECT project_id AS pid FROM runs WHERE id = ?')
      .bind(runId).first<{ pid: string }>();
    if (!row) return null;
    try {
      return await this.room(row.pid).getRun(row.pid, runId);
    } catch { return null; }
  }
}
