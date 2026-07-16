// RUN-35: a runner can be cut off, re-labelled, and pruned.
//
// Before this, a runner could be created and never removed, and nothing could stop one that had
// gone wrong. These tests care most about the two properties that make offboard mean something:
// it REVOKES (a flag with a live token in the wild accomplishes nothing), and it STICKS (a
// decision that evaporates on the next reconnect is a pause button, not a kill switch).
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authorizeForAllProjects, createUser, loginSession, mintPairForUser, mintTokenForUser } from './helpers';

let token: string;
let cookie: string;

const register = (tok: string, body: unknown) =>
  SELF.fetch('https://noriq.test/api/runners', {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const offboard = (id: string) =>
  SELF.fetch(`https://noriq.test/api/runners/${id}/offboard`, { method: 'POST', headers: { Cookie: cookie } });
const del = (id: string) =>
  SELF.fetch(`https://noriq.test/api/runners/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
const list = async () =>
  ((await (await SELF.fetch('https://noriq.test/api/runners', { headers: { Cookie: cookie } })).json()) as {
    runners: Array<{ id: string; status: string; label: string; offboardedAt: string | null }>;
  }).runners;

beforeAll(async () => {
  await createUser('lifecycle@example.com', 'Lifecycle', 'longenough1', 'member').catch(() => {});
  token = await mintTokenForUser('lifecycle@example.com');
  cookie = await loginSession('lifecycle@example.com', 'longenough1');
  await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'LIFE', name: 'lifecycle' }),
  });
  await authorizeForAllProjects(token);
}, 60000);

describe('runner offboard (RUN-35)', () => {
  it('revokes the token — offboard is a stop, not a flag', async () => {
    const id = ((await (await register(token, { label: 'doomed' })).json()) as { runner: { id: string } }).runner.id;
    const res = await offboard(id);
    expect(res.status).toBe(200);
    expect((await res.json()) as { tokenRevoked: boolean }).toMatchObject({ tokenRevoked: true });

    // The token is dead for EVERYTHING it could do, which is the point: no register, no
    // heartbeat, no MCP. A runner marked gone while its credential still works stops nothing.
    expect((await register(token, { label: 'retry' })).status).toBe(401);
    const hb = await SELF.fetch(`https://noriq.test/api/runners/${id}/heartbeat`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ freeSlots: 1 }),
    });
    expect(hb.status).toBe(401);
  });

  it('kills the refresh token too — not a 7-day delay', async () => {
    // issueTokens puts the access AND refresh hashes on ONE row and revoked_at is per-row, so a
    // single revoke covers both. Worth driving through the real grant: an access token that
    // lapses in 7 days while its 90-day refresh still works would make offboard a postponement,
    // and a test that only reads a column would pass either way.
    await createUser('lifecycle-refresh@example.com', 'Refreshy', 'longenough1', 'member').catch(() => {});
    const { access, refresh } = await mintPairForUser('lifecycle-refresh@example.com');
    const id = ((await (await register(access, { label: 'refreshy' })).json()) as { runner: { id: string } }).runner.id;

    const saved = cookie;
    cookie = await loginSession('lifecycle-refresh@example.com', 'longenough1');
    await offboard(id);
    cookie = saved;

    const res = await SELF.fetch('https://noriq.test/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
    });
    expect(res.status).toBe(400); // the revoked row takes the refresh with it
  });

  it('sticks: re-authorizing and reconnecting cannot un-offboard it', async () => {
    // The property that makes it a kill switch. A human who later re-authorizes that box would
    // otherwise silently revive the runner by reconnecting, and the decision would evaporate.
    const t1 = await mintTokenForUser('lifecycle-sticky@example.com');
    const id = ((await (await register(t1, { label: 'sticky' })).json()) as { runner: { id: string } }).runner.id;
    const stickyCookie = await loginSession('lifecycle-sticky@example.com', 'longenough1');
    const saved = cookie;
    cookie = stickyCookie;
    await offboard(id);

    // A brand-new, perfectly valid token for the same human, re-registering the same runner id.
    const t2 = await mintTokenForUser('lifecycle-sticky@example.com');
    const again = await register(t2, { runnerId: id, label: 'sticky' });
    expect(again.status).toBe(403);
    expect(await again.text()).toContain('offboarded');
    cookie = saved;
  });

  it('shows as offboarded, outranking liveness', async () => {
    const id = ((await (await register(await mintTokenForUser('lifecycle@example.com'), { label: 'shown' })).json()) as
      { runner: { id: string } }).runner.id;
    await offboard(id);
    const found = (await list()).find((r) => r.id === id);
    // Fresh heartbeat, but a human stopped it — "stopped" must not read as "online" or, once
    // stale, as merely "crashed".
    expect(found!.status).toBe('offboarded');
    expect(found!.offboardedAt).toBeTruthy();
  });

  it('fails its live runs rather than stranding them', async () => {
    const t = await mintTokenForUser('lifecycle-runs@example.com');
    const rc = await loginSession('lifecycle-runs@example.com', 'longenough1');
    const p = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: rc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'LFRN', name: 'lifecycle-runs' }),
    });
    const pid = ((await p.json()) as { id: string }).id;
    await authorizeForAllProjects(t);
    const id = ((await (await register(t, { label: 'busy' })).json()) as { runner: { id: string } }).runner.id;
    const owner = (await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind('lifecycle-runs@example.com').first<{ id: string }>())!.id;
    await env.DB.prepare(
      `INSERT INTO runs (id, project_id, runner_id, kind, repo_ref, agent_tool, status, created_by)
       VALUES ('run_offb', ?, ?, 'build', 'r', 'claude', 'running', ?)`,
    ).bind(pid, id, owner).run();

    const saved = cookie;
    cookie = rc;
    const res = await offboard(id);
    cookie = saved;
    expect((await res.json()) as { failedRuns: number }).toMatchObject({ failedRuns: 1 });
    // Its daemon can no longer report, so a live Run would otherwise sit 'running' forever.
    const run = await env.DB.prepare("SELECT status FROM runs WHERE id = 'run_offb'").first<{ status: string }>();
    expect(run!.status).toBe('failed');
  });
});

describe('runner rename + prune (RUN-35)', () => {
  it('re-labels', async () => {
    const t = await mintTokenForUser('lifecycle@example.com');
    const id = ((await (await register(t, { label: 'before' })).json()) as { runner: { id: string } }).runner.id;
    const res = await SELF.fetch(`https://noriq.test/api/runners/${id}`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'after' }),
    });
    expect(res.status).toBe(200);
    expect((await list()).find((r) => r.id === id)!.label).toBe('after');
  });

  it('refuses to delete a live runner — you cannot make a runaway invisible', async () => {
    const t = await mintTokenForUser('lifecycle@example.com');
    const id = ((await (await register(t, { label: 'alive' })).json()) as { runner: { id: string } }).runner.id;
    const res = await del(id);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('offboard it first');
  });

  it('deletes a stray — the escape hatch for a duplicate nobody could remove', async () => {
    // POST /api/runners with no runnerId mints a new runner, so a wiped state file or a
    // copy-pasted curl quietly forks a duplicate identity. One exists in prod right now.
    const t = await mintTokenForUser('lifecycle@example.com');
    const id = ((await (await register(t, { label: 'stray' })).json()) as { runner: { id: string } }).runner.id;
    await offboard(id);
    expect((await del(id)).status).toBe(200);
    expect((await list()).find((r) => r.id === id)).toBeUndefined();
  });

  it('refuses to delete a runner that spawned agents — that is history, not clutter', async () => {
    // The 0026 CHECK (kind='agent' ⇒ runner_id NOT NULL) means there is no unlink-and-forget:
    // erasing the runner would erase who ran the work. Offboard is the answer for a real runner.
    const t = await mintTokenForUser('lifecycle@example.com');
    const id = ((await (await register(t, { label: 'historic' })).json()) as { runner: { id: string } }).runner.id;
    const owner = (await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind('lifecycle@example.com').first<{ id: string }>())!.id;
    const pid = (await env.DB.prepare("SELECT id FROM projects WHERE key = 'LIFE'").first<{ id: string }>())!.id;
    await env.DB.prepare(
      `INSERT INTO agents (id, name, kind, runner_id, project_id, user_id)
       VALUES ('agt_hist', 'agt_hist', 'agent', ?, ?, ?)`,
    ).bind(id, pid, owner).run();
    await offboard(id);
    const res = await del(id);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('history');
  });

  it('another user cannot touch your runner', async () => {
    const t = await mintTokenForUser('lifecycle@example.com');
    const id = ((await (await register(t, { label: 'mine' })).json()) as { runner: { id: string } }).runner.id;
    await createUser('lifecycle-intruder@example.com', 'Intruder', 'longenough1', 'member').catch(() => {});
    const saved = cookie;
    cookie = await loginSession('lifecycle-intruder@example.com', 'longenough1');
    expect((await offboard(id)).status).toBe(404);
    expect((await del(id)).status).toBe(404);
    cookie = saved;
  });
});
