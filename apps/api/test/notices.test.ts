// PLNR-25: notices policy — piggyback only what's urgent/relevant to THIS agent.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, authorizeForAllProjects } from './helpers';

let idle: { id: string; apiKey: string };
let busy: { id: string; apiKey: string };
let projectId: string;
let cookie: string;
const openedComments: string[] = [];

async function humanQuestion(pid: string, tid: string, body: string) {
  const res = await SELF.fetch(`https://noriq.test/api/projects/${pid}/tasks/${tid}/comments`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'question', body }),
  });
  if (res.status !== 200) throw new Error(`comment failed: ${await res.text()}`);
  const c = (await res.json()) as { id: string };
  openedComments.push(c.id);
}

// Unassigned open questions surface to every idle agent (by design), so resolve the
// ones this suite creates — otherwise they leak into other suites' idle agents.
afterAll(async () => {
  for (const id of openedComments) {
    await SELF.fetch(`https://noriq.test/api/projects/${projectId}/comments/${id}/resolve`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'addressed', reply: 'test cleanup' }),
    });
  }
});

beforeAll(async () => {
  idle = await createAgent('notices-idle');
  busy = await createAgent('notices-busy');
  await createUser('notices-human@example.com', 'Notices Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('notices-human@example.com', 'longenough1');
  const proj = await mcpCall(idle.apiKey, 'create_project', { key: 'NOTE', name: 'notices' });
  projectId = proj.body.id;
  // Scoping (RUN-38): these agents were minted before the project existed, so each token is
  // scoped to nothing and only the CREATOR gains the new project. A human would authorize them
  // for it — say so explicitly rather than let the old implicit "every token sees everything"
  // creep back in.
  await authorizeForAllProjects(idle.apiKey, busy.apiKey);

}, 60000);

describe('notices policy (PLNR-25)', () => {
  it('a brand-new session is not flooded with historical broadcasts', async () => {
    // Seed some project history (broadcasts) BEFORE the new agent exists.
    await mcpCall(idle.apiKey, 'send_message', { projectId, body: 'ancient broadcast one' });
    await mcpCall(idle.apiKey, 'send_message', { projectId, body: 'ancient broadcast two' });
    // A brand-new MCP session's FIRST call must not replay that history as notices.
    const first = await mcpCall(idle.apiKey, 'get_project', { projectId }, 'flood-fresh-session');
    expect(first.notices ?? '').not.toMatch(/ancient broadcast/);
  });

  it('a completed task no longer piggybacks a "done" notice on other agents', async () => {
    const t = await mcpCall(idle.apiKey, 'create_task', { projectId, title: 'finish me' });
    await mcpCall(busy.apiKey, 'claim_task', { projectId, taskId: t.body.id });
    await mcpCall(busy.apiKey, 'release_task', { projectId, taskId: t.body.id, toStatus: 'done' });

    // The idle agent takes any action; it must NOT be told "X is done".
    const upd = await mcpCall(idle.apiKey, 'get_project', { projectId });
    expect(upd.notices ?? '').not.toMatch(/is done/);
  });

  it('an unheld-task question reaches an IDLE agent on the piggyback', async () => {
    const t = await mcpCall(idle.apiKey, 'create_task', { projectId, title: 'nobody holds this' });
    await humanQuestion(projectId, t.body.id, 'who can take this?');
    // idle agent (holds nothing) → sees the unassigned question in its notices block.
    const upd = await mcpCall(idle.apiKey, 'get_project', { projectId });
    expect(upd.notices ?? '').toMatch(/who can take this|Unassigned/);
  });

  it('a heads-down agent is NOT interrupted by unheld-task questions on the piggyback', async () => {
    // busy holds a task of its own.
    const own = await mcpCall(busy.apiKey, 'create_task', { projectId, title: 'busy work' });
    await mcpCall(busy.apiKey, 'claim_task', { projectId, taskId: own.body.id });

    const other = await mcpCall(idle.apiKey, 'create_task', { projectId, title: 'unrelated unheld' });
    await humanQuestion(projectId, other.body.id, 'unrelated question for whoever');

    const upd = await mcpCall(busy.apiKey, 'get_task', { taskId: own.body.id });
    expect(upd.notices ?? '').not.toMatch(/unrelated question/);
  });
});
