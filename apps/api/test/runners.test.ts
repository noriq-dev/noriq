// RUN-5: runner registration + heartbeat + online/capacity, and the RUN-3
// key→projectId resolution scoped to what the owning user may reach.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createUser, loginSession, mintTokenForUser } from './helpers';

let ownerToken: string;
let ownerCookie: string;
let rnrxProjectId: string;

const createProject = (cookie: string, key: string, name: string) =>
  SELF.fetch('https://planar.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name }),
  });

const register = (token: string, body: unknown) =>
  SELF.fetch('https://planar.test/api/runners', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const heartbeat = (token: string, id: string, body: unknown) =>
  SELF.fetch(`https://planar.test/api/runners/${id}/heartbeat`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const listRunners = (cookie: string, q = '') =>
  SELF.fetch(`https://planar.test/api/runners${q}`, { headers: { Cookie: cookie } });

beforeAll(async () => {
  await createUser('runner-owner@example.com', 'Runner Owner', 'longenough1', 'member').catch(() => {});
  ownerToken = await mintTokenForUser('runner-owner@example.com');
  ownerCookie = await loginSession('runner-owner@example.com', 'longenough1');
  const p = await createProject(ownerCookie, 'RNRX', 'rnrx');
  rnrxProjectId = ((await p.json()) as { id: string }).id;
}, 60000);

describe('runners (RUN-5)', () => {
  it('rejects registration without an OAuth bearer', async () => {
    const res = await SELF.fetch('https://planar.test/api/runners', {
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
    expect(runner.capabilities).toEqual({ tools: ['claude', 'codex'], kinds: ['scope', 'build', 'verify'], maxConcurrency: 2 });
    const byId = Object.fromEntries(runner.repos.map((r: any) => [r.id, r]));
    expect(byId.repo_a.projectKey).toBe('RNRX'); // normalized
    expect(byId.repo_a.projectId).toBe(rnrxProjectId); // resolved
    expect(byId.repo_b.projectId).toBeNull(); // unresolved
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
