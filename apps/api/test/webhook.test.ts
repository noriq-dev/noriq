// PLNR-104: the GitHub webhook must fail closed when GITHUB_WEBHOOK_SECRET is unset
// (an unauthenticated caller must never be able to flip task state), and its signature
// check must be constant-time. We call the worker's fetch handler directly so the secret
// can be toggled per-case — mutating the `cloudflare:test` env does NOT propagate to the
// worker isolate reached via SELF.fetch. The `ping` event returns before any DB access,
// so no fixtures are needed.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

type FetchEnv = Parameters<typeof worker.fetch>[1];

const WEBHOOK = 'https://noriq.test/api/webhooks/github';

async function signature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function callWebhook(secret: string | undefined, payload: string, headers: Record<string, string>): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload });
  const res = await worker.fetch(req, { ...env, GITHUB_WEBHOOK_SECRET: secret } as unknown as FetchEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('GitHub webhook auth (PLNR-104)', () => {
  const payload = JSON.stringify({ zen: 'ping' });
  const secret = 'wh-secret-under-test';

  it('fails closed with 501 when no secret is configured (no silent bypass)', async () => {
    const r = await callWebhook(undefined, payload, { 'X-GitHub-Event': 'ping' });
    expect(r.status).toBe(501);
  });

  it('rejects a request with no signature', async () => {
    const r = await callWebhook(secret, payload, { 'X-GitHub-Event': 'ping' });
    expect(r.status).toBe(401);
  });

  it('rejects a request with a wrong signature', async () => {
    const r = await callWebhook(secret, payload, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) });
    expect(r.status).toBe(401);
  });

  it('rejects a valid signature computed with the wrong secret', async () => {
    const sig = await signature('some-other-secret', payload);
    const r = await callWebhook(secret, payload, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sig });
    expect(r.status).toBe(401);
  });

  it('accepts a correctly-signed payload', async () => {
    const sig = await signature(secret, payload);
    const r = await callWebhook(secret, payload, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sig });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, ignored: 'ping' });
  });
});

// PLNR-226 follow-up: the claim guard in updateTask discriminates on `actor.kind === 'agent'`,
// which exempts `system` — written for the ask-flow/demo writers, but GitHub is a system actor
// too. A PR opening therefore moved a live run's claimed anchor to `review` underneath it, and
// `settleAnchorTask` (which only matches status IN ('in_progress','claimed')) could then no
// longer move its own task: a failed run left it parked in `review` as though it had passed.
describe('the webhook never restatuses a CLAIMED task (PLNR-226)', () => {
  const secret = 'wh-secret-under-test';
  const db = (env as unknown as { DB: D1Database }).DB;

  const prPayload = (key: string, state: 'open' | 'closed', merged: boolean) =>
    JSON.stringify({
      pull_request: { title: `${key} do the thing`, number: 7, state, merged, html_url: 'https://gh/pr/7', head: { ref: `feat/${key}` } },
    });

  const send = async (key: string, state: 'open' | 'closed', merged: boolean) => {
    const body = prPayload(key, state, merged);
    const sig = await signature(secret, body);
    return callWebhook(secret, body, { 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sig });
  };

  /** Seeds a project + (optionally) a holding agent, then the task. Both carry real FKs, so each
   *  step is verified rather than assumed — an OR IGNORE that silently skipped would otherwise
   *  surface later as an opaque FOREIGN KEY failure on the task insert. */
  const seed = async (id: string, key: string, status: string, claimedBy: string | null) => {
    await db.prepare("INSERT OR IGNORE INTO projects (id, key, name) VALUES ('prj_wh', 'WH', 'webhook')").run();
    const proj = await db.prepare("SELECT id FROM projects WHERE id = 'prj_wh'").first();
    if (!proj) throw new Error('fixture: project prj_wh was not created');
    if (claimedBy) {
      // Plain INSERT, not OR IGNORE: agents.name is globally UNIQUE and several columns are
      // NOT NULL, and OR IGNORE swallows both — the failure then reappears as an opaque FK
      // error on the task. Only skip when the row is genuinely already there (suite re-run).
      const existing = await db.prepare('SELECT id FROM agents WHERE id = ?').bind(claimedBy).first();
      if (!existing) {
        // A kind='agent' row is runner-owned by CHECK (0026) — it needs a runner to belong to.
        await db.prepare("INSERT OR IGNORE INTO runners (id, label, status, capabilities, repos) VALUES ('rnr_wh', 'rnr_wh', 'online', '{}', '[]')").run();
        await db.prepare("INSERT INTO agents (id, name, kind, runner_id, project_id) VALUES (?, ?, 'agent', 'rnr_wh', 'prj_wh')")
          .bind(claimedBy, claimedBy).run();
      }
    }
    await db.prepare('DELETE FROM task_refs WHERE task_id = ?').bind(id).run();
    await db.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
    await db.prepare(
      "INSERT INTO tasks (id, project_id, key, title, status, claimed_by) VALUES (?, 'prj_wh', ?, 'wh', ?, ?)",
    ).bind(id, key, status, claimedBy).run();
  };
  const statusOf = async (id: string) =>
    (await db.prepare('SELECT status FROM tasks WHERE id = ?').bind(id).first<{ status: string }>())?.status;

  it('leaves a claimed in_progress task alone when its PR opens', async () => {
    await seed('task_wh_held', 'WH-1', 'in_progress', 'agt_runner');
    expect((await send('WH-1', 'open', false)).status).toBe(200);
    // The run still owns it — settleAnchorTask must still find it in_progress when it finishes.
    expect(await statusOf('task_wh_held')).toBe('in_progress');
  });

  it('does not force a claimed task to done when its PR merges', async () => {
    await seed('task_wh_merge', 'WH-2', 'in_progress', 'agt_runner');
    expect((await send('WH-2', 'closed', true)).status).toBe(200);
    expect(await statusOf('task_wh_merge')).toBe('in_progress');
  });

  it('still reflects state on an UNCLAIMED task — the feature is not disabled', async () => {
    await seed('task_wh_free', 'WH-3', 'in_progress', null);
    expect((await send('WH-3', 'open', false)).status).toBe(200);
    expect(await statusOf('task_wh_free')).toBe('review');
  });

  it('records the PR ref even for a claimed task — only the status move is withheld', async () => {
    await seed('task_wh_ref', 'WH-4', 'in_progress', 'agt_runner');
    await send('WH-4', 'open', false);
    const ref = await db.prepare("SELECT state FROM task_refs WHERE task_id = ? AND kind = 'pr'")
      .bind('task_wh_ref').first<{ state: string }>();
    expect(ref?.state).toBe('open');
  });
});
