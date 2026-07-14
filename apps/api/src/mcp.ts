import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from './env';
import type { AgentIdentity } from './auth';
import type { Actor } from './do/ProjectRoom';
import { computeUpdates, formatNotices } from './sync';
import { base64ToBytes, bytesToBase64, newId, nowIso, sha256Hex } from './lib/util';

const MAX_ATTACHMENT = 100 * 1024 * 1024;
/** Stable resource URI for an attachment; agents read bytes back via resources/read. */
const attachmentUri = (id: string) => `noriq://attachment/${id}`;

/** Tool metadata captured at registration, used to generate the reference doc (PLNR-23). */
export type ToolSpec = { name: string; description: string; inputSchema: z.ZodRawShape };
export type ResourceSpec = { name: string; uriTemplate: string; description: string };

/**
 * Noriq MCP server — Streamable HTTP, stateless (a fresh server per request,
 * bound to the authenticated agent). Tools ARE the documentation: descriptions
 * teach the workflow, get_briefing orients, and every result carries a notices
 * block so working agents get pushed-feeling updates without polling.
 */

const INSTRUCTIONS = `Noriq coordinates multiple AI agents working the same project.
The contract: (1) call get_briefing first; (2) claim_task before working on anything;
(3) just keep working — every Noriq tool call renews your claim automatically, and the
TTL is generous (30 min), so you never need to ping to stay alive. heartbeat exists only
for the rare case where you'll go silent longer than that; (4) check and resolve open
comments — humans steer you through them; (5) release_task (to review or done) when
finished. Never work on a task you have not claimed. Each session (this chat, or a
sub-agent) is its own agent, local to one project — call set_agent_identity with a name
and the projectId you're working; sub-agents pass parentAgentId to attribute their work.`;

function room(env: Env, projectId: string) {
  return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
}

/**
 * Resolve a task reference — either the opaque `task_…` id or the `PLN-##` display key —
 * to its canonical id, so callers can accept whichever the agent passes. The ProjectRoom
 * is strictly id-keyed, so claim/release resolve here before crossing into it.
 */
async function resolveTaskId(env: Env, projectId: string, taskId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT id FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
    .bind(taskId, taskId, projectId).first<{ id: string }>();
  if (!row) throw new Error(`task ${taskId} not found in project ${projectId}`);
  return String(row.id);
}

const asActor = (a: AgentIdentity): Actor => ({ kind: 'agent', id: a.id, name: a.name });

export function buildMcpServer(env: Env, agent: AgentIdentity, opts: { oauthTokenId?: string; sessionId?: string } = {}): McpServer {
  const server = new McpServer(
    { name: 'noriq', version: '0.3.0' },
    {
      instructions: INSTRUCTIONS,
      // logging → standard notifications/message (any client); experimental claude/channel
      // → Claude's richer surfacing. Both ride the live POST SSE stream (PLNR-54/45).
      capabilities: { logging: {}, experimental: { 'claude/channel': {} } },
    },
  );
  const actor = asActor(agent);
  const toolSpecs: ToolSpec[] = [];
  const resourceSpecs: ResourceSpec[] = [];

  // PLNR-54: in stateless Streamable HTTP there is NO standing GET SSE stream, so a
  // notification sent with no related request id is dropped by the transport. The fix
  // (per spec) is to ride the *current* tool call's POST SSE stream: tag the
  // notification with relatedRequestId = the in-flight request id (from the handler's
  // `extra`). It then flushes on that stream and reaches the client within the same
  // turn, alongside the tool result — a real push, not just the text-block fallback.
  const pushChannel = async (content: string, meta: Record<string, string>, relatedRequestId?: string | number) => {
    if (relatedRequestId === undefined) return; // nowhere to deliver in stateless mode
    const params = { content, meta: { source: 'noriq', agent: agent.name, ...meta } };
    try {
      // Standard logging notification — surfaced by any spec-compliant client.
      await server.server.notification({ method: 'notifications/message', params: { level: 'info', logger: 'noriq', data: params } }, { relatedRequestId });
    } catch { /* client without logging capability */ }
    try {
      // Experimental channel — Claude surfaces this richly (capabilities.experimental).
      await server.server.notification({ method: 'notifications/claude/channel', params }, { relatedRequestId });
    } catch { /* transport/client without channel support — text block still carries it */ }
  };

  /** Wrap a handler: JSON result + piggybacked notices, pushed on the live stream too. */
  const tool = <T>(fn: (args: T) => Promise<unknown>) =>
    async (args: T, extra?: { requestId?: string | number }) => {
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
      if (notices) await pushChannel(notices, { kind: 'notices' }, extra?.requestId);
      const text = JSON.stringify(body, null, 1) + (notices ? `\n\n${notices}` : '');
      return { content: [{ type: 'text' as const, text }] };
    };

  /** Register a tool with the non-deprecated config-object API (was server.tool). */
  const defineTool = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cb: (args: any, extra?: { requestId?: string | number }) => unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => {
    // Capture the spec at definition time so the reference doc is generated from the
    // exact same zod schemas the tools validate against — it can't drift (PLNR-23).
    toolSpecs.push({ name, description, inputSchema });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return server.registerTool(name, { description, inputSchema }, cb as any);
  };

  // ---- orientation --------------------------------------------------------

  defineTool(
    'get_briefing',
    'Call this FIRST in every session. Returns the Noriq playbook plus your current state: who you are, tasks you hold, unresolved comments awaiting you, what is claimable, and recent messages.',
    {},
    tool(async () => {
      const updates = await computeUpdates(env, agent, { advanceCursor: false });
      const projects = (
        await env.DB.prepare("SELECT id, key, name, description, status FROM projects WHERE status = 'active'").all()
      ).results;
      return {
        you: { id: agent.id, name: agent.name, role: agent.role },
        playbook: [
          'Name this session for the project with set_agent_identity before your first claim. Work loop: my_updates → pick from claimable (or next_claimable) → claim_task (just the one you are about to start) → do the work → resolve any comments → release_task {toStatus:"review"|"done"}. Every tool call renews your claim, so no periodic pinging — heartbeat only if you will be idle longer than the claim TTL.',
          'Humans steer via comments on tasks (kind: question/instruction). Acknowledge fast, resolve with resolve_comment (addressed|wont_do) + a reply. Unresolved comments should block you from finishing.',
          'Anything bigger than one task: plan first. create_plan writes the plan as a document — goals/approach in the body, then ordered phases over tasks (phase order enforced via auto-dependencies); or decompose_task for a quick subtree. Workers drain the plan via next_claimable; keep it current with update_plan.',
          'Claims are exclusive. If claim_task fails, the task is taken or blocked — pick another.',
          'Blocked on a human decision? request_input (it auto-parks the task and frees you to work elsewhere) — do not guess or stall. Flag non-blocking concerns (deviations, risks) with raise_alert and keep going.',
          'Every tool result may end with a "--- notices ---" block: read it, it is addressed to you.',
        ],
        projects,
        state: updates,
      };
    }),
  );

  defineTool(
    'my_updates',
    'Your delta since last call (server-side cursor, no client state needed). Call whenever you finish a step or need orientation. Open comments are sticky — they reappear until resolved.',
    {},
    tool(async () => computeUpdates(env, agent)),
  );

  if (opts.oauthTokenId) {
    defineTool(
      'set_agent_identity',
      'Name THIS session as a distinct agent, scoped to the project you are about to work. Each chat/sub-agent is its own agent (keyed by MCP session), so pick a short name that reads well in that project — names are unique per project. Pass projectId to localize it (recommended; otherwise it scopes on your first claim). Sub-agents: pass parentAgentId to attribute your work to the agent that spawned you.',
      {
        name: z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'letters/digits/._-'),
        role: z.enum(['worker', 'orchestrator']).optional(),
        projectId: z.string().optional().describe('Localize this agent to a project (recommended)'),
        parentAgentId: z.string().optional().describe('If you are a sub-agent, the id of the agent that spawned you'),
      },
      tool(async ({ name, role, projectId, parentAgentId }) => {
        const token = await env.DB.prepare('SELECT user_id AS userId FROM oauth_tokens WHERE id = ?')
          .bind(opts.oauthTokenId).first<{ userId: string }>();
        if (!token) throw new Error('token not found');
        // The friendly name is the per-project display *label*; the DB `name` stays a
        // stable unique internal handle. Labels are unique within a project (app-enforced,
        // since D1 can't hold a per-project UNIQUE here); a retired label stays retired.
        const scope = projectId ?? null;
        const clash = await env.DB.prepare(
          `SELECT id, status, user_id AS userId FROM agents
           WHERE label = ? AND id != ? AND ((project_id IS NULL AND ? IS NULL) OR project_id = ?)`,
        ).bind(name, agent.id, scope, scope).first<{ id: string; status: string; userId: string | null }>();
        if (clash) {
          if (clash.status === 'revoked') throw new Error(`agent name "${name}" was revoked in this project and is retired — pick a new name`);
          if (clash.userId && clash.userId !== token.userId) throw new Error(`agent name "${name}" is owned by another user — pick a different name`);
          throw new Error(`agent name "${name}" is already taken in this project — pick another`);
        }
        if (parentAgentId) {
          const parent = await env.DB.prepare('SELECT id, user_id AS userId FROM agents WHERE id = ?')
            .bind(parentAgentId).first<{ id: string; userId: string | null }>();
          if (!parent) throw new Error(`parentAgentId ${parentAgentId} not found`);
          if (parent.userId && parent.userId !== token.userId) throw new Error('parent agent belongs to another user');
        }
        const newRole = role ?? agent.role;
        await env.DB.prepare(
          `UPDATE agents SET label = ?, role = ?, project_id = COALESCE(?, project_id),
             parent_agent_id = COALESCE(?, parent_agent_id), status = 'active', last_seen_at = ?
           WHERE id = ?`,
        ).bind(name, newRole, projectId ?? null, parentAgentId ?? null, nowIso(), agent.id).run();
        return {
          actingAs: { id: agent.id, name, role: newRole },
          project: projectId ?? null,
          parentAgentId: parentAgentId ?? null,
          note: 'this session now acts as this agent; subsequent calls are attributed to it',
        };
      }),
    );
  }

  // ---- projects -----------------------------------------------------------

  defineTool(
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

  defineTool(
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
        `INSERT INTO projects (id, key, name, description, status, repo_url, claim_ttl_seconds, created_at) VALUES (?, ?, ?, ?, 'active', ?, 1800, ?)`,
      ).bind(id, args.key, args.name, args.description ?? '', args.repoUrl ?? null, nowIso()).run();
      await room(env, id).createMilestone(id, actor, 'Backlog');
      await room(env, id).createBoard(id, actor, 'Main');
      return { id, key: args.key };
    }),
  );

  defineTool(
    'get_project',
    'Project snapshot: tasks (with status/holder/deps/board/open-comment counts), milestones, boards, agents active here.',
    { projectId: z.string() },
    tool(async ({ projectId }) => {
      const [tasks, milestones, boards, project, categories] = await Promise.all([
        env.DB.prepare(
          `SELECT t.id, t.key, t.title, t.status, t.type, t.priority, t.claimed_by AS claimedBy, t.parent_task_id AS parentTaskId,
                  t.milestone_id AS milestoneId, t.board_id AS boardId, t.open_comments AS openComments, t.claim_expires_at AS claimExpiresAt,
                  (SELECT GROUP_CONCAT(dt.key) FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = t.id) AS dependsOn,
                  (SELECT GROUP_CONCAT(g.name) FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id) AS tags
           FROM tasks t WHERE t.project_id = ? ORDER BY t."order"`,
        ).bind(projectId).all(),
        env.DB.prepare('SELECT id, title, due_at AS dueAt FROM milestones WHERE project_id = ? ORDER BY "order"').bind(projectId).all(),
        env.DB.prepare('SELECT id, name FROM boards WHERE project_id = ? ORDER BY "order", created_at').bind(projectId).all(),
        env.DB.prepare('SELECT id, key, name, description, repo_url AS repoUrl, claim_ttl_seconds AS claimTtlSeconds FROM projects WHERE id = ?')
          .bind(projectId).first(),
        env.DB.prepare('SELECT id, name, color FROM tags WHERE project_id = ? ORDER BY "order"').bind(projectId).all(),
      ]);
      if (!project) throw new Error(`project ${projectId} not found`);
      return { project, milestones: milestones.results, boards: boards.results, tags: categories.results, tasks: tasks.results };
    }),
  );

  // ---- tasks --------------------------------------------------------------

  defineTool(
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
      tags: z.array(z.string()).optional().describe('Tag names — auto-created for the project if new (e.g. ["backend", "auth"])'),
      type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
      boardId: z.string().optional().describe('Board to place the task on (see get_project.boards); defaults to the project’s default board'),
    },
    tool(async ({ projectId, ...input }) => room(env, projectId).createTask(projectId, actor, input)),
  );

  defineTool(
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
        const dependsOn = (st.dependsOnIndex ?? []).map((i: number) => {
          const dep = created[i];
          if (!dep) throw new Error(`dependsOnIndex ${i} refers to a subtask not yet created`);
          return dep.id;
        });
        created.push(await r.createTask(projectId, actor, { title: st.title, body: st.body, parentTaskId, priority: st.priority, dependsOn }));
      }
      return { created };
    }),
  );

  defineTool(
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
      tags: z.array(z.string()).optional().describe('REPLACES the tag set (auto-created; [] clears)'),
      type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
      boardId: z.string().optional().describe('Move the task to another board (see get_project.boards)'),
    },
    tool(async ({ projectId, taskId, ...patch }) => room(env, projectId).updateTask(projectId, actor, taskId, patch)),
  );

  defineTool(
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
      const [deps, comments, refs, attachments, signals] = await Promise.all([
        env.DB.prepare(
          `SELECT dt.id, dt.key, dt.status FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = ?`,
        ).bind(id).all(),
        env.DB.prepare(
          `SELECT id, author_kind AS authorKind, author_id AS authorId, kind, body, status, parent_comment_id AS parentCommentId, created_at AS createdAt
           FROM comments WHERE task_id = ? ORDER BY CASE WHEN status IN ('open','acknowledged') THEN 0 ELSE 1 END, created_at`,
        ).bind(id).all(),
        env.DB.prepare('SELECT kind, ref, url, state FROM task_refs WHERE task_id = ?').bind(id).all(),
        env.DB.prepare(
          `SELECT id, filename, content_type AS contentType, size, uploaded_by_kind AS uploadedByKind, uploaded_by AS uploadedBy, created_at AS createdAt
           FROM attachments WHERE task_id = ? ORDER BY created_at`,
        ).bind(id).all(),
        env.DB.prepare(
          `SELECT id, type, severity, title, body, options, status, response, created_at AS createdAt, resolved_at AS resolvedAt
           FROM signals WHERE task_id = ? ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC`,
        ).bind(id).all(),
      ]);
      // Each attachment carries its resource URI — read the bytes with resources/read.
      const withUris = attachments.results.map((a) => ({ ...a, resource: attachmentUri(String(a.id)) }));
      const sigs = signals.results.map((s) => ({ ...s, options: s.options ? JSON.parse(String(s.options)) : null }));
      return { task, dependencies: deps.results, comments: comments.results, refs: refs.results, attachments: withUris, signals: sigs };
    }),
  );

  defineTool(
    'add_dependency',
    'Make one task depend on another (blocks claiming until the dependency is done). Cycles are rejected.',
    { projectId: z.string(), taskId: z.string(), dependsOnTaskId: z.string() },
    tool(async ({ projectId, taskId, dependsOnTaskId }) => room(env, projectId).addDependency(projectId, actor, taskId, dependsOnTaskId)),
  );

  defineTool(
    'add_attachment',
    'Attach a file (screenshot, image, log, etc.) to a task. Pass the bytes base64-encoded in `data` (max 100 MB). Read them back later via the returned resource URI (resources/read) — e.g. noriq://attachment/<id>.',
    {
      projectId: z.string(),
      taskId: z.string(),
      filename: z.string().min(1).max(120),
      data: z.string().min(1).describe('file bytes, base64-encoded (up to 100 MB, transport limits permitting)'),
      contentType: z.string().optional().describe('MIME type, e.g. image/png — defaults to application/octet-stream'),
    },
    tool(async ({ projectId, taskId, filename, data, contentType }) => {
      if (!env.FILES) throw new Error('attachments not configured on this instance — enable R2 and bind FILES');
      const task = await env.DB.prepare('SELECT id, project_id AS pid, key FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
        .bind(taskId, taskId, projectId).first<{ id: string; pid: string; key: string }>();
      if (!task) throw new Error(`task ${taskId} not found in project ${projectId}`);
      const bytes = base64ToBytes(data);
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT) throw new Error('attachment must be 1 byte – 100 MB');
      const safeName = filename.replace(/[/\\]/g, '_').slice(0, 120);
      const ct = contentType ?? 'application/octet-stream';
      const id = newId('att');
      const key = `att/${task.pid}/${id}/${safeName}`;
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: ct } });
      await env.DB.prepare(
        `INSERT INTO attachments (id, task_id, filename, content_type, size, r2_key, uploaded_by_kind, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, ?)`,
      ).bind(id, task.id, safeName, ct, bytes.length, key, agent.id, nowIso()).run();
      await room(env, task.pid).noteAttachment(task.pid, actor, task.id, safeName, id);
      return { id, taskKey: task.key, filename: safeName, contentType: ct, size: bytes.length, resource: attachmentUri(id) };
    }),
  );

  // ---- coordination -------------------------------------------------------

  defineTool(
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

  defineTool(
    'claim_task',
    'Claim exclusive ownership before working. Fails if held, blocked, or not claimable. Returns the TTL and any open comments — read them before you start. Your claim renews on every Noriq tool call, so just keep working; no periodic heartbeat needed.',
    { projectId: z.string(), taskId: z.string() },
    tool(async ({ projectId, taskId }) => {
      const id = await resolveTaskId(env, projectId, taskId);
      const result = await room(env, projectId).claimTask(projectId, actor, id, agent.id);
      // An agent that hasn't localized itself yet adopts the project it first works in.
      await env.DB.prepare("UPDATE agents SET project_id = ?, status = 'active' WHERE id = ? AND project_id IS NULL")
        .bind(projectId, agent.id).run();
      return result;
    }),
  );

  defineTool(
    'heartbeat',
    'Rarely needed: every Noriq tool call already renews your claims. Use this ONLY when you will go silent longer than the claim TTL (e.g. a long external build) and want to hold the task without doing other Noriq work. Returns what was renewed.',
    { projectId: z.string() },
    tool(async ({ projectId }) => room(env, projectId).heartbeat(projectId, actor, agent.id)),
  );

  defineTool(
    'release_task',
    'Release your claim when done or handing off. toStatus: "review" (default for finished work needing eyes), "done", "todo" (give it back), or "blocked". Optional comment: your closing thoughts / handoff notes, recorded on the task in one call (no separate post_comment needed).',
    {
      projectId: z.string(),
      taskId: z.string(),
      toStatus: z.enum(['todo', 'review', 'done', 'blocked']).optional(),
      comment: z.string().optional().describe('Closing thoughts / handoff notes to record on the task'),
    },
    tool(async ({ projectId, taskId, toStatus, comment }) => {
      const id = await resolveTaskId(env, projectId, taskId);
      if (toStatus === 'done') {
        const open = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM comments WHERE task_id = ? AND status IN ('open','acknowledged')",
        ).bind(id).first<{ n: number }>();
        if (open && open.n > 0) {
          throw new Error(`task has ${open.n} unresolved comment(s) — resolve them (resolve_comment) before marking done`);
        }
        const gate = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM signals WHERE task_id = ? AND type = 'input_request' AND status = 'open'",
        ).bind(id).first<{ n: number }>();
        if (gate && gate.n > 0) {
          throw new Error(`task has ${gate.n} open input request(s) awaiting a human decision — can't finish until they're answered`);
        }
      }
      return room(env, projectId).releaseTask(projectId, actor, id, { toStatus, comment });
    }),
  );

  // ---- comments (the human steering channel) ------------------------------

  defineTool(
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

  defineTool(
    'add_comment',
    'Leave your OWN note on a task — progress, findings, rationale, a heads-up for whoever picks it up. A plain comment: it is recorded as a note and blocks nothing (not a question, not a resolution). To ask a human for a decision use request_input; to answer a human\'s open question use resolve_comment.',
    { projectId: z.string(), taskId: z.string(), body: z.string().min(1) },
    tool(async ({ projectId, taskId, body }) =>
      room(env, projectId).postComment(projectId, actor, taskId, 'comment', body),
    ),
  );

  defineTool(
    'post_comment',
    'Post a comment or a question on a task. kind:"question" asks a human (stays open until resolved); kind:"comment" is your own note (non-blocking); kind:"reply" answers a thread. For a plain note, add_comment is simpler.',
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

  defineTool(
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

  defineTool(
    'send_message',
    'Message another agent (toAgentId) or broadcast to the project (omit toAgentId). Recipients see it in my_updates/notices.',
    {
      projectId: z.string(),
      body: z.string().min(1),
      toAgentId: z.string().optional(),
      refTaskId: z.string().optional(),
    },
    tool(async ({ projectId, body, toAgentId, refTaskId }) =>
      room(env, projectId).sendMessage(projectId, actor, body, toAgentId, refTaskId),
    ),
  );

  // ---- signals: ask a human / flag attention ------------------------------

  defineTool(
    'request_input',
    'GATE: you need a human decision before you can proceed. Raise it here instead of guessing or stalling. If taskId is given, that task is auto-parked (released to blocked) so it does not lapse — then MOVE ON to other work via next_claimable; when a human answers you will see it in my_updates/notices and the task returns to the queue for you to re-claim. Give a clear title, the context in body, and options[] if it is a choice.',
    {
      projectId: z.string(),
      taskId: z.string().optional().describe('The task this decision blocks (auto-parked to blocked). Omit for a standalone question.'),
      title: z.string().min(1).describe('The decision needed, in one line'),
      body: z.string().optional().describe('Context: what you tried, why you are blocked, trade-offs'),
      options: z.array(z.string()).optional().describe('Discrete choices, if applicable'),
    },
    tool(async ({ projectId, taskId, title, body, options }) =>
      room(env, projectId).raiseSignal(projectId, actor, { type: 'input_request', taskId: taskId ?? null, title, body, options }),
    ),
  );

  defineTool(
    'raise_alert',
    'Flag something a human should SEE but that does not gate your work — a deviation from the plan, an unexpected finding, a risk, a heads-up. Non-blocking: keep working. Use severity critical sparingly for things that genuinely need prompt human attention.',
    {
      projectId: z.string(),
      taskId: z.string().optional(),
      title: z.string().min(1),
      body: z.string().optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional().describe('default info'),
    },
    tool(async ({ projectId, taskId, title, body, severity }) =>
      room(env, projectId).raiseSignal(projectId, actor, { type: 'alert', taskId: taskId ?? null, title, body, severity }),
    ),
  );

  // ---- plans (an agent's work program over tasks) ---------------------------

  defineTool(
    'create_plan',
    'Write your plan as a real document, then structure the work. body = your full written readout in markdown: goals, context, approach, constraints, risks, and an exit gate — what a teammate would need to pick this up. Each phase gets its own body (explicit details for that stage) plus its tasks (existing ids/keys via taskIds, or created inline via newTasks). Phase order is ENFORCED — every task in phase N auto-depends on all of phase N-1. Humans read the document and watch progress in the Plans view; append status updates later with update_plan.',
    {
      projectId: z.string(),
      title: z.string().min(1),
      description: z.string().optional().describe('One-line summary shown on the plan card'),
      body: z.string().optional().describe('The full plan document (markdown): goals, approach, constraints, exit gate'),
      phases: z.array(
        z.object({
          title: z.string().min(1),
          body: z.string().optional().describe('Explicit details for this phase (markdown): what, how, done-when'),
          taskIds: z.array(z.string()).optional(),
          newTasks: z.array(z.object({ title: z.string().min(1), body: z.string().optional(), priority: z.number().int().min(0).max(4).optional() })).optional(),
        }),
      ).min(1).max(12),
    },
    tool(async ({ projectId, title, description, body, phases }) =>
      room(env, projectId).createPlan(projectId, actor, { title, description, body, agentId: agent.id, phases }),
    ),
  );

  defineTool(
    'update_plan',
    'Revise a plan document as work progresses — append status updates, record findings/gotchas, mark the outcome. Pass the FULL new body (read it first via get_plans). updatePhase via phaseId to revise one phase.',
    {
      projectId: z.string(),
      planId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      body: z.string().optional().describe('Full replacement markdown for the plan document'),
      phaseId: z.string().optional().describe('If set, patch this phase instead of the plan'),
      phaseBody: z.string().optional(),
      phaseTitle: z.string().optional(),
    },
    tool(async ({ projectId, planId, title, description, body, phaseId, phaseBody, phaseTitle }) => {
      if (phaseId) {
        return room(env, projectId).updatePhase(projectId, actor, phaseId, { title: phaseTitle, body: phaseBody });
      }
      return room(env, projectId).updatePlan(projectId, actor, planId, { title, description, body });
    }),
  );

  defineTool(
    'get_plans',
    'Plans in a project with per-phase progress (done/total tasks) — see how the work program is advancing.',
    { projectId: z.string() },
    tool(async ({ projectId }) => {
      const { results: plans } = await env.DB.prepare(
        'SELECT id, agent_id AS agentId, title, description, body, created_at AS createdAt FROM plans WHERE project_id = ? ORDER BY created_at DESC',
      ).bind(projectId).all();
      const enriched = [];
      for (const p of plans) {
        const { results: phasesRows } = await env.DB.prepare(
          `SELECT ph.id, ph.title, ph.body, ph."order",
                  (SELECT COUNT(*) FROM phase_tasks pt WHERE pt.phase_id = ph.id) AS total,
                  (SELECT COUNT(*) FROM phase_tasks pt JOIN tasks t ON t.id = pt.task_id WHERE pt.phase_id = ph.id AND t.status = 'done') AS done,
                  (SELECT GROUP_CONCAT(t.key) FROM phase_tasks pt JOIN tasks t ON t.id = pt.task_id WHERE pt.phase_id = ph.id) AS taskKeys
           FROM phases ph WHERE ph.plan_id = ? ORDER BY ph."order"`,
        ).bind(p.id).all();
        enriched.push({ ...p, phases: phasesRows });
      }
      return { plans: enriched };
    }),
  );

  // ---- milestones ---------------------------------------------------------

  defineTool(
    'create_milestone',
    'Create a milestone in a project (assign tasks to it via update_task.milestoneId).',
    { projectId: z.string(), title: z.string().min(1), dueAt: z.string().datetime().optional() },
    tool(async ({ projectId, title, dueAt }) => room(env, projectId).createMilestone(projectId, actor, title, dueAt)),
  );

  // ---- git awareness (Phase 4) --------------------------------------------

  defineTool(
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

  // ---- resources: read attachment bytes back ------------------------------
  // noriq://attachment/<id> — binary comes back as base64 `blob`, text as `text`.
  resourceSpecs.push({
    name: 'attachment',
    uriTemplate: 'noriq://attachment/{id}',
    description: 'Bytes of a file attached to a task (image, log, etc.). Binary returns as base64 blob; text/json/xml/yaml as text.',
  });
  server.registerResource(
    'attachment',
    new ResourceTemplate('noriq://attachment/{id}', {
      // Discovery: recent attachments across active projects, each with its URI.
      list: async () => {
        const { results } = await env.DB.prepare(
          `SELECT a.id, a.filename, a.content_type AS ct, a.size
           FROM attachments a JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
           WHERE p.status = 'active' ORDER BY a.created_at DESC LIMIT 50`,
        ).all<{ id: string; filename: string; ct: string; size: number }>();
        return {
          resources: results.map((a) => ({
            uri: attachmentUri(a.id),
            name: a.filename,
            mimeType: a.ct,
            description: `${a.size} bytes`,
          })),
        };
      },
    }),
    { title: 'Task attachment', description: 'Bytes of a file attached to a task (image, log, etc.)' },
    async (uri, { id }) => {
      if (!env.FILES) throw new Error('attachments not configured on this instance');
      const attId = Array.isArray(id) ? id[0]! : id;
      const row = await env.DB.prepare('SELECT r2_key AS key, content_type AS ct FROM attachments WHERE id = ?')
        .bind(attId).first<{ key: string; ct: string }>();
      if (!row) throw new Error(`attachment ${attId} not found`);
      const obj = await env.FILES.get(row.key);
      if (!obj) throw new Error('file missing from storage');
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const mimeType = row.ct || 'application/octet-stream';
      // Text types come back as text so agents can read them directly; everything else as base64.
      const isText = /^text\/|^application\/(json|xml|yaml|x-yaml)/.test(mimeType);
      const content = isText
        ? { uri: uri.href, mimeType, text: new TextDecoder().decode(bytes) }
        : { uri: uri.href, mimeType, blob: bytesToBase64(bytes) };
      return { contents: [content] };
    },
  );

  // Expose the captured specs so the reference doc can be generated from them.
  (server as unknown as { specs: { tools: ToolSpec[]; resources: ResourceSpec[] } }).specs = { tools: toolSpecs, resources: resourceSpecs };
  return server;
}

/**
 * The tool/resource specs, for generating the reference doc (PLNR-23). Built with
 * stub env/agent — the specs (names/descriptions/zod schemas) are static and never
 * invoke a handler, so no DB/agent is needed. oauthTokenId is set so set_agent_identity
 * appears in the reference.
 */
export function mcpReferenceSpecs(): { tools: ToolSpec[]; resources: ResourceSpec[] } {
  const stubEnv = {} as Env;
  const stubAgent: AgentIdentity = { id: 'stub', name: 'stub', role: 'worker' } as AgentIdentity;
  const server = buildMcpServer(stubEnv, stubAgent, { oauthTokenId: 'stub' });
  return (server as unknown as { specs: { tools: ToolSpec[]; resources: ResourceSpec[] } }).specs;
}
