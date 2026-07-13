import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { newId, nowIso } from '../lib/util';

/**
 * ProjectRoom — one instance per project (idFromName(projectId)).
 *
 * The coordination authority (ROADMAP §3/§7):
 *  - SOLE WRITER of project-scoped rows in D1 — every mutation is serialized here,
 *    which is what makes the claim guarantees hold (no read-modify-write races).
 *  - Claim/lock arbiter: at most one live claim per task; TTL renewed by any agent action;
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
  /** Tags by name — auto-created for the project if they don't exist. */
  tags?: string[];
  /** Legacy alias for a single tag. */
  category?: string | null;
  type?: string;
}

export interface TaskPatch {
  title?: string;
  body?: string;
  status?: string;
  priority?: number;
  estimate?: number | null;
  milestoneId?: string | null;
  /** Replace the task's tag set (names; auto-created). */
  tags?: string[];
  /** Legacy single-tag alias. */
  category?: string | null;
  type?: string;
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

/*
 * SERIALIZATION NOTE (PLNR-19): D1 calls are subrequests and do NOT close the
 * DO's input gate, so awaiting them lets other requests interleave. Every
 * mutating method below therefore runs inside blockConcurrencyWhile — that is
 * what actually makes "sole writer" and "exactly one claim" true.
 */
export class ProjectRoom extends DurableObject<Env> {
  // Set explicitly by every entry point (RPC arg / WS URL / storage after hibernation)
  // rather than relying on ctx.id.name, which some runtimes don't expose.
  private _pid?: string;

  // Claim TTL rarely changes; cache it per instance so the liveness renewal folded
  // into emit() doesn't add a D1 read to every agent action.
  private _ttl?: number;

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
    const stmts = [
      this.env.DB.prepare(
        `INSERT INTO events (id, project_id, seq, actor_kind, actor_id, verb, subject_type, subject_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, pid, seq, actor.kind, actor.id, verb, subjectType, subjectId, JSON.stringify({ actorName: actor.name, ...payload }), createdAt),
      this.env.DB.prepare('UPDATE projects SET next_event_seq = ? WHERE id = ?').bind(seq + 1, pid),
    ];
    // Liveness is free: any action an agent takes renews its own live claims, so a
    // working agent never needs a standalone heartbeat (PLNR: stop the per-minute ping).
    // A no-op when the agent holds nothing; the pending alarm re-checks and reschedules.
    if (actor.kind === 'agent') {
      const ttl = await this.claimTtlSeconds();
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      stmts.push(
        this.env.DB.prepare(
          "UPDATE tasks SET claim_expires_at = ? WHERE project_id = ? AND claimed_by = ? AND status = 'in_progress' AND claim_expires_at IS NOT NULL",
        ).bind(expiresAt, pid, actor.id),
        this.env.DB.prepare(
          `UPDATE claims SET expires_at = ? WHERE agent_id = ? AND released_at IS NULL
           AND task_id IN (SELECT id FROM tasks WHERE project_id = ? AND claimed_by = ? AND status = 'in_progress')`,
        ).bind(expiresAt, actor.id, pid, actor.id),
        this.env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').bind(createdAt, actor.id),
      );
    }
    await this.env.DB.batch(stmts);
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

  /** Find or create a tag by name (per-project). */
  async resolveTag(projectId: string, actor: Actor, name: string): Promise<string>  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const trimmed = name.trim().toLowerCase();
      const existing = await this.env.DB.prepare('SELECT id FROM tags WHERE project_id = ? AND name = ?')
        .bind(this.projectId, trimmed).first<{ id: string }>();
      if (existing) return existing.id;
      const id = newId('tag');
      const palette = ['#4c9dff', '#b57bff', '#3fd98b', '#f5a623', '#ff8a8a', '#c6f24e', '#8a95a3'];
      const count = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM tags WHERE project_id = ?')
        .bind(this.projectId).first<{ n: number }>();
      const color = palette[(count?.n ?? 0) % palette.length]!;
      await this.env.DB.prepare('INSERT INTO tags (id, project_id, name, color, "order", created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, this.projectId, trimmed, color, count?.n ?? 0, nowIso()).run();
      await this.emit(actor, 'tag.created', 'tag', id, { name: trimmed, color });
      return id;
    
    });
  }

  private async setTaskTags(projectId: string, actor: Actor, taskId: string, names: string[]) {
    const ids: string[] = [];
    for (const n of names) {
      if (n.trim()) ids.push(await this.resolveTag(projectId, actor, n));
    }
    const stmts = [this.env.DB.prepare('DELETE FROM task_tags WHERE task_id = ?').bind(taskId)];
    for (const tid of ids) {
      stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').bind(taskId, tid));
    }
    await this.env.DB.batch(stmts);
  }

  async createTask(projectId: string, actor: Actor, input: CreateTaskInput)  {
    return this.ctx.blockConcurrencyWhile(async () => {
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
          `INSERT INTO tasks (id, project_id, key, milestone_id, parent_task_id, title, body, status, type, priority, estimate, "order", created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?)`,
        ).bind(id, pid, key, input.milestoneId ?? null, input.parentTaskId ?? null, input.title, input.body ?? '', input.type ?? 'feature', input.priority ?? 2, input.estimate ?? null, proj.n, now, now),
        this.env.DB.prepare('UPDATE projects SET next_task_number = ? WHERE id = ?').bind(proj.n + 1, pid),
      ];
      for (const dep of input.dependsOn ?? []) {
        stmts.push(
          this.env.DB.prepare('INSERT OR IGNORE INTO dependencies (task_id, depends_on_task_id) VALUES (?, ?)').bind(id, dep),
        );
      }
      await this.env.DB.batch(stmts);
      const tagNames = [...(input.tags ?? []), ...(input.category ? [input.category] : [])];
      if (tagNames.length) await this.setTaskTags(pid, actor, id, tagNames);
      await this.emit(actor, 'task.created', 'task', id, {
        key, title: input.title, parentTaskId: input.parentTaskId ?? null,
      });
      return { id, key };
    
    });
  }

  async updateTask(projectId: string, actor: Actor, taskId: string, patch: TaskPatch)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = await this.getTask(taskId);
      if (patch.category !== undefined) {
        patch.tags = patch.category ? [patch.category] : [];
        delete patch.category;
      }
      if (patch.tags !== undefined) {
        await this.setTaskTags(projectId, actor, taskId, patch.tags);
        delete patch.tags;
        // Tag-only updates still emit below via the fields list; ensure at least one emit.
        if (Object.keys(patch).filter((k) => k !== 'tags').length === 0) {
          await this.emit(actor, 'task.updated', 'task', taskId, { key: task.key, fields: ['tags'] });
          return { ok: true, key: task.key };
        }
      }
      const sets: string[] = [];
      const binds: unknown[] = [];
      const fields: Array<[keyof TaskPatch, string]> = [
        ['title', 'title'], ['body', 'body'], ['priority', 'priority'], ['type', 'type'],
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
    
    });
  }

  async addDependency(projectId: string, actor: Actor, taskId: string, dependsOnTaskId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
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
    
    });
  }

  // ---------------------------------------------------------------------------
  // Claim arbiter — the reason this DO exists
  // ---------------------------------------------------------------------------

  async claimTask(projectId: string, actor: Actor, taskId: string, agentId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
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
    
    });
  }

  async releaseTask(projectId: string, actor: Actor, taskId: string, opts: { toStatus?: string } = {})  {
    return this.ctx.blockConcurrencyWhile(async () => {
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
    
    });
  }

  /** Renew every live claim held by this agent in this project. */
  async heartbeat(projectId: string, actor: Actor, agentId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
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
    
    });
  }

  /** Alarm: requeue any claims whose TTL lapsed (agent died mid-work). */
  override async alarm()  {
    return this.ctx.blockConcurrencyWhile(async () => {
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
    
    });
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
  )  {
    return this.ctx.blockConcurrencyWhile(async () => {
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
    
    });
  }

  async resolveComment(projectId: string, actor: Actor, commentId: string, resolution: 'addressed' | 'wont_do', reply?: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
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
    
    });
  }

  async acknowledgeComments(projectId: string, actor: Actor, taskId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = await this.getTask(taskId);
      const { meta } = await this.env.DB.prepare(
        "UPDATE comments SET status = 'acknowledged' WHERE task_id = ? AND status = 'open'",
      ).bind(taskId).run();
      if (meta.changes > 0) {
        await this.emit(actor, 'comment.acknowledged', 'task', taskId, { taskKey: task.key, count: meta.changes });
      }
      return { acknowledged: meta.changes };
    
    });
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

  async sendMessage(projectId: string, actor: Actor, body: string, toAgentId?: string | null, refTaskId?: string | null)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      if (actor.kind === 'system') throw new Error('system cannot send messages');
      const id = newId('msg');
      await this.env.DB.prepare(
        'INSERT INTO messages (id, project_id, from_kind, from_id, from_name, to_agent_id, body, ref_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, this.projectId, actor.kind, actor.id, actor.name, toAgentId ?? null, body, refTaskId ?? null, nowIso()).run();
      await this.emit(actor, 'message.sent', 'message', id, {
        to: toAgentId ?? 'broadcast', body: body.slice(0, 140), refTaskId: refTaskId ?? null,
      });
      return { id };
    
    });
  }

  async updateMilestone(projectId: string, actor: Actor, milestoneId: string, patch: { title?: string; dueAt?: string | null })  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const ms = await this.env.DB.prepare('SELECT id, title FROM milestones WHERE id = ? AND project_id = ?')
        .bind(milestoneId, this.projectId).first<{ id: string; title: string }>();
      if (!ms) throw new Error('milestone not found in this project');
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.title !== undefined) { sets.push('title = ?'); binds.push(patch.title); }
      if (patch.dueAt !== undefined) { sets.push('due_at = ?'); binds.push(patch.dueAt); }
      if (!sets.length) return { ok: true };
      binds.push(milestoneId);
      await this.env.DB.prepare(`UPDATE milestones SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      await this.emit(actor, 'milestone.updated', 'milestone', milestoneId, { from: ms.title, title: patch.title ?? ms.title });
      return { ok: true };
    
    });
  }

  async createMilestone(projectId: string, actor: Actor, title: string, dueAt?: string | null)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const id = newId('ms');
      const row = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM milestones WHERE project_id = ?')
        .bind(this.projectId).first<{ n: number }>();
      await this.env.DB.prepare('INSERT INTO milestones (id, project_id, title, due_at, "order") VALUES (?, ?, ?, ?, ?)')
        .bind(id, this.projectId, title, dueAt ?? null, row?.n ?? 0).run();
      await this.emit(actor, 'milestone.created', 'milestone', id, { title });
      return { id };
    
    });
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
      /** The full written plan — goals, approach, constraints, exit gate (markdown). */
      body?: string;
      agentId?: string | null;
      phases: Array<{ title: string; body?: string; taskIds?: string[]; newTasks?: Array<{ title: string; body?: string; priority?: number }> }>;
    },
  )  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const planId = newId('pln');
      await this.env.DB.prepare(
        'INSERT INTO plans (id, project_id, agent_id, title, description, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(planId, projectId, input.agentId ?? null, input.title, input.description ?? '', input.body ?? '', nowIso()).run();
  
      let prevPhaseTaskIds: string[] = [];
      const phases: Array<{ id: string; title: string; taskIds: string[] }> = [];
      for (let i = 0; i < input.phases.length; i++) {
        const ph = input.phases[i]!;
        const phaseId = newId('phs');
        await this.env.DB.prepare('INSERT INTO phases (id, plan_id, title, body, "order") VALUES (?, ?, ?, ?, ?)')
          .bind(phaseId, planId, ph.title, ph.body ?? '', i).run();
  
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
    
    });
  }

  async noteAttachment(projectId: string, actor: Actor, taskId: string, filename: string, attachmentId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = await this.getTask(taskId);
      await this.emit(actor, 'attachment.added', 'task', taskId, { key: task.key, filename, attachmentId });
      return { ok: true };
    
    });
  }

  /** Plans evolve — agents append status updates, correct course, mark outcomes. */
  async updatePlan(projectId: string, actor: Actor, planId: string, patch: { title?: string; description?: string; body?: string })  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const plan = await this.env.DB.prepare('SELECT id, title FROM plans WHERE id = ? AND project_id = ?')
        .bind(planId, projectId).first<{ id: string; title: string }>();
      if (!plan) throw new Error('plan not found in this project');
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.title !== undefined) { sets.push('title = ?'); binds.push(patch.title); }
      if (patch.description !== undefined) { sets.push('description = ?'); binds.push(patch.description); }
      if (patch.body !== undefined) { sets.push('body = ?'); binds.push(patch.body); }
      if (!sets.length) return { ok: true };
      binds.push(planId);
      await this.env.DB.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      await this.emit(actor, 'plan.updated', 'plan', planId, { title: patch.title ?? plan.title, fields: Object.keys(patch) });
      return { ok: true };
    
    });
  }

  async updatePhase(projectId: string, actor: Actor, phaseId: string, patch: { title?: string; body?: string })  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const row = await this.env.DB.prepare(
        'SELECT ph.id, ph.title, pl.id AS planId FROM phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE ph.id = ? AND pl.project_id = ?',
      ).bind(phaseId, projectId).first<{ id: string; title: string; planId: string }>();
      if (!row) throw new Error('phase not found in this project');
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.title !== undefined) { sets.push('title = ?'); binds.push(patch.title); }
      if (patch.body !== undefined) { sets.push('body = ?'); binds.push(patch.body); }
      if (!sets.length) return { ok: true };
      binds.push(phaseId);
      await this.env.DB.prepare(`UPDATE phases SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      await this.emit(actor, 'plan.updated', 'plan', row.planId, { title: patch.title ?? row.title, fields: ['phase'] });
      return { ok: true };
    
    });
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
    if (this._ttl !== undefined) return this._ttl;
    const row = await this.env.DB.prepare('SELECT claim_ttl_seconds AS ttl FROM projects WHERE id = ?')
      .bind(this.projectId).first<{ ttl: number }>();
    return (this._ttl = row?.ttl ?? 1800);
  }

  private async openCommentsFor(taskId: string) {
    const { results } = await this.env.DB.prepare(
      `SELECT id, author_kind AS authorKind, author_id AS authorId, kind, body, status, created_at AS createdAt
       FROM comments WHERE task_id = ? AND status IN ('open','acknowledged') ORDER BY created_at`,
    ).bind(taskId).all();
    return results;
  }
}
