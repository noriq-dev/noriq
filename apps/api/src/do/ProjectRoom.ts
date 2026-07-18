import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { newId, nowIso } from '../lib/util';
import { userCanAccessProject } from '../lib/visibility';
import { unfinishedDeps as unfinishedDepsLib } from '../lib/claimability';
import { needsOutOfBand, sendSignalEmail, sendSignalWebhook } from '../lib/notify-out';
import { requireDecisionOnlyDoc } from '../lib/doclint';
import { searchBackend, indexEntity, removeEntity, type SearchKind } from '../search';
import { findNearDupes } from '../lib/tags';
import { DEFAULT_MAX_VERIFY_ATTEMPTS, type PhaseGateAction, phaseGateDecision } from '../lib/phase-gate';
import { RunKind, AgentTool, RunStatus, type RunPhase, isTerminalRunStatus } from '@noriq-dev/shared';

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
  /** Deadline, ISO datetime (PLNR-126). */
  dueAt?: string | null;
  dependsOn?: string[];
  /** Tags by name — auto-created for the project if they don't exist. */
  tags?: string[];
  /** Legacy alias for a single tag. */
  category?: string | null;
  type?: string;
  /** Board this task lands on; defaults to the project's default board. */
  boardId?: string | null;
  /** Related project docs (PLNR-182) — validated against this project's docs. */
  docIds?: string[];
  /** Permit minting genuinely-new tags past the near-duplicate guard (PLNR-194). */
  allowNewTags?: boolean;
}

export interface TaskPatch {
  title?: string;
  body?: string;
  status?: string;
  priority?: number;
  estimate?: number | null;
  dueAt?: string | null;
  milestoneId?: string | null;
  boardId?: string | null;
  /** Re-parent the task (PLNR-89); null detaches it to a root. Accepts an id or key. */
  parentTaskId?: string | null;
  /** Replace the task's tag set (names; auto-created). */
  tags?: string[];
  /** Non-destructive tag edits (PLNR-135): add/remove by name without clobbering the rest.
   *  addTags auto-creates; removeTags skips names the project doesn't have. */
  addTags?: string[];
  removeTags?: string[];
  /** Legacy single-tag alias. */
  category?: string | null;
  type?: string;
  order?: number;
  /** Replace the task's related-doc set (PLNR-182). */
  docIds?: string[];
  /** Non-destructive doc-link edits, mirroring addTags/removeTags. */
  addDocIds?: string[];
  removeDocIds?: string[];
  /** Permit minting genuinely-new tags past the near-duplicate guard (PLNR-194). */
  allowNewTags?: boolean;
}

type TaskRow = {
  id: string;
  key: string;
  status: string;
  claimed_by: string | null;
  claim_expires_at: string | null;
  failed_at: string | null;
  title: string;
};

const CLAIMABLE_STATUSES = ['todo', 'claimed'];

// --- Runs (execution plane, RUN-6) -----------------------------------------
export interface CreateRunInput {
  kind: string; // RunKind: scope|build|verify
  anchor?: { type: 'task' | 'plan'; id: string } | null;
  /** VERIFY only: the build run whose diff this one judges (ignored for other kinds). */
  verifiesRunId?: string | null;
  /** Land somewhere other than the repo's computed branch (RUN-41). The REPO decides whether that
   *  is permitted — checked daemon-side against [land].allowedBranches, since the manifest is
   *  committed in the repo and invisible here. */
  targetBranch?: string | null;
  brief?: string;
  repoRef: string;
  agentTool: string; // AgentTool: claude|codex
  /** Per-dispatch model + effort (RUN-33). Null = the repo's [defaults] for this kind, then
   *  the tool's own default. The daemon resolves that chain; it has the manifest, we don't. */
  model?: string | null;
  effort?: string | null;
  budget?: Record<string, unknown> | null;
  /** Pre-assign a runner (create + dispatch in one shot); else the Run starts queued. */
  runnerId?: string | null;
  /** Actor id credited as the dispatcher; defaults to the acting actor. */
  createdBy?: string;
  /** The plan dispatch that fanned this run out (PLNR-170). Null = a one-off dispatch. */
  planDispatchId?: string | null;
}

export interface RunPatch {
  status: string; // target RunStatus
  agentId?: string | null; // set once the spawned agent registers its own actor
  exit?: Record<string, unknown> | null; // terminal detail; synthesized if omitted
  worktreePath?: string | null; // daemon-side checkout path, for server-side visibility
  phase?: RunPhase | null; // sub-state of running (RUN-31); forced to null on terminal
  reason?: string | null;
}

type RunRow = {
  id: string; project_id: string; runner_id: string | null; agent_id: string | null;
  kind: string; anchor_type: string | null; anchor_id: string | null; verifies_run_id: string | null;
  plan_id: string | null; plan_key: string | null; target_branch: string | null; brief: string;
  repo_ref: string; agent_tool: string; model: string | null; effort: string | null;
  budget: string; status: string; phase: string | null;
  exit: string | null;
  worktree_path: string | null;
  tokens_used: number | null; usd_spent: number | null; log_tail: string | null;
  model_usage: string | null;
  plan_dispatch_id: string | null;
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
  /** VERIFY only: the build run whose diff this one judges. */
  verifiesRunId: string | null;
  /** The plan this run serves (RUN-28) — drives the per-plan working branch. Null = one-off. */
  planKey: string | null;
  /** A per-dispatch landing branch (RUN-41). Null = the repo's computed one. */
  targetBranch: string | null;
  brief: string;
  repoRef: string;
  agentTool: string;
  /** Per-dispatch model + effort (RUN-33). Null = the repo's [defaults], then the tool's. */
  model: string | null;
  effort: string | null;
  budget: Record<string, unknown>;
  status: string;
  /** Sub-state of `running` (RUN-31): what it is doing. Null when queued or terminal. */
  phase: RunPhase | null;
  exit: Record<string, unknown> | null;
  worktreePath: string | null;
  // Live telemetry (RUN-22): last-writer-wins spend + log tail from the daemon.
  tokensUsed: number | null;
  usdSpent: number | null;
  logTail: string | null;
  /** What the run actually spent per model (RUN-59); null = not reported. */
  modelUsage: Record<string, unknown> | null;
  /** The plan dispatch that fanned this run out (PLNR-170). Null = a one-off. The daemon's
   *  Run schema doesn't know the field and strips it — orchestration is server/UI business. */
  planDispatchId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  startedAt: string | null;
}

// --- Plan dispatch (PLNR-170) -----------------------------------------------
// "Dispatch a plan" = a durable orchestration record + a pump. The pump creates one
// task-anchored BUILD run per ready task (dependency edges satisfied), up to the runner's
// advertised capacity, and re-runs on every unblocking event: a run reaching terminal, a task
// reaching done/cancelled, a runner heartbeat with free slots, or an explicit retry. No queue
// object exists anywhere — the record plus re-derivation IS the scheduler, which is what lets
// it survive deploys, DO evictions, and the runner being off (the lesson plan_landings taught).

export interface CreatePlanDispatchInput {
  planId: string;
  runnerId: string;
  repoRef: string;
  agentTool: string;
  model?: string | null;
  effort?: string | null;
  /** Applied to every run this dispatch creates. */
  budget?: Record<string, unknown> | null;
  /** 'approved' (default, PLNR-176): dependents wait until the human marks each upstream task
   *  done — review is a real lock. 'landed': dependents start once the upstream's run lands
   *  (code on the plan branch) while review is still pending — explicit opt-in. */
  gate?: 'landed' | 'approved';
  createdBy?: string;
}

type PlanDispatchRow = {
  id: string; project_id: string; plan_id: string; runner_id: string; repo_ref: string;
  agent_tool: string; model: string | null; effort: string | null; budget: string;
  gate: string; status: string; stall_reason: string | null;
  created_by: string; created_at: string; updated_at: string; finished_at: string | null;
};

/** Per-task progress inside a dispatch, for the dashboard's plan card. */
export interface PlanDispatchTaskView {
  taskId: string;
  runId: string | null; // latest run this dispatch created for the task; null = not yet dispatched
  runStatus: string | null;
}

export interface PlanDispatchView {
  id: string;
  projectId: string;
  planId: string;
  runnerId: string;
  repoRef: string;
  agentTool: string;
  model: string | null;
  effort: string | null;
  budget: Record<string, unknown>;
  gate: 'landed' | 'approved';
  status: 'active' | 'stalled' | 'completed' | 'cancelled';
  stallReason: string | null;
  tasks: PlanDispatchTaskView[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
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
  async resolveTag(projectId: string, actor: Actor, name: string, allowNew = false): Promise<string>  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const trimmed = name.trim().toLowerCase();
      const existing = await this.env.DB.prepare('SELECT id FROM tags WHERE project_id = ? AND name = ?')
        .bind(this.projectId, trimmed).first<{ id: string }>();
      if (existing) return existing.id;
      // Minting a NEW tag (PLNR-194). Tags are a controlled filter vocabulary, and the
      // sprawl failure mode is agents minting per-item keywords. Humans mint freely —
      // they are the curators. Agents face two gates:
      //   curated policy → no agent minting at all (use the existing vocabulary);
      //   open policy    → a near-duplicate of an existing tag is rejected unless the
      //                    caller explicitly says allowNewTags (genuinely-new names pass).
      if (actor.kind !== 'human') {
        const proj = await this.env.DB.prepare('SELECT tag_policy AS policy FROM projects WHERE id = ?')
          .bind(this.projectId).first<{ policy: string }>();
        const { results } = await this.env.DB.prepare('SELECT name FROM tags WHERE project_id = ?')
          .bind(this.projectId).all<{ name: string }>();
        const names = results.map((r) => r.name);
        const near = findNearDupes(trimmed, names);
        if (proj?.policy === 'curated') {
          throw new Error(
            `tag "${trimmed}" does not exist and this project's tag vocabulary is curated (agents cannot mint tags). ` +
            (near.length ? `Closest existing: ${near.join(', ')}. ` : '') +
            'Use an existing tag (get_project.tags), or ask a human to add it.',
          );
        }
        if (near.length && !allowNew) {
          throw new Error(
            `tag "${trimmed}" is close to existing tag(s): ${near.join(', ')} — use one of those. ` +
            'If it is genuinely a distinct concept, pass allowNewTags: true.',
          );
        }
      }
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

  private async setTaskTags(projectId: string, actor: Actor, taskId: string, names: string[], allowNew = false) {
    const ids: string[] = [];
    for (const n of names) {
      if (n.trim()) ids.push(await this.resolveTag(projectId, actor, n, allowNew));
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
      // Every task lands on a board. Placement chain, decided HERE — the one seam every
      // creation path funnels through (create_task, create_tasks, create_plan's newTasks,
      // decompose_task): explicit boardId (validated — a typo or a foreign project's board
      // id must fail loudly, not as an opaque FK error or a silent cross-project placement)
      // → the parent task's board (a subtask sits beside its parent, PLNR-181) → the
      // creating agent's repo board lock (RUN-71, run-spawned agents only; a copilot or
      // human has no run bound, so the lookup finds nothing) → the project's default
      // board. The lock is a DEFAULT, not a fence: it is about where a repo's work lands
      // uninstructed, not about forbidding instruction — and a parent's board is
      // instruction too, since someone placed that parent deliberately.
      const boardId = input.boardId
        ? await this.requireProjectBoard(input.boardId)
        : (await this.parentBoardId(input.parentTaskId))
          ?? (await this.actorRepoBoardId(actor))
          ?? (await this.defaultBoardId(pid));
      // Doc links (PLNR-182) validate BEFORE the insert batch so a bad doc id fails the
      // whole create cleanly instead of leaving a task without its intended links.
      const docIds = await this.requireProjectDocs(input.docIds);
      // Tags resolve BEFORE the insert too (PLNR-194 hardening): the mint guard can reject
      // (near-duplicate / curated policy), and a post-insert rejection used to leave a
      // half-created untagged task behind. Failing here fails the whole create; the
      // worst leftover is a freshly-minted tag with zero uses, which is harmless.
      const tagNames = [...(input.tags ?? []), ...(input.category ? [input.category] : [])];
      const tagIds: string[] = [];
      for (const n of tagNames) {
        if (n.trim()) tagIds.push(await this.resolveTag(pid, actor, n, input.allowNewTags));
      }
      const stmts = [
        this.env.DB.prepare(
          `INSERT INTO tasks (id, project_id, key, milestone_id, board_id, parent_task_id, title, body, status, type, priority, estimate, due_at, "order", created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, pid, key, input.milestoneId ?? null, boardId, input.parentTaskId ?? null, input.title, input.body ?? '', input.type ?? 'feature', input.priority ?? 2, input.estimate ?? null, input.dueAt ?? null, proj.n, now, now),
        this.env.DB.prepare('UPDATE projects SET next_task_number = ? WHERE id = ?').bind(proj.n + 1, pid),
      ];
      for (const dep of input.dependsOn ?? []) {
        stmts.push(
          this.env.DB.prepare('INSERT OR IGNORE INTO dependencies (task_id, depends_on_task_id) VALUES (?, ?)').bind(id, dep),
        );
      }
      for (const docId of docIds) {
        stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO task_docs (task_id, doc_id) VALUES (?, ?)').bind(id, docId));
      }
      for (const tid of tagIds) {
        stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').bind(id, tid));
      }
      await this.env.DB.batch(stmts);
      await this.emit(actor, 'task.created', 'task', id, {
        key, title: input.title, parentTaskId: input.parentTaskId ?? null,
      });
      this.reindexSearch('task', id);
      return { id, key };
    
    });
  }

  async updateTask(projectId: string, actor: Actor, taskId: string, patch: TaskPatch)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = await this.getTask(taskId);
      // Consumed by the tag paths only — must not reach the generic field loop.
      const allowNewTags = patch.allowNewTags;
      delete patch.allowNewTags;
      if (patch.category !== undefined) {
        patch.tags = patch.category ? [patch.category] : [];
        delete patch.category;
      }
      if (patch.tags !== undefined) {
        await this.setTaskTags(projectId, actor, taskId, patch.tags, allowNewTags);
        delete patch.tags;
        // Tag-only updates still emit below via the fields list; ensure at least one emit.
        if (Object.keys(patch).filter((k) => k !== 'tags').length === 0) {
          await this.emit(actor, 'task.updated', 'task', taskId, { key: task.key, fields: ['tags'] });
          this.reindexSearch('task', taskId);
          return { ok: true, key: task.key };
        }
      }
      // Non-destructive tag edits (PLNR-135) — the whole point vs `tags` is NOT clobbering
      // what's already there, so bulk "add one label" can't eat hand-applied tags.
      if (patch.addTags !== undefined || patch.removeTags !== undefined) {
        const stmts = [];
        for (const n of patch.addTags ?? []) {
          if (!n.trim()) continue;
          const tid = await this.resolveTag(projectId, actor, n, allowNewTags);
          stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').bind(taskId, tid));
        }
        for (const n of patch.removeTags ?? []) {
          const trimmed = n.trim().toLowerCase();
          if (!trimmed) continue;
          stmts.push(this.env.DB.prepare(
            'DELETE FROM task_tags WHERE task_id = ? AND tag_id IN (SELECT id FROM tags WHERE project_id = ? AND name = ?)',
          ).bind(taskId, this.projectId, trimmed));
        }
        if (stmts.length) await this.env.DB.batch(stmts);
        delete patch.addTags;
        delete patch.removeTags;
        if (Object.keys(patch).length === 0) {
          await this.emit(actor, 'task.updated', 'task', taskId, { key: task.key, fields: ['tags'] });
          return { ok: true, key: task.key };
        }
      }
      // Doc links (PLNR-182), same shape as the tag edits: `docIds` replaces the set,
      // addDocIds/removeDocIds edit it without clobbering. All ids validated project-local.
      if (patch.docIds !== undefined || patch.addDocIds !== undefined || patch.removeDocIds !== undefined) {
        const stmts = [];
        if (patch.docIds !== undefined) {
          const ids = await this.requireProjectDocs(patch.docIds);
          stmts.push(this.env.DB.prepare('DELETE FROM task_docs WHERE task_id = ?').bind(taskId));
          for (const d of ids) stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO task_docs (task_id, doc_id) VALUES (?, ?)').bind(taskId, d));
        }
        for (const d of await this.requireProjectDocs(patch.addDocIds)) {
          stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO task_docs (task_id, doc_id) VALUES (?, ?)').bind(taskId, d));
        }
        for (const d of patch.removeDocIds ?? []) {
          stmts.push(this.env.DB.prepare('DELETE FROM task_docs WHERE task_id = ? AND doc_id = ?').bind(taskId, d));
        }
        if (stmts.length) await this.env.DB.batch(stmts);
        delete patch.docIds;
        delete patch.addDocIds;
        delete patch.removeDocIds;
        if (Object.keys(patch).length === 0) {
          await this.emit(actor, 'task.updated', 'task', taskId, { key: task.key, fields: ['docs'] });
          return { ok: true, key: task.key };
        }
      }
      // Same guard as createTask: a board move must name a board of THIS project.
      if (patch.boardId) patch.boardId = await this.requireProjectBoard(patch.boardId);
      const sets: string[] = [];
      const binds: unknown[] = [];
      const fields: Array<[keyof TaskPatch, string]> = [
        ['title', 'title'], ['body', 'body'], ['priority', 'priority'], ['type', 'type'],
        ['estimate', 'estimate'], ['dueAt', 'due_at'], ['milestoneId', 'milestone_id'], ['boardId', 'board_id'], ['order', '"order"'],
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
      // 'failed' is a DERIVED wire status (PLNR-178), never a stored one — the CHECK forbids
      // it, and it is set only by a run's gate outcome (settleAnchorTask). A human dropping a
      // task on the Failed column must be a no-op, not a 500.
      if (patch.status === 'failed') delete patch.status;
      let statusChanged = false;
      if (patch.status !== undefined) {
        // A human explicitly restatusing a task RESOLVES any prior gate failure — whether they
        // move it to review/done (accepting it) or back to todo (re-queuing). Clear failed_at
        // even when the real status is unchanged (a failed task's real status is already 'todo',
        // so a Failed→Todo drag changes nothing but the marker).
        if (task.failed_at) sets.push('failed_at = NULL');
        if (patch.status !== task.status) {
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
      }
      if (!sets.length) return { ok: true, key: task.key };
      sets.push('updated_at = ?');
      binds.push(nowIso(), taskId);
      await this.env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      if (statusChanged) {
        await this.emit(actor, 'task.status_changed', 'task', taskId, { key: task.key, from: task.status, to: patch.status, title: task.title });
        // The second way a task reaches done — a supervisor override rather than an agent
        // releasing it. Both paths need the hook or a plan finished by hand would never open its
        // merge request. `cancelled` counts too: a plan whose last open task was explicitly
        // dropped IS finished, and ignoring that strands its branch forever (RUN-28).
        if (patch.status === 'done' || patch.status === 'cancelled') {
          await this.maybeCompletePlan(taskId, actor);
          // Same event, plan-dispatch side (PLNR-170): a human approving (or dropping) a task
          // is exactly what an 'approved'-gated — or stalled — dispatch is waiting on.
          await this.pumpLiveDispatches(actor);
        }
      } else {
        await this.emit(actor, 'task.updated', 'task', taskId, { key: task.key, fields: Object.keys(patch) });
      }
      this.reindexSearch('task', taskId);
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
      // Run-anchored claims and the dependency gate (PLNR-170, tightened by PLNR-176):
      // - A HUMAN dispatching a single task made an explicit, standing readiness call — full
      //   bypass, as before.
      // - A PUMP-dispatched run's readiness call is dispatch-time only, and it can go stale:
      //   the human may kick an upstream task back to todo between dispatch and claim (the
      //   RUN-59 incident). So the claim re-evaluates the same predicate the pump used, WITH
      //   the dispatch's own gate — under 'landed' a review-with-landed-run upstream still
      //   satisfies (that's what the operator opted into); anything less refuses the claim.
      // - Pool claims (no anchored run) get the strict gate, as always.
      const anchored = await this.env.DB.prepare(
        `SELECT plan_dispatch_id AS pdid FROM runs WHERE agent_id = ? AND anchor_type = 'task' AND anchor_id = ?
          AND status IN ('dispatched','running','blocked') ORDER BY created_at DESC LIMIT 1`,
      ).bind(agentId, taskId).first<{ pdid: string | null }>();
      if (!anchored) {
        const blockers = await this.unfinishedDeps(taskId);
        if (blockers.length) {
          throw new Error(`${task.key} is blocked by unfinished dependencies: ${blockers.join(', ')}`);
        }
      } else if (anchored.pdid) {
        const d = await this.env.DB.prepare('SELECT gate FROM plan_dispatches WHERE id = ?')
          .bind(anchored.pdid).first<{ gate: string }>();
        const blockers = await this.unfinishedDeps(taskId, d?.gate === 'landed' ? 'landed' : 'strict');
        if (blockers.length) {
          throw new Error(
            `${task.key} is blocked by unfinished dependencies: ${blockers.join(', ')} — readiness changed since dispatch (an upstream was sent back?)`,
          );
        }
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
        // Clearing failed_at (RUN-83): claiming a task for a retry drops its prior gate failure,
        // so the derived wire status returns to in_progress instead of lingering as `failed`.
        this.env.DB.prepare("UPDATE tasks SET status = 'in_progress', claimed_by = ?, claim_expires_at = ?, failed_at = NULL, updated_at = ? WHERE id = ?")
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
      // A plan is finished when its last task is — check here rather than on a timer, so the
      // merge request follows the work instead of trailing it (RUN-28).
      if (toStatus === 'done') {
        await this.maybeCompletePlan(taskId, actor);
        // A task reaching done (e.g. a human approving a review) may unblock a plan
        // dispatch's dependents (PLNR-170). Never throws.
        await this.pumpLiveDispatches(actor);
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
    input: {
      type: 'input_request' | 'alert'; taskId?: string | null; title: string; body?: string;
      options?: string[]; severity?: string;
      /** Batched questions (PLNR-131, kinds PLNR-185) — structure for the UI. `kind`:
       *  select (one of options) | multi (several) | text (freeform) | number | confirm
       *  (yes/no). Legacy `multi: true` still reads as kind 'multi'. Answers come back
       *  structured in response_json plus the derived formatted string in response. */
      questions?: Array<{ question: string; header?: string; multi?: boolean; options?: string[]; kind?: 'select' | 'multi' | 'text' | 'number' | 'confirm' }>;
      /** Threads a clarifying round onto an earlier gate (PLNR-185). Must name an
       *  input_request in this project; the new gate inherits its task when taskId
       *  is not given, so round two parks the same task round one did. */
      followUpTo?: string | null;
    },
  )  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      let parent: { id: string; taskId: string | null } | null = null;
      if (input.type === 'input_request' && input.followUpTo) {
        parent = await this.env.DB.prepare(
          "SELECT id, task_id AS taskId FROM signals WHERE id = ? AND project_id = ? AND type = 'input_request'",
        ).bind(input.followUpTo, this.projectId).first<{ id: string; taskId: string | null }>();
        if (!parent) throw new Error(`followUpTo ${input.followUpTo} is not an input request in this project`);
      }
      const task = input.taskId ? await this.getTask(input.taskId) : (parent?.taskId ? await this.getTask(parent.taskId) : null);
      const id = newId('sig');
      const severity = input.type === 'input_request' ? 'info' : (input.severity ?? 'info');
      await this.env.DB.prepare(
        `INSERT INTO signals (id, project_id, task_id, agent_id, agent_name, type, severity, title, body, options, questions, follow_up_to, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      ).bind(
        id, this.projectId, task?.id ?? null, actor.kind === 'agent' ? actor.id : null, actor.name,
        input.type, severity, input.title, input.body ?? null,
        input.options && input.options.length ? JSON.stringify(input.options) : null,
        input.questions && input.questions.length ? JSON.stringify(input.questions) : null,
        parent?.id ?? null, nowIso(),
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
      // Out-of-band delivery (PLNR-120): a blocking decision or a critical alert must
      // reach the supervisor even with no tab open. Best-effort — a notification
      // failure never fails the signal.
      if (needsOutOfBand(input.type, severity)) {
        const owner = await this.env.DB.prepare(
          'SELECT u.email, p.key AS projectKey FROM projects p LEFT JOIN users u ON u.id = p.owner_user_id WHERE p.id = ?',
        ).bind(this.projectId).first<{ email: string | null; projectKey: string }>();
        const n = {
          projectId: this.projectId, projectKey: owner?.projectKey ?? '', type: input.type, severity,
          title: input.title, body: input.body ?? null, taskKey: task?.key ?? null,
          agentName: actor.name, options: input.options ?? null,
        };
        await Promise.all([
          owner?.email ? sendSignalEmail(this.env, owner.email, n) : Promise.resolve(false),
          sendSignalWebhook(this.env, n),
        ]).catch(() => {});
      }
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

  /** Human answers an input_request → unblocks its task (back to the queue) + notifies
   *  the requester. `answers` (PLNR-185) carries the structured per-question form; the
   *  flat `response` string is derived from it when not given, so every downstream
   *  reader (resume frames, notices, old clients) keeps working off text. */
  async answerSignal(
    projectId: string, actor: Actor, signalId: string, response: string,
    answers?: Array<{ question: string; answer: string | string[] | number | boolean }>,
  )  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const sig = await this.env.DB.prepare(
        // `body` is here for the resume frame (RUN-30): the agent gets its own question back
        // alongside the answer, because a session resumed after a night away should not have to
        // infer what it asked from a bare reply.
        'SELECT id, task_id AS taskId, agent_id AS agentId, type, status, title, body FROM signals WHERE id = ? AND project_id = ?',
      ).bind(signalId, this.projectId).first<{ id: string; taskId: string | null; agentId: string | null; type: string; status: string; title: string; body: string | null }>();
      if (!sig) throw new Error('signal not found');
      if (sig.status !== 'open') return { ok: true, alreadyResolved: true };
      if (!response && answers?.length) {
        const fmt = (a: string | string[] | number | boolean) => Array.isArray(a) ? a.join(', ') : String(a);
        response = answers.map((a) => `${a.question} → ${fmt(a.answer)}`).join('\n');
      }
      await this.env.DB.prepare("UPDATE signals SET status = 'answered', response = ?, response_json = ?, responder_id = ?, resolved_at = ? WHERE id = ?")
        .bind(response, answers?.length ? JSON.stringify(answers) : null, actor.id, nowIso(), signalId).run();
      // Return a parked task to the queue so the requester (or anyone) can resume it.
      let taskKey: string | null = null;
      if (sig.type === 'input_request' && sig.taskId) {
        const task = await this.getTask(sig.taskId);
        taskKey = task.key;
        if (task.status === 'blocked') {
          await this.env.DB.prepare("UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ?").bind(nowIso(), sig.taskId).run();
        }
      }
      // Mirror to the Run (RUN-18): the answer returns a blocked Run to running.
      //
      // RUN-30 changed what that means. It used to assume the agent process was still alive and
      // would notice the answer through its own MCP notices — true only for a run parked for
      // minutes. The daemon now ENDS the session on a park (a question can wait overnight, and a
      // process holding a slot that long is a slot nobody else can use), so the row going back to
      // 'running' is not enough on its own: something has to tell the machine to bring the agent
      // back, and hand it the answer.
      if (sig.type === 'input_request' && sig.agentId) {
        const { results } = await this.env.DB.prepare(
          `SELECT id, runner_id AS runnerId FROM runs
            WHERE project_id = ? AND agent_id = ? AND status = 'blocked'`,
        ).bind(this.projectId, sig.agentId).all<{ id: string; runnerId: string | null }>();
        for (const r of results) {
          await this.env.DB.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?").bind(nowIso(), r.id).run();
          await this.emit(actor, 'run.status_changed', 'run', r.id, { from: 'blocked', to: 'running', reason: 'input_answered' });
          if (!r.runnerId) continue;
          // Fast path only — `signals` holds the answer, and the daemon re-asks
          // (GET /api/runs/:id/park) for every run it parked, on every reconnect. A daemon that
          // was off when this fired is the normal case, not the edge one.
          try {
            await this.env.RUNNER_HUB.get(this.env.RUNNER_HUB.idFromName(r.runnerId)).deliver(
              JSON.stringify({
                type: 'run.resume',
                runId: r.id,
                signalId: sig.id,
                question: [sig.title, sig.body].filter(Boolean).join('\n\n') || null,
                answer: response,
              }),
            );
          } catch {
            /* socket gone — the signal is answered on the row, and reconnect will ask */
          }
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

  async createMilestone(projectId: string, actor: Actor, title: string, dueAt?: string | null, description?: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const id = newId('ms');
      const row = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM milestones WHERE project_id = ?')
        .bind(this.projectId).first<{ n: number }>();
      await this.env.DB.prepare('INSERT INTO milestones (id, project_id, title, due_at, description, "order") VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, this.projectId, title, dueAt ?? null, description ?? '', row?.n ?? 0).run();
      await this.emit(actor, 'milestone.created', 'milestone', id, { title });
      // Echo enough back that the caller can confirm what it made without a re-read (PLNR-137).
      return { id, title, dueAt: dueAt ?? null, description: description ?? '' };
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

  /** Resolve an explicitly requested board or throw a readable error. The boards FK alone
   *  can't do this: it doesn't know about projects, so another project's board id would
   *  pass it and silently land the task on a foreign board. */
  private async requireProjectBoard(boardId: string): Promise<string> {
    const row = await this.env.DB.prepare('SELECT id FROM boards WHERE id = ? AND project_id = ?')
      .bind(boardId, this.projectId).first<{ id: string }>();
    if (!row) throw new Error(`board ${boardId} not found in this project (see get_project.boards)`);
    return row.id;
  }

  // ---------------------------------------------------------------------------
  // Search indexing (PLNR-184) — fire-and-forget from every content write seam.
  // Never awaited on the write path and never throws: freshness is best-effort,
  // and an instance without the AI/VECTORIZE bindings skips it entirely.
  // ---------------------------------------------------------------------------

  protected reindexSearch(kind: SearchKind, id: string): void {
    const backend = searchBackend(this.env);
    if (!backend) return;
    void (async () => {
      if (kind === 'task') {
        const t = await this.env.DB.prepare(
          `SELECT t.project_id AS pid, t.title, t.body,
                  (SELECT GROUP_CONCAT(g.name, ' ') FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id) AS tags
           FROM tasks t WHERE t.id = ?`,
        ).bind(id).first<{ pid: string; title: string; body: string; tags: string | null }>();
        if (t) await indexEntity(backend, { kind, id, projectId: t.pid, title: t.title, body: t.body, extra: t.tags });
      } else if (kind === 'doc') {
        const d = await this.env.DB.prepare(
          `SELECT d.project_id AS pid, d.name, d.description, d.body, d.folder,
                  (SELECT GROUP_CONCAT(g.name, ' ') FROM doc_tags dt JOIN tags g ON g.id = dt.tag_id WHERE dt.doc_id = d.id) AS tags
           FROM docs d WHERE d.id = ?`,
        ).bind(id).first<{ pid: string; name: string; description: string; body: string; folder: string; tags: string | null }>();
        if (d) await indexEntity(backend, { kind, id, projectId: d.pid, title: d.name, body: d.body, extra: [d.description, d.folder, d.tags].filter(Boolean).join(' ') });
      } else {
        const p = await this.env.DB.prepare('SELECT project_id AS pid, title, description, body FROM plans WHERE id = ?')
          .bind(id).first<{ pid: string; title: string; description: string; body: string }>();
        if (p) await indexEntity(backend, { kind, id, projectId: p.pid, title: p.title, body: p.body, extra: p.description });
      }
    })().catch(() => {});
  }

  protected dropSearch(kind: SearchKind, ...ids: string[]): void {
    const backend = searchBackend(this.env);
    if (!backend) return;
    void (async () => { for (const id of ids) await removeEntity(backend, kind, id); })().catch(() => {});
  }

  /** Validate doc ids against THIS project's docs (PLNR-182): a typo or a foreign
   *  project's doc id fails loudly with the full list of offenders. Returns the
   *  deduplicated ids; [] for empty/undefined input. */
  private async requireProjectDocs(docIds: string[] | undefined): Promise<string[]> {
    const ids = [...new Set((docIds ?? []).filter(Boolean))];
    if (!ids.length) return [];
    const { results } = await this.env.DB.prepare(
      `SELECT id FROM docs WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    ).bind(this.projectId, ...ids).all<{ id: string }>();
    const found = new Set(results.map((r) => r.id));
    const missing = ids.filter((d) => !found.has(d));
    if (missing.length) throw new Error(`doc(s) not found in this project: ${missing.join(', ')} (see list_docs)`);
    return ids;
  }

  /** The board a new subtask inherits (PLNR-181): its parent's, so a decomposed task's
   *  children land beside it instead of on the default board. Null for root tasks. */
  private async parentBoardId(parentTaskId: string | null | undefined): Promise<string | null> {
    if (!parentTaskId) return null;
    const row = await this.env.DB.prepare('SELECT board_id AS boardId FROM tasks WHERE id = ? AND project_id = ?')
      .bind(parentTaskId, this.projectId).first<{ boardId: string | null }>();
    return row?.boardId ?? null;
  }

  /** The board lock of the actor's repo (RUN-71): if this actor is a run-spawned agent with a
   *  live run, and that run's repo carries a resolved boardId, tasks it creates land there.
   *  The repo binding lives in the runner's advertised repos JSON — one row, parsed here, only
   *  on the create path of an agent actor, so nothing hot pays for it. Any miss (no run, no
   *  runner row, repo gone from the advertisement, no lock) falls through to null. */
  private async actorRepoBoardId(actor: Actor): Promise<string | null> {
    if (actor.kind !== 'agent') return null;
    const run = await this.env.DB.prepare(
      `SELECT repo_ref AS repoRef, runner_id AS runnerId FROM runs
       WHERE agent_id = ? AND status IN ('dispatched','running','blocked') LIMIT 1`,
    ).bind(actor.id).first<{ repoRef: string; runnerId: string | null }>();
    if (!run?.runnerId) return null;
    const runner = await this.env.DB.prepare('SELECT repos FROM runners WHERE id = ?')
      .bind(run.runnerId).first<{ repos: string }>();
    if (!runner) return null;
    try {
      const repo = (JSON.parse(runner.repos) as Array<{ id: string; projectId: string | null; boardId?: string | null }>)
        .find((r) => r.id === run.repoRef);
      // The lock only binds within its own resolved project — a repo must never steer
      // task placement in a project it doesn't belong to.
      return repo && repo.projectId === this.projectId ? (repo.boardId ?? null) : null;
    } catch {
      return null; // malformed advertisement — behave as unlocked
    }
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
  /** Merge tag `from` INTO tag `into` (PLNR-194): every task/doc carrying `from` is
   *  re-pointed to `into` (deduped), then `from` is deleted. The vocabulary-cleanup
   *  primitive — deleteTag alone can only detach, which loses the grouping. Accepts
   *  ids or names. */
  async mergeTags(projectId: string, actor: Actor, from: string, into: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const resolve = async (ref: string) =>
        this.env.DB.prepare('SELECT id, name FROM tags WHERE project_id = ? AND (id = ? OR name = ?)')
          .bind(this.projectId, ref, ref.trim().toLowerCase()).first<{ id: string; name: string }>();
      const src = await resolve(from);
      const dst = await resolve(into);
      if (!src) throw new Error(`tag "${from}" not found in this project`);
      if (!dst) throw new Error(`tag "${into}" not found in this project — merge targets must already exist`);
      if (src.id === dst.id) throw new Error('cannot merge a tag into itself');
      const [tasks, docs] = await Promise.all([
        this.env.DB.prepare('SELECT COUNT(*) AS n FROM task_tags WHERE tag_id = ?').bind(src.id).first<{ n: number }>(),
        this.env.DB.prepare('SELECT COUNT(*) AS n FROM doc_tags WHERE tag_id = ?').bind(src.id).first<{ n: number }>(),
      ]);
      await this.env.DB.batch([
        this.env.DB.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) SELECT task_id, ? FROM task_tags WHERE tag_id = ?').bind(dst.id, src.id),
        this.env.DB.prepare('DELETE FROM task_tags WHERE tag_id = ?').bind(src.id),
        this.env.DB.prepare('INSERT OR IGNORE INTO doc_tags (doc_id, tag_id) SELECT doc_id, ? FROM doc_tags WHERE tag_id = ?').bind(dst.id, src.id),
        this.env.DB.prepare('DELETE FROM doc_tags WHERE tag_id = ?').bind(src.id),
        // Re-point any legacy tasks.category_id FK from src→dst before deleting src, or the
        // delete FK-aborts on old data (PLNR-108) — mirrors the task_tags re-point above.
        this.env.DB.prepare('UPDATE tasks SET category_id = ? WHERE category_id = ?').bind(dst.id, src.id),
        this.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(src.id),
      ]);
      await this.emit(actor, 'tag.merged', 'tag', dst.id, {
        from: src.name, into: dst.name, retaggedTasks: tasks?.n ?? 0, retaggedDocs: docs?.n ?? 0,
      });
      return { ok: true, from: src.name, into: dst.name, retaggedTasks: tasks?.n ?? 0, retaggedDocs: docs?.n ?? 0 };
    });
  }

  async deleteTag(projectId: string, actor: Actor, tagId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const tag = await this.env.DB.prepare('SELECT id, name FROM tags WHERE id = ? AND project_id = ?')
        .bind(tagId, this.projectId).first<{ id: string; name: string }>();
      if (!tag) throw new Error('tag not found');
      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM task_tags WHERE tag_id = ?').bind(tagId),
        this.env.DB.prepare('DELETE FROM doc_tags WHERE tag_id = ?').bind(tagId),
        // Detach any legacy tasks.category_id FK to this tag first, or the delete FK-aborts
        // on old data (PLNR-108). task_tags already carries the assignment; nulling loses nothing.
        this.env.DB.prepare('UPDATE tasks SET category_id = NULL WHERE category_id = ?').bind(tagId),
        this.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(tagId),
      ]);
      await this.emit(actor, 'tag.deleted', 'tag', tagId, { name: tag.name });
      return { ok: true };
    });
  }

  /** Directed reassignment (PLNR-122): hand a task to a NAMED agent instead of releasing
   *  it into the pool for whoever grabs first — the transfer orchestrator→worker was
   *  otherwise a race. Rides the existing claim machinery: the target becomes the real
   *  holder with a fresh TTL, so if they never show, the normal expiry requeue reclaims
   *  it — a handoff can strand nothing. Allowed for the CURRENT HOLDER (transfer my work)
   *  or on an unclaimed, claimable task (pre-assign); never a steal. The target hears
   *  via the notices channel (sync.ts reads task.handed_off). */
  async handoffTask(projectId: string, actor: Actor, taskId: string, toAgentId: string, note?: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = await this.getTask(taskId);
      const target = await this.env.DB.prepare(
        'SELECT id, COALESCE(label, name) AS name, status, project_id AS pid FROM agents WHERE id = ?',
      ).bind(toAgentId).first<{ id: string; name: string; status: string; pid: string | null }>();
      if (!target) throw new Error(`agent ${toAgentId} not found`);
      if (target.status === 'revoked') throw new Error(`${target.name} is revoked — pick a live agent (list_agents)`);
      if (target.pid !== projectId) throw new Error(`${target.name} is not on this project — a handoff cannot cross projects`);

      // Holder-ship BEFORE the self check: a non-holder handing a task "to themselves"
      // is a steal, and the refusal should say so — not quibble about the target.
      const live = !!(task.claimed_by && task.claim_expires_at && task.claim_expires_at > nowIso());
      if (live && task.claimed_by !== actor.id) {
        throw new Error(`${task.key} is claimed by another agent — only the holder may hand it off`);
      }
      if (target.id === actor.id) throw new Error('cannot hand a task to yourself');
      if (!live && !CLAIMABLE_STATUSES.includes(task.status)) {
        throw new Error(`${task.key} is not claimable (status: ${task.status})`);
      }
      const blockers = await this.unfinishedDeps(task.id);
      if (blockers.length) {
        throw new Error(`${task.key} is blocked by unfinished dependencies: ${blockers.join(', ')} — the target could not work it`);
      }
      const gated = await this.env.DB.prepare(
        `SELECT 1 FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id JOIN plans pl ON pl.id = ph.plan_id
         WHERE pt.task_id = ? AND pl.status = 'proposed'`,
      ).bind(task.id).first();
      if (gated) throw new Error(`${task.key} belongs to a proposed plan awaiting human approval`);

      const ttl = await this.claimTtlSeconds();
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE claims SET released_at = ? WHERE task_id = ? AND released_at IS NULL').bind(nowIso(), task.id),
        this.env.DB.prepare('INSERT INTO claims (id, task_id, agent_id, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)')
          .bind(newId('clm'), task.id, target.id, nowIso(), expiresAt),
        this.env.DB.prepare("UPDATE tasks SET status = 'in_progress', claimed_by = ?, claim_expires_at = ?, failed_at = NULL, updated_at = ? WHERE id = ?")
          .bind(target.id, expiresAt, nowIso(), task.id),
      ]);
      await this.emit(actor, 'task.handed_off', 'task', task.id, {
        key: task.key, title: task.title, toAgentId: target.id, toName: target.name,
        previousHolder: task.claimed_by ?? null, note: note ?? null, expiresAt,
      });
      await this.scheduleExpiryAlarm();
      return { ok: true, key: task.key, to: { id: target.id, name: target.name }, expiresAt, ttlSeconds: ttl };
    });
  }

  /** Re-home a task into another project (PLNR-136) — same row, new key, so comments,
   *  attachments, refs and history all ride along (they hang off the task id).
   *
   *  Runs in the SOURCE room: the contended object is the task and its claims, and both
   *  live here. The only target-side writes are the key allocation — a single
   *  UPDATE…RETURNING, atomic against the target room's own createTask — and tag rows
   *  (created silently: their tag.created event belongs to the target's seq, which only
   *  the target DO may write; the arrival event goes through noteTaskArrival instead).
   *
   *  What the move severs, by design: dependency edges (both directions — cross-project
   *  edges are not a thing), plan phase membership, milestone, board (target default),
   *  parent. Tag NAMES carry over and re-resolve in the target. Refused while claimed
   *  or with children — release/detach first, so nothing moves under a working agent. */
  async moveTask(projectId: string, actor: Actor, taskId: string, toProjectId: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = await this.getTask(taskId);
      if (toProjectId === projectId) throw new Error(`${task.key} is already in that project`);
      if (task.claimed_by) throw new Error(`${task.key} is held by an agent — release it before moving`);
      const kids = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?')
        .bind(task.id).first<{ n: number }>();
      if (kids!.n > 0) throw new Error(`${task.key} has ${kids!.n} subtask(s) — move or detach them first`);
      const target = await this.env.DB.prepare('SELECT key, status FROM projects WHERE id = ?')
        .bind(toProjectId).first<{ key: string; status: string }>();
      if (!target || target.status !== 'active') throw new Error('target project not found or not active');

      const { results: tagRows } = await this.env.DB.prepare(
        'SELECT g.name FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = ?',
      ).bind(task.id).all<{ name: string }>();
      const { n: depCount } = (await this.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM dependencies WHERE task_id = ? OR depends_on_task_id = ?',
      ).bind(task.id, task.id).first<{ n: number }>())!;
      // Doc links are project-local (docs live in the source project) — severed like deps.
      const { n: docLinkCount } = (await this.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM task_docs WHERE task_id = ?',
      ).bind(task.id).first<{ n: number }>())!;

      const alloc = await this.env.DB.prepare(
        'UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = ? RETURNING next_task_number AS next',
      ).bind(toProjectId).first<{ next: number }>();
      const num = alloc!.next - 1;
      const newKey = `${target.key}-${num}`;
      const boardId = await this.defaultBoardId(toProjectId);

      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM dependencies WHERE task_id = ? OR depends_on_task_id = ?').bind(task.id, task.id),
        this.env.DB.prepare('DELETE FROM phase_tasks WHERE task_id = ?').bind(task.id),
        this.env.DB.prepare('DELETE FROM task_tags WHERE task_id = ?').bind(task.id),
        this.env.DB.prepare('DELETE FROM task_docs WHERE task_id = ?').bind(task.id),
        this.env.DB.prepare(
          'UPDATE tasks SET project_id = ?, key = ?, milestone_id = NULL, board_id = ?, parent_task_id = NULL, "order" = ?, updated_at = ? WHERE id = ?',
        ).bind(toProjectId, newKey, boardId, num, nowIso(), task.id),
      ]);

      // Re-tag by name in the target. Tag creation is deliberately event-silent here (see doc).
      const retagged: string[] = [];
      for (const { name } of tagRows) {
        const trimmed = name.trim().toLowerCase();
        if (!trimmed) continue;
        let tag = await this.env.DB.prepare('SELECT id FROM tags WHERE project_id = ? AND name = ?')
          .bind(toProjectId, trimmed).first<{ id: string }>();
        if (!tag) {
          const tid = newId('tag');
          const count = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM tags WHERE project_id = ?')
            .bind(toProjectId).first<{ n: number }>();
          const palette = ['#4c9dff', '#b57bff', '#3fd98b', '#f5a623', '#ff8a8a', '#c6f24e', '#8a95a3'];
          await this.env.DB.prepare('INSERT INTO tags (id, project_id, name, color, "order", created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(tid, toProjectId, trimmed, palette[(count?.n ?? 0) % palette.length]!, count?.n ?? 0, nowIso()).run();
          tag = { id: tid };
        }
        await this.env.DB.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').bind(task.id, tag.id).run();
        retagged.push(trimmed);
      }

      await this.emit(actor, 'task.moved', 'task', task.id, {
        key: task.key, toKey: newKey, toProjectId, title: task.title, droppedDependencies: depCount,
      });
      this.reindexSearch('task', task.id); // metadata.projectId changed with the move
      return { ok: true, fromKey: task.key, key: newKey, projectId: toProjectId, droppedDependencies: depCount, droppedDocLinks: docLinkCount, tags: retagged };
    });
  }

  /** The arrival half of moveTask's event story — called on the TARGET room so the
   *  event takes the target's own serialized seq. Advisory: the move already happened. */
  async noteTaskArrival(projectId: string, actor: Actor, taskId: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const task = await this.getTask(taskId);
      await this.emit(actor, 'task.moved_in', 'task', task.id, { key: task.key, title: task.title });
      return { ok: true };
    });
  }

  /** Normalize a folder path (PLNR-188): trim segments, drop empties, join with '/'.
   *  '' = root. Purely organizational — nothing addresses a doc by folder. */
  private static normalizeFolder(folder: string): string {
    return folder.split('/').map((s) => s.trim()).filter(Boolean).join('/');
  }

  /** Replace a doc's tag set (PLNR-188) — same vocabulary as task tags (resolveTag
   *  auto-creates), so one set of words filters both tasks and docs. */
  private async setDocTags(projectId: string, actor: Actor, docId: string, names: string[], allowNew = false) {
    const ids: string[] = [];
    for (const n of names) {
      if (n.trim()) ids.push(await this.resolveTag(projectId, actor, n, allowNew));
    }
    const stmts = [this.env.DB.prepare('DELETE FROM doc_tags WHERE doc_id = ?').bind(docId)];
    for (const tid of ids) {
      stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO doc_tags (doc_id, tag_id) VALUES (?, ?)').bind(docId, tid));
    }
    await this.env.DB.batch(stmts);
  }

  /** Project docs (PLNR-158) — freeform markdown reference material. Writes go through
   *  the DO like every other mutation (evented + WS fanout); reads are direct D1. */
  async createDoc(projectId: string, actor: Actor, input: { name: string; description?: string; body?: string; folder?: string; tags?: string[]; allowNewTags?: boolean }) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      requireDecisionOnlyDoc(input.body); // PLNR-183: docs state decisions, not questions
      const id = newId('doc');
      await this.env.DB.prepare(
        'INSERT INTO docs (id, project_id, name, description, body, folder, author_kind, author_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, this.projectId, input.name, input.description ?? '', input.body ?? '',
        ProjectRoom.normalizeFolder(input.folder ?? ''), actor.kind, actor.name).run();
      if (input.tags?.length) await this.setDocTags(projectId, actor, id, input.tags, input.allowNewTags);
      await this.emit(actor, 'doc.created', 'doc', id, { name: input.name });
      this.reindexSearch('doc', id);
      return { id, name: input.name };
    });
  }

  async updateDoc(
    projectId: string, actor: Actor, docId: string,
    patch: { name?: string; description?: string; body?: string; folder?: string; tags?: string[]; addTags?: string[]; removeTags?: string[]; allowNewTags?: boolean },
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const doc = await this.env.DB.prepare('SELECT id, name FROM docs WHERE id = ? AND project_id = ?')
        .bind(docId, this.projectId).first<{ id: string; name: string }>();
      if (!doc) throw new Error('doc not found in this project');
      requireDecisionOnlyDoc(patch.body); // PLNR-183: docs state decisions, not questions
      let touched = false;
      // Tag edits (PLNR-188), mirroring the task patterns: `tags` replaces; add/remove edit.
      if (patch.tags !== undefined) {
        await this.setDocTags(projectId, actor, docId, patch.tags, patch.allowNewTags);
        touched = true;
      } else if (patch.addTags?.length || patch.removeTags?.length) {
        const stmts = [];
        for (const n of patch.addTags ?? []) {
          if (!n.trim()) continue;
          const tid = await this.resolveTag(projectId, actor, n, patch.allowNewTags);
          stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO doc_tags (doc_id, tag_id) VALUES (?, ?)').bind(docId, tid));
        }
        for (const n of patch.removeTags ?? []) {
          const trimmed = n.trim().toLowerCase();
          if (!trimmed) continue;
          stmts.push(this.env.DB.prepare(
            'DELETE FROM doc_tags WHERE doc_id = ? AND tag_id IN (SELECT id FROM tags WHERE project_id = ? AND name = ?)',
          ).bind(docId, this.projectId, trimmed));
        }
        if (stmts.length) { await this.env.DB.batch(stmts); touched = true; }
      }
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.name !== undefined) { sets.push('name = ?'); binds.push(patch.name); }
      if (patch.description !== undefined) { sets.push('description = ?'); binds.push(patch.description); }
      if (patch.body !== undefined) { sets.push('body = ?'); binds.push(patch.body); }
      if (patch.folder !== undefined) { sets.push('folder = ?'); binds.push(ProjectRoom.normalizeFolder(patch.folder)); }
      if (!sets.length) {
        if (!touched) return { ok: true };
        await this.emit(actor, 'doc.updated', 'doc', docId, { name: doc.name, fields: ['tags'] });
        this.reindexSearch('doc', docId);
        return { ok: true };
      }
      sets.push('updated_at = ?');
      binds.push(nowIso(), docId);
      await this.env.DB.prepare(`UPDATE docs SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      await this.emit(actor, 'doc.updated', 'doc', docId, { name: patch.name ?? doc.name, fields: Object.keys(patch) });
      this.reindexSearch('doc', docId);
      return { ok: true };
    });
  }

  /** Human-only surface (REST) — content deletion stays out of the MCP toolset. */
  async deleteDoc(projectId: string, actor: Actor, docId: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const doc = await this.env.DB.prepare('SELECT id, name FROM docs WHERE id = ? AND project_id = ?')
        .bind(docId, this.projectId).first<{ id: string; name: string }>();
      if (!doc) throw new Error('doc not found in this project');
      await this.env.DB.batch([
        this.env.DB.prepare('DELETE FROM task_docs WHERE doc_id = ?').bind(docId),
        this.env.DB.prepare('DELETE FROM doc_tags WHERE doc_id = ?').bind(docId),
        this.env.DB.prepare('DELETE FROM docs WHERE id = ?').bind(docId),
      ]);
      await this.emit(actor, 'doc.deleted', 'doc', docId, { name: doc.name });
      this.dropSearch('doc', docId);
      return { ok: true };
    });
  }

  /** Archive / restore a plan (PLNR-148) — display-only, mirroring task archive:
   *  everything (phases, membership, minted edges, gating) stays in force; the default
   *  Plans listing just hides it. Restore brings it back. */
  async setPlanArchived(projectId: string, actor: Actor, planId: string, archived: boolean) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const plan = await this.env.DB.prepare('SELECT id, title FROM plans WHERE id = ? AND project_id = ?')
        .bind(planId, projectId).first<{ id: string; title: string }>();
      if (!plan) throw new Error('plan not found');
      await this.env.DB.prepare('UPDATE plans SET archived_at = ? WHERE id = ?')
        .bind(archived ? nowIso() : null, planId).run();
      await this.emit(actor, archived ? 'plan.archived' : 'plan.restored', 'plan', planId, { title: plan.title });
      return { ok: true, archived };
    });
  }

  /** Delete a plan + its phases/phase-links, including the dependency edges it minted
   *  to enforce phase order (PLNR-153) — a deleted plan must not leave tasks blocked by
   *  debris nothing explains. Manual (NULL-provenance) edges survive; the underlying
   *  tasks survive. */
  async deletePlan(projectId: string, actor: Actor, planId: string)  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const plan = await this.env.DB.prepare('SELECT id, title FROM plans WHERE id = ? AND project_id = ?')
        .bind(planId, this.projectId).first<{ id: string; title: string }>();
      if (!plan) throw new Error('plan not found');
      await this.env.DB.batch([
        // Gate rows before phases — the subselect needs the phases still present.
        this.env.DB.prepare('DELETE FROM phase_gates WHERE phase_id IN (SELECT id FROM phases WHERE plan_id = ?)').bind(planId),
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
        this.env.DB.prepare('DELETE FROM task_docs WHERE task_id = ?').bind(id),
        this.env.DB.prepare('DELETE FROM attachments WHERE task_id = ?').bind(id),
        this.env.DB.prepare('DELETE FROM signals WHERE task_id = ?').bind(id),
        this.env.DB.prepare('UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?').bind(id),
        this.env.DB.prepare('UPDATE messages SET ref_task_id = NULL WHERE ref_task_id = ?').bind(id),
        this.env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id),
      ]);
      await this.emit(actor, 'task.deleted', 'task', id, { key: task.key, title: task.title });
      this.dropSearch('task', id);
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
      // R2: every attachment on any task in the project. Snapshot the keys now, but delete
      // the blobs only AFTER the D1 batch commits (PLNR-108): the batch is atomic, so a
      // FK abort rolls it back — deleting blobs first would strand a live project whose
      // attachment rows point at bytes that no longer exist.
      let r2Keys: string[] = [];
      if (this.env.FILES) {
        const { results } = await this.env.DB.prepare('SELECT a.r2_key AS key FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?').bind(pid).all<{ key: string }>();
        r2Keys = results.map((r) => r.key);
      }
      // Snapshot the searchable ids before the rows go — their vectors are dropped after.
      const [vecTasks, vecDocs, vecPlans] = await Promise.all([
        this.env.DB.prepare('SELECT id FROM tasks WHERE project_id = ?').bind(pid).all<{ id: string }>(),
        this.env.DB.prepare('SELECT id FROM docs WHERE project_id = ?').bind(pid).all<{ id: string }>(),
        this.env.DB.prepare('SELECT id FROM plans WHERE project_id = ?').bind(pid).all<{ id: string }>(),
      ]);
      const tasksSub = 'SELECT id FROM tasks WHERE project_id = ?';
      await this.env.DB.batch([
        this.env.DB.prepare(`DELETE FROM phase_tasks WHERE task_id IN (${tasksSub}) OR phase_id IN (SELECT id FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?))`).bind(pid, pid),
        this.env.DB.prepare(`DELETE FROM dependencies WHERE task_id IN (${tasksSub}) OR depends_on_task_id IN (${tasksSub})`).bind(pid, pid),
        this.env.DB.prepare(`DELETE FROM claims WHERE task_id IN (${tasksSub})`).bind(pid),
        this.env.DB.prepare(`DELETE FROM task_refs WHERE task_id IN (${tasksSub})`).bind(pid),
        this.env.DB.prepare(`DELETE FROM task_tags WHERE task_id IN (${tasksSub}) OR tag_id IN (SELECT id FROM tags WHERE project_id = ?)`).bind(pid, pid),
        this.env.DB.prepare(`DELETE FROM task_docs WHERE task_id IN (${tasksSub}) OR doc_id IN (SELECT id FROM docs WHERE project_id = ?)`).bind(pid, pid),
        this.env.DB.prepare('DELETE FROM doc_tags WHERE doc_id IN (SELECT id FROM docs WHERE project_id = ?)').bind(pid),
        this.env.DB.prepare(`DELETE FROM comments WHERE task_id IN (${tasksSub})`).bind(pid),
        this.env.DB.prepare(`DELETE FROM attachments WHERE task_id IN (${tasksSub})`).bind(pid),
        this.env.DB.prepare('DELETE FROM signals WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM messages WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM events WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM phase_gates WHERE phase_id IN (SELECT id FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?))').bind(pid),
        this.env.DB.prepare('DELETE FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)').bind(pid),
        this.env.DB.prepare('DELETE FROM plans WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM docs WHERE project_id = ?').bind(pid),
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
        // Tags go AFTER tasks (PLNR-108): the legacy tasks.category_id column still holds a
        // FK to tags(id) on old data, so dropping tags while tasks exist FK-aborts the batch.
        this.env.DB.prepare('DELETE FROM tags WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM milestones WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM boards WHERE project_id = ?').bind(pid),
        this.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(pid),
      ]);
      // Batch committed — now the attachment rows are gone, so it is safe to drop their blobs.
      if (this.env.FILES) for (const key of r2Keys) await this.env.FILES.delete(key).catch(() => {});
      await this.ctx.storage.deleteAlarm().catch(() => {});
      this.dropSearch('task', ...vecTasks.results.map((r) => r.id));
      this.dropSearch('doc', ...vecDocs.results.map((r) => r.id));
      this.dropSearch('plan', ...vecPlans.results.map((r) => r.id));
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
      // VERIFY only: the build run this one judges — the daemon branches its worktree
      // from that run, so the diff under review is actually present.
      verifiesRunId: r.verifies_run_id,
      // The plan this run serves (RUN-28) — the daemon uses it for the per-plan working branch.
      planKey: r.plan_key,
      targetBranch: r.target_branch,
      brief: r.brief,
      repoRef: r.repo_ref,
      agentTool: r.agent_tool,
      model: r.model,
      effort: r.effort,
      budget: JSON.parse(r.budget || '{}'),
      status: r.status,
      // Sub-state of running (RUN-31): 'verifying'/'landing' are the ~60–90s in which the
      // dashboard used to show a blanket "running" with the spend frozen — a gate at work
      // is indistinguishable from a hung agent unless it says so.
      phase: r.phase as RunPhase | null,
      exit: r.exit ? JSON.parse(r.exit) : null,
      worktreePath: r.worktree_path,
      tokensUsed: r.tokens_used,
      usdSpent: r.usd_spent,
      logTail: r.log_tail,
      modelUsage: r.model_usage ? JSON.parse(r.model_usage) : null,
      planDispatchId: r.plan_dispatch_id,
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
      return this.insertRun(actor, input);
    });
  }

  /** The unwrapped create: shared by createRun and the plan-dispatch pump (PLNR-170), which is
   *  already inside blockConcurrencyWhile and inserts several runs in one serialized breath. */
  private async insertRun(actor: Actor, input: CreateRunInput): Promise<RunView> {
    // Validate against the shared contract; the DB CHECKs are the backstop.
    RunKind.parse(input.kind);
    AgentTool.parse(input.agentTool);
    const id = newId('run');
    const now = nowIso();
    const anchorType = input.anchor?.type ?? null;
    const anchorId = input.anchor?.id ?? null;
    const runnerId = input.runnerId ?? null;
    const status = runnerId ? 'dispatched' : 'queued';
    // Only a verify run judges another run; carrying it elsewhere would be meaningless.
    const verifiesRunId = input.kind === 'verify' ? (input.verifiesRunId ?? null) : null;
    // Which plan does this run serve? (RUN-28) Resolved HERE because the daemon cannot: a
    // plan-anchored run names its plan, but a task-anchored one only knows its task, and the
    // task's plan membership is phase_tasks — server-side, and invisible to the runner.
    // Stored rather than re-derived at landing time: a task can be re-parented and a plan
    // deleted, but the branch a run landed on is a historical fact, not a live lookup.
    const plan = await this.resolveRunPlan(anchorType, anchorId);
    await this.env.DB.prepare(
      `INSERT INTO runs (id, project_id, runner_id, kind, anchor_type, anchor_id, verifies_run_id,
                         plan_id, plan_key, target_branch, brief, repo_ref, agent_tool, model, effort,
                         budget, status, plan_dispatch_id, created_by, created_at, updated_at, dispatched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, this.projectId, runnerId, input.kind, anchorType, anchorId, verifiesRunId,
      plan?.id ?? null, plan ? this.planKey(plan) : null, input.targetBranch ?? null,
      input.brief ?? '', input.repoRef,
      input.agentTool, input.model ?? null, input.effort ?? null,
      JSON.stringify(input.budget ?? {}), status, input.planDispatchId ?? null,
      input.createdBy ?? actor.id, now, now,
      runnerId ? now : null,
    ).run();
    await this.emit(actor, 'run.created', 'run', id, {
      kind: input.kind, agentTool: input.agentTool, repoRef: input.repoRef, anchor: anchorType,
    });
    if (runnerId) await this.emit(actor, 'run.dispatched', 'run', id, { runnerId, to: 'dispatched' });
    return this.runToWire(await this.loadRun(id));
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

  /**
   * Re-open a FAILED build run for another sitting — "continue a failed run" (PLNR-180).
   *
   * A gate-failed build is terminal today (`RUN_TRANSITIONS.failed = []`) even though the daemon
   * KEEPS its worktree: the branch, the diff, and the last reviewer report are all still on the
   * runner's disk. Continue hands the SAME run id back to the SAME runner (the worktree is
   * machine-local) with a fresh reviewer-round budget, instead of forking history into a new run —
   * telemetry (`model_usage`), the transcript (RUN-74), and adjudication continuity are all keyed
   * on the id. This is the inverse of `settleAnchorTask(…, 'failed')`: it clears the run's terminal
   * state (`exit`/`phase` → null, status → dispatched) AND the anchor task's `failed_at`, re-arming
   * the task to a claimable `todo` so the fresh builder session re-claims it — one serialized DO
   * breath, so the board and the run never disagree.
   *
   * Deliberately NOT `transitionRun`: that path owns terminal semantics (synthesizes `exit`,
   * retires the agent) and its map forbids failed → dispatched. Re-opening is a distinct,
   * server-initiated move, like `dispatchRun`. The daemon learns "this is a continuation, re-lease
   * the kept worktree" from the run id's on-disk worktree (RUN-91), not a wire flag — which is what
   * lets it survive a daemon restart between the fail and the continue. The only datum the wire
   * carries is `budget.maxRounds`, folded into the persisted budget JSON so a RunnerHub redelivery
   * (which rebuilds `run.assigned` from the row) carries it too; `null` ⇒ the manifest default.
   */
  async reopenRun(projectId: string, actor: Actor, runId: string, rounds: number | null): Promise<RunView> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const run = await this.loadRun(runId);
      if (run.status !== 'failed') throw new Error(`only a failed run can be continued (this one is ${run.status})`);
      if (run.kind !== 'build') throw new Error('only a build run keeps a worktree to continue');
      if (!run.runner_id) throw new Error('run has no runner — nothing holds its worktree');
      // The kept worktree is machine-local: continue MUST go back to the same runner, and only if
      // it is still online and still advertises the repo — otherwise the worktree is unreachable.
      const runner = await this.env.DB.prepare('SELECT status, repos FROM runners WHERE id = ?')
        .bind(run.runner_id).first<{ status: string; repos: string }>();
      if (!runner || runner.status !== 'online') {
        throw new Error("the run's runner is offline — bring it online to continue");
      }
      let advertises = false;
      try {
        advertises = (JSON.parse(runner.repos || '[]') as Array<{ id: string }>).some((r) => r.id === run.repo_ref);
      } catch { /* malformed repos JSON → treat as not advertised */ }
      if (!advertises) throw new Error("the run's runner no longer advertises this repo — its worktree is unreachable");

      const now = nowIso();
      // Fold the round budget into the persisted budget JSON: RunnerHub redelivers a `dispatched`
      // run as a plain run.assigned built from the row (RunnerHub.ts hello handler), so the datum
      // has to live ON the run, not in the one-shot frame we push below.
      const budget = { ...(JSON.parse(run.budget || '{}') as Record<string, unknown>), maxRounds: rounds };
      await this.env.DB.prepare(
        "UPDATE runs SET status = 'dispatched', exit = NULL, phase = NULL, budget = ?, dispatched_at = ?, updated_at = ? WHERE id = ?",
      ).bind(JSON.stringify(budget), now, now, runId).run();
      await this.emit(actor, 'run.status_changed', 'run', runId, { from: 'failed', to: 'dispatched', reason: 'continue', maxRounds: rounds });

      // Re-arm the anchor task — the inverse of the failed settle. Clear `failed_at` and hand it
      // back as a claimable `todo` (claim cleared) so the fresh builder session re-claims it; the
      // board stops reading `failed` the instant the run re-dispatches. Guarded to `failed_at IS
      // NOT NULL` so a human who already accepted/moved the task first is never stomped.
      if (run.anchor_type === 'task' && run.anchor_id) {
        const { meta } = await this.env.DB.prepare(
          "UPDATE tasks SET status = 'todo', failed_at = NULL, claimed_by = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ? AND failed_at IS NOT NULL",
        ).bind(now, run.anchor_id).run();
        if (meta.changes) {
          const t = await this.env.DB.prepare('SELECT key, title FROM tasks WHERE id = ?')
            .bind(run.anchor_id).first<{ key: string; title: string }>();
          await this.emit(actor, 'task.status_changed', 'task', run.anchor_id, {
            key: t?.key, from: 'failed', to: 'todo', title: t?.title, reason: 'run_continued',
          });
        }
      }
      return this.runToWire(await this.loadRun(runId));
    });
  }

  // ---------------------------------------------------------------------------
  // Plan dispatch (PLNR-170) — dispatch a whole plan; a pump fans out the runs.
  //
  // No scheduler object exists: the plan_dispatches row is the record, and the pump
  // RE-DERIVES the ready set from the task/dependency/run tables on every unblocking
  // event — a run reaching terminal, a task reaching done/cancelled, a runner
  // heartbeat, an explicit retry. Record + re-derivation is what survives deploys,
  // DO evictions, and the runner being off (the lesson plan_landings already taught;
  // a queue in memory re-ships the fire-and-forget bug a third time).
  // ---------------------------------------------------------------------------

  async createPlanDispatch(
    projectId: string,
    actor: Actor,
    input: CreatePlanDispatchInput,
  ): Promise<PlanDispatchView> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      AgentTool.parse(input.agentTool);
      const plan = await this.env.DB.prepare(
        'SELECT id, title, status FROM plans WHERE id = ? AND project_id = ?',
      ).bind(input.planId, projectId).first<{ id: string; title: string; status: string }>();
      if (!plan) throw new Error('plan not found');
      // The RUN-23 gate holds here too: a proposed plan's tasks are not real work yet.
      if (plan.status === 'proposed') throw new Error('plan is proposed — approve it before dispatching');
      // One live dispatch per plan: two pumps would race each other to the same ready tasks,
      // and "which runner is working my plan" should have one answer.
      const existing = await this.env.DB.prepare(
        "SELECT id FROM plan_dispatches WHERE plan_id = ? AND status IN ('active','stalled')",
      ).bind(input.planId).first();
      if (existing) throw new Error('this plan already has a live dispatch — cancel it first');
      const open = await this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM phase_tasks pt
           JOIN phases ph ON ph.id = pt.phase_id
           JOIN tasks t ON t.id = pt.task_id
         WHERE ph.plan_id = ? AND t.status NOT IN ('done','cancelled')`,
      ).bind(input.planId).first<{ n: number }>();
      if (!open?.n) throw new Error('plan has no open tasks — nothing to dispatch');

      const id = newId('pld');
      const now = nowIso();
      await this.env.DB.prepare(
        `INSERT INTO plan_dispatches (id, project_id, plan_id, runner_id, repo_ref, agent_tool,
                                      model, effort, budget, gate, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).bind(
        id, projectId, input.planId, input.runnerId, input.repoRef, input.agentTool,
        input.model ?? null, input.effort ?? null, JSON.stringify(input.budget ?? {}),
        input.gate ?? 'approved', input.createdBy ?? actor.id, now, now,
      ).run();
      await this.emit(actor, 'plan_dispatch.created', 'plan_dispatch', id, {
        planId: plan.id, planTitle: plan.title, runnerId: input.runnerId, gate: input.gate ?? 'approved',
        openTasks: open.n,
      });
      await this.pumpPlanDispatch(await this.loadPlanDispatch(id), actor);
      return this.planDispatchToWire(await this.loadPlanDispatch(id));
    });
  }

  /** Halt the pump and kill this dispatch's live runs. Idempotent on a finished dispatch. */
  async cancelPlanDispatch(
    projectId: string,
    actor: Actor,
    dispatchId: string,
    reason?: string | null,
  ): Promise<{ ok: boolean; cancelledRuns: number }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const d = await this.loadPlanDispatch(dispatchId);
      if (d.status === 'completed' || d.status === 'cancelled') return { ok: true, cancelledRuns: 0 };
      const { results: live } = await this.env.DB.prepare(
        `SELECT * FROM runs WHERE plan_dispatch_id = ? AND status IN ('queued','dispatched','running','blocked')`,
      ).bind(dispatchId).all<RunRow>();
      const why = reason ?? 'plan dispatch cancelled';
      for (const run of live) await this.cancelRunInner(run, actor, why);
      const now = nowIso();
      await this.env.DB.prepare(
        "UPDATE plan_dispatches SET status = 'cancelled', stall_reason = NULL, finished_at = ?, updated_at = ? WHERE id = ?",
      ).bind(now, now, dispatchId).run();
      await this.emit(actor, 'plan_dispatch.cancelled', 'plan_dispatch', dispatchId, {
        planId: d.plan_id, cancelledRuns: live.length, reason: reason ?? null,
      });
      // Best-effort fast path; the daemon also fails these runs itself on its next reconcile.
      for (const run of live) {
        if (!run.runner_id) continue;
        try {
          await this.env.RUNNER_HUB.get(this.env.RUNNER_HUB.idFromName(run.runner_id))
            .deliver(JSON.stringify({ type: 'run.cancel', runId: run.id, hard: true, reason: why }));
        } catch { /* socket gone — reconcile covers it */ }
      }
      return { ok: true, cancelledRuns: live.length };
    });
  }

  /** Re-arm tasks whose only attempts failed (or were cancelled) and pump again. The pump
   *  itself never retries — a failed agent run is a human's judgment call, this endpoint. */
  async retryPlanDispatch(projectId: string, actor: Actor, dispatchId: string): Promise<{ created: number }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const d = await this.loadPlanDispatch(dispatchId);
      if (d.status === 'completed' || d.status === 'cancelled') {
        throw new Error(`dispatch is ${d.status} — nothing to retry`);
      }
      return this.pumpPlanDispatch(d, actor, { retry: true });
    });
  }

  /** RunnerHub's heartbeat nudge (and any other cross-project wake): pump every live
   *  dispatch in this project. Slots on a shared runner can free from ANOTHER project's
   *  runs, which this room never hears about — the periodic heartbeat is the reconcile. */
  async pumpProjectDispatches(projectId: string): Promise<{ created: number }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      return this.pumpLiveDispatches({ kind: 'system', id: 'system', name: 'plan-dispatch' });
    });
  }

  async listPlanDispatches(projectId: string, planId?: string | null): Promise<{ dispatches: PlanDispatchView[] }> {
    await this.setPid(projectId);
    const { results } = planId
      ? await this.env.DB.prepare(
          'SELECT * FROM plan_dispatches WHERE project_id = ? AND plan_id = ? ORDER BY created_at DESC LIMIT 50',
        ).bind(projectId, planId).all<PlanDispatchRow>()
      : await this.env.DB.prepare(
          'SELECT * FROM plan_dispatches WHERE project_id = ? ORDER BY created_at DESC LIMIT 50',
        ).bind(projectId).all<PlanDispatchRow>();
    const dispatches: PlanDispatchView[] = [];
    for (const row of results) dispatches.push(await this.planDispatchToWire(row));
    return { dispatches };
  }

  /** Pump every live dispatch in this project. Callers are already inside
   *  blockConcurrencyWhile. Never throws: scheduling must not reject the daemon's
   *  status report (or a task release) that happened to trigger it. */
  private async pumpLiveDispatches(actor: Actor): Promise<{ created: number }> {
    let created = 0;
    try {
      const { results } = await this.env.DB.prepare(
        "SELECT * FROM plan_dispatches WHERE project_id = ? AND status IN ('active','stalled')",
      ).bind(this.projectId).all<PlanDispatchRow>();
      for (const d of results) {
        try {
          created += (await this.pumpPlanDispatch(d, actor)).created;
        } catch (err) {
          console.warn(`plan dispatch ${d.id} pump failed: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`plan dispatch sweep failed: ${String(err)}`);
    }
    return { created };
  }

  /**
   * The scheduler. Recomputes the plan's READY set and turns it into task-anchored build
   * runs, up to the runner's advertised concurrency.
   *
   * Ready = todo, unclaimed, every dependency satisfied, not already being run by anyone,
   * and not already attempted by this dispatch (one attempt per task — see retry).
   *
   * Dependency satisfaction is where the gate lives. gate='landed' counts a dependency in
   * REVIEW as satisfied iff a run anchored to it reached `done` — the verify gate passed and
   * the code is on the plan's working branch, so the material dependency exists; only the
   * human's sign-off is pending, and making dependents wait on that puts a person back in the
   * middle of the pipeline as a synchronous lock (the exact thing autoPush/RUN-27 moved).
   * gate='approved' keeps the strict rule: only done/cancelled satisfies.
   *
   * Capacity comes from the runs table (dispatched|running on that runner), NOT the
   * heartbeat's free_slots — that number is seconds stale, and nothing else server-side
   * prevents over-dispatch between heartbeats. `blocked` runs are excluded on purpose: a
   * parked agent's process is gone and its daemon slot is free (RUN-30); its resume takes a
   * slot like any new run, which this same arithmetic then counts.
   */
  private async pumpPlanDispatch(
    d: PlanDispatchRow,
    actor: Actor,
    opts: { retry?: boolean } = {},
  ): Promise<{ created: number }> {
    if (d.status !== 'active' && d.status !== 'stalled') return { created: 0 };

    const open = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM phase_tasks pt
         JOIN phases ph ON ph.id = pt.phase_id
         JOIN tasks t ON t.id = pt.task_id
       WHERE ph.plan_id = ? AND t.status NOT IN ('done','cancelled')`,
    ).bind(d.plan_id).first<{ n: number }>();
    if (!open?.n) {
      const now = nowIso();
      await this.env.DB.prepare(
        "UPDATE plan_dispatches SET status = 'completed', stall_reason = NULL, finished_at = ?, updated_at = ? WHERE id = ?",
      ).bind(now, now, d.id).run();
      await this.emit(actor, 'plan_dispatch.completed', 'plan_dispatch', d.id, { planId: d.plan_id });
      return { created: 0 };
    }

    // A blocker (manual dependency edge, or any task in an earlier phase of this plan —
    // PLNR-163) BLOCKS unless done/cancelled — or, under gate='landed', unless it is in
    // review with a landed run. SQL is composed from a fixed pair of literals, never input.
    const landedException = d.gate === 'landed'
      ? `AND NOT (dt.status = 'review' AND EXISTS (
           SELECT 1 FROM runs dr
           WHERE dr.anchor_type = 'task' AND dr.anchor_id = dt.id AND dr.status = 'done'))`
      : '';
    // One attempt per task per dispatch; retry re-arms tasks whose attempts all ended
    // failed/cancelled (which includes an agent that punted the task back to todo).
    const attempted = opts.retry
      ? `AND ar.status NOT IN ('failed','cancelled')`
      : '';
    const { results: ready } = await this.env.DB.prepare(
      `SELECT t.id FROM phase_tasks pt
         JOIN phases ph ON ph.id = pt.phase_id
         JOIN tasks t ON t.id = pt.task_id
       WHERE ph.plan_id = ?1
         AND t.status = 'todo' AND t.claimed_by IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM dependencies dp JOIN tasks dt ON dt.id = dp.depends_on_task_id
           WHERE dp.task_id = t.id AND dt.status NOT IN ('done','cancelled') ${landedException})
         AND NOT EXISTS (
           SELECT 1 FROM phases prev
             JOIN phase_tasks ppt ON ppt.phase_id = prev.id
             JOIN tasks dt ON dt.id = ppt.task_id
           WHERE prev.plan_id = ?1 AND prev."order" < ph."order"
             AND dt.status NOT IN ('done','cancelled') ${landedException})
         AND NOT EXISTS (
           SELECT 1 FROM runs lr WHERE lr.anchor_type = 'task' AND lr.anchor_id = t.id
             AND lr.status IN ('queued','dispatched','running','blocked'))
         AND NOT EXISTS (
           SELECT 1 FROM runs ar WHERE ar.plan_dispatch_id = ?2
             AND ar.anchor_type = 'task' AND ar.anchor_id = t.id ${attempted})
       ORDER BY t.priority DESC, t."order"`,
    ).bind(d.plan_id, d.id).all<{ id: string }>();

    // Capacity: advertised max minus what the runs table says is on the box.
    const runner = await this.env.DB.prepare('SELECT status, capabilities FROM runners WHERE id = ?')
      .bind(d.runner_id).first<{ status: string; capabilities: string }>();
    let slots = 0;
    if (runner && runner.status !== 'offboarded') {
      let maxC = 1;
      try {
        maxC = Number((JSON.parse(runner.capabilities || '{}') as { maxConcurrency?: number }).maxConcurrency ?? 1);
      } catch { /* malformed capabilities → assume 1 */ }
      const busy = await this.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE runner_id = ? AND status IN ('dispatched','running')",
      ).bind(d.runner_id).first<{ n: number }>();
      slots = Math.max(0, maxC - (busy?.n ?? 0));
    }

    let created = 0;
    for (const t of ready.slice(0, slots)) {
      const run = await this.insertRun(actor, {
        kind: 'build',
        anchor: { type: 'task', id: t.id },
        repoRef: d.repo_ref,
        agentTool: d.agent_tool,
        model: d.model,
        effort: d.effort,
        budget: JSON.parse(d.budget || '{}'),
        runnerId: d.runner_id,
        createdBy: d.created_by,
        planDispatchId: d.id,
      });
      created += 1;
      // Fast path only: a frame the socket misses is redelivered on the daemon's next
      // hello (RunnerHub redelivers every dispatched run), and the row is the truth.
      try {
        await this.env.RUNNER_HUB.get(this.env.RUNNER_HUB.idFromName(d.runner_id))
          .deliver(JSON.stringify({ type: 'run.assigned', run }));
      } catch { /* socket gone — hello redelivers */ }
    }

    const liveNow = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE plan_dispatch_id = ?
        AND status IN ('queued','dispatched','running','blocked')`,
    ).bind(d.id).first<{ n: number }>();
    const anyLive = (liveNow?.n ?? 0) > 0;

    if (anyLive || ready.length > created) {
      // Forward progress exists, or work is merely waiting for a slot (capacity frees via a
      // terminal run or the heartbeat nudge — no human is needed). Either way: active.
      if (d.status === 'stalled') {
        await this.env.DB.prepare(
          "UPDATE plan_dispatches SET status = 'active', stall_reason = NULL, updated_at = ? WHERE id = ?",
        ).bind(nowIso(), d.id).run();
        await this.emit(actor, 'plan_dispatch.resumed', 'plan_dispatch', d.id, { planId: d.plan_id });
      }
    } else if (created === 0) {
      // Nothing live, nothing dispatchable, plan still open: the pump cannot advance this
      // without a human. Say why, so the dashboard is actionable rather than just amber.
      const reason = await this.planDispatchStallReason(d);
      if (d.status !== 'stalled') {
        await this.env.DB.prepare(
          "UPDATE plan_dispatches SET status = 'stalled', stall_reason = ?, updated_at = ? WHERE id = ?",
        ).bind(reason, nowIso(), d.id).run();
        await this.emit(actor, 'plan_dispatch.stalled', 'plan_dispatch', d.id, { planId: d.plan_id, reason });
      } else if (d.stall_reason !== reason) {
        await this.env.DB.prepare('UPDATE plan_dispatches SET stall_reason = ?, updated_at = ? WHERE id = ?')
          .bind(reason, nowIso(), d.id).run();
      }
    }
    return { created };
  }

  /** Why the pump is stuck, composed for a human. Best-effort taxonomy — the counts answer
   *  "what do I click": retry failed runs, approve reviews, answer a parked question. */
  private async planDispatchStallReason(d: PlanDispatchRow): Promise<string> {
    const reasons: string[] = [];
    const runner = await this.env.DB.prepare('SELECT status FROM runners WHERE id = ?')
      .bind(d.runner_id).first<{ status: string }>();
    if (!runner || runner.status === 'offboarded') reasons.push('the runner is offboarded');
    const counts = await this.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END) AS inReview,
         SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS parked,
         SUM(CASE WHEN t.status = 'todo' AND EXISTS (
           SELECT 1 FROM runs fr WHERE fr.plan_dispatch_id = ?1
             AND fr.anchor_type = 'task' AND fr.anchor_id = t.id
             AND fr.status IN ('failed','cancelled')) THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN t.status IN ('in_progress','claimed') THEN 1 ELSE 0 END) AS held
       FROM phase_tasks pt
         JOIN phases ph ON ph.id = pt.phase_id
         JOIN tasks t ON t.id = pt.task_id
       WHERE ph.plan_id = ?2 AND t.status NOT IN ('done','cancelled')`,
    ).bind(d.id, d.plan_id).first<{ inReview: number | null; parked: number | null; failed: number | null; held: number | null }>();
    if (counts?.failed) reasons.push(`${counts.failed} task(s) failed — retry the dispatch or fix and re-dispatch`);
    if (counts?.inReview) {
      reasons.push(
        d.gate === 'approved'
          ? `${counts.inReview} task(s) awaiting your review (gate=approved holds dependents until you mark them done)`
          : `${counts.inReview} task(s) in review`,
      );
    }
    if (counts?.parked) reasons.push(`${counts.parked} task(s) parked on a question — answer the input request`);
    if (counts?.held) reasons.push(`${counts.held} task(s) held by other agents`);
    return reasons.length ? reasons.join('; ') : 'remaining tasks are dependency-blocked outside this plan';
  }

  /** Cancel one run without the public wrapper (callers hold the lock). Mirrors what
   *  transitionRun does for a terminal 'cancelled' — kept small on purpose; if these drift,
   *  drift shows up as a dispatch-cancelled run that still looks alive. */
  private async cancelRunInner(run: RunRow, actor: Actor, reason: string): Promise<void> {
    if (!RUN_TRANSITIONS[run.status]?.includes('cancelled')) return; // already terminal
    const now = nowIso();
    const exit = JSON.stringify({ outcome: 'cancelled', code: null, signal: null, reason, finishedAt: now });
    await this.env.DB.prepare(
      'UPDATE runs SET status = ?, exit = ?, phase = NULL, updated_at = ? WHERE id = ?',
    ).bind('cancelled', exit, now, run.id).run();
    if (run.agent_id) await this.retireRunAgent(run.agent_id);
    await this.emit(actor, 'run.status_changed', 'run', run.id, { from: run.status, to: 'cancelled', reason });
  }

  private async loadPlanDispatch(id: string): Promise<PlanDispatchRow> {
    const row = await this.env.DB.prepare('SELECT * FROM plan_dispatches WHERE id = ? AND project_id = ?')
      .bind(id, this.projectId).first<PlanDispatchRow>();
    if (!row) throw new Error('plan dispatch not found');
    return row;
  }

  private async planDispatchToWire(row: PlanDispatchRow): Promise<PlanDispatchView> {
    // Every plan task with its LATEST run from this dispatch — the dashboard's progress strip.
    const { results: tasks } = await this.env.DB.prepare(
      `SELECT t.id AS taskId, r.id AS runId, r.status AS runStatus
       FROM phase_tasks pt
         JOIN phases ph ON ph.id = pt.phase_id
         JOIN tasks t ON t.id = pt.task_id
         LEFT JOIN runs r ON r.id = (
           SELECT r2.id FROM runs r2
           WHERE r2.plan_dispatch_id = ?1 AND r2.anchor_type = 'task' AND r2.anchor_id = t.id
           ORDER BY r2.created_at DESC LIMIT 1)
       WHERE ph.plan_id = ?2
       ORDER BY ph."order", t."order"`,
    ).bind(row.id, row.plan_id).all<{ taskId: string; runId: string | null; runStatus: string | null }>();
    return {
      id: row.id,
      projectId: row.project_id,
      planId: row.plan_id,
      runnerId: row.runner_id,
      repoRef: row.repo_ref,
      agentTool: row.agent_tool,
      model: row.model,
      effort: row.effort,
      budget: JSON.parse(row.budget || '{}'),
      gate: row.gate as 'landed' | 'approved',
      status: row.status as PlanDispatchView['status'],
      stallReason: row.stall_reason,
      tasks: tasks.map((t) => ({ taskId: t.taskId, runId: t.runId, runStatus: t.runStatus })),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    };
  }

  /**
   * A branch-safe, readable, stable key for a plan (RUN-28). Plans have no `key` column — only a
   * title, which is neither unique nor immutable — so derive one: a slug of the title for a human
   * reading `git branch`, plus the id suffix so two plans called "Cleanup" never collide and a
   * retitled plan keeps landing on the branch its earlier runs used.
   */
  /** The plan a run serves (RUN-28), from its anchor. A plan anchor names it outright; a task
   *  anchor needs phase_tasks. Null = a one-off dispatch belonging to no plan, which lands on the
   *  literal `[land].branch` with any `<planKey>` stripped. */
  private async resolveRunPlan(
    anchorType: string | null,
    anchorId: string | null,
  ): Promise<{ id: string; title: string } | null> {
    if (!anchorType || !anchorId) return null;
    if (anchorType === 'plan') {
      return this.env.DB.prepare('SELECT id, title FROM plans WHERE id = ?')
        .bind(anchorId).first<{ id: string; title: string }>();
    }
    return this.env.DB.prepare(
      `SELECT pl.id, pl.title FROM phase_tasks pt
         JOIN phases ph ON ph.id = pt.phase_id
         JOIN plans pl ON pl.id = ph.plan_id
       WHERE pt.task_id = ? LIMIT 1`,
    ).bind(anchorId).first<{ id: string; title: string }>();
  }

  private planKey(plan: { id: string; title: string }): string {
    const slug = plan.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
      || 'plan';
    return `${slug}-${plan.id.slice(-6)}`;
  }

  /**
   * Did this task's plan just finish? (RUN-28)
   *
   * Completion is a SERVER fact: the daemon sees Runs, never the plan's task graph. So it is
   * computed here, the moment the last task lands, and RECORDED — the WS push is only the fast
   * path. A plan can complete while no runner is listening (box off, runner offboarded, socket
   * reconnecting), and a fire-and-forget notification would drop the merge request silently and
   * forever. That exact class of bug has shipped here twice already.
   *
   * INSERT OR IGNORE is what makes it fire once: a plan completes a single time, no matter how
   * many tasks are marked done in a batch or how often a runner re-asks.
   */
  private async maybeCompletePlan(taskId: string, actor: Actor): Promise<void> {
    const { results: plans } = await this.env.DB.prepare(
      `SELECT DISTINCT pl.id, pl.title FROM phase_tasks pt
         JOIN phases ph ON ph.id = pt.phase_id
         JOIN plans pl ON pl.id = ph.plan_id
       WHERE pt.task_id = ? AND pl.status != 'proposed'`,
    ).bind(taskId).all<{ id: string; title: string }>();

    for (const plan of plans) {
      // 'cancelled' counts as finished: a plan whose remaining work was explicitly dropped IS
      // done, and refusing to notice would strand its branch with no merge request forever.
      const open = await this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM phase_tasks pt
           JOIN phases ph ON ph.id = pt.phase_id
           JOIN tasks t ON t.id = pt.task_id
         WHERE ph.plan_id = ? AND t.status NOT IN ('done', 'cancelled')`,
      ).bind(plan.id).first<{ n: number }>();
      if (open?.n) continue;

      const rec = await this.env.DB.prepare(
        'INSERT OR IGNORE INTO plan_landings (plan_id, project_id, completed_at) VALUES (?, ?, ?)',
      ).bind(plan.id, this.projectId, nowIso()).run();
      if (!rec.meta.changes) continue; // already recorded — completes once

      const key = this.planKey(plan);
      await this.emit(actor, 'plan.completed', 'plan', plan.id, { title: plan.title, planKey: key });

      // Fast path: tell the runners that actually landed this plan's work. Best-effort by
      // construction — plan_landings is the truth, and a runner that hears nothing reconciles
      // when it reconnects.
      const { results: runners } = await this.env.DB.prepare(
        'SELECT DISTINCT runner_id AS id FROM runs WHERE plan_id = ? AND runner_id IS NOT NULL',
      ).bind(plan.id).all<{ id: string }>();
      const frame = JSON.stringify({
        type: 'plan.completed',
        planId: plan.id,
        planKey: key,
        planTitle: plan.title,
        projectId: this.projectId,
      });
      for (const r of runners) {
        try {
          await this.env.RUNNER_HUB.get(this.env.RUNNER_HUB.idFromName(r.id)).deliver(frame);
        } catch {
          /* socket gone — plan_landings still owes it, and reconnect will ask */
        }
      }
    }
  }

  /** Advance a Run's status (running/blocked/terminal). Enforces the transition map.
   *
   * A SAME-status report is a PATCH, not a transition (RUN-45). The daemon reports
   * `{status:'running', agentId}` right after it creates the run's agent (RUN-43), and the
   * transition map — correctly — has no running→running edge, so for months that frame was
   * rejected here and swallowed by the forwarder: agent_id only survived because a REST call
   * also wrote it, worktreePath was silently dropped, and the next field someone added would
   * have joined it. A patch applies the identifying fields and appends no event: from===to is
   * not a transition, and `exit`/`started_at` stay owned by real transitions.
   */
  async transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const run = await this.loadRun(runId);
      const to = RunStatus.parse(patch.status);
      if (to === run.status) {
        const agentId = patch.agentId !== undefined ? patch.agentId : run.agent_id;
        const worktreePath = patch.worktreePath !== undefined ? patch.worktreePath : run.worktree_path;
        // Phase deliberately untouched: it rides the telemetry frame (RUN-31), and letting the
        // patch lane also write it would recreate the two-writers race that frame exists to avoid.
        await this.env.DB.prepare('UPDATE runs SET agent_id = ?, worktree_path = ?, updated_at = ? WHERE id = ?')
          .bind(agentId, worktreePath, nowIso(), runId).run();
        return this.runToWire(await this.loadRun(runId));
      }
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
      // Phase is a sub-state of `running` (RUN-31), so terminality ends it — a done Run that
      // still reads "verifying" is worse than one that reads nothing. This is the only place
      // it can be cleared: telemetry ticks COALESCE, so the daemon can set a phase but never
      // unset one, and the DO is what actually knows the Run is over.
      const phase = isTerminalRunStatus(to) ? null : (patch.phase ?? run.phase);
      await this.env.DB.prepare(
        `UPDATE runs SET status = ?, agent_id = ?, exit = ?, worktree_path = ?, phase = ?,
                started_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(to, agentId, exitJson, worktreePath, phase, startedAt, now, runId).run();
      if (isTerminalRunStatus(to) && agentId) await this.retireRunAgent(agentId);
      // The RUN's terminal outcome now moves its anchor task — not the agent (RUN-83). The build
      // agent used to release_task(review) when it finished, BEFORE the daemon's verify/reviewer
      // gate ran, so a gate FAILURE stranded the task in `review`. Settle it here instead, before
      // the pump reads task state below.
      if (isTerminalRunStatus(to) && run.kind === 'build' && run.anchor_type === 'task' && run.anchor_id) {
        await this.settleAnchorTask(run.anchor_id, to, now, agentId);
      }
      await this.emit(actor, 'run.status_changed', 'run', runId, { from: run.status, to, reason: patch.reason ?? null });
      // A terminal run is the plan-dispatch pump's main wake-up (PLNR-170): it freed a slot,
      // and if it was `done` it may have landed the dependency some other task waits on.
      // pumpLiveDispatches never throws — scheduling must not reject the daemon's report.
      if (isTerminalRunStatus(to)) await this.pumpLiveDispatches(actor);
      return this.runToWire(await this.loadRun(runId));
    });
  }

  /**
   * A runner-spawned agent lives for exactly one run, so the run ending must end it (RUN-43).
   *
   * Its credential is bound to it and to nothing else, so leaving that token valid would let
   * a dead run's identity keep acting — for the 7-day token TTL — with no process, no
   * supervision, and no budget behind it. Revoking here is what makes "one run, one identity"
   * true rather than aspirational, and it is the same lever RUN-35's kill switch needs.
   *
   * Copilots are untouched: a human's session is not owned by a run and must survive one.
   */
  /**
   * Move a build run's anchor task to match the run's terminal outcome (RUN-83): gate passed
   * (`done`) → `review`; gate failed → `failed`; cancelled → back to the queue.
   *
   * `failed` is a DERIVED wire status: D1 cannot widen tasks.status's CHECK (0049), so a
   * gate-failed task keeps a real status of `todo` — which is what lets the plan-dispatch RETRY
   * path re-arm it — and carries `failed_at`, from which the wire renders `failed`. It is `todo`
   * rather than `in_progress` on purpose: the pump's one-attempt-per-dispatch guard already
   * blocks an AUTO re-dispatch (a failed run exists), so it sits failed until a human retries.
   *
   * Guarded to a task the run still owns (`in_progress`/`claimed`), so a human who moved it first
   * is never stomped. The claim is cleared either way — the run is over.
   */
  private async settleAnchorTask(
    taskId: string,
    outcome: string,
    now: string,
    /** The run's agent, whose claim is released regardless of the status guard (PLNR-192). */
    agentId: string | null,
  ): Promise<void> {
    const owned = "status IN ('in_progress','claimed')";
    const clear = 'claimed_by = NULL, claim_expires_at = NULL';
    if (outcome === 'done') {
      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'review', failed_at = NULL, ${clear}, updated_at = ? WHERE id = ? AND ${owned}`,
      ).bind(now, taskId).run();
    } else if (outcome === 'failed') {
      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'todo', failed_at = ?, ${clear}, updated_at = ? WHERE id = ? AND ${owned}`,
      ).bind(now, now, taskId).run();
    } else {
      // cancelled: hand it back to the queue, cleared of any prior failure.
      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'todo', failed_at = NULL, ${clear}, updated_at = ? WHERE id = ? AND ${owned}`,
      ).bind(now, taskId).run();
    }
    // The run's own claim dies with the run even when the status guard above refused
    // (PLNR-192): the agent is retired and its token revoked, so a claim it still holds can
    // only dangle until the TTL reaper. Scoped to THIS run's agent — a human who restatused
    // the task keeps their status, and a fresh claim someone else took is not this run's to
    // clear.
    if (agentId) {
      await this.env.DB.prepare(
        `UPDATE tasks SET ${clear}, updated_at = ? WHERE id = ? AND claimed_by = ?`,
      ).bind(now, taskId, agentId).run();
      await this.env.DB.prepare(
        'UPDATE claims SET released_at = ? WHERE task_id = ? AND agent_id = ? AND released_at IS NULL',
      ).bind(now, taskId, agentId).run();
    }
  }

  private async retireRunAgent(agentId: string): Promise<void> {
    const agent = await this.env.DB.prepare("SELECT id FROM agents WHERE id = ? AND kind = 'agent'")
      .bind(agentId).first();
    if (!agent) return; // a copilot (legacy runs report one) — not ours to retire
    await this.env.DB.batch([
      this.env.DB.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL')
        .bind(nowIso(), agentId),
      this.env.DB.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").bind(agentId),
    ]);
    // NOTE: a claim the agent still holds is left to the TTL reaper (alarm()), as before —
    // it cannot release itself now that its token is dead. That is unchanged behaviour for a
    // process that died mid-claim, but it is the reason RUN-30 (pause/resume) and the claim
    // sweep matter more once identities are this short-lived.
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
    t: {
      tokensUsed?: number | null; usdSpent?: number | null; logTail?: string | null; phase?: RunPhase | null;
      modelUsage?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await this.setPid(projectId);
    // COALESCE, not a plain bind: null on this frame means "no news", never "set it back to
    // nothing". Ticks are partial by nature — the verify phase knows the phase but has no
    // spend to report, and a spend tick mid-run carries no log tail. Binding null directly
    // (as this did) let each such tick wipe the fields it happened not to carry, which is
    // how the live log tail could blank itself between two token updates.
    await this.env.DB.prepare(
      `UPDATE runs SET tokens_used = COALESCE(?, tokens_used), usd_spent = COALESCE(?, usd_spent),
              log_tail = COALESCE(?, log_tail), phase = COALESCE(?, phase)
        WHERE id = ? AND project_id = ?`,
    ).bind(t.tokensUsed ?? null, t.usdSpent ?? null, t.logTail ?? null, t.phase ?? null, runId, projectId).run();
    // model_usage is a TRI-STATE (RUN-59), which COALESCE cannot express: null/absent = no
    // news (keep); {} = the daemon EXPLICITLY retracting an unattributable mix (store NULL);
    // a non-empty object = the authoritative breakdown (store it). The empty-clear is the
    // whole reason this can't ride the COALESCE above — a stale complete mix must be droppable.
    if (t.modelUsage != null) {
      const val = Object.keys(t.modelUsage).length ? JSON.stringify(t.modelUsage) : null;
      await this.env.DB.prepare('UPDATE runs SET model_usage = ? WHERE id = ? AND project_id = ?')
        .bind(val, runId, projectId).run();
    }
  }

  /**
   * Append transcript segments (RUN-74). Idempotent by construction — the daemon may resend a
   * batch after a reconnect, and (run_id, seq) OR IGNORE makes that a no-op. No event emitted:
   * this is telemetry-frequency data, and the event log is for facts humans subscribe to.
   * Capped per run so a runaway agent cannot grow a row set without bound; the daemon already
   * caps segment text, this caps count — beyond it, one system marker says the tail was cut.
   */
  async appendRunLog(
    projectId: string,
    runId: string,
    segments: Array<{ seq: number; role: string; round?: number | null; text: string; at: string }>,
  ): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const run = await this.env.DB.prepare('SELECT id FROM runs WHERE id = ? AND project_id = ?')
        .bind(runId, projectId).first();
      if (!run || !segments.length) return;
      const CAP = 2000;
      const stmts = segments
        .filter((s) => s.seq < CAP)
        .map((s) =>
          this.env.DB.prepare(
            'INSERT OR IGNORE INTO run_log_segments (run_id, seq, role, round, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).bind(runId, s.seq, s.role, s.round ?? null, s.text, s.at),
        );
      if (segments.some((s) => s.seq >= CAP)) {
        stmts.push(
          this.env.DB.prepare(
            'INSERT OR IGNORE INTO run_log_segments (run_id, seq, role, round, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).bind(runId, CAP, 'system', null, '… transcript truncated (per-run segment cap reached)', nowIso()),
        );
      }
      if (stmts.length) await this.env.DB.batch(stmts);
    });
  }

  /** The transcript, in daemon order — the dashboard's run stream (RUN-74). */
  async getRunLog(
    projectId: string,
    runId: string,
  ): Promise<{ segments: Array<{ seq: number; role: string; round: number | null; text: string; at: string }> }> {
    await this.setPid(projectId);
    const { results } = await this.env.DB.prepare(
      `SELECT seq, role, round, text, created_at AS at FROM run_log_segments
       WHERE run_id = ? ORDER BY seq LIMIT 2001`,
    ).bind(runId).all<{ seq: number; role: string; round: number | null; text: string; at: string }>();
    return { segments: results };
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
      /** Shared fields for every newTask across all phases (PLNR-133) — the same defaults
       *  idea create_tasks uses; a task's own value wins. */
      taskDefaults?: { milestoneId?: string; tags?: string[]; boardId?: string; priority?: number; estimate?: number; type?: string; docIds?: string[] };
      phases: Array<{
        title: string;
        body?: string;
        taskIds?: string[];
        newTasks?: Array<{
          title: string; body?: string; priority?: number; estimate?: number; dueAt?: string;
          tags?: string[]; milestoneId?: string; type?: string; boardId?: string; docIds?: string[];
          /** Extra ad-hoc edges beyond the enforced phase chain — existing task ids or keys. */
          dependsOn?: string[];
        }>;
      }>;
    },
  )  {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const planId = newId('pln');
      const status = input.proposed ? 'proposed' : 'active';
      await this.env.DB.prepare(
        'INSERT INTO plans (id, project_id, agent_id, title, description, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(planId, projectId, input.agentId ?? null, input.title, input.description ?? '', input.body ?? '', status, nowIso()).run();
  
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
          const d = input.taskDefaults ?? {};
          // Ad-hoc dependsOn accepts ids or keys, resolved here — createTask inserts raw.
          const dependsOn = await Promise.all((nt.dependsOn ?? []).map(async (ref) => {
            const t = await this.env.DB.prepare('SELECT id FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
              .bind(ref, ref, projectId).first<{ id: string }>();
            if (!t) throw new Error(`dependsOn ${ref} not found in this project`);
            return t.id;
          }));
          const created = await this.createTask(projectId, actor, {
            title: nt.title,
            body: nt.body,
            priority: nt.priority ?? d.priority,
            estimate: nt.estimate ?? d.estimate,
            dueAt: nt.dueAt,
            tags: nt.tags ?? d.tags,
            milestoneId: nt.milestoneId ?? d.milestoneId,
            type: nt.type ?? d.type,
            boardId: nt.boardId ?? d.boardId,
            docIds: nt.docIds ?? d.docIds,
            dependsOn,
          });
          taskIds.push(created.id);
        }
        if (!taskIds.length) throw new Error(`phase "${ph.title}" has no tasks`);
  
        await this.env.DB.batch(taskIds.map((tid) =>
          this.env.DB.prepare('INSERT OR IGNORE INTO phase_tasks (phase_id, task_id) VALUES (?, ?)').bind(phaseId, tid),
        ));
        phases.push({ id: phaseId, title: ph.title, taskIds });
      }
      // Phase ordering gates directly off phase membership (PLNR-163) — no dependency
      // edges are minted; the claim/claimable/dispatch predicates read the phase graph.
      await this.emit(actor, 'plan.created', 'plan', planId, {
        title: input.title, status, phases: phases.map((p) => ({ title: p.title, tasks: p.taskIds.length })),
      });
      this.reindexSearch('plan', planId);
      return { id: planId, title: input.title, status, phases };

    });
  }

  /** Replace a plan's structure — phases and their task membership (PLNR-154).
   *
   *  Before this, phase_tasks was written only by createPlan: a plan whose shape was wrong
   *  could have its prose corrected but never its structure, so document and reality drifted
   *  (the RUN-39 incident). Semantics mirror create_plan: the argument IS the new structure.
   *  A phase entry carrying its existing id is kept in place (its phase_gates verify state
   *  survives); entries without an id are new; existing phases not mentioned are dropped.
   *  Membership is rebuilt wholesale; phase-order gating follows automatically because the
   *  gate reads phase membership live (PLNR-163) — a task removed from the plan sheds its
   *  phase gate the moment the row is gone, and no task or dependency row is touched. */
  async restructurePlan(
    projectId: string,
    actor: Actor,
    planId: string,
    phases: Array<{ id?: string; title: string; body?: string; taskIds: string[] }>,
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.setPid(projectId);
      const plan = await this.env.DB.prepare('SELECT id, title FROM plans WHERE id = ? AND project_id = ?')
        .bind(planId, projectId).first<{ id: string; title: string }>();
      if (!plan) throw new Error('plan not found in this project');

      const resolved: Array<{ id: string | null; title: string; body?: string; taskIds: string[] }> = [];
      for (const ph of phases) {
        const taskIds: string[] = [];
        for (const tid of ph.taskIds) {
          const t = await this.env.DB.prepare('SELECT id FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
            .bind(tid, tid, projectId).first<{ id: string }>();
          if (!t) throw new Error(`task ${tid} not found in this project`);
          taskIds.push(t.id);
        }
        if (!taskIds.length) throw new Error(`phase "${ph.title}" has no tasks`);
        resolved.push({ id: ph.id ?? null, title: ph.title, body: ph.body, taskIds });
      }

      const { results: existing } = await this.env.DB.prepare('SELECT id FROM phases WHERE plan_id = ?')
        .bind(planId).all<{ id: string }>();
      const existingIds = new Set(existing.map((r) => r.id));
      for (const p of resolved) {
        if (p.id && !existingIds.has(p.id)) throw new Error(`phase ${p.id} is not part of this plan`);
      }
      const keptIds = new Set(resolved.map((p) => p.id).filter((id): id is string => !!id));

      const stmts = [
        // Membership first, plan-wide — the subselect needs the doomed phases still present.
        this.env.DB.prepare('DELETE FROM phase_tasks WHERE phase_id IN (SELECT id FROM phases WHERE plan_id = ?)').bind(planId),
        ...existing.filter((e) => !keptIds.has(e.id)).flatMap((e) => [
          this.env.DB.prepare('DELETE FROM phase_gates WHERE phase_id = ?').bind(e.id),
          this.env.DB.prepare('DELETE FROM phases WHERE id = ?').bind(e.id),
        ]),
      ];
      const out: Array<{ id: string; title: string; taskIds: string[] }> = [];
      resolved.forEach((p, i) => {
        const phaseId = p.id ?? newId('phs');
        if (p.id) {
          stmts.push(
            p.body === undefined
              ? this.env.DB.prepare('UPDATE phases SET title = ?, "order" = ? WHERE id = ?').bind(p.title, i, phaseId)
              : this.env.DB.prepare('UPDATE phases SET title = ?, body = ?, "order" = ? WHERE id = ?').bind(p.title, p.body, i, phaseId),
          );
        } else {
          stmts.push(this.env.DB.prepare('INSERT INTO phases (id, plan_id, title, body, "order") VALUES (?, ?, ?, ?, ?)')
            .bind(phaseId, planId, p.title, p.body ?? '', i));
        }
        for (const tid of p.taskIds) {
          stmts.push(this.env.DB.prepare('INSERT OR IGNORE INTO phase_tasks (phase_id, task_id) VALUES (?, ?)').bind(phaseId, tid));
        }
        out.push({ id: phaseId, title: p.title, taskIds: p.taskIds });
      });
      await this.env.DB.batch(stmts);

      await this.emit(actor, 'plan.updated', 'plan', planId, {
        title: plan.title, structural: true, phases: out.map((p) => ({ title: p.title, tasks: p.taskIds.length })),
      });
      return { id: planId, title: plan.title, phases: out };
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
        // Gate rows before phases (subselect needs them). Phase-order gating dies with the
        // phase_tasks rows themselves (PLNR-163) — nothing else to reap.
        this.env.DB.prepare('DELETE FROM phase_gates WHERE phase_id IN (SELECT id FROM phases WHERE plan_id = ?)').bind(planId),
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
      this.reindexSearch('plan', planId);
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
      'SELECT id, key, status, claimed_by, claim_expires_at, failed_at, title FROM tasks WHERE id = ? AND project_id = ?',
    ).bind(taskId, this.projectId).first<TaskRow>();
    if (!row) throw new Error(`task ${taskId} not found in this project`);
    return row;
  }

  /** Blockers between this task and workability — manual dep edges + earlier-phase tasks.
   *  Delegates to the shared lib (PLNR-177) so the mutating claim path and the read-only
   *  can_claim probe enforce byte-identical gate logic. */
  private unfinishedDeps(taskId: string, gate: 'strict' | 'landed' = 'strict'): Promise<string[]> {
    return unfinishedDepsLib(this.env.DB, taskId, gate);
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
