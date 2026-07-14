// RUN-7: the /ws/runner/:id runtime channel (run.assigned/run.cancel + hello/
// heartbeat/run.status), the dispatch endpoint, and the steering-ack that dedups
// the MCP notices fallback.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, mintTokenForUser } from './helpers';

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

describe('runner WS channel + dispatch (RUN-7)', () => {
  let token: string;
  let cookie: string;
  let runnerId: string;
  let pid: string;

  beforeAll(async () => {
    await createUser('rws-owner@example.com', 'RWS Owner', 'longenough1', 'member').catch(() => {});
    token = await mintTokenForUser('rws-owner@example.com');
    cookie = await loginSession('rws-owner@example.com', 'longenough1');
    const p = await SELF.fetch('https://planar.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'RWSP', name: 'rwsp' }),
    });
    pid = ((await p.json()) as { id: string }).id;
    const reg = await SELF.fetch('https://planar.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'ws-daemon', tools: ['claude'], kinds: ['build'], maxConcurrency: 2, repos: [{ id: 'repo_x', projectKey: 'RWSP' }] }),
    });
    runnerId = ((await reg.json()) as { runner: { id: string } }).runner.id;
  }, 60000);

  const wsConnect = (id: string, headers: Record<string, string>) =>
    SELF.fetch(`https://planar.test/ws/runner/${id}`, { headers: { Upgrade: 'websocket', ...headers } });

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
    const disp = await (await SELF.fetch(`https://planar.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, kind: 'build', agentTool: 'claude', repoRef: 'repo_x', brief: 'do the thing' }),
    })).json() as { run: { id: string; status: string }; delivered: boolean };
    expect(disp.run.status).toBe('dispatched');
    expect(disp.delivered).toBe(true);
    const assigned = await assignedP;
    expect(assigned.run.id).toBe(disp.run.id);
    expect(assigned.run.brief).toBe('do the thing');

    // Daemon reports the process came up → the Run transitions in its ProjectRoom.
    ws.send(JSON.stringify({ type: 'run.status', runId: disp.run.id, status: 'running', at: new Date(0).toISOString() }));
    await waitRunStatus(disp.run.id, 'running');
  });

  it('dispatch rejects a repoRef that does not resolve to the project', async () => {
    const res = await SELF.fetch(`https://planar.test/api/projects/${pid}/runs`, {
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

    const disp = await (await SELF.fetch(`https://planar.test/api/projects/${pid}/runs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, kind: 'build', agentTool: 'claude', repoRef: 'repo_x' }),
    })).json() as { run: { id: string } };

    const cancelP = nextFrame(ws, (m) => m.type === 'run.cancel');
    await SELF.fetch(`https://planar.test/api/runs/${disp.run.id}/cancel`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'changed my mind' }),
    });
    const cancel = await cancelP;
    expect(cancel.runId).toBe(disp.run.id);
    const row = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(disp.run.id).first<{ status: string }>();
    expect(row!.status).toBe('cancelled');
  });
});

describe('steering-ack dedups the notices fallback (RUN-7)', () => {
  it('a runtime-delivered steer is not re-surfaced via MCP notices; an un-acked one is', async () => {
    // A sends B two messages; only the first is acked as delivered-via-runner.
    const A = await createAgent('steer-sender');
    const B = await createAgent('steer-target');
    const mintCookie = await loginSession('agent-mint@example.com', 'longenough1');
    const p = await SELF.fetch('https://planar.test/api/projects', {
      method: 'POST', headers: { Cookie: mintCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'STEER', name: 'steer' }),
    });
    const pid = ((await p.json()) as { id: string }).id;

    // A runner + run owned by the mint user, so the steer-ack (agentAuth) authorizes.
    const reg = await SELF.fetch('https://planar.test/api/runners', {
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
    const ack = await SELF.fetch(`https://planar.test/api/runs/${runId}/steer-ack`, {
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
