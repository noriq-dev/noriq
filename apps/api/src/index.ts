import { Hono } from 'hono';
import { StreamableHTTPTransport } from '@hono/mcp';
import type { Env } from './env';
import { adminAuth, agentAuth, userAuth, type AppContext } from './auth';
import { buildMcpServer } from './mcp';
import { hashPassword, newApiKey, newId, nowIso, sha256Hex, verifyPassword } from './lib/util';
import type { Actor } from './do/ProjectRoom';
import { SKILL_MD } from './skill';
import { metadataRoutes, oauth } from './oauth';
import { onboarding } from './onboarding';

export { ProjectRoom } from './do/ProjectRoom';
export { AgentSession } from './do/AgentSession';

const app = new Hono<AppContext>();

// OAuth 2.1 AS for MCP clients: discovery + register/authorize/token.
metadataRoutes(app);
app.route('/oauth', oauth);
app.route('/', onboarding);

const room = (env: Env, projectId: string) => env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
const humanActor = (c: { var: { user?: { id: string; name: string } } }): Actor => ({
  kind: 'human',
  id: c.var.user!.id,
  name: c.var.user!.name,
});

// --- health -----------------------------------------------------------------
app.get('/api/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1, service: 'planar', version: '0.2.0' });
});

// --- MCP (agents) -------------------------------------------------------------
app.all('/mcp', agentAuth, async (c) => {
  const server = buildMcpServer(c.env, c.var.agent!);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

// --- agent skill (served by planar itself; ROADMAP Phase 5) -------------------
app.get('/skill.md', (c) => c.text(SKILL_MD, 200, { 'Content-Type': 'text/markdown; charset=utf-8' }));

// --- live channel --------------------------------------------------------------
app.get('/ws/projects/:projectId', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('expected WebSocket upgrade', 426);
  }
  return room(c.env, c.req.param('projectId')).fetch(c.req.raw);
});

// --- admin bootstrap (agent keys, users) ----------------------------------------
app.post('/api/admin/agents', adminAuth, async (c) => {
  const body = await c.req.json<{ name: string; role?: 'orchestrator' | 'worker' }>();
  if (!body.name) return c.json({ error: 'name required' }, 400);
  const key = newApiKey();
  const id = newId('agt');
  await c.env.DB.prepare(
    `INSERT INTO agents (id, name, role, status, api_key_hash, created_at) VALUES (?, ?, ?, 'idle', ?, ?)`,
  ).bind(id, body.name, body.role ?? 'worker', await sha256Hex(key), nowIso()).run();
  // The raw key is returned exactly once; only its hash is stored.
  return c.json({ id, name: body.name, role: body.role ?? 'worker', apiKey: key });
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

// --- UI read API (session-authed) -------------------------------------------------
app.get('/api/projects', userAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.key, p.name, p.description, p.status, p.repo_url AS repoUrl, p.group_id AS groupId,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'in_progress') AS liveTasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS openTasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS totalTasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS doneTasks
     FROM projects p WHERE p.status = 'active' ORDER BY p.created_at`,
  ).all();
  return c.json({ projects: results });
});

app.get('/api/projects/:pid/snapshot', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const [project, tasks, deps, agents, events, milestones, plans, phases, phaseTasks, categories] = await Promise.all([
    c.env.DB.prepare('SELECT id, key, name, description, claim_ttl_seconds AS claimTtlSeconds, repo_url AS repoUrl FROM projects WHERE id = ?')
      .bind(pid).first(),
    c.env.DB.prepare(
      `SELECT id, key, title, body, status, priority, claimed_by AS claimedBy, claim_expires_at AS claimExpiresAt,
              parent_task_id AS parentTaskId, milestone_id AS milestoneId, category_id AS categoryId,
              open_comments AS openComments, "order"
       FROM tasks WHERE project_id = ? ORDER BY "order"`,
    ).bind(pid).all(),
    c.env.DB.prepare(
      `SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnTaskId
       FROM dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
    ).bind(pid).all(),
    c.env.DB.prepare(
      `SELECT DISTINCT a.id, a.name, a.role, a.status, a.last_seen_at AS lastSeenAt
       FROM agents a WHERE a.status != 'revoked' ORDER BY a.created_at`,
    ).all(),
    c.env.DB.prepare(
      `SELECT id, seq, actor_kind AS actorKind, actor_id AS actorId, verb, subject_type AS subjectType,
              subject_id AS subjectId, payload, created_at AS createdAt
       FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT 60`,
    ).bind(pid).all(),
    c.env.DB.prepare('SELECT id, title, due_at AS dueAt, "order" FROM milestones WHERE project_id = ? ORDER BY "order"').bind(pid).all(),
    c.env.DB.prepare('SELECT id, agent_id AS agentId, title, description, created_at AS createdAt FROM plans WHERE project_id = ? ORDER BY created_at DESC').bind(pid).all(),
    c.env.DB.prepare('SELECT ph.id, ph.plan_id AS planId, ph.title, ph."order" FROM phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ? ORDER BY ph."order"').bind(pid).all(),
    c.env.DB.prepare('SELECT pt.phase_id AS phaseId, pt.task_id AS taskId FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ?').bind(pid).all(),
    c.env.DB.prepare('SELECT id, name, color, "order" FROM categories WHERE project_id = ? ORDER BY "order"').bind(pid).all(),
  ]);
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json({
    project,
    tasks: tasks.results,
    dependencies: deps.results,
    agents: agents.results,
    milestones: milestones.results,
    plans: plans.results,
    phases: phases.results,
    phaseTasks: phaseTasks.results,
    categories: categories.results,
    events: events.results.map((e) => ({ ...e, payload: JSON.parse(String(e.payload)) })),
  });
});

app.get('/api/tasks/:tid', userAuth, async (c) => {
  const tid = c.req.param('tid')!;
  const task = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(tid).first();
  if (!task) return c.json({ error: 'not found' }, 404);
  const [comments, refs] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, author_kind AS authorKind, author_id AS authorId, kind, body, status, parent_comment_id AS parentCommentId, created_at AS createdAt
       FROM comments WHERE task_id = ? ORDER BY created_at`,
    ).bind(tid).all(),
    c.env.DB.prepare('SELECT kind, ref, url, state FROM task_refs WHERE task_id = ?').bind(tid).all(),
  ]);
  return c.json({ task, comments: comments.results, refs: refs.results });
});

// --- UI write API (all writes go through ProjectRoom; a human is just another actor) ---
app.post('/api/projects', userAuth, async (c) => {
  const body = await c.req.json<{ key: string; name: string; description?: string }>();
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(body.key ?? '')) return c.json({ error: 'key must be 1-8 uppercase letters/digits' }, 400);
  const id = `prj_${body.key.toLowerCase()}`;
  await c.env.DB.prepare(
    `INSERT INTO projects (id, key, name, description, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
  ).bind(id, body.key, body.name, body.description ?? '', nowIso()).run();
  await room(c.env, id).createMilestone(id, humanActor(c), 'Backlog');
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

app.post('/api/projects/:pid/tasks', userAuth, async (c) => {
  const body = await c.req.json<{ title: string; body?: string; parentTaskId?: string; priority?: number; dependsOn?: string[] }>();
  if (!body.title) return c.json({ error: 'title required' }, 400);
  const result = await room(c.env, c.req.param('pid')!).createTask(c.req.param('pid')!, humanActor(c), body);
  return c.json(result);
});

app.patch('/api/projects/:pid/tasks/:tid', userAuth, async (c) => {
  const patch = await c.req.json();
  const result = await room(c.env, c.req.param('pid')!).updateTask(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, patch);
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

app.post('/api/projects/:pid/tasks/:tid/release', userAuth, async (c) => {
  const { toStatus } = await c.req.json<{ toStatus?: string }>().catch(() => ({ toStatus: undefined }));
  const result = await room(c.env, c.req.param('pid')!).releaseTask(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, { toStatus });
  return c.json(result);
});

// --- groups (collections of projects) ----------------------------------------------
app.get('/api/groups', userAuth, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, description, "order" FROM groups ORDER BY "order", created_at').all();
  return c.json({ groups: results });
});

app.post('/api/groups', userAuth, async (c) => {
  const body = await c.req.json<{ name: string; description?: string }>();
  if (!body.name) return c.json({ error: 'name required' }, 400);
  const id = newId('grp');
  await c.env.DB.prepare('INSERT INTO groups (id, name, description, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, body.name, body.description ?? '', nowIso()).run();
  return c.json({ id, name: body.name });
});

app.patch('/api/projects/:pid/meta', userAuth, async (c) => {
  const body = await c.req.json<{ groupId?: string | null; description?: string; name?: string }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.groupId !== undefined) { sets.push('group_id = ?'); binds.push(body.groupId); }
  if (body.description !== undefined) { sets.push('description = ?'); binds.push(body.description); }
  if (body.name !== undefined) { sets.push('name = ?'); binds.push(body.name); }
  if (!sets.length) return c.json({ ok: true });
  binds.push(c.req.param('pid')!);
  await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return c.json({ ok: true });
});

// --- categories (custom, per project) -----------------------------------------------
app.post('/api/projects/:pid/categories', userAuth, async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) return c.json({ error: 'name required' }, 400);
  const pid = c.req.param('pid')!;
  const id = await room(c.env, pid).resolveCategory(pid, humanActor(c), name);
  return c.json({ id, name: name.trim() });
});

// --- user management ------------------------------------------------------------------
const requireAdmin = (c: { var: { user?: { role: string } } }) => c.var.user?.role === 'admin';

app.get('/api/users', userAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at AS createdAt,
            (u.password_hash IS NULL AND NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id)) AS pending,
            (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
            (SELECT GROUP_CONCAT(g.id) FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE ug.user_id = u.id) AS groupIds
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
  const { name, description } = await c.req.json<{ name?: string; description?: string }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (name !== undefined) { sets.push('name = ?'); binds.push(name); }
  if (description !== undefined) { sets.push('description = ?'); binds.push(description); }
  if (!sets.length) return c.json({ ok: true });
  binds.push(c.req.param('gid')!);
  await c.env.DB.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return c.json({ ok: true });
});

app.delete('/api/groups/:gid', userAuth, async (c) => {
  const gid = c.req.param('gid')!;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE projects SET group_id = NULL WHERE group_id = ?').bind(gid),
    c.env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(gid),
  ]);
  return c.json({ ok: true });
});

// --- agent management (admin humans) ------------------------------------------------

app.get('/api/agents', userAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.role, a.status, a.last_seen_at AS lastSeenAt, a.created_at AS createdAt,
            (SELECT COUNT(*) FROM tasks t WHERE t.claimed_by = a.id) AS heldTasks,
            (SELECT COUNT(*) FROM claims cl WHERE cl.agent_id = a.id) AS totalClaims
     FROM agents a ORDER BY a.created_at`,
  ).all();
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

app.post('/api/agents', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const body = await c.req.json<{ name: string; role?: 'orchestrator' | 'worker' }>();
  if (!body.name) return c.json({ error: 'name required' }, 400);
  const key = newApiKey();
  const id = newId('agt');
  await c.env.DB.prepare(
    `INSERT INTO agents (id, name, role, status, api_key_hash, created_at) VALUES (?, ?, ?, 'idle', ?, ?)`,
  ).bind(id, body.name, body.role ?? 'worker', await sha256Hex(key), nowIso()).run();
  return c.json({ id, name: body.name, role: body.role ?? 'worker', apiKey: key });
});

app.post('/api/agents/:aid/revoke', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  await c.env.DB.prepare("UPDATE agents SET status = 'revoked' WHERE id = ?").bind(c.req.param('aid')!).run();
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

app.onError((err, c) => c.json({ error: err.message }, 400));

export default app;
