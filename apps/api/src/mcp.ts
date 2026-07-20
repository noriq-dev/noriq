import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from './env';
import type { AgentIdentity } from './auth';
import type { Actor } from './do/ProjectRoom';
import { computeUpdates, formatNotices } from './sync';
import { base64ToBytes, bytesToBase64, newId, nowIso, sha256Hex } from './lib/util';
import {
  TASK_NOT_IN_PROPOSED_PLAN,
  TASK_NOT_PHASE_BLOCKED,
  USER_PROJECT_WHERE,
  taskWireStatus,
  tokenCanReachProject,
  tokenProjectWhere,
  userCanAccessProject,
} from './lib/visibility';
import { taskSearchFilters } from './lib/search';
import { search, searchBackend, reindexProject } from './search';
import { nearDupeGroups } from './lib/tags';
import { DOC_SKILL_MD } from './skill-docs';
import { signUploadToken } from './lib/upload-token';
import { taskClaimability } from './lib/claimability';

const MAX_ATTACHMENT = 100 * 1024 * 1024;
// Inline base64 rides the model's context window at ~1 token/byte both ways, so it is only
// for genuinely small payloads (a log snippet, an icon). Anything real goes through
// create_attachment_upload. 16 KB ≈ 22 KB base64 ≈ ~22K tokens each way — the practical
// ceiling before it stops paying for itself (and won't round-trip under the Read cap).
const MAX_INLINE_ATTACHMENT = 16 * 1024;
const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Stable resource URI for an attachment; agents read bytes back via resources/read. */
const attachmentUri = (id: string) => `noriq://attachment/${id}`;
/** Stable resource URI for a project doc (PLNR-158). */
const docUri = (id: string) => `noriq://doc/${id}`;

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
finished. Never work on a task you have not claimed.
Tasks you create MUST carry descriptive tags (topic/area/component words like "oauth" or
"board-filters"); the FIRST tag is the primary tag. Tags are a shared filter vocabulary:
reuse existing tags before minting new ones — near-duplicates are rejected, and curated
projects accept no agent-minted tags at all. Never tag with status/type/priority
words — those have dedicated fields. Plans need no dependency wiring: phase order itself
gates tasks (a task is claimable when every earlier phase is finished); use dependsOn
only for real, hand-picked orderings.
When a project has file locking enabled (opt-in), acquire_lock the file paths you are about
to edit/create/delete/rename BEFORE you touch them — pass the whole edit's paths in ONE call
(it is all-or-nothing, so no half-held clashes), scoped to your branch, and linked to your
task so they auto-release when it settles. Re-acquiring your own paths just renews them; hold
the smallest scope that covers the edit and release_lock when done. check_locks looks without
taking. On conflict, coordinate with the holder (send_message / handoff_task) or wait — never
clobber a locked file. Git has no file locking; this is how agents avoid stepping on each other.
Project docs are the knowledge base: settled decisions and facts ONLY (enforced — a doc
with TBDs or open questions is rejected). Check a task's related docs (get_task.docs)
and list_docs before unfamiliar work; link the docs a task must follow via docIds at
creation; when you settle something durable, create_doc the outcome. Undecided things
are not docs — raise request_input, then document the answer.
Search before you file: semantic_search finds tasks, docs and plans by meaning — the
thing you are about to create may already exist. Use search_tasks for attribute filters.
You do not register yourself — you already are somebody, and get_briefing tells you who.
Its \`you.kind\` says which: a "copilot" is a human's session (registered when they
authorized this connection, and parented to it automatically), and an "agent" was created
by a runner for exactly one run, pinned to one project. Sub-agent attribution is automatic.`;

function room(env: Env, projectId: string) {
  return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
}

/**
 * Resolve a task reference — either the opaque `task_…` id or the `PLN-##` display key —
 * to its canonical id, so callers can accept whichever the agent passes. The ProjectRoom
 * is strictly id-keyed, so claim/release resolve here before crossing into it.
 */
/** The group-filing rule (PLNR-134, mirroring PLNR-93's REST rule): a user may file a
 *  project under a group only if they created the group or belong to it. No admin
 *  escalation here — an agent is scoped to its user, never to admin. Throws on an
 *  unknown group so "no such group" and "not yours" read differently. */
async function canUseGroup(env: Env, userId: string, groupId: string): Promise<boolean> {
  const g = await env.DB.prepare('SELECT created_by AS createdBy FROM groups WHERE id = ?')
    .bind(groupId).first<{ createdBy: string | null }>();
  if (!g) throw new Error(`group ${groupId} not found`);
  if (g.createdBy === userId) return true;
  return !!(await env.DB.prepare('SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?')
    .bind(userId, groupId).first());
}

async function resolveTaskId(env: Env, projectId: string, taskId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT id FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
    .bind(taskId, taskId, projectId).first<{ id: string }>();
  if (!row) throw new Error(`task ${taskId} not found in project ${projectId}`);
  return String(row.id);
}

const asActor = (a: AgentIdentity): Actor => ({ kind: 'agent', id: a.id, name: a.name });

// PLNR-171: agent-created tasks must carry descriptive tags — tags[0] is the task's
// PRIMARY tag (its main topical bucket). A tag restating status/type/priority/milestone
// is rejected: those concepts have dedicated fields, and a tag copy of them is noise
// that rots. The denylist is compared on a normalized form (lowercase, separators → '-').
const NON_DESCRIPTIVE_TAGS = new Set([
  'todo', 'in-progress', 'inprogress', 'blocked', 'review', 'in-review', 'done',
  'cancelled', 'canceled', 'backlog', 'wip', 'in-flight',
  'bug', 'feature', 'chore', 'research', 'task', 'epic', 'story', 'ticket',
  'p0', 'p1', 'p2', 'p3', 'p4', 'priority', 'high', 'medium', 'low', 'high-priority',
  'low-priority', 'urgent', 'critical', 'milestone',
]);
const TAG_GUIDANCE =
  'tags must be descriptive topic/area/component words (e.g. "oauth", "board-filters", "ws-resume"); ' +
  'the FIRST tag is the primary tag. Status, type, priority, and milestone have dedicated fields — never restate them as tags.';

/** Validate tag NAMES when present (docs: tags optional but still descriptive, PLNR-194). */
function validateTagNames(tags: string[] | undefined): void {
  for (const raw of tags ?? []) {
    const norm = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (!norm) throw new Error(`empty tag — ${TAG_GUIDANCE}`);
    if (NON_DESCRIPTIVE_TAGS.has(norm)) throw new Error(`"${raw}" is not a descriptive tag — ${TAG_GUIDANCE}`);
  }
}

function requireDescriptiveTags(tags: string[] | undefined): void {
  if (!tags?.length) throw new Error(`tags are required — ${TAG_GUIDANCE}`);
  validateTagNames(tags);
}

// MCP tool annotations (PLNR-88). Without these, clients assume the spec defaults —
// write + destructive + open-world — for every tool. Ours are more benign: reads are
// marked read-only; writes are additive/coordination edits (content deletion is
// human-only in the web app; remove_dependency is the one deliberate exception and it
// only drops a coordination edge add_dependency can recreate), so destructiveHint is
// false; some are idempotent; and everything operates on this project system, never
// the open internet, so openWorldHint is false. Unlisted tools fall back to a plain
// non-destructive write.
type ToolHints = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
const READ: ToolHints = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT: ToolHints = { ...WRITE, idempotentHint: true };
const TOOL_HINTS: Record<string, ToolHints> = {
  // reads
  get_briefing: READ, my_updates: READ, list_projects: READ, get_project: READ, list_groups: READ, list_agents: READ,
  get_task: READ, search_tasks: READ, semantic_search: READ, tag_report: READ, next_claimable: READ, read_open_comments: READ, get_plans: READ, can_claim: READ,
  list_docs: READ, get_doc: READ, update_doc: WRITE_IDEMPOTENT, list_templates: READ, get_plan_doc: READ, update_plan_doc: WRITE_IDEMPOTENT,
  check_locks: READ, list_locks: READ,
  // writes that are safe to repeat with the same args (renew/replace-in-place/insert-or-ignore)
  heartbeat: WRITE_IDEMPOTENT, set_agent_identity: WRITE_IDEMPOTENT, update_task: WRITE_IDEMPOTENT, update_tasks: WRITE_IDEMPOTENT,
  update_plan: WRITE_IDEMPOTENT, add_dependency: WRITE_IDEMPOTENT, remove_dependency: WRITE_IDEMPOTENT, attach_ref: WRITE_IDEMPOTENT,
  set_project_group: WRITE_IDEMPOTENT, reindex_search: WRITE_IDEMPOTENT,
  acquire_lock: WRITE_IDEMPOTENT, release_lock: WRITE_IDEMPOTENT,
  // everything else → WRITE (additive, non-idempotent, non-destructive, closed-world)
};

export function buildMcpServer(env: Env, agent: AgentIdentity, opts: { oauthTokenId?: string; sessionId?: string; origin?: string } = {}): McpServer {
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

  // RUN-47: a runner-spawned agent's tool floor, declared by the daemon when it created the
  // agent. Advertising the full catalogue and letting the daemon's allowlist deny on use told
  // the model a lie — it reported it COULD raise_alert because the server said so, then lost a
  // turn to the refusal. Advertise only what the daemon will permit, so its allowlist and this
  // catalogue are two views of one policy. Copilots (and agents from pre-RUN-47 daemons) carry
  // no floor and see everything, as before.
  const floor = agent.kind === 'agent' && agent.allowedTools ? new Set(agent.allowedTools) : null;

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
        // Scope every project-bearing tool to what the AGENT'S USER can reach — an
        // agent (even an admin's) never acts with admin-wide access (PLNR-83).
        const pid = args && typeof args === 'object' ? (args as { projectId?: unknown }).projectId : undefined;
        if (typeof pid === 'string' && pid && !(await userCanAccessProject(env, agent.userId, pid))) {
          throw new Error(`project ${pid} not found or not accessible to you`);
        }
        // …and then to what THIS TOKEN was authorized for (RUN-38). Two distinct limits: the
        // user's reach is who you are, the token's scope is what this particular credential
        // was granted — a laptop authorized for one project must not touch the rest of the
        // account. Enforced here, once, because every project-bearing tool funnels through
        // this wrapper; sprinkling it per-tool is how the next tool forgets.
        if (typeof pid === 'string' && pid && opts.oauthTokenId
            && !(await tokenCanReachProject(env, opts.oauthTokenId, pid))) {
          throw new Error(`project ${pid} is outside this connection's authorized projects`);
        }
        body = await fn(args);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
      const updates = await computeUpdates(env, agent, { oauthTokenId: opts.oauthTokenId });
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
    // Below the floor → not registered at all: absent from tools/list AND unknown on call,
    // one consistent answer instead of advertise-then-deny. (The reference doc is unaffected:
    // mcpReferenceSpecs builds with a floorless stub agent.)
    if (floor && !floor.has(name)) return;
    // Capture the spec at definition time so the reference doc is generated from the
    // exact same zod schemas the tools validate against — it can't drift (PLNR-23).
    toolSpecs.push({ name, description, inputSchema });
    const annotations = TOOL_HINTS[name] ?? WRITE; // PLNR-88: proper read/write/destructive hints
    // The SDK (1.29.0) accepts zod v4 at runtime (peer `^3.25 || ^4.0`) but types
    // registerTool's inputSchema against v3's fuller ZodType, so v4's leaner raw
    // shape needs a cast at this single funnel point. Runtime validation is unchanged.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return server.registerTool(name, { description, inputSchema: inputSchema as any, annotations }, cb as any);
  };

  // ---- orientation --------------------------------------------------------

  defineTool(
    'get_briefing',
    'Call this FIRST in every session. Returns the Noriq playbook plus your current state: who you are, tasks you hold, unresolved comments awaiting you, what is claimable, and recent messages.',
    {},
    tool(async () => {
      const updates = await computeUpdates(env, agent, { advanceCursor: false, oauthTokenId: opts.oauthTokenId });
      const projects = (
        await env.DB.prepare(
          `SELECT p.id, p.key, p.name, p.description, p.status FROM projects p
           WHERE p.status = 'active' AND ${USER_PROJECT_WHERE}
             AND ${tokenProjectWhere('?2')} ORDER BY p.created_at`,
        ).bind(agent.userId, opts.oauthTokenId ?? null).all()
      ).results;
      return {
        // `kind` is what an identity most needs to know about itself (0026): a copilot is a
        // human's session and may roam between projects; an agent is runner-owned, pinned to
        // one project for life, and expected to stay reachable.
        you: { id: agent.id, name: agent.name, role: agent.role, kind: agent.kind },
        playbook: [
          'You already have an identity — `you` above is it, and `you.kind` says whether you are a human\'s copilot or a runner-spawned agent. Nothing to register. Work loop: my_updates → pick from claimable (or next_claimable) → claim_task (just the one you are about to start) → do the work → resolve any comments → release_task {toStatus:"review"|"done"}. Every tool call renews your claim, so no periodic pinging — heartbeat only if you will be idle longer than the claim TTL.',
          'Humans steer via comments on tasks (kind: question/instruction). Acknowledge fast, resolve with resolve_comment (addressed|wont_do) + a reply. Unresolved comments should block you from finishing.',
          'Anything bigger than one task: plan first. create_plan writes the plan as a document — goals/approach in the body, then ordered phases over tasks. Phase order itself gates the work (tasks in phase N are claimable once every earlier phase is finished — no dependency wiring needed); or decompose_task for a quick subtree. Workers drain the plan via next_claimable; keep it current with update_plan.',
          'Tasks you create MUST carry descriptive tags — topic/area/component words (e.g. "oauth", "board-filters"), FIRST tag = primary tag. Tags are the project\'s SHARED filter vocabulary: reuse existing tags (get_project.tags) before minting — near-duplicates are rejected, and some projects are curated (agents cannot mint at all). Never status/type/priority words as tags. Use dependsOn only for real, hand-picked orderings.',
          'Project docs are settled decisions and facts ONLY (enforced — open questions/TBDs are rejected). Read a task\'s related docs (get_task.docs) before starting; link the docs new tasks must follow via docIds; when you settle something durable, create_doc the outcome. Undecided → request_input first, then document the answer.',
          'Search before you file or dig: semantic_search finds tasks, docs and plans by MEANING (the thing you are about to create may already exist); search_tasks filters by attributes. Prefer them over dumping get_project in large projects.',
          'Claims are exclusive. If claim_task fails, the task is taken or blocked — pick another.',
          'When a project has file locking ON (opt-in), acquire_lock the file(s) you are about to edit/create/rename BEFORE touching them — all paths in ONE all-or-nothing call, scoped to your branch and linked to your task (they auto-release when it settles). Re-acquiring your own paths renews them; check_locks to look without taking; release_lock when done. On conflict, coordinate with the holder or wait — never clobber a locked file. Git has no file locking; this is how agents avoid stepping on each other.',
          'Blocked on a human decision? request_input (it auto-parks the task and frees you to work elsewhere) — do not guess or stall. Batch every question the decision needs into its typed `questions` (select/multi/text/number/confirm) in ONE gate; thread a genuine follow-up round with followUpTo. Flag non-blocking concerns (deviations, risks) with raise_alert and keep going.',
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
    tool(async () => computeUpdates(env, agent, { oauthTokenId: opts.oauthTokenId })),
  );

  if (opts.oauthTokenId) {
    defineTool(
      'set_agent_identity',
      'RENAME the identity you already have — it does NOT create one, and you never need it to start working. You are registered already (a copilot when your human authorized this connection; an agent when a runner spawned you), your parent is set automatically, and get_briefing tells you who you are. Use this only to swap the auto-generated label for one that reads better in a project — names are unique per project. projectId localizes a copilot to a project (a runner-spawned agent is already pinned and should not move).',
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
        // Read the parent back rather than echoing the argument: it is COALESCEd above, and
        // since PLNR-155 a copilot already HAS a parent (its connection). Echoing `?? null`
        // would report an orphan for every rename that didn't happen to pass one.
        const after = await env.DB.prepare('SELECT parent_agent_id AS parentAgentId, project_id AS projectId FROM agents WHERE id = ?')
          .bind(agent.id).first<{ parentAgentId: string | null; projectId: string | null }>();
        return {
          actingAs: { id: agent.id, name, role: newRole },
          project: after?.projectId ?? null,
          parentAgentId: after?.parentAgentId ?? null,
          note: 'renamed — this identity now reads as that label; you were already this agent',
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
         FROM projects p WHERE p.status = 'active' AND ${USER_PROJECT_WHERE}
           AND ${tokenProjectWhere('?2')} ORDER BY p.created_at`,
      ).bind(agent.userId, opts.oauthTokenId ?? null).all();
      return { projects: results };
    }),
  );

  defineTool(
    'create_project',
    'Create a project. key is the short task-key prefix (e.g. "PLN" → PLN-1, PLN-2…). Pass groupId (see list_groups) to file it under a group at birth — grouping SHARES the project with that group\'s members.',
    {
      key: z.string().min(1).max(8).regex(/^[A-Z][A-Z0-9]*$/, 'uppercase letters/digits'),
      name: z.string().min(1),
      description: z.string().optional(),
      repoUrl: z.string().url().optional(),
      groupId: z.string().optional().describe('Group to file the project under — you must be its creator or a member'),
    },
    tool(async (args) => {
      // Same rule as the dashboard's group move (PLNR-93), minus the admin escalation —
      // an agent is scoped to its user, never to admin: you may file a project into a
      // group only if you created that group or already belong to it.
      if (args.groupId && !(await canUseGroup(env, agent.userId, args.groupId))) {
        throw new Error('you must be a member or the creator of the target group');
      }
      // Random id, NOT prj_<key> (PLNR-106): a key-derived id is a cross-tenant existence
      // oracle (guess prj_acme to learn ACME exists) and lowers the bar for any missing-
      // projectId authz gap. key stays a label; the id is unguessable and looked up, never derived.
      const id = newId('prj');
      await env.DB.prepare(
        `INSERT INTO projects (id, key, name, description, status, repo_url, claim_ttl_seconds, owner_user_id, group_id, created_at) VALUES (?, ?, ?, ?, 'active', ?, 1800, ?, ?, ?)`,
      ).bind(id, args.key, args.name, args.description ?? '', args.repoUrl ?? null, agent.userId, args.groupId ?? null, nowIso()).run();
      await room(env, id).createMilestone(id, actor, 'Backlog');
      await room(env, id).createBoard(id, actor, 'Main');
      // A scoped token joins the project it just created to its own scope (RUN-38). Otherwise
      // create_project is a trap: it succeeds and returns an id the caller is then refused
      // access to. This does let a scoped token widen itself — but only to projects it creates
      // itself, under its own user, never to one that already existed. That is the line between
      // bootstrapping and escalation, and it is what lets a token scoped to NOTHING (a
      // brand-new user's first connection) get started at all.
      // An "All projects" token (RUN-58) is excluded: it already reaches this, by asking its
      // user rather than reading these rows, so a row here would be dead weight that also
      // misreports the grant as a frozen list.
      if (opts.oauthTokenId) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO oauth_token_projects (token_id, project_id)
           SELECT ?1, ?2 WHERE EXISTS (
             SELECT 1 FROM oauth_tokens WHERE id = ?1 AND scoped_at IS NOT NULL AND scope_all = 0)`,
        ).bind(opts.oauthTokenId, id).run();
      }
      return { id, key: args.key };
    }),
  );

  defineTool(
    'list_agents',
    'Who else is on this project: active agents with role/kind, parent attribution (sub-agents), liveness, and the tasks each one holds right now. Use it to coordinate — find the orchestrator, see who owns what, resolve a name to the agent id that send_message needs. `you` marks your own entry.',
    { projectId: z.string(), includeRevoked: z.boolean().optional().describe('Also list revoked agents (default false)') },
    tool(async ({ projectId, includeRevoked }) => {
      const [{ results: agents }, { results: heldRows }] = await Promise.all([
        env.DB.prepare(
          `SELECT a.id, COALESCE(a.label, a.name) AS name, a.role, a.kind, a.status,
                  a.parent_agent_id AS parentAgentId, a.last_seen_at AS lastSeenAt
           FROM agents a WHERE a.project_id = ?${includeRevoked ? '' : " AND a.status != 'revoked'"}
           ORDER BY a.created_at`,
        ).bind(projectId).all<{ id: string; name: string; role: string; kind: string; status: string; parentAgentId: string | null; lastSeenAt: string | null }>(),
        env.DB.prepare(
          'SELECT t.claimed_by AS agentId, t.key, t.title, t.status FROM tasks t WHERE t.project_id = ? AND t.claimed_by IS NOT NULL',
        ).bind(projectId).all<{ agentId: string; key: string; title: string; status: string }>(),
      ]);
      const held = new Map<string, Array<{ key: string; title: string; status: string }>>();
      for (const h of heldRows) held.set(h.agentId, [...(held.get(h.agentId) ?? []), { key: h.key, title: h.title, status: h.status }]);
      return {
        agents: agents.map((a) => ({ ...a, you: a.id === agent.id, heldTasks: held.get(a.id) ?? [] })),
      };
    }),
  );

  defineTool(
    'set_project_group',
    'File a project under a group, or null to ungroup it. Grouping SHARES the project: every member of the group can then see and work it; ungrouping narrows it back to its owner. You must be the group\'s creator or a member (see list_groups).',
    { projectId: z.string(), groupId: z.string().nullable().describe('Target group id, or null to ungroup') },
    tool(async ({ projectId, groupId }) => {
      if (!(await userCanAccessProject(env, agent.userId, projectId))) {
        throw new Error(`project ${projectId} not found`);
      }
      if (groupId !== null && !(await canUseGroup(env, agent.userId, groupId))) {
        throw new Error('you must be a member or the creator of the target group');
      }
      await env.DB.prepare('UPDATE projects SET group_id = ? WHERE id = ?').bind(groupId, projectId).run();
      return { ok: true, projectId, groupId };
    }),
  );

  defineTool(
    'list_groups',
    'Groups in this instance, with whether you can file projects under each (creator or member). Resolve a group name to the id create_project/set_project_group need.',
    {},
    tool(async () => {
      const { results } = await env.DB.prepare(
        `SELECT g.id, g.name,
                (g.created_by = ?1) AS mine,
                EXISTS (SELECT 1 FROM user_groups ug WHERE ug.group_id = g.id AND ug.user_id = ?1) AS member
         FROM groups g ORDER BY g.name`,
      ).bind(agent.userId).all<{ id: string; name: string; mine: number; member: number }>();
      return { groups: results.map((g) => ({ id: g.id, name: g.name, usable: !!g.mine || !!g.member })) };
    }),
  );

  defineTool(
    'save_template',
    'Save a reusable work template — a plan skeleton (title/body/taskDefaults/phases with newTasks) you can stamp into ANY project later with create_plan_from_template. Save the shapes your team repeats: "ship a feature", "security review", "release checklist". Templates are yours (user-owned), not project-bound.',
    {
      name: z.string().min(1).max(80),
      description: z.string().max(300).optional(),
      spec: z.object({
        title: z.string().min(1).describe('Default plan title (instantiation may override)'),
        description: z.string().optional(),
        body: z.string().optional().describe('The plan document (markdown)'),
        taskDefaults: z.object({
          priority: z.number().int().min(0).max(4).optional(),
          estimate: z.number().int().min(0).optional(),
          type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
          tags: z.array(z.string()).optional(),
        }).optional(),
        phases: z.array(z.object({
          title: z.string().min(1),
          body: z.string().optional(),
          newTasks: z.array(z.object({
            title: z.string().min(1),
            body: z.string().optional(),
            priority: z.number().int().min(0).max(4).optional(),
            estimate: z.number().int().min(0).optional(),
            type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
            tags: z.array(z.string()).optional(),
          })).min(1),
        })).min(1).max(12),
      }).describe('The skeleton — same shape create_plan takes, minus concrete ids (no taskIds/milestones: those are per-project)'),
    },
    tool(async ({ name, description, spec }) => {
      const id = newId('tpl');
      await env.DB.prepare('INSERT INTO templates (id, user_id, name, description, spec) VALUES (?, ?, ?, ?, ?)')
        .bind(id, agent.userId, name, description ?? '', JSON.stringify(spec)).run();
      return { id, name };
    }),
  );

  defineTool(
    'list_templates',
    'Your saved work templates (name + description + shape summary). Instantiate one with create_plan_from_template.',
    {},
    tool(async () => {
      const { results } = await env.DB.prepare(
        'SELECT id, name, description, spec, updated_at AS updatedAt FROM templates WHERE user_id = ? ORDER BY updated_at DESC',
      ).bind(agent.userId).all<{ id: string; name: string; description: string; spec: string; updatedAt: string }>();
      return {
        templates: results.map((t) => {
          const spec = JSON.parse(t.spec) as { phases: Array<{ title: string; newTasks: unknown[] }> };
          return {
            id: t.id, name: t.name, description: t.description, updatedAt: t.updatedAt,
            phases: spec.phases.map((p) => ({ title: p.title, tasks: p.newTasks.length })),
          };
        }),
      };
    }),
  );

  defineTool(
    'create_plan_from_template',
    'Stamp a saved template into a project as a live plan (enforced phase ordering and all). Optionally override the title or park it as proposed for human approval.',
    {
      projectId: z.string(),
      templateId: z.string(),
      title: z.string().optional().describe('Override the template\'s default plan title'),
      proposed: z.boolean().optional(),
    },
    tool(async ({ projectId, templateId, title, proposed }) => {
      const row = await env.DB.prepare('SELECT spec FROM templates WHERE id = ? AND user_id = ?')
        .bind(templateId, agent.userId).first<{ spec: string }>();
      if (!row) throw new Error(`template ${templateId} not found`);
      const spec = JSON.parse(row.spec) as {
        title: string; description?: string; body?: string;
        taskDefaults?: { priority?: number; estimate?: number; type?: string; tags?: string[] };
        phases: Array<{ title: string; body?: string; newTasks: Array<{ title: string; body?: string; priority?: number; estimate?: number; type?: string; tags?: string[] }> }>;
      };
      return room(env, projectId).createPlan(projectId, actor, {
        title: title ?? spec.title,
        description: spec.description,
        body: spec.body,
        proposed,
        agentId: agent.id,
        taskDefaults: spec.taskDefaults,
        phases: spec.phases,
      });
    }),
  );

  defineTool(
    'list_docs',
    'The project\'s knowledge base: settled design decisions, conventions, architecture facts. CHECK IT before working unfamiliar ground — a task\'s related docs (get_task.docs) plus this index are your ground truth. Each doc carries tags (the same vocabulary as task tags — filter with `tag`) and a folder path (human organization only; never needed to address a doc, its id does that). Returns name + description + folder + tags + linkedTasks count; read a body with get_doc. Docs here are trustworthy BY CONTRACT: they contain only explicit decisions and facts, never open questions.',
    {
      projectId: z.string(),
      tag: z.string().optional().describe('Only docs carrying this tag (exact name, case-insensitive)'),
      folder: z.string().optional().describe('Only docs in this folder (exact path) and its subfolders'),
    },
    tool(async ({ projectId, tag, folder }) => {
      const binds: unknown[] = [projectId];
      let where = 'd.project_id = ?';
      if (tag) {
        where += ' AND EXISTS (SELECT 1 FROM doc_tags dt JOIN tags g ON g.id = dt.tag_id WHERE dt.doc_id = d.id AND g.name = ?)';
        binds.push(tag.trim().toLowerCase());
      }
      if (folder) {
        const f = String(folder).split('/').map((s: string) => s.trim()).filter(Boolean).join('/');
        where += ' AND (d.folder = ? OR d.folder LIKE ?)';
        binds.push(f, `${f}/%`);
      }
      const { results } = await env.DB.prepare(
        `SELECT d.id, d.name, d.description, d.folder, d.author_name AS authorName, d.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM task_docs td WHERE td.doc_id = d.id) AS linkedTasks,
                (SELECT GROUP_CONCAT(g.name) FROM doc_tags dt JOIN tags g ON g.id = dt.tag_id WHERE dt.doc_id = d.id) AS tags
         FROM docs d WHERE ${where} ORDER BY d.folder, d.updated_at DESC`,
      ).bind(...binds).all();
      return { docs: results.map((d) => ({ ...d, tags: d.tags ? String(d.tags).split(',') : [], resource: docUri(String(d.id)) })) };
    }),
  );

  defineTool(
    'get_doc',
    'Read a project doc in full (markdown), plus the tasks that cite it (linkedTasks). What it states is settled — build to it; if reality has moved on, update_doc it to the new truth rather than silently deviating. Accepts the doc id from list_docs.',
    { projectId: z.string(), docId: z.string() },
    tool(async ({ projectId, docId }) => {
      const doc = await env.DB.prepare(
        `SELECT d.id, d.name, d.description, d.body, d.folder, d.author_name AS authorName, d.updated_at AS updatedAt,
                (SELECT GROUP_CONCAT(g.name) FROM doc_tags dt JOIN tags g ON g.id = dt.tag_id WHERE dt.doc_id = d.id) AS tags
         FROM docs d WHERE d.id = ? AND d.project_id = ?`,
      ).bind(docId, projectId).first();
      if (!doc) throw new Error(`doc ${docId} not found in this project`);
      doc.tags = doc.tags ? String(doc.tags).split(',') : [];
      const { results: tasks } = await env.DB.prepare(
        `SELECT t.id, t.key, t.title, ${taskWireStatus('t')} AS status
         FROM task_docs td JOIN tasks t ON t.id = td.task_id WHERE td.doc_id = ? ORDER BY t.key`,
      ).bind(docId).all();
      return { ...doc, resource: docUri(String(doc.id)), linkedTasks: tasks };
    }),
  );

  defineTool(
    'create_doc',
    'Record a SETTLED decision or established fact as a project doc (markdown). FIRST doc of your session? Read the authoring guide first — resources/read noriq://skill/doc-authoring (or GET /skill/docs.md) — it covers what belongs in a doc, the shapes that work, and placement. The contract (enforced): docs are static, complete entities stating explicit design decisions and facts — no TBD/TODO, no open questions, no "we should discuss". An undecided point is never encoded as fact: settle it (request_input) if it blocks the doc\'s central claim, or scope the doc to exclude it and ship what IS settled. Give it a clear name and one-line description (the pair future agents scan in list_docs), and link it to the tasks that implement it via create_task/update_task docIds. For revising an existing doc use update_doc.',
    {
      projectId: z.string(),
      name: z.string().min(1).max(120),
      description: z.string().max(300).optional().describe('One line: what a reader finds inside'),
      body: z.string().optional().describe('The document, markdown'),
      folder: z.string().max(200).optional().describe('Folder path for human browsing, e.g. "design/networking" — organizational only, the doc is always addressed by its id. Reuse existing folders (see list_docs) before minting new ones.'),
      tags: z.array(z.string()).optional().describe('1-3 tags from the project vocabulary (get_project.tags / list_docs) — tags are shared FILTERS, so reuse before minting (near-duplicates are rejected) and only tag with words that group 3+ items. Never restate the folder or the title as a tag; finding one specific doc is semantic search\'s job.'),
      allowNewTags: z.boolean().optional().describe('Mint a tag the near-duplicate guard flagged — only for genuinely distinct concepts'),
    },
    tool(async ({ projectId, name, description, body, folder, tags, allowNewTags }) => {
      validateTagNames(tags);
      return room(env, projectId).createDoc(projectId, actor, { name, description, body, folder, tags, allowNewTags });
    }),
  );

  defineTool(
    'update_doc',
    'Revise a project doc to the CURRENT truth — pass the FULL new body (read it first via get_doc). A stale doc misleads every agent that reads it; when a decision changes, the doc changes with it, stating the new decision (not the deliberation). The same contract as create_doc is enforced: decisions and facts only, nothing open-ended — for a substantial rewrite, read the authoring guide first (resources/read noriq://skill/doc-authoring).',
    {
      projectId: z.string(),
      docId: z.string(),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(300).optional(),
      body: z.string().optional().describe('Full replacement markdown'),
      folder: z.string().max(200).optional().describe('Move the doc to this folder path ("" = root) — organizational only, links and ids are unaffected'),
      tags: z.array(z.string()).optional().describe('REPLACES the tag set ([] clears) — prefer addTags/removeTags for edits. Reuse the project vocabulary; near-duplicates are rejected.'),
      addTags: z.array(z.string()).optional().describe('Add these tags, keeping existing ones'),
      removeTags: z.array(z.string()).optional().describe('Remove these tags, keeping the rest'),
      allowNewTags: z.boolean().optional().describe('Mint a tag the near-duplicate guard flagged — only for genuinely distinct concepts'),
    },
    tool(async ({ projectId, docId, name, description, body, folder, tags, addTags, removeTags, allowNewTags }) => {
      validateTagNames(tags);
      validateTagNames(addTags);
      return room(env, projectId).updateDoc(projectId, actor, docId, { name, description, body, folder, tags, addTags, removeTags, allowNewTags });
    }),
  );

  defineTool(
    'get_project',
    'Full project snapshot: every task (status/holder/deps/board/open-comment counts), milestones, boards, tags, the docs index, and agents active here. Heavy — use it to orient once or to resolve ids (boards, milestones, tags); for "find the thing about X" use semantic_search, and for filtered task lists use search_tasks.',
    { projectId: z.string() },
    tool(async ({ projectId }) => {
      const [tasks, milestones, boards, project, categories, docs] = await Promise.all([
        env.DB.prepare(
          `SELECT t.id, t.key, t.title, ${taskWireStatus('t')} AS status, t.failed_at AS failedAt, t.type, t.priority, t.claimed_by AS claimedBy, t.parent_task_id AS parentTaskId,
                  t.milestone_id AS milestoneId, t.board_id AS boardId, t.open_comments AS openComments, t.claim_expires_at AS claimExpiresAt,
                  (SELECT GROUP_CONCAT(dt.key) FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = t.id) AS dependsOn,
                  (SELECT GROUP_CONCAT(g.name) FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id) AS tags
           FROM tasks t WHERE t.project_id = ? ORDER BY t."order"`,
        ).bind(projectId).all(),
        env.DB.prepare('SELECT id, title, due_at AS dueAt, description FROM milestones WHERE project_id = ? ORDER BY "order"').bind(projectId).all(),
        env.DB.prepare('SELECT id, name FROM boards WHERE project_id = ? ORDER BY "order", created_at').bind(projectId).all(),
        env.DB.prepare('SELECT id, key, name, description, repo_url AS repoUrl, claim_ttl_seconds AS claimTtlSeconds FROM projects WHERE id = ?')
          .bind(projectId).first(),
        env.DB.prepare('SELECT id, name, color FROM tags WHERE project_id = ? ORDER BY "order"').bind(projectId).all(),
        env.DB.prepare('SELECT id, name, description, updated_at AS updatedAt FROM docs WHERE project_id = ? ORDER BY updated_at DESC').bind(projectId).all(),
      ]);
      if (!project) throw new Error(`project ${projectId} not found`);
      return { project, milestones: milestones.results, boards: boards.results, tags: categories.results, tasks: tasks.results, docs: docs.results };
    }),
  );

  // ---- tasks --------------------------------------------------------------

  defineTool(
    'create_task',
    'Create ONE task. `tags` is REQUIRED: 1+ descriptive topic/area tags, FIRST tag = primary (e.g. ["oauth", "token-refresh"]) — never status/type/priority words, those have dedicated fields. Set everything at creation: docIds for the design docs it must follow, boardId for placement, parentTaskId for a decomposition tree, dependsOn (task ids or keys in this project) to gate order. Before filing, semantic_search — the task may already exist. Creating several tasks? Use create_tasks (one call, shared defaults); structuring multi-phase work? create_plan. New tasks start as todo.',
    {
      projectId: z.string(),
      title: z.string().min(1),
      body: z.string().optional(),
      parentTaskId: z.string().optional(),
      milestoneId: z.string().optional(),
      priority: z.number().int().min(0).max(4).optional(),
      estimate: z.number().int().min(0).optional().describe('Effort estimate in points (team-defined scale)'),
      dueAt: z.string().datetime().optional().describe('Deadline (ISO datetime) — overdue tasks are surfaced to humans'),
      dependsOn: z.array(z.string()).optional().describe('Existing task ids or display keys in THIS project this task must wait on; cross-project or unknown refs are rejected'),
      // Optional in the schema so a missing value reaches the handler's instructive error
      // (protocol-level zod failures are generic); the contract is REQUIRED (PLNR-171).
      tags: z.array(z.string()).optional().describe('REQUIRED. Descriptive topic/area tags, primary first (e.g. ["oauth", "token-refresh"]). REUSE the project vocabulary (get_project.tags) — a tag is a shared filter, not a per-task keyword, and near-duplicates of existing tags are rejected. Never status/type/priority/milestone words.'),
      allowNewTags: z.boolean().optional().describe('Mint a tag the near-duplicate guard flagged — only when it is genuinely a distinct concept, not a variant spelling'),
      type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
      boardId: z.string().optional().describe('Board to place the task on (see get_project.boards); defaults to the parent task’s board for subtasks, else the project’s default board'),
      docIds: z.array(z.string()).optional().describe('Related project docs (ids from list_docs) — link the design/decision docs this task implements or must follow, so workers read them before starting'),
    },
    tool(async ({ projectId, ...input }) => {
      requireDescriptiveTags(input.tags);
      return room(env, projectId).createTask(projectId, actor, input);
    }),
  );

  defineTool(
    'create_tasks',
    'Create MANY tasks in one call — the batch form of create_task, for building a backlog or a plan\'s inventory without one call per task. Every item needs descriptive `tags` (its own, or via `defaults.tags`; first tag = primary, never status/type/priority words). `defaults` fills fields every item shares (per-item values win). Give items a `ref` (any string unique in the batch) and read ids back by ref instead of by position; later items may name an earlier item\'s ref in dependsOn/parentTaskId. Items are created in order and a failed item does NOT roll back earlier ones — check each result for `error`.',
    {
      projectId: z.string(),
      defaults: z.object({
        milestoneId: z.string().optional(),
        boardId: z.string().optional(),
        priority: z.number().int().min(0).max(4).optional(),
        estimate: z.number().int().min(0).optional(),
        dueAt: z.string().datetime().optional(),
        type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
        tags: z.array(z.string()).optional(),
        docIds: z.array(z.string()).optional(),
      }).optional().describe('Shared fields applied to every item unless the item sets its own'),
      allowNewTags: z.boolean().optional().describe('Applies to every item: mint tags the near-duplicate guard flagged'),
      tasks: z.array(
        z.object({
          ref: z.string().optional().describe('Caller-chosen handle, echoed back and addressable from later items\' dependsOn/parentTaskId'),
          title: z.string().min(1),
          body: z.string().optional(),
          priority: z.number().int().min(0).max(4).optional(),
          estimate: z.number().int().min(0).optional(),
          dueAt: z.string().datetime().optional(),
          milestoneId: z.string().optional(),
          boardId: z.string().optional(),
          docIds: z.array(z.string()).optional().describe('Related project docs (ids from list_docs)'),
          type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
          tags: z.array(z.string()).optional(),
          parentTaskId: z.string().optional().describe('Existing task id/key, or an earlier item\'s ref'),
          dependsOn: z.array(z.string()).optional().describe('Existing task ids/keys, or earlier items\' refs'),
        }),
      ).min(1).max(100),
    },
    tool(async ({ projectId, defaults, allowNewTags, tasks }) => {
      const r = room(env, projectId);
      const byRef = new Map<string, string>(); // ref → created task id
      // Resolve a dependsOn/parent entry: batch ref first, then id-or-key in this project.
      const resolve = async (entry: string): Promise<string> => {
        const fromBatch = byRef.get(entry);
        if (fromBatch) return fromBatch;
        const t = await env.DB.prepare('SELECT id FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
          .bind(entry, entry, projectId).first<{ id: string }>();
        if (!t) throw new Error(`"${entry}" is neither an earlier ref in this batch nor a task in this project`);
        return t.id;
      };
      const created: Array<{ ref?: string; title: string; id?: string; key?: string; error?: string }> = [];
      for (const item of tasks) {
        try {
          // PLNR-171: every item needs descriptive tags (its own, or the batch defaults).
          // Checked per item so one untagged entry fails alone, matching batch semantics.
          const effectiveTags = item.tags ?? defaults?.tags;
          requireDescriptiveTags(effectiveTags);
          const dependsOn = await Promise.all((item.dependsOn ?? []).map(resolve));
          const parentTaskId = item.parentTaskId ? await resolve(item.parentTaskId) : undefined;
          const res = await r.createTask(projectId, actor, {
            title: item.title,
            body: item.body,
            priority: item.priority ?? defaults?.priority,
            estimate: item.estimate ?? defaults?.estimate,
            dueAt: item.dueAt ?? defaults?.dueAt,
            milestoneId: item.milestoneId ?? defaults?.milestoneId,
            boardId: item.boardId ?? defaults?.boardId,
            docIds: item.docIds ?? defaults?.docIds,
            type: item.type ?? defaults?.type,
            tags: effectiveTags,
            allowNewTags,
            parentTaskId,
            dependsOn,
          });
          if (item.ref) byRef.set(item.ref, res.id);
          created.push({ ref: item.ref, title: item.title, id: res.id, key: res.key });
        } catch (e) {
          created.push({ ref: item.ref, title: item.title, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const failed = created.filter((c) => c.error).length;
      return { created, count: created.length - failed, failed };
    }),
  );

  defineTool(
    'decompose_task',
    'Orchestrator tool: create several subtasks of a parent in one call. Each subtask may depend on earlier ones by index (dependsOnIndex) to express ordering. Subtasks land on the parent\'s board unless a subtask sets its own boardId.',
    {
      projectId: z.string(),
      parentTaskId: z.string(),
      subtasks: z.array(
        z.object({
          title: z.string().min(1),
          body: z.string().optional(),
          priority: z.number().int().min(0).max(4).optional(),
          boardId: z.string().optional().describe('Board for this subtask (see get_project.boards); defaults to the parent task\'s board'),
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
        created.push(await r.createTask(projectId, actor, { title: st.title, body: st.body, parentTaskId, priority: st.priority, boardId: st.boardId, dependsOn }));
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
      estimate: z.number().int().min(0).nullable().optional().describe('Effort estimate in points; null clears it'),
      dueAt: z.string().datetime().nullable().optional().describe('Deadline (ISO datetime); null clears it'),
      milestoneId: z.string().optional(),
      tags: z.array(z.string()).optional().describe('REPLACES the tag set (auto-created; [] clears) — prefer addTags/removeTags for edits'),
      addTags: z.array(z.string()).optional().describe('Add these tags, keeping existing ones (auto-created if new)'),
      removeTags: z.array(z.string()).optional().describe('Remove these tags, keeping the rest (unknown names ignored)'),
      type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
      boardId: z.string().optional().describe('Move the task to another board (see get_project.boards)'),
      parentTaskId: z.string().nullable().optional().describe('Re-parent under another task (id or key); null detaches it to a root. Lets you build the tree after creating tasks in key order.'),
      docIds: z.array(z.string()).optional().describe('REPLACES the related-doc set (ids from list_docs; [] clears) — prefer addDocIds/removeDocIds for edits'),
      addDocIds: z.array(z.string()).optional().describe('Link these docs, keeping existing links'),
      removeDocIds: z.array(z.string()).optional().describe('Unlink these docs, keeping the rest'),
      allowNewTags: z.boolean().optional().describe('Mint a tag the near-duplicate guard flagged — only for genuinely distinct concepts'),
    },
    tool(async ({ projectId, taskId, ...patch }) => {
      // A runner-spawned agent must not move its task's status (PLNR-192). RUN-83 took
      // release_task off the build floor so the RUN's terminal outcome owns the move
      // (settleAnchorTask: gate passed → review, failed → failed) — but this field was the
      // adjacent door: a builder that "finished" moved its task to review, the gate then
      // failed, and the settle's don't-stomp-a-human guard left the task stranded in review.
      // Same discriminator as the RUN-47 tool floor; copilots and humans are unchanged.
      if (agent.kind === 'agent' && patch.status !== undefined) {
        throw new Error(
          "run agents don't set task status: your run's outcome moves the task when it ends " +
            '(gate passed → review, failed → failed). Drop the status field; the other edits are fine.',
        );
      }
      return room(env, projectId).updateTask(projectId, actor, await resolveTaskId(env, projectId, taskId), patch);
    }),
  );

  defineTool(
    'update_tasks',
    'Apply ONE change to MANY tasks — bulk re-tag, re-prioritize, move to a milestone/board, or supervisor-style bulk status. `set` is applied to every task in taskIds (ids or keys); results are per-task, and one failure does not stop the rest. For tags, addTags/removeTags edit without clobbering; `tags` replaces outright.',
    {
      projectId: z.string(),
      taskIds: z.array(z.string()).min(1).max(100).describe('Task ids or display keys'),
      set: z.object({
        status: z.enum(['todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled']).optional(),
        priority: z.number().int().min(0).max(4).optional(),
        estimate: z.number().int().min(0).nullable().optional(),
        dueAt: z.string().datetime().nullable().optional(),
        milestoneId: z.string().nullable().optional(),
        boardId: z.string().optional(),
        type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
        tags: z.array(z.string()).optional(),
        addTags: z.array(z.string()).optional(),
        removeTags: z.array(z.string()).optional(),
        parentTaskId: z.string().nullable().optional(),
      }).describe('The change applied to every task'),
    },
    tool(async ({ projectId, taskIds, set }) => {
      if (!Object.keys(set).length) throw new Error('set is empty — nothing to apply');
      const r = room(env, projectId);
      const results: Array<{ taskId: string; key?: string; ok: boolean; error?: string }> = [];
      for (const tid of taskIds) {
        try {
          // Spread per task: updateTask mutates its patch object (deletes tag fields).
          const res = await r.updateTask(projectId, actor, await resolveTaskId(env, projectId, tid), { ...set });
          results.push({ taskId: tid, key: res.key, ok: true });
        } catch (e) {
          results.push({ taskId: tid, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const failed = results.filter((x) => !x.ok).length;
      return { results, count: results.length - failed, failed };
    }),
  );

  defineTool(
    'get_task',
    'Full task detail including body, dependencies, comments (open first), git refs, related docs (READ them before starting — they carry the design decisions the task must follow), and claim state.',
    { taskId: z.string() },
    tool(async ({ taskId }) => {
      const task = await env.DB.prepare(
        `SELECT t.*, t.claimed_by AS claimedBy, t.claim_expires_at AS claimExpiresAt, t.open_comments AS openComments
         FROM tasks t WHERE t.id = ? OR t.key = ?`,
      ).bind(taskId, taskId).first();
      if (!task) throw new Error(`task ${taskId} not found`);
      // Scope to the agent's user (get_task takes only a taskId — check its project).
      if (!(await userCanAccessProject(env, agent.userId, String(task.project_id)))) {
        throw new Error(`task ${taskId} not found`);
      }
      // Derived status (PLNR-178): SELECT t.* gives the raw column; render 'failed' from failed_at.
      if (task.failed_at) task.status = 'failed';
      task.failedAt = task.failed_at;
      const id = String(task.id);
      const [deps, comments, refs, attachments, signals, docs] = await Promise.all([
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
          `SELECT id, type, severity, title, body, options, questions, status, response, response_json AS responseJson,
                  follow_up_to AS followUpTo, created_at AS createdAt, resolved_at AS resolvedAt
           FROM signals WHERE task_id = ? ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC`,
        ).bind(id).all(),
        env.DB.prepare(
          `SELECT d.id, d.name, d.description FROM task_docs td JOIN docs d ON d.id = td.doc_id WHERE td.task_id = ? ORDER BY d.name`,
        ).bind(id).all(),
      ]);
      // Each attachment carries its resource URI — read the bytes with resources/read.
      const withUris = attachments.results.map((a) => ({ ...a, resource: attachmentUri(String(a.id)) }));
      const sigs = signals.results.map((s) => ({
        ...s,
        options: s.options ? JSON.parse(String(s.options)) : null,
        questions: s.questions ? JSON.parse(String(s.questions)) : null,
        responseJson: s.responseJson ? JSON.parse(String(s.responseJson)) : null,
      }));
      const relatedDocs = docs.results.map((d) => ({ ...d, resource: docUri(String(d.id)) }));
      return { task, dependencies: deps.results, comments: comments.results, refs: refs.results, attachments: withUris, signals: sigs, docs: relatedDocs };
    }),
  );

  defineTool(
    'handoff_task',
    'Hand a task to a NAMED agent instead of releasing it into the pool — the directed form of delegation. Works on a task you hold (transfer) or an unclaimed claimable one (pre-assign); never steals another agent\'s claim. The target becomes the real holder with a fresh TTL (so a no-show just requeues normally) and is told via notices, with your `note` as the handoff briefing. Resolve names to ids with list_agents.',
    {
      projectId: z.string(),
      taskId: z.string().describe('Task id or display key'),
      toAgentId: z.string(),
      note: z.string().optional().describe('Briefing for the receiving agent — context, what is done, what remains'),
    },
    tool(async ({ projectId, taskId, toAgentId, note }) =>
      room(env, projectId).handoffTask(projectId, actor, await resolveTaskId(env, projectId, taskId), toAgentId, note)),
  );

  defineTool(
    'move_task',
    'Re-home a task into another project — same task row, new key, so comments/attachments/refs/history ride along. The move severs what cannot cross a project boundary: dependency edges (count reported back), plan phase membership, milestone, parent; the board becomes the target\'s default; tag NAMES carry over and re-resolve there. Refused while the task is claimed or has subtasks. Makes the "which project should this live in" decision reversible instead of delete-and-retype.',
    { projectId: z.string(), taskId: z.string().describe('Task id or display key'), toProjectId: z.string() },
    tool(async ({ projectId, taskId, toProjectId }) => {
      // The per-call guard covers projectId; the TARGET needs the same two checks or a
      // narrow token could exfiltrate a task into (or plant one in) a project it can't reach.
      if (!(await userCanAccessProject(env, agent.userId, toProjectId))) {
        throw new Error(`project ${toProjectId} not found`);
      }
      if (opts.oauthTokenId && !(await tokenCanReachProject(env, opts.oauthTokenId, toProjectId))) {
        throw new Error(`project ${toProjectId} is outside this connection's authorized projects`);
      }
      const id = await resolveTaskId(env, projectId, taskId);
      const res = await room(env, projectId).moveTask(projectId, actor, id, toProjectId);
      // Arrival event through the TARGET room so its event seq stays DO-serialized;
      // advisory — the move is already durable either way.
      await room(env, toProjectId).noteTaskArrival(toProjectId, actor, id).catch(() => {});
      return res;
    }),
  );

  defineTool(
    'search_tasks',
    'Filter tasks by ATTRIBUTES — "review tasks tagged auth", "my in-progress work", "overdue anywhere". Omit projectId to search every project you can reach. All filters AND together; `text` is an exact substring over title/body/key (NOT meaning — for loosely-phrased "find the thing about X", or to search docs and plans too, use semantic_search). Returns up to `limit` matches urgent-first, plus `matched` (the true total) so a truncated result is visible.',
    {
      projectId: z.string().optional().describe('Restrict to one project; omit for everything your credential reaches'),
      status: z.enum(['todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled']).optional(),
      type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
      tag: z.string().optional().describe('Tag name (exact, case-insensitive)'),
      milestoneId: z.string().optional(),
      holder: z.string().optional().describe("'me' (your claims), 'none' (unclaimed), or an agent id"),
      text: z.string().optional().describe('Substring over title/body/key'),
      overdue: z.boolean().optional().describe('Only past-due, still-open tasks'),
      includeArchived: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
    },
    tool(async ({ projectId, status, type, tag, milestoneId, holder, text, overdue, includeArchived, limit }) => {
      const { sql, binds } = taskSearchFilters({
        status, type, tag, milestoneId, text, overdue, includeArchived,
        holder: holder === 'me' ? agent.id : holder,
      });
      // Numbered params first (?1 user, ?2 project-or-null, ?3 token), THEN the filter
      // fragment's bare `?`s — SQLite continues the positional counter from 3.
      const base = `FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
        WHERE ${USER_PROJECT_WHERE} AND ${tokenProjectWhere('?3')} AND (?2 IS NULL OR t.project_id = ?2)${sql}`;
      const allBinds = [agent.userId, projectId ?? null, opts.oauthTokenId ?? null, ...binds];
      const max = limit ?? 50;
      const [rows, total] = await Promise.all([
        env.DB.prepare(
          `SELECT t.id, t.key, t.title, ${taskWireStatus('t')} AS status, t.failed_at AS failedAt, t.priority, t.estimate, t.due_at AS dueAt, t.type,
                  t.project_id AS projectId, p.key AS projectKey, t.claimed_by AS claimedBy,
                  t.milestone_id AS milestoneId, t.open_comments AS openComments, t.updated_at AS updatedAt
           ${base} ORDER BY t.priority DESC, t.updated_at DESC LIMIT ${max}`,
        ).bind(...allBinds).all(),
        env.DB.prepare(`SELECT COUNT(*) AS n ${base}`).bind(...allBinds).first<{ n: number }>(),
      ]);
      return { tasks: rows.results, matched: total?.n ?? rows.results.length, returned: rows.results.length };
    }),
  );

  defineTool(
    'semantic_search',
    'Search tasks, docs and plans by MEANING, not exact words — "how do we handle payment retries" finds the retry design doc and its tasks even when none contain that phrasing. Use this to orient in a large project: find the docs/tasks/plans relevant to what you are about to work on, before creating anything new (the thing you are about to file may already exist). For attribute filtering (status/tag/holder/overdue) use search_tasks instead — the two compose: discover here, then filter there. Falls back to keyword matching on instances without an embeddings backend (`mode` in the result says which ran).',
    {
      query: z.string().min(1).describe('Natural-language description of what you are looking for'),
      projectId: z.string().optional().describe('Restrict to one project; omit to search every project you can reach'),
      kinds: z.array(z.enum(['task', 'doc', 'plan'])).optional().describe('Restrict result types; default all three'),
      limit: z.number().int().min(1).max(50).optional().describe('Default 12'),
    },
    tool(async ({ query, projectId, kinds, limit }) => {
      const { results } = await env.DB.prepare(
        `SELECT p.id FROM projects p WHERE p.status = 'active' AND ${USER_PROJECT_WHERE} AND ${tokenProjectWhere('?2')}`,
      ).bind(agent.userId, opts.oauthTokenId ?? null).all<{ id: string }>();
      let projectIds = results.map((r) => r.id);
      if (projectId) projectIds = projectIds.filter((id) => id === projectId);
      const { mode, results: hits } = await search(env, { q: query, projectIds, kinds, limit });
      return { mode, results: hits, returned: hits.length };
    }),
  );

  defineTool(
    'merge_tags',
    'Vocabulary cleanup: merge tag `from` INTO tag `into` — every task and doc carrying `from` is re-pointed to `into`, then `from` is deleted. Supervisor-style maintenance for consolidating near-duplicates ("building-system" → "building"), NOT part of any normal work loop. The target must already exist; accepts ids or names. Survey the damage first with tag_report.',
    {
      projectId: z.string(),
      from: z.string().describe('Tag to dissolve (id or name)'),
      into: z.string().describe('Tag that absorbs it (id or name; must exist)'),
    },
    tool(async ({ projectId, from, into }) => room(env, projectId).mergeTags(projectId, actor, from, into)),
  );

  defineTool(
    'tag_report',
    'Tag-vocabulary health check: per-tag task/doc usage counts, single-use tags (no grouping value), unused tags, and near-duplicate clusters ("building"/"building-system"). Read-only — use it to plan a cleanup (merge_tags / human tag deletion) or to see whether the vocabulary needs curating.',
    { projectId: z.string() },
    tool(async ({ projectId }) => {
      const { results } = await env.DB.prepare(
        `SELECT g.id, g.name,
                (SELECT COUNT(*) FROM task_tags tt WHERE tt.tag_id = g.id) AS tasks,
                (SELECT COUNT(*) FROM doc_tags dt WHERE dt.tag_id = g.id) AS docs
         FROM tags g WHERE g.project_id = ? ORDER BY g.name`,
      ).bind(projectId).all<{ id: string; name: string; tasks: number; docs: number }>();
      const withTotal = results.map((r) => ({ ...r, total: r.tasks + r.docs })).sort((a, b) => b.total - a.total);
      const policy = await env.DB.prepare('SELECT tag_policy AS p FROM projects WHERE id = ?').bind(projectId).first<{ p: string }>();
      return {
        tagPolicy: policy?.p ?? 'open',
        totalTags: withTotal.length,
        tags: withTotal,
        singleUse: withTotal.filter((t) => t.total === 1).map((t) => t.name),
        unused: withTotal.filter((t) => t.total === 0).map((t) => t.name),
        nearDuplicateGroups: nearDupeGroups(withTotal.map((t) => t.name)),
      };
    }),
  );

  defineTool(
    'reindex_search',
    'Maintenance: rebuild the semantic-search vector index for one project (content that predates the embeddings backend, or drifted). Batched — call again with the returned offset while `remaining > 0`. Idempotent and safe to re-run; NOT part of any normal work loop (write-time indexing keeps the index fresh on its own). Errors when the instance has no embeddings backend.',
    {
      projectId: z.string(),
      offset: z.number().int().min(0).optional().describe('Continue a previous pass from here (default 0)'),
    },
    tool(async ({ projectId, offset }) => {
      const backend = searchBackend(env);
      if (!backend) throw new Error('no embeddings backend — this instance runs keyword search only');
      return reindexProject(env, backend, projectId, offset ?? 0);
    }),
  );

  defineTool(
    'add_dependency',
    'Make one task depend on another (blocks claiming until the dependency is done). Cycles are rejected. Undo with remove_dependency.',
    { projectId: z.string(), taskId: z.string(), dependsOnTaskId: z.string() },
    tool(async ({ projectId, taskId, dependsOnTaskId }) => room(env, projectId).addDependency(projectId, actor, taskId, dependsOnTaskId)),
  );

  defineTool(
    'remove_dependency',
    'Remove a manual dependency edge (the inverse of add_dependency), unblocking the dependent task if that was its last unfinished blocker. Remove an edge ONLY because the ordering itself is wrong — a dependency that should never have existed. NEVER remove one to get past a blocker you find inconvenient: that is not clearing the gate, it is deleting it, and it defeats the coordination this whole system exists to enforce. If the blocker is genuinely finished, mark the BLOCKER done (or cancelled) and the gate clears itself — do not touch the edge. If the blocker is NOT finished, the gate is doing its job; work something else or clear the blocker honestly. (A plan\'s phase order is not a dependency edge and can\'t be removed here — restructure the plan if the ordering is wrong.)',
    { projectId: z.string(), taskId: z.string(), dependsOnTaskId: z.string() },
    tool(async ({ projectId, taskId, dependsOnTaskId }) => room(env, projectId).removeDependency(projectId, actor, taskId, dependsOnTaskId)),
  );

  defineTool(
    'can_claim',
    'Read-only: would a claim of this task succeed RIGHT NOW? Returns {claimable, reason?}. It reports the plan/phase gate a normal claim faces — phase order (a phase stays locked until every earlier phase is done, unless the plan\'s dispatch opted into the landed gate), manual dependencies, and the proposed-plan lock — WITHOUT the anchored-run bypass, so a runner can check before spawning an agent on plan work whose earlier phase is not yet complete. reason is a short human string.',
    { taskId: z.string() },
    tool(async ({ taskId }) => {
      const t = await env.DB.prepare('SELECT project_id AS pid FROM tasks WHERE id = ? OR key = ?')
        .bind(taskId, taskId).first<{ pid: string }>();
      if (!t) throw new Error(`task ${taskId} not found`);
      if (!(await userCanAccessProject(env, agent.userId, t.pid))) throw new Error(`task ${taskId} not found`);
      return taskClaimability(env.DB, taskId);
    }),
  );

  defineTool(
    'add_attachment',
    'Attach a SMALL file (≤16 KB — a log snippet, a tiny icon) to a task by passing its bytes base64-encoded in `data`. For anything larger (screenshots, images, real files) use create_attachment_upload instead: base64 here rides the model context at ~1 token/byte, so a real file is prohibitively expensive and may not fit. Read bytes back later via the returned resource URI (resources/read) — e.g. noriq://attachment/<id>.',
    {
      projectId: z.string(),
      taskId: z.string(),
      filename: z.string().min(1).max(120),
      data: z.string().min(1).describe('file bytes, base64-encoded — ≤16 KB decoded; larger files go through create_attachment_upload'),
      contentType: z.string().optional().describe('MIME type, e.g. image/png — defaults to application/octet-stream'),
    },
    tool(async ({ projectId, taskId, filename, data, contentType }) => {
      if (!env.FILES) throw new Error('attachments not configured on this instance — enable R2 and bind FILES');
      const task = await env.DB.prepare('SELECT id, project_id AS pid, key FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
        .bind(taskId, taskId, projectId).first<{ id: string; pid: string; key: string }>();
      if (!task) throw new Error(`task ${taskId} not found in project ${projectId}`);
      const bytes = base64ToBytes(data);
      if (bytes.length === 0) throw new Error('attachment is empty');
      if (bytes.length > MAX_INLINE_ATTACHMENT) {
        throw new Error(`inline attachment is ${bytes.length} bytes; the inline limit is ${MAX_INLINE_ATTACHMENT} bytes — use create_attachment_upload for anything larger (it streams from disk, no base64 in context)`);
      }
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

  defineTool(
    'create_attachment_upload',
    'Get a one-shot upload URL to attach a real file (screenshot, image, log, up to 100 MB) WITHOUT routing its bytes through your context. Returns a ready-to-run `curl` that PUTs the file straight from disk to storage; the attachment is created when the upload lands, readable at the returned resourceUri (noriq://attachment/<id>). Use this for anything but the smallest payloads — the file must already be on disk (materialize a pasted image to a file first). The URL is short-lived (~15 min) and single-purpose.',
    {
      projectId: z.string(),
      taskId: z.string(),
      filename: z.string().min(1).max(120),
      contentType: z.string().optional().describe('MIME type, e.g. image/png — defaults to application/octet-stream'),
    },
    tool(async ({ projectId, taskId, filename, contentType }) => {
      if (!env.FILES) throw new Error('attachments not configured on this instance — enable R2 and bind FILES');
      const secret = env.ATTACHMENT_UPLOAD_SECRET ?? env.ADMIN_TOKEN;
      if (!secret) throw new Error('upload URLs are not enabled — set ATTACHMENT_UPLOAD_SECRET (or ADMIN_TOKEN); use add_attachment for files ≤16 KB');
      const origin = env.PUBLIC_ORIGIN ?? opts.origin;
      if (!origin) throw new Error('cannot build an absolute upload URL — set PUBLIC_ORIGIN');
      const task = await env.DB.prepare('SELECT id, project_id AS pid, key FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
        .bind(taskId, taskId, projectId).first<{ id: string; pid: string; key: string }>();
      if (!task) throw new Error(`task ${taskId} not found in project ${projectId}`);
      const safeName = filename.replace(/[/\\]/g, '_').slice(0, 120);
      const ct = contentType ?? 'application/octet-stream';
      const id = newId('att');
      const expMs = Date.now() + UPLOAD_TOKEN_TTL_MS;
      const token = await signUploadToken(secret, {
        aid: id, tid: task.id, pid: task.pid, fn: safeName, ct,
        agentId: agent.id, max: MAX_ATTACHMENT, exp: Math.floor(expMs / 1000),
      });
      const uploadUrl = `${origin.replace(/\/$/, '')}/api/attachments/upload/${token}`;
      return {
        attachmentId: id,
        uploadUrl,
        method: 'PUT',
        headers: { 'Content-Type': ct },
        maxBytes: MAX_ATTACHMENT,
        expiresAt: new Date(expMs).toISOString(),
        resourceUri: attachmentUri(id),
        curl: `curl -X PUT -H 'Content-Type: ${ct}' --data-binary @<FILE> '${uploadUrl}'`,
      };
    }),
  );

  // ---- coordination -------------------------------------------------------

  defineTool(
    'next_claimable',
    'The worker pull-loop: returns the highest-priority dependency-unblocked, unclaimed task (optionally within one project). Claim it with claim_task.',
    { projectId: z.string().optional() },
    tool(async ({ projectId }) => {
      // Scope to what the agent's USER can reach (PLNR-95): with no projectId the
      // central guard is skipped, so without this an omitted-projectId call returned
      // the top task (incl. body) across ALL tenants. Mirrors sync.ts `claimable`.
      //
      // The token clause is here for the same reason, and it is not redundant with the
      // central guard: omitting projectId is exactly how a scoped token would otherwise be
      // handed work from a project it was never authorized for — the pull-loop chooses the
      // project, so nothing upstream can check it (RUN-38).
      const row = await env.DB.prepare(
        `SELECT t.id, t.key, t.title, t.body, t.priority, t.project_id AS projectId
         FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
         WHERE t.status = 'todo' AND t.claimed_by IS NULL AND t.failed_at IS NULL AND (?2 IS NULL OR t.project_id = ?2)
           AND ${USER_PROJECT_WHERE}
           AND ${tokenProjectWhere('?3')}
           AND NOT EXISTS (
             SELECT 1 FROM dependencies d JOIN tasks dt ON dt.id = d.depends_on_task_id
             WHERE d.task_id = t.id AND dt.status NOT IN ('done','cancelled'))
           AND ${TASK_NOT_IN_PROPOSED_PLAN}
           AND ${TASK_NOT_PHASE_BLOCKED}
         ORDER BY t.priority DESC, t."order" LIMIT 1`,
      ).bind(agent.userId, projectId ?? null, opts.oauthTokenId ?? null).first();
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

  // ---- file locks (advisory path locks, PLNR-206) -------------------------
  // Opt-in per project. The ProjectRoom is the race-free arbiter; these tools are the agent
  // surface. Advisory: acquiring succeeds against a cooperating peer, not an uncooperative one —
  // the contract is "acquire BEFORE you touch the file(s)".

  defineTool(
    'acquire_lock',
    'Acquire an advisory lock on file path(s) BEFORE you edit/create/delete/rename them, so another '
      + 'agent on this project cannot clobber your work (git has no file locking). Pass EVERY path in the '
      + 'edit you are about to make in one call — it is all-or-nothing (you get them all or none, so no '
      + 'half-held deadlocks); a rename locks {source, dest}. Paths accept an exact file ("src/auth.ts"), '
      + 'a directory ("src/api/"), or a glob ("src/**/*.ts"). Give branch (or allBranches:true) so your '
      + 'lock does not needlessly block work on other branches. Link taskId to auto-release when the task '
      + 'settles. Re-acquiring paths you already hold just renews them (idempotent) — call it again before '
      + 'each edit to keep the active set held; unlocked paths expire on their own. On conflict it returns '
      + 'the current holder (who, which task, when it expires) so you coordinate (send_message / '
      + 'handoff_task) or wait. Requires file locking to be enabled for the project.',
    {
      projectId: z.string(),
      paths: z.array(z.string().min(1)).min(1).describe('Paths to lock: exact files, dirs (trailing /), or globs'),
      branch: z.string().optional().describe('The branch you are editing on; conflicts are scoped to it'),
      allBranches: z.boolean().optional().describe('Lock across all branches (use when no branch applies)'),
      taskId: z.string().optional().describe('Link to the task you are working — the lock auto-releases when it settles'),
    },
    tool(async ({ projectId, paths, branch, allBranches, taskId }) => {
      const resolvedTaskId = taskId ? await resolveTaskId(env, projectId, taskId) : null;
      return room(env, projectId).acquireLocks(projectId, actor, agent.id, { paths, branch, allBranches, taskId: resolvedTaskId });
    }),
  );

  defineTool(
    'release_lock',
    'Release advisory file locks your session holds — by lockIds or by paths — when you finish editing them. '
      + 'Idempotent, and only ever releases YOUR locks (a peer\'s lock is untouchable; a human resolves a stuck '
      + 'one from the dashboard). Locks linked to a task also auto-release when the task is released or done, so '
      + 'you rarely need this explicitly.',
    {
      projectId: z.string(),
      lockIds: z.array(z.string()).optional().describe('Lock ids returned by acquire_lock'),
      paths: z.array(z.string()).optional().describe('Or release by the exact paths you locked'),
    },
    tool(async ({ projectId, lockIds, paths }) =>
      room(env, projectId).releaseLocks(projectId, actor, agent.id, { lockIds, paths }),
    ),
  );

  defineTool(
    'check_locks',
    'Look BEFORE you leap: without acquiring anything, check whether file path(s) you are about to touch are '
      + 'held by another session (and which you already hold). Returns each conflicting holder + expiry so you '
      + 'can coordinate or pick different work. Read-only. Returns enabled:false if the project has not turned '
      + 'on file locking.',
    {
      projectId: z.string(),
      paths: z.array(z.string().min(1)).min(1),
      branch: z.string().optional(),
      allBranches: z.boolean().optional(),
    },
    tool(async ({ projectId, paths, branch, allBranches }) =>
      room(env, projectId).checkLocks(projectId, actor, agent.id, { paths, branch, allBranches }),
    ),
  );

  defineTool(
    'list_locks',
    'List the advisory file locks currently held in a project — who holds what, for which task, on which '
      + 'branch, and when each expires. Pass mine:true for only your own, or taskId to scope to one task. Read-only.',
    {
      projectId: z.string(),
      taskId: z.string().optional(),
      mine: z.boolean().optional().describe('Only locks held by your session'),
    },
    tool(async ({ projectId, taskId, mine }) => {
      const resolvedTaskId = taskId ? await resolveTaskId(env, projectId, taskId) : undefined;
      return room(env, projectId).listLocks(projectId, actor, { taskId: resolvedTaskId, agentId: mine ? agent.id : undefined });
    }),
  );

  // ---- comments (the human steering channel) ------------------------------

  defineTool(
    'read_open_comments',
    'Unresolved comments/questions on a task. Humans steer you here — treat instructions as scope changes and questions as blocking asks.',
    { taskId: z.string() },
    tool(async ({ taskId }) => {
      // Authorize (PLNR-95): resolve the task (id or key) and require the agent's
      // user can reach its project. This tool took only a taskId and never checked,
      // so any agent could read any task's human instructions. Mirrors get_task.
      const task = await env.DB.prepare('SELECT id, project_id AS pid FROM tasks WHERE id = ? OR key = ?')
        .bind(taskId, taskId).first<{ id: string; pid: string }>();
      if (!task) throw new Error(`task ${taskId} not found`);
      if (!(await userCanAccessProject(env, agent.userId, task.pid))) throw new Error(`task ${taskId} not found`);
      const { results } = await env.DB.prepare(
        `SELECT id, author_kind AS authorKind, author_id AS authorId, kind, body, status, created_at AS createdAt
         FROM comments WHERE task_id = ? AND status IN ('open','acknowledged') ORDER BY created_at`,
      ).bind(task.id).all();
      return { openComments: results };
    }),
  );

  defineTool(
    'add_comment',
    'Leave your OWN note on a task — progress, findings, rationale, a heads-up for whoever picks it up. A plain comment: it is recorded as a note and blocks nothing (not a question, not a resolution). To ask a human for a decision use request_input; to answer a human\'s open question use resolve_comment.',
    { projectId: z.string(), taskId: z.string().describe('Task id or display key'), body: z.string().min(1) },
    tool(async ({ projectId, taskId, body }) =>
      room(env, projectId).postComment(projectId, actor, await resolveTaskId(env, projectId, taskId), 'comment', body),
    ),
  );

  defineTool(
    'post_comment',
    'Post a comment or a question on a task. kind:"question" asks a human (stays open until resolved); kind:"comment" is your own note (non-blocking); kind:"reply" answers a thread. For a plain note, add_comment is simpler.',
    {
      projectId: z.string(),
      taskId: z.string().describe('Task id or display key'),
      kind: z.enum(['comment', 'question', 'reply']).default('comment'),
      body: z.string().min(1),
      parentCommentId: z.string().optional(),
    },
    tool(async ({ projectId, taskId, kind, body, parentCommentId }) =>
      room(env, projectId).postComment(projectId, actor, await resolveTaskId(env, projectId, taskId), kind, body, parentCommentId),
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
    'Message another agent (toAgentId, from list_agents) or broadcast to the project (omit toAgentId). Recipients see it in my_updates/notices. For narrative coordination only — a decision you need from a human is request_input (messages read as status and go unanswered), and a note that belongs on a task is add_comment (messages are not attached to tasks).',
    {
      projectId: z.string(),
      body: z.string().min(1),
      toAgentId: z.string().optional(),
      refTaskId: z.string().optional().describe('Task id or display key this message references'),
    },
    tool(async ({ projectId, body, toAgentId, refTaskId }) => {
      const refId = refTaskId ? await resolveTaskId(env, projectId, refTaskId) : undefined;
      return room(env, projectId).sendMessage(projectId, actor, body, toAgentId, refId);
    }),
  );

  // ---- signals: ask a human / flag attention ------------------------------

  defineTool(
    'request_input',
    'GATE: you need a human decision before you can proceed. Raise it here instead of guessing or stalling. If taskId is given, that task is auto-parked (released to blocked) so it does not lapse — then MOVE ON to other work via next_claimable; when a human answers you will see it in my_updates/notices and the task returns to the queue for you to re-claim. Batch every question the decision needs into ONE gate via `questions` (each with its own kind: pick-one, pick-several, freeform text, number, or yes/no) — one park + one answer beats four round-trips. Answers come back per-question ("Q → choice" lines). If the answer raises a NEW question, thread the next round with followUpTo (the prior gate id) — the human sees the earlier Q&A as context and the same task parks again. Ask everything you can foresee in round one; rounds are for genuine follow-ups, not drip-feeding.',
    {
      projectId: z.string(),
      taskId: z.string().optional().describe('The task (id or display key) this decision blocks (auto-parked to blocked). Omit for a standalone question; a followUpTo round inherits its predecessor\'s task automatically.'),
      title: z.string().min(1).describe('The decision needed, in one line'),
      body: z.string().optional().describe('Context: what you tried, why you are blocked, trade-offs'),
      options: z.array(z.string()).optional().describe('Discrete choices for a SINGLE simple question — for anything richer use `questions`'),
      questions: z.array(
        z.object({
          question: z.string().min(1).describe('The full question'),
          header: z.string().max(20).optional().describe('Short chip label, e.g. "Auth method"'),
          kind: z.enum(['select', 'multi', 'text', 'number', 'confirm']).optional()
            .describe('Answer form: select = one of options; multi = several of options; text = freeform; number = numeric; confirm = yes/no. Default: select when options given, else text.'),
          multi: z.boolean().optional().describe('Legacy alias for kind:"multi"'),
          options: z.array(z.string()).max(8).optional().describe('Choices for select/multi. The human ALWAYS also gets an "other" free-text escape.'),
        }),
      ).min(1).max(4).optional().describe('Batch up to 4 related questions in ONE gate (PLNR-131/185). The human answers them as one form; you receive per-question answers.'),
      followUpTo: z.string().optional().describe('Signal id of the gate this round follows up on (from the earlier request_input result or my_updates). Threads the rounds and re-parks the same task.'),
    },
    tool(async ({ projectId, taskId, title, body, options, questions, followUpTo }) => {
      const refTaskId = taskId ? await resolveTaskId(env, projectId, taskId) : null;
      return room(env, projectId).raiseSignal(projectId, actor, { type: 'input_request', taskId: refTaskId, title, body, options, questions, followUpTo: followUpTo ?? null });
    }),
  );

  defineTool(
    'raise_alert',
    'Flag something a human should SEE but that does not gate your work — a deviation from the plan, an unexpected finding, a risk, a heads-up. Non-blocking: keep working. Use severity critical sparingly for things that genuinely need prompt human attention.',
    {
      projectId: z.string(),
      taskId: z.string().optional().describe('Task id or display key'),
      title: z.string().min(1),
      body: z.string().optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional().describe('default info'),
    },
    tool(async ({ projectId, taskId, title, body, severity }) => {
      const refTaskId = taskId ? await resolveTaskId(env, projectId, taskId) : null;
      return room(env, projectId).raiseSignal(projectId, actor, { type: 'alert', taskId: refTaskId, title, body, severity });
    }),
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
      proposed: z.boolean().optional().describe('Emit as a PROPOSED plan awaiting human approval — its tasks are NOT claimable/dispatchable until someone approves it in the dashboard. Scope-mode Runner agents set this; a normal plan you intend to drain yourself does not.'),
      taskDefaults: z.object({
        milestoneId: z.string().optional(),
        boardId: z.string().optional(),
        priority: z.number().int().min(0).max(4).optional(),
        estimate: z.number().int().min(0).optional(),
        type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
        tags: z.array(z.string()).optional(),
        docIds: z.array(z.string()).optional().describe('Related project docs linked to every newTask — e.g. the design doc this plan implements'),
      }).optional().describe('Shared fields applied to every newTask in every phase (a task\'s own value wins) — write plan + fully-attributed tasks in ONE call'),
      phases: z.array(
        z.object({
          title: z.string().min(1),
          body: z.string().optional().describe('Explicit details for this phase (markdown): what, how, done-when'),
          taskIds: z.array(z.string()).optional(),
          newTasks: z.array(z.object({
            title: z.string().min(1),
            body: z.string().optional(),
            priority: z.number().int().min(0).max(4).optional(),
            estimate: z.number().int().min(0).optional(),
            milestoneId: z.string().optional(),
            boardId: z.string().optional(),
            docIds: z.array(z.string()).optional().describe('Related project docs (ids from list_docs)'),
            type: z.enum(['feature', 'bug', 'chore', 'research']).optional(),
            tags: z.array(z.string()).optional(),
            dependsOn: z.array(z.string()).optional().describe('Ad-hoc extra edges beyond the enforced phase chain — existing task ids or keys'),
          })).optional(),
        }),
      ).min(1).max(12),
    },
    tool(async ({ projectId, title, description, body, proposed, taskDefaults, phases }) =>
      room(env, projectId).createPlan(projectId, actor, { title, description, body, proposed, agentId: agent.id, taskDefaults, phases }),
    ),
  );

  defineTool(
    'update_plan',
    'Revise a plan as work progresses — append status updates, record findings/gotchas, mark the outcome. Pass the FULL new body (read it first via get_plans). updatePhase via phaseId to revise one phase. To change the plan\'s STRUCTURE (add/remove/move tasks between phases, add/drop/reorder phases), pass `phases` with the complete new shape, mirroring create_plan: keep a phase\'s existing id to keep it (and its verify-gate state), omit the id for a new phase, and any existing phase you leave out is dropped. The phase-ordering dependency edges are re-derived to match; hand-added edges are untouched. Keep the document in step with a structural edit — a plan that says one thing and enforces another is worse than no plan.',
    {
      projectId: z.string(),
      planId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      body: z.string().optional().describe('Full replacement markdown for the plan document'),
      phaseId: z.string().optional().describe('If set, patch this phase instead of the plan'),
      phaseBody: z.string().optional(),
      phaseTitle: z.string().optional(),
      phases: z.array(
        z.object({
          id: z.string().optional().describe('Existing phase id to keep it (preserves gate state); omit for a new phase'),
          title: z.string().min(1),
          body: z.string().optional().describe('Replacement phase body; omitted = keep the current one'),
          taskIds: z.array(z.string()).min(1).describe('The phase\'s complete new membership (ids or keys)'),
        }),
      ).min(1).max(12).optional().describe('The plan\'s complete new structure — replaces phase membership wholesale and re-derives the ordering edges (PLNR-154)'),
    },
    tool(async ({ projectId, planId, title, description, body, phaseId, phaseBody, phaseTitle, phases }) => {
      if (phases) {
        const restructured = await room(env, projectId).restructurePlan(projectId, actor, planId, phases);
        if (title !== undefined || description !== undefined || body !== undefined) {
          await room(env, projectId).updatePlan(projectId, actor, planId, { title, description, body });
        }
        return restructured;
      }
      if (phaseId) {
        return room(env, projectId).updatePhase(projectId, actor, phaseId, { title: phaseTitle, body: phaseBody });
      }
      return room(env, projectId).updatePlan(projectId, actor, planId, { title, description, body });
    }),
  );

  defineTool(
    'get_plans',
    'Plans in a project with per-phase progress (done/total tasks) — see how the work program is advancing. Each plan also lists its plan-local docs (id/name/description); read a full one with get_plan_doc.',
    { projectId: z.string() },
    tool(async ({ projectId }) => {
      const { results: plans } = await env.DB.prepare(
        // Archived plans are shelved, not deleted (PLNR-148) — a worker must not drain one.
        'SELECT id, agent_id AS agentId, title, description, body, created_at AS createdAt FROM plans WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC',
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
        // Plan-local docs (PLNR-200): summaries only — the body is fetched on demand via
        // get_plan_doc so a plan with many working docs doesn't bloat every get_plans.
        const { results: docRows } = await env.DB.prepare(
          'SELECT id, name, description, updated_at AS updatedAt FROM plan_docs WHERE plan_id = ? ORDER BY updated_at DESC',
        ).bind(p.id).all();
        enriched.push({ ...p, phases: phasesRows, docs: docRows });
      }
      return { plans: enriched };
    }),
  );

  // ---- plan-local docs (PLNR-200) -------------------------------------------------------
  // Working docs that belong to ONE plan. Unlike project docs (create_doc) they are never
  // indexed for semantic_search and carry NO settled-only contract — they may hold open
  // questions and evolve freely. Use them for design notes and supporting material a plan
  // needs, so the project knowledge base (create_doc) stays reserved for settled facts.
  defineTool(
    'create_plan_doc',
    'Create a working document attached to a plan (PLNR-200). Distinct from create_doc: a plan doc is scoped to this plan, is NOT searchable/indexed, and has NO "settled decisions only" rule — it may hold open questions and change as the plan evolves. Use it for design notes, scratch, or supporting material the plan needs; reserve create_doc for settled project-wide facts.',
    {
      projectId: z.string(),
      planId: z.string(),
      name: z.string().min(1).max(120),
      description: z.string().max(300).optional().describe('One line: what a reader finds inside'),
      body: z.string().optional().describe('The document, markdown — may be provisional'),
    },
    tool(async ({ projectId, planId, name, description, body }) =>
      room(env, projectId).createPlanDoc(projectId, actor, planId, { name, description, body })),
  );

  defineTool(
    'update_plan_doc',
    'Revise a plan-local doc (PLNR-200) — pass the full new body (read it first via get_plan_doc). No contract is enforced; a plan doc is expected to change as the design firms up.',
    {
      projectId: z.string(),
      docId: z.string(),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(300).optional(),
      body: z.string().optional().describe('Full replacement markdown'),
    },
    tool(async ({ projectId, docId, name, description, body }) =>
      room(env, projectId).updatePlanDoc(projectId, actor, docId, { name, description, body })),
  );

  defineTool(
    'get_plan_doc',
    'Read one plan-local doc in full (PLNR-200). Discover their ids via get_plans (each plan lists its docs).',
    { projectId: z.string(), docId: z.string() },
    tool(async ({ projectId, docId }) => {
      const doc = await env.DB.prepare(
        `SELECT id, plan_id AS planId, name, description, body, author_kind AS authorKind, author_name AS authorName,
                created_at AS createdAt, updated_at AS updatedAt
         FROM plan_docs WHERE id = ? AND project_id = ?`,
      ).bind(docId, projectId).first();
      if (!doc) throw new Error('plan doc not found in this project');
      return { doc };
    }),
  );

  // ---- milestones ---------------------------------------------------------

  defineTool(
    'create_milestone',
    'Create a milestone in a project. `description` is the goal — what "done" means. Assign tasks to it via update_task.milestoneId, or in bulk via create_tasks/create_plan taskDefaults.',
    {
      projectId: z.string(),
      title: z.string().min(1),
      dueAt: z.string().datetime().optional(),
      description: z.string().optional().describe('The goal / exit criteria for this milestone'),
    },
    tool(async ({ projectId, title, dueAt, description }) => room(env, projectId).createMilestone(projectId, actor, title, dueAt, description)),
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
      // Authorize + route through the DO (PLNR-95): this matched the guessable task
      // KEY with no access check and wrote straight to D1 (no event, no WS fanout),
      // so any agent could plant a ref/URL on any tenant's task, silently.
      const task = await env.DB.prepare('SELECT id, project_id AS pid FROM tasks WHERE id = ? OR key = ?')
        .bind(taskId, taskId).first<{ id: string; pid: string }>();
      if (!task) throw new Error(`task ${taskId} not found`);
      if (!(await userCanAccessProject(env, agent.userId, task.pid))) throw new Error(`task ${taskId} not found`);
      return room(env, task.pid).attachRef(task.pid, actor, task.id, kind, ref, url ?? null, state ?? null);
    }),
  );

  // ---- resources: read attachment bytes back ------------------------------
  // noriq://attachment/<id> — binary comes back as base64 `blob`, text as `text`.
  resourceSpecs.push({
    name: 'doc',
    uriTemplate: 'noriq://doc/{id}',
    description: 'A project reference doc (markdown) — conventions, architecture notes, decisions.',
  });
  server.registerResource(
    'doc',
    new ResourceTemplate('noriq://doc/{id}', {
      list: async () => {
        const { results } = await env.DB.prepare(
          `SELECT d.id, d.name, d.description FROM docs d JOIN projects p ON p.id = d.project_id
           WHERE p.status = 'active' AND ${USER_PROJECT_WHERE} AND ${tokenProjectWhere('?2')}
           ORDER BY d.updated_at DESC LIMIT 50`,
        ).bind(agent.userId, opts.oauthTokenId ?? null).all<{ id: string; name: string; description: string }>();
        return { resources: results.map((d) => ({ uri: docUri(d.id), name: d.name, mimeType: 'text/markdown', description: d.description })) };
      },
    }),
    { title: 'Project doc', description: 'A project reference doc (markdown).' },
    async (uri, { id }) => {
      const docId = Array.isArray(id) ? id[0]! : id;
      const row = await env.DB.prepare('SELECT body, project_id AS pid FROM docs WHERE id = ?')
        .bind(docId).first<{ body: string; pid: string }>();
      if (!row) throw new Error(`doc ${docId} not found`);
      if (!(await userCanAccessProject(env, agent.userId, row.pid))) throw new Error(`doc ${docId} not found`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: row.body }] };
    },
  );

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
        // Scope discovery to attachments in projects the agent's USER can reach
        // (PLNR-94) — this list used to enumerate every tenant's recent files,
        // handing out the ids needed to read them.
        const { results } = await env.DB.prepare(
          `SELECT a.id, a.filename, a.content_type AS ct, a.size
           FROM attachments a JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
           WHERE p.status = 'active' AND ${USER_PROJECT_WHERE}
             AND ${tokenProjectWhere('?2')} ORDER BY a.created_at DESC LIMIT 50`,
        ).bind(agent.userId, opts.oauthTokenId ?? null).all<{ id: string; filename: string; ct: string; size: number }>();
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
      // Authorize (PLNR-94): only stream bytes from a project the agent's USER can
      // reach. Join through the owning task/project; 404 (indistinguishable from a
      // missing id) otherwise. Previously any agent could read any tenant's file.
      const row = await env.DB.prepare(
        `SELECT a.r2_key AS key, a.content_type AS ct, t.project_id AS pid
         FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?`,
      ).bind(attId).first<{ key: string; ct: string; pid: string }>();
      if (!row) throw new Error(`attachment ${attId} not found`);
      if (!(await userCanAccessProject(env, agent.userId, row.pid))) throw new Error(`attachment ${attId} not found`);
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

  // The doc-authoring skill (PLNR-190) as a static resource, for clients that browse
  // resources; get_doc_guide is the reliable path (every MCP client can call tools).
  resourceSpecs.push({
    name: 'doc-authoring-skill',
    uriTemplate: 'noriq://skill/doc-authoring',
    description: 'The doc-authoring guide — how to write project docs that last (also via get_doc_guide or GET /skill/docs.md)',
  });
  server.registerResource(
    'doc-authoring-skill',
    'noriq://skill/doc-authoring',
    { title: 'Doc-authoring guide', description: 'How to write Noriq project docs that last', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: DOC_SKILL_MD }] }),
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
