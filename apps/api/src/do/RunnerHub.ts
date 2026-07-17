import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import type { Actor } from './ProjectRoom';
import { RunnerClientMessage, RUNNER_PROTOCOL_VERSION } from '@noriq-dev/shared';

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
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Push a server→daemon message onto the live socket. Returns whether anyone got it. */
  async deliver(json: string): Promise<{ delivered: boolean }> {
    let delivered = false;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(json); delivered = true; } catch { /* socket gone */ }
    }
    return { delivered };
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message !== 'string') return;
    const runnerId = await this.loadRunnerId();
    if (!runnerId) return;
    let parsed;
    try {
      parsed = RunnerClientMessage.safeParse(JSON.parse(message));
    } catch { return; }
    if (!parsed.success) return;
    const msg = parsed.data;

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        return;

      case 'hello': {
        ws.send(JSON.stringify({ type: 'registered', runnerId, protocol: RUNNER_PROTOCOL_VERSION, serverTime: new Date().toISOString() }));
        // Redeliver Runs already dispatched to this runner but not yet started — they
        // may have been assigned while the socket was down (dispatch-before-connect).
        const { results } = await this.env.DB.prepare(
          "SELECT id FROM runs WHERE runner_id = ? AND status = 'dispatched'",
        ).bind(runnerId).all<{ id: string }>();
        for (const r of results) {
          const run = await this.runView(r.id);
          if (run) ws.send(JSON.stringify({ type: 'run.assigned', run }));
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
        try {
          await this.room(row.pid).transitionRun(row.pid, SYS, msg.runId, {
            status: msg.status,
            agentId: msg.agentId ?? undefined,
            exit: msg.exit ?? undefined,
            worktreePath: msg.worktreePath ?? undefined,
          });
        } catch (err) {
          // The DO is authoritative, so a rejected frame is dropped — but LOUDLY (RUN-45): this
          // exact catch silently ate every same-status report for the whole life of RUN-43,
          // which is how a dead frame kept looking load-bearing.
          console.warn(`run.status rejected for ${msg.runId}: ${String(err)}`);
        }
        return;
      }

      case 'run.telemetry': {
        // Non-transitional spend/log-tail/phase tick (RUN-22, RUN-31). Persist on the run row
        // via the owning project's authority; the runner may only report its OWN runs.
        const row = await this.env.DB.prepare('SELECT project_id AS pid, runner_id AS rid FROM runs WHERE id = ?')
          .bind(msg.runId).first<{ pid: string; rid: string | null }>();
        if (!row || row.rid !== runnerId) return;
        try {
          await this.room(row.pid).recordRunTelemetry(row.pid, msg.runId, {
            tokensUsed: msg.tokensUsed,
            usdSpent: msg.usdSpent,
            logTail: msg.logTail,
            phase: msg.phase,
            modelUsage: msg.modelUsage,
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
          'SELECT agent_id AS agentId, source_id AS sourceId, run_id AS runId FROM steers WHERE id = ?',
        ).bind(msg.steerId).first<{ agentId: string | null; sourceId: string | null; runId: string }>();
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

  private room(projectId: string) {
    return this.env.PROJECT_ROOM.get(this.env.PROJECT_ROOM.idFromName(projectId));
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
