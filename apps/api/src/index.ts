import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { StreamableHTTPTransport } from '@hono/mcp';
import type { Env } from './env';
import { adminAuth, agentAuth, readSessionId, resolveSessionAgent, SESSION_CLEAR_COOKIE, sessionSetCookie, userAuth, type AppContext } from './auth';
import { buildMcpServer, INSTRUCTIONS, GET_BRIEFING_PLAYBOOK } from './mcp';
import { handleModernMcp, isModernMcpRequest } from './mcp-2026';
import { renderMcpReference, mcpReferenceJson } from './reference';
import { backupToR2, exportSnapshot, importSnapshot } from './backup';
import { sweepPendingErasures, sweepProjectDebris, sweepProjectDebrisForProject, listProjectBackupGenerations } from './memory/lifecycle';
import { hashPassword, newApiKey, newId, nowIso, sha256Hex, timingSafeEqual, verifyPassword, verifyPasswordConstantTime } from './lib/util';
import { taskSearchFilters } from './lib/search';
import type { ExecutionSpecInput, RunStatus } from '@noriq-dev/shared';
import { readExecutionSpec } from './lib/execution-spec';
import { search, searchBackend, reindexProject, ALL_KINDS, type SearchKind } from './search';
import { answerQuestion, generationClient } from './ask';
import { verifyUploadToken, resolveUploadSecret, signIngestToken, verifyIngestToken, type IngestClaims } from './lib/upload-token';
import { USER_PROJECT_WHERE, taskWireStatus, tokenCanReachProject, tokenProjectWhere, userCanAccessProject } from './lib/visibility';
import { advertisedWorkflowNames } from './lib/workflows';
import type { Actor, RunView } from './do/ProjectRoom';
import { SKILL_MD, SKILL_REFERENCES, SKILL_MD_SURFACE } from './skill';
import { DOC_SKILL_MD } from './skill-docs';
import pkg from '../package.json';
import { issueTokens, metadataRoutes, oauth } from './oauth';
import { demoLocksDown } from './lib/demo';
import { isMaintenanceMode, MAINTENANCE_MESSAGE } from './lib/maintenance';
import { errorPage, wantsHtml } from './errorPage';
import { onboarding } from './onboarding';
import { z } from 'zod';
import {
  listProjectRepositories, listRepositoryCheckouts, resolveRepositoryByKey, loadPriorEffort, searchHitToEvidenceItem,
  getMemoryRegistry, memoryCapabilities, deriveRepositoryMemoryState, checkoutAssociationState, type ProjectMemoryStub,
} from './lib/project-memory';
import { renderEvidenceFrame, type EvidenceFrameItem } from './memory/evidence-frame';
import { assembleContextPack } from './memory/context-pack';
import { readBoundedBody, verifyBatchChecksum, decodeBatchRows, MAX_INGEST_BATCH_BYTES, INGEST_TOKEN_TTL_SECONDS } from './memory/ingest';
import { normalizeVerificationReport } from './memory/verification';
import { sweepPendingEpisodeJobs } from './memory/episodes';
import { AgentTool, AdvertisedAgent, RunEffort, RunKind, RunnerRepo, RunBudget, isTerminalRunStatus, normalizeProjectKey, IndexGenerationManifest, ContextPackRole, type RunnerIndexCursor } from '@noriq-dev/shared';

export { ProjectRoom } from './do/ProjectRoom';
export { AgentSession } from './do/AgentSession';
export { RateLimiter } from './do/RateLimiter';
export { RunnerHub } from './do/RunnerHub';
export { ProjectMemory } from './do/ProjectMemory';

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

// Write-freeze (PLNR-166): when MAINTENANCE_MODE is on, refuse mutating requests with a
// retryable 503 so nothing is acked into a database about to be swapped out (PLNR-164);
// reads stay live. Registered before every route so no handler can slip a write past it.
// Exemptions: GET/HEAD/OPTIONS (reads); /mcp (gated per-tool instead — its reads must stay
// live on the same POST endpoint); auth/OAuth/health/ws (bootstrap + observation, not the
// acked coordination-write contract, and trivially redone if a session is lost); and
// /api/admin/import — a restore is the one write you DO want under a freeze (a deliberate
// admin DB replacement, with the freeze holding off the coordination writes that would race it).
// /api/admin/memory-restore is the same exception for ProjectMemory (PLNR-249) — matches both
// the restore route and its /rollback sibling by prefix; /api/admin/memory-backup is NOT
// exempt, matching /api/admin/backup/export above it (an export is safe to defer, not something
// you need mid-freeze).
const FREEZE_EXEMPT_PREFIXES = ['/mcp', '/oauth/', '/.well-known/', '/api/auth/', '/api/reset', '/api/setup', '/api/health', '/ws/', '/api/admin/import', '/api/admin/memory-restore'];
app.use('*', async (c, next) => {
  if (!isMaintenanceMode(c.env)) return next();
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const path = new URL(c.req.url).pathname;
  if (FREEZE_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p))) return next();
  return c.json({ error: MAINTENANCE_MESSAGE }, 503, { 'Retry-After': '30' });
});

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

/** The "poor demo" gate for cookie routes (PLNR-199): returns a 403 Response to short-circuit
 *  the handler when the demo visitor tries a locked-down action, or null to proceed. Requires
 *  userAuth to have run (c.var.user set). See demoLocksDown for the policy. */
const demoDenied = (c: Context<AppContext>): Response | null =>
  demoLocksDown(c.env, c.get('user')?.email)
    ? c.json({ error: 'This action is disabled in the demo.' }, 403)
    : null;

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

/** Resolve a dependency BLOCKER ref on the human path (PLNR-241): id or display key (both
 *  globally unique), in this project or any project this session can reach — the REST twin
 *  of the MCP layer's resolveBlockerRef. Unknown and unreachable collapse into ONE error so
 *  a rejected ref never confirms that a task exists somewhere the caller cannot see. */
async function resolveBlockerRefRest(c: Context<AppContext>, pid: string, ref: string): Promise<string> {
  const t = await c.env.DB.prepare('SELECT id, project_id AS tpid FROM tasks WHERE id = ? OR key = ?')
    .bind(ref, ref).first<{ id: string; tpid: string }>();
  if (t && (t.tpid === pid || (await reachesProject(c, t.tpid)))) return String(t.id);
  throw new Error(`dependsOn ${ref} not found or not accessible`);
}

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
// `version` comes from package.json (bumped every deploy) — the SPA compares it to
// its own build-time version and reloads itself when a new deploy lands (PLNR-193).
app.get('/api/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({
    ok: row?.ok === 1,
    service: 'noriq',
    version: pkg.version,
    // Surfaced so the dashboard can show a write-frozen banner (PLNR-166).
    maintenance: isMaintenanceMode(c.env),
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
  // Dual-era fork (PLNR-233): a request carrying modern per-request `_meta` (2026-07-28,
  // stateless — no initialize, no Mcp-Session-Id) is served by the compat layer; an
  // `initialize` opening (or a bare session-id request) selects the legacy path below.
  if (c.req.method === 'POST' && isModernMcpRequest(c.req.header('mcp-protocol-version'), msgs)) {
    return handleModernMcp(c, c.env, conn, msgs);
  }
  const isInit = msgs.some((m) => m?.method === 'initialize');
  // OpenAI app bridges may create a fresh MCP transport session for each tool
  // invocation. Their stable conversation identity is carried on tools/call as
  // `_meta["openai/session"]`; prefer it so one Codex/ChatGPT thread remains one
  // Noriq copilot even when Mcp-Session-Id changes underneath it.
  const openAiSession = msgs
    .map((m) => m?.params?._meta?.['openai/session'])
    .find((value) => typeof value === 'string' && value.length > 0) as string | undefined;
  let sessionId = openAiSession ? `openai:${openAiSession}` : c.req.header('mcp-session-id') || undefined;
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

  const server = buildMcpServer(c.env, agent, { oauthTokenId: conn.tokenId, sessionId, origin: new URL(c.req.url).origin });
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c, raw ?? undefined);
});

// --- agent skill (served by Noriq itself; ROADMAP Phase 5) -------------------
// PLNR-310: SKILL_MD is the core entry point; SKILL_REFERENCES are the on-demand references
// split out of it (file locks, planning, memory), each served the same way as the pre-existing
// doc-authoring guide below. Route paths are named from SKILL_REFERENCES' own keys so a new
// reference only needs adding to that map, never a second route list to keep in sync.
app.get('/skill.md', (c) => c.text(SKILL_MD, 200, { 'Content-Type': 'text/markdown; charset=utf-8' }));
app.get('/skill/docs.md', (c) => c.text(DOC_SKILL_MD, 200, { 'Content-Type': 'text/markdown; charset=utf-8' }));
for (const [slug, text] of Object.entries(SKILL_REFERENCES)) {
  app.get(`/skill/${slug}.md`, (c) => c.text(text, 200, { 'Content-Type': 'text/markdown; charset=utf-8' }));
}

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
  const sid = readSessionId(c.req.header('Cookie') ?? '');
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
    `SELECT t.user_id AS userId, u.email AS userEmail FROM oauth_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).bind(await sha256Hex(token)).first<{ userId: string; userEmail: string }>();
  if (!tok) return c.text('invalid or expired token', 401);
  // This route does its own bearer lookup (a Node client sets headers), so it bypasses
  // agentAuth's demo kill switch — re-apply it here (PLNR-199) or a rotated legacy demo
  // token could open a runner socket.
  if (demoLocksDown(c.env, tok.userEmail)) return c.text('the demo account cannot use API tokens', 401);
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
    'Content-Disposition': `attachment; filename="noriq-${at.replace(/[:.]/g, '-')}.json"`,
  });
});

// On-demand trigger of the same backup the cron runs → R2 (admin-only).
app.post('/api/admin/backup', adminAuth, async (c) => {
  const res = await backupToR2(c.env, nowIso());
  return c.json(res, res.ok ? 200 : 503);
});

// On-demand ProjectMemory portable snapshot (PLNR-248) — the per-project analogue of
// /api/admin/backup, above. Admin-only; same graceful-degradation shape when R2 isn't bound.
// projectId is a trailing segment (not nested under /projects/:id/...) so the flat path shape
// matches /api/admin/import and lets memory-restore's freeze exemption below match by prefix
// without also matching this read-mostly route. See BACKUP.md for the R2 layout.
app.post('/api/admin/memory-backup/:projectId', adminAuth, async (c) => {
  const projectId = c.req.param('projectId')!;
  const tier = c.req.query('tier') === 'full' ? 'full' : 'core';
  const res = await c.env.PROJECT_MEMORY.get(c.env.PROJECT_MEMORY.idFromName(projectId)).exportSnapshot(projectId, { tier });
  return c.json(res, res.ok ? 200 : 503);
});

// Restore a ProjectMemory snapshot (PLNR-249) — the per-project analogue of /api/admin/import.
// DESTRUCTIVE in the same sense: it replaces this project's ACTIVE generation (though never by
// deleting it first — see ProjectMemory.restoreSnapshot), so ?confirm=replace guards it and it
// is exempt from the write-freeze below, exactly like /api/admin/import: "freeze → restore →
// unfreeze" is a clean cutover. Restore + rollback runbook in BACKUP.md.
app.post('/api/admin/memory-restore/:projectId', adminAuth, async (c) => {
  if (c.req.query('confirm') !== 'replace') {
    return c.json({ error: 'refusing: this REPLACES the project\'s active memory generation. Re-POST with ?confirm=replace to proceed.' }, 400);
  }
  const projectId = c.req.param('projectId')!;
  const exportedAt = c.req.query('exportedAt');
  if (!exportedAt) return c.json({ error: 'exportedAt query param is required — the timestamp of the backup to restore' }, 400);
  const res = await c.env.PROJECT_MEMORY.get(c.env.PROJECT_MEMORY.idFromName(projectId)).restoreSnapshot(projectId, { exportedAt });
  return c.json(res, res.ok ? 200 : 400);
});

// Roll back to the retained prior generation (PLNR-249) — no R2 read, no re-upload. Single-
// level undo: only the immediately preceding generation is ever retained.
app.post('/api/admin/memory-restore/:projectId/rollback', adminAuth, async (c) => {
  const projectId = c.req.param('projectId')!;
  const res = await c.env.PROJECT_MEMORY.get(c.env.PROJECT_MEMORY.idFromName(projectId)).rollback(projectId);
  return c.json(res, res.ok ? 200 : 400);
});

// On-demand trigger of the same lifecycle sweep the cron runs (PLNR-250) — retries any standing
// erasure tombstone and prunes per-project debris. Safe to call any time; both halves are
// independently idempotent, same as the scheduled() version.
app.post('/api/admin/memory-lifecycle-sweep', adminAuth, async (c) => {
  const [erasures, debris] = await Promise.all([sweepPendingErasures(c.env), sweepProjectDebris(c.env)]);
  return c.json({ erasures, debris });
});

// Restore a snapshot (PLNR-218) — the inverse of /export. DESTRUCTIVE: REPLACES all data
// (it is not a merge), so ?confirm=replace guards the wipe. Admin-only; exempt from the
// write-freeze so "freeze → import → unfreeze" is a clean cutover. Restore steps in BACKUP.md.
app.post('/api/admin/import', adminAuth, async (c) => {
  if (c.req.query('confirm') !== 'replace') {
    return c.json({ error: 'refusing: /api/admin/import REPLACES all data. Re-POST with ?confirm=replace to proceed.' }, 400);
  }
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: 'body must be the JSON snapshot from /api/admin/export' }, 400); }
  const result = await importSnapshot(c.env, raw);
  return c.json(result, result.ok ? 200 : 400);
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
// DEMO_MODE disables it outright (PLNR-199): a demo D1 starts empty and its demo user is
// seeded lazily, so an unguarded /api/setup would let the first visitor self-install as a
// NON-demo admin (whom demoLocksDown never matches) before that seeding runs — a full
// takeover of the demo instance. A demo has no legitimate founder flow.
app.get('/api/setup/status', async (c) => {
  if (c.env.DEMO_MODE) return c.json({ needsSetup: false });
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return c.json({ needsSetup: (row?.n ?? 0) === 0 });
});

app.post('/api/setup', async (c) => {
  if (c.env.DEMO_MODE) return c.json({ error: 'setup is disabled in the demo' }, 403);
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
  c.header('Set-Cookie', sessionSetCookie(sid, expires));
  return c.json({ user: { id, email: body.email, name: body.name, role: 'admin' } });
});

// --- human auth -----------------------------------------------------------------
// Demo mode (PLNR-146): status for the login page, and the one-click session.
app.get('/api/demo/status', (c) => c.json({ enabled: !!c.env.DEMO_MODE }));
app.post('/api/demo/login', async (c) => {
  if (!c.env.DEMO_MODE) return c.json({ error: 'not found' }, 404);
  const rl = await rateLimit(c.env, `auth:${clientIp(c)}`, 10);
  if (!rl.ok) return c.json(tooMany, 429, { 'Retry-After': String(rl.retryAfter) });
  const { ensureDemoUser, resetDemo, DEMO_EMAIL } = await import('./lib/demo');
  await ensureDemoUser(c.env);
  // Seed lazily on first login so a fresh demo deployment works before the first cron.
  const seeded = await c.env.DB.prepare("SELECT 1 FROM projects WHERE id = 'prj_demo'").first();
  if (!seeded) await resetDemo(c.env);
  const user = await c.env.DB.prepare('SELECT id, email, name, role FROM users WHERE email = ?')
    .bind(DEMO_EMAIL).first<{ id: string; email: string; name: string; role: string }>();
  const sid = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + 24 * 3600 * 1000); // demo sessions live one day
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(sid), user!.id, expires.toISOString()).run();
  c.header('Set-Cookie', sessionSetCookie(sid, expires));
  return c.json({ user });
});

app.post('/api/auth/login', async (c) => {
  const rl = await rateLimit(c.env, `auth:${clientIp(c)}`, 10);
  if (!rl.ok) return c.json(tooMany, 429, { 'Retry-After': String(rl.retryAfter) });
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const user = await c.env.DB.prepare('SELECT id, email, name, role, password_hash AS hash FROM users WHERE email = ? AND disabled = 0')
    .bind((email ?? '').toLowerCase())
    .first<{ id: string; email: string; name: string; role: string; hash: string | null }>();
  // Constant-time regardless of whether the account exists (PLNR-105): a dummy PBKDF2 verify
  // runs even when there's no user/hash, so response timing doesn't enumerate accounts. The
  // `!user` check comes after the verify so both branches pay the same cost.
  const ok = await verifyPasswordConstantTime(password ?? '', user?.hash);
  if (!ok || !user) {
    return c.json({ error: 'invalid credentials' }, 401);
  }
  const sid = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(sid), user.id, expires.toISOString()).run();
  c.header('Set-Cookie', sessionSetCookie(sid, expires));
  return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.post('/api/auth/logout', userAuth, async (c) => {
  c.header('Set-Cookie', SESSION_CLEAR_COOKIE);
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

// --- Admin OAuth management (PLNR-160) --------------------------------------------
// The per-user /api/auth/sessions view, widened instance-wide for admins: every live
// connection (whose, from which client, reaching what), revocable; plus the registered
// OAuth clients with cleanup for stale registrations.
app.get('/api/admin/oauth/connections', userAuth, async (c) => {
  if (c.var.user!.role !== 'admin') return c.json({ error: 'admin role required' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, u.name AS userName, u.email AS userEmail,
            COALESCE(cl.name, 'MCP client') AS clientName, t.created_at AS createdAt, t.expires_at AS expiresAt,
            t.scoped_at IS NOT NULL AS scoped, t.scope_all AS scopeAll,
            t.agent_id IS NOT NULL AS bound,
            (SELECT GROUP_CONCAT(p.key) FROM oauth_token_projects otp JOIN projects p ON p.id = otp.project_id
              WHERE otp.token_id = t.id) AS projectKeys,
            (SELECT COUNT(*) FROM agents a WHERE a.oauth_token_id = t.id AND a.status != 'revoked') AS agentCount,
            (SELECT MAX(a.last_seen_at) FROM agents a WHERE a.oauth_token_id = t.id) AS lastActive
     FROM oauth_tokens t
     LEFT JOIN oauth_clients cl ON cl.id = t.client_id
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.revoked_at IS NULL AND t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
     ORDER BY t.created_at DESC`,
  ).all();
  return c.json({ connections: results });
});

app.post('/api/admin/oauth/connections/:id/revoke', userAuth, async (c) => {
  if (c.var.user!.role !== 'admin') return c.json({ error: 'admin role required' }, 403);
  const r = await c.env.DB.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(nowIso(), c.req.param('id')).run();
  await c.env.DB.prepare("UPDATE agents SET status = 'offline' WHERE oauth_token_id = ? AND status = 'active'")
    .bind(c.req.param('id')).run();
  return c.json({ ok: true, revoked: r.meta.changes ?? 0 });
});

app.get('/api/admin/oauth/clients', userAuth, async (c) => {
  if (c.var.user!.role !== 'admin') return c.json({ error: 'admin role required' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT cl.id, cl.name, cl.redirect_uris AS redirectUris, cl.created_at AS createdAt,
            (SELECT COUNT(*) FROM oauth_tokens t WHERE t.client_id = cl.id AND t.revoked_at IS NULL
               AND t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS liveTokens
     FROM oauth_clients cl ORDER BY cl.created_at DESC`,
  ).all();
  return c.json({ clients: results });
});

app.delete('/api/admin/oauth/clients/:id', userAuth, async (c) => {
  if (c.var.user!.role !== 'admin') return c.json({ error: 'admin role required' }, 403);
  const cid = c.req.param('id')!;
  // A client with live tokens is in use — revoke the connections first, deliberately;
  // deleting out from under them would strand rows and surprise the users involved.
  const live = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM oauth_tokens WHERE client_id = ? AND revoked_at IS NULL
       AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).bind(cid).first<{ n: number }>();
  if ((live?.n ?? 0) > 0) return c.json({ error: `client has ${live!.n} live connection(s) — revoke them first` }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM oauth_codes WHERE client_id = ?').bind(cid),
    c.env.DB.prepare('DELETE FROM oauth_device_codes WHERE client_id = ?').bind(cid),
    // Historical (revoked/expired) tokens FK the client, and agents.oauth_token_id FKs the
    // tokens (0009) — unhook the agents first (they survive; a dead token grants nothing),
    // then remove the token rows, then the client. D1 enforces FKs on execute, so order is
    // load-bearing.
    c.env.DB.prepare('UPDATE agents SET oauth_token_id = NULL WHERE oauth_token_id IN (SELECT id FROM oauth_tokens WHERE client_id = ?)').bind(cid),
    c.env.DB.prepare('DELETE FROM oauth_token_projects WHERE token_id IN (SELECT id FROM oauth_tokens WHERE client_id = ?)').bind(cid),
    c.env.DB.prepare('DELETE FROM oauth_tokens WHERE client_id = ?').bind(cid),
    c.env.DB.prepare('DELETE FROM oauth_clients WHERE id = ?').bind(cid),
  ]);
  return c.json({ ok: true });
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
  OR (p.group_id IS NOT NULL AND p.group_id IN (SELECT group_id FROM user_groups WHERE user_id = ? AND status = 'accepted'))
)`;

app.get('/api/projects', userAuth, async (c) => {
  const u = c.var.user!;
  // PLNR-83: admins see only their own projects by default (owning all of them is
  // noise); `?scope=all` opts into the admin-wide view. Non-admins always get the
  // user-scoped set. `admin` in the response tells the UI it may offer admin view.
  const adminAll = u.role === 'admin' && c.req.query('scope') === 'all';
  const select = `SELECT p.id, p.key, p.name, p.description, p.status, p.repo_url AS repoUrl, p.group_id AS groupId, p.public,
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

// Cross-project attention inbox (PLNR-121): everything that needs a HUMAN right now —
// open decisions/alerts plus overdue-and-still-open tasks (PLNR-126) — across every
// project the user can see, so "what needs me" is one call, not ten open tabs.
app.get('/api/attention', userAuth, async (c) => {
  const u = c.var.user!;
  const [signals, overdue] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.id, s.project_id AS projectId, p.key AS projectKey, s.task_id AS taskId,
              (SELECT key FROM tasks WHERE id = s.task_id) AS taskKey,
              s.agent_name AS agentName, s.type, s.severity, s.title, s.body, s.options, s.questions, s.created_at AS createdAt
       FROM signals s JOIN projects p ON p.id = s.project_id AND p.status = 'active'
       WHERE s.status = 'open' AND ${VISIBILITY_WHERE}
       ORDER BY CASE WHEN s.type = 'input_request' THEN 0 ELSE 1 END,
                CASE s.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, s.created_at`,
    ).bind(u.role, u.id, u.id).all(),
    c.env.DB.prepare(
      `SELECT t.id, t.key, t.title, t.due_at AS dueAt, ${taskWireStatus('t')} AS status, t.failed_at AS failedAt,
              t.project_id AS projectId, p.key AS projectKey
       FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
       WHERE ${VISIBILITY_WHERE}
         AND t.due_at IS NOT NULL AND t.due_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND t.status NOT IN ('done','cancelled') AND t.archived_at IS NULL
       ORDER BY t.due_at LIMIT 50`,
    ).bind(u.role, u.id, u.id).all(),
  ]);
  return c.json({
    signals: signals.results.map((s) => ({
      ...s,
      options: s.options ? JSON.parse(String(s.options)) : null,
      questions: s.questions ? JSON.parse(String(s.questions)) : null,
    })),
    overdue: overdue.results,
  });
});

// Public read-only snapshot (PLNR-78): NO auth, serves only when the owner explicitly
// flipped `public` on. Reduced payload — signals (pending human decisions/alerts) and
// operational agent detail stay private; the WORK (tasks/plans/boards/feed) is what a
// public project shows. All writes remain session/OAuth-authed; this route reads only.
app.get('/api/public/projects/:pid/snapshot', async (c) => {
  const pid = c.req.param('pid')!;
  const proj = await c.env.DB.prepare(
    'SELECT id, key, name, description, public FROM projects WHERE id = ? AND status = ?',
  ).bind(pid, 'active').first<{ id: string; key: string; name: string; description: string; public: number }>();
  if (!proj || !proj.public) return c.json({ error: 'not found' }, 404);
  const [tasks, deps, extDeps, agents, events, milestones, boards, plans, phases, phaseTasks, tags, taskTags] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, key, title, body,
              ${taskWireStatus()} AS status,
              type, priority, estimate, due_at AS dueAt, claimed_by AS claimedBy,
              parent_task_id AS parentTaskId, milestone_id AS milestoneId, board_id AS boardId, archived_at AS archivedAt,
              failed_at AS failedAt, open_comments AS openComments, "order" FROM tasks WHERE project_id = ? ORDER BY "order"`,
    ).bind(pid).all(),
    c.env.DB.prepare(
      'SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnTaskId FROM dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?',
    ).bind(pid).all(),
    // Cross-project blockers, ANONYMIZED (PLNR-241): id + status only. The status must ship
    // or a genuinely gated task renders claimable, but a public project must not leak even
    // the display key of a task in a project that never opted into being public.
    c.env.DB.prepare(
      `SELECT DISTINCT dt.id, ${taskWireStatus('dt')} AS status
       FROM dependencies d JOIN tasks t ON t.id = d.task_id
         JOIN tasks dt ON dt.id = d.depends_on_task_id
       WHERE t.project_id = ?1 AND dt.project_id != ?1`,
    ).bind(pid).all(),
    c.env.DB.prepare(
      "SELECT a.id, COALESCE(a.label, a.name) AS name, a.role, a.status FROM agents a WHERE a.project_id = ? AND a.status != 'revoked'",
    ).bind(pid).all(),
    c.env.DB.prepare(
      'SELECT id, seq, actor_kind AS actorKind, actor_id AS actorId, verb, subject_type AS subjectType, subject_id AS subjectId, payload, created_at AS createdAt FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT 60',
    ).bind(pid).all(),
    c.env.DB.prepare('SELECT id, title, due_at AS dueAt, description, "order" FROM milestones WHERE project_id = ? ORDER BY "order"').bind(pid).all(),
    c.env.DB.prepare('SELECT id, name, "order" FROM boards WHERE project_id = ? ORDER BY "order"').bind(pid).all(),
    c.env.DB.prepare('SELECT id, title, description, body, status, archived_at AS archivedAt, created_at AS createdAt FROM plans WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC').bind(pid).all(),
    c.env.DB.prepare('SELECT ph.id, ph.plan_id AS planId, ph.title, ph.body, ph."order" FROM phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ? ORDER BY ph."order"').bind(pid).all(),
    c.env.DB.prepare('SELECT pt.phase_id AS phaseId, pt.task_id AS taskId FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ?').bind(pid).all(),
    c.env.DB.prepare('SELECT id, name, color, "order" FROM tags WHERE project_id = ?').bind(pid).all(),
    c.env.DB.prepare('SELECT tt.task_id AS taskId, tt.tag_id AS tagId FROM task_tags tt JOIN tasks t ON t.id = tt.task_id WHERE t.project_id = ?').bind(pid).all(),
  ]);
  c.header('Cache-Control', 'public, max-age=30');
  return c.json({
    project: { id: proj.id, key: proj.key, name: proj.name, description: proj.description },
    tasks: tasks.results, dependencies: deps.results, externalTasks: extDeps.results, agents: agents.results,
    events: events.results.map((e) => ({ ...e, payload: JSON.parse(String(e.payload)) })),
    milestones: milestones.results, boards: boards.results, plans: plans.results,
    phases: phases.results, phaseTasks: phaseTasks.results, tags: tags.results, taskTags: taskTags.results,
  });
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
  // PLNR-225: same opportunistic sweep for completed plans (all member tasks settled >24h ago).
  await room(c.env, pid).sweepPlanArchive(pid).catch(() => {});
  const [project, tasks, deps, extDeps, agents, events, milestones, boards, plans, phases, phaseTasks, tags, taskTags, signals, taskDocs, planDocs, locks] = await Promise.all([
    c.env.DB.prepare('SELECT id, key, name, description, claim_ttl_seconds AS claimTtlSeconds, lock_ttl_seconds AS lockTtlSeconds, file_locking_enabled AS fileLockingEnabled, repo_url AS repoUrl FROM projects WHERE id = ?')
      .bind(pid).first(),
    // PLNR-150: archived tasks ship too, flagged by archivedAt. Archiving is a *board
    // display* concern — filtering it out here silently drained every derived aggregate
    // (milestone chips, plan phase rails) of the tasks it was counting, so a milestone
    // whose work was all done+archived read 0/0 instead of complete. The client hides
    // archived tasks at render; anything that counts uses the full list.
    c.env.DB.prepare(
      // status is DERIVED (PLNR-178): failed_at set → 'failed'; the stored column stays within
      // its CHECK. taskWireStatus() is the single source so every wire read stays consistent.
      `SELECT id, key, title, body,
              ${taskWireStatus()} AS status,
              type, priority, estimate, due_at AS dueAt, claimed_by AS claimedBy, claim_expires_at AS claimExpiresAt,
              parent_task_id AS parentTaskId, milestone_id AS milestoneId, board_id AS boardId, archived_at AS archivedAt,
              failed_at AS failedAt, open_comments AS openComments, "order",
              -- Spin-off surface (PLNR-230): proposedAt drives the approval UI; run/source/finding
              -- are the provenance the drawer shows a human deciding accept vs reject.
              proposed_at AS proposedAt, spinoff_run_id AS spinoffRunId,
              spinoff_source_task_id AS spinoffSourceTaskId, spinoff_finding AS spinoffFinding,
              -- Whether there IS a spec, never the spec (RUN-162). Approving a plan approves what
              -- its tasks say, so the board counts the unplanned ones; shipping every spec through
              -- this poll to draw that number would be the whole feature's payload for it.
              (execution_spec IS NOT NULL) AS specPlanned,
              -- The dispatch-workflow override (PLNR-240) — the Plans surface reads and sets it.
              workflow
       FROM tasks WHERE project_id = ? ORDER BY "order"`,
    ).bind(pid).all(),
    c.env.DB.prepare(
      `SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnTaskId
       FROM dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
    ).bind(pid).all(),
    // Foreign blockers behind cross-project edges (PLNR-241): just enough of each to
    // compute blocked state and label the chip. Redacted below for projects this
    // session cannot reach — the STATUS still ships (the gate is real either way; hiding
    // it would render a genuinely blocked task as claimable), the identity does not.
    c.env.DB.prepare(
      `SELECT DISTINCT dt.id, dt.key, dt.title, ${taskWireStatus('dt')} AS status,
              dt.project_id AS projectId, dp.key AS projectKey
       FROM dependencies d JOIN tasks t ON t.id = d.task_id
         JOIN tasks dt ON dt.id = d.depends_on_task_id
         JOIN projects dp ON dp.id = dt.project_id
       WHERE t.project_id = ?1 AND dt.project_id != ?1`,
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
    c.env.DB.prepare('SELECT id, title, due_at AS dueAt, description, "order" FROM milestones WHERE project_id = ? ORDER BY "order"').bind(pid).all(),
    c.env.DB.prepare('SELECT id, name, "order" FROM boards WHERE project_id = ? ORDER BY "order", created_at').bind(pid).all(),
    c.env.DB.prepare('SELECT id, agent_id AS agentId, title, description, body, status, archived_at AS archivedAt, created_at AS createdAt FROM plans WHERE project_id = ? ORDER BY created_at DESC').bind(pid).all(),
    c.env.DB.prepare('SELECT ph.id, ph.plan_id AS planId, ph.title, ph.body, ph."order" FROM phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ? ORDER BY ph."order"').bind(pid).all(),
    c.env.DB.prepare('SELECT pt.phase_id AS phaseId, pt.task_id AS taskId FROM phase_tasks pt JOIN phases ph ON ph.id = pt.phase_id JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ?').bind(pid).all(),
    c.env.DB.prepare('SELECT id, name, color, "order" FROM tags WHERE project_id = ? ORDER BY "order"').bind(pid).all(),
    c.env.DB.prepare('SELECT tt.task_id AS taskId, tt.tag_id AS tagId FROM task_tags tt JOIN tasks t ON t.id = tt.task_id WHERE t.project_id = ?').bind(pid).all(),
    c.env.DB.prepare(
      `SELECT s.id, s.task_id AS taskId, t.key AS taskKey, s.agent_id AS agentId, s.agent_name AS agentName,
              s.type, s.severity, s.title, s.body, s.options, s.questions, s.follow_up_to AS followUpTo,
              s.blocking, s.created_at AS createdAt
       FROM signals s LEFT JOIN tasks t ON t.id = s.task_id
       WHERE s.project_id = ? AND s.status = 'open' ORDER BY
         CASE s.type WHEN 'input_request' THEN 0 ELSE 1 END,
         CASE s.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, s.created_at DESC`,
    ).bind(pid).all(),
    c.env.DB.prepare('SELECT td.task_id AS taskId, td.doc_id AS docId FROM task_docs td JOIN tasks t ON t.id = td.task_id WHERE t.project_id = ?').bind(pid).all(),
    // Plan-local docs (PLNR-200): body included so the plan view renders/edits inline
    // (mirrors plans/phases, which also carry full body in the snapshot). Not indexed.
    c.env.DB.prepare('SELECT id, plan_id AS planId, name, description, body, author_kind AS authorKind, author_name AS authorName, created_at AS createdAt, updated_at AS updatedAt FROM plan_docs WHERE project_id = ? ORDER BY updated_at DESC').bind(pid).all(),
    // Live file locks (PLNR-212) — unreleased + unexpired (arbiter reads by server time; the alarm
    // sweep lags), joined to holder + task for the locks panel + board chips.
    c.env.DB.prepare(
      `SELECT fl.id, fl.agent_id AS agentId, fl.task_id AS taskId, fl.kind, fl.canon_pattern AS path,
              fl.branch, fl.all_branches AS allBranches, fl.acquired_at AS acquiredAt, fl.expires_at AS expiresAt,
              a.name AS holderName, t.key AS taskKey, t.title AS taskTitle
       FROM file_locks fl LEFT JOIN agents a ON a.id = fl.agent_id LEFT JOIN tasks t ON t.id = fl.task_id
       WHERE fl.project_id = ? AND fl.released_at IS NULL AND fl.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
       ORDER BY fl.acquired_at DESC`,
    ).bind(pid).all(),
  ]);
  if (!project) return c.json({ error: 'not found' }, 404);
  // Redact foreign blockers in projects this session cannot reach (PLNR-241): status only.
  const extPids = [...new Set(extDeps.results.map((r) => String(r.projectId)))];
  const reachablePids = new Set(
    (await Promise.all(extPids.map(async (p) => ((await reachesProject(c, p)) ? p : null)))).filter(Boolean),
  );
  const externalTasks = extDeps.results.map((r) =>
    reachablePids.has(String(r.projectId)) ? r : { id: r.id, status: r.status },
  );
  return c.json({
    version: pkg.version, // deploy marker — the SPA reloads itself on mismatch (PLNR-193)
    project,
    tasks: tasks.results,
    dependencies: deps.results,
    externalTasks,
    agents: agents.results,
    milestones: milestones.results,
    boards: boards.results,
    plans: plans.results,
    phases: phases.results,
    phaseTasks: phaseTasks.results,
    tags: tags.results,
    taskTags: taskTags.results,
    taskDocs: taskDocs.results,
    planDocs: planDocs.results,
    locks: locks.results,
    signals: signals.results.map((s) => ({
      ...s,
      options: s.options ? JSON.parse(String(s.options)) : null,
      questions: s.questions ? JSON.parse(String(s.questions)) : null,
    })),
    events: events.results.map((e) => ({ ...e, payload: JSON.parse(String(e.payload)) })),
  });
});

// Task search (PLNR-117) — the same filters the MCP search_tasks tool offers, for the
// UI/scripts. Registered before /api/tasks/:tid so "search" isn't eaten as a task id.
app.get('/api/tasks/search', userAuth, async (c) => {
  const u = c.var.user!;
  const q = c.req.query();
  const { sql, binds } = taskSearchFilters({
    status: q.status, type: q.type, tag: q.tag, milestoneId: q.milestoneId,
    holder: q.holder, text: q.text, includeArchived: q.includeArchived === '1', overdue: q.overdue === '1',
  });
  const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 200);
  const pid = q.projectId ?? null;
  // VISIBILITY_WHERE and the filter fragment both use bare `?` — bind in textual order.
  const base = `FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
    WHERE ${VISIBILITY_WHERE} AND (? IS NULL OR t.project_id = ?)${sql}`;
  const allBinds = [u.role, u.id, u.id, pid, pid, ...binds];
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.id, t.key, t.title, ${taskWireStatus('t')} AS status, t.failed_at AS failedAt, t.priority, t.estimate, t.due_at AS dueAt, t.type,
              t.project_id AS projectId, p.key AS projectKey, t.claimed_by AS claimedBy,
              t.milestone_id AS milestoneId, t.open_comments AS openComments, t.updated_at AS updatedAt
       ${base} ORDER BY t.priority ASC, t.updated_at DESC LIMIT ${limit}`,
    ).bind(...allBinds).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n ${base}`).bind(...allBinds).first<{ n: number }>(),
  ]);
  return c.json({ tasks: rows.results, matched: total?.n ?? rows.results.length, returned: rows.results.length });
});

app.get('/api/tasks/:tid', userAuth, async (c) => {
  const tid = c.req.param('tid')!;
  const task = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(tid).first();
  if (!task) return c.json({ error: 'not found' }, 404);
  if (!(await reachesProject(c, String(task.project_id)))) return c.json({ error: 'not found' }, 404); // PLNR-97
  // Derived status (PLNR-178): SELECT * gives the raw column, so apply the same rule as the
  // wire SELECTs — a task with failed_at set reads as 'failed'. failedAt is already present.
  if (task.failed_at) task.status = 'failed';
  task.failedAt = task.failed_at;
  // Derived 'proposed' + spin-off provenance (PLNR-230), mirroring MCP get_task.
  if (task.proposed_at && task.status === 'todo') task.status = 'proposed';
  task.proposedAt = task.proposed_at;
  task.spinoffRunId = task.spinoff_run_id;
  task.spinoffSourceTaskId = task.spinoff_source_task_id;
  task.spinoffFinding = task.spinoff_finding;
  // The execution spec (RUN-135) rides only on the DETAIL reads — a board snapshot ships every
  // task in a project and renders none of this. `SELECT *` brought the raw JSON along, so the
  // column is dropped rather than shipped beside its parsed form: unlike the scalars above, a
  // duplicated spec doubles the payload for nothing.
  const stored = readExecutionSpec(task.execution_spec, tid);
  task.executionSpec = stored.spec;
  if (stored.unreadable) task.executionSpecUnreadable = true;
  delete task.execution_spec;
  const [comments, refs, attachments, taskTagRows, docRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, author_kind AS authorKind, author_id AS authorId, kind, body, status, parent_comment_id AS parentCommentId, created_at AS createdAt
       FROM comments WHERE task_id = ? ORDER BY created_at`,
    ).bind(tid).all(),
    c.env.DB.prepare('SELECT kind, ref, url, state FROM task_refs WHERE task_id = ?').bind(tid).all(),
    c.env.DB.prepare('SELECT id, filename, content_type AS contentType, size, uploaded_by_kind AS uploaderKind, uploaded_by AS uploadedBy, created_at AS createdAt FROM attachments WHERE task_id = ? ORDER BY created_at').bind(tid).all(),
    c.env.DB.prepare('SELECT tag_id AS tagId FROM task_tags WHERE task_id = ?').bind(tid).all(),
    c.env.DB.prepare('SELECT d.id, d.name, d.description FROM task_docs td JOIN docs d ON d.id = td.doc_id WHERE td.task_id = ? ORDER BY d.name').bind(tid).all(),
  ]);
  return c.json({ task, comments: comments.results, refs: refs.results, attachments: attachments.results, tagIds: taskTagRows.results.map((r) => r.tagId), docs: docRows.results });
});

// --- UI write API (all writes go through ProjectRoom; a human is just another actor) ---
app.post('/api/projects', userAuth, async (c) => {
  const denied = demoDenied(c); // demo stays inside the seeded project (PLNR-199)
  if (denied) return denied;
  const body = await c.req.json<{ key: string; name: string; description?: string }>();
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(body.key ?? '')) return c.json({ error: 'key must be 1-8 uppercase letters/digits' }, 400);
  const id = newId('prj'); // random, not prj_<key> — see create_project in mcp.ts (PLNR-106)
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
  const pid = c.req.param('pid')!;
  const body = await c.req.json<{ title: string; body?: string; parentTaskId?: string; priority?: number; estimate?: number | null; dueAt?: string | null; dependsOn?: string[]; boardId?: string | null; executionSpec?: ExecutionSpecInput | null }>();
  if (!body.title) return c.json({ error: 'title required' }, 400);
  // Blocker refs resolve at the edge (PLNR-241): a cross-project ref must pass this
  // session's reach check, which the DO cannot apply for us.
  if (body.dependsOn?.length) {
    try {
      body.dependsOn = await Promise.all(body.dependsOn.map((ref) => resolveBlockerRefRest(c, pid, ref)));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  const result = await room(c.env, pid).createTask(pid, humanActor(c), body);
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
// The blocker may live in another project this session can reach (PLNR-241).
app.post('/api/projects/:pid/tasks/:tid/dependencies', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const { dependsOnTaskId } = await c.req.json<{ dependsOnTaskId: string }>();
  if (!dependsOnTaskId) return c.json({ error: 'dependsOnTaskId required' }, 400);
  try {
    const blockerId = await resolveBlockerRefRest(c, pid, dependsOnTaskId);
    const result = await room(c.env, pid).addDependency(pid, humanActor(c), c.req.param('tid')!, blockerId);
    return c.json(result);
  } catch (e) {
    // Cycle / self-edge / resolution failures are caller errors, matching neighbor routes.
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.delete('/api/projects/:pid/tasks/:tid/dependencies/:depId', userAuth, async (c) => {
  const result = await room(c.env, c.req.param('pid')!).removeDependency(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, c.req.param('depId')!);
  return c.json(result);
});

// Signals — human answers a decision gate / acknowledges an alert (PLNR-67).
// PLNR-185: `answers` is the structured per-question form ([{question, answer}], answer =
// string | string[] | number | boolean); `response` stays the plain-text form. Either works.
app.post('/api/projects/:pid/signals/:sid/answer', userAuth, async (c) => {
  const { response, answers } = await c.req.json<{
    response?: string;
    answers?: Array<{ question: string; answer: string | string[] | number | boolean }>;
  }>();
  if (!response?.trim() && !answers?.length) return c.json({ error: 'response or answers required' }, 400);
  const result = await room(c.env, c.req.param('pid')!).answerSignal(
    c.req.param('pid')!, humanActor(c), c.req.param('sid')!, response?.trim() ?? '', answers,
  );
  return c.json(result);
});

// The rounds of a threaded gate (PLNR-185): the signal itself plus every ancestor it
// follows up on, oldest first — the UI renders prior Q&A above the open round.
app.get('/api/projects/:pid/signals/:sid/thread', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const chain: unknown[] = [];
  let cursor: string | null = c.req.param('sid')!;
  for (let depth = 0; cursor && depth < 20; depth++) {
    const row: { followUpTo: string | null } | null = await c.env.DB.prepare(
      `SELECT id, task_id AS taskId, agent_name AS agentName, title, body, options, questions, status,
              response, response_json AS responseJson, follow_up_to AS followUpTo, created_at AS createdAt, resolved_at AS resolvedAt
       FROM signals WHERE id = ? AND project_id = ?`,
    ).bind(cursor, pid).first();
    if (!row) break;
    const r = row as Record<string, unknown>;
    chain.unshift({
      ...r,
      options: r.options ? JSON.parse(String(r.options)) : null,
      questions: r.questions ? JSON.parse(String(r.questions)) : null,
      responseJson: r.responseJson ? JSON.parse(String(r.responseJson)) : null,
    });
    cursor = row.followUpTo;
  }
  if (!chain.length) return c.json({ error: 'not found' }, 404);
  return c.json({ thread: chain });
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

// Merge tag :tid INTO another tag (PLNR-194) — the vocabulary-cleanup primitive.
app.post('/api/projects/:pid/tags/:tid/merge', userAuth, async (c) => {
  const { into } = await c.req.json<{ into: string }>();
  if (!into?.trim()) return c.json({ error: 'into required (target tag id or name)' }, 400);
  return c.json(await room(c.env, c.req.param('pid')!).mergeTags(c.req.param('pid')!, humanActor(c), c.req.param('tid')!, into));
});
app.delete('/api/projects/:pid/tags/:tid', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).deleteTag(c.req.param('pid')!, humanActor(c), c.req.param('tid')!)));

app.delete('/api/projects/:pid/plans/:plid', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).deletePlan(c.req.param('pid')!, humanActor(c), c.req.param('plid')!)));

// Project docs (PLNR-158) — reads direct, writes through the DO.
app.get('/api/projects/:pid/docs', userAuth, async (c) => {
  const u = c.var.user!;
  const visible = await c.env.DB.prepare(`SELECT 1 FROM projects p WHERE p.id = ? AND ${VISIBILITY_WHERE}`)
    .bind(c.req.param('pid')!, u.role, u.id, u.id).first();
  if (!visible) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.name, d.description, d.body, d.folder, d.author_kind AS authorKind, d.author_name AS authorName, d.updated_at AS updatedAt,
            (SELECT GROUP_CONCAT(g.name) FROM doc_tags dt JOIN tags g ON g.id = dt.tag_id WHERE dt.doc_id = d.id) AS tags
     FROM docs d WHERE d.project_id = ? ORDER BY d.folder, d.updated_at DESC`,
  ).bind(c.req.param('pid')!).all();
  return c.json({ docs: results.map((d) => ({ ...d, tags: d.tags ? String(d.tags).split(',') : [] })) });
});
app.post('/api/projects/:pid/docs', userAuth, async (c) => {
  const body = await c.req.json<{ name: string; description?: string; body?: string; folder?: string; tags?: string[] }>();
  if (!body.name?.trim()) return c.json({ error: 'name required' }, 400);
  return c.json(await room(c.env, c.req.param('pid')!).createDoc(c.req.param('pid')!, humanActor(c), body));
});
app.patch('/api/projects/:pid/docs/:did', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).updateDoc(c.req.param('pid')!, humanActor(c), c.req.param('did')!, await c.req.json())));
app.delete('/api/projects/:pid/docs/:did', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).deleteDoc(c.req.param('pid')!, humanActor(c), c.req.param('did')!)));

// Project memory (PLNR-251/252) — human-facing READS only; recording happens through the
// agent-facing record_memory MCP tool. Access is already gated by requireProjectAccess on
// /api/projects/:pid/* (line 138), same as every other route in this block.
const memoryStub = (env: Env, pid: string): ProjectMemoryStub =>
  env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(pid)) as unknown as ProjectMemoryStub;

// The FULLY-typed DO stub (env.PROJECT_MEMORY is DurableObjectNamespace<ProjectMemory> — see
// env.ts) rather than the narrow ProjectMemoryStub interface above, for the PLNR-273 operator
// routes below: they reach RPCs (listIndexGenerations, exportSnapshot, restoreSnapshot, rollback,
// activateIndexGeneration, abortIndexIngest, rebuildVectorIndex, pruneRetainedGeneration) that
// ProjectMemoryStub was never widened to include, and adding ten more single-use method
// signatures to that manually-maintained interface would cost more than it buys here — this
// matches the existing /api/admin/memory-backup|restore routes' own style (line ~303 below).
const memoryDO = (env: Env, pid: string) => env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(pid));

app.get('/api/projects/:pid/memory/health', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  return c.json(await memoryStub(c.env, pid).health(pid));
});
// Canonical repository identity + checkout associations (PLNR-259) — straight D1 reads (CLAUDE.md:
// reads go straight to D1), not a ProjectMemory DO RPC; registration/association happen through
// ProjectRoom (runner registration/heartbeat sync them automatically — see syncRepositoryCheckouts).
// PLNR-273 widens this with each repository's index-generation state (active/staged, with
// per-generation ingest progress and validation problems) and two server-computed booleans —
// `stale` and `failedIngest` — so the operations panel never re-derives them client-side (§18's
// "the number shown is the number the server enforces against").
app.get('/api/projects/:pid/memory/repositories', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const [repos, generations] = await Promise.all([listProjectRepositories(c.env, pid), memoryDO(c.env, pid).listIndexGenerations(pid)]);
  const withCheckouts = await Promise.all(repos.map(async (r) => {
    const checkouts = await listRepositoryCheckouts(c.env, r.id);
    // stale/failedIngest/activeGeneration/stagedGenerations: shared with the runner's agentAuth
    // index-cursor read (PLNR-306, /api/runner-memory/index-cursor) so the two surfaces can never
    // disagree on "is this index stale" — see deriveRepositoryMemoryState.
    return { ...r, checkouts, ...deriveRepositoryMemoryState(r, generations) };
  }));
  return c.json({ repositories: withCheckouts });
});

const RegisterRepositoryBody = z.object({
  repositoryKey: z.string().min(1),
  defaultBranch: z.string().nullable().optional(),
  vcsKind: z.string().nullable().optional(),
});

// PLNR-311: registration is a HUMAN action — this route lives under /api/projects/:pid/* (userAuth
// + requireProjectAccess, line ~147), which a Bearer-authenticated runner/agent connection can
// never present a session cookie for, so no runner- or agent-authenticated path can reach this
// route (§4/§6 locked decision: humans declare identity, daemons only associate against it — see
// this task's executionSpec). The write goes through ProjectRoom.registerRepository — the sole D1
// writer for this table (CLAUDE.md) — never a Worker-side INSERT. `RepositoryKey`'s own validation
// (including the ckt_-prefixed-checkout-id rejection) already lives in the DO method; this route
// does not re-validate the key shape, it only relays the DO's own message on failure. The DO
// throws on an EXACT duplicate key (memory-registry.test.ts pins that as its own contract) — this
// route absorbs that specific conflict into an idempotent 200 by re-resolving the existing row
// (`created: false`), rather than surfacing an error a human re-running setup does not expect;
// any other failure (invalid key shape) still surfaces as 400 with the DO's own message.
app.post('/api/projects/:pid/memory/repositories', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const parsed = RegisterRepositoryBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid repository registration request', detail: parsed.error.issues }, 400);
  const { repositoryKey, defaultBranch, vcsKind } = parsed.data;
  let created = true;
  try {
    await room(c.env, pid).registerRepository(pid, humanActor(c), repositoryKey, {
      defaultBranch: defaultBranch ?? null,
      vcsKind: vcsKind ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already registered/.test(message)) return c.json({ error: message }, 400);
    created = false; // idempotent re-register: fall through to re-resolve the existing row
  }
  const repo = await resolveRepositoryByKey(c.env, pid, repositoryKey);
  return c.json({ repository: repo, created }, created ? 201 : 200);
});

// PLNR-273: assembled operator status — the DO's own health() plus the compact D1 registry
// projection (backup status, vector-dirty, size) plus which optional bindings are actually
// configured on THIS deployment. Never a client-computed rollup (§18/locked decision): every
// field here is exactly what health()/the registry/env already report. A DO that cannot be
// reached throws through to Hono's default error handling — the same "unreachable, not empty"
// distinction ExploreTab's reachability probe already relies on (memoryHealth in api.ts).
app.get('/api/projects/:pid/memory/ops-status', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const [health, registry] = await Promise.all([memoryDO(c.env, pid).health(pid), getMemoryRegistry(c.env, pid)]);
  return c.json({ health, registry, capabilities: memoryCapabilities(c.env) });
});

// PLNR-273: this project's backup generations (exportedAt slugs, newest first) — the picker for
// the restore control below. `listProjectBackupGenerations` already degrades to [] with R2
// unbound; `r2Available` lets the UI say so explicitly rather than reading an empty list as "no
// backups yet exist" on a self-hosted instance that simply has no R2 bucket.
app.get('/api/projects/:pid/memory/backups', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const backups = await listProjectBackupGenerations(c.env, pid);
  return c.json({ backups, r2Available: !!c.env.FILES });
});

// --- Below this point: authorized operator ACTIONS (PLNR-273). Every route additionally
// requires the admin role (requireAdmin, defined further down this file — referenced here as a
// closure, evaluated at request time, well after the whole module — including that const — has
// loaded). These are session-cookie routes for the web app; they call the SAME DO/lib functions
// as the pre-existing ADMIN_TOKEN routes (/api/admin/memory-backup|restore|...) rather than
// duplicating logic, but cannot reuse those routes directly — adminAuth checks a static bearer
// token against env.ADMIN_TOKEN, which a browser session can never supply. ---

app.post('/api/projects/:pid/memory/backup', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const pid = c.req.param('pid')!;
  const tier = c.req.query('tier') === 'full' ? 'full' : 'core';
  const res = await memoryDO(c.env, pid).exportSnapshot(pid, { tier });
  return c.json(res, res.ok ? 200 : 503);
});

// The ?confirm=replace guard is the SAME safety catch the ADMIN_TOKEN route enforces — never
// pre-supplied here. The web control that calls this only appends it after its own Dialog
// confirmation, so the guard still does real work against an unconfirmed call (a stray retry, a
// scripted mistake), it is just no longer the ONLY confirmation a human sees.
app.post('/api/projects/:pid/memory/restore', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  if (c.req.query('confirm') !== 'replace') {
    return c.json({ error: "refusing: this REPLACES the project's active memory generation. Re-POST with ?confirm=replace to proceed." }, 400);
  }
  const pid = c.req.param('pid')!;
  const exportedAt = c.req.query('exportedAt');
  if (!exportedAt) return c.json({ error: 'exportedAt query param is required — the timestamp of the backup to restore' }, 400);
  const res = await memoryDO(c.env, pid).restoreSnapshot(pid, { exportedAt });
  return c.json(res, res.ok ? 200 : 400);
});

app.post('/api/projects/:pid/memory/restore/rollback', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const pid = c.req.param('pid')!;
  const res = await memoryDO(c.env, pid).rollback(pid);
  return c.json(res, res.ok ? 200 : 400);
});

// Unconditional discard of the retained rollback generation — distinct from rollback itself:
// this gives up the ability to roll back at all, freeing its storage immediately rather than
// waiting for the sweep's age-gated prune. `health().hasPriorGeneration` is what the UI disables
// this control against.
app.post('/api/projects/:pid/memory/generations/prune-retained', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const pid = c.req.param('pid')!;
  return c.json(await memoryDO(c.env, pid).pruneRetainedGeneration(pid));
});

// activateIndexGeneration throws (rather than returning {ok:false}) on an unsealed or
// validation-failed generation — the DO's guard is the authority (locked decision: the UI does
// not re-implement it), this route only translates that throw into an HTTP 409 for the client.
app.post('/api/projects/:pid/memory/generations/:generationId/activate', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const pid = c.req.param('pid')!;
  try {
    return c.json(await memoryDO(c.env, pid).activateIndexGeneration(pid, c.req.param('generationId')!));
  } catch (err) {
    return c.json({ error: String(err) }, 409);
  }
});

// Cancel a still-staged generation (e.g. one that failed validation) and drop its staged rows —
// abortIndexIngest already refuses once active/superseded.
app.post('/api/projects/:pid/memory/generations/:generationId/abort', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const pid = c.req.param('pid')!;
  try {
    return c.json(await memoryDO(c.env, pid).abortIndexIngest(pid, c.req.param('generationId')!));
  } catch (err) {
    return c.json({ error: String(err) }, 409);
  }
});

// rebuildVectorIndex is an honest no-op (`{ ok: true, rebuilt: false, reason }`) with VECTORIZE
// unbound — never an error — matching §20's reduced-capability contract.
app.post('/api/projects/:pid/memory/vectors/rebuild', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const pid = c.req.param('pid')!;
  return c.json(await memoryDO(c.env, pid).rebuildVectorIndex(pid));
});

// The same idempotent per-project sweep the daily cron already runs (sweepProjectDebrisForProject,
// extracted from sweepProjectDebris for exactly this on-demand use) — an operator-triggered
// "clean up now" rather than a parallel cleanup mechanism.
app.post('/api/projects/:pid/memory/lifecycle-sweep', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const pid = c.req.param('pid')!;
  return c.json(await sweepProjectDebrisForProject(c.env, pid));
});

// PLNR-283: the idempotent full-state graph backfill — projects this project's LIVE tasks/
// plans/docs/milestones/agents (plus the task<->plan/task<->doc relationships the board already
// knows) into nodes/edges, straight from D1, never event replay. Safe to re-run any time: every
// write is idempotent by uri/triple (stated acceptance — same counts, no changed ids). Exists so
// a project whose event log predates this task can still get a connected memory graph without an
// operator hand-replaying its projector cursor from zero.
app.post('/api/projects/:pid/memory/graph/rebuild', userAuth, async (c) => {
  if (!requireAdmin(c)) return c.json({ error: 'admin role required' }, 403);
  const pid = c.req.param('pid')!;
  return c.json(await memoryDO(c.env, pid).rebuildProjection(pid));
});
app.get('/api/projects/:pid/memory/items/:id', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const row = await memoryStub(c.env, pid).getMemoryItem(pid, c.req.param('id')!);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
});
app.get('/api/projects/:pid/memory/contradictions/:setId', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  return c.json(await memoryStub(c.env, pid).getContradictionSet(pid, c.req.param('setId')!));
});

// Hybrid memory retrieval (PLNR-257) — the human-facing twin of the search_project_memory MCP
// tool; same DO RPC, same result shape. POST (not GET) because the filter set is a body, not a
// couple of query params, matching /api/projects/:pid/ask's shape.
//
// PLNR-271/§13: the MCP tool has rendered its hits through `renderEvidenceFrame` since PLNR-270
// (a human reading agent-recorded memory is still reading untrusted content — §13 draws no
// human/agent line); this REST twin did not carry the same `evidenceFrame` until the Project
// Memory explorer needed it. `searchHitToEvidenceItem` now lives in lib/project-memory.ts
// precisely so both callers render the identical frame rather than the explorer growing its own.
app.post('/api/projects/:pid/memory/search', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const body = await c.req.json<{
    query?: string; memoryItemId?: string; episodeId?: string; taskId?: string; seedEntityUri?: string;
    edgeTypes?: string[]; maxDepth?: number; repositoryKey?: string; branch?: string; kind?: string;
    minAuthority?: number; validity?: string; limit?: number;
  }>().catch(() => ({}) as Record<string, never>);
  const result = await memoryStub(c.env, pid).searchProjectMemory(pid, body);
  const evidenceItems = result.results.map(searchHitToEvidenceItem).filter((i): i is EvidenceFrameItem => i !== null);
  return c.json({ ...result, evidenceFrame: renderEvidenceFrame(evidenceItems) });
});

// Similar-effort retrieval (PLNR-264) — the human-facing twin of the priorEffort block
// can_claim/claim_task attach; same loadPriorEffort() glue so the two surfaces can't drift on
// how a task's title/body/anticipatedFiles become ProjectMemory.similarEffort's input.
app.post('/api/projects/:pid/memory/similar-effort', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const body = await c.req.json<{ taskId?: string }>().catch(() => ({}) as { taskId?: string });
  if (!body.taskId) return c.json({ error: 'taskId required' }, 400);
  const task = await c.env.DB.prepare('SELECT id, title, body, execution_spec AS executionSpec FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
    .bind(body.taskId, body.taskId, pid).first<{ id: string; title: string; body: string | null; executionSpec: string | null }>();
  if (!task) return c.json({ error: 'not found' }, 404);
  const result = await loadPriorEffort(c.env, pid, task);
  if (!result) return c.json({ error: 'project memory unavailable' }, 502);
  return c.json(result);
});

// Named graph-query primitives (PLNR-258) — the human-facing twin of explain_project_area;
// shaped for Phase 8's graph/ego-network view but no UI ships here. One route, `focus`
// discriminates the primitive, same shape as the MCP tool.
app.post('/api/projects/:pid/memory/explain', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const body = await c.req.json<{
    focus?: 'dependencies' | 'tests' | 'implementers' | 'decision' | 'impact';
    entityUri?: string; decisionUri?: string; entityUris?: string[];
    edgeTypes?: string[]; maxDepth?: number; maxResults?: number;
  }>().catch(() => ({}) as Record<string, never>);
  const stub = memoryStub(c.env, pid);
  switch (body.focus) {
    case 'dependencies':
      if (!body.entityUri) return c.json({ error: 'entityUri is required for focus="dependencies"' }, 400);
      return c.json(await stub.dependencyNeighborhood(pid, { entityUri: body.entityUri, edgeTypes: body.edgeTypes, maxDepth: body.maxDepth, maxResults: body.maxResults }));
    case 'tests':
      if (!body.entityUri) return c.json({ error: 'entityUri is required for focus="tests"' }, 400);
      return c.json(await stub.validatingTests(pid, { entityUri: body.entityUri, maxDepth: body.maxDepth, maxResults: body.maxResults }));
    case 'implementers':
      if (!body.entityUri) return c.json({ error: 'entityUri is required for focus="implementers"' }, 400);
      return c.json(await stub.implementingWork(pid, { entityUri: body.entityUri, maxDepth: body.maxDepth, maxResults: body.maxResults }));
    case 'decision':
      if (!body.decisionUri) return c.json({ error: 'decisionUri is required for focus="decision"' }, 400);
      return c.json(await stub.decisionLineage(pid, { decisionUri: body.decisionUri, maxDepth: body.maxDepth, maxResults: body.maxResults }));
    case 'impact':
      if (!body.entityUris?.length) return c.json({ error: 'entityUris is required for focus="impact"' }, 400);
      return c.json(await stub.changeImpact(pid, { entityUris: body.entityUris, maxDepth: body.maxDepth, maxResults: body.maxResults }));
    default:
      return c.json({ error: 'focus must be one of dependencies|tests|implementers|decision|impact' }, 400);
  }
});

// The bounded constellation feeding the memory star map (PLNR-284, §5) — POST (not GET) to match
// /memory/search's and /memory/explain's shape immediately above, even though this endpoint
// takes no body today: a future filter (node type, kind, authority floor, repository, time
// window — the task's own discretion list) belongs in a JSON body, not a growing query string,
// and changing the HTTP method later would be the breaking change, not adding fields to an
// already-POST route. Read-only, same userAuth + requireProjectAccess gate as every memory route
// in this block (line 138) — never widens what the browser can reach.
app.post('/api/projects/:pid/memory/constellation', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  return c.json(await memoryStub(c.env, pid).constellation(pid));
});

// Task-aware context packs (PLNR-267) — the human-facing twin of get_task_context; same
// assembler, same shape. `role` defaults to 'human' here (there is no agent-kind to derive it
// from on this side of the API — that inference is get_task_context's own job).
app.post('/api/projects/:pid/memory/context', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const body = await c.req.json<{
    taskId?: string; repositoryKey?: string; branch?: string; baseId?: string;
    role?: 'scope' | 'build' | 'verify' | 'human'; budgetTokens?: number;
  }>().catch(() => ({}) as Record<string, never>);
  if (!body.taskId) return c.json({ error: 'taskId required' }, 400);
  const task = await c.env.DB.prepare('SELECT id FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
    .bind(body.taskId, body.taskId, pid).first<{ id: string }>();
  if (!task) return c.json({ error: 'not found' }, 404);
  const pack = await assembleContextPack(c.env, pid, task.id, {
    repositoryKey: body.repositoryKey, branch: body.branch, baseId: body.baseId,
    role: body.role ?? 'human', tokenBudget: body.budgetTokens ?? null,
  });
  return c.json(pack);
});

// Proposed-decision approval (PLNR-253) — HUMAN-only, never an MCP tool (§12/§13: an agent must
// never be the one that approves its own or another agent's claim). Mirrors the spin-off
// accept/reject route shape (/api/projects/:pid/tasks/:tid/spinoff/accept|reject).
app.get('/api/projects/:pid/memory/proposed-decisions', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  return c.json({ decisions: await memoryStub(c.env, pid).listProposedDecisions(pid) });
});
app.post('/api/projects/:pid/memory/items/:id/approve', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const body = await c.req.json<{ note?: string; revision?: string }>().catch(() => ({}) as { note?: string; revision?: string });
  return c.json(
    await memoryStub(c.env, pid).approveDecision(pid, {
      memoryItemId: c.req.param('id')!,
      actorUserId: c.var.user!.id,
      note: body.note ?? null,
      revision: body.revision ?? null,
    }),
  );
});
app.post('/api/projects/:pid/memory/items/:id/reject', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
  return c.json(
    await memoryStub(c.env, pid).rejectDecision(pid, { memoryItemId: c.req.param('id')!, actorUserId: c.var.user!.id, note: body.note ?? null }),
  );
});

// Memory lineage (PLNR-271) — the human explorer's version/authority-transition/contradiction/
// feedback read for ONE memory item. Same DO RPC output whether `:id` names the root, a middle
// correction, or the latest version — getMemoryHistory walks supersedes_memory_id both ways.
app.get('/api/projects/:pid/memory/items/:id/history', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const history = await memoryStub(c.env, pid).getMemoryHistory(pid, c.req.param('id')!);
  if (!history) return c.json({ error: 'not found' }, 404);
  return c.json(history);
});

// Human feedback (PLNR-271, §11) — an operation on the memory surface, not an edit: the five-kind
// vocabulary (migration 0004) via the SAME recordFeedback RPC record_memory's op="feedback" uses.
app.post('/api/projects/:pid/memory/items/:id/feedback', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const body = await c.req.json<{ kind?: 'useful' | 'incorrect' | 'outdated' | 'harmful' | 'unverifiable'; reason?: string }>()
    .catch(() => ({}) as Record<string, never>);
  if (!body.kind) return c.json({ error: 'kind required' }, 400);
  return c.json(
    await memoryStub(c.env, pid).recordFeedback(pid, {
      memoryItemId: c.req.param('id')!,
      kind: body.kind,
      reason: body.reason ?? null,
      actor: { kind: 'human', id: c.var.user!.id },
    }),
  );
});

// Human correction (PLNR-271, §12) — records a NEW version linked back via supersedesMemoryId;
// never edits the original in place. `authority` is deliberately never forwarded: recordMemory's
// clampAuthority only restricts actor.kind==='agent', so leaving it unset is what keeps a human
// correction landing at the same low default an unspecified agent write gets — authority 5 stays
// reachable ONLY through /approve (locked decision: nothing here sets an authority directly).
// `kind`/scope are copied from the memory being corrected so the new version stays comparable.
app.post('/api/projects/:pid/memory/items/:id/correct', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const body = await c.req.json<{ statement?: string }>().catch(() => ({}) as { statement?: string });
  const statement = body.statement?.trim();
  if (!statement) return c.json({ error: 'statement required' }, 400);
  const original = await memoryStub(c.env, pid).getMemoryItem(pid, c.req.param('id')!);
  if (!original) return c.json({ error: 'not found' }, 404);
  const scope: { repositoryKey?: string; branch?: string; baseId?: string } = {};
  if (original.repositoryKey) scope.repositoryKey = original.repositoryKey;
  if (original.branch) scope.branch = original.branch;
  if (original.baseId) scope.baseId = original.baseId;
  const result = await memoryStub(c.env, pid).recordMemory(pid, {
    kind: original.kind,
    statement,
    supersedesMemoryId: original.id,
    scope,
    actor: { kind: 'human', id: c.var.user!.id },
  });
  return c.json(result);
});

// Guidance-drift scanning (PLNR-266) — admin-only, same trailing-:projectId shape as
// /api/admin/memory-backup/:projectId: this compares NORIQ'S OWN agent-guidance surfaces
// (never project data), but a project's ProjectMemory DO is where findings persist, so a scan
// still names a project. This route is the ONLY place that gathers the four live surface
// texts — memory/guidance-drift.ts and ProjectMemory itself deliberately never import
// mcp.ts/skill.ts/skill-docs.ts (see ProjectMemory.recordGuidanceDriftScan's own comment).
// Recommendations are DATA: nothing here (or anywhere in this task) writes to a guidance file,
// opens a PR, or edits a doc/task.
// PLNR-310: skill_md uses SKILL_MD_SURFACE (core + every split-out reference), not bare
// SKILL_MD — the scanner's rules must keep resolving prose that now lives in a reference file
// (skill.ts's module comment explains why; test/memory-guidance-drift.test.ts's liveSurfaces()
// builds this the identical way).
app.post('/api/admin/memory-guidance-drift/:projectId/scan', adminAuth, async (c) => {
  const projectId = c.req.param('projectId')!;
  const surfaces = {
    instructions: INSTRUCTIONS,
    playbook: GET_BRIEFING_PLAYBOOK.join('\n\n'),
    skill_md: SKILL_MD_SURFACE,
    doc_skill_md: DOC_SKILL_MD,
  };
  return c.json(await memoryStub(c.env, projectId).recordGuidanceDriftScan(projectId, surfaces));
});
app.get('/api/admin/memory-guidance-drift/:projectId', adminAuth, async (c) => {
  const projectId = c.req.param('projectId')!;
  return c.json({ findings: await memoryStub(c.env, projectId).listGuidanceDriftFindings(projectId) });
});

// Plan-local docs (PLNR-200) — working documents scoped to one plan; read via the snapshot
// (planDocs) or MCP get_plans/get_plan_doc. Under /api/projects/:pid/* → project-reach gated.
app.post('/api/projects/:pid/plans/:plid/docs', userAuth, async (c) => {
  const body = await c.req.json<{ name: string; description?: string; body?: string }>();
  if (!body.name?.trim()) return c.json({ error: 'name required' }, 400);
  return c.json(await room(c.env, c.req.param('pid')!).createPlanDoc(c.req.param('pid')!, humanActor(c), c.req.param('plid')!, body));
});
app.patch('/api/projects/:pid/plans/:plid/docs/:docId', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).updatePlanDoc(c.req.param('pid')!, humanActor(c), c.req.param('docId')!, await c.req.json())));
app.delete('/api/projects/:pid/plans/:plid/docs/:docId', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).deletePlanDoc(c.req.param('pid')!, humanActor(c), c.req.param('docId')!)));

// Human force-release of a stuck file lock (PLNR-213) — e.g. a dead agent's hold. Agent↔agent
// force-release is forbidden in the DO; a human is the override.
app.post('/api/projects/:pid/locks/:lockId/force-release', userAuth, async (c) => {
  const denied = demoDenied(c);
  if (denied) return denied;
  return c.json(await room(c.env, c.req.param('pid')!).forceReleaseLock(c.req.param('pid')!, humanActor(c), c.req.param('lockId')!));
});

// Project search (PLNR-184) — semantic when the AI+VECTORIZE bindings exist, keyword
// otherwise; `mode` in the response says which ran. Covers tasks, docs, plans, and (PLNR-255)
// recorded memory + effort episodes. Validated against ALL_KINDS (not a hand-written literal
// list) so a widened SearchKind can't silently drop a kind here (CLAUDE.md: this union has
// five independent hand-written copies and a missed one fails silently).
app.get('/api/projects/:pid/search', userAuth, async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ error: 'q required' }, 400);
  const kindsParam = c.req.query('kinds')?.split(',').filter((k): k is SearchKind => (ALL_KINDS as readonly string[]).includes(k));
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '12', 10) || 12, 1), 50);
  const { mode, results } = await search(c.env, {
    q, projectIds: [c.req.param('pid')!], kinds: kindsParam?.length ? kindsParam : undefined, limit,
  });
  return c.json({ mode, results });
});

// Backfill/repair the vector index (PLNR-184): walks the project's tasks/docs/plans and
// re-embeds them. For content that predates the bindings (or drifted). Batched — call
// again while `remaining > 0`. 503 without an embeddings backend.
app.post('/api/projects/:pid/search/reindex', userAuth, async (c) => {
  const backend = searchBackend(c.env);
  if (!backend) return c.json({ error: 'no embeddings backend — AI + VECTORIZE bindings required' }, 503);
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0);
  return c.json(await reindexProject(c.env, backend, c.req.param('pid')!, offset));
});

// "Ask the project" (PLNR-219) — read-only RAG Q&A for the humans: retrieval reuses /search
// (semantic → keyword), generation runs on Workers AI, grounded only on the retrieved hits.
// Requires the AI binding (retrieval can degrade to keyword, but there's no model to answer
// with) → 503 without it. Creates nothing; returns the answer plus its sources. Project
// reach is already gated by requireProjectAccess on /api/projects/:pid/*.
app.post('/api/projects/:pid/ask', userAuth, async (c) => {
  const gen = generationClient(c.env);
  if (!gen) return c.json({ error: 'no AI backend — asking questions requires the Workers AI (AI) binding' }, 503);
  const { question } = await c.req.json<{ question?: string }>().catch(() => ({ question: undefined }));
  const q = question?.trim();
  if (!q) return c.json({ error: 'question required' }, 400);
  const pid = c.req.param('pid')!;
  const project = await c.env.DB.prepare('SELECT name FROM projects WHERE id = ?').bind(pid).first<{ name: string }>();
  try {
    return c.json(await answerQuestion(c.env, gen, { question: q, projectId: pid, projectName: project?.name ?? 'this project' }));
  } catch (e) {
    return c.json({ error: `answer generation failed: ${e instanceof Error ? e.message : 'unknown error'}` }, 502);
  }
});

// Archive / restore a plan (PLNR-148) — display-only; see setPlanArchived.
app.post('/api/projects/:pid/plans/:plid/archive', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).setPlanArchived(c.req.param('pid')!, humanActor(c), c.req.param('plid')!, true)));
app.post('/api/projects/:pid/plans/:plid/restore', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).setPlanArchived(c.req.param('pid')!, humanActor(c), c.req.param('plid')!, false)));

// The mandatory human gate (RUN-23): approve a proposed plan → its tasks become
// claimable/dispatchable; reject → discard the proposal (its un-started tasks are
// cancelled). Both are project-reach gated by the /api/projects/:pid/* middleware.
app.post('/api/projects/:pid/plans/:plid/approve', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).approvePlan(c.req.param('pid')!, humanActor(c), c.req.param('plid')!)));
app.post('/api/projects/:pid/plans/:plid/reject', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).rejectPlan(c.req.param('pid')!, humanActor(c), c.req.param('plid')!)));

// The spin-off gate's task-level twin (PLNR-230): accept a run agent's proposed spin-off
// (→ plain claimable todo) or reject it (→ cancelled; provenance kept). Same project-reach
// gating as the plan gate above.
app.post('/api/projects/:pid/tasks/:tid/spinoff/accept', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).acceptSpinoff(c.req.param('pid')!, humanActor(c), c.req.param('tid')!)));
app.post('/api/projects/:pid/tasks/:tid/spinoff/reject', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).rejectSpinoff(c.req.param('pid')!, humanActor(c), c.req.param('tid')!)));

app.delete('/api/projects/:pid/tasks/:tid', userAuth, async (c) =>
  c.json(await room(c.env, c.req.param('pid')!).deleteTask(c.req.param('pid')!, humanActor(c), c.req.param('tid')!)));

// Whole-project delete — owner or admin only. Irreversible.
app.delete('/api/projects/:pid', userAuth, async (c) => {
  // The demo user OWNS the seeded project, so the owner gate below would let it delete the
  // whole demo out from under the nightly reset (PLNR-199). Refuse.
  const denied = demoDenied(c);
  if (denied) return denied;
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
  // Consent-based (PLNR-138): a PENDING invite is not membership — only 'accepted' counts.
  !!(await env.DB.prepare("SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ? AND status = 'accepted'").bind(userId, gid).first());

app.get('/api/groups', userAuth, async (c) => {
  // Everyone sees every group (group names are needed to render the project
  // directory — a project's group must resolve or the project vanishes from the
  // UI). Editing is what's restricted: `canEdit` gates the rename/delete controls,
  // and PATCH/DELETE enforce membership server-side (PLNR-81).
  const u = c.var.user!;
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.name, g.description, g."order",
            (CASE WHEN ?1 = 'admin' OR EXISTS (SELECT 1 FROM user_groups ug WHERE ug.group_id = g.id AND ug.user_id = ?2 AND ug.status = 'accepted')
                  THEN 1 ELSE 0 END) AS canEdit
     FROM groups g ORDER BY g."order", g.created_at`,
  ).bind(u.role, u.id).all();
  return c.json({ groups: results });
});

app.post('/api/groups', userAuth, async (c) => {
  const denied = demoDenied(c); // no new groups in the demo (PLNR-199)
  if (denied) return denied;
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
  // Project meta carries the sharing/visibility levers (group, public, owner) that would let
  // the demo escape its seeded sandbox — and the whole endpoint is outside the "light
  // in-project work" the demo allows (PLNR-199). Refuse it wholesale; the nightly reset owns
  // the demo project's shape anyway.
  const denied = demoDenied(c);
  if (denied) return denied;
  const body = await c.req.json<{ groupId?: string | null; description?: string; name?: string; claimTtlSeconds?: number; ownerUserId?: string | null; public?: boolean; tagPolicy?: 'open' | 'curated'; fileLocking?: boolean; lockTtlSeconds?: number | null }>();
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
  // TTL changes route through the DO (PLNR-116) instead of this batched UPDATE, so the live
  // room resets its memoized this._ttl instead of issuing claims on the stale value.
  let ttlToSet: number | undefined;
  if (body.claimTtlSeconds !== undefined) {
    if (body.claimTtlSeconds < 60 || body.claimTtlSeconds > 24 * 3600) return c.json({ error: 'claim TTL must be 60s–24h' }, 400);
    ttlToSet = Math.round(body.claimTtlSeconds);
  }
  // File locking (opt-in, PLNR-206) routes through the DO like the claim TTL, so the live room
  // resets its memoized flag/TTL instead of running on the stale value.
  const lockOpts: { enabled?: boolean; ttlSeconds?: number | null } = {};
  if (body.fileLocking !== undefined) lockOpts.enabled = !!body.fileLocking;
  if (body.lockTtlSeconds !== undefined) {
    if (body.lockTtlSeconds !== null && (body.lockTtlSeconds < 60 || body.lockTtlSeconds > 24 * 3600)) {
      return c.json({ error: 'lock TTL must be 60s–24h (or null to inherit the claim TTL)' }, 400);
    }
    lockOpts.ttlSeconds = body.lockTtlSeconds === null ? null : Math.round(body.lockTtlSeconds);
  }
  if (body.ownerUserId !== undefined) {
    if (c.var.user!.role !== 'admin') return c.json({ error: 'admin role required to reassign ownership' }, 403);
    sets.push('owner_user_id = ?'); binds.push(body.ownerUserId);
  }
  if (body.tagPolicy !== undefined) {
    // PLNR-194: 'curated' = only humans mint tags; agents must use the existing vocabulary.
    if (body.tagPolicy !== 'open' && body.tagPolicy !== 'curated') return c.json({ error: 'tagPolicy must be "open" or "curated"' }, 400);
    sets.push('tag_policy = ?'); binds.push(body.tagPolicy);
  }
  if (body.public !== undefined) {
    // Publishing a project is the OWNER's call (or an admin's) — a group member must not
    // be able to expose shared work to the internet (PLNR-78).
    const own = await c.env.DB.prepare('SELECT owner_user_id AS o FROM projects WHERE id = ?')
      .bind(c.req.param('pid')!).first<{ o: string | null }>();
    if (c.var.user!.role !== 'admin' && own?.o !== c.var.user!.id) {
      return c.json({ error: 'only the project owner may change public visibility' }, 403);
    }
    sets.push('public = ?'); binds.push(body.public ? 1 : 0);
  }
  const pid = c.req.param('pid')!;
  if (sets.length) {
    binds.push(pid);
    await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }
  if (ttlToSet !== undefined) await room(c.env, pid).setClaimTtl(pid, ttlToSet);
  if (lockOpts.enabled !== undefined || lockOpts.ttlSeconds !== undefined) await room(c.env, pid).setFileLocking(pid, lockOpts);
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
  // The full directory — role, disabled flag, group ids, passkey/owned-project counts — is
  // admin-only PII (account enumeration / phishing / "find the admins"); the admin UI is the
  // only surface that renders it. Non-admins still get a minimal directory (id, name, email,
  // disabled) because a group member manages their group's membership and the add-member picker
  // resolves candidates from it (PLNR-83) — but nothing role- or metadata-revealing.
  if (!requireAdmin(c)) {
    const { results } = await c.env.DB.prepare(
      'SELECT id, name, email, disabled FROM users ORDER BY created_at',
    ).all();
    return c.json({ users: results });
  }
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
  if (body.disabled) {
    // Disabling must be a real kill switch (PLNR-103): killing web sessions alone leaves every
    // OAuth-connected agent with full MCP access for the token lifetime (≤7d) and refreshable to
    // ≤90d. Revoke the user's tokens and agents too so containment is immediate.
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid),
      c.env.DB.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(nowIso(), uid),
      c.env.DB.prepare("UPDATE agents SET status = 'revoked' WHERE user_id = ? AND status != 'revoked'").bind(uid),
    ]);
  }
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
    c.env.DB.prepare('DELETE FROM templates WHERE user_id = ?').bind(uid),
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
  const denied = demoDenied(c); // the demo touches no shared groups (PLNR-199)
  if (denied) return denied;
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
  const denied = demoDenied(c);
  if (denied) return denied;
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
  // status lets the UI mark who's a member vs. who has a pending invite (PLNR-138).
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, ug.status FROM user_groups ug JOIN users u ON u.id = ug.user_id
     WHERE ug.group_id = ? ORDER BY ug.status = 'accepted' DESC, u.name`,
  ).bind(gid).all();
  return c.json({ members: results });
});

// A user's own pending group invites — the accept/decline surface in Settings (PLNR-138).
app.get('/api/me/group-invites', userAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT g.id AS groupId, g.name AS groupName, ug.invited_at AS invitedAt, iu.name AS invitedByName
     FROM user_groups ug JOIN groups g ON g.id = ug.group_id
     LEFT JOIN users iu ON iu.id = ug.invited_by
     WHERE ug.user_id = ? AND ug.status = 'pending' ORDER BY ug.invited_at DESC`,
  ).bind(c.var.user!.id).all();
  return c.json({ invites: results });
});

app.post('/api/groups/:gid/members', userAuth, async (c) => {
  const denied = demoDenied(c);
  if (denied) return denied;
  const gid = c.req.param('gid')!;
  if (!(await requireGroupMember(c, gid))) return c.json({ error: 'only a group member can invite members' }, 403);
  const { userId } = await c.req.json<{ userId: string }>();
  const target = await c.env.DB.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0').bind(userId ?? '').first();
  if (!target) return c.json({ error: 'user not found' }, 404);
  // Consent-based (PLNR-138): create a PENDING invite the target must accept, rather than
  // adding them outright. OR IGNORE leaves any existing row as-is — an accepted member is
  // not downgraded to pending, and a standing invite is not duplicated or its inviter reset.
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO user_groups (user_id, group_id, status, invited_by, invited_at) VALUES (?, ?, 'pending', ?, ?)",
  ).bind(userId, gid, c.var.user!.id, nowIso()).run();
  // Report the resulting state so re-inviting an existing member reads honestly.
  const row = await c.env.DB.prepare('SELECT status FROM user_groups WHERE user_id = ? AND group_id = ?')
    .bind(userId, gid).first<{ status: string }>();
  return c.json({ ok: true, status: row?.status ?? 'pending' });
});

// The invite target consents (PLNR-138). You act only on your OWN invite (keyed by your
// user id), so there is no group-member gate — a pending invitee is not yet a member.
app.post('/api/groups/:gid/members/accept', userAuth, async (c) => {
  const denied = demoDenied(c);
  if (denied) return denied;
  const gid = c.req.param('gid')!;
  const r = await c.env.DB.prepare(
    "UPDATE user_groups SET status = 'accepted' WHERE user_id = ? AND group_id = ? AND status = 'pending'",
  ).bind(c.var.user!.id, gid).run();
  if (!r.meta.changes) return c.json({ error: 'no pending invite for you in this group' }, 404);
  return c.json({ ok: true });
});

app.post('/api/groups/:gid/members/decline', userAuth, async (c) => {
  const denied = demoDenied(c);
  if (denied) return denied;
  const gid = c.req.param('gid')!;
  await c.env.DB.prepare(
    "DELETE FROM user_groups WHERE user_id = ? AND group_id = ? AND status = 'pending'",
  ).bind(c.var.user!.id, gid).run();
  return c.json({ ok: true });
});

app.delete('/api/groups/:gid/members/:uid', userAuth, async (c) => {
  const denied = demoDenied(c);
  if (denied) return denied;
  const gid = c.req.param('gid')!;
  // Removing yourself (declining a membership you hold, or leaving) needs no gate; removing
  // someone else is group management, so it stays member-gated.
  const uid = c.req.param('uid')!;
  if (uid !== c.var.user!.id && !(await requireGroupMember(c, gid))) {
    return c.json({ error: 'only a group member can remove members' }, 403);
  }
  await c.env.DB.prepare('DELETE FROM user_groups WHERE user_id = ? AND group_id = ?').bind(uid, gid).run();
  return c.json({ ok: true });
});

// --- agent management (admin humans) ------------------------------------------------

app.get('/api/agents', userAuth, async (c) => {
  // Agents are project-local; scope the roster to a project when given (the Agents tab
  // passes the current project).
  const projectId = c.req.query('projectId');
  // ?kind=copilot is a DIFFERENT read, not a filter (PLNR-156). A copilot is deliberately not
  // project-local — it roams, and a connection's copilot has project_id NULL by design
  // (PLNR-155) — so the project-scoped query below would return an empty list and read as
  // broken. Copilots scope to their OWNER instead: yours are yours to see, no admin needed.
  if (c.req.query('kind') === 'copilot') {
    const isAdmin = c.var.user!.role === 'admin';
    const stmt = c.env.DB.prepare(
      `SELECT a.id, COALESCE(a.label, a.name) AS name, a.role, a.status, a.last_seen_at AS lastSeenAt,
              a.created_at AS createdAt, a.kind, a.runner_id AS runnerId, a.project_id AS projectId,
              a.parent_agent_id AS parentAgentId, u.name AS ownerName, u.id AS ownerUserId,
              (SELECT COUNT(*) FROM tasks t WHERE t.claimed_by = a.id) AS heldTasks,
              (SELECT COUNT(*) FROM claims cl WHERE cl.agent_id = a.id) AS totalClaims,
              -- Which client authorized it; only a connection copilot has a token pointing at it.
              (SELECT COALESCE(oc.name, 'MCP client') FROM oauth_tokens ot
                 LEFT JOIN oauth_clients oc ON oc.id = ot.client_id
                WHERE ot.copilot_id = a.id ORDER BY ot.expires_at DESC LIMIT 1) AS clientName
         FROM agents a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.kind = 'copilot' AND a.status != 'revoked'${isAdmin ? '' : ' AND a.user_id = ?1'}
        -- Group each connection copilot with its session children: same COALESCE key, parent
        -- first (its own parent_agent_id is NULL), then children oldest-first.
        ORDER BY COALESCE(a.parent_agent_id, a.id), a.parent_agent_id IS NOT NULL, a.created_at`,
    );
    const { results } = await (isAdmin ? stmt : stmt.bind(c.var.user!.id)).all();
    return c.json({ agents: results });
  }
  // PLNR-97: the roster is per-project — a non-admin must be able to reach it; the
  // cross-project view (no projectId) stays admin-only.
  if (projectId) {
    if (!(await reachesProject(c, projectId))) return c.json({ error: 'not found' }, 404);
  } else if (c.var.user!.role !== 'admin') {
    return c.json({ agents: [] });
  }
  // ?kind=agent narrows the project roster to runner-spawned agents. Absent, the roster stays
  // exactly as it was (both kinds), so nothing that already calls this changes shape.
  const agentsOnly = c.req.query('kind') === 'agent' ? " AND a.kind = 'agent'" : '';
  const where = (projectId ? 'WHERE a.project_id = ?' : 'WHERE a.project_id IS NOT NULL') + agentsOnly;
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
  // The coordinate catalog per installed tool (RUN-115) — models + efforts for the dashboard's
  // agent picker. Additive to `tools`; an older runner omits it and the picker falls back to
  // free-text. Persisted inside the `capabilities` JSON (no column), so it rides the existing read.
  agents: z.array(AdvertisedAgent).default([]),
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
    const projectId = row?.id ?? null;
    // The board lock (RUN-71), resolved the same way the key is: committed NAME → per-server
    // id, only within the repo's own resolved project. Case-insensitive because the marker is
    // hand-typed and board names are display strings. No match → null, and the repo stays
    // fully dispatchable — an unresolved board must not cost more than it locks.
    let boardId: string | null = null;
    if (projectId && r.board) {
      const board = await env.DB.prepare(
        'SELECT id FROM boards WHERE project_id = ? AND LOWER(name) = LOWER(?)',
      ).bind(projectId, r.board.trim()).first<{ id: string }>();
      boardId = board?.id ?? null;
    }
    out.push({ ...r, projectKey: key, projectId, board: r.board ?? null, boardId });
  }
  return out;
}

/**
 * Associate each resolved repo's committed `repositoryKey` with its canonical project_repositories
 * row (PLNR-259, §4/§6) — the "one round trip" option: a checkout declares its key on the SAME
 * POST /api/runners (or heartbeat) call that already resolves projectKey -> projectId, rather than
 * a separate associate endpoint. Best-effort per repo: an unresolved project or a missing
 * repositoryKey is skipped outright; a REFUSED association (unknown key, conflicting checkout —
 * `associateCheckout` RETURNS `{associated:false, reason}` for both, it does not throw) is logged
 * rather than discarded, so it is at least visible in the Worker's own logs even though this path
 * has no actor to notify — the runner-facing surface is the agentAuth read in PLNR-306
 * (/api/runner-memory/index-cursor), which reads the SAME live D1 state rather than this call's
 * outcome. A THROW (malformed repositoryKey, e.g. a ckt_-prefixed value) is caught separately:
 * registration/heartbeat must succeed regardless either way.
 */
async function syncRepositoryCheckouts(env: Env, runnerId: string, repos: Array<z.infer<typeof RunnerRepo>>): Promise<void> {
  const sysActor: Actor = { kind: 'system', id: 'system', name: 'system' };
  for (const r of repos) {
    if (!r.projectId || !r.repositoryKey) continue;
    try {
      const result = await room(env, r.projectId).associateCheckout(r.projectId, sysActor, {
        repositoryKey: r.repositoryKey,
        runnerId,
        checkoutId: r.id,
      });
      if (!result.associated) {
        console.warn(`checkout association refused for runner ${runnerId}, repositoryKey "${r.repositoryKey}": ${result.reason}`);
      }
    } catch (err) {
      // Malformed repositoryKey (e.g. a ckt_-prefixed value) — registration/heartbeat must
      // succeed regardless, but still worth a log line rather than a silent swallow.
      console.warn(`checkout association threw for runner ${runnerId}, repositoryKey "${r.repositoryKey}": ${String(err)}`);
    }
  }
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
  const capabilities = JSON.stringify({ tools: b.tools, kinds: b.kinds, maxConcurrency: b.maxConcurrency, agents: b.agents });
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
  await syncRepositoryCheckouts(c.env, id, repos);
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
    await syncRepositoryCheckouts(c.env, id, repos);
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
  // Land this run somewhere other than the repo's computed branch (RUN-41). The REPO decides
  // whether that is allowed at all — the daemon checks it against [land].allowedBranches, which
  // the server cannot see (the manifest is committed in the repo, not here). Validated for shape
  // only: a syntactically impossible branch name is worth rejecting at the door rather than
  // spending an agent's tokens to fail at the very end.
  targetBranch: z.string().min(1).max(200).regex(
    /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*[\x00-\x20~^:?*[\\])(?!.*\.lock(\/|$)).+(?<!\/|\.)$/,
    'not a valid git branch name',
  ).nullish(),
  anchor: z.discriminatedUnion('type', [
    z.object({ type: z.literal('task'), id: z.string() }),
    z.object({ type: z.literal('plan'), id: z.string() }),
  ]).nullish(),
  // VERIFY only: the build run whose diff to judge. The daemon branches the verifier's
  // worktree from that run's branch — without it the verifier reviews a pristine HEAD.
  verifiesRunId: z.string().nullish(),
  // Per-dispatch model + effort (RUN-33). Null/absent = the repo's [defaults] for this kind,
  // then whatever the tool defaults to — the daemon resolves that chain, since the manifest is
  // committed in the repo and invisible here.
  //
  // `model` is an unconstrained string on purpose: model names belong to the vendor and change
  // constantly, so an allowlist here would need a deploy every time one ships, and would reject
  // a model the operator's own CLI supports perfectly well. A wrong name fails fast and cheaply
  // in the tool. `effort` IS closed, because it is a fixed intent we map per driver.
  model: z.string().min(1).max(200).nullish(),
  effort: RunEffort.nullish(),
  // The agent COORDINATE (RUN-114): `claude.opus-4_8.high`, naming tool+model+effort in one string.
  // When set the daemon prefers it over the triple; when null it synthesizes one from the triple, so
  // this is a pure UI upgrade — an unconstrained string for the same reason `model` is (the daemon's
  // coordinate parser is the validator, and model ids are the vendor's).
  agent: z.string().min(1).max(200).nullish(),
  // A repo-defined workflow name (RUN-121). The daemon resolves it against the repo's committed
  // manifest; `kind` above still carries the posture — the dispatcher sets `kind` to the
  // workflow's base (the advertised entry names it, PLNR-240). Free string, but VALIDATED at
  // dispatch against the repo's advertised set: an unknown name is refused legibly here rather
  // than silently falling back to the built-in — a run built under the wrong posture's prompt
  // is worse than one that didn't start.
  workflow: z.string().min(1).max(80).nullish(),
  budget: RunBudget.optional(),
});


// Dispatch a brief → a Run on a runner (RUN-7). The dispatch primitive is the
// *intent*: kind + repo + brief (+ optional task/plan anchor). Creates the Run in
// the project's ProjectRoom (authoritative, dispatched) and pushes run.assigned
// down the runner's live socket. Under /api/projects/:pid/* → project reach gated.
app.post('/api/projects/:pid/runs', userAuth, async (c) => {
  const denied = demoDenied(c); // the demo drives no runners (PLNR-199)
  if (denied) return denied;
  const pid = c.req.param('pid')!;
  const parsed = DispatchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid dispatch', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  // The runner must belong to this user, and the target repo must resolve to THIS project.
  const runner = await c.env.DB.prepare('SELECT repos FROM runners WHERE id = ? AND owner_user_id = ?')
    .bind(b.runnerId, c.var.user!.id).first<{ repos: string }>();
  if (!runner) return c.json({ error: 'runner not found' }, 404);
  const repo = (JSON.parse(runner.repos) as Array<{ id: string; projectId: string | null; workflows?: Array<string | { name: string }> }>).find((r) => r.id === b.repoRef);
  if (!repo) return c.json({ error: 'unknown repoRef for this runner' }, 400);
  if (repo.projectId !== pid) return c.json({ error: 'repo does not resolve to this project' }, 400);

  // A named workflow must be on the repo's advertised menu (PLNR-240) — refuse legibly, never
  // silently fall back to the built-in.
  if (b.workflow && !advertisedWorkflowNames(repo).has(b.workflow)) {
    return c.json({ error: `workflow "${b.workflow}" is not advertised by this repo — refresh the runner or pick another` }, 400);
  }

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
    targetBranch: b.targetBranch ?? null,
    agent: b.agent ?? null, workflow: b.workflow ?? null,
    model: b.model ?? null, effort: b.effort ?? null,
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

// --- Plan dispatch (PLNR-170): dispatch a whole PLAN; the server fans out per-task runs ---
// The dispatch primitive above stays the unit of execution — this creates a durable
// orchestration record and a pump in the project's room turns ready tasks (dependency edges
// satisfied) into task-anchored build runs, parallel up to the runner's capacity.
const PlanDispatchApiBody = z.object({
  runnerId: z.string(),
  repoRef: z.string(), // must be one of the runner's advertised repos, resolving to this project
  agentTool: AgentTool,
  // Same rules as DispatchBody (RUN-33): model is the vendor's string, effort is our intent.
  model: z.string().min(1).max(200).nullish(),
  effort: RunEffort.nullish(),
  // Applied to EVERY run the dispatch creates (per-run ceilings, not a shared pool).
  budget: RunBudget.optional(),
  // 'approved' (default, PLNR-176): dependents wait until the human marks each upstream
  // task done — review is a real lock, and a kicked-back task can't already have
  // dependents running on its rejected work. 'landed' unblocks dependents as soon as the
  // upstream's run lands (verify passed, code on the plan branch) while review is still
  // pending — faster, but an explicit opt-in to running ahead of sign-off.
  gate: z.enum(['landed', 'approved']).default('approved'),
  // The dispatch-level workflow DEFAULT (PLNR-240): every run the pump creates runs under it
  // unless the task names its own. Validated against the repo's advertised set at the door,
  // same as the single-run dispatch; a task-level name is validated by the pump per task.
  workflow: z.string().min(1).max(80).nullish(),
});
app.post('/api/projects/:pid/plans/:planId/dispatch', userAuth, async (c) => {
  const denied = demoDenied(c);
  if (denied) return denied;
  const pid = c.req.param('pid')!;
  const planId = c.req.param('planId')!;
  const parsed = PlanDispatchApiBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid plan dispatch', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  // Same door checks as a single-run dispatch: your runner, and a repo that resolves HERE.
  const runner = await c.env.DB.prepare('SELECT repos FROM runners WHERE id = ? AND owner_user_id = ?')
    .bind(b.runnerId, c.var.user!.id).first<{ repos: string }>();
  if (!runner) return c.json({ error: 'runner not found' }, 404);
  const repo = (JSON.parse(runner.repos) as Array<{ id: string; projectId: string | null; workflows?: Array<string | { name: string }> }>).find((r) => r.id === b.repoRef);
  if (!repo) return c.json({ error: 'unknown repoRef for this runner' }, 400);
  if (repo.projectId !== pid) return c.json({ error: 'repo does not resolve to this project' }, 400);
  if (b.workflow && !advertisedWorkflowNames(repo).has(b.workflow)) {
    return c.json({ error: `workflow "${b.workflow}" is not advertised by this repo — refresh the runner or pick another` }, 400);
  }
  try {
    const dispatch = await room(c.env, pid).createPlanDispatch(pid, humanActor(c), {
      planId, runnerId: b.runnerId, repoRef: b.repoRef, agentTool: b.agentTool,
      model: b.model ?? null, effort: b.effort ?? null, budget: b.budget, gate: b.gate,
      workflow: b.workflow ?? null,
    });
    return c.json({ dispatch });
  } catch (e) {
    // The room's refusals (proposed plan, duplicate live dispatch, no open tasks) are the
    // caller's to fix — surface them as a 409, not a 500.
    return c.json({ error: e instanceof Error ? e.message : 'plan dispatch failed' }, 409);
  }
});

app.get('/api/projects/:pid/plan-dispatches', userAuth, async (c) => {
  const pid = c.req.param('pid')!;
  const planId = c.req.query('planId') ?? null;
  const { dispatches } = await room(c.env, pid).listPlanDispatches(pid, planId);
  return c.json({ dispatches });
});

app.post('/api/plan-dispatches/:id/cancel', userAuth, async (c) => {
  const id = c.req.param('id')!;
  const reason = ((await c.req.json<{ reason?: string }>().catch(() => ({}))) as { reason?: string }).reason ?? null;
  const row = await c.env.DB.prepare('SELECT project_id AS pid FROM plan_dispatches WHERE id = ?')
    .bind(id).first<{ pid: string }>();
  if (!row) return c.json({ error: 'plan dispatch not found' }, 404);
  if (!(await reachesProject(c, row.pid))) return c.json({ error: 'not found' }, 404);
  const res = await room(c.env, row.pid).cancelPlanDispatch(row.pid, humanActor(c), id, reason);
  return c.json(res);
});

// Re-arm tasks whose only attempts failed and pump again. The pump never retries on its
// own — a failed agent run is a human's judgment call, and this endpoint is that judgment.
app.post('/api/plan-dispatches/:id/retry', userAuth, async (c) => {
  const denied = demoDenied(c);
  if (denied) return denied;
  const id = c.req.param('id')!;
  const row = await c.env.DB.prepare('SELECT project_id AS pid FROM plan_dispatches WHERE id = ?')
    .bind(id).first<{ pid: string }>();
  if (!row) return c.json({ error: 'plan dispatch not found' }, 404);
  if (!(await reachesProject(c, row.pid))) return c.json({ error: 'not found' }, 404);
  try {
    const res = await room(c.env, row.pid).retryPlanDispatch(row.pid, humanActor(c), id);
    return c.json(res);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'retry failed' }, 409);
  }
});

// The run TRANSCRIPT (RUN-74): the append-only, role-labeled stream of everything the run
// said — builder turns, each reviewer round, verify output, daemon milestones. This is the
// "why was it refused" surface; log_tail on the run row remains the collapsed live preview.
app.get('/api/runs/:runId/log', userAuth, async (c) => {
  const runId = c.req.param('runId')!;
  const run = await c.env.DB.prepare('SELECT project_id AS pid FROM runs WHERE id = ?')
    .bind(runId).first<{ pid: string }>();
  if (!run) return c.json({ error: 'run not found' }, 404);
  if (!(await reachesProject(c, run.pid))) return c.json({ error: 'not found' }, 404);
  const { segments } = await room(c.env, run.pid).getRunLog(run.pid, runId);
  return c.json({ segments });
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

// Continue a FAILED run (PLNR-180): re-open the SAME run id → dispatched with a fresh reviewer-
// round budget, and re-hand it to the runner that still holds its kept worktree. The daemon
// (RUN-91) picks up from that worktree instead of re-deriving from scratch. `rounds` is optional —
// null lets the daemon fall back to its manifest `[verify.agent].maxRounds`. reopenRun enforces the
// real guards (run is failed+build, its runner online and still advertising the repo) and re-arms
// the anchor task in the same DO breath.
const ContinueBody = z.object({ rounds: z.number().int().positive().nullable().default(null) });
app.post('/api/runs/:runId/continue', userAuth, async (c) => {
  const denied = demoDenied(c);
  if (denied) return denied;
  const runId = c.req.param('runId')!;
  const parsed = ContinueBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid continue', detail: parsed.error.issues }, 400);
  const run = await c.env.DB.prepare('SELECT project_id AS pid, runner_id AS runnerId FROM runs WHERE id = ?')
    .bind(runId).first<{ pid: string; runnerId: string | null }>();
  if (!run) return c.json({ error: 'run not found' }, 404);
  if (!(await reachesProject(c, run.pid))) return c.json({ error: 'not found' }, 404);
  let reopened: RunView;
  try {
    reopened = await room(c.env, run.pid).reopenRun(run.pid, humanActor(c), runId, parsed.data.rounds);
  } catch (err) {
    // The DO owns the guards (offline runner, repo no longer advertised, not a failed build) — a
    // rejection here is the human's answer, not a 500. 409: the run's state won't allow it now.
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 409);
  }
  // Fast path; a missed frame is redelivered on the daemon's next hello (RunnerHub) from the row.
  const { delivered } = reopened.runnerId
    ? await hub(c.env, reopened.runnerId).deliver(JSON.stringify({ type: 'run.assigned', run: reopened }))
    : { delivered: false };
  return c.json({ run: reopened, delivered });
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
  const denied = demoDenied(c);
  if (denied) return denied;
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
  // RUN-47: the daemon's per-kind tool floor, declared at agent creation so the MCP server
  // advertises exactly what the daemon will permit — one authority, one advertisement, no
  // shared constant to drift. Optional: an older daemon that omits it gets the full
  // catalogue, which is the pre-RUN-47 behavior it enforces against anyway.
  allowedTools: z.array(z.string().min(1).max(64)).max(64).optional(),
});
app.post('/api/runs/:runId/agent', agentAuth, async (c) => {
  const runId = c.req.param('runId')!;
  const parsed = RunAgentBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid run-agent request', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  const conn = c.var.connection!;
  const run = await c.env.DB.prepare(
    `SELECT r.id, r.kind, r.status, r.project_id AS projectId, r.runner_id AS runnerId, r.agent_id AS agentId,
            rn.owner_user_id AS owner
     FROM runs r LEFT JOIN runners rn ON rn.id = r.runner_id WHERE r.id = ?`,
  ).bind(runId).first<{
    id: string; kind: string; status: RunStatus; projectId: string; runnerId: string | null;
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
  // A run that is OVER gets no credential at all, and this is asked FIRST so a finished run says
  // so plainly rather than being refused for the incidental reason that it already had an agent.
  // A run can reach a terminal status before its agent was ever created — a daemon restart
  // reconciles dispatched runs to failed, and a human can cancel one in the same window — and
  // would otherwise be handed a working credential with no process, no supervision and no budget
  // behind it. Every terminal path takes an EXISTING credential away (retireRunAgent); this is the
  // same rule pointed the other way, and without it that retirement is trivially undone by asking
  // again. It also restores RUN-160: an agent whose run is not live has no attributable run kind.
  if (isTerminalRunStatus(run.status)) {
    return c.json({ error: `run is already ${run.status} — it gets no agent` }, 409);
  }
  // One LIVE agent per run. What must never happen is two live processes acting as one identity —
  // and it is not re-issuable: handing out a second credential for the same run would mean two
  // live processes could act as one identity, which is the ambiguity this exists to remove. It is
  // also what keeps a human's revocation meaningful — revoking a misbehaving run agent must not be
  // answerable by the runner minting itself a replacement.
  //
  // A CONTINUED run is not an exception and needs none: `reopenRun` clears `runs.agent_id`
  // (RUN-182), so a new sitting arrives with a clean slate and mints its first agent. Testing the
  // EXISTING agent's liveness instead was tried and is wrong twice over — a revoked agent is
  // indistinguishable from a retired one, and the daemon reports `running` BEFORE it mints, so any
  // narrowing by run status refuses exactly the case it was written to allow.
  if (run.agentId) return c.json({ error: 'run already has an agent' }, 409);

  const agentId = newId('agt');
  // The label is what a human reads in the dashboard; scope it to the run so two concurrent
  // runs in one project cannot collide (label uniqueness is per-project).
  const base = b.label ?? `${run.kind}-${runId.slice(-6)}`;
  // A CONTINUED run mints again under the same run id, and the default label is derived from that
  // id — so the second sitting would collide with the retired agent's under UNIQUE (project_id,
  // label) (migration 0045) and fail the insert outright. Distinguish the SITTING, which a human
  // needs anyway: two agents did work on this run, and a reader has to know which one a transcript
  // or a claim belongs to.
  //
  // Asked as "is this name taken", NOT derived from `run.agentId` — `reopenRun` clears that
  // column, so by the time a continuation reaches here there is nothing on the run to notice a
  // previous sitting by. An exact-equality probe rather than a count or a LIKE: counting races two
  // mints onto one number, and a caller-supplied label containing `%` or `_` would turn a LIKE
  // into a wildcard matching strangers. The suffix is the new agent's own id, unique by
  // construction.
  const taken = await c.env.DB.prepare('SELECT 1 AS ok FROM agents WHERE project_id = ? AND label = ?')
    .bind(run.projectId, base).first<{ ok: number }>();
  const label = taken ? `${base}#${agentId.slice(-6)}` : base;
  const name = `runner-${agentId.slice(-6)}`;

  // Order matters here and it is not arbitrary: agents.oauth_token_id and oauth_tokens.agent_id
  // reference each other, so whichever row is written first points at one that does not exist
  // yet. Minting the token first fails the FK outright. Hence: agent (unlinked) → token (bound
  // to the agent) → link back. 0026 made this cycle survivable by dropping NOT NULL from
  // oauth_tokens.agent_id; PLNR-143 is where the cycle stops existing at all.
  await c.env.DB.prepare(
    `INSERT INTO agents (id, name, label, role, status, kind, user_id, project_id, runner_id, allowed_tools, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, 'active', 'agent', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    agentId, name, label, b.role, conn.userId, run.projectId, run.runnerId,
    b.allowedTools ? JSON.stringify(b.allowedTools) : null, nowIso(), nowIso(),
  ).run();
  const tokens = await issueTokens(c.env.DB, conn.clientId, conn.userId, agentId, 'mcp');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE agents SET oauth_token_id = ? WHERE id = ?').bind(tokens.tokenId, agentId),
    c.env.DB.prepare('UPDATE runs SET agent_id = ? WHERE id = ?').bind(agentId, runId),
  ]);
  // The run takes its anchor task's CLAIM here, at the one moment that happens exactly once per
  // sitting (RUN-181). RUN-83 moved the task lifecycle from the agent to the run's outcome but
  // left the claim with the agent — builders are told to call `claim_task` and nothing enforces
  // it, so a run whose builder skipped it owned nothing, and a run that passed the gate, landed
  // and pushed left its task reading as never started and still claimable over merged code.
  //
  // Best-effort: a run must still get its credential if the claim cannot be taken (the task may
  // legitimately be somebody else's, or parked by a human). `settleAnchorTask` reports having
  // moved nothing via `task.settle_skipped`, which is where that shows up.
  //
  // RUN-185: this call was dropped by 31582d6 and no test noticed, because the suite exercised
  // `claimAnchorTaskOnMint` on the DO directly. The endpoint-level test in runs.test.ts is what
  // holds this line in place now — it fails if this call goes missing again.
  await room(c.env, run.projectId)
    .claimAnchorTaskOnMint(run.projectId, runId, agentId)
    .catch(() => {});

  return c.json({
    agentId,
    label,
    projectId: run.projectId,
    token: tokens.access_token,
    expiresIn: tokens.expires_in,
  });
});

/**
 * Is this Run parked on a human, and have they answered? (RUN-30)
 *
 * The daemon calls this at exactly two moments, and the second is why it exists at all:
 *
 * 1. **When the agent's session ends.** An agent that called `request_input` normally ends its
 *    turn right after, so "the session finished" is ambiguous — it means either "done" or "asked
 *    a question and stopped". Reading the row disambiguates it, and does so WITHOUT a race:
 *    `raiseSignal` commits `status='blocked'` inside blockConcurrencyWhile before the MCP call
 *    returns, so the row is already authoritative by the time the agent could emit a result. A
 *    pushed `run.parked` frame would be a coin-flip against that same instant; this cannot lose.
 * 2. **On reconnect**, for each run it has parked locally — the durable half, mirroring
 *    owed-merges. A human can answer while the box is off, and a fire-and-forget resume frame
 *    would strand the run and its worktree forever.
 *
 * `answer` is non-null only once a human has actually responded; that is the daemon's cue to
 * resume, and the text it hands the agent.
 */
app.get('/api/runs/:runId/park', agentAuth, async (c) => {
  const runId = c.req.param('runId')!;
  // Same ownership test as the run-agent endpoint: the run must belong to a runner this user
  // owns. A daemon must not be able to read the state of runs that are not its own.
  const run = await c.env.DB.prepare(
    `SELECT r.id, r.status, r.agent_id AS agentId, r.project_id AS projectId, rn.owner_user_id AS owner
       FROM runs r LEFT JOIN runners rn ON rn.id = r.runner_id WHERE r.id = ?`,
  ).bind(runId).first<{ id: string; status: string; agentId: string | null; projectId: string; owner: string | null }>();
  if (!run || run.owner !== c.var.connection!.userId) return c.json({ error: 'run not found' }, 404);
  if (!(await tokenCanReachProject(c.env, c.var.connection!.tokenId, run.projectId))) {
    return c.json({ error: 'run is outside this connection’s authorized projects' }, 403);
  }
  // The input_request this run's agent raised. Newest wins: an agent can ask more than once over
  // a run's life, and the one that parked it is the one it is waiting on now.
  const signal = run.agentId
    ? await c.env.DB.prepare(
        `SELECT id, title, body, status, response FROM signals
          WHERE agent_id = ? AND type = 'input_request' AND status IN ('open','answered')
          ORDER BY created_at DESC LIMIT 1`,
      ).bind(run.agentId).first<{ id: string; title: string; body: string | null; status: string; response: string | null }>()
    : null;
  return c.json({
    runId,
    status: run.status,
    blocked: run.status === 'blocked',
    signalId: signal?.id ?? null,
    question: signal ? [signal.title, signal.body].filter(Boolean).join('\n\n') : null,
    // Only a real human response. An 'open' signal has no answer, and a resumed run must not be
    // handed the empty string as though someone had spoken.
    answer: signal?.status === 'answered' ? signal.response : null,
  });
});

/**
 * Merge requests this runner still owes (RUN-28).
 *
 * The durable half of plan completion. The WS `plan.completed` frame is the fast path, and it is
 * only that: a plan can finish while the box is off, while the runner is offboarded, or while the
 * socket is reconnecting — and a fire-and-forget push would drop the merge request silently and
 * forever. So completion is recorded (`plan_landings`) and the daemon asks on reconnect.
 *
 * Scoped to plans this runner actually landed work for: it is the only machine with the branch.
 */
app.get('/api/runners/:id/owed-merges', agentAuth, async (c) => {
  const id = c.req.param('id')!;
  const owned = await c.env.DB.prepare('SELECT id FROM runners WHERE id = ? AND owner_user_id = ?')
    .bind(id, c.var.connection!.userId).first();
  if (!owned) return c.json({ error: 'runner not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT pl.plan_id AS planId, pl.project_id AS projectId, p.title AS planTitle,
            (SELECT r.plan_key FROM runs r WHERE r.plan_id = pl.plan_id AND r.plan_key IS NOT NULL LIMIT 1) AS planKey,
            (SELECT r.repo_ref FROM runs r WHERE r.plan_id = pl.plan_id AND r.runner_id = ?1 LIMIT 1) AS repoRef
     FROM plan_landings pl
       JOIN plans p ON p.id = pl.plan_id
     WHERE pl.merge_requested_at IS NULL
       AND EXISTS (SELECT 1 FROM runs r WHERE r.plan_id = pl.plan_id AND r.runner_id = ?1)
     ORDER BY pl.completed_at`,
  ).bind(id).all();
  return c.json({ owed: results });
});

/**
 * The daemon reports what happened to a merge request it owed.
 *
 * Recorded either way — opened, or failed with a reason. Marking only successes would leave a
 * failure invisible and the plan owed forever, so the daemon would retry the same broken thing on
 * every reconnect and nobody would learn why.
 */
const MergeReportBody = z.object({
  planId: z.string(),
  url: z.string().nullable().default(null),
  failed: z.string().nullable().default(null),
});
app.post('/api/runners/:id/owed-merges/report', agentAuth, async (c) => {
  const id = c.req.param('id')!;
  const parsed = MergeReportBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid report', detail: parsed.error.issues }, 400);
  const owned = await c.env.DB.prepare('SELECT id FROM runners WHERE id = ? AND owner_user_id = ?')
    .bind(id, c.var.connection!.userId).first();
  if (!owned) return c.json({ error: 'runner not found' }, 404);
  const b = parsed.data;
  await c.env.DB.prepare(
    'UPDATE plan_landings SET merge_requested_at = ?, merge_request_url = ?, failed_detail = ? WHERE plan_id = ?',
  ).bind(nowIso(), b.url, b.failed, b.planId).run();
  return c.json({ ok: true });
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

// PLNR-265: the Runner worktree-verification (thorough) tier's landing point (§15). Deliberately
// on the ordinary agentAuth run surface, NOT PLNR-260's capability-token ingest routes (locked
// decision) — a verification report is small and belongs where every other run-scoped agent
// action already lives; capability tokens exist for BULK payloads (§8), and widening them here
// would add a second trust path for no size benefit. Authenticates as the RUN'S OWN agent
// specifically (never a bare copilot connection, never a DIFFERENT run's agent) — the same
// "is this caller who it claims to be for THIS run" check `steer-ack`/`park` apply via ownership,
// tightened here to the exact bound agent because a verification report is written attributed to
// an actor, not merely gated by project reach.
app.post('/api/runs/:runId/verification-report', agentAuth, async (c) => {
  const runId = c.req.param('runId')!;
  let report: ReturnType<typeof normalizeVerificationReport>;
  try {
    report = normalizeVerificationReport(await c.req.json());
  } catch (e) {
    return c.json({ error: 'invalid verification report', detail: e instanceof Error ? e.message : String(e) }, 400);
  }
  const conn = c.var.connection!;
  const run = await c.env.DB.prepare('SELECT project_id AS projectId, agent_id AS agentId FROM runs WHERE id = ?')
    .bind(runId).first<{ projectId: string; agentId: string | null }>();
  if (!run) return c.json({ error: 'run not found' }, 404);
  if (!conn.boundAgent || conn.boundAgent.id !== run.agentId) {
    return c.json({ error: 'this run has no live agent matching the caller' }, 403);
  }
  if (!(await tokenCanReachProject(c.env, conn.tokenId, run.projectId))) {
    return c.json({ error: 'run is outside this connection’s authorized projects' }, 403);
  }
  const result = await memoryStub(c.env, run.projectId).acceptVerificationReport(run.projectId, report, { kind: 'agent', id: conn.boundAgent.id });
  return c.json(result);
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

// Agent upload via capability token (PLNR-173). No cookie/bearer — the signed token IS
// the authorization, minted by create_attachment_upload for exactly this (agent, task,
// file). Bytes stream straight to R2, never through the model context. Mirrors the POST
// route above, including the PLNR-98 real-size check (Content-Length is client-controlled).
app.put('/api/attachments/upload/:token', async (c) => {
  if (!c.env.FILES) return c.json({ error: 'attachments not configured' }, 503);
  const secret = resolveUploadSecret(c.env);
  if (!secret) return c.json({ error: 'uploads not enabled' }, 503);
  const claims = await verifyUploadToken(secret, c.req.param('token')!, Math.floor(Date.now() / 1000));
  if (!claims) return c.json({ error: 'invalid or expired upload token' }, 401);
  // The task must still exist (deleted within the TTL, or a stale token) — checked so a
  // dangling FK can't orphan an R2 object.
  const task = await c.env.DB.prepare('SELECT id, project_id AS pid FROM tasks WHERE id = ?')
    .bind(claims.tid).first<{ id: string; pid: string }>();
  if (!task || task.pid !== claims.pid) return c.json({ error: 'task not found' }, 404);
  if (Number(c.req.header('Content-Length') ?? '0') > claims.max) {
    return c.json({ error: `attachment exceeds ${claims.max} bytes` }, 413);
  }
  const key = `att/${claims.pid}/${claims.aid}/${claims.fn}`;
  const obj = await c.env.FILES.put(key, c.req.raw.body, { httpMetadata: { contentType: claims.ct } });
  const size = obj?.size ?? 0;
  if (!size || size > claims.max) {
    await c.env.FILES.delete(key).catch(() => {});
    return c.json({ error: `attachment must be 1 byte – ${claims.max} bytes` }, 413);
  }
  // Idempotent on the attachment id: a replayed PUT overwrites the same object and inserts
  // nothing new, so it stays exactly one row (and one WS event).
  const ins = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO attachments (id, task_id, filename, content_type, size, r2_key, uploaded_by_kind, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, ?)`,
  ).bind(claims.aid, claims.tid, claims.fn, claims.ct, size, key, claims.agentId, nowIso()).run();
  if (ins.meta.changes > 0) {
    const nm = await c.env.DB.prepare('SELECT COALESCE(label, name) AS name FROM agents WHERE id = ?')
      .bind(claims.agentId).first<{ name: string }>();
    await room(c.env, claims.pid).noteAttachment(claims.pid, { kind: 'agent', id: claims.agentId, name: nm?.name ?? 'agent' }, claims.tid, claims.fn, claims.aid);
  }
  return c.json({ id: claims.aid, filename: claims.fn, size });
});

// --- Repository-index + episode ingest (PLNR-260, §8): short-lived, single-purpose capability
// tokens minted for a RUNNER, then five flat token-authenticated routes — no separate agentAuth
// on those five, same posture as the attachment upload PUT above: the token IS the
// authorization. RunnerHub carries none of this (no bulk frame added to packages/shared/src/ws.ts)
// — it is HTTP-only, mirroring memory/backup.ts's bounded-chunk, checksum-before-parse, and
// manifest-last conventions. Staged-generation validation (real entity counts/hashes, graph
// references, atomic activation) is PLNR-261's; this is transport + authorization only.
const MintIngestCapabilityBody = z.object({
  projectId: z.string(),
  repositoryKey: z.string(),
  purpose: z.enum(['index', 'episode']),
  scopeId: z.string().min(1), // an IndexGenerationManifest.generationId (index) or a caller-chosen episode upload id
  runnerId: z.string(),
  maxBytes: z.number().int().positive().max(MAX_INGEST_BATCH_BYTES).optional(),
});

app.post('/api/runner-ingest/capability', agentAuth, async (c) => {
  const parsed = MintIngestCapabilityBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid capability request', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  const conn = c.var.connection!;
  // Same two gates as POST /api/runs/:runId/agent and GET /api/runs/:runId/park: the runner must
  // be owned by this connection's user, and the connection's TOKEN must be authorized for the
  // project — an unscoped run-agent token would otherwise treat this as reaching every project.
  const owned = await c.env.DB.prepare('SELECT id FROM runners WHERE id = ? AND owner_user_id = ?').bind(b.runnerId, conn.userId).first<{ id: string }>();
  if (!owned) return c.json({ error: 'runner not found' }, 404);
  if (!(await tokenCanReachProject(c.env, conn.tokenId, b.projectId))) {
    return c.json({ error: 'runner is outside this connection’s authorized projects' }, 403);
  }
  // The repository key must resolve to a canonical repository IN THIS project (PLNR-259) —
  // refused, without disclosing whether the key exists elsewhere, rather than minting a
  // capability scoped to nothing.
  const repo = await resolveRepositoryByKey(c.env, b.projectId, b.repositoryKey);
  if (!repo) return c.json({ error: `no repository registered for key "${b.repositoryKey}" in this project` }, 404);
  const secret = resolveUploadSecret(c.env);
  if (!secret) return c.json({ error: 'ingest capabilities are not enabled — set ATTACHMENT_UPLOAD_SECRET (or ADMIN_TOKEN)' }, 503);
  const max = Math.min(b.maxBytes ?? MAX_INGEST_BATCH_BYTES, MAX_INGEST_BATCH_BYTES);
  const expSec = Math.floor(Date.now() / 1000) + INGEST_TOKEN_TTL_SECONDS;
  const token = await signIngestToken(secret, {
    typ: 'ingest', pid: b.projectId, repositoryKey: b.repositoryKey, purpose: b.purpose, scopeId: b.scopeId, runnerId: b.runnerId, max, exp: expSec,
  });
  return c.json({ token, maxBytes: max, expiresAt: new Date(expSec * 1000).toISOString() });
});

// --- Runner-reachable (agentAuth) Project Memory READS (PLNR-306) -----------------------------
// Every Project Memory read above (memory/repositories, memory/context, etc.) lives under
// /api/projects/:pid/* (line 146), which runs userAuth before any route-level auth — a
// Bearer-only daemon can never reach it (see the locked decision on index.ts:146 in this task's
// executionSpec). These two routes give the runner daemon the read side RUN-213 (index cursor
// reconciliation) and RUN-228 (context packs) need, OUTSIDE that subtree, with projectId in the
// BODY — mirroring POST /api/runner-ingest/capability immediately above: the SAME two gates
// (runner owned by this connection's user -> 404; tokenCanReachProject -> 403) in the SAME order,
// then resolveRepositoryByKey's existing non-disclosing 404. Read-only: no capability minted, no
// row written, no event emitted, ProjectRoom never touched.

/** The two gates every runner-memory route below shares with POST /api/runner-ingest/capability.
 *  Returns a Response to return as-is on failure, or null to proceed. */
async function runnerMemoryGateDenied(c: Context<AppContext>, runnerId: string, projectId: string): Promise<Response | null> {
  const conn = c.var.connection!;
  const owned = await c.env.DB.prepare('SELECT id FROM runners WHERE id = ? AND owner_user_id = ?').bind(runnerId, conn.userId).first<{ id: string }>();
  if (!owned) return c.json({ error: 'runner not found' }, 404);
  if (!(await tokenCanReachProject(c.env, conn.tokenId, projectId))) {
    return c.json({ error: 'runner is outside this connection’s authorized projects' }, 403);
  }
  return null;
}

const RunnerMemoryCursorBody = z.object({
  projectId: z.string(),
  repositoryKey: z.string(),
  runnerId: z.string(),
  // RunnerRepo.id — the runner-local checkout asking "is MY checkout associated?", not the
  // canonical key (that's repositoryKey above).
  checkoutId: z.string(),
});

// One round trip for RUN-213's whole reconciliation decision (unchanged / incremental / full /
// incompatible-version / association-error): the active generation's baseId/branch/indexerVersion,
// staged generations for a resume decision, and this checkout's own association state.
// `stale`/`failedIngest`/the generation lists are computed by deriveRepositoryMemoryState — the
// EXACT function GET /api/projects/:pid/memory/repositories uses — so the two surfaces can never
// disagree on "is this index stale" (locked decision).
app.post('/api/runner-memory/index-cursor', agentAuth, async (c) => {
  const parsed = RunnerMemoryCursorBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid request', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  const denied = await runnerMemoryGateDenied(c, b.runnerId, b.projectId);
  if (denied) return denied;
  const repo = await resolveRepositoryByKey(c.env, b.projectId, b.repositoryKey);
  if (!repo) return c.json({ error: `no repository registered for key "${b.repositoryKey}" in this project` }, 404);
  const generations = await memoryDO(c.env, b.projectId).listIndexGenerations(b.projectId);
  const state = deriveRepositoryMemoryState(repo, generations);
  const association = await checkoutAssociationState(c.env, repo.id, b.runnerId, b.checkoutId);
  const cursor: RunnerIndexCursor = {
    repositoryKey: repo.repositoryKey,
    defaultBranch: repo.defaultBranch,
    latestObservedBase: repo.latestObservedBase,
    ...state,
    association,
  };
  return c.json(cursor);
});

const RunnerMemoryContextBody = z.object({
  projectId: z.string(),
  runnerId: z.string(),
  taskId: z.string(),
  repositoryKey: z.string().optional(),
  branch: z.string().optional(),
  baseId: z.string().optional(),
  role: ContextPackRole.optional(),
  budgetTokens: z.number().int().positive().optional(),
});

// The agentAuth twin of POST /api/projects/:pid/memory/context (RUN-228) — same assembler, same
// shape, reused unchanged. `role` defaults to 'build' (never the userAuth route's 'human' default
// — a runner is never a browser, and 'human' would reweight section budgets toward the wrong
// reader); pass an explicit `role` to override.
app.post('/api/runner-memory/context', agentAuth, async (c) => {
  const parsed = RunnerMemoryContextBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid request', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  const denied = await runnerMemoryGateDenied(c, b.runnerId, b.projectId);
  if (denied) return denied;
  const task = await c.env.DB.prepare('SELECT id FROM tasks WHERE (id = ? OR key = ?) AND project_id = ?')
    .bind(b.taskId, b.taskId, b.projectId).first<{ id: string }>();
  if (!task) return c.json({ error: 'not found' }, 404);
  const pack = await assembleContextPack(c.env, b.projectId, task.id, {
    repositoryKey: b.repositoryKey, branch: b.branch, baseId: b.baseId,
    role: b.role ?? 'build', tokenBudget: b.budgetTokens ?? null,
  });
  return c.json(pack);
});

/** Verify an ingest capability, or a Response to return as-is on failure. Every one of the five
 *  routes below calls this first — the token is the whole authorization; there is no cookie or
 *  bearer on these routes. */
async function requireIngestCap(c: Context<AppContext>, token: string): Promise<IngestClaims | Response> {
  const secret = resolveUploadSecret(c.env);
  if (!secret) return c.json({ error: 'ingest not enabled' }, 503);
  const claims = await verifyIngestToken(secret, token, Math.floor(Date.now() / 1000));
  if (!claims) return c.json({ error: 'invalid or expired ingest token' }, 401);
  // Capabilities are stateless, so a signature minted before project deletion remains valid
  // until `exp`. Re-check the live project/repository association on every use; otherwise an old
  // index token can recreate rows in an already-erased ProjectMemory DO after its tombstone has
  // been cleared. This also revokes a token immediately when its repository is unregistered.
  const liveScope = await c.env.DB.prepare(
    `SELECT 1 FROM projects p
       JOIN project_repositories pr ON pr.project_id = p.id
      WHERE p.id = ? AND pr.repository_key = ?`,
  ).bind(claims.pid, claims.repositoryKey).first();
  if (!liveScope) return c.json({ error: 'ingest capability scope no longer exists' }, 401);
  return claims;
}

app.post('/api/memory-ingest/:token/begin', async (c) => {
  const claims = await requireIngestCap(c, c.req.param('token')!);
  if (claims instanceof Response) return claims;
  const stub = memoryStub(c.env, claims.pid);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  try {
    if (claims.purpose === 'index') {
      const manifest = IndexGenerationManifest.parse({
        ...body, generationId: claims.scopeId, projectId: claims.pid, repositoryKey: claims.repositoryKey,
      });
      await stub.beginIndexIngest(claims.pid, manifest);
    } else {
      const batchCount = typeof body.batchCount === 'number' ? body.batchCount : 1;
      await stub.beginEpisodeIngest(claims.pid, { scopeId: claims.scopeId, projectId: claims.pid, batchCount });
    }
  } catch (err) {
    return c.json({ error: String(err) }, 409);
  }
  return c.json({ ok: true });
});

app.put('/api/memory-ingest/:token/batch/:batchNumber', async (c) => {
  const claims = await requireIngestCap(c, c.req.param('token')!);
  if (claims instanceof Response) return claims;
  const batchNumber = Number(c.req.param('batchNumber'));
  if (!Number.isInteger(batchNumber) || batchNumber < 0) return c.json({ error: 'batchNumber must be a non-negative integer' }, 400);
  const batchHash = c.req.header('X-Batch-Hash');
  if (!batchHash) return c.json({ error: 'X-Batch-Hash header is required' }, 400);
  // Early reject on an honest oversized Content-Length; the REAL bound is enforced below by
  // readBoundedBody, which never buffers past claims.max regardless of what the header claims
  // (PLNR-98's streaming precedent — a chunked body has no Content-Length at all).
  if (Number(c.req.header('Content-Length') ?? '0') > claims.max) {
    return c.json({ error: `batch exceeds ${claims.max} bytes` }, 413);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(c.req.raw.body, claims.max);
    await verifyBatchChecksum(bytes, batchHash);
  } catch (err) {
    return c.json({ error: String(err) }, 413);
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await decodeBatchRows(bytes);
  } catch (err) {
    return c.json({ error: `malformed batch: ${String(err)}` }, 400);
  }
  const stub = memoryStub(c.env, claims.pid);
  try {
    const result = claims.purpose === 'index'
      ? await stub.ingestIndexBatch(claims.pid, { generationId: claims.scopeId, batchNumber, batchHash }, rows)
      : await stub.ingestEpisodeBatch(claims.pid, claims.scopeId, batchNumber, rows);
    return c.json(result);
  } catch (err) {
    return c.json({ error: String(err) }, 409);
  }
});

app.post('/api/memory-ingest/:token/complete', async (c) => {
  const claims = await requireIngestCap(c, c.req.param('token')!);
  if (claims instanceof Response) return claims;
  const stub = memoryStub(c.env, claims.pid);
  try {
    const result = claims.purpose === 'index'
      ? await stub.completeIndexIngest(claims.pid, claims.scopeId)
      : await stub.completeEpisodeIngest(claims.pid, claims.scopeId);
    return c.json(result);
  } catch (err) {
    return c.json({ error: String(err) }, 409);
  }
});

app.post('/api/memory-ingest/:token/abort', async (c) => {
  const claims = await requireIngestCap(c, c.req.param('token')!);
  if (claims instanceof Response) return claims;
  const stub = memoryStub(c.env, claims.pid);
  const result = claims.purpose === 'index'
    ? await stub.abortIndexIngest(claims.pid, claims.scopeId)
    : await stub.abortEpisodeIngest(claims.pid, claims.scopeId);
  return c.json(result);
});

app.get('/api/memory-ingest/:token/status', async (c) => {
  const claims = await requireIngestCap(c, c.req.param('token')!);
  if (claims instanceof Response) return claims;
  const stub = memoryStub(c.env, claims.pid);
  const result = claims.purpose === 'index'
    ? await stub.indexIngestStatus(claims.pid, claims.scopeId)
    : await stub.episodeIngestStatus(claims.pid, claims.scopeId);
  return c.json(result);
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
  // Show viewable types inline (images, PDF, plain text, media) so a click opens in the
  // browser instead of forcing a download. This is a STRICT allowlist, not a broad prefix
  // match: attachments are served same-origin with the SPA, so any type the browser will
  // execute as markup (text/html, image/svg+xml, application/xhtml+xml, …) must download,
  // not render — otherwise a client-supplied Content-Type is stored XSS (PLNR-99). Note
  // `text/plain` only: `text/*` would let `text/html` through. Everything else downloads.
  const inlineable = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain|audio\/|video\/)(;|$)/.test(row.ct);
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
  // Auth here (uploader/admin), then route the delete through the DO (PLNR-116) so the row
  // drop + R2 cleanup happen as a sole-writer mutation that emits attachment.removed.
  const row = await c.env.DB.prepare(
    'SELECT a.id, a.uploaded_by AS uploader, t.project_id AS pid FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?',
  ).bind(c.req.param('aid')!).first<{ id: string; uploader: string; pid: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (c.var.user!.role !== 'admin' && row.uploader !== c.var.user!.id) return c.json({ error: 'not yours' }, 403);
  await room(c.env, row.pid).removeAttachment(row.pid, humanActor(c), row.id);
  return c.json({ ok: true });
});

// --- GitHub webhook (Phase 4: reflect PR/commit state onto tasks) ----------------
app.post('/api/webhooks/github', async (c) => {
  const payload = await c.req.text();
  // Fail closed: an unset secret is not a bypass. Without it we cannot verify the
  // sender, so refuse the payload rather than trust an unauthenticated caller to
  // flip task state across every project.
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'webhook not configured — set GITHUB_WEBHOOK_SECRET' }, 501);
  const sig = c.req.header('X-Hub-Signature-256') ?? '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!(await timingSafeEqual(sig, expected))) return c.json({ error: 'bad signature' }, 401);
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
    const task = await c.env.DB.prepare('SELECT id, project_id AS pid, key, status, claimed_by AS claimedBy FROM tasks WHERE key = ?')
      .bind(key).first<{ id: string; pid: string; key: string; status: string; claimedBy: string | null }>();
    if (!task) continue;
    await c.env.DB.prepare(
      `INSERT INTO task_refs (id, task_id, kind, ref, url, state, created_at) VALUES (?, ?, 'pr', ?, ?, ?, ?)
       ON CONFLICT (task_id, kind, ref) DO UPDATE SET state = excluded.state, url = excluded.url`,
    ).bind(`ref_${crypto.randomUUID().slice(0, 12)}`, task.id, String(pr.number), pr.html_url ?? null, state, nowIso()).run();
    const sys: Actor = { kind: 'system', id: 'github', name: 'github' };
    // A CLAIMED task is somebody's live work, and this webhook must not restatus it (PLNR-226).
    // The claim guard in updateTask discriminates on `actor.kind === 'agent'`, which reads as
    // "via MCP" and deliberately exempts humans and `system` — but that exemption was written for
    // the ask-flow/demo writers, not for this: GitHub is a `system` actor too, so a PR opening
    // moved a live run's in_progress anchor to `review` underneath it. That is not a cosmetic
    // stomp. `settleAnchorTask` only matches `status IN ('in_progress','claimed')`, so when the
    // run finished it could no longer move its own task — a failed run left the task sitting in
    // `review` as though it had passed, which is exactly the stranding PLNR-226 exists to stop.
    // The PR ref is still recorded above either way; only the status move is withheld.
    if (task.claimedBy) {
      updated.push(`${key} (ref only — claimed)`);
      continue;
    }
    if (state === 'merged' && !['done', 'cancelled'].includes(task.status)) {
      await room(c.env, task.pid).updateTask(task.pid, sys, task.id, { status: 'done' });
    } else if (state === 'open' && task.status === 'in_progress') {
      await room(c.env, task.pid).updateTask(task.pid, sys, task.id, { status: 'review' });
    }
    updated.push(key);
  }
  // Merge-evidence authority promotion (PLNR-253, §12) — best-effort, never blocks the webhook's
  // own response. Scoped to a project only when it has EXACTLY ONE registered repository: the
  // webhook payload carries no Noriq repositoryKey, so a project with zero or several registered
  // repos is ambiguous and is left alone rather than guessed at (the thorough per-repository
  // correlation is Phase 5 ingest's job).
  if (state === 'merged') {
    const projectIds = [...new Set(updated.length ? (await Promise.all(keys.map(async (key) => {
      const t = await c.env.DB.prepare('SELECT project_id AS pid FROM tasks WHERE key = ?').bind(key).first<{ pid: string }>();
      return t?.pid ?? null;
    }))).filter((pid): pid is string => !!pid) : [])];
    for (const pid of projectIds) {
      try {
        const repos = await listProjectRepositories(c.env, pid);
        if (repos.length !== 1) continue;
        await memoryStub(c.env, pid).promoteMemoriesOnMerge(pid, {
          repositoryKey: repos[0]!.repositoryKey,
          branch: pr.base?.ref ?? 'main',
          mergedBaseId: pr.merge_commit_sha ?? String(pr.number),
        });
      } catch (err) {
        console.warn(`memory merge-promotion for ${pid} failed: ${String(err)}`);
      }
    }
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
    // Demo deployments re-seed nightly (PLNR-146) so visitors always land on a clean board.
    // The demo's data is disposable, so skip the backup entirely (PLNR-199) — no point
    // spending R2 on a board that gets dropped in the same cron.
    if (env.DEMO_MODE) {
      ctx.waitUntil(import('./lib/demo').then(({ resetDemo }) => resetDemo(env)).catch(() => {}));
    } else {
      ctx.waitUntil(
        backupToR2(env, new Date(event.scheduledTime).toISOString()).then((r) => {
          // eslint-disable-next-line no-console
          console.log(r.ok ? `[backup] wrote ${r.key}` : `[backup] skipped: ${r.reason}`);
        }),
      );
      // ProjectMemory portable snapshots (PLNR-248): one per project that has ever touched its
      // memory store (a project_memory_registry row exists — PLNR-246). A project that hasn't
      // has nothing in ProjectMemory yet worth a backup. Each project's export is independent —
      // one failure never blocks another's.
      ctx.waitUntil(
        env.DB.prepare('SELECT project_id FROM project_memory_registry')
          .all<{ project_id: string }>()
          .then(({ results }) =>
            Promise.all(
              results.map((r) =>
                env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(r.project_id))
                  .exportSnapshot(r.project_id)
                  .then((res) => {
                    // eslint-disable-next-line no-console
                    console.log(res.ok ? `[memory-backup] ${r.project_id} wrote ${res.manifestKey}` : `[memory-backup] ${r.project_id} skipped: ${res.reason}`);
                  })
                  .catch((err) => console.warn(`[memory-backup] ${r.project_id} failed: ${String(err)}`)),
              ),
            ),
          )
          .catch((err) => console.warn(`[memory-backup] sweep failed: ${String(err)}`)),
      );
      // ProjectMemory lifecycle sweep (PLNR-250): retry any standing erasure tombstone, then
      // prune per-project debris (abandoned staged index generations, an expired retained
      // restore generation, backups beyond the retention count) and refresh visible size
      // status. Independent of the backup sweep above — a failure in one never blocks the
      // other, since both are separately-caught waitUntil branches.
      ctx.waitUntil(
        Promise.all([
          sweepPendingErasures(env).then((r) => console.log(`[memory-lifecycle] erasure sweep: ${r.length} tombstone(s) processed`)),
          sweepProjectDebris(env).then((r) => console.log(`[memory-lifecycle] debris sweep: ${r.length} project(s) processed`)),
          sweepPendingEpisodeJobs(env).then((r) => console.log(`[memory-lifecycle] episode jobs: ${r.completed} completed, ${r.failed} failed`)),
        ]).catch((err) => console.warn(`[memory-lifecycle] sweep failed: ${String(err)}`)),
      );
    }
    // Backstop auto-archive for projects nobody has viewed (the snapshot sweeps viewed ones).
    ctx.waitUntil(
      env.DB.prepare(
        "UPDATE tasks SET archived_at = ? WHERE status = 'done' AND archived_at IS NULL AND updated_at < ?",
      ).bind(new Date(event.scheduledTime).toISOString(), new Date(event.scheduledTime - 24 * 3600 * 1000).toISOString()).run().then(() => {}),
    );
  },
};
