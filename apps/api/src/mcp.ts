import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from './env';
import type { AgentIdentity } from './auth';
import type { Actor } from './do/ProjectRoom';
import { computeUpdates, formatNotices } from './sync';
import { nowIso } from './lib/util';

/**
 * planar MCP server — Streamable HTTP, stateless (a fresh server per request,
 * bound to the authenticated agent). Tools ARE the documentation: descriptions
 * teach the workflow, get_briefing orients, and every result carries a notices
 * block so working agents get pushed-feeling updates without polling.
 */

const INSTRUCTIONS = `planar coordinates multiple AI agents working the same project.
The contract: (1) call get_briefing first; (2) claim_task before working on anything;
(3) call heartbeat (or any tool) at least every minute while working — your claim's TTL
lapses otherwise and the task is requeued; (4) check and resolve open comments — humans
steer you through them; (5) release_task (to review or done) when finished. Never work
on a task you have not claimed.`;

function room(env: Env, projectId: string) {
  return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
}

const asActor = (a: AgentIdentity): Actor => ({ kind: 'agent', id: a.id, name: a.name });

export function buildMcpServer(env: Env, agent: AgentIdentity): McpServer {
  const server = new McpServer(
    { name: 'planar', version: '0.2.0' },
    { instructions: INSTRUCTIONS },
  );
  const actor = asActor(agent);

  /** Wrap a handler: JSON result + piggybacked notices for the calling agent. */
  const tool = <T>(fn: (args: T) => Promise<unknown>) =>
    async (args: T) => {
      let body: unknown;
      try {
        body = await fn(args);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
      const updates = await computeUpdates(env, agent);
      const notices = formatNotices(updates);
      const text = JSON.stringify(body, null, 1) + (notices ? `\n\n${notices}` : '');
      return { content: [{ type: 'text' as const, text }] };
    };

  // ---- orientation --------------------------------------------------------

  server.tool(
    'get_briefing',
    'Call this FIRST in every session. Returns the planar playbook plus your current state: who you are, tasks you hold, unresolved comments awaiting you, what is claimable, and recent messages.',
    {},
    tool(async () => {
      const updates = await computeUpdates(env, agent, { advanceCursor: false });
      const projects = (
        await env.DB.prepare("SELECT id, key, name, description, status FROM projects WHERE status = 'active'").all()
      ).results;
      return {
        you: { id: agent.id, name: agent.name, role: agent.role },
        playbook: [
          'Work loop: my_updates → pick from claimable (or next_claimable) → claim_task → do the work → heartbeat every ~60s → resolve any comments → release_task {toStatus:"review"|"done"}.',
          'Humans steer via comments on tasks (kind: question/instruction). Acknowledge fast, resolve with resolve_comment (addressed|wont_do) + a reply. Unresolved comments should block you from finishing.',
          'Orchestrators: structure work with create_plan (ordered phases over tasks — order is enforced via auto-dependencies) or decompose_task for a quick subtree; workers drain via next_claimable.',
          'Claims are exclusive. If claim_task fails, the task is taken or blocked — pick another.',
          'Every tool result may end with a "--- notices ---" block: read it, it is addressed to you.',
        ],
        projects,
        state: updates,
      };
    }),
  );

  server.tool(
    'my_updates',
    'Your delta since last call (server-side cursor, no client state needed). Call whenever you finish a step or need orientation. Open comments are sticky — they reappear until resolved.',
    {},
    tool(async () => computeUpdates(env, agent)),
  );

  // ---- projects -----------------------------------------------------------

  server.tool(
    'list_projects',
    'List active projects with task counts.',
    {},
    tool(async () => {
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.key, p.name, p.description, p.repo_url AS repoUrl,
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS openTasks
         FROM projects p WHERE p.status = 'active' ORDER BY p.created_at`,
      ).all();
      return { projects: results };
    }),
  );

  server.tool(
    'create_project',
    'Create a project. key is the short task-key prefix (e.g. "PLN" → PLN-1, PLN-2…).',
    {
      key: z.string().min(1).max(8).regex(/^[A-Z][A-Z0-9]*$/, 'uppercase letters/digits'),
      name: z.string().min(1),
      description: z.string().optional(),
      repoUrl: z.string().url().optional(),
    },
    tool(async (args) => {
      const id = `prj_${args.key.toLowerCase()}`;
      await env.DB.prepare(
        `INSERT INTO projects (id, key, name, description, status, repo_url, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(id, args.key, args.name, args.description ?? '', args.repoUrl ?? null, nowIso()).run();
      await room(env, id).createMilestone(id, actor, 'Backlog');
      return { id, key: args.key };
    }),
  );

  server.tool(
    'get_project',
    'Project snapshot: tasks (with status/holder/deps/open-comment counts), milestones, agents active here.',
    { projectId: z.string() },
    tool(async ({ projectId }) => {
      const [tasks, milestones, project] = await Promise.all([
        env.DB.prepare(
          `SELECT t.id, t.key, t.title, t.status, t.priority, t.claimed_by AS claimedBy, t.parent_task_id AS parentTaskId,
                  t.milestone_id AS milestoneId, t.open_comments AS openComments, t.claim_expires_at AS claimExpiresAt,
                  (SELECT GROUP_CONCAT(dt.key) FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = t.id) AS dependsOn
           FROM tasks t WHERE t.project_id = ? ORDER BY t."order"`,
        ).bind(projectId).all(),
        env.DB.prepare('SELECT id, title, due_at AS dueAt FROM milestones WHERE project_id = ? ORDER BY "order"').bind(projectId).all(),
        env.DB.prepare('SELECT id, key, name, description, repo_url AS repoUrl, claim_ttl_seconds AS claimTtlSeconds FROM projects WHERE id = ?')
          .bind(projectId).first(),
      ]);
      if (!project) throw new Error(`project ${projectId} not found`);
      return { project, milestones: milestones.results, tasks: tasks.results };
    }),
  );

  // ---- tasks --------------------------------------------------------------

  server.tool(
    'create_task',
    'Create a task. Use parentTaskId to build a decomposition tree and dependsOn (task ids) to gate order. New tasks start as todo.',
    {
      projectId: z.string(),
      title: z.string().min(1),
      body: z.string().optional(),
      parentTaskId: z.string().optional(),
      milestoneId: z.string().optional(),
      priority: z.number().int().min(0).max(4).optional(),
      dependsOn: z.array(z.string()).optional(),
    },
    tool(async ({ projectId, ...input }) => room(env, projectId).createTask(projectId, actor, input)),
  );

  server.tool(
    'decompose_task',
    'Orchestrator tool: create several subtasks of a parent in one call. Each subtask may depend on earlier ones by index (dependsOnIndex) to express ordering.',
    {
      projectId: z.string(),
      parentTaskId: z.string(),
      subtasks: z.array(
        z.object({
          title: z.string().min(1),
          body: z.string().optional(),
          priority: z.number().int().min(0).max(4).optional(),
          dependsOnIndex: z.array(z.number().int().nonnegative()).optional(),
        }),
      ).min(1).max(20),
    },
    tool(async ({ projectId, parentTaskId, subtasks }) => {
      const r = room(env, projectId);
      const created: Array<{ id: string; key: string }> = [];
      for (const st of subtasks) {
        const dependsOn = (st.dependsOnIndex ?? []).map((i) => {
          const dep = created[i];
          if (!dep) throw new Error(`dependsOnIndex ${i} refers to a subtask not yet created`);
          return dep.id;
        });
        created.push(await r.createTask(projectId, actor, { title: st.title, body: st.body, parentTaskId, priority: st.priority, dependsOn }));
      }
      return { created };
    }),
  );

  server.tool(
    'update_task',
    'Edit task fields. For claim-related status changes prefer claim_task/release_task; setting status directly here is a supervisor-style override.',
    {
      projectId: z.string(),
      taskId: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled']).optional(),
      priority: z.number().int().min(0).max(4).optional(),
      milestoneId: z.string().optional(),
    },
    tool(async ({ projectId, taskId, ...patch }) => room(env, projectId).updateTask(projectId, actor, taskId, patch)),
  );

  server.tool(
    'get_task',
    'Full task detail including body, dependencies, comments (open first), git refs, and claim state.',
    { taskId: z.string() },
    tool(async ({ taskId }) => {
      const task = await env.DB.prepare(
        `SELECT t.*, t.claimed_by AS claimedBy, t.claim_expires_at AS claimExpiresAt, t.open_comments AS openComments
         FROM tasks t WHERE t.id = ? OR t.key = ?`,
      ).bind(taskId, taskId).first();
      if (!task) throw new Error(`task ${taskId} not found`);
      const id = String(task.id);
      const [deps, comments, refs] = await Promise.all([
        env.DB.prepare(
          `SELECT dt.id, dt.key, dt.status FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = ?`,
        ).bind(id).all(),
        env.DB.prepare(
          `SELECT id, author_kind AS authorKind, author_id AS authorId, kind, body, status, parent_comment_id AS parentCommentId, created_at AS createdAt
           FROM comments WHERE task_id = ? ORDER BY CASE WHEN status IN ('open','acknowledged') THEN 0 ELSE 1 END, created_at`,
        ).bind(id).all(),
        env.DB.prepare('SELECT kind, ref, url, state FROM task_refs WHERE task_id = ?').bind(id).all(),
      ]);
      return { task, dependencies: deps.results, comments: comments.results, refs: refs.results };
    }),
  );

  server.tool(
    'add_dependency',
    'Make one task depend on another (blocks claiming until the dependency is done). Cycles are rejected.',
    { projectId: z.string(), taskId: z.string(), dependsOnTaskId: z.string() },
    tool(async ({ projectId, taskId, dependsOnTaskId }) => room(env, projectId).addDependency(projectId, actor, taskId, dependsOnTaskId)),
  );

  // ---- coordination -------------------------------------------------------

  server.tool(
    'next_claimable',
    'The worker pull-loop: returns the highest-priority dependency-unblocked, unclaimed task (optionally within one project). Claim it with claim_task.',
    { projectId: z.string().optional() },
    tool(async ({ projectId }) => {
      const row = await env.DB.prepare(
        `SELECT t.id, t.key, t.title, t.body, t.priority, t.project_id AS projectId
         FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
         WHERE t.status = 'todo' AND t.claimed_by IS NULL AND (? IS NULL OR t.project_id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id
             WHERE d.task_id = t.id AND dt.status NOT IN ('done','cancelled'))
         ORDER BY t.priority DESC, t."order" LIMIT 1`,
      ).bind(projectId ?? null, projectId ?? null).first();
      return row ? { task: row } : { task: null, note: 'nothing claimable right now — check my_updates for blockers' };
    }),
  );

  server.tool(
    'claim_task',
    'Claim exclusive ownership before working. Fails if held, blocked, or not claimable. Returns the TTL and any open comments — read them before you start. Keep the claim alive with heartbeat.',
    { projectId: z.string(), taskId: z.string() },
    tool(async ({ projectId, taskId }) => room(env, projectId).claimTask(projectId, actor, taskId, agent.id)),
  );

  server.tool(
    'heartbeat',
    'Renew your claim TTLs in a project (call at least every 60s while working — any planar tool call also counts as liveness). Returns what was renewed.',
    { projectId: z.string() },
    tool(async ({ projectId }) => room(env, projectId).heartbeat(projectId, actor, agent.id)),
  );

  server.tool(
    'release_task',
    'Release your claim when done or handing off. toStatus: "review" (default for finished work needing eyes), "done", "todo" (give it back), or "blocked".',
    { projectId: z.string(), taskId: z.string(), toStatus: z.enum(['todo', 'review', 'done', 'blocked']).optional() },
    tool(async ({ projectId, taskId, toStatus }) => {
      if (toStatus === 'done') {
        const open = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM comments WHERE task_id = ? AND status IN ('open','acknowledged')",
        ).bind(taskId).first<{ n: number }>();
        if (open && open.n > 0) {
          throw new Error(`task has ${open.n} unresolved comment(s) — resolve them (resolve_comment) before marking done`);
        }
      }
      return room(env, projectId).releaseTask(projectId, actor, taskId, { toStatus });
    }),
  );

  // ---- comments (the human steering channel) ------------------------------

  server.tool(
    'read_open_comments',
    'Unresolved comments/questions on a task. Humans steer you here — treat instructions as scope changes and questions as blocking asks.',
    { taskId: z.string() },
    tool(async ({ taskId }) => {
      const { results } = await env.DB.prepare(
        `SELECT id, author_kind AS authorKind, author_id AS authorId, kind, body, status, created_at AS createdAt
         FROM comments WHERE task_id = ? AND status IN ('open','acknowledged') ORDER BY created_at`,
      ).bind(taskId).all();
      return { openComments: results };
    }),
  );

  server.tool(
    'post_comment',
    'Post a comment/question on a task (agents may ask humans questions too — they appear in the UI).',
    {
      projectId: z.string(),
      taskId: z.string(),
      kind: z.enum(['comment', 'question', 'reply']).default('comment'),
      body: z.string().min(1),
      parentCommentId: z.string().optional(),
    },
    tool(async ({ projectId, taskId, kind, body, parentCommentId }) =>
      room(env, projectId).postComment(projectId, actor, taskId, kind, body, parentCommentId),
    ),
  );

  server.tool(
    'resolve_comment',
    'Resolve an open comment on your task: addressed (you did/answered it) or wont_do (explain why). Always include a reply — the human is waiting.',
    {
      projectId: z.string(),
      commentId: z.string(),
      resolution: z.enum(['addressed', 'wont_do']),
      reply: z.string().min(1),
    },
    tool(async ({ projectId, commentId, resolution, reply }) =>
      room(env, projectId).resolveComment(projectId, actor, commentId, resolution, reply),
    ),
  );

  // ---- messaging ----------------------------------------------------------

  server.tool(
    'send_message',
    'Message another agent (toAgentId) or broadcast to the project (omit toAgentId). Recipients see it in my_updates/notices.',
    {
      projectId: z.string(),
      body: z.string().min(1),
      toAgentId: z.string().optional(),
      refTaskId: z.string().optional(),
    },
    tool(async ({ projectId, body, toAgentId, refTaskId }) =>
      room(env, projectId).sendMessage(projectId, actor, agent.id, body, toAgentId, refTaskId),
    ),
  );

  // ---- plans (an agent's work program over tasks) ---------------------------

  server.tool(
    'create_plan',
    'Structure your approach: group tasks into ordered phases. Phase order is ENFORCED — every task in phase N automatically depends on all tasks in phase N-1, so workers can only claim in sequence. Reference existing tasks by id/key (taskIds) and/or create tasks inline (newTasks). Humans see the plan visualized.',
    {
      projectId: z.string(),
      title: z.string().min(1),
      description: z.string().optional(),
      phases: z.array(
        z.object({
          title: z.string().min(1),
          taskIds: z.array(z.string()).optional(),
          newTasks: z.array(z.object({ title: z.string().min(1), body: z.string().optional(), priority: z.number().int().min(0).max(4).optional() })).optional(),
        }),
      ).min(1).max(12),
    },
    tool(async ({ projectId, title, description, phases }) =>
      room(env, projectId).createPlan(projectId, actor, { title, description, agentId: agent.id, phases }),
    ),
  );

  server.tool(
    'get_plans',
    'Plans in a project with per-phase progress (done/total tasks) — see how the work program is advancing.',
    { projectId: z.string() },
    tool(async ({ projectId }) => {
      const { results: plans } = await env.DB.prepare(
        'SELECT id, agent_id AS agentId, title, description, created_at AS createdAt FROM plans WHERE project_id = ? ORDER BY created_at DESC',
      ).bind(projectId).all();
      const enriched = [];
      for (const p of plans) {
        const { results: phasesRows } = await env.DB.prepare(
          `SELECT ph.id, ph.title, ph."order",
                  (SELECT COUNT(*) FROM phase_tasks pt WHERE pt.phase_id = ph.id) AS total,
                  (SELECT COUNT(*) FROM phase_tasks pt JOIN tasks t ON t.id = pt.task_id WHERE pt.phase_id = ph.id AND t.status = 'done') AS done
           FROM phases ph WHERE ph.plan_id = ? ORDER BY ph."order"`,
        ).bind(p.id).all();
        enriched.push({ ...p, phases: phasesRows });
      }
      return { plans: enriched };
    }),
  );

  // ---- milestones ---------------------------------------------------------

  server.tool(
    'create_milestone',
    'Create a milestone in a project (assign tasks to it via update_task.milestoneId).',
    { projectId: z.string(), title: z.string().min(1), dueAt: z.string().datetime().optional() },
    tool(async ({ projectId, title, dueAt }) => room(env, projectId).createMilestone(projectId, actor, title, dueAt)),
  );

  // ---- git awareness (Phase 4) --------------------------------------------

  server.tool(
    'attach_ref',
    'Link a git branch/PR/commit to a task so humans see where the work lives. Update state when the PR merges (or let the GitHub webhook do it).',
    {
      taskId: z.string(),
      kind: z.enum(['branch', 'pr', 'commit']),
      ref: z.string().min(1),
      url: z.string().url().optional(),
      state: z.string().optional(),
    },
    tool(async ({ taskId, kind, ref, url, state }) => {
      const task = await env.DB.prepare('SELECT id, project_id AS pid, key FROM tasks WHERE id = ? OR key = ?')
        .bind(taskId, taskId).first<{ id: string; pid: string; key: string }>();
      if (!task) throw new Error(`task ${taskId} not found`);
      await env.DB.prepare(
        `INSERT INTO task_refs (id, task_id, kind, ref, url, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id, kind, ref) DO UPDATE SET url = excluded.url, state = excluded.state`,
      ).bind(`ref_${crypto.randomUUID().slice(0, 12)}`, task.id, kind, ref, url ?? null, state ?? null, nowIso()).run();
      return { ok: true, taskKey: task.key };
    }),
  );

  return server;
}
