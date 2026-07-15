import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { newId, nowIso } from '../lib/util';
import { userCanAccessProject } from '../lib/visibility';
import { DEFAULT_MAX_VERIFY_ATTEMPTS, type PhaseGateAction, phaseGateDecision } from '../lib/phase-gate';
import { RunKind, AgentTool, RunStatus, isTerminalRunStatus } from '@noriq/shared';

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
  /** Board this task lands on; defaults to the project's default board. */
  boardId?: string | null;
}

export interface TaskPatch {
  title?: string;
  body?: string;
  status?: string;
  priority?: number;
  estimate?: number | null;
  milestoneId?: string | null;
  boardId?: string | null;
  /** Re-parent the task (PLNR-89); null detaches it to a root. Accepts an id or key. */
  parentTaskId?: string | null;
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

// --- Runs (execution plane, RUN-6) -----------------------------------------
export interface CreateRunInput {
  kind: string; // RunKind: scope|build|verify
  anchor?: { type: 'task' | 'plan'; id: string } | null;
  brief?: string;
  repoRef: string;
  agentTool: string; // AgentTool: claude|codex
  budget?: Record<string, unknown> | null;
  /** Pre-assign a runner (create + dispatch in one shot); else the Run starts queued. */
  runnerId?: string | null;
  /** Actor id credited as the dispatcher; defaults to the acting actor. */
  createdBy?: string;
}

export interface RunPatch {
  status: string; // target RunStatus
  agentId?: string | null; // set once the spawned agent registers its own actor
  exit?: Record<string, unknown> | null; // terminal detail; synthesized if omitted
  worktreePath?: string | null; // daemon-side checkout path, for server-side visibility
  reason?: string | null;
}

type RunRow = {
  id: string; project_id: string; runner_id: string | null; agent_id: string | null;
  kind: string; anchor_type: string | null; anchor_id: string | null; brief: string;
  repo_ref: string; agent_tool: string; budget: string; status: string; exit: string | null;
  worktree_path: string | null;
  tokens_used: number | null; usd_spent: number | null; log_tail: string | null;
  created_by: string; created_at: string; updated_at: string;
  dispatched_at: string | null; started_at: string | null;
};

// The wire shape of a Run (mirrors the shared Run entity). Named explicitly so the
// DO-stub RPC return-type inference doesn't recurse on a large anonymous literal.
export interface RunView {
  id: string;
  projectId: string;
  runnerId: string | null;
  agentId: string | null;
  kind: string;
  anchor: { type: 'task'; taskId: string } | { type: 'plan'; planId: string } | null;
  brief: string;
  repoRef: string;
  agentTool: string;
  budget: Record<string, unknown>;
  status: string;
  exit: Record<string, unknown> | null;
  worktreePath: string | null;
  // Live telemetry (RUN-22): last-writer-wins spend + log tail from the daemon.
  tokensUsed: number | null;
  usdSpent: number | null;
  logTail: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  startedAt: string | null;
}

// Legal Run status transitions. queued Runs were never sent to a daemon (no
// process); dispatched/running/blocked have a live (or expected-live) process.
const RUN_TRANSITIONS: Record<string, string[]> = {
  queued: ['dispatched', 'cancelled'],
  dispatched: ['running', 'failed', 'cancelled'],
  running: ['blocked', 'done', 'failed', 'cancelled'],
  blocked: ['running', 'done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

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
      // Every task lands on a board; fall back to the project's default board.
      const boardId = input.boardId ?? (await this.defaultBoardId(pid));
      const stmts = [
        this.env.DB.prepare(
          `INSERT INTO tasks (id, project_id, key, milestone_id, board_id, parent_task_id, title, body, status, type, priority, estimate, "order", created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?)`,
        ).bind(id, pid, key, input.milestoneId ?? null, boardId, input.parentTaskId ?? null, input.title, input.body ?? '', input.type ?? 'feature', input.priority ?? 2, input.estimate ?? null, proj.n, now, now),
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
        ['estimate', 'estimate'], ['milestoneId', 'milestone_id'], ['boardId', 'board_id'], ['order', '"order"'],
      ];
      for (const [k, col] of fields) {
        if (patch[k] !== undefined) {
          sets.push(`${col} = ?`);
          binds.push(patch[k]);
        }
      }
      // Re-parent (PLNR-89): resolve the new parent by id-or-key, reject self-parenting
      // and cycles (the new parent must not be the task or one of its descendants).
      if (patch.parentTaskId !== undefined) {
        let parentId: string | null = null;
        if (patch.parentTaskId) {
          const parent = await this.env.DB.prepare('SELECT id FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
            .bind(patch.parentTaskId, patch.parentTaskId, this.projectId).first<{ id: string }>();
          if (!parent) throw new Error(`parent task ${patch.parentTaskId} not found in this project`);
          parentId = parent.id;
          let cursor: string | null = parentId;
          while (cursor) {
            if (cursor === task.id) throw new Error('cannot re-parent a task under itself or a descendant (would create a cycle)');
            const anc: { p: string | null } | null = await this.env.DB.prepare('SELECT parent_task_id AS p FROM tasks WHERE id = ?').bind(cursor).first<{ p: string | null }>();
            cursor = anc?.p ?? null;
          }
        }
        sets.push('parent_task_id = ?');
        binds.push(parentId);
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

  async removeDependency(projectId: string, actor: Actor, taskId: string, dependsOnTaskId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const [task, dep] = await Promise.all([this.getTask(taskId), this.getTask(dependsOnTaskId)]);
      await this.env.DB.prepare('DELETE FROM dependencies WHERE task_id = ? AND depends_on_task_id = ?')
        .bind(taskId, dependsOnTaskId)
        .run();
      await this.emit(actor, 'dependency.removed', 'task', taskId, { key: task.key, dependsOn: dep.key });
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
      // RUN-23 gate (defense in depth — the claimable surface already hides these):
      // a task in a proposed plan can't be worked until a human approves the plan.
      const gated = await this.env.DB.prepare(
        `SELECT 1 FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id JOIN plans pl ON pl.id = ph.plan_id
         WHERE pt.task_id = ? AND pl.status = 'proposed'`,
      ).bind(taskId).first();
      if (gated) throw new Error(`${task.key} belongs to a proposed plan awaiting human approval`);
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

  async releaseTask(projectId: string, actor: Actor, taskId: string, opts: { toStatus?: string; comment?: string } = {})  {
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
      // Optional closing note from the agent. Recorded as already-resolved so it reads as
      // a handoff remark, not an unresolved question (and never blocks a later `done`).
      let commentId: string | null = null;
      const note = opts.comment?.trim();
      if (note) {
        commentId = newId('cmt');
        await this.env.DB.prepare(
          `INSERT INTO comments (id, task_id, author_kind, author_id, kind, body, status, created_at)
           VALUES (?, ?, ?, ?, 'comment', ?, 'addressed', ?)`,
        ).bind(commentId, taskId, actor.kind, actor.id, note, nowIso()).run();
        await this.emit(actor, 'comment.posted', 'comment', commentId, {
          taskId, taskKey: task.key, kind: 'comment', body: note.slice(0, 140), holder: null,
        });
      }
      return { ok: true, key: task.key, status: toStatus, commentId };

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
      // An agent's own plain comment is a note (self-authored), not something a human
      // must resolve — so it doesn't count as an open/unresolved comment. Questions and
      // human comments stay open; replies are addressed.
      const status = kind === 'reply' || (kind === 'comment' && actor.kind === 'agent') ? 'addressed' : 'open';
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

  // ---------------------------------------------------------------------------
  // Signals — agent → human input requests (decision gates) and alerts (PLNR-67)
  // ---------------------------------------------------------------------------

  /** Raise an input_request (gate) or alert. An input_request on a held task auto-parks
   *  it to 'blocked' so it doesn't lapse to claim-TTL while the human decides. */
  async raiseSignal(
    projectId: string,
    actor: Actor,
    input: { type: 'input_request' | 'alert'; taskId?: string | null; title: string; body?: string; options?: string[]; severity?: string },
  )  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = input.taskId ? await this.getTask(input.taskId) : null;
      const id = newId('sig');
      const severity = input.type === 'input_request' ? 'info' : (input.severity ?? 'info');
      await this.env.DB.prepare(
        `INSERT INTO signals (id, project_id, task_id, agent_id, agent_name, type, severity, title, body, options, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      ).bind(
        id, this.projectId, task?.id ?? null, actor.kind === 'agent' ? actor.id : null, actor.name,
        input.type, severity, input.title, input.body ?? null,
        input.options && input.options.length ? JSON.stringify(input.options) : null, nowIso(),
      ).run();

      let parked = false;
      // Auto-park a held task behind an input gate: release the claim, mark it blocked.
      if (input.type === 'input_request' && task && task.claimed_by) {
        await this.env.DB.batch([
          this.env.DB.prepare('UPDATE claims SET released_at = ? WHERE task_id = ? AND released_at IS NULL').bind(nowIso(), task.id),
          this.env.DB.prepare("UPDATE tasks SET status = 'blocked', claimed_by = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), task.id),
        ]);
        parked = true;
      }
      await this.emit(actor, 'signal.raised', task ? 'task' : 'project', task?.id ?? this.projectId, {
        signalId: id, sigType: input.type, severity, title: input.title, taskKey: task?.key ?? null, parked,
      });
      // Mirror to the Run (RUN-18): if this input_request comes from a spawned agent
      // driving a running Run, park the Run → blocked so the dashboard shows "waiting
      // on you", not a hung run. (Raw UPDATE, not transitionRun, to avoid nesting
      // blockConcurrencyWhile; running→blocked is a legal transition.)
      if (input.type === 'input_request' && actor.kind === 'agent') {
        const { results } = await this.env.DB.prepare(
          "SELECT id FROM runs WHERE project_id = ? AND agent_id = ? AND status = 'running'",
        ).bind(this.projectId, actor.id).all<{ id: string }>();
        for (const r of results) {
          await this.env.DB.prepare("UPDATE runs SET status = 'blocked', updated_at = ? WHERE id = ?").bind(nowIso(), r.id).run();
          await this.emit(actor, 'run.status_changed', 'run', r.id, { from: 'running', to: 'blocked', reason: 'request_input' });
        }
      }
      return { id, type: input.type, taskKey: task?.key ?? null, parked };

    });
  }

  /** Human answers an input_request → unblocks its task (back to the queue) + notifies the requester. */
  async answerSignal(projectId: string, actor: Actor, signalId: string, response: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const sig = await this.env.DB.prepare(
        'SELECT id, task_id AS taskId, agent_id AS agentId, type, status, title FROM signals WHERE id = ? AND project_id = ?',
      ).bind(signalId, this.projectId).first<{ id: string; taskId: string | null; agentId: string | null; type: string; status: string; title: string }>();
      if (!sig) throw new Error('signal not found');
      if (sig.status !== 'open') return { ok: true, alreadyResolved: true };
      await this.env.DB.prepare("UPDATE signals SET status = 'answered', response = ?, responder_id = ?, resolved_at = ? WHERE id = ?")
        .bind(response, actor.id, nowIso(), signalId).run();
      // Return a parked task to the queue so the requester (or anyone) can resume it.
      let taskKey: string | null = null;
      if (sig.type === 'input_request' && sig.taskId) {
        const task = await this.getTask(sig.taskId);
        taskKey = task.key;
        if (task.status === 'blocked') {
          await this.env.DB.prepare("UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ?").bind(nowIso(), sig.taskId).run();
        }
      }
      // Mirror to the Run (RUN-18): the answer returns a blocked Run to running so
      // the spawned agent resumes (it picks up the answer via its own MCP notices).
      if (sig.type === 'input_request' && sig.agentId) {
        const { results } = await this.env.DB.prepare(
          "SELECT id FROM runs WHERE project_id = ? AND agent_id = ? AND status = 'blocked'",
        ).bind(this.projectId, sig.agentId).all<{ id: string }>();
        for (const r of results) {
          await this.env.DB.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?").bind(nowIso(), r.id).run();
          await this.emit(actor, 'run.status_changed', 'run', r.id, { from: 'blocked', to: 'running', reason: 'input_answered' });
        }
      }
      await this.emit(actor, 'signal.answered', sig.taskId ? 'task' : 'project', sig.taskId ?? this.projectId, {
        signalId, agentId: sig.agentId, title: sig.title, response: response.slice(0, 200), taskKey,
      });
      return { ok: true, taskKey };

    });
  }

  /** Human acknowledges/dismisses a signal (mainly alerts). */
  async acknowledgeSignal(projectId: string, actor: Actor, signalId: string, dismiss = false)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const sig = await this.env.DB.prepare('SELECT id, status, title, task_id AS taskId FROM signals WHERE id = ? AND project_id = ?')
        .bind(signalId, this.projectId).first<{ id: string; status: string; title: string; taskId: string | null }>();
      if (!sig) throw new Error('signal not found');
      if (sig.status !== 'open') return { ok: true, alreadyResolved: true };
      await this.env.DB.prepare('UPDATE signals SET status = ?, responder_id = ?, resolved_at = ? WHERE id = ?')
        .bind(dismiss ? 'dismissed' : 'acknowledged', actor.id, nowIso(), signalId).run();
      await this.emit(actor, 'signal.acknowledged', sig.taskId ? 'task' : 'project', sig.taskId ?? this.projectId, { signalId, title: sig.title });
      return { ok: true };

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
      // A directed message must target an agent whose USER can reach this project
      // (PLNR-96) — blocks cross-tenant DM injection, while allowing same-user and
      // group co-member agents (including ones not yet scoped to a project).
      if (toAgentId) {
        const target = await this.env.DB.prepare('SELECT user_id AS userId, project_id AS pid FROM agents WHERE id = ?')
          .bind(toAgentId).first<{ userId: string | null; pid: string | null }>();
        const reachable = !!target && (target.pid === this.projectId
          || (!!target.userId && await userCanAccessProject(this.env, target.userId, this.projectId)));
        if (!reachable) throw new Error(`agent ${toAgentId} cannot be messaged in this project`);
      }
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
  // Boards (PLNR-80): a project can hold several boards (environments, stages…).
  // Every task belongs to one board; the default board is the earliest one.
  // ---------------------------------------------------------------------------

  /** The project's default board (lowest order, then oldest). Null only if none exist. */
  private async defaultBoardId(projectId: string): Promise<string | null> {
    const row = await this.env.DB.prepare(
      'SELECT id FROM boards WHERE project_id = ? ORDER BY "order", created_at LIMIT 1',
    ).bind(projectId).first<{ id: string }>();
    return row?.id ?? null;
  }

  async createBoard(projectId: string, actor: Actor, name: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const id = newId('brd');
      const row = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM boards WHERE project_id = ?')
        .bind(this.projectId).first<{ n: number }>();
      await this.env.DB.prepare('INSERT INTO boards (id, project_id, name, "order", created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, this.projectId, name, row?.n ?? 0, nowIso()).run();
      await this.emit(actor, 'board.created', 'board', id, { name });
      return { id, name };
    });
  }

  async renameBoard(projectId: string, actor: Actor, boardId: string, name: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      await this.env.DB.prepare('UPDATE boards SET name = ? WHERE id = ? AND project_id = ?')
        .bind(name, boardId, this.projectId).run();
      await this.emit(actor, 'board.updated', 'board', boardId, { name });
      return { ok: true };
    });
  }

  /** Delete a board, moving its tasks to another board. Refuses to remove the last one. */
  async deleteBoard(projectId: string, actor: Actor, boardId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const others = await this.env.DB.prepare(
        'SELECT id FROM boards WHERE project_id = ? AND id != ? ORDER BY "order", created_at LIMIT 1',
      ).bind(this.projectId, boardId).first<{ id: string }>();
      if (!others) throw new Error('cannot delete the only board — a project needs at least one');
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE tasks SET board_id = ? WHERE board_id = ? AND project_id = ?')
          .bind(others.id, boardId, this.projectId),
        this.env.DB.prepare('DELETE FROM boards WHERE id = ? AND project_id = ?').bind(boardId, this.projectId),
      ]);
      await this.emit(actor, 'board.deleted', 'board', boardId, { movedTo: others.id });
      return { ok: true, movedTo: others.id };
    });
  }

  // ---------------------------------------------------------------------------
  // Archive (PLNR-70/73): archived tasks drop off the board unless the switch is on.
  // ---------------------------------------------------------------------------

  async archiveTask(projectId: string, actor: Actor, taskId: string, archived: boolean)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = await this.getTask(taskId);
      // Restore also bumps updated_at so the 24h auto-sweep doesn't immediately re-archive it.
      await this.env.DB.prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?')
        .bind(archived ? nowIso() : null, nowIso(), taskId).run();
      await this.emit(actor, archived ? 'task.archived' : 'task.restored', 'task', taskId, { key: task.key, title: task.title });
      return { ok: true, key: task.key, archived };
    });
  }

  /** Auto-archive done tasks untouched for >24h. Returns how many were swept. */
  async sweepArchive(projectId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { meta } = await this.env.DB.prepare(
        "UPDATE tasks SET archived_at = ? WHERE project_id = ? AND status = 'done' AND archived_at IS NULL AND updated_at < ?",
      ).bind(nowIso(), this.projectId, cutoff).run();
      return { archived: meta.changes ?? 0 };
    });
  }

  // ---------------------------------------------------------------------------
  // Deletion (PLNR-70). D1 enforces FKs, so children go before parents. R2 objects
  // for attachments are removed out-of-band before the rows.
  // ---------------------------------------------------------------------------

  /** Delete a milestone; its tasks survive (milestone_id nulled). */
  async deleteMilestone(projectId: string, actor: Actor, milestoneId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const ms = await this.env.DB.prepare('SELECT id, title FROM milestones WHERE id = ? AND project_id = ?')
        .bind(milestoneId, this.projectId).first<{ id: string; title: string }>();
      if (!ms) throw new Error('milestone not found');
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE tasks SET milestone_id = NULL WHERE milestone_id = ?').bind(milestoneId),
        this.env.DB.prepare('DELETE FROM milestones WHERE id = ?').bind(milestoneId),
      ]);
      await this.emit(actor, 'milestone.deleted', 'milestone', milestoneId, { title: ms.title });
      return { ok: true };
    });
  }

  /** Delete a tag; task_tags links removed, tasks survive. */
  async deleteTag(projectId: string, actor: Actor, tagId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const tag = await this.env.DB.prepare('SELECT id, name FROM tags WHERE id = ? AND project_id = ?')
        .bind(tagId, this.projectId).first<{ id: string; name: string }>();
      if (!tag) throw new Error('tag not found');
      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM task_tags WHERE tag_id = ?').bind(tagId),
        this.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(tagId),
      ]);
      await this.emit(actor, 'tag.deleted', 'tag', tagId, { name: tag.name });
      return { ok: true };
    });
  }

  /** Delete a plan + its phases/phase-links. The underlying tasks survive. */
  async deletePlan(projectId: string, actor: Actor, planId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const plan = await this.env.DB.prepare('SELECT id, title FROM plans WHERE id = ? AND project_id = ?')
        .bind(planId, this.projectId).first<{ id: string; title: string }>();
      if (!plan) throw new Error('plan not found');
      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM phase_tasks WHERE phase_id IN (SELECT id FROM phases WHERE plan_id = ?)').bind(planId),
        this.env.DB.prepare('DELETE FROM phases WHERE plan_id = ?').bind(planId),
        this.env.DB.prepare('DELETE FROM plans WHERE id = ?').bind(planId),
      ]);
      await this.emit(actor, 'plan.deleted', 'plan', planId, { title: plan.title });
      return { ok: true };
    });
  }

  /** Hard-delete a task and everything hanging off it (deps, claims, comments,
   *  refs, tags, attachments+R2, signals). Child tasks are orphaned, not deleted. */
  async deleteTask(projectId: string, actor: Actor, taskId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = await this.getTask(taskId);
      // R2 first (best-effort; not transactional with D1).
      if (this.env.FILES) {
        const { results } = await this.env.DB.prepare('SELECT r2_key AS key FROM attachments WHERE task_id = ?').bind(task.id).all<{ key: string }>();
        for (const a of results) await this.env.FILES.delete(a.key).catch(() => {});
      }
      const id = task.id;
      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM phase_tasks WHERE task_id = ?').bind(id),
        this.env.DB.prepare('DELETE FROM dependencies WHERE task_id = ? OR depends_on_task_id = ?').bind(id, id),
        this.env.DB.prepare('DELETE FROM claims WHERE task_id = ?').bind(id),
        this.env.DB.prepare('DELETE FROM comments WHERE task_id = ?').bind(id),
        this.env.DB.prepare('DELETE FROM task_refs WHERE task_id = ?').bind(id),
        this.env.DB.prepare('DELETE FROM task_tags WHERE task_id = ?').bind(id),
        this.env.DB.prepare('DELETE FROM attachments WHERE task_id = ?').bind(id),
        this.env.DB.prepare('DELETE FROM signals WHERE task_id = ?').bind(id),
        this.env.DB.prepare('UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?').bind(id),
        this.env.DB.prepare('UPDATE messages SET ref_task_id = NULL WHERE ref_task_id = ?').bind(id),
        this.env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id),
      ]);
      await this.emit(actor, 'task.deleted', 'task', id, { key: task.key, title: task.title });
      return { ok: true, key: task.key };
    });
  }

  /** Delete an entire project and every row under it. Irreversible. */
  async deleteProject(projectId: string, actor: Actor)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const proj = await this.env.DB.prepare('SELECT id, key, name FROM projects WHERE id = ?').bind(this.projectId).first<{ id: string; key: string; name: string }>();
      if (!proj) throw new Error('project not found');
      const pid = this.projectId;
      // R2: every attachment on any task in the project.
      if (this.env.FILES) {
        const { results } = await this.env.DB.prepare('SELECT a.r2_key AS key FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?').bind(pid).all<{ key: string }>();
        for (const a of results) await this.env.FILES.delete(a.key).catch(() => {});
      }
      const tasksSub = 'SELECT id FROM tasks WHERE project_id = ?';
      await this.env.DB.batch([
        this.env.DB.prepare(`DELETE FROM phase_tasks WHERE task_id IN (${tasksSub}) OR phase_id IN (SELECT id FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?))`).bind(pid, pid),
        this.env.DB.prepare(`DELETE FROM dependencies WHERE task_id IN (${tasksSub}) OR depends_on_task_id IN (${tasksSub})`).bind(pid, pid),
        this.env.DB.prepare(`DELETE FROM claims WHERE task_id IN (${tasksSub})`).bind(pid),
        this.env.DB.prepare(`DELETE FROM task_refs WHERE task_id IN (${tasksSub})`).bind(pid),
        this.env.DB.prepare(`DELETE FROM task_tags WHERE task_id IN (${tasksSub}) OR tag_id IN (SELECT id FROM tags WHERE project_id = ?)`).bind(pid, pid),
        this.env.DB.prepare(`DELETE FROM comments WHERE task_id IN (${tasksSub})`).bind(pid),
        this.env.DB.prepare(`DELETE FROM attachments WHERE task_id IN (${tasksSub})`).bind(pid),
        this.env.DB.prepare('DELETE FROM signals WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM messages WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM events WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM phase_gates WHERE phase_id IN (SELECT id FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?))').bind(pid),
        this.env.DB.prepare('DELETE FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)').bind(pid),
        this.env.DB.prepare('DELETE FROM plans WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM tags WHERE project_id = ?').bind(pid),
        this.env.DB.prepare("UPDATE agents SET project_id = NULL, status = 'offline' WHERE project_id = ?").bind(pid),
        // Runs are project-scoped → delete (with any steer-delivery rows keyed to them).
        // Runners are machines (project_id optional, multi-project) → unpin, not delete;
        // the daemon's heartbeat keeps its status.
        this.env.DB.prepare('DELETE FROM runtime_deliveries WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)').bind(pid),
        this.env.DB.prepare('DELETE FROM steers WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)').bind(pid),
        this.env.DB.prepare('DELETE FROM runs WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('UPDATE runners SET project_id = NULL WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('UPDATE tasks SET parent_task_id = NULL WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM tasks WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM milestones WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM boards WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(pid),
      ]);
      await this.ctx.storage.deleteAlarm().catch(() => {});
      return { ok: true, key: proj.key, name: proj.name };
    });
  }

  // ---------------------------------------------------------------------------
  // Runs — the execution plane (RUN-6). Runs are AUTHORITATIVE here, not in the
  // daemon: create/dispatch/transition all flow through blockConcurrencyWhile so
  // status changes serialize, append to the event log, and fan out over WS. The
  // daemon only *reports* transitions (RUN-7); this DO owns the truth.
  // ---------------------------------------------------------------------------

  private runToWire(r: RunRow): RunView {
    return {
      id: r.id,
      projectId: r.project_id,
      runnerId: r.runner_id,
      agentId: r.agent_id,
      kind: r.kind,
      // CHECK((anchor_type IS NULL) = (anchor_id IS NULL)) guarantees the id is set here.
      anchor:
        r.anchor_type === 'task' ? { type: 'task', taskId: r.anchor_id! }
        : r.anchor_type === 'plan' ? { type: 'plan', planId: r.anchor_id! }
        : null,
      brief: r.brief,
      repoRef: r.repo_ref,
      agentTool: r.agent_tool,
      budget: JSON.parse(r.budget || '{}'),
      status: r.status,
      exit: r.exit ? JSON.parse(r.exit) : null,
      worktreePath: r.worktree_path,
      tokensUsed: r.tokens_used,
      usdSpent: r.usd_spent,
      logTail: r.log_tail,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      dispatchedAt: r.dispatched_at,
      startedAt: r.started_at,
    };
  }

  private async loadRun(runId: string): Promise<RunRow> {
    const row = await this.env.DB.prepare('SELECT * FROM runs WHERE id = ? AND project_id = ?')
      .bind(runId, this.projectId).first<RunRow>();
    if (!row) throw new Error('run not found');
    return row;
  }

  /** Create a Run. Starts `queued`; if runnerId is given, create + dispatch atomically. */
  async createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      // Validate against the shared contract; the DB CHECKs are the backstop.
      RunKind.parse(input.kind);
      AgentTool.parse(input.agentTool);
      const id = newId('run');
      const now = nowIso();
      const anchorType = input.anchor?.type ?? null;
      const anchorId = input.anchor?.id ?? null;
      const runnerId = input.runnerId ?? null;
      const status = runnerId ? 'dispatched' : 'queued';
      await this.env.DB.prepare(
        `INSERT INTO runs (id, project_id, runner_id, kind, anchor_type, anchor_id, brief, repo_ref,
                           agent_tool, budget, status, created_by, created_at, updated_at, dispatched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, projectId, runnerId, input.kind, anchorType, anchorId, input.brief ?? '', input.repoRef,
        input.agentTool, JSON.stringify(input.budget ?? {}), status, input.createdBy ?? actor.id, now, now,
        runnerId ? now : null,
      ).run();
      await this.emit(actor, 'run.created', 'run', id, {
        kind: input.kind, agentTool: input.agentTool, repoRef: input.repoRef, anchor: anchorType,
      });
      if (runnerId) await this.emit(actor, 'run.dispatched', 'run', id, { runnerId, to: 'dispatched' });
      return this.runToWire(await this.loadRun(id));
    });
  }

  /** Assign a queued Run to a runner and mark it dispatched. */
  async dispatchRun(projectId: string, actor: Actor, runId: string, runnerId: string): Promise<RunView> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const run = await this.loadRun(runId);
      if (!RUN_TRANSITIONS[run.status]?.includes('dispatched')) {
        throw new Error(`cannot dispatch run in status ${run.status}`);
      }
      const now = nowIso();
      await this.env.DB.prepare(
        "UPDATE runs SET runner_id = ?, status = 'dispatched', dispatched_at = ?, updated_at = ? WHERE id = ?",
      ).bind(runnerId, now, now, runId).run();
      await this.emit(actor, 'run.dispatched', 'run', runId, { runnerId, from: run.status, to: 'dispatched' });
      return this.runToWire(await this.loadRun(runId));
    });
  }

  /** Advance a Run's status (running/blocked/terminal). Enforces the transition map. */
  async transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const run = await this.loadRun(runId);
      const to = RunStatus.parse(patch.status);
      if (!RUN_TRANSITIONS[run.status]?.includes(to)) {
        throw new Error(`illegal run transition ${run.status} -> ${to}`);
      }
      const now = nowIso();
      const startedAt = to === 'running' && !run.started_at ? now : run.started_at;
      const agentId = patch.agentId !== undefined ? patch.agentId : run.agent_id;
      const worktreePath = patch.worktreePath !== undefined ? patch.worktreePath : run.worktree_path;
      let exitJson = run.exit;
      if (isTerminalRunStatus(to)) {
        // Synthesize a RunExit if the caller didn't supply one; caller fields win.
        exitJson = JSON.stringify({
          outcome: to, code: null, signal: null, reason: patch.reason ?? null, finishedAt: now,
          ...(patch.exit ?? {}),
        });
      }
      await this.env.DB.prepare(
        'UPDATE runs SET status = ?, agent_id = ?, exit = ?, worktree_path = ?, started_at = ?, updated_at = ? WHERE id = ?',
      ).bind(to, agentId, exitJson, worktreePath, startedAt, now, runId).run();
      await this.emit(actor, 'run.status_changed', 'run', runId, { from: run.status, to, reason: patch.reason ?? null });
      return this.runToWire(await this.loadRun(runId));
    });
  }

  /** On daemon reconnect, orphaned non-terminal Runs for that runner → failed{daemon_restart}. */
  async reconcileRunnerRuns(projectId: string, actor: Actor, runnerId: string): Promise<{ failed: number }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const { results } = await this.env.DB.prepare(
        "SELECT id, status FROM runs WHERE project_id = ? AND runner_id = ? AND status IN ('dispatched','running','blocked')",
      ).bind(projectId, runnerId).all<{ id: string; status: string }>();
      const now = nowIso();
      for (const r of results) {
        const exit = JSON.stringify({ outcome: 'failed', code: null, signal: null, reason: 'daemon_restart', finishedAt: now });
        await this.env.DB.prepare("UPDATE runs SET status = 'failed', exit = ?, updated_at = ? WHERE id = ?")
          .bind(exit, now, r.id).run();
        await this.emit(actor, 'run.status_changed', 'run', r.id, { from: r.status, to: 'failed', reason: 'daemon_restart' });
      }
      return { failed: results.length };
    });
  }

  /** Read Runs for the project (UI + dispatch). Optional runner/status filters. */
  async listRuns(projectId: string, opts: { runnerId?: string; status?: string } = {}): Promise<RunView[]> {
    await this.setPid(projectId);
    const clauses = ['project_id = ?'];
    const binds: unknown[] = [projectId];
    if (opts.runnerId) { clauses.push('runner_id = ?'); binds.push(opts.runnerId); }
    if (opts.status) { clauses.push('status = ?'); binds.push(opts.status); }
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM runs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
    ).bind(...binds).all<RunRow>();
    return results.map((r) => this.runToWire(r));
  }

  async getRun(projectId: string, runId: string): Promise<RunView> {
    await this.setPid(projectId);
    return this.runToWire(await this.loadRun(runId));
  }

  /**
   * Persist live Run telemetry (RUN-22) reported by the owning daemon. This is a
   * high-frequency, non-transitional update: it touches ONLY the telemetry columns
   * (so it never races the status/exit columns transitionRun owns), does NOT append
   * to the event log, and does NOT bump updated_at (telemetry must not perturb the
   * recency sort). Last write wins — spend is monotonic, so the final tick carries
   * the final numbers regardless of how it interleaves with the terminal status.
   */
  async recordRunTelemetry(
    projectId: string,
    runId: string,
    t: { tokensUsed?: number | null; usdSpent?: number | null; logTail?: string | null },
  ): Promise<void> {
    await this.setPid(projectId);
    await this.env.DB.prepare(
      'UPDATE runs SET tokens_used = ?, usd_spent = ?, log_tail = ? WHERE id = ? AND project_id = ?',
    ).bind(t.tokensUsed ?? null, t.usdSpent ?? null, t.logTail ?? null, runId, projectId).run();
  }

  /**
   * Phase-boundary verify gate (RUN-21). Interposes at review→done: `passed`
   * advances the phase (its review tasks → done, which unblocks the next phase via
   * the phase-dependency chain); a failure bounces the phase's tasks back to todo
   * for a fix and increments the attempt count — until DEFAULT_MAX_VERIFY_ATTEMPTS
   * failed cycles, after which we stop auto-retrying and escalate to a human
   * (raise an alert; leave the tasks) rather than burn budget on fix→fail→fix.
   */
  async recordPhaseVerify(
    projectId: string,
    actor: Actor,
    phaseId: string,
    passed: boolean,
    opts: { maxAttempts?: number } = {},
  ): Promise<{ action: PhaseGateAction; attempts: number }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const now = nowIso();
      const prev = (await this.env.DB.prepare('SELECT attempts FROM phase_gates WHERE phase_id = ?')
        .bind(phaseId).first<{ attempts: number }>())?.attempts ?? 0;
      const attempts = passed ? prev : prev + 1;
      const action = phaseGateDecision(attempts, passed, opts.maxAttempts ?? DEFAULT_MAX_VERIFY_ATTEMPTS);

      const { results: tasks } = await this.env.DB.prepare(
        'SELECT t.id, t.key, t.status FROM phase_tasks pt JOIN tasks t ON t.id = pt.task_id WHERE pt.phase_id = ?',
      ).bind(phaseId).all<{ id: string; key: string; status: string }>();

      let gateStatus: string;
      if (action === 'advance') {
        gateStatus = 'passed';
        for (const t of tasks) {
          if (t.status !== 'review') continue;
          await this.env.DB.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").bind(now, t.id).run();
          await this.emit(actor, 'task.status_changed', 'task', t.id, { key: t.key, from: 'review', to: 'done', reason: 'verify_passed' });
        }
      } else if (action === 'retry') {
        gateStatus = 'retrying';
        for (const t of tasks) {
          if (t.status !== 'review' && t.status !== 'blocked') continue;
          await this.env.DB.prepare("UPDATE tasks SET status = 'todo', claimed_by = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ?").bind(now, t.id).run();
          await this.emit(actor, 'task.status_changed', 'task', t.id, { key: t.key, from: t.status, to: 'todo', reason: 'verify_failed_retry' });
        }
      } else {
        // escalate — stop auto-retrying, raise an alert for a human (inline insert
        // to avoid nesting blockConcurrencyWhile); leave the tasks as-is.
        gateStatus = 'escalated';
        const sigId = newId('sig');
        await this.env.DB.prepare(
          `INSERT INTO signals (id, project_id, task_id, agent_id, agent_name, type, severity, title, body, status, created_at)
           VALUES (?, ?, ?, NULL, ?, 'alert', 'warning', ?, ?, 'open', ?)`,
        ).bind(
          sigId, this.projectId, tasks[0]?.id ?? null, actor.name,
          `Phase verify failed ${attempts}× — human review needed`,
          `Auto-retry stopped after ${attempts} failed verify cycles. Tasks: ${tasks.map((t) => t.key).join(', ') || '(none)'}.`,
          now,
        ).run();
        await this.emit(actor, 'signal.raised', 'project', this.projectId, { signalId: sigId, sigType: 'alert', severity: 'warning', title: 'phase verify escalated', attempts });
      }

      await this.env.DB.prepare(
        `INSERT INTO phase_gates (phase_id, attempts, status, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(phase_id) DO UPDATE SET attempts = excluded.attempts, status = excluded.status, updated_at = excluded.updated_at`,
      ).bind(phaseId, attempts, gateStatus, now).run();
      return { action, attempts };
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
      /** Emit as a PROPOSED plan (RUN-23): its tasks are gated (not claimable) until
       *  a human approves it. Scope-run agents set this; defaults to an active plan
       *  so existing orchestrator create_plan behavior is unchanged. */
      proposed?: boolean;
      phases: Array<{ title: string; body?: string; taskIds?: string[]; newTasks?: Array<{ title: string; body?: string; priority?: number }> }>;
    },
  )  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const planId = newId('pln');
      const status = input.proposed ? 'proposed' : 'active';
      await this.env.DB.prepare(
        'INSERT INTO plans (id, project_id, agent_id, title, description, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(planId, projectId, input.agentId ?? null, input.title, input.description ?? '', input.body ?? '', status, nowIso()).run();
  
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
        title: input.title, status, phases: phases.map((p) => ({ title: p.title, tasks: p.taskIds.length })),
      });
      return { id: planId, title: input.title, status, phases };

    });
  }

  /** Approve a PROPOSED plan (RUN-23): flip proposed → active so its tasks become
   *  claimable/dispatchable. The mandatory human gate for v1 — gating is plan-level,
   *  so no per-task write is needed (the claimable clause lifts the moment the plan
   *  is active). Idempotent-ish: only a proposed plan can be approved. */
  async approvePlan(projectId: string, actor: Actor, planId: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const plan = await this.env.DB.prepare('SELECT id, title, status FROM plans WHERE id = ? AND project_id = ?')
        .bind(planId, projectId).first<{ id: string; title: string; status: string }>();
      if (!plan) throw new Error('plan not found');
      if (plan.status !== 'proposed') throw new Error(`plan is ${plan.status}, not proposed — nothing to approve`);
      await this.env.DB.prepare("UPDATE plans SET status = 'active' WHERE id = ?").bind(planId).run();
      // Count the tasks this ungates, for the event + response.
      const { taskCount } = (await this.env.DB.prepare(
        'SELECT COUNT(DISTINCT pt.task_id) AS taskCount FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id WHERE ph.plan_id = ?',
      ).bind(planId).first<{ taskCount: number }>())!;
      await this.emit(actor, 'plan.approved', 'plan', planId, { title: plan.title, tasks: taskCount });
      return { id: planId, title: plan.title, status: 'active', tasksUngated: taskCount };
    });
  }

  /** Reject a PROPOSED plan (RUN-23): discard the proposal. Cancels the plan's
   *  never-started tasks (todo + unclaimed — so a referenced pre-existing task that
   *  is already in flight is left alone) so they don't become claimable orphans when
   *  the plan is removed, then deletes the plan + its phase structure. */
  async rejectPlan(projectId: string, actor: Actor, planId: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const plan = await this.env.DB.prepare('SELECT id, title, status FROM plans WHERE id = ? AND project_id = ?')
        .bind(planId, projectId).first<{ id: string; title: string; status: string }>();
      if (!plan) throw new Error('plan not found');
      if (plan.status !== 'proposed') throw new Error(`plan is ${plan.status}, not proposed — only a proposal can be rejected`);
      const { results: taskRows } = await this.env.DB.prepare(
        'SELECT DISTINCT pt.task_id AS id FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id WHERE ph.plan_id = ?',
      ).bind(planId).all<{ id: string }>();
      const now = nowIso();
      const stmts = [
        // Cancel only the plan's own un-started tasks (never touch in-flight/finished work).
        ...taskRows.map((r) =>
          this.env.DB.prepare(
            "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'todo' AND claimed_by IS NULL",
          ).bind(now, r.id),
        ),
        this.env.DB.prepare('DELETE FROM phase_tasks WHERE phase_id IN (SELECT id FROM phases WHERE plan_id = ?)').bind(planId),
        this.env.DB.prepare('DELETE FROM phases WHERE plan_id = ?').bind(planId),
        this.env.DB.prepare('DELETE FROM plans WHERE id = ?').bind(planId),
      ];
      await this.env.DB.batch(stmts);
      await this.emit(actor, 'plan.rejected', 'plan', planId, { title: plan.title, cancelledTasks: taskRows.length });
      return { ok: true, cancelledTasks: taskRows.length };
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

  /** Link a git branch/PR/commit to a task. Routed through the DO (PLNR-95) so it
   *  emits an event + WS fanout — the attach_ref tool used to write straight to D1,
   *  silently. getTask scopes to this project (throws if the task isn't in it). */
  async attachRef(projectId: string, actor: Actor, taskId: string, kind: string, ref: string, url: string | null, state: string | null)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = await this.getTask(taskId);
      await this.env.DB.prepare(
        `INSERT INTO task_refs (id, task_id, kind, ref, url, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id, kind, ref) DO UPDATE SET url = excluded.url, state = excluded.state`,
      ).bind(newId('ref'), taskId, kind, ref, url, state, nowIso()).run();
      await this.emit(actor, 'ref.attached', 'task', taskId, { key: task.key, kind, ref, url, state });
      return { ok: true, taskKey: task.key };
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
