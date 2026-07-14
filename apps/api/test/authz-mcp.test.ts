// PLNR-94 + 95: MCP reads/tools must be scoped to the agent's USER — an agent
// (even an admin's) never gets cross-tenant reach over MCP. Regressions for the
// attachment resource, next_claimable, read_open_comments, and attach_ref.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, mcpRpc } from './helpers';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let agent: { id: string; apiKey: string };
let myTaskKey: string;
let myAttUri: string;
let bobPid: string;
let bobTaskId: string;
let bobTaskKey: string;
let bobAttId: string;

beforeAll(async () => {
  agent = await createAgent('mcp-authz-agent');
  // The agent's own project + attachment (positive cases).
  const proj = await mcpCall(agent.apiKey, 'create_project', { key: 'MXAGT', name: 'mine' });
  const t = await mcpCall(agent.apiKey, 'create_task', { projectId: proj.body.id, title: 'mine' });
  myTaskKey = t.body.key;
  // Claim it so this file doesn't leave a claimable task in the shared mint-user
  // pool (createAgent mints all agents under one user) — otherwise it perturbs
  // other files' claimable/notice assertions (e.g. tasknotify.test.ts).
  await mcpCall(agent.apiKey, 'claim_task', { projectId: proj.body.id, taskId: t.body.id });
  const add = await mcpCall(agent.apiKey, 'add_attachment', {
    projectId: proj.body.id, taskId: t.body.id, filename: 'mine.png', data: PNG_B64, contentType: 'image/png',
  });
  myAttUri = add.body.resource;

  // A DIFFERENT user (Bob, over REST) with a private project the agent must never
  // reach. (createAgent mints every agent under one user, so a genuine cross-user
  // case needs a REST user here.)
  await createUser('mx-bob@example.com', 'MX Bob', 'longenough1').catch(() => {});
  const bobCookie = await loginSession('mx-bob@example.com', 'longenough1');
  const bp = await SELF.fetch('https://planar.test/api/projects', {
    method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'MXBOB', name: "Bob's" }),
  });
  bobPid = (await bp.json() as { id: string }).id;
  // Priority 4 so a cross-tenant next_claimable leak (if present) would sort first.
  const bt = await SELF.fetch(`https://planar.test/api/projects/${bobPid}/tasks`, {
    method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'bob task', priority: 4 }),
  });
  const btj = await bt.json() as { id: string; key: string };
  bobTaskId = btj.id; bobTaskKey = btj.key;
  // A human steering comment on Bob's task (what read_open_comments would leak).
  await SELF.fetch(`https://planar.test/api/projects/${bobPid}/tasks/${bobTaskId}/comments`, {
    method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'question', body: 'bob-only steering question' }),
  });
  const ba = await SELF.fetch(`https://planar.test/api/tasks/${bobTaskId}/attachments?filename=secret.txt`, {
    method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'text/plain' }, body: 'bob-secret-bytes',
  });
  bobAttId = (await ba.json() as { id: string }).id;
}, 60000);

describe('MCP attachment resource is user-scoped (PLNR-94)', () => {
  it("an agent cannot read another user's attachment by id", async () => {
    await expect(mcpRpc(agent.apiKey, 'resources/read', { uri: `noriq://attachment/${bobAttId}` }))
      .rejects.toThrow(/not found/);
  });

  it("resources/list does not enumerate another user's attachments", async () => {
    const list = await mcpRpc(agent.apiKey, 'resources/list', {});
    const uris = (list.resources as Array<{ uri: string }>).map((r) => r.uri);
    expect(uris).not.toContain(`noriq://attachment/${bobAttId}`);
  });

  it('an agent can still read its own attachment', async () => {
    const read = await mcpRpc(agent.apiKey, 'resources/read', { uri: myAttUri });
    expect(read.contents[0].blob).toBe(PNG_B64);
  });
});

describe('MCP coordination tools are user-scoped (PLNR-95)', () => {
  it("next_claimable (no projectId) never returns another user's task", async () => {
    const nc = await mcpCall(agent.apiKey, 'next_claimable', {});
    // Bob's task is priority 4 (would sort first if leaked); the agent must not see it.
    expect(nc.body.task?.projectId).not.toBe(bobPid);
  });

  it("read_open_comments rejects another user's task", async () => {
    const r = await mcpCall(agent.apiKey, 'read_open_comments', { taskId: bobTaskId });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });

  it("attach_ref rejects another user's task addressed by its guessable key", async () => {
    const r = await mcpCall(agent.apiKey, 'attach_ref', { taskId: bobTaskKey, kind: 'pr', ref: '1', url: 'https://evil.example/x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });

  it('attach_ref still works on the agent’s own task (and is routed through the DO)', async () => {
    const r = await mcpCall(agent.apiKey, 'attach_ref', { taskId: myTaskKey, kind: 'branch', ref: 'feat/x' });
    expect(r.isError).toBe(false);
    expect(r.body.ok).toBe(true);
    // The write now emits an event — it shows up on the task detail.
    const gt = await mcpCall(agent.apiKey, 'get_task', { taskId: myTaskKey });
    expect(gt.body.refs.some((x: { ref: string }) => x.ref === 'feat/x')).toBe(true);
  });
});
