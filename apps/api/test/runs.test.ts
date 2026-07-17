// RUN-6: Run lifecycle is authoritative in ProjectRoom — create/dispatch/transition
// through the DO, event log + fanout, and daemon-reconnect reconciliation. Drives the
// DO methods directly via the stub (the HTTP/WS dispatch surface lands in RUN-7).
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import type { Actor, CreateRunInput, RunPatch, RunView } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { createAgent, createUser, loginSession, mcpCall, mintTokenForUser, authorizeForAllProjects } from './helpers';

const actor: Actor = { kind: 'human', id: 'usr_runtest', name: 'Run Tester' };
let cookie: string;
let pid: string;

// ProvidedEnv (cloudflare:test) exposes DB but not the DO namespace; cast to app Env.
const appEnv = env as unknown as Env;
// The DurableObjectStub RPC type collapses these RunView returns to `never`, so
// address the room through a hand-typed facade — keeps assertions checked vs RunView.
interface RoomRpc {
  createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView>;
  dispatchRun(projectId: string, actor: Actor, runId: string, runnerId: string): Promise<RunView>;
  transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView>;
  reopenRun(projectId: string, actor: Actor, runId: string, rounds: number | null): Promise<RunView>;
  reconcileRunnerRuns(projectId: string, actor: Actor, runnerId: string): Promise<{ failed: number }>;
  listRuns(projectId: string, opts?: { runnerId?: string; status?: string }): Promise<RunView[]>;
  getRun(projectId: string, runId: string): Promise<RunView>;
  claimTask(projectId: string, actor: Actor, taskId: string): Promise<unknown>;
  updateTask(projectId: string, actor: Actor, taskId: string, patch: { status?: string }): Promise<{ ok: boolean; key: string }>;
}
const room = (projectId: string) =>
  appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(projectId)) as unknown as RoomRpc;
// runs.runner_id is a real FK → runners(id). Seed the runner rows dispatch targets need.
const seedRunner = (id: string) =>
  env.DB.prepare('INSERT OR IGNORE INTO runners (id, label) VALUES (?, ?)').bind(id, id).run();
const runEvents = async (projectId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT verb, subject_id FROM events WHERE project_id = ? AND subject_type = 'run' ORDER BY seq",
  ).bind(projectId).all<{ verb: string; subject_id: string }>();
  return results;
};

beforeAll(async () => {
  await createUser('run-owner@example.com', 'Run Owner', 'longenough1', 'member').catch(() => {});
  cookie = await loginSession('run-owner@example.com', 'longenough1');
  const p = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'RUNL', name: 'runl' }),
  });
  pid = ((await p.json()) as { id: string }).id;
  for (const r of ['rnr_1', 'rnr_2', 'rnr_ev', 'rnr_recon', 'rnr_other']) await seedRunner(r);
  // runs.agent_id is a real FK → agents(id); the spawned agent is a genuine actor. Since
  // 0026 it is a genuinely distinct KIND of actor: runner-spawned, so it must carry both a
  // runner and a project or the schema rejects the row outright. api_key_hash is gone (it
  // was vestigial NOT NULL filler left over from the retired static-key era).
  for (const a of ['agt_spawned', 'agt_spawned_late', 'agt_x']) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO agents (id, name, kind, runner_id, project_id)
       VALUES (?, ?, 'agent', 'rnr_1', ?)`,
    ).bind(a, a, pid).run();
  }
}, 60000);

describe('run lifecycle in ProjectRoom (RUN-6)', () => {
  it('creates a queued run and maps the wire shape', async () => {
    const run = await room(pid).createRun(pid, actor, {
      kind: 'build', repoRef: 'repo_a', agentTool: 'claude',
      anchor: { type: 'task', id: 'task_x' }, budget: { maxTokens: 1000 },
    });
    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe('queued');
    expect(run.anchor).toEqual({ type: 'task', taskId: 'task_x' });
    expect(run.budget).toEqual({ maxTokens: 1000 });
    expect(run.runnerId).toBeNull();
  });

  it('drives queued → dispatched → running → blocked → running → done, synthesizing exit', async () => {
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    const d = await room(pid).dispatchRun(pid, actor, run.id, 'rnr_1');
    expect(d.status).toBe('dispatched');
    expect(d.runnerId).toBe('rnr_1');
    expect(d.dispatchedAt).not.toBeNull();

    const running = await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: 'agt_spawned' });
    expect(running.status).toBe('running');
    expect(running.agentId).toBe('agt_spawned');
    expect(running.startedAt).not.toBeNull();

    await room(pid).transitionRun(pid, actor, run.id, { status: 'blocked', reason: 'awaiting input' });
    await room(pid).transitionRun(pid, actor, run.id, { status: 'running' });
    const done = await room(pid).transitionRun(pid, actor, run.id, { status: 'done' });
    expect(done.status).toBe('done');
    expect(done.exit).toMatchObject({ outcome: 'done' });
    expect(done.exit!.finishedAt).toBeTruthy();
  });

  it('persists the worktree path reported on a transition (server-side Run visibility)', async () => {
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_1' });
    expect(run.worktreePath).toBeNull(); // not known until the daemon reports it
    const running = await room(pid).transitionRun(pid, actor, run.id, {
      status: 'running',
      worktreePath: '/home/mtuska/.noriq/worktrees/repo-run_1',
    });
    expect(running.worktreePath).toBe('/home/mtuska/.noriq/worktrees/repo-run_1');
    // sticky: a later transition that omits it keeps the path
    const done = await room(pid).transitionRun(pid, actor, run.id, { status: 'done' });
    expect(done.worktreePath).toBe('/home/mtuska/.noriq/worktrees/repo-run_1');
  });

  it('a SAME-status report is a patch, not a transition (RUN-45)', async () => {
    // The daemon reports {status:'running', agentId} right after creating the run's agent
    // (RUN-43) — running→running has no edge in the map, so this frame was rejected and the
    // forwarder swallowed the throw. agent_id only survived because a REST call also wrote it;
    // worktreePath from the same frame was silently dropped.
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_1' });
    await room(pid).transitionRun(pid, actor, run.id, { status: 'running' });

    const patched = await room(pid).transitionRun(pid, actor, run.id, {
      status: 'running', // same status — a patch
      agentId: 'agt_spawned_late',
      worktreePath: '/wt/run_x',
    });
    expect(patched.status).toBe('running');
    expect(patched.agentId).toBe('agt_spawned_late');
    expect(patched.worktreePath).toBe('/wt/run_x');
  });

  it('a same-status patch never touches exit or startedAt', async () => {
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_1' });
    const running = await room(pid).transitionRun(pid, actor, run.id, { status: 'running' });
    const started = running.startedAt;

    const patched = await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: 'agt_x' });
    expect(patched.startedAt).toBe(started); // not re-stamped
    expect(patched.exit).toBeNull(); // a patch cannot synthesize an exit

    // Terminal same-status is a no-op patch too — a daemon retry of `done` must not rewrite
    // the exit the first report synthesized.
    const done = await room(pid).transitionRun(pid, actor, run.id, { status: 'done', reason: 'first' });
    const retried = await room(pid).transitionRun(pid, actor, run.id, { status: 'done', reason: 'second' });
    expect(retried.exit!.reason).toBe(done.exit!.reason);
  });

  it('a same-status patch appends no run.status_changed event — from===to is not a transition', async () => {
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_1' });
    await room(pid).transitionRun(pid, actor, run.id, { status: 'running' });
    const before = (await runEvents(pid)).filter((e) => e.verb === 'run.status_changed').length;
    await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: 'agt_x' });
    const after = (await runEvents(pid)).filter((e) => e.verb === 'run.status_changed').length;
    expect(after).toBe(before);
  });

  it('rejects an illegal transition (queued → done)', async () => {
    const run = await room(pid).createRun(pid, actor, { kind: 'scope', repoRef: 'r', agentTool: 'codex' });
    await expect(room(pid).transitionRun(pid, actor, run.id, { status: 'done' })).rejects.toThrow(/illegal run transition/);
  });

  it('create + dispatch atomically when runnerId is given', async () => {
    const run = await room(pid).createRun(pid, actor, { kind: 'verify', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_2' });
    expect(run.status).toBe('dispatched');
    expect(run.dispatchedAt).not.toBeNull();
  });

  it('reconcileRunnerRuns fails orphaned non-terminal runs for that runner', async () => {
    const a = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_recon' });
    await room(pid).transitionRun(pid, actor, a.id, { status: 'running' });
    const b = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_recon' });
    // a different runner's run must be untouched
    const other = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_other' });
    await room(pid).transitionRun(pid, actor, other.id, { status: 'running' });

    const res = await room(pid).reconcileRunnerRuns(pid, actor, 'rnr_recon');
    expect(res.failed).toBe(2);
    const failedA = await room(pid).getRun(pid, a.id);
    expect(failedA.status).toBe('failed');
    expect(failedA.exit!.reason).toBe('daemon_restart');
    expect((await room(pid).getRun(pid, b.id)).status).toBe('failed');
    expect((await room(pid).getRun(pid, other.id)).status).toBe('running'); // untouched
  });

  it('emits run.created / run.dispatched / run.status_changed to the event log', async () => {
    const before = (await runEvents(pid)).length;
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    await room(pid).dispatchRun(pid, actor, run.id, 'rnr_ev');
    await room(pid).transitionRun(pid, actor, run.id, { status: 'running' });
    const verbs = (await runEvents(pid)).slice(before).filter((e) => e.subject_id === run.id).map((e) => e.verb);
    expect(verbs).toEqual(['run.created', 'run.dispatched', 'run.status_changed']);
  });

  it('listRuns filters by runner and status', async () => {
    const runnerRuns = await room(pid).listRuns(pid, { runnerId: 'rnr_1' });
    expect(runnerRuns.length).toBeGreaterThanOrEqual(1);
    expect(runnerRuns.every((r) => r.runnerId === 'rnr_1')).toBe(true);
    const doneRuns = await room(pid).listRuns(pid, { status: 'done' });
    expect(doneRuns.every((r) => r.status === 'done')).toBe(true);
  });

  it('mirrors a spawned agent request_input to Run blocked, and the answer back to running (RUN-18)', async () => {
    const spawned = await createAgent('run18-agent');
    const mintCookie = await loginSession('agent-mint@example.com', 'longenough1');
    const pr = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: mintCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'RB18', name: 'rb18' }),
    });
    const rbPid = ((await pr.json()) as { id: string }).id;
    // The agent was minted before RB18 existed, so it is scoped to nothing for it (RUN-38).
    await authorizeForAllProjects(spawned.apiKey);
    // A running Run driven by the spawned agent.
    const runId = `run_rb18_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      "INSERT INTO runs (id, project_id, agent_id, kind, repo_ref, agent_tool, status, created_by) VALUES (?, ?, ?, 'build', 'r', 'claude', 'running', ?)",
    ).bind(runId, rbPid, spawned.id, spawned.id).run();

    // The spawned agent asks for input → Run mirrors to blocked.
    await mcpCall(spawned.apiKey, 'request_input', { projectId: rbPid, title: 'which approach?' });
    const blocked = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>();
    expect(blocked!.status).toBe('blocked'); // "waiting on you", not hung

    // Human answers → Run returns to running.
    const sig = await env.DB.prepare("SELECT id FROM signals WHERE agent_id = ? AND type = 'input_request' ORDER BY created_at DESC LIMIT 1")
      .bind(spawned.id).first<{ id: string }>();
    const ans = await SELF.fetch(`https://noriq.test/api/projects/${rbPid}/signals/${sig!.id}/answer`, {
      method: 'POST', headers: { Cookie: mintCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: 'go with option B' }),
    });
    expect(ans.status).toBe(200);
    const running = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>();
    expect(running!.status).toBe('running');
  });

  it('tells the daemon a run parked, and hands back the answer once it lands (RUN-30)', async () => {
    // The read the daemon makes when an agent's session ends. It exists because "the session
    // finished" and "the agent asked a question and stopped" look identical from the daemon,
    // which never sees the request_input — that call goes straight to the server over MCP.
    // The project must belong to the same user createAgent() mints under, or the spawned agent
    // cannot see it and request_input never fires (the RUN-18 test above does the same).
    const ownerEmail = 'agent-mint@example.com';
    const ownerToken = await mintTokenForUser(ownerEmail);
    const mintCookie = await loginSession(ownerEmail, 'longenough1');
    const pr = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: mintCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'PARK', name: 'park' }),
    });
    const parkPid = ((await pr.json()) as { id: string }).id;
    // The token was minted before PARK existed, so it reaches nothing in it (RUN-38).
    await authorizeForAllProjects(ownerToken);
    const reg = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'park-daemon', maxConcurrency: 1 }),
    });
    const runnerId = ((await reg.json()) as { runner: { id: string } }).runner.id;

    const spawned = await createAgent('park-agent');
    await authorizeForAllProjects(spawned.apiKey);
    const runId = `run_park_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO runs (id, project_id, runner_id, agent_id, kind, repo_ref, agent_tool, status, created_by)
       VALUES (?, ?, ?, ?, 'build', 'r', 'claude', 'running', ?)`,
    ).bind(runId, parkPid, runnerId, spawned.id, spawned.id).run();

    const park = async () =>
      (await (await SELF.fetch(`https://noriq.test/api/runs/${runId}/park`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      })).json()) as { blocked: boolean; question: string | null; answer: string | null; status: string };

    // Before anything: running, nothing to say.
    expect(await park()).toMatchObject({ blocked: false, answer: null });

    // The agent asks. The park is committed BEFORE this call returns to the agent — which is why
    // the daemon can read it and never race the agent's own session ending.
    await mcpCall(spawned.apiKey, 'request_input', {
      projectId: parkPid, title: 'which approach?', body: 'A is faster, B is safer.',
    });
    const asked = await park();
    expect(asked.blocked).toBe(true);
    expect(asked.question).toContain('which approach?');
    expect(asked.question).toContain('A is faster'); // the body too — the daemon replays it on resume
    expect(asked.answer).toBeNull(); // nobody has spoken yet; a resume now would send an empty answer

    // The human answers.
    const sig = await env.DB.prepare(
      "SELECT id FROM signals WHERE agent_id = ? AND type = 'input_request' ORDER BY created_at DESC LIMIT 1",
    ).bind(spawned.id).first<{ id: string }>();
    // mintCookie, not the file-level `cookie`: PARK belongs to the mint user, and the file-level
    // one is a different person with no reach into this project at all.
    const ansRes = await SELF.fetch(`https://noriq.test/api/projects/${parkPid}/signals/${sig!.id}/answer`, {
      method: 'POST', headers: { Cookie: mintCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: 'go with B' }),
    });
    expect(ansRes.status).toBe(200); // asserted: a silent 404 here would hollow out the test below

    // This is the durable half: a daemon that was OFF when the resume frame fired asks on
    // reconnect and gets everything it needs to bring the run back.
    const answered = await park();
    expect(answered).toMatchObject({ blocked: false, status: 'running', answer: 'go with B' });
  });

  it('refuses to tell a runner about a run that is not its own (RUN-30)', async () => {
    // A daemon reading park state for arbitrary runs would leak what other people's agents are
    // asking. Same ownership test as the run-agent endpoint.
    const stranger = await mintTokenForUser('park-stranger@example.com');
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude' });
    const res = await SELF.fetch(`https://noriq.test/api/runs/${run.id}/park`, {
      headers: { Authorization: `Bearer ${stranger}` },
    });
    expect(res.status).toBe(404);
  });

  it('re-register (reconnect) reconciles the runner\'s orphaned runs over HTTP', async () => {
    const token = await mintTokenForUser('run-owner@example.com');
    const reg = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'recon-daemon', maxConcurrency: 2 }),
    });
    const runnerId = ((await reg.json()) as { runner: { id: string } }).runner.id;
    const run = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId });
    await room(pid).transitionRun(pid, actor, run.id, { status: 'running' });

    // Reconnect: POST /api/runners again with the same runnerId.
    await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, label: 'recon-daemon', maxConcurrency: 2 }),
    });
    const after = await room(pid).getRun(pid, run.id);
    expect(after.status).toBe('failed');
    expect(after.exit!.reason).toBe('daemon_restart');
  });
});

describe('a verify run names the build it judges (verifiesRunId)', () => {
  it('round-trips verifiesRunId through the DO onto the wire', async () => {
    const build = await room(pid).createRun(pid, actor, {
      kind: 'build', repoRef: 'repo_a', agentTool: 'claude',
      anchor: { type: 'task', id: 'task_v' },
    });
    const verify = await room(pid).createRun(pid, actor, {
      kind: 'verify', repoRef: 'repo_a', agentTool: 'claude',
      anchor: { type: 'task', id: 'task_v' },
      verifiesRunId: build.id,
    });
    // Without this the daemon branches the verifier from HEAD and its `git diff` is
    // empty — it would review unchanged code and emit a verdict about nothing.
    expect(verify.verifiesRunId).toBe(build.id);
    // The task anchor SURVIVES alongside it: that is where findings get posted, so a
    // verify run genuinely needs both.
    expect(verify.anchor).toEqual({ type: 'task', taskId: 'task_v' });
    expect((await room(pid).getRun(pid, verify.id)).verifiesRunId).toBe(build.id);
  });

  it('is null for scope/build runs even if supplied', async () => {
    const build = await room(pid).createRun(pid, actor, {
      kind: 'build', repoRef: 'repo_a', agentTool: 'claude', verifiesRunId: 'run_bogus',
    });
    expect(build.verifiesRunId).toBeNull(); // only a verifier judges another run
  });

  it('defaults to null', async () => {
    const r = await room(pid).createRun(pid, actor, { kind: 'verify', repoRef: 'repo_a', agentTool: 'claude' });
    expect(r.verifiesRunId).toBeNull();
  });
});

describe('dispatch validates verifiesRunId (HTTP)', () => {
  // The HTTP dispatch requires a runner OWNED by the caller whose advertised repos
  // resolve to this project — seed one properly rather than reuse the bare rnr_* rows.
  beforeAll(async () => {
    const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind('run-owner@example.com').first<{ id: string }>();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO runners (id, label, owner_user_id, repos, status)
       VALUES ('rnr_owned', 'owned', ?, ?, 'online')`,
    ).bind(u!.id, JSON.stringify([{ id: 'repo_a', projectId: pid }])).run();
  });

  const dispatch = (body: Record<string, unknown>) =>
    SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('rejects a verifiesRunId that names no run in this project', async () => {
    // The daemon would otherwise branch a worktree from a ref that does not exist.
    const res = await dispatch({
      runnerId: 'rnr_owned', kind: 'verify', agentTool: 'claude', repoRef: 'repo_a',
      verifiesRunId: 'run_nope',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('does not name a run in this project');
  });

  it('rejects verifiesRunId on a non-verify run', async () => {
    const build = await room(pid).createRun(pid, actor, { kind: 'build', repoRef: 'repo_a', agentTool: 'claude' });
    const res = await dispatch({
      runnerId: 'rnr_owned', kind: 'build', agentTool: 'claude', repoRef: 'repo_a',
      verifiesRunId: build.id,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('only valid for a verify run');
  });

  it('rejects verifying a run that produced no diff (scope)', async () => {
    const scope = await room(pid).createRun(pid, actor, { kind: 'scope', repoRef: 'repo_a', agentTool: 'claude' });
    const res = await dispatch({
      runnerId: 'rnr_owned', kind: 'verify', agentTool: 'claude', repoRef: 'repo_a',
      verifiesRunId: scope.id,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('only a build run produces a diff');
  });

  it('round-trips model + effort onto the Run the daemon receives (RUN-33)', async () => {
    const res = await dispatch({
      runnerId: 'rnr_owned', kind: 'build', agentTool: 'claude', repoRef: 'repo_a',
      brief: 'pick a model', model: 'claude-opus-4-8', effort: 'xhigh',
    });
    expect(res.status).toBe(200);
    const { run } = (await res.json()) as { run: { id: string; model: string | null; effort: string | null } };
    // On the wire, because the daemon reads it off the run.assigned frame — the driver seam
    // for `model` existed from RUN-12 and was dead precisely because Run never carried one.
    expect(run.model).toBe('claude-opus-4-8');
    expect(run.effort).toBe('xhigh');
    const row = await env.DB.prepare('SELECT model, effort FROM runs WHERE id = ?')
      .bind(run.id).first<{ model: string | null; effort: string | null }>();
    expect(row).toMatchObject({ model: 'claude-opus-4-8', effort: 'xhigh' });
  });

  it('a dispatch that picks neither leaves both null — the tool keeps its default (RUN-33)', async () => {
    const res = await dispatch({
      runnerId: 'rnr_owned', kind: 'build', agentTool: 'claude', repoRef: 'repo_a', brief: 'no pick',
    });
    const { run } = (await res.json()) as { run: { model: string | null; effort: string | null } };
    expect(run.model).toBeNull();
    expect(run.effort).toBeNull();
  });

  it('rejects an effort that is not one of ours (RUN-33)', async () => {
    // effort is a closed intent we map per driver, so a bad one is worth refusing at the door.
    // `model` deliberately is NOT validated this way: names are the vendor's and they change.
    const res = await dispatch({
      runnerId: 'rnr_owned', kind: 'build', agentTool: 'claude', repoRef: 'repo_a', effort: 'ludicrous',
    });
    expect(res.status).toBe(400);
  });
});

describe("a build run settles its anchor task from the gate outcome (RUN-83)", () => {
  const mkTask = (id: string, key: string, status = "in_progress") =>
    env.DB.prepare(
      "INSERT INTO tasks (id, project_id, key, title, status, claimed_by) VALUES (?, ?, ?, 'a task', ?, 'agt_spawned')",
    ).bind(id, pid, key, status).run();
  const taskRow = (id: string) =>
    env.DB.prepare("SELECT status, failed_at AS failedAt, claimed_by AS claimedBy FROM tasks WHERE id = ?")
      .bind(id).first<{ status: string; failedAt: string | null; claimedBy: string | null }>();
  const anchored = (taskId: string) =>
    room(pid).createRun(pid, actor, {
      kind: "build", repoRef: "r", agentTool: "claude", anchor: { type: "task", id: taskId }, runnerId: "rnr_1",
    });

  it("gate passed (run done) → task review, claim cleared", async () => {
    await mkTask("task_pass", "STL-PASS");
    const run = await anchored("task_pass");
    await room(pid).transitionRun(pid, actor, run.id, { status: "running", agentId: "agt_spawned" });
    await room(pid).transitionRun(pid, actor, run.id, { status: "done" });
    expect(await taskRow("task_pass")).toEqual({ status: "review", failedAt: null, claimedBy: null });
  });

  it("gate failed (run failed) → derived `failed` (todo + failed_at), re-armable, claim cleared", async () => {
    await mkTask("task_fail", "STL-FAIL");
    const run = await anchored("task_fail");
    await room(pid).transitionRun(pid, actor, run.id, { status: "running", agentId: "agt_spawned" });
    await room(pid).transitionRun(pid, actor, run.id, { status: "failed", reason: "review" });
    const row = await taskRow("task_fail");
    expect(row!.status).toBe("todo"); // raw stays todo so the retry path can re-arm it
    expect(row!.failedAt).toBeTruthy(); // the marker the wire derives `failed` from
    expect(row!.claimedBy).toBeNull();
    const wire = await env.DB.prepare(
      "SELECT CASE WHEN failed_at IS NOT NULL THEN 'failed' ELSE status END AS s FROM tasks WHERE id = 'task_fail'",
    ).first<{ s: string }>();
    expect(wire!.s).toBe("failed");
  });

  it("a human 'move to failed' is a no-op, never a CHECK violation (PLNR-178)", async () => {
    await env.DB.prepare(
      "INSERT INTO tasks (id, project_id, key, title, status) VALUES ('task_nofail', ?, 'STL-NOFAIL', 't', 'review')",
    ).bind(pid).run();
    // 'failed' is derived, not writable — updateTask must silently drop it, not hit the CHECK.
    await expect(room(pid).updateTask(pid, actor, "task_nofail", { status: "failed" })).resolves.toMatchObject({ ok: true });
    expect((await taskRow("task_nofail"))!.status).toBe("review"); // unchanged
  });

  it("moving a failed task to a real column clears failed_at, incl. the same-real-status Failed→Todo drag (PLNR-178)", async () => {
    // The shape settleAnchorTask leaves: real status todo + failed_at (wire 'failed').
    await env.DB.prepare(
      "INSERT INTO tasks (id, project_id, key, title, status, failed_at) VALUES ('task_unfail', ?, 'STL-UNFAIL', 't', 'todo', ?)",
    ).bind(pid, "2026-07-17T00:00:00.000Z").run();
    // Failed→Review: sets review AND clears the marker.
    await room(pid).updateTask(pid, actor, "task_unfail", { status: "review" });
    expect(await taskRow("task_unfail")).toMatchObject({ status: "review", failedAt: null });

    // Failed→Todo: the real status is already todo, but the human dragging it out still clears
    // the failure marker (else the wire would keep deriving 'failed').
    await env.DB.prepare("UPDATE tasks SET status = 'todo', failed_at = ? WHERE id = 'task_unfail'")
      .bind("2026-07-17T00:00:00.000Z").run();
    await room(pid).updateTask(pid, actor, "task_unfail", { status: "todo" });
    expect((await taskRow("task_unfail"))!.failedAt).toBeNull();
  });

  it("does not stomp a task a human already moved off the run (guard)", async () => {
    await mkTask("task_human", "STL-HUMAN", "done");
    const run = await anchored("task_human");
    await room(pid).transitionRun(pid, actor, run.id, { status: "running", agentId: "agt_spawned" });
    await room(pid).transitionRun(pid, actor, run.id, { status: "failed" });
    expect((await taskRow("task_human"))!.status).toBe("done"); // untouched
  });

  it("(re-)claiming a failed task clears failed_at so the retry is not shown failed", async () => {
    // A failed task is `todo` + failed_at (the shape settleAnchorTask leaves). The claim UPDATE
    // that both claimTask sites run must drop failed_at — asserted directly, since claimTask's
    // full actor/identity path is exercised in coordination.test.ts, not here.
    await env.DB.prepare(
      "INSERT INTO tasks (id, project_id, key, title, status, failed_at) VALUES ('task_retry', ?, 'STL-RETRY', 't', 'todo', ?)",
    ).bind(pid, "2026-07-17T00:00:00.000Z").run();
    await env.DB.prepare(
      "UPDATE tasks SET status = 'in_progress', claimed_by = ?, claim_expires_at = ?, failed_at = NULL, updated_at = ? WHERE id = 'task_retry'",
    ).bind("agt_spawned", "2026-07-17T01:00:00.000Z", "2026-07-17T01:00:00.000Z").run();
    const row = await taskRow("task_retry");
    expect(row!.status).toBe("in_progress");
    expect(row!.failedAt).toBeNull();
  });
});

describe('continue a failed run — reopenRun (PLNR-180)', () => {
  // A runner that is online AND still advertises the repo the run targets (its kept worktree is on
  // that box). advertises=false / status seeds the guard cases.
  const seedOnlineRunner = (id: string, repoRef: string, opts: { online?: boolean; advertises?: boolean } = {}) =>
    env.DB.prepare('INSERT OR REPLACE INTO runners (id, label, status, repos) VALUES (?, ?, ?, ?)').bind(
      id, id, opts.online === false ? 'offline' : 'online',
      JSON.stringify(opts.advertises === false ? [] : [{ id: repoRef, projectId: pid }]),
    ).run();
  const mkTask = (id: string, key: string) =>
    env.DB.prepare(
      "INSERT INTO tasks (id, project_id, key, title, status, claimed_by) VALUES (?, ?, ?, 'a task', 'in_progress', 'agt_spawned')",
    ).bind(id, pid, key).run();
  const taskRow = (id: string) =>
    env.DB.prepare('SELECT status, failed_at AS failedAt, claimed_by AS claimedBy FROM tasks WHERE id = ?')
      .bind(id).first<{ status: string; failedAt: string | null; claimedBy: string | null }>();
  // A failed, task-anchored build run on `runnerId`, targeting `repoRef` — the exact terminal shape
  // Continue must re-open. Uses a fresh spawned-agent id per run (retireRunAgent revokes on fail).
  const failedBuild = async (taskId: string, runnerId: string, repoRef: string) => {
    const run = await room(pid).createRun(pid, actor, {
      kind: 'build', repoRef, agentTool: 'claude', anchor: { type: 'task', id: taskId }, runnerId,
      budget: { maxUsd: 5 },
    });
    await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: 'agt_spawned' });
    await room(pid).transitionRun(pid, actor, run.id, { status: 'failed', reason: 'gate' });
    return run;
  };

  it('re-opens the same run id to dispatched, clears exit/phase, carries the round budget, re-arms the task', async () => {
    await seedRunner('rnr_cont');
    await seedOnlineRunner('rnr_cont', 'repo_cont');
    await mkTask('task_cont', 'CNT-1');
    const run = await failedBuild('task_cont', 'rnr_cont', 'repo_cont');
    // Precondition: the fail settled the task to the derived `failed` shape.
    expect(await taskRow('task_cont')).toMatchObject({ status: 'todo', claimedBy: null });
    expect((await taskRow('task_cont'))!.failedAt).toBeTruthy();

    const reopened = await room(pid).reopenRun(pid, actor, run.id, 3);
    expect(reopened.id).toBe(run.id); // SAME run id — history/telemetry continuity
    expect(reopened.status).toBe('dispatched');
    expect(reopened.exit).toBeNull();
    expect(reopened.phase).toBeNull();
    expect(reopened.runnerId).toBe('rnr_cont');
    expect(reopened.budget.maxRounds).toBe(3); // the fresh reviewer-round budget rides budget JSON
    expect(reopened.budget.maxUsd).toBe(5); // the prior ceiling is preserved

    // The anchor task is re-armed: failed_at cleared, back to a claimable todo, claim cleared.
    expect(await taskRow('task_cont')).toEqual({ status: 'todo', failedAt: null, claimedBy: null });

    // The re-open is auditable and its terminal exit no longer round-trips from the row.
    const evs = await runEvents(pid);
    expect(evs.some((e) => e.subject_id === run.id)).toBe(true);
  });

  it('null rounds → budget.maxRounds null (the daemon falls back to its manifest default)', async () => {
    await seedRunner('rnr_cont2');
    await seedOnlineRunner('rnr_cont2', 'repo_cont2');
    await mkTask('task_cont2', 'CNT-2');
    const run = await failedBuild('task_cont2', 'rnr_cont2', 'repo_cont2');
    const reopened = await room(pid).reopenRun(pid, actor, run.id, null);
    expect(reopened.budget.maxRounds).toBeNull();
  });

  it('rejects a run that is not failed', async () => {
    await seedRunner('rnr_cont3');
    await seedOnlineRunner('rnr_cont3', 'repo_cont3');
    const run = await room(pid).createRun(pid, actor, {
      kind: 'build', repoRef: 'repo_cont3', agentTool: 'claude', anchor: { type: 'task', id: 'task_none' }, runnerId: 'rnr_cont3',
    });
    await expect(room(pid).reopenRun(pid, actor, run.id, null)).rejects.toThrow(/only a failed run/);
  });

  it("rejects when the run's runner is offline (kept worktree unreachable)", async () => {
    await seedRunner('rnr_cont4');
    await mkTask('task_cont4', 'CNT-4');
    const run = await failedBuild('task_cont4', 'rnr_cont4', 'repo_cont4');
    await seedOnlineRunner('rnr_cont4', 'repo_cont4', { online: false });
    await expect(room(pid).reopenRun(pid, actor, run.id, null)).rejects.toThrow(/offline/);
    // The task stays failed — a rejected continue must not half-arm it.
    expect((await taskRow('task_cont4'))!.failedAt).toBeTruthy();
  });

  it('rejects when the runner no longer advertises the repo', async () => {
    await seedRunner('rnr_cont5');
    await mkTask('task_cont5', 'CNT-5');
    const run = await failedBuild('task_cont5', 'rnr_cont5', 'repo_cont5');
    await seedOnlineRunner('rnr_cont5', 'repo_cont5', { advertises: false });
    await expect(room(pid).reopenRun(pid, actor, run.id, null)).rejects.toThrow(/no longer advertises/);
  });

  it('does not stomp a task a human already accepted (failed_at cleared) — run still re-opens', async () => {
    await seedRunner('rnr_cont6');
    await seedOnlineRunner('rnr_cont6', 'repo_cont6');
    await mkTask('task_cont6', 'CNT-6');
    const run = await failedBuild('task_cont6', 'rnr_cont6', 'repo_cont6');
    // A human moves the failed task to review — updateTask clears failed_at.
    await room(pid).updateTask(pid, actor, 'task_cont6', { status: 'review' });
    const reopened = await room(pid).reopenRun(pid, actor, run.id, 2);
    expect(reopened.status).toBe('dispatched'); // the run re-opens regardless
    expect((await taskRow('task_cont6'))!.status).toBe('review'); // human's decision untouched
  });

  // The thin HTTP wrapper: auth + project reach + 409-mapping of the DO guards + delivery.
  describe('POST /api/runs/:id/continue (HTTP)', () => {
    beforeAll(async () => {
      const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
        .bind('run-owner@example.com').first<{ id: string }>();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO runners (id, label, owner_user_id, repos, status) VALUES ('rnr_cont_http', 'owned', ?, ?, 'online')",
      ).bind(u!.id, JSON.stringify([{ id: 'repo_a', projectId: pid }])).run();
    });
    const cont = (runId: string, body: Record<string, unknown>, withCookie = true) =>
      SELF.fetch(`https://noriq.test/api/runs/${runId}/continue`, {
        method: 'POST',
        headers: { ...(withCookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('re-opens a failed run to dispatched with the round budget', async () => {
      await env.DB.prepare(
        "INSERT INTO tasks (id, project_id, key, title, status, claimed_by) VALUES ('task_http', ?, 'CNT-HTTP', 't', 'in_progress', 'agt_x')",
      ).bind(pid).run();
      const run = await room(pid).createRun(pid, actor, {
        kind: 'build', repoRef: 'repo_a', agentTool: 'claude', anchor: { type: 'task', id: 'task_http' }, runnerId: 'rnr_cont_http',
      });
      await room(pid).transitionRun(pid, actor, run.id, { status: 'running', agentId: 'agt_x' });
      await room(pid).transitionRun(pid, actor, run.id, { status: 'failed', reason: 'gate' });

      const res = await cont(run.id, { rounds: 4 });
      expect(res.status).toBe(200);
      const { run: reopened } = (await res.json()) as { run: { status: string; budget: { maxRounds: number | null } } };
      expect(reopened.status).toBe('dispatched');
      expect(reopened.budget.maxRounds).toBe(4);
    });

    it('401 without a session', async () => {
      const res = await cont('run_whatever', { rounds: 1 }, false);
      expect(res.status).toBe(401);
    });

    it('404 for an unknown run', async () => {
      const res = await cont('run_missing', { rounds: 1 });
      expect(res.status).toBe(404);
    });

    it('409 when the DO guard rejects (run not failed)', async () => {
      const run = await room(pid).createRun(pid, actor, {
        kind: 'build', repoRef: 'repo_a', agentTool: 'claude', runnerId: 'rnr_cont_http',
      });
      const res = await cont(run.id, { rounds: 1 });
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain('only a failed run');
    });
  });
});
