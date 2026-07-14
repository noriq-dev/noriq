import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { StreamableHTTPTransport } from '@hono/mcp';
import type { Env } from './env';
import { adminAuth, agentAuth, resolveSessionAgent, userAuth, type AppContext } from './auth';
import { buildMcpServer } from './mcp';
import { renderMcpReference, mcpReferenceJson } from './reference';
import { backupToR2, exportSnapshot } from './backup';
import { hashPassword, newApiKey, newId, nowIso, sha256Hex, verifyPassword } from './lib/util';
import { USER_PROJECT_WHERE } from './lib/visibility';
import type { Actor } from './do/ProjectRoom';
import { SKILL_MD } from './skill';
import { metadataRoutes, oauth } from './oauth';
import { errorPage, wantsHtml } from './errorPage';
import { onboarding } from './onboarding';

export { ProjectRoom } from './do/ProjectRoom';
export { AgentSession } from './do/AgentSession';
export { RateLimiter } from './do/RateLimiter';

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

  // Agents are per MCP SESSION (a chat / sub-agent), not per connection. We issue a
  // session id at initialize and the client echoes it back (Mcp-Session-Id); each
  // session resolves to its own agent. Sessionless (legacy) calls use the connection's
  // default agent.
  const raw = await c.req.json().catch(() => null);
  const msgs = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const isInit = msgs.some((m) => m?.method === 'initialize');
  let sessionId = c.req.header('mcp-session-id') || undefined;
  if (isInit && !sessionId) sessionId = crypto.randomUUID();
  let agent = c.var.agent!;
  if (sessionId) {
    agent = await resolveSessionAgent(c.env, conn, sessionId);
    if (isInit) c.header('Mcp-Session-Id', sessionId);
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
  return room(c.env, c.req.param('projectId')).fetch(c.req.raw);
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
 *  project is shared — visible to all users; ownerless/legacy projects stay visible;
 *  admins see everything. Binds: ?=role, ?=userId. */
const VISIBILITY_WHERE = `(
  ? = 'admin'
  OR p.owner_user_id = ?
  OR p.group_id IS NOT NULL
  OR (p.group_id IS NULL AND p.owner_user_id IS NULL)
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
  ).bind(pid, u.role, u.id).first();
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
    c.env.DB.prepare('SELECT id, agent_id AS agentId, title, description, body, created_at AS createdAt FROM plans WHERE project_id = ? ORDER BY created_at DESC').bind(pid).all(),
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
  await c.env.DB.prepare('INSERT INTO groups (id, name, description, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, body.name, body.description ?? '', nowIso()).run();
  // The creator becomes a member so they can manage (and see) the group they made.
  await c.env.DB.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)')
    .bind(c.var.user!.id, id).run();
  return c.json({ id, name: body.name });
});

app.patch('/api/projects/:pid/meta', userAuth, async (c) => {
  const body = await c.req.json<{ groupId?: string | null; description?: string; name?: string; claimTtlSeconds?: number; ownerUserId?: string | null }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.groupId !== undefined) { sets.push('group_id = ?'); binds.push(body.groupId); }
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
  binds.push(c.req.param('pid')!);
  await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
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
  const where = projectId ? 'WHERE a.project_id = ?' : 'WHERE a.project_id IS NOT NULL';
  const stmt = c.env.DB.prepare(
    `SELECT a.id, COALESCE(a.label, a.name) AS name, a.role, a.status, a.last_seen_at AS lastSeenAt, a.created_at AS createdAt,
            a.parent_agent_id AS parentAgentId, u.name AS ownerName, u.id AS ownerUserId,
            (SELECT COUNT(*) FROM tasks t WHERE t.claimed_by = a.id) AS heldTasks,
            (SELECT COUNT(*) FROM claims cl WHERE cl.agent_id = a.id) AS totalClaims
     FROM agents a LEFT JOIN users u ON u.id = a.user_id ${where} ORDER BY a.created_at`,
  );
  const { results } = await (projectId ? stmt.bind(projectId) : stmt).all();
  return c.json({ agents: results });
});

app.get('/api/agents/:aid/events', userAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.project_id AS projectId, e.seq, e.verb, e.subject_type AS subjectType, e.subject_id AS subjectId,
            e.payload, e.created_at AS createdAt
     FROM events e WHERE e.actor_id = ? ORDER BY e.rowid DESC LIMIT 50`,
  ).bind(c.req.param('aid')!).all();
  return c.json({ events: results.map((e) => ({ ...e, payload: JSON.parse(String(e.payload)) })) });
});

app.post('/api/agents/:aid/revoke', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  await c.env.DB.prepare("UPDATE agents SET status = 'revoked' WHERE id = ?").bind(c.req.param('aid')!).run();
  return c.json({ ok: true });
});

// --- per-task event timeline (PLNR-34) ----------------------------------------------
app.get('/api/tasks/:tid/events', userAuth, async (c) => {
  const tid = c.req.param('tid')!;
  const { results } = await c.env.DB.prepare(
    `SELECT id, seq, actor_kind AS actorKind, actor_id AS actorId, verb, payload, created_at AS createdAt
     FROM events WHERE subject_id = ?1 OR payload LIKE '%"taskId":"' || ?1 || '"%'
     ORDER BY rowid DESC LIMIT 60`,
  ).bind(tid).all();
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
  const filename = (c.req.query('filename') ?? 'file').replace(/[\/\\]/g, '_').slice(0, 120);
  const size = Number(c.req.header('Content-Length') ?? '0');
  if (!size || size > MAX_ATTACHMENT) return c.json({ error: 'attachment must be 1 byte – 100 MB' }, 413);
  const id = newId('att');
  const key = `att/${task.pid}/${id}/${filename}`;
  await c.env.FILES.put(key, c.req.raw.body, {
    httpMetadata: { contentType: c.req.header('Content-Type') ?? 'application/octet-stream' },
  });
  await c.env.DB.prepare(
    `INSERT INTO attachments (id, task_id, filename, content_type, size, r2_key, uploaded_by_kind, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'human', ?, ?)`,
  ).bind(id, tid, filename, c.req.header('Content-Type') ?? 'application/octet-stream', size, key, c.var.user!.id, nowIso()).run();
  await room(c.env, task.pid).noteAttachment(task.pid, humanActor(c), tid, filename, id);
  return c.json({ id, filename, size });
});

app.get('/api/attachments/:aid', userAuth, async (c) => {
  const row = await c.env.DB.prepare('SELECT r2_key AS key, filename, content_type AS ct FROM attachments WHERE id = ?')
    .bind(c.req.param('aid')!).first<{ key: string; filename: string; ct: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
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
