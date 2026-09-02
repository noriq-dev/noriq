import { SELF, env } from 'cloudflare:test';
import { VECTORIZE_METADATA_TOPK_MAX } from '../src/search';
import { issueTokens } from '../src/oauth';

export const ADMIN = 'test-admin-token';

// ---------------------------------------------------------------------------
// PLNR-281: the real Vectorize service rejects `topK > 50` whenever a query asks for
// `returnValues: true` or `returnMetadata: 'all'` — VECTOR_QUERY_ERROR, code 40025. Every
// hand-rolled fake VectorStore in search.test.ts/memory-search.test.ts/code-index.test.ts
// stands in for an adapter that ALWAYS asks for 'all' (searchBackend/codeSearchBackend never
// use 'indexed'), so a fake's `query` can enforce the ceiling unconditionally — no need to
// thread `returnMetadata` through the fake `VectorStore` interface just to branch on it. This
// is the durable half of the PLNR-281 fix: the bug survived 1103 tests purely because these
// fakes were more permissive than the real service, and a shared assert here means the next
// fake store written against this pattern gets it right instead of re-omitting the check.
// ---------------------------------------------------------------------------

export function assertVectorizeTopKOk(topK: number): void {
  if (topK > VECTORIZE_METADATA_TOPK_MAX) {
    throw new Error(
      `VECTOR_QUERY_ERROR (code = 40025): with returnValues=true or returnMetadata=all, max top K is 50, but got ${topK}; for a top K up to 100, retry with returnValues=false and returnMetadata=indexed`,
    );
  }
}

// ---------------------------------------------------------------------------
// Agent minting via the REAL OAuth flow (static keys are retired — PLNR-52):
// one shared client + consent user, then configure_agent names the agent.
// ---------------------------------------------------------------------------

const MINT_REDIRECT = 'http://localhost:39999/cb';
let mintClientId: string | null = null;
let mintCookie: string | null = null;

async function s256b64url(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintBoot() {
  if (!mintCookie) {
    mintCookie = await loginSession('agent-mint@example.com', 'longenough1').catch(async () => {
      await createUser('agent-mint@example.com', 'Agent Mint', 'longenough1', 'admin');
      return loginSession('agent-mint@example.com', 'longenough1');
    });
  }
  if (!mintClientId) {
    const res = await SELF.fetch('https://noriq.test/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'test-mint', redirect_uris: [MINT_REDIRECT] }),
    });
    mintClientId = ((await res.json()) as { client_id: string }).client_id;
  }
}

/** Every active project a user owns — what the mint helpers tick on the consent form. */
async function userProjectIds(email: string): Promise<string[]> {
  const { results } = await (env as unknown as { DB: D1Database }).DB.prepare(
    "SELECT p.id FROM projects p JOIN users u ON u.id = p.owner_user_id WHERE u.email = ? AND p.status = 'active'",
  ).bind(email).all<{ id: string }>();
  return results.map((r) => r.id);
}
const mintUserProjectIds = () => userProjectIds('agent-mint@example.com');

/**
 * Full OAuth mint: consent → code → token → configure_agent(name, role).
 *
 * Consent now REQUIRES a project scope when the user has any (RUN-38), so tick all of them —
 * that reproduces exactly what these tests assumed before scoping existed ("this token reaches
 * everything its user does") while still exercising the scoped path rather than the legacy
 * unscoped one. Projects created LATER by the token itself join its scope automatically
 * (create_project), which is what lets a mint with zero projects still bootstrap.
 */
export async function createAgent(name: string, role: 'orchestrator' | 'worker' = 'worker') {
  await mintBoot();
  const verifier = `mint-verifier-${name}-`.padEnd(48, 'x');
  const q = new URLSearchParams({
    response_type: 'code', client_id: mintClientId!, redirect_uri: MINT_REDIRECT,
    code_challenge: await s256b64url(verifier), code_challenge_method: 'S256', scope: 'mcp', state: 'm',
  });
  const form = new URLSearchParams(Object.fromEntries(q.entries()));
  form.set('decision', 'approve');
  for (const id of await mintUserProjectIds()) form.append('project_ids', id);
  const approve = await SELF.fetch('https://noriq.test/oauth/authorize', {
    method: 'POST',
    headers: { Cookie: mintCookie!, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  const code = new URL(approve.headers.get('Location')!).searchParams.get('code')!;
  const tokenRes = await SELF.fetch('https://noriq.test/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: MINT_REDIRECT,
      client_id: mintClientId!, code_verifier: verifier,
    }).toString(),
  });
  const apiKey = ((await tokenRes.json()) as { access_token: string }).access_token;
  const set = await mcpCall(apiKey, 'configure_agent', { name, role });
  if (set.isError) throw new Error(`configure_agent failed for ${name}: ${set.text}`);
  return { id: set.body.actingAs.id as string, apiKey };
}

// ---------------------------------------------------------------------------
// Acting as a historical RUNNER-SPAWNED agent (RUN-160).
// ---------------------------------------------------------------------------

const runOwnerTokens = new Map<string, string>();

/**
 * An agent with `agents.kind = 'agent'`, bound to a live run of a given kind, and the token that
 * IS it.
 *
 * New RunnerJob dispatches never mint server-side run agents. The legacy creation endpoint is
 * intentionally gone, but generic MCP and memory tests still need to exercise how already-stored
 * bound-agent identities are interpreted. This fixture therefore seeds that historical identity
 * shape directly. It must not be used to test dispatch or agent creation; the cutover tests assert
 * those writes return 410.
 *
 * The owner defaults to the user `createAgent` mints under, so a project created by a copilot in
 * the same suite remains reachable with no extra grant.
 *
 * `kind` is the three the schema allows — 0018's CHECK constrains `runs.kind` — so a test asking
 * for a kind that cannot exist fails at the type, not with an opaque D1 error.
 */
export async function createRunAgent(
  projectId: string,
  kind: 'scope' | 'build' | 'verify',
  opts: { ownerEmail?: string; allowedTools?: string[] } = {},
): Promise<{ agentId: string; apiKey: string; runId: string; runnerId: string }> {
  // Lowercased once, here: createUser lowercases the address, so an unnormalized key would give
  // two spellings of one owner two cache entries and two runners.
  const email = (opts.ownerEmail ?? 'agent-mint@example.com').toLowerCase();
  let ownerToken = runOwnerTokens.get(email);
  if (!ownerToken) {
    await createUser(email, email, 'longenough1', 'admin').catch(() => {});
    ownerToken = await mintTokenForUser(email);
    runOwnerTokens.set(email, ownerToken);
  }
  // Re-authorized on every call, not just at mint: the project under test is almost always
  // created after the token, and a token scoped to nothing turns the mint into a 403 (RUN-38).
  await authorizeForAllProjects(ownerToken);

  const db = (env as unknown as { DB: D1Database }).DB;
  const owner = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  if (!owner) throw new Error(`createRunAgent: no such user ${email}`);
  // Hashed, not sanitized: one runner per owner is the realistic shape, but any lossy mapping
  // from address to id (a prefix, or punctuation collapsed to `_`) lets two owners land on one
  // runner, and `INSERT OR IGNORE` then keeps whichever ran first — so the second owner's mint
  // 404s depending on test order. This is the only derivation that cannot do that.
  const runnerId = `rnr_fx_${(await sha256HexTest(email)).slice(0, 16)}`;
  const runId = `run_fx${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await db.prepare('INSERT OR IGNORE INTO runners (id, label, owner_user_id) VALUES (?, ?, ?)')
    .bind(runnerId, runnerId, owner.id).run();
  // Plain INSERT, not OR IGNORE: a seed that half-writes has to fail HERE rather than resurface
  // as a mystery 404 from the endpoint under test.
  await db.prepare(
    `INSERT INTO runs (id, project_id, runner_id, kind, repo_ref, agent_tool, status, created_by)
     VALUES (?, ?, ?, ?, 'repo_fx', 'claude', 'dispatched', ?)`,
  ).bind(runId, projectId, runnerId, kind, owner.id).run();
  const client = await db.prepare(
    'SELECT client_id AS clientId FROM oauth_tokens WHERE user_id = ? ORDER BY rowid DESC LIMIT 1',
  ).bind(owner.id).first<{ clientId: string }>();
  if (!client) throw new Error(`createRunAgent: no OAuth client for ${email}`);
  const agentId = `agt_fx${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO agents (
       id, name, label, role, status, kind, actor_class, user_id, project_id, runner_id,
       allowed_tools, last_seen_at, lineage_status, lineage_reason, lifecycle_updated_at, created_at
     ) VALUES (?, ?, ?, 'worker', 'active', 'agent', 'runner_agent', ?, ?, ?, ?, ?,
               'partial', 'legacy_test_fixture', ?, ?)`,
  ).bind(
    agentId, `runner-${agentId.slice(-6)}`, `${kind}-${runId.slice(-6)}`,
    owner.id, projectId, runnerId, opts.allowedTools ? JSON.stringify(opts.allowedTools) : null,
    now, now, now,
  ).run();
  const tokens = await issueTokens(db, client.clientId, owner.id, agentId, 'mcp');
  await db.batch([
    db.prepare('UPDATE agents SET oauth_token_id = ? WHERE id = ?').bind(tokens.tokenId, agentId),
    db.prepare('UPDATE runs SET agent_id = ? WHERE id = ?').bind(agentId, runId),
  ]);
  return { agentId, apiKey: tokens.access_token, runId, runnerId };
}

/** The ProjectRoom for a project, for tests that need to drive a transition the HTTP surface
 *  does not expose (run lifecycle, reconciliation). */
export function projectRoom<T>(projectId: string): T {
  const appEnv = env as unknown as { PROJECT_ROOM: DurableObjectNamespace };
  return appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(projectId)) as unknown as T;
}

/** What a test means when it says "the system did this", not a person. */
export const SYSTEM_ACTOR = { kind: 'system', id: 'system', name: 'system' };

/** OAuth-mint an access token bound to a SPECIFIC user (createAgent mints all agents
 *  under one shared user). Registers a throwaway client and runs the full flow with
 *  that user's cookie — used for genuine cross-tenant tests. */
export async function mintTokenForUser(email: string, password = 'longenough1'): Promise<string> {
  return (await mintPairForUser(email, password)).access;
}

/** Same flow, but hands back the refresh token too — for tests about rotation/revocation. */
export async function mintPairForUser(
  email: string,
  password = 'longenough1',
  clientName = 'mint-user',
): Promise<{ access: string; refresh: string }> {
  await createUser(email, email, password).catch(() => {});
  const cookie = await loginSession(email, password);
  const reg = await SELF.fetch('https://noriq.test/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: ['http://localhost:39990/cb'] }),
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = `mint-${email}-`.padEnd(48, 'x');
  const form = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:39990/cb',
    code_challenge: await s256b64url(verifier), code_challenge_method: 'S256', scope: 'mcp', state: 'm', decision: 'approve',
  });
  // Same rule as createAgent: consent requires a scope once the user has projects (RUN-38).
  // Tick whatever exists at mint time. Anything this token creates later joins its scope
  // automatically; anything created later by someone ELSE needs authorizeForAllProjects.
  for (const id of await userProjectIds(email)) form.append('project_ids', id);
  const approve = await SELF.fetch('https://noriq.test/oauth/authorize', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(), redirect: 'manual',
  });
  const code = new URL(approve.headers.get('Location')!).searchParams.get('code')!;
  const tok = await SELF.fetch('https://noriq.test/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:39990/cb', client_id: clientId, code_verifier: verifier }).toString(),
  });
  const body = (await tok.json()) as { access_token: string; refresh_token: string };
  return { access: body.access_token, refresh: body.refresh_token };
}

export async function createUser(email: string, name: string, password: string, role: 'admin' | 'member' = 'member') {
  const res = await SELF.fetch('https://noriq.test/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, password, role }),
  });
  if (res.status !== 200) throw new Error(`createUser failed: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

let rpcId = 1;

/**
 * One implicit MCP session per token.
 *
 * A connection is not an agent (0026), so a sessionless call has nobody to be, and the
 * server refuses it rather than inventing a phantom default agent. These tests were written
 * against that fallback and what they mean by a bare token is "this token's one working
 * identity" — so give each token a stable session and let that carry the meaning. Passing an
 * explicit sessionId still resolves a distinct copilot, which is what the sub-agent tests
 * are really exercising.
 */
const defaultSessions = new Map<string, string>();
export const sessionFor = (apiKey: string): string => {
  const existing = defaultSessions.get(apiKey);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  defaultSessions.set(apiKey, fresh);
  return fresh;
};

/** Call an MCP tool over Streamable HTTP and return the parsed result body + notices.
 *  Pass a sessionId to act as a distinct MCP session (a chat / sub-agent). */
export async function mcpCall(
  apiKey: string,
  tool: string,
  args: Record<string, unknown> = {},
  sessionId?: string,
  meta?: Record<string, unknown>,
) {
  const effectiveSession = sessionId ?? sessionFor(apiKey);
  // Keep older behavioral tests exercising the canonical server doors while those files are
  // migrated incrementally. This adapter exists only in test code; deprecated names never reach
  // tools/call and therefore cannot mask a production alias.
  let wireTool = tool;
  let wireArgs = args;
  let unwrap: 'created' | 'updated' | 'attachment' | 'projects' | 'intelligence' | 'comments' | undefined;
  if (tool === 'create_task') {
    const { projectId, allowNewTags, ...task } = args;
    wireTool = 'create_tasks'; wireArgs = { projectId, allowNewTags, tasks: [task] }; unwrap = 'created';
  } else if (tool === 'spin_off_task') {
    const { projectId, finding, ...task } = args;
    wireTool = 'create_tasks'; wireArgs = { projectId, tasks: [{ ...task, proposal: { finding } }] }; unwrap = 'created';
  } else if (tool === 'update_task') {
    const { projectId, taskId, ...set } = args;
    wireTool = 'update_tasks'; wireArgs = { projectId, tasks: [{ taskId, set }] }; unwrap = 'updated';
  } else if (tool === 'add_dependency' || tool === 'remove_dependency') {
    const { projectId, taskId, dependsOnTaskId } = args;
    wireTool = 'update_tasks'; wireArgs = { projectId, tasks: [{ taskId, [tool === 'add_dependency' ? 'addDependsOn' : 'removeDependsOn']: [dependsOnTaskId] }] }; unwrap = 'updated';
  } else if (tool === 'attach_ref') {
    const lookup = await mcpCallOnce(apiKey, 'get_task', { taskId: args.taskId }, effectiveSession, meta);
    if (lookup.isError) return lookup;
    const task = (lookup.body as { task?: Record<string, unknown> } | null)?.task;
    const projectId = task?.projectId ?? task?.project_id;
    const { taskId, kind, ref, url, state } = args;
    wireTool = 'update_tasks'; wireArgs = { projectId, tasks: [{ taskId, refs: [{ kind, ref, url, state }] }] }; unwrap = 'updated';
  } else if (tool === 'add_comment') {
    wireTool = 'post_comment'; wireArgs = { ...args, kind: 'comment' };
  } else if (tool === 'create_plan_from_template') {
    wireTool = 'create_plan';
  } else if (tool === 'get_task_intelligence') {
    wireTool = 'get_task_context'; wireArgs = { ...args, intelligenceDetail: 'full' }; unwrap = 'intelligence';
  } else if (tool === 'add_attachment') {
    const { projectId, taskId, filename, data, contentType } = args;
    wireTool = 'attach_files'; wireArgs = { projectId, taskId, files: [{ filename, contentType, source: { kind: 'inline', data } }] }; unwrap = 'attachment';
  } else if (tool === 'create_attachment_upload') {
    const { projectId, taskId, filename, contentType } = args;
    wireTool = 'attach_files'; wireArgs = { projectId, taskId, files: [{ filename, contentType, source: { kind: 'upload' } }] }; unwrap = 'attachment';
  } else if (tool === 'set_agent_identity' || tool === 'focus_project') {
    wireTool = 'configure_agent';
    if (tool === 'set_agent_identity') {
      const { parentAgentId: _removedParentAgentId, ...canonical } = args;
      wireArgs = canonical;
    }
  } else if (tool === 'list_projects') {
    wireTool = 'get_briefing'; wireArgs = {}; unwrap = 'projects';
  } else if (tool === 'read_open_comments') {
    wireTool = 'get_task'; unwrap = 'comments';
  } else if (tool === 'decompose_task') {
    const { projectId, parentTaskId, subtasks } = args as { projectId: string; parentTaskId: string; subtasks: Array<Record<string, unknown> & { dependsOnIndex?: number[] }> };
    wireTool = 'create_tasks';
    wireArgs = { projectId, tasks: subtasks.map((task, index) => {
      const { dependsOnIndex, ...rest } = task;
      return { ...rest, ref: `subtask-${index}`, parentTaskId, tags: rest.tags ?? ['decomposition'], dependsOn: (dependsOnIndex ?? []).map((i) => `subtask-${i}`) };
    }) };
  } else if (tool === 'update_tasks' && Array.isArray(args.taskIds)) {
    const { projectId, taskIds, set } = args as { projectId: string; taskIds: string[]; set: Record<string, unknown> };
    wireArgs = { projectId, tasks: taskIds.map((taskId) => ({ taskId, set })) };
  }
  let first = await mcpCallOnce(apiKey, wireTool, wireArgs, effectiveSession, meta);
  // vitest-pool-workers reloads the bundle between files, breaking in-flight DO
  // stubs exactly once ("invalidating this Durable Object ... Please retry").
  if (first.isError && first.text.includes('invalidating this Durable Object')) {
    first = await mcpCallOnce(apiKey, wireTool, wireArgs, effectiveSession, meta);
  }
  if (!first.isError && unwrap) {
    const body = first.body as Record<string, unknown> | null;
    let value: unknown = body;
    if (unwrap === 'created') value = (body?.created as unknown[] | undefined)?.[0];
    if (unwrap === 'updated') value = (body?.results as unknown[] | undefined)?.[0];
    if (unwrap === 'attachment') {
      const attachment = (body?.results as Array<Record<string, unknown>> | undefined)?.[0];
      value = attachment?.resourceUri && !attachment.resource
        ? { ...attachment, resource: attachment.resourceUri }
        : attachment;
    }
    if (unwrap === 'projects') value = { projects: body?.projects };
    if (unwrap === 'intelligence') value = body?.intelligence;
    if (unwrap === 'comments') {
      const task = body?.task as { comments?: Array<{ status?: string }> } | undefined;
      value = { openComments: (task?.comments ?? []).filter((comment) => comment.status === 'open' || comment.status === 'acknowledged') };
    }
    const item = value as { error?: string; ok?: boolean } | undefined;
    if (item?.error || item?.ok === false) return { ...first, isError: true, text: `Error: ${item.error ?? 'operation failed'}`, body: null };
    return { ...first, body: value };
  }
  return first;
}

async function mcpCallOnce(
  apiKey: string,
  tool: string,
  args: Record<string, unknown> = {},
  sessionId?: string,
  meta?: Record<string, unknown>,
) {
  const res = await SELF.fetch('https://noriq.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId ?? sessionFor(apiKey),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) },
    }),
  });
  const raw = await res.text();
  if (res.status !== 200) throw new Error(`mcp ${tool} → ${res.status}: ${raw}`);
  const message = parseRpcResponse(raw, res.headers.get('Content-Type') ?? '');
  if (message.error) throw new Error(`mcp ${tool} rpc error: ${JSON.stringify(message.error)}`);
  const text: string = message.result?.content?.[0]?.text ?? '';
  const isError = message.result?.isError === true;
  const [jsonPart, noticesPart] = text.split('\n\n--- notices ---\n');
  return {
    isError,
    text,
    body: isError ? null : safeParse(jsonPart ?? ''),
    notices: noticesPart ?? null,
  };
}

/** Raw JSON-RPC call (resources/read, resources/list, etc.) → parsed result. */
export async function mcpRpc(apiKey: string, method: string, params: Record<string, unknown> = {}) {
  const res = await SELF.fetch('https://noriq.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionFor(apiKey),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const raw = await res.text();
  if (res.status !== 200) throw new Error(`mcp ${method} → ${res.status}: ${raw}`);
  const message = parseRpcResponse(raw, res.headers.get('Content-Type') ?? '');
  if (message.error) throw new Error(`mcp ${method} rpc error: ${JSON.stringify(message.error)}`);
  return message.result;
}

/**
 * Like mcpCall but also returns every JSON-RPC *notification* (no `id`) the server
 * pushed on the POST SSE stream — used to assert live delivery (PLNR-54).
 */
export async function mcpCallStream(apiKey: string, tool: string, args: Record<string, unknown> = {}) {
  const res = await SELF.fetch('https://noriq.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionFor(apiKey),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  if (res.status !== 200) throw new Error(`mcp ${tool} → ${res.status}: ${raw}`);
  const frames = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  const notifications: any[] = [];
  let result: any = null;
  for (const d of frames) {
    try {
      const parsed = JSON.parse(d);
      if (parsed.id !== undefined) result = parsed;
      else if (parsed.method) notifications.push(parsed);
    } catch { /* skip */ }
  }
  return { result, notifications };
}

export async function mcpList(apiKey: string, sessionId?: string) {
  const res = await SELF.fetch('https://noriq.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId ?? sessionFor(apiKey),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/list', params: {} }),
  });
  const message = parseRpcResponse(await res.text(), res.headers.get('Content-Type') ?? '');
  return message.result?.tools as Array<{
    name: string;
    description: string;
    inputSchema: { properties?: Record<string, unknown> };
    annotations?: Record<string, unknown>;
  }>;
}

function parseRpcResponse(raw: string, contentType: string): any {
  if (contentType.includes('text/event-stream')) {
    // SSE: take the last data: line containing our response.
    const datas = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (const d of datas.reverse()) {
      try {
        const parsed = JSON.parse(d);
        if (parsed.id !== undefined) return parsed;
      } catch {
        /* skip */
      }
    }
    throw new Error(`no JSON-RPC response found in SSE stream: ${raw.slice(0, 400)}`);
  }
  return JSON.parse(raw);
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function loginSession(email: string, password: string): Promise<string> {
  const res = await SELF.fetch('https://noriq.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${await res.text()}`);
  const cookie = res.headers.get('Set-Cookie') ?? '';
  return cookie.split(';')[0] ?? '';
}

/**
 * Authorize an existing connection for every project its user can currently reach —
 * i.e. what a human does by re-running consent with all the boxes ticked.
 *
 * Needed because scoping (RUN-38) makes fixture ORDER matter in a way it never used to. A
 * token minted before a project exists is scoped to nothing, and only the token that CREATES
 * a project gains it; several suites mint their agents in beforeAll and create the shared
 * project afterwards, so the other agents are correctly — and newly — locked out. That is the
 * feature working, not a bug, so the fixtures say out loud that the human granted access
 * rather than having the old implicit "every token reaches everything" quietly restored.
 */
export async function authorizeForAllProjects(...apiKeys: string[]): Promise<void> {
  const db = (env as unknown as { DB: D1Database }).DB;
  for (const apiKey of apiKeys) {
    const hash = await sha256HexTest(apiKey);
    const tok = await db.prepare('SELECT id, user_id AS userId FROM oauth_tokens WHERE token_hash = ?')
      .bind(hash).first<{ id: string; userId: string }>();
    if (!tok) throw new Error('authorizeForAllProjects: unknown token');
    const { results } = await db.prepare(
      `SELECT p.id FROM projects p
       WHERE p.status = 'active' AND (p.owner_user_id = ?1
         OR EXISTS (
           SELECT 1 FROM project_grants pg
            WHERE pg.project_id = p.id AND pg.principal_type = 'user' AND pg.principal_id = ?1
         )
         OR EXISTS (
           SELECT 1 FROM project_grants pg
             JOIN user_groups ug ON ug.group_id = pg.principal_id
            WHERE pg.project_id = p.id AND pg.principal_type = 'group'
              AND ug.user_id = ?1 AND ug.status = 'accepted'
         ))`,
    ).bind(tok.userId).all<{ id: string }>();
    if (!results.length) continue;
    await db.batch(
      results.map((r) =>
        db.prepare('INSERT OR IGNORE INTO oauth_token_projects (token_id, project_id) VALUES (?, ?)').bind(tok.id, r.id),
      ),
    );
  }
}

async function sha256HexTest(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
