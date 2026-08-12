import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import type { Actor } from './ProjectRoom';
import {
  ORCHESTRATION_CAPABILITY,
  MISSION_CAPABILITY,
  RunnerClientMessage,
  RUNNER_PROTOCOL_CAPABILITIES,
  RUNNER_PROTOCOL_VERSION,
  type ExecutionReportAck,
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
    let parsed;
    try {
      parsed = RunnerClientMessage.safeParse(JSON.parse(message));
    } catch { return; }
    if (!parsed.success) return;
    const msg = parsed.data;

    switch (msg.type) {
      case 'ping':
        this.sendIfOpen(ws, JSON.stringify({ type: 'pong' }));
        return;

      case 'hello': {
        const acceptedCapabilities = RUNNER_PROTOCOL_CAPABILITIES.filter((capability) =>
          msg.protocolCapabilities.includes(capability));
        ws.serializeAttachment({ ...auth, capabilities: acceptedCapabilities } satisfies RunnerSocketAuth);
        if (!this.sendIfOpen(ws, JSON.stringify({
          type: 'registered', runnerId, protocol: RUNNER_PROTOCOL_VERSION,
          serverTime: new Date().toISOString(), acceptedCapabilities,
        }))) return;
        // Redeliver Runs already dispatched to this runner but not yet started — they
        // may have been assigned while the socket was down (dispatch-before-connect).
        const { results } = await this.env.DB.prepare(
          "SELECT id, project_id AS pid FROM runs WHERE runner_id = ? AND status = 'dispatched'",
        ).bind(runnerId).all<{ id: string; pid: string }>();
        for (const r of results) {
          if (!(await this.authorizeProject(ws, auth, r.pid))) return;
          const run = await this.runView(r.id);
          if (run && !this.sendIfOpen(ws, await this.messageForSocket(ws, JSON.stringify({ type: 'run.assigned', run })))) return;
        }
        return;
      }

      case 'heartbeat': {
        await this.env.DB.prepare("UPDATE runners SET free_slots = ?, status = 'online', last_heartbeat_at = ? WHERE id = ?")
          .bind(msg.freeSlots, new Date().toISOString(), runnerId).run();
        // The plan-dispatch reconcile (PLNR-170). A shared runner's slots can free from
        // ANOTHER project's runs — an event the waiting project's room never hears — so the
        // periodic heartbeat is the wake-up that closes that gap. Best-effort: the rooms'
        // pumps are idempotent and the next heartbeat asks again.
        if (msg.freeSlots > 0) {
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
        try {
          await this.room(row.pid).transitionRun(row.pid, SYS, msg.runId, {
            status: msg.status,
            agentId: msg.agentId ?? undefined,
            exit: msg.exit ?? undefined,
            worktreePath: msg.worktreePath ?? undefined,
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
        try {
          const ack = await this.room(pid).beginMissionTask(pid, msg.runId, msg.begin);
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
        try {
          const ack = await this.room(pid).settleMissionTask(pid, msg.runId, msg.settle);
          this.sendMissionAck(ws, ack);
        } catch (error) {
          this.sendMissionAck(ws, this.rejectedMissionAck(
            msg.settle.reportId, msg.settle.attemptId, 'settle', error,
          ));
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

  private room(projectId: string) {
    return this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId));
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
         FROM runs r JOIN plan_dispatches pd ON pd.id = r.plan_dispatch_id
        WHERE r.id = ? AND r.anchor_type = 'plan' AND pd.strategy = 'single_root'`,
    ).bind(runId).first<{ pid: string; rid: string | null }>();
    if (!row || row.rid !== runnerId) return null;
    return await this.authorizeProject(ws, auth, row.pid) ? row.pid : null;
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
