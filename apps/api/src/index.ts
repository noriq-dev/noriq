import { Hono } from 'hono';
import { StreamableHTTPTransport } from '@hono/mcp';
import type { Env } from './env';
import { adminAuth, agentAuth, userAuth, type AppContext } from './auth';
import { buildMcpServer } from './mcp';
import { hashPassword, newApiKey, newId, nowIso, sha256Hex, verifyPassword } from './lib/util';
import type { Actor } from './do/ProjectRoom';
import { SKILL_MD } from './skill';

export { ProjectRoom } from './do/ProjectRoom';
export { AgentSession } from './do/AgentSession';

const app = new Hono<AppContext>();

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

// --- human auth -----------------------------------------------------------------
app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const user = await c.env.DB.prepare('SELECT id, email, name, role, password_hash AS hash FROM users WHERE email = ?')
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
    `SELECT p.id, p.key, p.name, p.description, p.status, p.repo_url AS repoUrl,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'in_progress') AS liveTasks
     FROM projects p WHERE p.status = 'active' ORDER BY p.created_at`,
  ).all();
  return c.json({ projects: results });
});

app.get('/api/projects/:pid/snapshot', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const [project, tasks, deps, agents, events, milestones] = await Promise.all([
    c.env.DB.prepare('SELECT id, key, name, description, claim_ttl_seconds AS claimTtlSeconds, repo_url AS repoUrl FROM projects WHERE id = ?')
      .bind(pid).first(),
    c.env.DB.prepare(
      `SELECT id, key, title, body, status, priority, claimed_by AS claimedBy, claim_expires_at AS claimExpiresAt,
              parent_task_id AS parentTaskId, milestone_id AS milestoneId, open_comments AS openComments, "order"
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
  ]);
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json({
    project,
    tasks: tasks.results,
    dependencies: deps.results,
    agents: agents.results,
    milestones: milestones.results,
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
