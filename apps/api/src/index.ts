import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { StreamableHTTPTransport } from '@hono/mcp';
import type { Env } from './env';
import { adminAuth, agentAuth, getCookie, resolveSessionAgent, userAuth, type AppContext } from './auth';
import { buildMcpServer } from './mcp';
import { renderMcpReference, mcpReferenceJson } from './reference';
import { backupToR2, exportSnapshot } from './backup';
import { hashPassword, newApiKey, newId, nowIso, sha256Hex, verifyPassword } from './lib/util';
import { USER_PROJECT_WHERE, tokenCanReachProject, tokenProjectWhere, userCanAccessProject } from './lib/visibility';
import type { Actor } from './do/ProjectRoom';
import { SKILL_MD } from './skill';
import { issueTokens, metadataRoutes, oauth } from './oauth';
import { errorPage, wantsHtml } from './errorPage';
import { onboarding } from './onboarding';
import { z } from 'zod';
import { AgentTool, RunKind, RunnerRepo, RunBudget, normalizeProjectKey } from '@noriq-dev/shared';

export { ProjectRoom } from './do/ProjectRoom';
export { AgentSession } from './do/AgentSession';
export { RateLimiter } from './do/RateLimiter';
export { RunnerHub } from './do/RunnerHub';

const app = new Hono<AppContext>();

// CORS for the MCP + OAuth surface so browser-based and cross-origin MCP clients
// can preflight (PLNR-82). Registered before the handlers so it wraps them.
app.use('/mcp', cors({
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
  exposeHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
  maxAge: 86400,
}));
app.use('/oauth/*', cors({ allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 86400 }));

// OAuth 2.1 AS for MCP clients: discovery + register/authorize/token.
metadataRoutes(app);
app.route('/oauth', oauth);
app.route('/', onboarding);

const room = (env: Env, projectId: string) => env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));

/** Fixed-window limiter via the RateLimiter DO (PLNR-18). */
const rateLimit = async (env: Env, bucket: string, limit: number, windowMs = 60_000) => {
  if (env.DISABLE_RATE_LIMIT) return { ok: true, retryAfter: 0 };
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(bucket));
  return stub.hit(limit, windowMs);
};
const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header('CF-Connecting-IP') ?? 'local';
const tooMany = { error: 'too many attempts — slow down' };
const humanActor = (c: { var: { user?: { id: string; name: string } } }): Actor => ({
  kind: 'human',
  id: c.var.user!.id,
  name: c.var.user!.name,
});

// Gate every project-scoped route (PLNR-92): being signed in is NOT enough — you
// must be able to REACH this project. Mirrors VISIBILITY_WHERE (owner, a member of
// its group, or an admin). Returns 404 (not 403) so project-id existence doesn't
// leak. Registered as ONE chokepoint over /api/projects/:pid/* so no individual
// write route can forget the check (the mass-IDOR hole this closes came from the
// check living only on the MCP path). userAuth runs first (idempotent) to populate
// c.var.user; the route-level userAuth then no-ops.
/** Human-path project reach (PLNR-92/97): an admin sees everything; everyone else
 *  must own the project or be a member of its group. */
const reachesProject = (c: Context<AppContext>, pid: string): Promise<boolean> =>
  c.var.user!.role === 'admin' ? Promise.resolve(true) : userCanAccessProject(c.env, c.var.user!.id, pid);

async function requireProjectAccess(c: Context<AppContext>, next: Next) {
  // Path shape: /api/projects/<pid>/<sub>... — derive pid directly (robust
  // regardless of how Hono resolves params for wildcard middleware). Only the
  // SUB-routes are governed here; the bare /api/projects/:pid (whole-project
  // DELETE) is out of scope — it keeps its own owner/admin gate (403).
  const parts = new URL(c.req.url).pathname.split('/');
  const pid = parts[3];
  if (pid && parts.length > 4 && !(await reachesProject(c, pid))) {
    return c.json({ error: 'not found' }, 404);
  }
  await next();
}
app.use('/api/projects/:pid/*', userAuth, requireProjectAccess);

// --- health -----------------------------------------------------------------
app.get('/api/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({
    ok: row?.ok === 1,
    service: 'noriq',
    version: '0.2.0',
  });
});

// --- MCP (agents) -------------------------------------------------------------
app.all('/mcp', agentAuth, async (c) => {
  const conn = c.var.connection!;
  // Per-connection throughput cap; generous for tool cadence, hostile to floods.
  const rl = await rateLimit(c.env, `mcp:${conn.tokenId}`, 120);
  if (!rl.ok) return c.json({ error: 'rate limited — back off and retry' }, 429, { 'Retry-After': String(rl.retryAfter) });

  // Two ways to be somebody here (0026):
  //  * a runner's per-run token is BOUND to one agent — it acts as that agent, full stop,
  //    and no session id can move it. The runner owns that identity's lifecycle.
  //  * a human's connection is bound to nothing; each MCP SESSION (a chat / sub-agent)
  //    resolves to its own copilot. We issue a session id at initialize and the client
  //    echoes it back (Mcp-Session-Id).
  const raw = await c.req.json().catch(() => null);
  const msgs = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const isInit = msgs.some((m) => m?.method === 'initialize');
  let sessionId = c.req.header('mcp-session-id') || undefined;
  if (isInit && !sessionId) sessionId = crypto.randomUUID();
  let agent = conn.boundAgent;
  if (!agent && sessionId) {
    // Both refusals here are authentication failures, not server faults: a session id
    // replayed under another user's token (PLNR-101), and a session whose copilot was
    // revoked. They used to escape as 500s.
    try {
      agent = await resolveSessionAgent(c.env, conn, sessionId);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 401);
    }
    if (isInit) c.header('Mcp-Session-Id', sessionId);
  }
  // The old sessionless path silently acted as the connection's phantom "default agent".
  // That agent no longer exists, and minting one per request would re-create precisely the
  // unattributable work 0026 deletes — so refuse, and say why.
  if (!agent) {
    return c.json({ error: 'no MCP session — call initialize first (sessionless calls are not attributable)' }, 400);
  }

  const server = buildMcpServer(c.env, agent, { oauthTokenId: conn.tokenId, sessionId });
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c, raw ?? undefined);
});

// --- agent skill (served by Noriq itself; ROADMAP Phase 5) -------------------
app.get('/skill.md', (c) => c.text(SKILL_MD, 200, { 'Content-Type': 'text/markdown; charset=utf-8' }));

// --- MCP tool reference, generated from the zod schemas (PLNR-23) --------------
app.get('/reference.md', (c) =>
  c.text(renderMcpReference(new URL(c.req.url).origin), 200, { 'Content-Type': 'text/markdown; charset=utf-8' }),
);
app.get('/reference.json', (c) => c.json(mcpReferenceJson()));

// --- live channel --------------------------------------------------------------
app.get('/ws/projects/:projectId', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('expected WebSocket upgrade', 426);
  }
  // Refuse cross-origin upgrades (PLNR-91): WS handshakes aren't covered by CORS,
  // and SameSite=Lax already withholds the cookie cross-site — reject explicitly too.
  const origin = c.req.header('Origin');
  if (origin) {
    let originHost: string | null = null;
    try { originHost = new URL(origin).host; } catch { originHost = null; } // malformed → treat as cross-origin
    if (originHost !== new URL(c.req.url).host) return c.text('cross-origin websocket refused', 403);
  }
  // Authenticate + authorize the handshake (PLNR-91): the session cookie rides the
  // upgrade. Previously this forwarded straight to the DO with NO check, so anyone
  // could subscribe to any project's entire event log. Mirror VISIBILITY_WHERE
  // (owner / group member / admin); 404 (not 403) so project existence doesn't leak.
  const sid = getCookie(c.req.header('Cookie') ?? '', 'planar_session');
  const user = sid
    ? await c.env.DB.prepare(
        `SELECT u.id, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled = 0`,
      ).bind(await sha256Hex(sid)).first<{ id: string; role: string }>()
    : null;
  if (!user) return c.text('not signed in', 401);
  const pid = c.req.param('projectId');
  if (user.role !== 'admin' && !(await userCanAccessProject(c.env, user.id, pid))) {
    return c.text('not found', 404);
  }
  return room(c.env, pid).fetch(c.req.raw);
});

// The runtime channel (RUN-7): the daemon dials this per-runner WS. Unlike the
// browser project socket it authenticates with the user's OAuth Bearer (a Node
// client can set headers), and the runner must belong to that user. The socket
// itself lives in the RunnerHub DO (idFromName(runnerId)).
app.get('/ws/runner/:id', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.text('expected WebSocket upgrade', 426);
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return c.text('missing bearer token', 401);
  const tok = await c.env.DB.prepare(
    `SELECT t.user_id AS userId FROM oauth_tokens t
     WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).bind(await sha256Hex(token)).first<{ userId: string }>();
  if (!tok) return c.text('invalid or expired token', 401);
  const id = c.req.param('id')!;
  const owned = await c.env.DB.prepare('SELECT id FROM runners WHERE id = ? AND owner_user_id = ?').bind(id, tok.userId).first();
  if (!owned) return c.text('not found', 404);
  return c.env.RUNNER_HUB.get(c.env.RUNNER_HUB.idFromName(id)).fetch(c.req.raw);
});

// --- admin bootstrap (users; agent key issuance retired — agents arrive via OAuth) --
// Full D1 snapshot download (PLNR-21). Admin-only; restore steps in BACKUP.md.
app.get('/api/admin/export', adminAuth, async (c) => {
  const at = nowIso();
  const snapshot = await exportSnapshot(c.env, at);
  return c.json(snapshot, 200, {
    'Content-Disposition': `attachment; filename="planar-${at.replace(/[:.]/g, '-')}.json"`,
  });
});

// On-demand trigger of the same backup the cron runs → R2 (admin-only).
app.post('/api/admin/backup', adminAuth, async (c) => {
  const res = await backupToR2(c.env, nowIso());
  return c.json(res, res.ok ? 200 : 503);
});

app.post('/api/admin/users', adminAuth, async (c) => {
  const body = await c.req.json<{ email: string; name: string; password: string; role?: 'admin' | 'member' }>();
  if (!body.email || !body.password || !body.name) return c.json({ error: 'email, name, password required' }, 400);
  const id = newId('usr');
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, body.email.toLowerCase(), body.name, body.role ?? 'member', await hashPassword(body.password), nowIso()).run();
  return c.json({ id, email: body.email, name: body.name });
});

// --- first-run setup (self-install) ------------------------------------------------
// Open until the first user exists; afterwards it's a no-op that reports configured.
app.get('/api/setup/status', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return c.json({ needsSetup: (row?.n ?? 0) === 0 });
});

app.post('/api/setup', async (c) => {
  const rl = await rateLimit(c.env, `auth:${clientIp(c)}`, 10);
  if (!rl.ok) return c.json(tooMany, 429, { 'Retry-After': String(rl.retryAfter) });
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if ((row?.n ?? 0) > 0) return c.json({ error: 'already configured' }, 409);
  const body = await c.req.json<{ email: string; name: string; password: string }>();
  if (!body.email || !body.name || (body.password ?? '').length < 8) {
    return c.json({ error: 'email, name and a password of 8+ chars required' }, 400);
  }
  const id = newId('usr');
  await c.env.DB.prepare(
    "INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, 'admin', ?, ?)",
  ).bind(id, body.email.toLowerCase(), body.name, await hashPassword(body.password), nowIso()).run();
  // Sign the founder in immediately.
  const sid = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(sid), id, expires.toISOString()).run();
  c.header('Set-Cookie', `planar_session=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${expires.toUTCString()}`);
  return c.json({ user: { id, email: body.email, name: body.name, role: 'admin' } });
});

// --- human auth -----------------------------------------------------------------
app.post('/api/auth/login', async (c) => {
  const rl = await rateLimit(c.env, `auth:${clientIp(c)}`, 10);
  if (!rl.ok) return c.json(tooMany, 429, { 'Retry-After': String(rl.retryAfter) });
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const user = await c.env.DB.prepare('SELECT id, email, name, role, password_hash AS hash FROM users WHERE email = ? AND disabled = 0')
    .bind((email ?? '').toLowerCase())
    .first<{ id: string; email: string; name: string; role: string; hash: string | null }>();
  if (!user?.hash || !(await verifyPassword(password ?? '', user.hash))) {
    return c.json({ error: 'invalid credentials' }, 401);
  }
  const sid = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(sid), user.id, expires.toISOString()).run();
  c.header('Set-Cookie', `planar_session=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${expires.toUTCString()}`);
  return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.post('/api/auth/logout', userAuth, async (c) => {
  c.header('Set-Cookie', 'planar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  return c.json({ ok: true });
});

app.get('/api/auth/me', userAuth, (c) => c.json({ user: c.var.user }));

// --- OAuth connections ("sessions") the user can see & revoke (agent re-model) ----
app.get('/api/auth/sessions', userAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, COALESCE(cl.name, 'MCP client') AS clientName, t.scope, t.created_at AS createdAt, t.expires_at AS expiresAt,
            -- RUN-38: what this connection may actually reach. scoped_at distinguishes a
            -- legacy token (reaches everything its user can) from one a human put through the
            -- picker. Surfacing it turns a grandfathered token from an invisible hole into
            -- something a human can look at and decide to revoke.
            t.scoped_at IS NOT NULL AS scoped,
            (SELECT GROUP_CONCAT(p.key) FROM oauth_token_projects otp JOIN projects p ON p.id = otp.project_id
              WHERE otp.token_id = t.id) AS projectKeys,
            (SELECT COUNT(*) FROM agents a WHERE a.oauth_token_id = t.id AND a.status != 'revoked') AS agentCount,
            (SELECT MAX(a.last_seen_at) FROM agents a WHERE a.oauth_token_id = t.id) AS lastActive
     FROM oauth_tokens t LEFT JOIN oauth_clients cl ON cl.id = t.client_id
     WHERE t.user_id = ? AND t.revoked_at IS NULL AND t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
     ORDER BY t.created_at DESC`,
  ).bind(c.var.user!.id).all();
  return c.json({ sessions: results });
});

app.post('/api/auth/sessions/:id/revoke', userAuth, async (c) => {
  const now = nowIso();
  const r = await c.env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(now, c.req.param('id'), c.var.user!.id).run();
  // Retire the agents that ran on this connection so they stop showing as live.
  await c.env.DB.prepare("UPDATE agents SET status = 'offline' WHERE oauth_token_id = ? AND status = 'active'")
    .bind(c.req.param('id')).run();
  return c.json({ ok: true, revoked: r.meta.changes ?? 0 });
});

app.post('/api/auth/sessions/revoke-all', userAuth, async (c) => {
  const now = nowIso();
  const r = await c.env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .bind(now, c.var.user!.id).run();
  await c.env.DB.prepare(
    "UPDATE agents SET status = 'offline' WHERE status = 'active' AND oauth_token_id IN (SELECT id FROM oauth_tokens WHERE user_id = ?)",
  ).bind(c.var.user!.id).run();
  return c.json({ ok: true, revoked: r.meta.changes ?? 0 });
});

// --- UI read API (session-authed) -------------------------------------------------
/** Visibility (PLNR-48/83): a private (ungrouped) project is owner-only; a GROUPED
 *  project is shared with that group's MEMBERS; admins see everything. Every project
 *  has an owner (migration 0014), so there is no ownerless/global-visible case.
 *  Binds: ?=role, ?=userId (owner), ?=userId (member). */
const VISIBILITY_WHERE = `(
  ? = 'admin'
  OR p.owner_user_id = ?
  OR (p.group_id IS NOT NULL AND p.group_id IN (SELECT group_id FROM user_groups WHERE user_id = ?))
)`;

app.get('/api/projects', userAuth, async (c) => {
  const u = c.var.user!;
  // PLNR-83: admins see only their own projects by default (owning all of them is
  // noise); `?scope=all` opts into the admin-wide view. Non-admins always get the
  // user-scoped set. `admin` in the response tells the UI it may offer admin view.
  const adminAll = u.role === 'admin' && c.req.query('scope') === 'all';
  const select = `SELECT p.id, p.key, p.name, p.description, p.status, p.repo_url AS repoUrl, p.group_id AS groupId,
            p.owner_user_id AS ownerUserId, ou.name AS ownerName,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'in_progress') AS liveTasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS openTasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS totalTasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS doneTasks,
            (SELECT COUNT(*) FROM agents a WHERE a.project_id = p.id AND a.status != 'revoked') AS agentCount
     FROM projects p LEFT JOIN users ou ON ou.id = p.owner_user_id`;
  const stmt = adminAll
    ? c.env.DB.prepare(`${select} WHERE p.status = 'active' ORDER BY p.created_at`)
    : c.env.DB.prepare(`${select} WHERE p.status = 'active' AND ${USER_PROJECT_WHERE} ORDER BY p.created_at`).bind(u.id);
  const { results } = await stmt.all();
  return c.json({ projects: results, admin: u.role === 'admin' });
});

app.get('/api/projects/:pid/snapshot', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const u = c.var.user!;
  const visible = await c.env.DB.prepare(
    `SELECT 1 FROM projects p WHERE p.id = ? AND ${VISIBILITY_WHERE}`,
  ).bind(pid, u.role, u.id, u.id).first();
  if (!visible) return c.json({ error: 'not found' }, 404);
  // Auto-archive done tasks untouched for >24h whenever the project is viewed.
  await room(c.env, pid).sweepArchive(pid).catch(() => {});
  const includeArchived = c.req.query('archived') === '1';
  const [project, tasks, deps, agents, events, milestones, boards, plans, phases, phaseTasks, tags, taskTags, signals] = await Promise.all([
    c.env.DB.prepare('SELECT id, key, name, description, claim_ttl_seconds AS claimTtlSeconds, repo_url AS repoUrl FROM projects WHERE id = ?')
      .bind(pid).first(),
    c.env.DB.prepare(
      `SELECT id, key, title, body, status, type, priority, claimed_by AS claimedBy, claim_expires_at AS claimExpiresAt,
              parent_task_id AS parentTaskId, milestone_id AS milestoneId, board_id AS boardId, archived_at AS archivedAt,
              open_comments AS openComments, "order"
       FROM tasks WHERE project_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY "order"`,
    ).bind(pid).all(),
    c.env.DB.prepare(
      `SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnTaskId
       FROM dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
    ).bind(pid).all(),
    c.env.DB.prepare(
      // Project-local agents only (PLNR agent re-model): an agent belongs to the
      // project it works, not to every project.
      `SELECT a.id, COALESCE(a.label, a.name) AS name, a.role, a.status, a.last_seen_at AS lastSeenAt,
              a.kind, a.runner_id AS runnerId,
              a.parent_agent_id AS parentAgentId, u.name AS ownerName
       FROM agents a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.project_id = ? AND a.status != 'revoked' ORDER BY a.created_at`,
    ).bind(pid).all(),
    c.env.DB.prepare(
      `SELECT id, seq, actor_kind AS actorKind, actor_id AS actorId, verb, subject_type AS subjectType,
              subject_id AS subjectId, payload, created_at AS createdAt
       FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT 60`,
    ).bind(pid).all(),
    c.env.DB.prepare('SELECT id, title, due_at AS dueAt, "order" FROM milestones WHERE project_id = ? ORDER BY "order"').bind(pid).all(),
    c.env.DB.prepare('SELECT id, name, "order" FROM boards WHERE project_id = ? ORDER BY "order", created_at').bind(pid).all(),
    c.env.DB.prepare('SELECT id, agent_id AS agentId, title, description, body, status, created_at AS createdAt FROM plans WHERE project_id = ? ORDER BY created_at DESC').bind(pid).all(),
    c.env.DB.prepare('SELECT ph.id, ph.plan_id AS planId, ph.title, ph.body, ph."order" FROM phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ? ORDER BY ph."order"').bind(pid).all(),
    c.env.DB.prepare('SELECT pt.phase_id AS phaseId, pt.task_id AS taskId FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ?').bind(pid).all(),
    c.env.DB.prepare('SELECT id, name, color, "order" FROM tags WHERE project_id = ? ORDER BY "order"').bind(pid).all(),
    c.env.DB.prepare('SELECT tt.task_id AS taskId, tt.tag_id AS tagId FROM task_tags tt JOIN tasks t ON t.id = tt.task_id WHERE t.project_id = ?').bind(pid).all(),
    c.env.DB.prepare(
      `SELECT s.id, s.task_id AS taskId, t.key AS taskKey, s.agent_id AS agentId, s.agent_name AS agentName,
              s.type, s.severity, s.title, s.body, s.options, s.created_at AS createdAt
       FROM signals s LEFT JOIN tasks t ON t.id = s.task_id
       WHERE s.project_id = ? AND s.status = 'open' ORDER BY
         CASE s.type WHEN 'input_request' THEN 0 ELSE 1 END,
         CASE s.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, s.created_at DESC`,
    ).bind(pid).all(),
  ]);
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json({
    project,
    tasks: tasks.results,
    dependencies: deps.results,
    agents: agents.results,
    milestones: milestones.results,
    boards: boards.results,
    plans: plans.results,
    phases: phases.results,
    phaseTasks: phaseTasks.results,
    tags: tags.results,
    taskTags: taskTags.results,
    signals: signals.results.map((s) => ({ ...s, options: s.options ? JSON.parse(String(s.options)) : null })),
    events: events.results.map((e) => ({ ...e, payload: JSON.parse(String(e.payload)) })),
  });
});

app.get('/api/tasks/:tid', userAuth, async (c) => {
  const tid = c.req.param('tid')!;
  const task = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(tid).first();
  if (!task) return c.json({ error: 'not found' }, 404);
  if (!(await reachesProject(c, String(task.project_id)))) return c.json({ error: 'not found' }, 404); // PLNR-97
  const [comments, refs, attachments, taskTagRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, author_kind AS authorKind, author_id AS authorId, kind, body, status, parent_comment_id AS parentCommentId, created_at AS createdAt
       FROM comments WHERE task_id = ? ORDER BY created_at`,
    ).bind(tid).all(),
    c.env.DB.prepare('SELECT kind, ref, url, state FROM task_refs WHERE task_id = ?').bind(tid).all(),
    c.env.DB.prepare('SELECT id, filename, content_type AS contentType, size, uploaded_by_kind AS uploaderKind, uploaded_by AS uploadedBy, created_at AS createdAt FROM attachments WHERE task_id = ? ORDER BY created_at').bind(tid).all(),
    c.env.DB.prepare('SELECT tag_id AS tagId FROM task_tags WHERE task_id = ?').bind(tid).all(),
  ]);
  return c.json({ task, comments: comments.results, refs: refs.results, attachments: attachments.results, tagIds: taskTagRows.results.map((r) => r.tagId) });
});

// --- UI write API (all writes go through ProjectRoom; a human is just another actor) ---
app.post('/api/projects', userAuth, async (c) => {
  const body = await c.req.json<{ key: string; name: string; description?: string }>();
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(body.key ?? '')) return c.json({ error: 'key must be 1-8 uppercase letters/digits' }, 400);
  const id = `prj_${body.key.toLowerCase()}`;
  await c.env.DB.prepare(
    `INSERT INTO projects (id, key, name, description, status, claim_ttl_seconds, owner_user_id, created_at) VALUES (?, ?, ?, ?, 'active', 1800, ?, ?)`,
  ).bind(id, body.key, body.name, body.description ?? '', c.var.user!.id, nowIso()).run();
  await room(c.env, id).createMilestone(id, humanActor(c), 'Backlog');
  await room(c.env, id).createBoard(id, humanActor(c), 'Main');
  return c.json({ id, key: body.key });
});

app.post('/api/projects/:pid/milestones', userAuth, async (c) => {
  const { title, dueAt } = await c.req.json<{ title: string; dueAt?: string }>();
  if (!title) return c.json({ error: 'title required' }, 400);
  const result = await room(c.env, c.req.param('pid')!).createMilestone(c.req.param('pid')!, humanActor(c), title, dueAt ?? null);
  return c.json(result);
});

app.patch('/api/projects/:pid/milestones/:mid', userAuth, async (c) => {
  const patch = await c.req.json<{ title?: string; dueAt?: string | null }>();
  const result = await room(c.env, c.req.param('pid')!).updateMilestone(c.req.param('pid')!, humanActor(c), c.req.param('mid')!, patch);
  return c.json(result);
});

// --- boards (PLNR-80): multiple boards per project -----------------------------------
app.post('/api/projects/:pid/boards', userAuth, async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) return c.json({ error: 'name required' }, 400);
  const result = await room(c.env, c.req.param('pid')!).createBoard(c.req.param('pid')!, humanActor(c), name.trim());
  return c.json(result);
});

app.patch('/api/projects/:pid/boards/:bid', userAuth, async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) return c.json({ error: 'name required' }, 400);
  const result = await room(c.env, c.req.param('pid')!).renameBoard(c.req.param('pid')!, humanActor(c), c.req.param('bid')!, name.trim());
  return c.json(result);
});

app.delete('/api/projects/:pid/boards/:bid', userAuth, async (c) => {
  try {
    const result = await room(c.env, c.req.param('pid')!).deleteBoard(c.req.param('pid')!, humanActor(c), c.req.param('bid')!);
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.post('/api/projects/:pid/tasks', userAuth, async (c) => {
  const body = await c.req.json<{ title: string; body?: string; parentTaskId?: string; priority?: number; dependsOn?: string[]; boardId?: string | null }>();
  if (!body.title) return c.json({ error: 'title required' }, 400);
  const result = await room(c.env, c.req.param('pid')!).createTask(c.req.param('pid')!, humanActor(c), body);
  return c.json(result);
});

app.patch('/api/projects/:pid/tasks/:tid', userAuth, async (c) => {
  const patch = await c.req.json();
  const result = await room(c.env, c.req.param('pid')!).updateTask(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, patch);
  return c.json(result);
});

app.post('/api/projects/:pid/messages', userAuth, async (c) => {
  const { body, toAgentId } = await c.req.json<{ body: string; toAgentId?: string }>();
  if (!body?.trim()) return c.json({ error: 'body required' }, 400);
  const result = await room(c.env, c.req.param('pid')!).sendMessage(c.req.param('pid')!, humanActor(c), body.trim(), toAgentId ?? null);
  return c.json(result);
});

app.post('/api/projects/:pid/tasks/:tid/comments', userAuth, async (c) => {
  const { kind, body, parentCommentId } = await c.req.json<{ kind?: string; body: string; parentCommentId?: string }>();
  if (!body) return c.json({ error: 'body required' }, 400);
  const k = ['comment', 'question', 'instruction', 'reply'].includes(kind ?? '') ? (kind as never) : 'comment';
  const result = await room(c.env, c.req.param('pid')!).postComment(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, k, body, parentCommentId);
  return c.json(result);
});

app.post('/api/projects/:pid/comments/:cid/resolve', userAuth, async (c) => {
  const { resolution, reply } = await c.req.json<{ resolution: 'addressed' | 'wont_do'; reply?: string }>();
  const result = await room(c.env, c.req.param('pid')!).resolveComment(c.req.param('pid')!, humanActor(c), c.req.param('cid')!, resolution ?? 'addressed', reply);
  return c.json(result);
});

// Dependency management from the UI (PLNR-58). Cycles are rejected in addDependency.
app.post('/api/projects/:pid/tasks/:tid/dependencies', userAuth, async (c) => {
  const { dependsOnTaskId } = await c.req.json<{ dependsOnTaskId: string }>();
  if (!dependsOnTaskId) return c.json({ error: 'dependsOnTaskId required' }, 400);
  const result = await room(c.env, c.req.param('pid')!).addDependency(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, dependsOnTaskId);
  return c.json(result);
});

app.delete('/api/projects/:pid/tasks/:tid/dependencies/:depId', userAuth, async (c) => {
  const result = await room(c.env, c.req.param('pid')!).removeDependency(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, c.req.param('depId')!);
  return c.json(result);
});

// Signals — human answers a decision gate / acknowledges an alert (PLNR-67).
app.post('/api/projects/:pid/signals/:sid/answer', userAuth, async (c) => {
  const { response } = await c.req.json<{ response: string }>();
  if (!response?.trim()) return c.json({ error: 'response required' }, 400);
  const result = await room(c.env, c.req.param('pid')!).answerSignal(c.req.param('pid')!, humanActor(c), c.req.param('sid')!, response.trim());
  return c.json(result);
});

app.post('/api/projects/:pid/signals/:sid/acknowledge', userAuth, async (c) => {
  const { dismiss } = await c.req.json<{ dismiss?: boolean }>().catch(() => ({ dismiss: false }));
  const result = await room(c.env, c.req.param('pid')!).acknowledgeSignal(c.req.param('pid')!, humanActor(c), c.req.param('sid')!, !!dismiss);
  return c.json(result);
});

// --- archive (PLNR-73) -------------------------------------------------------
app.post('/api/projects/:pid/tasks/:tid/archive', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).archiveTask(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, true)));
app.post('/api/projects/:pid/tasks/:tid/restore', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).archiveTask(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, false)));

// --- deletion (PLNR-70) ------------------------------------------------------
app.delete('/api/projects/:pid/milestones/:mid', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).deleteMilestone(c.req.param('pid')!, humanActor(c), c.req.param('mid')!)));

app.delete('/api/projects/:pid/tags/:tid', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).deleteTag(c.req.param('pid')!, humanActor(c), c.req.param('tid')!)));

app.delete('/api/projects/:pid/plans/:plid', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).deletePlan(c.req.param('pid')!, humanActor(c), c.req.param('plid')!)));

// The mandatory human gate (RUN-23): approve a proposed plan → its tasks become
// claimable/dispatchable; reject → discard the proposal (its un-started tasks are
// cancelled). Both are project-reach gated by the /api/projects/:pid/* middleware.
app.post('/api/projects/:pid/plans/:plid/approve', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).approvePlan(c.req.param('pid')!, humanActor(c), c.req.param('plid')!)));
app.post('/api/projects/:pid/plans/:plid/reject', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).rejectPlan(c.req.param('pid')!, humanActor(c), c.req.param('plid')!)));

app.delete('/api/projects/:pid/tasks/:tid', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).deleteTask(c.req.param('pid')!, humanActor(c), c.req.param('tid')!)));

// Whole-project delete — owner or admin only. Irreversible.
app.delete('/api/projects/:pid', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const proj = await c.env.DB.prepare('SELECT owner_user_id AS owner FROM projects WHERE id = ?').bind(pid).first<{ owner: string | null }>();
  if (!proj) return c.json({ error: 'not found' }, 404);
  const u = c.var.user!;
  if (u.role !== 'admin' && proj.owner && proj.owner !== u.id) return c.json({ error: 'only the project owner or an admin can delete a project' }, 403);
  return c.json(await room(c.env, pid).deleteProject(pid, humanActor(c)));
});

app.post('/api/projects/:pid/tasks/:tid/release', userAuth, async (c) => {
  const { toStatus } = await c.req.json<{ toStatus?: string }>().catch(() => ({ toStatus: undefined }));
  const result = await room(c.env, c.req.param('pid')!).releaseTask(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, { toStatus });
  return c.json(result);
});

// --- groups (collections of projects) ----------------------------------------------
// Authorization (PLNR-81): a group is adjustable only by its members (rows in
// user_groups) or an admin. Non-members can't even see groups they don't belong to.
const isGroupMember = async (env: Env, userId: string, gid: string) =>
  !!(await env.DB.prepare('SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?').bind(userId, gid).first());

app.get('/api/groups', userAuth, async (c) => {
  // Everyone sees every group (group names are needed to render the project
  // directory — a project's group must resolve or the project vanishes from the
  // UI). Editing is what's restricted: `canEdit` gates the rename/delete controls,
  // and PATCH/DELETE enforce membership server-side (PLNR-81).
  const u = c.var.user!;
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.name, g.description, g."order",
            (CASE WHEN ?1 = 'admin' OR EXISTS (SELECT 1 FROM user_groups ug WHERE ug.group_id = g.id AND ug.user_id = ?2)
                  THEN 1 ELSE 0 END) AS canEdit
     FROM groups g ORDER BY g."order", g.created_at`,
  ).bind(u.role, u.id).all();
  return c.json({ groups: results });
});

app.post('/api/groups', userAuth, async (c) => {
  const body = await c.req.json<{ name: string; description?: string }>();
  if (!body.name) return c.json({ error: 'name required' }, 400);
  const id = newId('grp');
  await c.env.DB.prepare('INSERT INTO groups (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, body.name, body.description ?? '', c.var.user!.id, nowIso()).run();
  // The creator becomes a member so they can manage (and see) the group they made.
  await c.env.DB.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)')
    .bind(c.var.user!.id, id).run();
  return c.json({ id, name: body.name });
});

app.patch('/api/projects/:pid/meta', userAuth, async (c) => {
  const body = await c.req.json<{ groupId?: string | null; description?: string; name?: string; claimTtlSeconds?: number; ownerUserId?: string | null }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.groupId !== undefined) {
    // PLNR-93 ("closed + self-join"): you may move a project into a group only if you
    // CREATED it or already belong to it (or you're an admin) — you can't join
    // someone else's group by dropping a project into it. (The reach-check on the
    // project itself is handled by the requireProjectAccess middleware.)
    if (body.groupId !== null && c.var.user!.role !== 'admin') {
      const g = await c.env.DB.prepare('SELECT created_by AS createdBy FROM groups WHERE id = ?')
        .bind(body.groupId).first<{ createdBy: string | null }>();
      if (!g) return c.json({ error: 'group not found' }, 404);
      const allowed = g.createdBy === c.var.user!.id || await isGroupMember(c.env, c.var.user!.id, body.groupId);
      if (!allowed) return c.json({ error: 'you must be a member or the creator of the target group' }, 403);
    }
    sets.push('group_id = ?'); binds.push(body.groupId);
  }
  if (body.description !== undefined) { sets.push('description = ?'); binds.push(body.description); }
  if (body.name !== undefined) { sets.push('name = ?'); binds.push(body.name); }
  if (body.claimTtlSeconds !== undefined) {
    if (body.claimTtlSeconds < 60 || body.claimTtlSeconds > 24 * 3600) return c.json({ error: 'claim TTL must be 60s–24h' }, 400);
    sets.push('claim_ttl_seconds = ?'); binds.push(Math.round(body.claimTtlSeconds));
  }
  if (body.ownerUserId !== undefined) {
    if (c.var.user!.role !== 'admin') return c.json({ error: 'admin role required to reassign ownership' }, 403);
    sets.push('owner_user_id = ?'); binds.push(body.ownerUserId);
  }
  if (!sets.length) return c.json({ ok: true });
  const pid = c.req.param('pid')!;
  binds.push(pid);
  await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  // No auto-join anymore (PLNR-93): the caller was required to already be a member or
  // the creator of the target group above, so their visibility is already correct —
  // and this closes the "join any group by dropping a project in" hole.
  return c.json({ ok: true });
});

// --- categories (custom, per project) -----------------------------------------------
app.post('/api/projects/:pid/tags', userAuth, async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) return c.json({ error: 'name required' }, 400);
  const pid = c.req.param('pid')!;
  const id = await room(c.env, pid).resolveTag(pid, humanActor(c), name);
  return c.json({ id, name: name.trim().toLowerCase() });
});

// --- user management ------------------------------------------------------------------
const requireAdmin = (c: { var: { user?: { role: string } } }) => c.var.user?.role === 'admin';

app.get('/api/users', userAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at AS createdAt,
            (u.password_hash IS NULL AND NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id)) AS pending,
            (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
            (SELECT GROUP_CONCAT(g.id) FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE ug.user_id = u.id) AS groupIds,
            (SELECT COUNT(*) FROM projects p WHERE p.owner_user_id = u.id AND p.status = 'active') AS ownedProjects
     FROM users u ORDER BY u.created_at`,
  ).all();
  return c.json({ users: results });
});

app.post('/api/users', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const body = await c.req.json<{ email: string; name: string; password: string; role?: 'admin' | 'member' }>();
  if (!body.email || !body.name || (body.password ?? '').length < 8) {
    return c.json({ error: 'email, name and password (8+) required' }, 400);
  }
  const id = newId('usr');
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, body.email.toLowerCase(), body.name, body.role ?? 'member', await hashPassword(body.password), nowIso()).run();
  return c.json({ id, email: body.email, name: body.name, role: body.role ?? 'member' });
});

app.patch('/api/users/:uid', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const uid = c.req.param('uid')!;
  const body = await c.req.json<{ role?: 'admin' | 'member'; disabled?: boolean; name?: string }>();
  if (uid === c.var.user!.id && (body.role === 'member' || body.disabled)) {
    return c.json({ error: 'cannot demote or disable yourself' }, 400);
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.role !== undefined) { sets.push('role = ?'); binds.push(body.role); }
  if (body.disabled !== undefined) { sets.push('disabled = ?'); binds.push(body.disabled ? 1 : 0); }
  if (body.name !== undefined) { sets.push('name = ?'); binds.push(body.name); }
  if (!sets.length) return c.json({ ok: true });
  binds.push(uid);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  if (body.disabled) await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid).run();
  return c.json({ ok: true });
});

app.delete('/api/users/:uid', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const uid = c.req.param('uid')!;
  if (uid === c.var.user!.id) return c.json({ error: 'cannot delete yourself' }, 400);
  const target = await c.env.DB.prepare('SELECT disabled FROM users WHERE id = ?').bind(uid).first<{ disabled: number }>();
  if (!target) return c.json({ error: 'not found' }, 404);
  if (!target.disabled) return c.json({ error: 'disable the user first — delete is only available for disabled users' }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid),
    c.env.DB.prepare('DELETE FROM invites WHERE user_id = ?').bind(uid),
    c.env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(uid),
    c.env.DB.prepare('DELETE FROM user_groups WHERE user_id = ?').bind(uid),
    c.env.DB.prepare('DELETE FROM oauth_codes WHERE user_id = ?').bind(uid),
    c.env.DB.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').bind(uid),
    c.env.DB.prepare('UPDATE agents SET user_id = NULL WHERE user_id = ?').bind(uid),
    c.env.DB.prepare('UPDATE projects SET owner_user_id = NULL WHERE owner_user_id = ?').bind(uid),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid),
  ]);
  // Historical attribution in events/comments keeps the raw id — intentionally preserved.
  return c.json({ ok: true });
});

app.post('/api/users/:uid/reset-password', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const temp = newApiKey().slice(5, 21); // 16 random chars
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(temp), c.req.param('uid')!).run();
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(c.req.param('uid')!).run();
  return c.json({ tempPassword: temp }); // shown once to the admin
});

app.post('/api/auth/change-password', userAuth, async (c) => {
  const { current, next } = await c.req.json<{ current: string; next: string }>();
  if ((next ?? '').length < 8) return c.json({ error: 'new password must be 8+ chars' }, 400);
  const row = await c.env.DB.prepare('SELECT password_hash AS hash FROM users WHERE id = ?')
    .bind(c.var.user!.id).first<{ hash: string | null }>();
  if (!row?.hash || !(await verifyPassword(current ?? '', row.hash))) {
    return c.json({ error: 'current password incorrect' }, 401);
  }
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(next), c.var.user!.id).run();
  return c.json({ ok: true });
});

// --- group management -----------------------------------------------------------------
app.patch('/api/groups/:gid', userAuth, async (c) => {
  const u = c.var.user!;
  const gid = c.req.param('gid')!;
  if (u.role !== 'admin' && !(await isGroupMember(c.env, u.id, gid))) {
    return c.json({ error: 'only a group member can edit this group' }, 403);
  }
  const { name, description } = await c.req.json<{ name?: string; description?: string }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (name !== undefined) { sets.push('name = ?'); binds.push(name); }
  if (description !== undefined) { sets.push('description = ?'); binds.push(description); }
  if (!sets.length) return c.json({ ok: true });
  binds.push(gid);
  await c.env.DB.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return c.json({ ok: true });
});

app.delete('/api/groups/:gid', userAuth, async (c) => {
  const u = c.var.user!;
  const gid = c.req.param('gid')!;
  if (u.role !== 'admin' && !(await isGroupMember(c.env, u.id, gid))) {
    return c.json({ error: 'only a group member can delete this group' }, 403);
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE projects SET group_id = NULL WHERE group_id = ?').bind(gid),
    c.env.DB.prepare('DELETE FROM user_groups WHERE group_id = ?').bind(gid),
    c.env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(gid),
  ]);
  return c.json({ ok: true });
});

// Per-group membership, self-service (PLNR-83): a group's members (or an admin)
// manage who's in it. This is what lets a regular user run their own group
// without the admin-only PUT /users/:uid/groups.
const requireGroupMember = async (c: { env: Env; var: { user?: { id: string; role: string } } }, gid: string) =>
  c.var.user!.role === 'admin' || (await isGroupMember(c.env, c.var.user!.id, gid));

app.get('/api/groups/:gid/members', userAuth, async (c) => {
  const gid = c.req.param('gid')!;
  if (!(await requireGroupMember(c, gid))) return c.json({ error: 'only a group member can view membership' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email FROM user_groups ug JOIN users u ON u.id = ug.user_id
     WHERE ug.group_id = ? ORDER BY u.name`,
  ).bind(gid).all();
  return c.json({ members: results });
});

app.post('/api/groups/:gid/members', userAuth, async (c) => {
  const gid = c.req.param('gid')!;
  if (!(await requireGroupMember(c, gid))) return c.json({ error: 'only a group member can add members' }, 403);
  const { userId } = await c.req.json<{ userId: string }>();
  const target = await c.env.DB.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0').bind(userId ?? '').first();
  if (!target) return c.json({ error: 'user not found' }, 404);
  await c.env.DB.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').bind(userId, gid).run();
  return c.json({ ok: true });
});

app.delete('/api/groups/:gid/members/:uid', userAuth, async (c) => {
  const gid = c.req.param('gid')!;
  if (!(await requireGroupMember(c, gid))) return c.json({ error: 'only a group member can remove members' }, 403);
  await c.env.DB.prepare('DELETE FROM user_groups WHERE user_id = ? AND group_id = ?').bind(c.req.param('uid')!, gid).run();
  return c.json({ ok: true });
});

// --- agent management (admin humans) ------------------------------------------------

app.get('/api/agents', userAuth, async (c) => {
  // Agents are project-local; scope the roster to a project when given (the Agents tab
  // passes the current project). Connection default agents (project_id NULL) never show.
  const projectId = c.req.query('projectId');
  // PLNR-97: the roster is per-project — a non-admin must be able to reach it; the
  // cross-project view (no projectId) stays admin-only.
  if (projectId) {
    if (!(await reachesProject(c, projectId))) return c.json({ error: 'not found' }, 404);
  } else if (c.var.user!.role !== 'admin') {
    return c.json({ agents: [] });
  }
  const where = projectId ? 'WHERE a.project_id = ?' : 'WHERE a.project_id IS NOT NULL';
  const stmt = c.env.DB.prepare(
    `SELECT a.id, COALESCE(a.label, a.name) AS name, a.role, a.status, a.last_seen_at AS lastSeenAt, a.created_at AS createdAt,
            a.kind, a.runner_id AS runnerId,
            a.parent_agent_id AS parentAgentId, u.name AS ownerName, u.id AS ownerUserId,
            (SELECT COUNT(*) FROM tasks t WHERE t.claimed_by = a.id) AS heldTasks,
            (SELECT COUNT(*) FROM claims cl WHERE cl.agent_id = a.id) AS totalClaims
     FROM agents a LEFT JOIN users u ON u.id = a.user_id ${where} ORDER BY a.created_at`,
  );
  const { results } = await (projectId ? stmt.bind(projectId) : stmt).all();
  return c.json({ agents: results });
});

app.get('/api/agents/:aid/events', userAuth, async (c) => {
  const aid = c.req.param('aid')!;
  const ag = await c.env.DB.prepare('SELECT project_id AS pid FROM agents WHERE id = ?').bind(aid).first<{ pid: string | null }>();
  if (!ag) return c.json({ events: [] });
  // PLNR-97: only an admin, or someone who can reach the agent's project, sees its events.
  if (!(c.var.user!.role === 'admin' || (ag.pid && await userCanAccessProject(c.env, c.var.user!.id, ag.pid)))) {
    return c.json({ error: 'not found' }, 404);
  }
  const cols = `SELECT e.id, e.project_id AS projectId, e.seq, e.verb, e.subject_type AS subjectType, e.subject_id AS subjectId,
            e.payload, e.created_at AS createdAt FROM events e`;
  const stmt = ag.pid
    ? c.env.DB.prepare(`${cols} WHERE e.actor_id = ? AND e.project_id = ? ORDER BY e.rowid DESC LIMIT 50`).bind(aid, ag.pid)
    : c.env.DB.prepare(`${cols} WHERE e.actor_id = ? ORDER BY e.rowid DESC LIMIT 50`).bind(aid);
  const { results } = await stmt.all();
  return c.json({ events: results.map((e) => ({ ...e, payload: JSON.parse(String(e.payload)) })) });
});

app.post('/api/agents/:aid/revoke', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  await c.env.DB.prepare("UPDATE agents SET status = 'revoked' WHERE id = ?").bind(c.req.param('aid')!).run();
  return c.json({ ok: true });
});

// --- runners: the execution plane (RUN-5) -----------------------------------
// A runner is a per-user local daemon, authenticated by the user's OAuth token
// (the same credential its spawned agents use). Registration + heartbeat run over
// REST (agentAuth → the owning user); the dashboard reads them via userAuth. Run
// dispatch + the live WS channel land in RUN-6/RUN-7.

// A runner is treated offline once its heartbeat is older than this (≈3 missed
// 30s beats), derived on read so the panel is correct even without a sweeper.
const RUNNER_HEARTBEAT_TTL_MS = 90_000;

const RegisterRunnerBody = z.object({
  runnerId: z.string().optional(), // present on re-register (reconnect)
  label: z.string().min(1),
  tools: z.array(AgentTool).default([]),
  kinds: z.array(RunKind).default([]),
  maxConcurrency: z.number().int().nonnegative().default(1),
  repos: z.array(RunnerRepo).default([]),
  /** The daemon's RELEASE version (RUN-36). Optional: a runner older than version reporting
   *  still registers, and the panel says "unknown" rather than inventing a number. */
  version: z.string().max(40).optional(),
});

const HeartbeatBody = z.object({
  freeSlots: z.number().int().nonnegative(),
  // 'offline' is the daemon saying GOODBYE on a clean shutdown (RUN-35). Without it, stopping
  // a runner on purpose and a runner crashing look identical — both just stop heartbeating and
  // go stale. A final beat saying "I'm going" is the whole difference, and the panel reads it
  // as stopped-on-purpose precisely because the heartbeat is FRESH while the status is offline.
  status: z.enum(['online', 'draining', 'offline']).default('online'),
  repos: z.array(RunnerRepo).nullish(), // resend only when discovery changed the set
});

// Wire the RUN-3 resolution contract: a committed KEY resolves to a prj_… id on
// THIS server, but only among projects the owning user may reach (mirrors the
// agent/MCP scoping — no admin escalation, no leaking other tenants' projects).
async function resolveRunnerRepos(
  env: Env,
  ownerUserId: string,
  repos: Array<z.infer<typeof RunnerRepo>>,
  tokenId: string | null = null,
): Promise<Array<z.infer<typeof RunnerRepo>>> {
  const out: Array<z.infer<typeof RunnerRepo>> = [];
  for (const r of repos) {
    const key = normalizeProjectKey(r.projectKey);
    // Resolve only within the TOKEN's projects, not merely the user's (RUN-38). A repo the
    // runner advertises but is not scoped for resolves to null — unresolved, undispatchable —
    // rather than silently binding. That null is the enforcement: dispatch already refuses a
    // repo with no projectId, so scoping the resolution scopes the whole dispatch path with
    // it. Dropping the repo entirely would be worse: the operator would see a marker on disk
    // and no repo in the dashboard, with nothing saying why.
    const row = await env.DB.prepare(
      `SELECT p.id AS id FROM projects p
       WHERE p.key = ?2 AND ${USER_PROJECT_WHERE} AND ${tokenProjectWhere('?3')}`,
    ).bind(ownerUserId, key, tokenId).first<{ id: string }>();
    out.push({ ...r, projectKey: key, projectId: row?.id ?? null });
  }
  return out;
}

// Map a runners row to the wire Runner shape (never leak owner_user_id), deriving
// effective online/offline from heartbeat freshness.
function runnerView(row: Record<string, unknown>) {
  const last = row.last_heartbeat_at as string | null;
  const stale = !last || Date.now() - Date.parse(last) > RUNNER_HEARTBEAT_TTL_MS;
  const offboardedAt = (row.offboarded_at as string | null) ?? null;
  return {
    id: row.id as string,
    projectId: (row.project_id as string | null) ?? null,
    label: row.label as string,
    // Offboarded outranks liveness (RUN-35): a heartbeat cannot make a cut-off runner look
    // online, and its absence must not make it look merely crashed. "Someone stopped this"
    // and "this went quiet" are different facts and the panel has to tell them apart.
    status: offboardedAt ? 'offboarded' : stale ? 'offline' : (row.status as string),
    offboardedAt,
    capabilities: JSON.parse(String(row.capabilities)),
    repos: JSON.parse(String(row.repos)),
    freeSlots: row.free_slots as number,
    lastHeartbeatAt: last,
    // What the runner told us it is running. Noriq records it and shows it; it does not judge
    // it. Deciding "current" would put the server in the release-distribution business for a
    // number it does not own — the runner reads its own repo (RUN-37).
    version: (row.version as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

app.post('/api/runners', agentAuth, async (c) => {
  const parsed = RegisterRunnerBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid runner registration', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  const userId = c.var.connection!.userId;
  const repos = await resolveRunnerRepos(c.env, userId, b.repos, c.var.connection!.tokenId);
  const capabilities = JSON.stringify({ tools: b.tools, kinds: b.kinds, maxConcurrency: b.maxConcurrency });
  const now = nowIso();
  let id = b.runnerId;
  if (id) {
    // Re-register (reconnect): only the owner may re-bind an existing runner.
    const owned = await c.env.DB.prepare('SELECT id, offboarded_at AS offboardedAt FROM runners WHERE id = ? AND owner_user_id = ?')
      .bind(id, userId).first<{ id: string; offboardedAt: string | null }>();
    if (!owned) return c.json({ error: 'runner not found' }, 404);
    // Offboarding is STICKY (RUN-35). Revoking the token is what stops a runner, but a human
    // who later re-authorizes that box would otherwise silently un-offboard it by reconnecting
    // — the decision would evaporate on the next registration and the kill switch would be a
    // pause button. Coming back is a deliberate act: delete it and let it register fresh.
    if (owned.offboardedAt) {
      return c.json({ error: 'this runner was offboarded — delete it to let this machine register again' }, 403);
    }
    await c.env.DB.prepare(
      "UPDATE runners SET label = ?, status = 'online', capabilities = ?, repos = ?, free_slots = ?, last_heartbeat_at = ?, token_id = ?, version = ? WHERE id = ?",
    ).bind(b.label, capabilities, JSON.stringify(repos), b.maxConcurrency, now, c.var.connection!.tokenId, b.version ?? null, id).run();
    // Reconnect reconciliation (RUN-6): the daemon's previous process died, so any
    // Runs still dispatched/running/blocked for it are orphaned → failed{daemon_restart}.
    // Runs are per-project, so sweep each affected project's ProjectRoom (the authority).
    const { results: staleProjects } = await c.env.DB.prepare(
      "SELECT DISTINCT project_id AS pid FROM runs WHERE runner_id = ? AND status IN ('dispatched','running','blocked')",
    ).bind(id).all<{ pid: string }>();
    const sysActor: Actor = { kind: 'system', id: 'system', name: 'system' };
    for (const { pid } of staleProjects) {
      await room(c.env, pid).reconcileRunnerRuns(pid, sysActor, id);
    }
  } else {
    id = newId('rnr');
    await c.env.DB.prepare(
      `INSERT INTO runners (id, owner_user_id, label, status, capabilities, repos, free_slots, last_heartbeat_at, token_id, version, created_at)
       VALUES (?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, userId, b.label, capabilities, JSON.stringify(repos), b.maxConcurrency, now, c.var.connection!.tokenId, b.version ?? null, now).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM runners WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ runner: runnerView(row!) });
});

app.post('/api/runners/:id/heartbeat', agentAuth, async (c) => {
  const parsed = HeartbeatBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid heartbeat', detail: parsed.error.issues }, 400);
  const userId = c.var.connection!.userId;
  const id = c.req.param('id')!;
  const owned = await c.env.DB.prepare('SELECT id, offboarded_at AS offboardedAt FROM runners WHERE id = ? AND owner_user_id = ?')
    .bind(id, userId).first<{ id: string; offboardedAt: string | null }>();
  if (!owned) return c.json({ error: 'runner not found' }, 404);
  // Revoking the token normally stops this call ever arriving; this is defence in depth for a
  // runner offboarded while holding a still-valid credential (an unscoped legacy token, say).
  if (owned.offboardedAt) return c.json({ error: 'this runner was offboarded' }, 403);
  const b = parsed.data;
  if (b.repos) {
    const repos = await resolveRunnerRepos(c.env, userId, b.repos, c.var.connection!.tokenId);
    await c.env.DB.prepare('UPDATE runners SET free_slots = ?, status = ?, repos = ?, last_heartbeat_at = ? WHERE id = ?')
      .bind(b.freeSlots, b.status, JSON.stringify(repos), nowIso(), id).run();
  } else {
    await c.env.DB.prepare('UPDATE runners SET free_slots = ?, status = ?, last_heartbeat_at = ? WHERE id = ?')
      .bind(b.freeSlots, b.status, nowIso(), id).run();
  }
  return c.json({ ok: true });
});

app.get('/api/runners', userAuth, async (c) => {
  // A user sees their own runners; an admin may see all with ?all=1.
  const all = c.req.query('all') === '1' && c.var.user!.role === 'admin';
  const stmt = all
    ? c.env.DB.prepare('SELECT * FROM runners ORDER BY created_at DESC')
    : c.env.DB.prepare('SELECT * FROM runners WHERE owner_user_id = ? ORDER BY created_at DESC').bind(c.var.user!.id);
  const { results } = await stmt.all<Record<string, unknown>>();
  return c.json({ runners: results.map(runnerView) });
});

/** The owner's runner, or null. Every lifecycle route below is owner-scoped through this. */
async function ownedRunner(c: Context<AppContext>, id: string) {
  return c.env.DB.prepare('SELECT * FROM runners WHERE id = ? AND owner_user_id = ?')
    .bind(id, c.var.user!.id).first<Record<string, unknown>>();
}

/**
 * Offboard: cut this runner off (RUN-35). The one action an operator needs when a box is lost,
 * compromised, or running away.
 *
 * Revoking the TOKEN is what does the work — it severs dispatch, MCP, reporting and the WS in
 * one row, because agentAuth already rejects revoked tokens and issueTokens puts the access and
 * refresh hashes on that SAME row (so this is a stop, not a 7-day delay while the refresh
 * outlives it). Marking the runner without revoking would accomplish nothing at all.
 *
 * BE HONEST ABOUT THE LIMIT: this severs Noriq. It does NOT stop a compromised machine touching
 * the local repo — the daemon still has the checkout, and with [land] it has branch write, and
 * with [land].autoPush (RUN-27) it can push until the git credential is pulled too. This is a
 * real control, not a big red button, and the response says so rather than implying otherwise.
 */
app.post('/api/runners/:id/offboard', userAuth, async (c) => {
  const id = c.req.param('id')!;
  const runner = await ownedRunner(c, id);
  if (!runner) return c.json({ error: 'runner not found' }, 404);
  const now = nowIso();
  const tokenId = (runner.token_id as string | null) ?? null;

  const stmts = [
    c.env.DB.prepare("UPDATE runners SET offboarded_at = ?, status = 'offline', free_slots = 0 WHERE id = ?").bind(now, id),
  ];
  if (tokenId) {
    stmts.push(
      c.env.DB.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now, tokenId),
      // Same sweep the connections revoke does: retire the agents that ran on it so they stop
      // showing as live. A runner's agents are exactly the ones it spawned (0026).
      c.env.DB.prepare("UPDATE agents SET status = 'offline' WHERE oauth_token_id = ? AND status = 'active'").bind(tokenId),
      c.env.DB.prepare("UPDATE agents SET status = 'offline' WHERE runner_id = ? AND status = 'active'").bind(id),
    );
  }
  await c.env.DB.batch(stmts);

  // Its live Runs are now orphaned — the daemon can no longer report on them, so they would sit
  // `running` forever. Same treatment, and the same precedent, as a daemon that died.
  const { results: pids } = await c.env.DB.prepare(
    "SELECT DISTINCT project_id AS pid FROM runs WHERE runner_id = ? AND status IN ('dispatched','running','blocked')",
  ).bind(id).all<{ pid: string }>();
  const sysActor: Actor = { kind: 'system', id: 'system', name: 'system' };
  let failedRuns = 0;
  for (const { pid } of pids) {
    failedRuns += (await room(c.env, pid).reconcileRunnerRuns(pid, sysActor, id)).failed;
  }

  return c.json({
    ok: true,
    tokenRevoked: !!tokenId,
    failedRuns,
    // A runner registered before 0028 has no token_id, so there is nothing to revoke and the
    // offboard is only a flag. Say so plainly instead of reporting a stop that did not happen.
    ...(tokenId
      ? {}
      : { warning: 'this runner predates token tracking — it is marked offboarded, but no token was revoked. Revoke its connection in Settings.' }),
    note: 'Noriq access is severed. This does not remove the daemon’s local repo access — stop the process on that machine too.',
  });
});

/** Re-label. Cosmetic, but it is how a human tells two boxes apart. */
app.patch('/api/runners/:id', userAuth, async (c) => {
  const id = c.req.param('id')!;
  const body = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });
  const label = (body.label ?? '').trim();
  if (!label) return c.json({ error: 'label required' }, 400);
  if (!(await ownedRunner(c, id))) return c.json({ error: 'runner not found' }, 404);
  await c.env.DB.prepare('UPDATE runners SET label = ? WHERE id = ?').bind(label.slice(0, 80), id).run();
  return c.json({ ok: true });
});

/**
 * Delete a runner row. This is prune, not a kill switch — deleting a LIVE runner would only
 * lose track of it while it kept working, so it must be offboarded (or already dead) first.
 * That ordering is the whole safety property: you cannot make a runaway invisible.
 *
 * Also the escape hatch for a stray: `POST /api/runners` with no runnerId mints a new one, so a
 * wiped state file or a copy-pasted curl quietly forks a duplicate identity that, until now,
 * nothing could remove.
 */
app.delete('/api/runners/:id', userAuth, async (c) => {
  const id = c.req.param('id')!;
  const runner = await ownedRunner(c, id);
  if (!runner) return c.json({ error: 'runner not found' }, 404);
  const last = runner.last_heartbeat_at as string | null;
  const live = !runner.offboarded_at && last && Date.now() - Date.parse(last) <= RUNNER_HEARTBEAT_TTL_MS;
  if (live) {
    return c.json({ error: 'runner is online — offboard it first (deleting a live runner only loses track of it)' }, 409);
  }
  // A runner that ever spawned an agent cannot be deleted, and that is the 0026 CHECK doing its
  // job rather than getting in the way: `kind='agent'` REQUIRES a runner_id, so there is no
  // "unlink and forget" — an agent's provenance is a fact, and erasing the runner would erase
  // who ran the work. Offboard is the answer for a real runner; delete is for a stray that
  // never did anything (an omitted runnerId mints one, so a wiped state file or a stray curl
  // forks a duplicate identity that nothing could remove until now).
  const agents = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM agents WHERE runner_id = ?').bind(id)
    .first<{ n: number }>();
  if (agents?.n) {
    return c.json(
      { error: `this runner spawned ${agents.n} agent(s) — it is part of that work's history and cannot be deleted. Offboard it instead.` },
      409,
    );
  }
  // runs.runner_id has no such constraint, so null it rather than deleting the runs: a Run is
  // history too, and the honest record is "the runner that did this is gone", not "this never
  // happened".
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE runs SET runner_id = NULL WHERE runner_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM runners WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

const hub = (env: Env, runnerId: string) => env.RUNNER_HUB.get(env.RUNNER_HUB.idFromName(runnerId));

const DispatchBody = z.object({
  runnerId: z.string(),
  kind: RunKind,
  agentTool: AgentTool,
  repoRef: z.string(), // must be one of the runner's advertised repos, resolving to this project
  brief: z.string().default(''),
  anchor: z.discriminatedUnion('type', [
    z.object({ type: z.literal('task'), id: z.string() }),
    z.object({ type: z.literal('plan'), id: z.string() }),
  ]).nullish(),
  // VERIFY only: the build run whose diff to judge. The daemon branches the verifier's
  // worktree from that run's branch — without it the verifier reviews a pristine HEAD.
  verifiesRunId: z.string().nullish(),
  budget: RunBudget.optional(),
});

// Dispatch a brief → a Run on a runner (RUN-7). The dispatch primitive is the
// *intent*: kind + repo + brief (+ optional task/plan anchor). Creates the Run in
// the project's ProjectRoom (authoritative, dispatched) and pushes run.assigned
// down the runner's live socket. Under /api/projects/:pid/* → project reach gated.
app.post('/api/projects/:pid/runs', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const parsed = DispatchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid dispatch', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  // The runner must belong to this user, and the target repo must resolve to THIS project.
  const runner = await c.env.DB.prepare('SELECT repos FROM runners WHERE id = ? AND owner_user_id = ?')
    .bind(b.runnerId, c.var.user!.id).first<{ repos: string }>();
  if (!runner) return c.json({ error: 'runner not found' }, 404);
  const repo = (JSON.parse(runner.repos) as Array<{ id: string; projectId: string | null }>).find((r) => r.id === b.repoRef);
  if (!repo) return c.json({ error: 'unknown repoRef for this runner' }, 400);
  if (repo.projectId !== pid) return c.json({ error: 'repo does not resolve to this project' }, 400);

  // A verify run must judge a real build in THIS project — otherwise the daemon would
  // branch its worktree from a ref that doesn't exist (or, worse, another tenant's).
  if (b.verifiesRunId) {
    if (b.kind !== 'verify') return c.json({ error: 'verifiesRunId is only valid for a verify run' }, 400);
    const target = await c.env.DB.prepare('SELECT kind FROM runs WHERE id = ? AND project_id = ?')
      .bind(b.verifiesRunId, pid).first<{ kind: string }>();
    if (!target) return c.json({ error: 'verifiesRunId does not name a run in this project' }, 400);
    if (target.kind !== 'build') return c.json({ error: 'only a build run produces a diff to verify' }, 400);
  }

  const run = await room(c.env, pid).createRun(pid, humanActor(c), {
    kind: b.kind, agentTool: b.agentTool, repoRef: b.repoRef, brief: b.brief,
    anchor: b.anchor ? { type: b.anchor.type, id: b.anchor.id } : null,
    verifiesRunId: b.verifiesRunId ?? null,
    budget: b.budget, runnerId: b.runnerId,
  });
  const { delivered } = await hub(c.env, b.runnerId).deliver(JSON.stringify({ type: 'run.assigned', run }));
  return c.json({ run, delivered });
});

// List a project's Runs for the dashboard (RUN-22). Under /api/projects/:pid/* →
// project-reach gated.
app.get('/api/projects/:pid/runs', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const runs = await room(c.env, pid).listRuns(pid);
  return c.json({ runs });
});

// Cancel a Run (RUN-7): mark it cancelled in its project's authority and push
// run.cancel down the runner's socket so the daemon SIGTERMs the process.
app.post('/api/runs/:runId/cancel', userAuth, async (c) => {
  const runId = c.req.param('runId')!;
  const reason = ((await c.req.json<{ reason?: string }>().catch(() => ({}))) as { reason?: string }).reason ?? null;
  const run = await c.env.DB.prepare('SELECT project_id AS pid, runner_id AS runnerId FROM runs WHERE id = ?')
    .bind(runId).first<{ pid: string; runnerId: string | null }>();
  if (!run) return c.json({ error: 'run not found' }, 404);
  if (!(await reachesProject(c, run.pid))) return c.json({ error: 'not found' }, 404);
  const updated = await room(c.env, run.pid).transitionRun(run.pid, humanActor(c), runId, { status: 'cancelled', reason });
  if (run.runnerId) {
    await hub(c.env, run.runnerId).deliver(JSON.stringify({ type: 'run.cancel', runId, hard: true, reason }));
  }
  return c.json({ run: updated });
});

// Steer a live Run (RUN-16/17): push a human's steer down the runner's socket so
// the daemon injects it into the running agent's live input. Records the steer so
// the daemon's steer.ack can mark the source delivered-via-runtime (dedup — the
// notices fallback won't also surface it). Graceful degradation: if the daemon is
// down / never acks, no suppression is recorded and the notice fires normally.
const SteerBody = z.object({
  text: z.string().min(1),
  mode: z.enum(['soft', 'hard']).default('soft'),
  // The Noriq comment/message id this steer derives from — the stable dedup key.
  sourceCommentId: z.string().nullish(),
  sourceMessageId: z.string().nullish(),
  noticeCursor: z.number().int().nonnegative().nullish(),
});
app.post('/api/runs/:runId/steer', userAuth, async (c) => {
  const runId = c.req.param('runId')!;
  const parsed = SteerBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid steer', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  const run = await c.env.DB.prepare('SELECT project_id AS pid, runner_id AS runnerId, agent_id AS agentId FROM runs WHERE id = ?')
    .bind(runId).first<{ pid: string; runnerId: string | null; agentId: string | null }>();
  if (!run) return c.json({ error: 'run not found' }, 404);
  if (!(await reachesProject(c, run.pid))) return c.json({ error: 'not found' }, 404);
  if (!run.runnerId) return c.json({ error: 'run has no runner to steer' }, 409);

  const steerId = newId('str');
  const sourceId = b.sourceCommentId ?? b.sourceMessageId ?? null;
  await c.env.DB.prepare(
    'INSERT INTO steers (id, run_id, agent_id, source_id, notice_cursor, mode) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(steerId, runId, run.agentId, sourceId, b.noticeCursor ?? null, b.mode).run();

  const { delivered } = await hub(c.env, run.runnerId).deliver(
    JSON.stringify({
      type: 'steer',
      runId,
      steerId,
      mode: b.mode,
      body: b.text,
      sourceCommentId: b.sourceCommentId ?? null,
      sourceMessageId: b.sourceMessageId ?? null,
      noticeCursor: b.noticeCursor ?? null,
      issuedAt: new Date().toISOString(),
    }),
  );
  return c.json({ steerId, delivered });
});

// The runner creates the agent it is about to spawn, and gets a token BOUND to it (RUN-43).
//
// This inverts how identity used to work. The daemon told the model, in English, to call
// set_agent_identity — so identity depended on the model choosing to comply, the daemon never
// learned the agt_ that resulted (run.status.agentId was always null), and Codex, which never
// had MCP wired at all, was silently un-attributable. Now the identity exists BEFORE the
// process does, and the process inherits it by holding a credential that can only be it.
//
// The bound token is also least-privilege: agents previously shared the runner's own token,
// so every spawned process held the credential that can register runners and read every
// project the human can reach. This one can only be one agent, in one project.
const RunAgentBody = z.object({
  label: z.string().min(1).max(60).optional(),
  role: z.enum(['orchestrator', 'worker']).default('worker'),
});
app.post('/api/runs/:runId/agent', agentAuth, async (c) => {
  const runId = c.req.param('runId')!;
  const parsed = RunAgentBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid run-agent request', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  const conn = c.var.connection!;
  const run = await c.env.DB.prepare(
    `SELECT r.id, r.kind, r.project_id AS projectId, r.runner_id AS runnerId, r.agent_id AS agentId,
            rn.owner_user_id AS owner
     FROM runs r LEFT JOIN runners rn ON rn.id = r.runner_id WHERE r.id = ?`,
  ).bind(runId).first<{
    id: string; kind: string; projectId: string; runnerId: string | null;
    agentId: string | null; owner: string | null;
  }>();
  // Same ownership test as steer-ack: the run must belong to a runner this user owns.
  if (!run || run.owner !== conn.userId) return c.json({ error: 'run not found' }, 404);
  if (!run.runnerId) return c.json({ error: 'run has no runner yet' }, 400);
  // The runner's token must be authorized for the run's project (RUN-38). Without this a
  // scoped runner could mint itself an agent — and a working credential — inside a project it
  // was never granted, which would make the whole scope decorative. Repo resolution normally
  // stops such a run existing; this is the check that does not depend on that having worked.
  if (!(await tokenCanReachProject(c.env, conn.tokenId, run.projectId))) {
    return c.json({ error: 'run is outside this connection’s authorized projects' }, 403);
  }
  // One agent per run, and it is not re-issuable: handing out a second credential for the
  // same run would mean two live processes could act as one identity, which is exactly the
  // ambiguity this task exists to remove.
  if (run.agentId) return c.json({ error: 'run already has an agent' }, 409);

  const agentId = newId('agt');
  // The label is what a human reads in the dashboard; scope it to the run so two concurrent
  // runs in one project cannot collide (label uniqueness is per-project).
  const label = b.label ?? `${run.kind}-${runId.slice(-6)}`;
  const name = `runner-${agentId.slice(-6)}`;

  // Order matters here and it is not arbitrary: agents.oauth_token_id and oauth_tokens.agent_id
  // reference each other, so whichever row is written first points at one that does not exist
  // yet. Minting the token first fails the FK outright. Hence: agent (unlinked) → token (bound
  // to the agent) → link back. 0026 made this cycle survivable by dropping NOT NULL from
  // oauth_tokens.agent_id; PLNR-143 is where the cycle stops existing at all.
  await c.env.DB.prepare(
    `INSERT INTO agents (id, name, label, role, status, kind, user_id, project_id, runner_id, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, 'active', 'agent', ?, ?, ?, ?, ?)`,
  ).bind(agentId, name, label, b.role, conn.userId, run.projectId, run.runnerId, nowIso(), nowIso()).run();
  const tokens = await issueTokens(c.env.DB, conn.clientId, conn.userId, agentId, 'mcp');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE agents SET oauth_token_id = ? WHERE id = ?').bind(tokens.tokenId, agentId),
    c.env.DB.prepare('UPDATE runs SET agent_id = ? WHERE id = ?').bind(agentId, runId),
  ]);

  return c.json({
    agentId,
    label,
    projectId: run.projectId,
    token: tokens.access_token,
    expiresIn: tokens.expires_in,
  });
});

// Steering-ack (RUN-7): the daemon reports it delivered a steer to the agent over
// the runtime channel. Record it so the MCP notices fallback won't double-deliver
// (the dedup guard consumed in computeUpdates). agentAuth → the runner's owner.
const SteerAckBody = z.object({
  messageId: z.string(),
  agentId: z.string().optional(), // defaults to the Run's spawned agent
  via: z.enum(['runtime', 'fallback', 'dropped']).default('runtime'),
});
app.post('/api/runs/:runId/steer-ack', agentAuth, async (c) => {
  const runId = c.req.param('runId')!;
  const parsed = SteerAckBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid steer-ack', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  const run = await c.env.DB.prepare(
    `SELECT r.agent_id AS agentId, rn.owner_user_id AS owner
     FROM runs r LEFT JOIN runners rn ON rn.id = r.runner_id WHERE r.id = ?`,
  ).bind(runId).first<{ agentId: string | null; owner: string | null }>();
  if (!run || run.owner !== c.var.connection!.userId) return c.json({ error: 'run not found' }, 404);
  // Only a live runtime delivery suppresses the notices fallback; fallback/dropped
  // leave the notice to fire normally.
  if (b.via === 'runtime') {
    const agentId = b.agentId ?? run.agentId;
    if (!agentId) return c.json({ error: 'no agent to attribute delivery to' }, 400);
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO runtime_deliveries (agent_id, message_id, run_id) VALUES (?, ?, ?)',
    ).bind(agentId, b.messageId, runId).run();
  }
  return c.json({ ok: true, suppressed: b.via === 'runtime' });
});

// --- per-task event timeline (PLNR-34) ----------------------------------------------
app.get('/api/tasks/:tid/events', userAuth, async (c) => {
  const tid = c.req.param('tid')!;
  const task = await c.env.DB.prepare('SELECT project_id AS pid FROM tasks WHERE id = ?').bind(tid).first<{ pid: string }>();
  if (!task) return c.json({ error: 'not found' }, 404);
  if (!(await reachesProject(c, task.pid))) return c.json({ error: 'not found' }, 404); // PLNR-97
  const { results } = await c.env.DB.prepare(
    `SELECT id, seq, actor_kind AS actorKind, actor_id AS actorId, verb, payload, created_at AS createdAt
     FROM events WHERE project_id = ?2 AND (subject_id = ?1 OR payload LIKE '%"taskId":"' || ?1 || '"%')
     ORDER BY rowid DESC LIMIT 60`,
  ).bind(tid, task.pid).all();
  return c.json({ events: results.map((e) => ({ ...e, payload: JSON.parse(String(e.payload)) })) });
});

// --- attachments (PLNR-31): bytes in R2, metadata in D1 -------------------------------
const MAX_ATTACHMENT = 100 * 1024 * 1024;

app.post('/api/tasks/:tid/attachments', userAuth, async (c) => {
  if (!c.env.FILES) return c.json({ error: 'attachments not configured — enable R2 and bind FILES (see wrangler.jsonc)' }, 503);
  const tid = c.req.param('tid')!;
  const task = await c.env.DB.prepare('SELECT id, project_id AS pid FROM tasks WHERE id = ?').bind(tid)
    .first<{ id: string; pid: string }>();
  if (!task) return c.json({ error: 'task not found' }, 404);
  if (!(await reachesProject(c, task.pid))) return c.json({ error: 'task not found' }, 404); // PLNR-98
  const filename = (c.req.query('filename') ?? 'file').replace(/[\/\\]/g, '_').slice(0, 120);
  // Early reject on an honest oversized Content-Length; but the header is
  // client-controlled, so the REAL size is enforced from R2 after the stream lands
  // (a forged small length used to under-report while R2 stored the full body — PLNR-98).
  if (Number(c.req.header('Content-Length') ?? '0') > MAX_ATTACHMENT) {
    return c.json({ error: 'attachment must be 1 byte – 100 MB' }, 413);
  }
  const id = newId('att');
  const key = `att/${task.pid}/${id}/${filename}`;
  const ct = c.req.header('Content-Type') ?? 'application/octet-stream';
  const obj = await c.env.FILES.put(key, c.req.raw.body, { httpMetadata: { contentType: ct } });
  const size = obj?.size ?? 0;
  if (!size || size > MAX_ATTACHMENT) {
    await c.env.FILES.delete(key).catch(() => {});
    return c.json({ error: 'attachment must be 1 byte – 100 MB' }, 413);
  }
  await c.env.DB.prepare(
    `INSERT INTO attachments (id, task_id, filename, content_type, size, r2_key, uploaded_by_kind, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'human', ?, ?)`,
  ).bind(id, tid, filename, ct, size, key, c.var.user!.id, nowIso()).run();
  await room(c.env, task.pid).noteAttachment(task.pid, humanActor(c), tid, filename, id);
  return c.json({ id, filename, size });
});

app.get('/api/attachments/:aid', userAuth, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT a.r2_key AS key, a.filename, a.content_type AS ct, t.project_id AS pid
     FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?`,
  ).bind(c.req.param('aid')!).first<{ key: string; filename: string; ct: string; pid: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (!(await reachesProject(c, row.pid))) return c.json({ error: 'not found' }, 404); // PLNR-97
  if (!c.env.FILES) return c.json({ error: 'attachments not configured' }, 503);
  const obj = await c.env.FILES.get(row.key);
  if (!obj) return c.json({ error: 'file missing from storage' }, 404);
  // Show viewable types inline (images, PDF, text, media) so a click opens in the
  // browser instead of forcing a download. SVG is excluded — as same-origin markup it
  // can carry script — so it downloads. Everything else downloads too.
  const inlineable = /^(image\/(?!svg)|application\/pdf$|text\/|audio\/|video\/|application\/json)/.test(row.ct);
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.ct,
      'Content-Disposition': `${inlineable ? 'inline' : 'attachment'}; filename="${row.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

app.delete('/api/attachments/:aid', userAuth, async (c) => {
  const row = await c.env.DB.prepare('SELECT id, r2_key AS key, uploaded_by AS uploader FROM attachments WHERE id = ?')
    .bind(c.req.param('aid')!).first<{ id: string; key: string; uploader: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (c.var.user!.role !== 'admin' && row.uploader !== c.var.user!.id) return c.json({ error: 'not yours' }, 403);
  if (c.env.FILES) await c.env.FILES.delete(row.key);
  await c.env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(row.id).run();
  return c.json({ ok: true });
});

// --- GitHub webhook (Phase 4: reflect PR/commit state onto tasks) ----------------
app.post('/api/webhooks/github', async (c) => {
  const payload = await c.req.text();
  if (c.env.GITHUB_WEBHOOK_SECRET) {
    const sig = c.req.header('X-Hub-Signature-256') ?? '';
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(c.env.GITHUB_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const expected = 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (sig !== expected) return c.json({ error: 'bad signature' }, 401);
  }
  const event = c.req.header('X-GitHub-Event');
  if (event !== 'pull_request') return c.json({ ok: true, ignored: event });
  const body = JSON.parse(payload);
  const pr = body.pull_request;
  if (!pr) return c.json({ ok: true });
  // Match task keys (e.g. PLN-42) in the PR title/branch and reflect state.
  const text = `${pr.title ?? ''} ${pr.head?.ref ?? ''}`;
  const keys = [...new Set([...text.matchAll(/\b([A-Z][A-Z0-9]{0,7}-\d+)\b/g)].map((m) => m[1]!))];
  const state = pr.merged ? 'merged' : pr.state; // open | closed | merged
  const updated: string[] = [];
  for (const key of keys) {
    const task = await c.env.DB.prepare('SELECT id, project_id AS pid, key, status FROM tasks WHERE key = ?')
      .bind(key).first<{ id: string; pid: string; key: string; status: string }>();
    if (!task) continue;
    await c.env.DB.prepare(
      `INSERT INTO task_refs (id, task_id, kind, ref, url, state, created_at) VALUES (?, ?, 'pr', ?, ?, ?, ?)
       ON CONFLICT (task_id, kind, ref) DO UPDATE SET state = excluded.state, url = excluded.url`,
    ).bind(`ref_${crypto.randomUUID().slice(0, 12)}`, task.id, String(pr.number), pr.html_url ?? null, state, nowIso()).run();
    const sys: Actor = { kind: 'system', id: 'github', name: 'github' };
    if (state === 'merged' && !['done', 'cancelled'].includes(task.status)) {
      await room(c.env, task.pid).updateTask(task.pid, sys, task.id, { status: 'done' });
    } else if (state === 'open' && task.status === 'in_progress') {
      await room(c.env, task.pid).updateTask(task.pid, sys, task.id, { status: 'review' });
    }
    updated.push(key);
  }
  return c.json({ ok: true, updated });
});

app.onError((err, c) => {
  const status = (err as { status?: number }).status ?? 500;
  if (wantsHtml(c.req.raw)) return c.html(errorPage(status, status >= 500 ? undefined : err.message), status as never);
  return c.json({ error: err.message }, status as never);
});

// 404 for unmatched routes: styled page for navigations, JSON otherwise.
app.notFound((c) => {
  if (wantsHtml(c.req.raw)) return c.html(errorPage(404), 404);
  return c.json({ error: 'not found' }, 404);
});

// Scheduled backup (PLNR-21): the cron trigger in wrangler.jsonc fires this; it writes
// a D1 snapshot to R2. No-op (logged) when R2 isn't configured, so it's safe by default.
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      backupToR2(env, new Date(event.scheduledTime).toISOString()).then((r) => {
        // eslint-disable-next-line no-console
        console.log(r.ok ? `[backup] wrote ${r.key}` : `[backup] skipped: ${r.reason}`);
      }),
    );
    // Backstop auto-archive for projects nobody has viewed (the snapshot sweeps viewed ones).
    ctx.waitUntil(
      env.DB.prepare(
        "UPDATE tasks SET archived_at = ? WHERE status = 'done' AND archived_at IS NULL AND updated_at < ?",
      ).bind(new Date(event.scheduledTime).toISOString(), new Date(event.scheduledTime - 24 * 3600 * 1000).toISOString()).run().then(() => {}),
    );
  },
};
