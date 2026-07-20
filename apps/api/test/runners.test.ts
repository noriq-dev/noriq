// RUN-5: runner registration + heartbeat + online/capacity, and the RUN-3
// key→projectId resolution scoped to what the owning user may reach.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createUser, loginSession, mintTokenForUser, authorizeForAllProjects } from './helpers';

let ownerToken: string;
let ownerCookie: string;
let rnrxProjectId: string;

const createProject = (cookie: string, key: string, name: string) =>
  SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name }),
  });

const register = (token: string, body: unknown) =>
  SELF.fetch('https://noriq.test/api/runners', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const heartbeat = (token: string, id: string, body: unknown) =>
  SELF.fetch(`https://noriq.test/api/runners/${id}/heartbeat`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const listRunners = (cookie: string, q = '') =>
  SELF.fetch(`https://noriq.test/api/runners${q}`, { headers: { Cookie: cookie } });

beforeAll(async () => {
  await createUser('runner-owner@example.com', 'Runner Owner', 'longenough1', 'member').catch(() => {});
  ownerToken = await mintTokenForUser('runner-owner@example.com');
  ownerCookie = await loginSession('runner-owner@example.com', 'longenough1');
  const p = await createProject(ownerCookie, 'RNRX', 'rnrx');
  rnrxProjectId = ((await p.json()) as { id: string }).id;
  // The token was minted before this project existed, so it is scoped to nothing (RUN-38).
  // A human authorizing their runner does this on the consent page; do it explicitly here —
  // registration resolves repo keys only within the TOKEN's projects, so without it every
  // repo resolves to null and nothing is dispatchable.
  await authorizeForAllProjects(ownerToken);
}, 60000);

describe('runners (RUN-5)', () => {
  it('rejects registration without an OAuth bearer', async () => {
    const res = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('registers, resolving repo keys only to projects the owner can reach', async () => {
    const res = await register(ownerToken, {
      label: 'montana-laptop',
      tools: ['claude', 'codex'], kinds: ['scope', 'build', 'verify'], maxConcurrency: 2,
      repos: [
        { id: 'repo_a', projectKey: 'rnrx' },   // lowercase → normalized + resolved
        { id: 'repo_b', projectKey: 'NOSUCH' },  // no such project → null
      ],
    });
    expect(res.status).toBe(200);
    const { runner } = (await res.json()) as { runner: any };
    expect(runner.id).toMatch(/^rnr_/);
    expect(runner.status).toBe('online');
    expect(runner.freeSlots).toBe(2);
    // A registration that sends no coordinate catalog (RUN-115) defaults `agents` to [] — the
    // dashboard picker falls back to free-text for an older runner.
    expect(runner.capabilities).toEqual({ tools: ['claude', 'codex'], kinds: ['scope', 'build', 'verify'], maxConcurrency: 2, agents: [] });
    const byId = Object.fromEntries(runner.repos.map((r: any) => [r.id, r]));
    expect(byId.repo_a.projectKey).toBe('RNRX'); // normalized
    expect(byId.repo_a.projectId).toBe(rnrxProjectId); // resolved
    expect(byId.repo_b.projectId).toBeNull(); // unresolved
  });

  it('reads the coordinate catalog + per-repo workflows and exposes them (RUN-115/121, PLNR-223)', async () => {
    const res = await register(ownerToken, {
      label: 'coords',
      tools: ['claude', 'codex'], kinds: ['build'], maxConcurrency: 1,
      // The per-tool coordinate menu the dashboard's agent picker reads.
      agents: [
        { tool: 'claude', models: ['claude-opus-4-8', 'claude-sonnet-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { tool: 'codex', models: ['gpt-5.6-codex'], efforts: ['low', 'medium', 'high'] },
      ],
      repos: [{ id: 'repo_wf', projectKey: 'rnrx', workflows: ['docs', 'triage'] }],
    });
    expect(res.status).toBe(200);
    const { runner } = (await res.json()) as { runner: any };
    // Coordinate catalog rode the capabilities read (stored in the JSON, no column).
    expect(runner.capabilities.agents).toEqual([
      { tool: 'claude', models: ['claude-opus-4-8', 'claude-sonnet-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { tool: 'codex', models: ['gpt-5.6-codex'], efforts: ['low', 'medium', 'high'] },
    ]);
    // The repo's custom workflow names survived resolution (the built-ins are implicit).
    const repo = runner.repos.find((r: any) => r.id === 'repo_wf');
    expect(repo.workflows).toEqual(['docs', 'triage']);
    expect(repo.projectId).toBe(rnrxProjectId); // still resolved as before

    // And they persist to the read side (GET /api/runners), not just the registration echo.
    const listed = (await (await listRunners(ownerCookie)).json()) as { runners: any[] };
    const fromList = listed.runners.find((r) => r.id === runner.id)!;
    expect(fromList.capabilities.agents).toHaveLength(2);
    expect(fromList.repos.find((r: any) => r.id === 'repo_wf').workflows).toEqual(['docs', 'triage']);
  });

  it('does not resolve a key for a project the owner cannot reach', async () => {
    await createUser('other-owner@example.com', 'Other', 'longenough1', 'member').catch(() => {});
    const otherCookie = await loginSession('other-owner@example.com', 'longenough1');
    await createProject(otherCookie, 'OTHR', 'othr'); // owned by the other user
    const res = await register(ownerToken, { label: 'l', repos: [{ id: 'r', projectKey: 'OTHR' }] });
    const { runner } = (await res.json()) as { runner: any };
    expect(runner.repos[0].projectId).toBeNull(); // owner can't reach OTHR → not resolved
  });

  it('heartbeat updates capacity; owner sees it, non-owner does not', async () => {
    const reg = await register(ownerToken, { label: 'hb', maxConcurrency: 3 });
    const { runner } = (await reg.json()) as { runner: any };
    expect(runner.freeSlots).toBe(3);

    expect((await heartbeat(ownerToken, runner.id, { freeSlots: 1 })).status).toBe(200);
    const listed = (await (await listRunners(ownerCookie)).json()) as { runners: any[] };
    const seen = listed.runners.find((r) => r.id === runner.id);
    expect(seen.freeSlots).toBe(1);
    expect(seen.status).toBe('online');

    // A different user's token cannot heartbeat this runner, and cannot see it.
    const otherToken = await mintTokenForUser('other-owner@example.com');
    expect((await heartbeat(otherToken, runner.id, { freeSlots: 9 })).status).toBe(404);
    const otherCookie = await loginSession('other-owner@example.com', 'longenough1');
    const otherList = (await (await listRunners(otherCookie)).json()) as { runners: any[] };
    expect(otherList.runners.find((r) => r.id === runner.id)).toBeUndefined();
  });

  it('re-register with runnerId re-binds the same row', async () => {
    const reg = await register(ownerToken, { label: 'orig', maxConcurrency: 1 });
    const id = ((await reg.json()) as { runner: any }).runner.id;
    const again = await register(ownerToken, { runnerId: id, label: 'renamed', maxConcurrency: 4 });
    const { runner } = (await again.json()) as { runner: any };
    expect(runner.id).toBe(id); // same row
    expect(runner.label).toBe('renamed');
    expect(runner.freeSlots).toBe(4);
  });

  it('derives offline when the heartbeat is stale', async () => {
    const reg = await register(ownerToken, { label: 'stale' });
    const id = ((await reg.json()) as { runner: any }).runner.id;
    // Backdate the heartbeat well past the TTL (no time-travel API in the harness).
    await env.DB.prepare("UPDATE runners SET last_heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(id).run();
    const listed = (await (await listRunners(ownerCookie)).json()) as { runners: any[] };
    expect(listed.runners.find((r) => r.id === id).status).toBe('offline');
  });
});

// --- the runner owns its agents' identity (RUN-43) -----------------------------------
/** Dig the tool result out of an MCP Streamable-HTTP (SSE) response body. */
function parseBriefing(raw: string): { you: { id: string; kind: string; name: string } } {
  const line = raw.split('\n').find((l) => l.startsWith('data: '))!;
  const msg = JSON.parse(line.slice(6)) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(msg.result.content[0]!.text);
}

/** One JSON-RPC call to /mcp, SSE-framed response parsed back to the raw message. */
async function mcpRpcRaw(token: string, method: string, params: unknown): Promise<unknown> {
  const res = await SELF.fetch('https://noriq.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  const line = (await res.text()).split('\n').find((l) => l.startsWith('data: '))!;
  return JSON.parse(line.slice(6));
}
/** Same, unwrapped to `result` for calls expected to succeed. */
async function mcpRpc(token: string, method: string, params: unknown): Promise<unknown> {
  return (await mcpRpcRaw(token, method, params) as { result: unknown }).result;
}

describe('run agent creation (RUN-43)', () => {
  const createAgentFor = (token: string, runId: string, body: unknown = {}) =>
    SELF.fetch(`https://noriq.test/api/runs/${runId}/agent`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** A dispatched run owned by `ownerToken`'s runner, straight into D1.
   *  Plain INSERT rather than INSERT OR IGNORE: a seed that half-writes must fail loudly
   *  here, not resurface later as a mystery 404 from the endpoint under test. (It did:
   *  `runs.created_by` is NOT NULL and OR IGNORE swallowed the violation.) */
  async function seedRun(runId: string, runnerId = 'rnr_agent'): Promise<void> {
    const owner = (await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind('runner-owner@example.com').first<{ id: string }>())!.id;
    await env.DB.prepare('INSERT OR IGNORE INTO runners (id, label, owner_user_id) VALUES (?, ?, ?)')
      .bind(runnerId, runnerId, owner).run();
    await env.DB.prepare(
      `INSERT INTO runs (id, project_id, runner_id, kind, repo_ref, agent_tool, status, created_by)
       VALUES (?, ?, ?, 'build', 'repo_a', 'claude', 'dispatched', ?)`,
    ).bind(runId, rnrxProjectId, runnerId, owner).run();
  }

  it('mints an agent bound to a token that can only be that agent', async () => {
    await seedRun('run_a43');
    const res = await createAgentFor(ownerToken, 'run_a43');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string; token: string; projectId: string; label: string };
    expect(body.agentId).toMatch(/^agt_/);
    expect(body.projectId).toBe(rnrxProjectId);

    // The identity exists BEFORE any process does — that is the whole point. It is a
    // runner-spawned agent, pinned to the run's project and owned by the runner.
    const row = await env.DB.prepare('SELECT kind, runner_id AS runnerId, project_id AS projectId, status FROM agents WHERE id = ?')
      .bind(body.agentId).first<{ kind: string; runnerId: string; projectId: string; status: string }>();
    expect(row).toMatchObject({ kind: 'agent', runnerId: 'rnr_agent', projectId: rnrxProjectId, status: 'active' });

    // The run now points at it, so the daemon never has to learn an agt_ by scraping output.
    const run = await env.DB.prepare('SELECT agent_id AS agentId FROM runs WHERE id = ?').bind('run_a43')
      .first<{ agentId: string }>();
    expect(run!.agentId).toBe(body.agentId);

    // The token IS that agent: no MCP session needed, and no session can move it.
    const mcp = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${body.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_briefing', arguments: {} } }),
    });
    expect(mcp.status).toBe(200);
    const briefing = parseBriefing(await mcp.text());
    expect(briefing.you.id).toBe(body.agentId);
    expect(briefing.you.kind).toBe('agent');
  });

  // RUN-47: the daemon declares its per-kind tool floor at agent creation, and the MCP
  // server advertises exactly that — no more "here are 28 tools" followed by a denial.
  it('advertises only the daemon-declared tool floor to the bound agent', async () => {
    await seedRun('run_a47');
    const floor = [
      'set_agent_identity', 'get_briefing', 'get_task', 'get_plans', 'post_comment',
      'read_open_comments', 'raise_alert', 'request_input', 'heartbeat',
    ];
    const res = await createAgentFor(ownerToken, 'run_a47', { allowedTools: floor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string; token: string };

    const listed = await mcpRpc(body.token, 'tools/list', {});
    const names = ((listed as { tools: Array<{ name: string }> }).tools).map((t) => t.name).sort();
    expect(names).toEqual([...floor].sort());

    // Below the floor → unknown on call, the same answer as the listing. The old behavior
    // (advertise, then deny on use) is what cost an agent a turn and us a bug report.
    const denied = await mcpRpcRaw(body.token, 'tools/call', { name: 'claim_task', arguments: { projectId: rnrxProjectId, taskId: 't' } });
    expect(JSON.stringify(denied)).toMatch(/not found|unknown tool/i);

    // Within the floor still works end to end.
    const briefingRes = await mcpRpcRaw(body.token, 'tools/call', { name: 'get_briefing', arguments: {} });
    const briefing = JSON.parse((briefingRes as { result: { content: Array<{ text: string }> } }).result.content[0]!.text);
    expect(briefing.you.id).toBe(body.agentId);
  });

  it('a run agent cannot restatus its task via update_task — the run outcome owns the move (PLNR-192)', async () => {
    // RUN-83 took release_task off the build floor so settleAnchorTask owns the move; but
    // update_task.status was the adjacent door — a builder self-moved its task to review, the
    // run then failed, and the settle guard left it stranded there. Copilots keep the override.
    await seedRun('run_p192');
    const body = (await (await createAgentFor(ownerToken, 'run_p192')).json()) as { agentId: string; token: string };
    await env.DB.prepare(
      "INSERT INTO tasks (id, project_id, key, title, status, claimed_by) VALUES ('task_p192', ?, 'RNRX-192', 't', 'in_progress', ?)",
    ).bind(rnrxProjectId, body.agentId).run();

    const refused = await mcpRpcRaw(body.token, 'tools/call', {
      name: 'update_task', arguments: { projectId: rnrxProjectId, taskId: 'task_p192', status: 'review' },
    });
    expect(JSON.stringify(refused)).toMatch(/run agents don't set task status/);
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = 'task_p192'").first<{ status: string }>();
    expect(row!.status).toBe('in_progress'); // unmoved

    // The rest of update_task stays open to it — only the status override is closed.
    const ok = await mcpRpcRaw(body.token, 'tools/call', {
      name: 'update_task', arguments: { projectId: rnrxProjectId, taskId: 'task_p192', priority: 1 },
    });
    expect(JSON.stringify(ok)).not.toMatch(/run agents don't set task status/);
    const after = await env.DB.prepare("SELECT priority FROM tasks WHERE id = 'task_p192'").first<{ priority: number }>();
    expect(after!.priority).toBe(1);
  });

  it('an agent created without a floor sees the full catalogue (pre-RUN-47 daemons)', async () => {
    await seedRun('run_a47b');
    const body = (await (await createAgentFor(ownerToken, 'run_a47b')).json()) as { token: string };
    const listed = await mcpRpc(body.token, 'tools/list', {});
    // Not pinned to an exact count — the catalogue grows. The point is it is NOT a floor.
    expect((listed as { tools: unknown[] }).tools.length).toBeGreaterThan(20);
  });

  it('refuses to issue a second credential for the same run', async () => {
    await seedRun('run_a43b');
    expect((await createAgentFor(ownerToken, 'run_a43b')).status).toBe(200);
    // Two live credentials for one run would mean two processes could act as one identity.
    expect((await createAgentFor(ownerToken, 'run_a43b')).status).toBe(409);
  });

  it('refuses a run belonging to someone else’s runner', async () => {
    await seedRun('run_a43c');
    const intruder = await mintTokenForUser('runner-intruder@example.com');
    expect((await createAgentFor(intruder, 'run_a43c')).status).toBe(404);
  });

  it('the run ending revokes the agent’s token — one run, one identity', async () => {
    await seedRun('run_a43d');
    const body = (await (await createAgentFor(ownerToken, 'run_a43d')).json()) as { agentId: string; token: string };

    const appEnv = env as unknown as { PROJECT_ROOM: DurableObjectNamespace };
    const stub = appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(rnrxProjectId)) as unknown as {
      transitionRun(p: string, a: unknown, r: string, patch: { status: string }): Promise<unknown>;
    };
    const sys = { kind: 'system', id: 'system', name: 'system' };
    await stub.transitionRun(rnrxProjectId, sys, 'run_a43d', { status: 'running' });
    await stub.transitionRun(rnrxProjectId, sys, 'run_a43d', { status: 'done' });

    // Left valid, this credential would outlive its run by the whole 7-day token TTL, with
    // no process, no supervision and no budget behind it.
    const after = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${body.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_briefing', arguments: {} } }),
    });
    expect(after.status).toBe(401);

    const row = await env.DB.prepare('SELECT status FROM agents WHERE id = ?').bind(body.agentId)
      .first<{ status: string }>();
    expect(row!.status).toBe('offline');
  });
});
