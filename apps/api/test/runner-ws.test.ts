// RUN-7: the /ws/runner/:id runtime channel (run.assigned/run.cancel + hello/
// heartbeat/run.status), the dispatch endpoint, and the steering-ack that dedups
// the MCP notices fallback.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RunnerHello, RunnerServerMessage } from '@noriq-dev/shared';
import type { MissionInventoryItem } from '@noriq-dev/shared';
import type { Actor, CreatePlanDispatchInput, PlanDispatchView } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { createAgent, createUser, loginSession, mcpCall, mintTokenForUser, authorizeForAllProjects } from './helpers';

// Resolve the next WS frame matching a predicate (with a timeout).
function nextFrame(ws: WebSocket, pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('frame timeout')); }, timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      let m: any; try { m = JSON.parse(ev.data as string); } catch { return; }
      if (pred(m)) { cleanup(); resolve(m); }
    };
    function cleanup() { clearTimeout(timer); ws.removeEventListener('message', onMsg); }
    ws.addEventListener('message', onMsg);
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitRunStatus(runId: string, want: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>();
    if (r?.status === want) return;
    await sleep(25);
  }
  throw new Error(`run ${runId} never reached ${want}`);
}

type RunRowPeek = {
  status: string; phase: string | null;
  tokens_used: number | null; usd_spent: number | null; log_tail: string | null; model_usage: string | null;
};
/** Poll the run row until `want` holds. WS frames are fire-and-forget into an async DO RPC,
 *  so there is no reply to await — the row is the only observable. */
async function pollRun(runId: string, want: (r: RunRowPeek) => boolean, tries = 40): Promise<RunRowPeek> {
  let last: RunRowPeek | null = null;
  for (let i = 0; i < tries; i++) {
    last = await env.DB.prepare(
      'SELECT status, phase, tokens_used, usd_spent, log_tail, model_usage FROM runs WHERE id = ?',
    ).bind(runId).first<RunRowPeek>();
    if (last && want(last)) return last;
    await sleep(25);
  }
  throw new Error(`run ${runId} never matched — last: ${JSON.stringify(last)}`);
}

describe('runner protocol compatibility (PLNR-366)', () => {
  it('defaults capability fields for legacy v1 peers', () => {
    expect(RunnerHello.parse({ type: 'hello', protocol: 1, label: 'legacy' }).protocolCapabilities).toEqual([]);
    expect(RunnerServerMessage.parse({
      type: 'registered', runnerId: 'run_legacy', protocol: 1, serverTime: new Date().toISOString(),
    })).toMatchObject({ acceptedCapabilities: [] });
  });
});

describe('runner WS channel + dispatch (RUN-7)', () => {
  let token: string;
  let cookie: string;
  let runnerId: string;
  let pid: string;

  beforeAll(async () => {
    await createUser('rws-owner@example.com', 'RWS Owner', 'longenough1', 'member').catch(() => {});
    token = await mintTokenForUser('rws-owner@example.com');
    cookie = await loginSession('rws-owner@example.com', 'longenough1');
    const p = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'RWSP', name: 'rwsp' }),
    });
    pid = ((await p.json()) as { id: string }).id;
    // The token was minted before this project existed, so it is scoped to nothing (RUN-38).
    // A human authorizing their runner does this on the consent page; do it explicitly here —
    // registration resolves repo keys only within the TOKEN's projects, so without it every
    // repo resolves to null and nothing is dispatchable.
    await authorizeForAllProjects(token);
    const reg = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'ws-daemon', tools: ['claude'], kinds: ['build'], maxConcurrency: 2, repos: [{ id: 'repo_x', projectKey: 'RWSP' }] }),
    });
    runnerId = ((await reg.json()) as { runner: { id: string } }).runner.id;
  }, 60000);

  const wsConnect = (id: string, headers: Record<string, string>) =>
    SELF.fetch(`https://noriq.test/ws/runner/${id}`, { headers: { Upgrade: 'websocket', ...headers } });

  const projectRoom = () => (env as unknown as Env).PROJECT_ROOM.get(
    (env as unknown as Env).PROJECT_ROOM.idFromName(pid),
  ) as unknown as {
    createPlan(projectId: string, actor: Actor, input: Record<string, unknown>): Promise<{ id: string }>;
    createPlanDispatch(projectId: string, actor: Actor, input: CreatePlanDispatchInput): Promise<PlanDispatchView>;
  };

  it('rejects the upgrade without a token (401) and for a non-owner (404)', async () => {
    expect((await wsConnect(runnerId, {})).status).toBe(401);
    await createUser('rws-other@example.com', 'Other', 'longenough1', 'member').catch(() => {});
    const otherToken = await mintTokenForUser('rws-other@example.com');
    expect((await wsConnect(runnerId, { Authorization: `Bearer ${otherToken}` })).status).toBe(404);
  });

  it('hello → registered, and dispatch pushes run.assigned; run.status transitions it', async () => {
    const res = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();

    const registered = nextFrame(ws, (m) => m.type === 'registered');
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, label: 'ws-daemon' }));
    expect((await registered).runnerId).toBe(runnerId);

    // Dispatch a brief; the run.assigned frame should arrive on the socket.
    const assignedP = nextFrame(ws, (m) => m.type === 'run.assigned');
    const disp = await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, kind: 'build', agentTool: 'claude', repoRef: 'repo_x', brief: 'do the thing' }),
    })).json() as { run: { id: string; status: string }; delivered: boolean };
    expect(disp.run.status).toBe('dispatched');
    expect(disp.delivered).toBe(true);
    const assigned = await assignedP;
    expect(assigned.run.id).toBe(disp.run.id);
    expect(assigned.run.brief).toBe('do the thing');
    // Capability negotiation is additive: old daemons receive the byte-compatible v1 frame,
    // without the new assignment field that their strict decoders do not know about.
    expect(assigned.run).not.toHaveProperty('execution');

    // Daemon reports the process came up → the Run transitions in its ProjectRoom.
    ws.send(JSON.stringify({ type: 'run.status', runId: disp.run.id, status: 'running', at: new Date(0).toISOString() }));
    await waitRunStatus(disp.run.id, 'running');
  });

  it('negotiates orchestration assignments and accepts idempotent execution reports', async () => {
    const res = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();

    const registeredP = nextFrame(ws, (m) => m.type === 'registered');
    ws.send(JSON.stringify({
      type: 'hello', protocol: 1, label: 'ws-daemon',
      protocolCapabilities: ['orchestration.v1'],
    }));
    const registered = await registeredP;
    expect(registered.acceptedCapabilities).toEqual(['orchestration.v1']);

    const brief = `orchestration protocol ${crypto.randomUUID()}`;
    const assignedP = nextFrame(ws, (m) => m.type === 'run.assigned' && m.run?.brief === brief);
    const disp = await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, kind: 'build', agentTool: 'claude', repoRef: 'repo_x', brief }),
    })).json() as { run: { id: string; execution: null | { orchestrationId: string; executionId: string } } };
    const assigned = await assignedP;
    expect(assigned.run.execution).toMatchObject({
      schemaVersion: 1,
      orchestrationId: expect.any(String),
      executionId: expect.any(String),
      role: 'worker',
    });
    expect(disp.run.execution).toEqual(assigned.run.execution);

    // The polling transport exposes the exact same server-derived assignment. It accepts no
    // client project/task/plan fields, so a daemon cannot widen the scope it was dispatched into.
    const polled = await SELF.fetch(`https://noriq.test/api/runs/${disp.run.id}/orchestration`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(polled.status).toBe(200);
    expect((await polled.json() as { assignment: unknown }).assignment).toEqual(assigned.run.execution);

    const observedAt = new Date().toISOString();
    const declaration = {
      reportId: `report-${crypto.randomUUID()}`,
      parentExecutionId: assigned.run.execution.executionId,
      localNodeKey: 'build-stage',
      kind: 'stage', role: 'worker', stage: 'build', step: null, gateId: null,
      continuesExecutionId: null, observedAt,
    };
    const declaredP = nextFrame(ws, (m) => m.type === 'execution.ack' && m.ack?.reportId === declaration.reportId);
    ws.send(JSON.stringify({ type: 'execution.declare', runId: disp.run.id, declaration }));
    const declared = await declaredP;
    expect(declared.ack).toMatchObject({ accepted: true, executionId: expect.any(String) });

    const restDeclaration = {
      ...declaration,
      reportId: `rest-${crypto.randomUUID()}`,
      localNodeKey: 'test-stage',
      stage: 'test',
    };
    const restDeclared = await SELF.fetch(`https://noriq.test/api/runs/${disp.run.id}/executions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(restDeclaration),
    });
    expect(restDeclared.status).toBe(200);
    expect(await restDeclared.json()).toMatchObject({ created: true, id: expect.any(String) });

    const event = {
      reportId: `event-${crypto.randomUUID()}`,
      executionId: declared.ack.executionId,
      revision: 1, event: 'started', observedAt, reason: null,
    };
    const startedP = nextFrame(ws, (m) => m.type === 'execution.ack' && m.ack?.reportId === event.reportId);
    ws.send(JSON.stringify({ type: 'execution.event', runId: disp.run.id, event }));
    expect((await startedP).ack).toMatchObject({
      accepted: true, executionId: declared.ack.executionId, status: 'running', expectedRevision: 2,
    });

    // Replaying the exact report is accepted without incrementing the node a second time.
    const replayP = nextFrame(ws, (m) => m.type === 'execution.ack' && m.ack?.reportId === event.reportId);
    ws.send(JSON.stringify({ type: 'execution.event', runId: disp.run.id, event }));
    expect((await replayP).ack).toMatchObject({ accepted: true, status: 'running', expectedRevision: 2 });

    const reconciliation = {
      reportId: `reconcile-${crypto.randomUUID()}`,
      declarations: [], relations: [], events: [], observedAt: new Date().toISOString(),
    };
    const reconciledP = nextFrame(ws, (m) => m.type === 'execution.ack' && m.ack?.reportId === reconciliation.reportId);
    ws.send(JSON.stringify({ type: 'execution.reconcile', runId: disp.run.id, reconciliation }));
    expect((await reconciledP).ack).toMatchObject({
      accepted: true, executionId: assigned.run.execution.executionId,
    });

    const treeRes = await SELF.fetch(
      `https://noriq.test/api/projects/${pid}/orchestrations/${assigned.run.execution.orchestrationId}`,
      { headers: { Cookie: cookie } },
    );
    expect(treeRes.status).toBe(200);
    const tree = await treeRes.json() as { nodes: Array<{ id: string; parentExecutionId: string | null; status: string }> };
    expect(tree.nodes).toContainEqual(expect.objectContaining({
      id: declared.ack.executionId,
      parentExecutionId: assigned.run.execution.executionId,
      status: 'running',
    }));
    const inventoryRes = await SELF.fetch(
      `https://noriq.test/api/projects/${pid}/orchestrations?view=active&limit=100`,
      { headers: { Cookie: cookie } },
    );
    expect(inventoryRes.status).toBe(200);
    const inventory = await inventoryRes.json() as { orchestrations: Array<{ id: string }>; page: { limit: number } };
    expect(inventory.orchestrations.map((item) => item.id)).toContain(assigned.run.execution.orchestrationId);
    expect(inventory.page.limit).toBe(100);

    const minted = await SELF.fetch(`https://noriq.test/api/runs/${disp.run.id}/agent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolCapabilities: ['orchestration.v1'] }),
    });
    expect(minted.status).toBe(200);
    expect(await minted.json()).toMatchObject({ execution: assigned.run.execution });
    ws.close();
  });

  it('reconciles a restarted mission and fences stale lifecycle frames by lease epoch (PLNR-486)', async () => {
    const registration = {
      runnerId,
      label: 'ws-daemon', tools: ['claude'], kinds: ['build'], maxConcurrency: 2,
      repos: [{
        id: 'repo_x', projectKey: 'RWSP',
        workflows: [{
          name: 'mission-plan', base: 'build', description: 'WS mission harness', capabilities: ['mission.v2'],
        }],
      }],
      protocolCapabilities: ['mission.v2'],
    };
    expect((await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(registration),
    })).status).toBe(200);

    const owner = await env.DB.prepare('SELECT owner_user_id AS id FROM runners WHERE id = ?')
      .bind(runnerId).first<{ id: string }>();
    const actor: Actor = { kind: 'human', id: owner!.id, name: 'RWS Owner' };
    const plan = await projectRoom().createPlan(pid, actor, {
      title: `WS mission ${crypto.randomUUID()}`,
      phases: [{ title: 'build', newTasks: [{ title: 'mission child' }] }],
    });

    const first = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    const ws = first.webSocket!;
    ws.accept();
    const registeredP = nextFrame(ws, (m) => m.type === 'registered');
    ws.send(JSON.stringify({
      type: 'hello', protocol: 1, label: 'ws-daemon',
      protocolCapabilities: ['orchestration.v1', 'mission.v2'],
    }));
    expect((await registeredP).acceptedCapabilities).toEqual(['orchestration.v1', 'mission.v2']);

    const assignedP = nextFrame(ws, (m) => m.type === 'run.assigned' && m.missionLease);
    const dispatch = await projectRoom().createPlanDispatch(pid, actor, {
      planId: plan.id, runnerId, repoRef: 'repo_x', agentTool: 'claude',
      strategy: 'single_root', workflow: 'mission-plan',
    });
    const assigned = await assignedP;
    const runId = assigned.run.id as string;
    expect(assigned.missionLease).toMatchObject({ sitting: 1, executionId: expect.any(String), epoch: 1 });
    expect(assigned.missionCommission).toMatchObject({
      digest: expect.any(String),
      snapshot: { runId, planId: plan.id, sitting: 1, tasks: [expect.objectContaining({ taskId: expect.any(String) })] },
    });
    expect(dispatch.strategy).toBe('single_root');

    // Mission lifecycle frames without the server lease retain byte compatibility in the
    // parser but are rejected before reaching ProjectRoom.
    ws.send(JSON.stringify({ type: 'run.status', runId, status: 'running', at: new Date().toISOString() }));
    await sleep(75);
    expect((await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>())?.status)
      .toBe('dispatched');
    ws.send(JSON.stringify({
      type: 'run.status', runId, status: 'running', missionLease: assigned.missionLease,
      at: new Date().toISOString(),
    }));
    await waitRunStatus(runId, 'running');
    ws.close();

    // Re-registration opens the durable adoption window. Hello returns the server inventory;
    // exact adoption advances the epoch before any further process effects are accepted.
    expect((await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(registration),
    })).status).toBe(200);
    const second = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    const resumed = second.webSocket!;
    resumed.accept();
    const reconciliationP = nextFrame(resumed, (m) => m.type === 'mission.reconcile.request');
    resumed.send(JSON.stringify({
      type: 'hello', protocol: 1, label: 'ws-daemon',
      protocolCapabilities: ['orchestration.v1', 'mission.v2'],
    }));
    const reconciliation = await reconciliationP as { items: MissionInventoryItem[] };
    expect(reconciliation.items).toEqual([expect.objectContaining({
      runId, lease: assigned.missionLease, commissionDigest: assigned.missionCommission.digest,
    })]);
    const resultP = nextFrame(resumed, (m) => m.type === 'mission.reconcile.result');
    resumed.send(JSON.stringify({
      type: 'mission.reconcile', inventory: reconciliation.items, observedAt: new Date().toISOString(),
    }));
    const result = await resultP;
    expect(result.results[0]).toMatchObject({
      runId, decision: 'adopt', lease: { ...assigned.missionLease, epoch: 2 }, reason: null,
    });

    resumed.send(JSON.stringify({
      type: 'run.status', runId, status: 'blocked', missionLease: assigned.missionLease,
      at: new Date().toISOString(),
    }));
    const spendBefore = await env.DB.prepare('SELECT tokens_used AS tokens FROM runs WHERE id = ?')
      .bind(runId).first<{ tokens: number }>();
    resumed.send(JSON.stringify({
      type: 'run.telemetry', runId, missionLease: assigned.missionLease,
      tokensUsed: 999, usdSpent: 999, logTail: null, phase: null,
    }));
    await sleep(75);
    expect((await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>())?.status)
      .toBe('running');
    expect((await env.DB.prepare('SELECT tokens_used AS tokens FROM runs WHERE id = ?')
      .bind(runId).first<{ tokens: number }>())?.tokens).toBe(spendBefore?.tokens);
    resumed.send(JSON.stringify({
      type: 'run.status', runId, status: 'blocked', missionLease: result.results[0].lease,
      at: new Date().toISOString(),
    }));
    await waitRunStatus(runId, 'blocked');
    resumed.close();
  });

  it('persists exact mission handoffs and replays authorized consumption after reconnect (PLNR-488)', async () => {
    const registration = {
      runnerId,
      label: 'ws-daemon', tools: ['claude'], kinds: ['build'], maxConcurrency: 2,
      repos: [{
        id: 'repo_x', projectKey: 'RWSP', repositoryKey: 'noriq',
        workflows: [{
          name: 'mission-plan', base: 'build', description: 'WS mission harness', capabilities: ['mission.v2'],
        }],
      }],
      protocolCapabilities: ['mission.v2', 'mission.handoff.v1'],
    };
    expect((await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(registration),
    })).status).toBe(200);
    const owner = await env.DB.prepare('SELECT owner_user_id AS id FROM runners WHERE id = ?')
      .bind(runnerId).first<{ id: string }>();
    const actor: Actor = { kind: 'human', id: owner!.id, name: 'RWS Owner' };
    const plan = await projectRoom().createPlan(pid, actor, {
      title: `WS handoff ${crypto.randomUUID()}`,
      phases: [{ title: 'build', newTasks: [{ title: 'mission child' }] }],
    });

    const first = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    const ws = first.webSocket!;
    ws.accept();
    const registeredP = nextFrame(ws, (m) => m.type === 'registered');
    ws.send(JSON.stringify({
      type: 'hello', protocol: 1, label: 'ws-daemon',
      protocolCapabilities: ['mission.v2', 'mission.handoff.v1'],
    }));
    expect((await registeredP).acceptedCapabilities).toEqual(['mission.v2', 'mission.handoff.v1']);

    const assignedP = nextFrame(ws, (m) => m.type === 'run.assigned' && m.missionLease);
    await projectRoom().createPlanDispatch(pid, actor, {
      planId: plan.id, runnerId, repoRef: 'repo_x', agentTool: 'claude',
      strategy: 'single_root', workflow: 'mission-plan',
    });
    const assigned = await assignedP;
    const handoff = {
      schemaVersion: 1, handoffId: `handoff-${crypto.randomUUID()}`, backend: 'opaque-vcs',
      repositoryKey: 'noriq', checkpoint: 'checkpoint-1', revision: 'revision-1', reference: 'reference-1',
    };
    const ackP = nextFrame(ws, (m) => m.type === 'mission.handoff.ack' && m.ack.reportId === 'publish-handoff');
    ws.send(JSON.stringify({
      type: 'mission.handoff.publish', runId: assigned.run.id, lease: assigned.missionLease,
      publication: { reportId: 'publish-handoff', handoff },
    }));
    expect((await ackP).ack).toMatchObject({ accepted: true, state: 'preserved_unlanded' });

    const read = await SELF.fetch(`https://noriq.test/api/runs/${assigned.run.id}/handoff`, {
      headers: { Cookie: cookie },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ handoff: { identity: handoff, state: 'preserved_unlanded' } });

    const stale = await SELF.fetch(`https://noriq.test/api/runs/${assigned.run.id}/handoff/consume`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...handoff, revision: 'stale-revision' }),
    });
    expect(stale.status).toBe(409);

    const consumedP = nextFrame(ws, (m) => m.type === 'mission.handoff.consumed');
    const consumed = await SELF.fetch(`https://noriq.test/api/runs/${assigned.run.id}/handoff/consume`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(handoff),
    });
    expect(consumed.status).toBe(200);
    const consumedBody = await consumed.json() as { handoff: { state: string; consumptionId: string } };
    expect(consumedBody.handoff).toMatchObject({ state: 'consumed_unlanded', consumptionId: expect.any(String) });
    expect((await consumedP).consumed).toMatchObject({
      runId: assigned.run.id, handoff, consumptionId: consumedBody.handoff.consumptionId,
    });

    const replayResponse = await SELF.fetch(`https://noriq.test/api/runs/${assigned.run.id}/handoff/consume`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(handoff),
    });
    expect((await replayResponse.json() as { handoff: { consumptionId: string } }).handoff.consumptionId)
      .toBe(consumedBody.handoff.consumptionId);
    ws.close();

    const second = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    const resumed = second.webSocket!;
    resumed.accept();
    const replayP = nextFrame(resumed, (m) => m.type === 'mission.handoff.consumed');
    resumed.send(JSON.stringify({
      type: 'hello', protocol: 1, label: 'ws-daemon',
      protocolCapabilities: ['mission.v2', 'mission.handoff.v1'],
    }));
    expect((await replayP).consumed).toMatchObject({
      runId: assigned.run.id, consumptionId: consumedBody.handoff.consumptionId,
    });
    resumed.close();
  });

  it('dispatch rejects a repoRef that does not resolve to the project', async () => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, kind: 'build', agentTool: 'claude', repoRef: 'nope' }),
    });
    expect(res.status).toBe(400);
  });

  it('cancel pushes run.cancel and marks the run cancelled', async () => {
    const res = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, label: 'ws-daemon' }));
    await nextFrame(ws, (m) => m.type === 'registered');

    const disp = await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, kind: 'build', agentTool: 'claude', repoRef: 'repo_x' }),
    })).json() as { run: { id: string } };

    const cancelP = nextFrame(ws, (m) => m.type === 'run.cancel');
    await SELF.fetch(`https://noriq.test/api/runs/${disp.run.id}/cancel`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'changed my mind' }),
    });
    const cancel = await cancelP;
    expect(cancel.runId).toBe(disp.run.id);
    const row = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(disp.run.id).first<{ status: string }>();
    expect(row!.status).toBe('cancelled');
  });

  it('the dashboard runs list (RUN-22) returns this project\'s runs to the owner, 404 to a non-owner', async () => {
    // Dispatch one so the list is non-empty, then read it back over the GET surface.
    const disp = await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, kind: 'build', agentTool: 'claude', repoRef: 'repo_x', brief: 'list me' }),
    })).json() as { run: { id: string } };

    const listed = await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, { headers: { Cookie: cookie } });
    expect(listed.status).toBe(200);
    const { runs } = (await listed.json()) as { runs: Array<{ id: string; projectId: string; repoRef: string }> };
    const mine = runs.find((r) => r.id === disp.run.id);
    expect(mine).toBeDefined();
    expect(mine!.projectId).toBe(pid);
    expect(mine!.repoRef).toBe('repo_x');

    // A user with no reach to this project is 404'd by the project-access middleware.
    const otherCookie = await loginSession('rws-other@example.com', 'longenough1');
    const denied = await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, { headers: { Cookie: otherCookie } });
    expect(denied.status).toBe(404);
  });

  it('persists live run.telemetry (RUN-22) and surfaces spend + log tail on the runs list', async () => {
    const res = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, label: 'ws-daemon' }));
    await nextFrame(ws, (m) => m.type === 'registered');

    const disp = await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, kind: 'build', agentTool: 'claude', repoRef: 'repo_x', brief: 'telemetry' }),
    })).json() as { run: { id: string } };
    const runId = disp.run.id;

    // Bring it live, then stream a non-transitional telemetry tick.
    ws.send(JSON.stringify({ type: 'run.status', runId, status: 'running', at: new Date(0).toISOString() }));
    await waitRunStatus(runId, 'running');
    ws.send(JSON.stringify({ type: 'run.telemetry', runId, tokensUsed: 8100, usdSpent: 0.42, logTail: 'compiling module A...\nok', at: new Date().toISOString() }));

    // Poll until the telemetry lands on the row (DO RPC is async).
    let row: { t: number | null; u: number | null; l: string | null } | null = null;
    for (let i = 0; i < 40; i++) {
      row = await env.DB.prepare('SELECT tokens_used AS t, usd_spent AS u, log_tail AS l FROM runs WHERE id = ?')
        .bind(runId).first<{ t: number | null; u: number | null; l: string | null }>();
      if (row?.t != null) break;
      await sleep(25);
    }
    expect(row!.t).toBe(8100);
    expect(row!.u).toBeCloseTo(0.42);
    expect(row!.l).toContain('compiling module A');
    // Telemetry must NOT mint a status transition — the run stays running.
    const st = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>();
    expect(st!.status).toBe('running');

    // And it comes back on the dashboard list projection.
    const listed = await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, { headers: { Cookie: cookie } })).json() as {
      runs: Array<{ id: string; tokensUsed: number | null; usdSpent: number | null; logTail: string | null }>;
    };
    const mine = listed.runs.find((r) => r.id === runId);
    expect(mine!.tokensUsed).toBe(8100);
    expect(mine!.usdSpent).toBeCloseTo(0.42);
    expect(mine!.logTail).toContain('ok');
    ws.close();
  });

  it('carries the run phase (RUN-31) without disturbing the spend, and clears it on terminal', async () => {
    const res = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, label: 'ws-daemon' }));
    await nextFrame(ws, (m) => m.type === 'registered');

    const disp = await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, kind: 'build', agentTool: 'claude', repoRef: 'repo_x', brief: 'phase' }),
    })).json() as { run: { id: string } };
    const runId = disp.run.id;

    ws.send(JSON.stringify({ type: 'run.status', runId, status: 'running', at: new Date(0).toISOString() }));
    await waitRunStatus(runId, 'running');
    // A spend tick, then a PHASE-ONLY tick — which is what entering the verify gate looks like:
    // the agent process is gone, so there is no new spend to report.
    ws.send(JSON.stringify({ type: 'run.telemetry', runId, tokensUsed: 5000, usdSpent: 0.25, logTail: 'built', at: new Date().toISOString() }));
    await pollRun(runId, (r) => r.tokens_used === 5000);
    ws.send(JSON.stringify({ type: 'run.telemetry', runId, phase: 'verifying', at: new Date().toISOString() }));
    const gated = await pollRun(runId, (r) => r.phase === 'verifying');

    // The whole point of COALESCE: a tick that says nothing about spend must not erase it.
    // Binding null directly here would blank the dashboard the moment the gate started.
    expect(gated.tokens_used).toBe(5000);
    expect(gated.usd_spent).toBeCloseTo(0.25);
    expect(gated.log_tail).toBe('built');
    expect(gated.status).toBe('running'); // a phase is not a status — liveness queries still match

    // Terminal ends the phase. The daemon cannot do this itself (its nulls mean "no news"),
    // so the DO — the thing that actually knows the run is over — has to.
    ws.send(JSON.stringify({ type: 'run.status', runId, status: 'done', at: new Date().toISOString() }));
    const finished = await pollRun(runId, (r) => r.status === 'done');
    expect(finished.phase).toBeNull(); // a done run that still reads "verifying" is worse than silent
    ws.close();
  });

  it('records the per-model mix as a tri-state: store, no-news keeps, {} explicitly clears (RUN-59)', async () => {
    const res = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, label: 'ws-daemon' }));
    await nextFrame(ws, (m) => m.type === 'registered');
    const disp = await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, kind: 'build', agentTool: 'claude', repoRef: 'repo_x', brief: 'mix' }),
    })).json() as { run: { id: string } };
    const runId = disp.run.id;
    ws.send(JSON.stringify({ type: 'run.status', runId, status: 'running', at: new Date(0).toISOString() }));
    await waitRunStatus(runId, 'running');

    // The authoritative breakdown — an opus run that actually spent on a haiku sub-agent.
    const mix = {
      'claude-opus-4-8': { inputTokens: 540, outputTokens: 93, cacheReadInputTokens: 40554, cacheCreationInputTokens: 5332, costUSD: 0.0761 },
      'claude-haiku-4-5': { inputTokens: 536, outputTokens: 23, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0004 },
    };
    ws.send(JSON.stringify({ type: 'run.telemetry', runId, tokensUsed: 1000, modelUsage: mix, at: new Date().toISOString() }));
    const stored = await pollRun(runId, (r) => r.model_usage != null);
    expect(JSON.parse(stored.model_usage!)['claude-haiku-4-5'].inputTokens).toBe(536);

    // A phase-only tick (no modelUsage) is no-news — the stored mix must survive it.
    ws.send(JSON.stringify({ type: 'run.telemetry', runId, phase: 'verifying', at: new Date().toISOString() }));
    const kept = await pollRun(runId, (r) => r.phase === 'verifying');
    expect(kept.model_usage).not.toBeNull(); // COALESCE-style keep, not a wipe

    // {} is the daemon retracting an unattributable mix — an EXPLICIT clear, stored as null.
    ws.send(JSON.stringify({ type: 'run.telemetry', runId, modelUsage: {}, at: new Date().toISOString() }));
    const cleared = await pollRun(runId, (r) => r.model_usage == null);
    expect(cleared.model_usage).toBeNull();

    // And the list projection parses it back to an object.
    ws.send(JSON.stringify({ type: 'run.telemetry', runId, modelUsage: mix, at: new Date().toISOString() }));
    await pollRun(runId, (r) => r.model_usage != null);
    const listed = await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/runs`, { headers: { Cookie: cookie } })).json() as {
      runs: Array<{ id: string; modelUsage: Record<string, { costUSD: number }> | null }>;
    };
    expect(listed.runs.find((r) => r.id === runId)?.modelUsage?.['claude-opus-4-8']?.costUSD).toBeCloseTo(0.0761);
    ws.close();
  });

  it('closes a live runner socket immediately when its account becomes read-only', async () => {
    const res = await wsConnect(runnerId, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, label: 'ws-daemon' }));
    await nextFrame(ws, (m) => m.type === 'registered');
    const owner = await env.DB.prepare("SELECT id FROM users WHERE email = 'rws-owner@example.com'").first<{ id: string }>();
    const closed = new Promise<CloseEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('runner socket did not close')), 3000);
      ws.addEventListener('close', (event) => { clearTimeout(timer); resolve(event); }, { once: true });
    });
    await env.DB.prepare("UPDATE users SET access_mode = 'read_only' WHERE id = ?").bind(owner!.id).run();
    ws.send(JSON.stringify({ type: 'ping' }));
    expect((await closed).code).toBe(1008);
    await env.DB.prepare("UPDATE users SET access_mode = 'read_write' WHERE id = ?").bind(owner!.id).run();
  });
});

describe('steering-ack dedups the notices fallback (RUN-7)', () => {
  it('a runtime-delivered steer is not re-surfaced via MCP notices; an un-acked one is', async () => {
    // A sends B two messages; only the first is acked as delivered-via-runner.
    const A = await createAgent('steer-sender');
    const B = await createAgent('steer-target');
    const mintCookie = await loginSession('agent-mint@example.com', 'longenough1');
    const p = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: mintCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'STEER', name: 'steer' }),
    });
    const pid = ((await p.json()) as { id: string }).id;
    // A and B were minted before this project existed, so their tokens are scoped to nothing
    // for it (RUN-38) — a human would authorize them on the consent page.
    await authorizeForAllProjects(A.apiKey, B.apiKey);

    // A runner + run owned by the mint user, so the steer-ack (agentAuth) authorizes.
    const reg = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${A.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'steer-daemon' }),
    });
    const runnerId = ((await reg.json()) as { runner: { id: string } }).runner.id;
    const runId = `run_steer_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      "INSERT INTO runs (id, project_id, runner_id, agent_id, kind, repo_ref, agent_tool, status, created_by) VALUES (?, ?, ?, ?, 'build', 'r', 'claude', 'running', ?)",
    ).bind(runId, pid, runnerId, B.id, A.id).run();

    const m1 = (await mcpCall(A.apiKey, 'send_message', { projectId: pid, toAgentId: B.id, body: 'STEER-ONE-acked' })).body;
    // Ack m1 as delivered over the runtime channel → suppress the notices fallback.
    const ack = await SELF.fetch(`https://noriq.test/api/runs/${runId}/steer-ack`, {
      method: 'POST', headers: { Authorization: `Bearer ${A.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: m1.id, agentId: B.id, via: 'runtime' }),
    });
    expect(((await ack.json()) as { suppressed: boolean }).suppressed).toBe(true);

    const m2 = (await mcpCall(A.apiKey, 'send_message', { projectId: pid, toAgentId: B.id, body: 'STEER-TWO-live' })).body;
    expect(m2.id).toBeTruthy();

    const updates = (await mcpCall(B.apiKey, 'my_updates')).body as { notices: string[] };
    const joined = updates.notices.join('\n');
    expect(joined).toContain('STEER-TWO-live');   // un-acked → surfaced
    expect(joined).not.toContain('STEER-ONE-acked'); // runtime-delivered → suppressed
  });
});

describe('WS steer → ack → notices dedup (RUN-17)', () => {
  async function waitDelivery(agentId: string, messageId: string, tries = 40) {
    for (let i = 0; i < tries; i++) {
      const r = await env.DB.prepare('SELECT 1 FROM runtime_deliveries WHERE agent_id = ? AND message_id = ?').bind(agentId, messageId).first();
      if (r) return;
      await sleep(25);
    }
    throw new Error('no runtime_delivery recorded');
  }

  it('POST /steer pushes over the socket; the daemon ack suppresses the source notice', async () => {
    const A = await createAgent('wsteer-sender');
    const B = await createAgent('wsteer-target');
    const mintCookie = await loginSession('agent-mint@example.com', 'longenough1');
    const p = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: mintCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'WSTR', name: 'wstr' }),
    });
    const pid = ((await p.json()) as { id: string }).id;
    // A and B were minted before this project existed, so their tokens are scoped to nothing
    // for it (RUN-38) — a human would authorize them on the consent page.
    await authorizeForAllProjects(A.apiKey, B.apiKey);
    const reg = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${A.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'wsteer-daemon' }),
    });
    const runnerId = ((await reg.json()) as { runner: { id: string } }).runner.id;
    const runId = `run_wsteer_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      "INSERT INTO runs (id, project_id, runner_id, agent_id, kind, repo_ref, agent_tool, status, created_by) VALUES (?, ?, ?, ?, 'build', 'r', 'claude', 'running', ?)",
    ).bind(runId, pid, runnerId, B.id, A.id).run();

    // Daemon connects its runner WS.
    const res = await SELF.fetch(`https://noriq.test/ws/runner/${runnerId}`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${A.apiKey}` } });
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, label: 'wsteer-daemon' }));
    await nextFrame(ws, (m) => m.type === 'registered');

    // A message A→B is the steer source.
    const src = (await mcpCall(A.apiKey, 'send_message', { projectId: pid, toAgentId: B.id, body: 'WS-STEER-acked' })).body;

    // Human steers the run via HTTP → server pushes a steer down the socket.
    const steerP = nextFrame(ws, (m) => m.type === 'steer');
    const steerRes = await SELF.fetch(`https://noriq.test/api/runs/${runId}/steer`, {
      method: 'POST', headers: { Cookie: mintCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'focus on auth', mode: 'soft', sourceMessageId: src.id }),
    });
    const { steerId, delivered } = (await steerRes.json()) as { steerId: string; delivered: boolean };
    expect(delivered).toBe(true);
    const steerFrame = await steerP;
    expect(steerFrame.steerId).toBe(steerId);
    expect(steerFrame.body).toBe('focus on auth');

    // Daemon injected it → acks delivered-via-runtime.
    ws.send(JSON.stringify({ type: 'steer.ack', runId, steerId, delivered: true, via: 'runtime', noticeCursor: null, detail: null, ackedAt: new Date(0).toISOString() }));
    await waitDelivery(B.id, src.id); // dedup row recorded

    // A second, un-steered message must still surface.
    await mcpCall(A.apiKey, 'send_message', { projectId: pid, toAgentId: B.id, body: 'WS-STEER-live' });
    const notices = ((await mcpCall(B.apiKey, 'my_updates')).body as { notices: string[] }).notices.join('\n');
    expect(notices).toContain('WS-STEER-live'); // not steered → surfaced
    expect(notices).not.toContain('WS-STEER-acked'); // steered + acked runtime → suppressed
  });
});
