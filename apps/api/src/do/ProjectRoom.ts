import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { newId, nowIso } from '../lib/util';

/**
 * ProjectRoom — one instance per project (idFromName(projectId)).
 *
 * The coordination authority (ROADMAP §3/§7):
 *  - SOLE WRITER of project-scoped rows in D1 — every mutation is serialized here,
 *    which is what makes the claim guarantees hold (no read-modify-write races).
 *  - Claim/lock arbiter: at most one live claim per task; TTL renewed by heartbeat;
 *    dependency gating; alarm-driven auto-requeue of expired claims.
 *  - Every mutation appends to the per-project event log (monotonic seq) and fans
 *    out over WebSocket to subscribed UIs/agents (hibernation API).
 */

export interface Actor {
  kind: 'agent' | 'human' | 'system';
  id: string;
  name: string;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  parentTaskId?: string | null;
  milestoneId?: string | null;
  priority?: number;
  estimate?: number | null;
  dependsOn?: string[];
}

export interface TaskPatch {
  title?: string;
  body?: string;
  status?: string;
  priority?: number;
  estimate?: number | null;
  milestoneId?: string | null;
  order?: number;
}

type TaskRow = {
  id: string;
  key: string;
  status: string;
  claimed_by: string | null;
  claim_expires_at: string | null;
  title: string;
};

const CLAIMABLE_STATUSES = ['todo', 'claimed'];

export class ProjectRoom extends DurableObject<Env> {
  // Set explicitly by every entry point (RPC arg / WS URL / storage after hibernation)
  // rather than relying on ctx.id.name, which some runtimes don't expose.
  private _pid?: string;

  private get projectId(): string {
    if (!this._pid) throw new Error('ProjectRoom: projectId not bound');
    return this._pid;
  }

  private async setPid(pid: string) {
    if (this._pid === pid) return;
    this._pid = pid;
    await this.ctx.storage.put('pid', pid);
  }

  /** Recover pid after hibernation (alarm / webSocketMessage wake-ups). */
  private async loadPid() {
    if (!this._pid) {
      this._pid = this.ctx.id.name ?? (await this.ctx.storage.get<string>('pid')) ?? undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Event log + fanout
  // ---------------------------------------------------------------------------

  private async emit(
    actor: Actor,
    verb: string,
    subjectType: string,
    subjectId: string,
    payload: Record<string, unknown> = {},
  ) {
    const pid = this.projectId;
    // Sole-writer invariant makes read-increment-write on next_event_seq safe.
    const seqRow = await this.env.DB.prepare('SELECT next_event_seq AS seq FROM projects WHERE id = ?')
      .bind(pid)
      .first<{ seq: number }>();
    const seq = seqRow?.seq ?? 1;
    const id = newId('ev');
    const createdAt = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO events (id, project_id, seq, actor_kind, actor_id, verb, subject_type, subject_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, pid, seq, actor.kind, actor.id, verb, subjectType, subjectId, JSON.stringify({ actorName: actor.name, ...payload }), createdAt),
      this.env.DB.prepare('UPDATE projects SET next_event_seq = ? WHERE id = ?').bind(seq + 1, pid),
    ]);
    const event = {
      id, projectId: pid, seq,
      actorKind: actor.kind, actorId: actor.id, actorName: actor.name,
      verb, subjectType, subjectId, payload, createdAt,
    };
    this.broadcast(JSON.stringify({ type: 'event', event }));
    return event;
  }

  broadcast(data: string) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* socket gone; hibernation API cleans up */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket live channel
  // ---------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const m = new URL(request.url).pathname.match(/\/ws\/projects\/([^/]+)/);
      if (m) await this.setPid(decodeURIComponent(m[1]!));
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message !== 'string') return;
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (msg.type === 'subscribe') {
        await this.loadPid();
        const since = typeof msg.sinceSeq === 'number' ? msg.sinceSeq : 0;
        const { results } = await this.env.DB.prepare(
          `SELECT id, seq, actor_kind AS actorKind, actor_id AS actorId, verb,
                  subject_type AS subjectType, subject_id AS subjectId, payload, created_at AS createdAt
           FROM events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT 200`,
        )
          .bind(this.projectId, since)
          .all();
        const events = results.map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
        ws.send(JSON.stringify({ type: 'backlog', events }));
      }
    } catch {
      /* ignore malformed frames */
    }
  }

  override async webSocketClose(ws: WebSocket) {
    ws.close();
  }

  // ---------------------------------------------------------------------------
  // Task CRUD (RPC from the Worker)
  // ---------------------------------------------------------------------------

  async createTask(projectId: string, actor: Actor, input: CreateTaskInput) {
    await this.setPid(projectId);
    const pid = this.projectId;
    const proj = await this.env.DB.prepare('SELECT key, next_task_number AS n FROM projects WHERE id = ?')
      .bind(pid)
      .first<{ key: string; n: number }>();
    if (!proj) throw new Error(`project ${pid} not found`);
    const id = newId('task');
    const key = `${proj.key}-${proj.n}`;
    const now = nowIso();
    const stmts = [
      this.env.DB.prepare(
        `INSERT INTO tasks (id, project_id, key, milestone_id, parent_task_id, title, body, status, priority, estimate, "order", created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?)`,
      ).bind(id, pid, key, input.milestoneId ?? null, input.parentTaskId ?? null, input.title, input.body ?? '', input.priority ?? 2, input.estimate ?? null, proj.n, now, now),
      this.env.DB.prepare('UPDATE projects SET next_task_number = ? WHERE id = ?').bind(proj.n + 1, pid),
    ];
    for (const dep of input.dependsOn ?? []) {
      stmts.push(
        this.env.DB.prepare('INSERT OR IGNORE INTO dependencies (task_id, depends_on_task_id) VALUES (?, ?)').bind(id, dep),
      );
    }
    await this.env.DB.batch(stmts);
    await this.emit(actor, input.parentTaskId ? 'task.created' : 'task.created', 'task', id, {
      key, title: input.title, parentTaskId: input.parentTaskId ?? null,
    });
    return { id, key };
  }

  async updateTask(projectId: string, actor: Actor, taskId: string, patch: TaskPatch) {
    await this.setPid(projectId);
    const task = await this.getTask(taskId);
    const sets: string[] = [];
    const binds: unknown[] = [];
    const fields: Array<[keyof TaskPatch, string]> = [
      ['title', 'title'], ['body', 'body'], ['priority', 'priority'],
      ['estimate', 'estimate'], ['milestoneId', 'milestone_id'], ['order', '"order"'],
    ];
    for (const [k, col] of fields) {
      if (patch[k] !== undefined) {
        sets.push(`${col} = ?`);
        binds.push(patch[k]);
      }
    }
    let statusChanged = false;
    if (patch.status !== undefined && patch.status !== task.status) {
      sets.push('status = ?');
      binds.push(patch.status);
      statusChanged = true;
      if (patch.status === 'done' || patch.status === 'cancelled' || patch.status === 'todo') {
        sets.push('claimed_by = NULL', 'claim_expires_at = NULL');
        await this.env.DB.prepare('UPDATE claims SET released_at = ? WHERE task_id = ? AND released_at IS NULL')
          .bind(nowIso(), taskId)
          .run();
      }
    }
    if (!sets.length) return { ok: true, key: task.key };
    sets.push('updated_at = ?');
    binds.push(nowIso(), taskId);
    await this.env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
    if (statusChanged) {
      await this.emit(actor, 'task.status_changed', 'task', taskId, { key: task.key, from: task.status, to: patch.status, title: task.title });
    } else {
      await this.emit(actor, 'task.updated', 'task', taskId, { key: task.key, fields: Object.keys(patch) });
    }
    return { ok: true, key: task.key };
  }

  async addDependency(projectId: string, actor: Actor, taskId: string, dependsOnTaskId: string) {
    await this.setPid(projectId);
    if (taskId === dependsOnTaskId) throw new Error('a task cannot depend on itself');
    const [task, dep] = await Promise.all([this.getTask(taskId), this.getTask(dependsOnTaskId)]);
    // Cycle guard: walk dep's transitive deps looking for taskId.
    const { results } = await this.env.DB.prepare(
      `WITH RECURSIVE up(id) AS (
         SELECT depends_on_task_id FROM dependencies WHERE task_id = ?
         UNION SELECT d.depends_on_task_id FROM dependencies d JOIN up ON d.task_id = up.id)
       SELECT id FROM up WHERE id = ?`,
    ).bind(dependsOnTaskId, taskId).all();
    if (results.length) throw new Error('dependency would create a cycle');
    await this.env.DB.prepare('INSERT OR IGNORE INTO dependencies (task_id, depends_on_task_id) VALUES (?, ?)')
      .bind(taskId, dependsOnTaskId)
      .run();
    await this.emit(actor, 'dependency.added', 'task', taskId, { key: task.key, dependsOn: dep.key });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Claim arbiter — the reason this DO exists
  // ---------------------------------------------------------------------------

  async claimTask(projectId: string, actor: Actor, taskId: string, agentId: string) {
    await this.setPid(projectId);
    const task = await this.getTask(taskId);
    if (!CLAIMABLE_STATUSES.includes(task.status)) {
      throw new Error(`${task.key} is not claimable (status: ${task.status})`);
    }
    if (task.claimed_by && task.claim_expires_at && task.claim_expires_at > nowIso()) {
      throw new Error(`${task.key} is already claimed by another agent`);
    }
    const blockers = await this.unfinishedDeps(taskId);
    if (blockers.length) {
      throw new Error(`${task.key} is blocked by unfinished dependencies: ${blockers.join(', ')}`);
    }
    const ttl = await this.claimTtlSeconds();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const claimId = newId('clm');
    await this.env.DB.batch([
      // Defensive release of any stale claim row before granting.
      this.env.DB.prepare('UPDATE claims SET released_at = ? WHERE task_id = ? AND released_at IS NULL').bind(nowIso(), taskId),
      this.env.DB.prepare('INSERT INTO claims (id, task_id, agent_id, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .bind(claimId, taskId, agentId, nowIso(), expiresAt),
      this.env.DB.prepare("UPDATE tasks SET status = 'in_progress', claimed_by = ?, claim_expires_at = ?, updated_at = ? WHERE id = ?")
        .bind(agentId, expiresAt, nowIso(), taskId),
    ]);
    await this.emit(actor, 'task.claimed', 'task', taskId, { key: task.key, title: task.title, agentId, expiresAt });
    await this.scheduleExpiryAlarm();
    const openComments = await this.openCommentsFor(taskId);
    return { claimId, key: task.key, expiresAt, ttlSeconds: ttl, openComments };
  }

  async releaseTask(projectId: string, actor: Actor, taskId: string, opts: { toStatus?: string } = {}) {
    await this.setPid(projectId);
    const task = await this.getTask(taskId);
    if (!task.claimed_by) throw new Error(`${task.key} has no live claim`);
    const toStatus = opts.toStatus ?? 'todo';
    if (!['todo', 'review', 'done', 'blocked'].includes(toStatus)) throw new Error(`invalid release status: ${toStatus}`);
    await this.env.DB.batch([
      this.env.DB.prepare('UPDATE claims SET released_at = ? WHERE task_id = ? AND released_at IS NULL').bind(nowIso(), taskId),
      this.env.DB.prepare('UPDATE tasks SET status = ?, claimed_by = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ?')
        .bind(toStatus, nowIso(), taskId),
    ]);
    await this.emit(actor, 'task.released', 'task', taskId, {
      key: task.key, title: task.title, by: actor.id, previousHolder: task.claimed_by, toStatus,
    });
    return { ok: true, key: task.key, status: toStatus };
  }

  /** Renew every live claim held by this agent in this project. */
  async heartbeat(projectId: string, actor: Actor, agentId: string) {
    await this.setPid(projectId);
    const ttl = await this.claimTtlSeconds();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const { results } = await this.env.DB.prepare(
      "SELECT id, key FROM tasks WHERE project_id = ? AND claimed_by = ? AND status = 'in_progress'",
    ).bind(this.projectId, agentId).all<{ id: string; key: string }>();
    if (results.length) {
      const now = nowIso();
      await this.env.DB.batch(
        results.flatMap((t) => [
          this.env.DB.prepare('UPDATE tasks SET claim_expires_at = ? WHERE id = ?').bind(expiresAt, t.id),
          this.env.DB.prepare('UPDATE claims SET expires_at = ? WHERE task_id = ? AND agent_id = ? AND released_at IS NULL')
            .bind(expiresAt, t.id, agentId),
        ]).concat([
          this.env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').bind(now, agentId),
        ]),
      );
      await this.scheduleExpiryAlarm();
    }
    return { renewed: results.map((r) => r.key), expiresAt: results.length ? expiresAt : null };
  }

  /** Alarm: requeue any claims whose TTL lapsed (agent died mid-work). */
  override async alarm() {
    await this.loadPid();
    if (!this._pid) return;
    const now = nowIso();
    const { results } = await this.env.DB.prepare(
      `SELECT id, key, title, claimed_by FROM tasks
       WHERE project_id = ? AND claimed_by IS NOT NULL AND claim_expires_at < ? AND status = 'in_progress'`,
    ).bind(this.projectId, now).all<TaskRow & { title: string }>();
    for (const t of results) {
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE claims SET released_at = ? WHERE task_id = ? AND released_at IS NULL').bind(now, t.id),
        this.env.DB.prepare("UPDATE tasks SET status = 'todo', claimed_by = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ?")
          .bind(now, t.id),
      ]);
      // Logged as its own event so the timeline shows why a task went back to todo.
      await this.emit({ kind: 'system', id: 'system', name: 'system' }, 'task.requeued', 'task', t.id, {
        key: t.key, title: t.title, previousHolder: t.claimed_by, reason: 'claim TTL expired',
      });
    }
    await this.scheduleExpiryAlarm();
  }

  private async scheduleExpiryAlarm() {
    const row = await this.env.DB.prepare(
      `SELECT MIN(claim_expires_at) AS next FROM tasks WHERE project_id = ? AND claimed_by IS NOT NULL AND status = 'in_progress'`,
    ).bind(this.projectId).first<{ next: string | null }>();
    if (row?.next) {
      // +2s grace so the heartbeat that renews right at the boundary wins.
      await this.ctx.storage.setAlarm(new Date(row.next).getTime() + 2000);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  // ---------------------------------------------------------------------------
  // Comments — the human steering channel
  // ---------------------------------------------------------------------------

  async postComment(
    projectId: string,
    actor: Actor,
    taskId: string,
    kind: 'comment' | 'question' | 'instruction' | 'reply',
    body: string,
    parentCommentId?: string | null,
  ) {
    await this.setPid(projectId);
    const task = await this.getTask(taskId);
    const id = newId('cmt');
    const status = kind === 'reply' ? 'addressed' : 'open';
    await this.env.DB.prepare(
      `INSERT INTO comments (id, task_id, author_kind, author_id, kind, body, status, parent_comment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, taskId, actor.kind, actor.id, kind, body, status, parentCommentId ?? null, nowIso()).run();
    await this.refreshOpenCommentCount(taskId);
    await this.emit(actor, 'comment.posted', 'comment', id, {
      taskId, taskKey: task.key, kind, body: body.slice(0, 140), holder: task.claimed_by,
    });
    return { id, taskKey: task.key, status };
  }

  async resolveComment(projectId: string, actor: Actor, commentId: string, resolution: 'addressed' | 'wont_do', reply?: string) {
    await this.setPid(projectId);
    const comment = await this.env.DB.prepare('SELECT id, task_id AS taskId, status FROM comments WHERE id = ?')
      .bind(commentId)
      .first<{ id: string; taskId: string; status: string }>();
    if (!comment) throw new Error('comment not found');
    if (comment.status === 'addressed' || comment.status === 'wont_do') return { ok: true, alreadyResolved: true };
    const task = await this.getTask(comment.taskId);
    await this.env.DB.prepare('UPDATE comments SET status = ?, resolved_by = ? WHERE id = ?')
      .bind(resolution, actor.id, commentId)
      .run();
    let replyId: string | null = null;
    if (reply) {
      replyId = (await this.postComment(projectId, actor, comment.taskId, 'reply', reply, commentId)).id;
    }
    await this.refreshOpenCommentCount(comment.taskId);
    await this.emit(actor, 'comment.resolved', 'comment', commentId, { taskKey: task.key, taskId: task.id, resolution });
    return { ok: true, replyId };
  }

  async acknowledgeComments(projectId: string, actor: Actor, taskId: string) {
    await this.setPid(projectId);
    const task = await this.getTask(taskId);
    const { meta } = await this.env.DB.prepare(
      "UPDATE comments SET status = 'acknowledged' WHERE task_id = ? AND status = 'open'",
    ).bind(taskId).run();
    if (meta.changes > 0) {
      await this.emit(actor, 'comment.acknowledged', 'task', taskId, { taskKey: task.key, count: meta.changes });
    }
    return { acknowledged: meta.changes };
  }

  private async refreshOpenCommentCount(taskId: string) {
    await this.env.DB.prepare(
      `UPDATE tasks SET open_comments =
         (SELECT COUNT(*) FROM comments WHERE task_id = ? AND status IN ('open','acknowledged'))
       WHERE id = ?`,
    ).bind(taskId, taskId).run();
  }

  // ---------------------------------------------------------------------------
  // Messaging / milestones
  // ---------------------------------------------------------------------------

  async sendMessage(projectId: string, actor: Actor, fromAgentId: string, body: string, toAgentId?: string | null, refTaskId?: string | null) {
    await this.setPid(projectId);
    const id = newId('msg');
    await this.env.DB.prepare(
      'INSERT INTO messages (id, project_id, from_agent_id, to_agent_id, body, ref_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, this.projectId, fromAgentId, toAgentId ?? null, body, refTaskId ?? null, nowIso()).run();
    await this.emit(actor, 'message.sent', 'message', id, {
      to: toAgentId ?? 'broadcast', body: body.slice(0, 140), refTaskId: refTaskId ?? null,
    });
    return { id };
  }

  async createMilestone(projectId: string, actor: Actor, title: string, dueAt?: string | null) {
    await this.setPid(projectId);
    const id = newId('ms');
    const row = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM milestones WHERE project_id = ?')
      .bind(this.projectId).first<{ n: number }>();
    await this.env.DB.prepare('INSERT INTO milestones (id, project_id, title, due_at, "order") VALUES (?, ?, ?, ?, ?)')
      .bind(id, this.projectId, title, dueAt ?? null, row?.n ?? 0).run();
    await this.emit(actor, 'milestone.created', 'milestone', id, { title });
    return { id };
  }

  // ---------------------------------------------------------------------------
  // Plans — an agent's work program over existing (or inline-created) tasks.
  // Phase order is ENFORCED: every task in phase N gains a dependency on every
  // task in phase N-1, so the claim arbiter gates the sequence automatically.
  // ---------------------------------------------------------------------------

  async createPlan(
    projectId: string,
    actor: Actor,
    input: {
      title: string;
      description?: string;
      agentId?: string | null;
      phases: Array<{ title: string; taskIds?: string[]; newTasks?: Array<{ title: string; body?: string; priority?: number }> }>;
    },
  ) {
    await this.setPid(projectId);
    const planId = newId('pln');
    await this.env.DB.prepare(
      'INSERT INTO plans (id, project_id, agent_id, title, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(planId, projectId, input.agentId ?? null, input.title, input.description ?? '', nowIso()).run();

    let prevPhaseTaskIds: string[] = [];
    const phases: Array<{ id: string; title: string; taskIds: string[] }> = [];
    for (let i = 0; i < input.phases.length; i++) {
      const ph = input.phases[i]!;
      const phaseId = newId('phs');
      await this.env.DB.prepare('INSERT INTO phases (id, plan_id, title, "order") VALUES (?, ?, ?, ?)')
        .bind(phaseId, planId, ph.title, i).run();

      const taskIds: string[] = [];
      for (const tid of ph.taskIds ?? []) {
        // Accept ids or keys; validate the task belongs to this project.
        const t = await this.env.DB.prepare('SELECT id FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
          .bind(tid, tid, projectId).first<{ id: string }>();
        if (!t) throw new Error(`task ${tid} not found in this project`);
        taskIds.push(t.id);
      }
      for (const nt of ph.newTasks ?? []) {
        const created = await this.createTask(projectId, actor, { title: nt.title, body: nt.body, priority: nt.priority });
        taskIds.push(created.id);
      }
      if (!taskIds.length) throw new Error(`phase "${ph.title}" has no tasks`);

      const stmts = taskIds.map((tid) =>
        this.env.DB.prepare('INSERT OR IGNORE INTO phase_tasks (phase_id, task_id) VALUES (?, ?)').bind(phaseId, tid),
      );
      // Enforce phase ordering through the dependency graph.
      for (const tid of taskIds) {
        for (const prev of prevPhaseTaskIds) {
          if (tid !== prev) {
            stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO dependencies (task_id, depends_on_task_id) VALUES (?, ?)').bind(tid, prev));
          }
        }
      }
      await this.env.DB.batch(stmts);
      prevPhaseTaskIds = taskIds;
      phases.push({ id: phaseId, title: ph.title, taskIds });
    }
    await this.emit(actor, 'plan.created', 'plan', planId, {
      title: input.title, phases: phases.map((p) => ({ title: p.title, tasks: p.taskIds.length })),
    });
    return { id: planId, title: input.title, phases };
  }

  // ---------------------------------------------------------------------------
  // Queries used by the arbiter (kept here for cohesion; harmless reads)
  // ---------------------------------------------------------------------------

  private async getTask(taskId: string): Promise<TaskRow> {
    const row = await this.env.DB.prepare(
      'SELECT id, key, status, claimed_by, claim_expires_at, title FROM tasks WHERE id = ? AND project_id = ?',
    ).bind(taskId, this.projectId).first<TaskRow>();
    if (!row) throw new Error(`task ${taskId} not found in this project`);
    return row;
  }

  private async unfinishedDeps(taskId: string): Promise<string[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT t.key FROM dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ? AND t.status NOT IN ('done','cancelled')`,
    ).bind(taskId).all<{ key: string }>();
    return results.map((r) => r.key);
  }

  private async claimTtlSeconds(): Promise<number> {
    const row = await this.env.DB.prepare('SELECT claim_ttl_seconds AS ttl FROM projects WHERE id = ?')
      .bind(this.projectId).first<{ ttl: number }>();
    return row?.ttl ?? 300;
  }

  private async openCommentsFor(taskId: string) {
    const { results } = await this.env.DB.prepare(
      `SELECT id, author_kind AS authorKind, author_id AS authorId, kind, body, status, created_at AS createdAt
       FROM comments WHERE task_id = ? AND status IN ('open','acknowledged') ORDER BY created_at`,
    ).bind(taskId).all();
    return results;
  }
}
