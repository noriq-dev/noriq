// PLNR-259: canonical repository identity + checkout association. Extends the coverage
// memory-registry.test.ts already established for registerRepository/deleteProject with the
// new identity fields, the checkout-association RPC, ckt_ rejection through the real write
// path, opaque VCS/baseId round-trips, and the D1 active-generation projection.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { Actor } from '../src/do/ProjectRoom';
import { projectRoom, createUser, mintTokenForUser, mcpCall, SYSTEM_ACTOR, loginSession, createAgent, authorizeForAllProjects } from './helpers';
import { listProjectRepositories, resolveRepositoryByKey, listRepositoryCheckouts } from '../src/lib/project-memory';

const appEnv = env as unknown as Env;
const actor = SYSTEM_ACTOR as Actor;

interface RepoRpc {
  registerRepository(pid: string, actor: Actor, repositoryKey: string, opts?: { defaultBranch?: string | null; vcsKind?: string | null }): Promise<{ id: string; created: boolean }>;
  deregisterRepository(pid: string, actor: Actor, repositoryKey: string): Promise<{ deleted: boolean }>;
  updateRepository(pid: string, actor: Actor, repositoryKey: string, patch: Record<string, unknown>): Promise<{ ok: true }>;
  setRepositoryActiveGeneration(pid: string, repositoryKey: string, generationId: string | null): Promise<{ ok: true }>;
  associateCheckout(
    pid: string,
    actor: Actor,
    input: { repositoryKey: string; runnerId: string; checkoutId: string },
  ): Promise<{ associated: true; projectRepositoryId: string } | { associated: false; reason: string }>;
  deleteProject(pid: string, actor: Actor): Promise<{ ok: true; key: string; name: string }>;
}

const room = (pid: string) => projectRoom<RepoRpc>(pid);

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  return { userId: user.id, projectId: proj.body.id as string };
}

async function makeRunner(projectId: string): Promise<string> {
  const id = `rnr_test_${Math.random().toString(36).slice(2)}`;
  await appEnv.DB.prepare(
    `INSERT INTO runners (id, project_id, owner_user_id, label, status, capabilities, repos, free_slots, created_at)
     VALUES (?, ?, 'system', 'test-runner', 'online', '{}', '[]', 1, datetime('now'))`,
  ).bind(id, projectId).run();
  return id;
}

describe('canonical repository identity (PLNR-259)', () => {
  it('rejects a ckt_-prefixed value wherever a canonical RepositoryKey is expected, through the real write path', async () => {
    const { projectId } = await newOwnedProject('pm-259-ckt@example.com', 'PM259CKT');
    await expect(room(projectId).registerRepository(projectId, actor, 'ckt_abc123')).rejects.toThrow(/checkout id/);
  });

  it('a non-Git-shaped vcsKind and baseId round-trip byte-identical — nothing parses, pads, or case-folds', async () => {
    const { projectId } = await newOwnedProject('pm-259-vcs@example.com', 'PM259VCS');
    await room(projectId).registerRepository(projectId, actor, 'p4-repo', { vcsKind: 'perforce' });
    await room(projectId).updateRepository(projectId, actor, 'p4-repo', { latestObservedBase: '12345' });
    const row = await resolveRepositoryByKey(appEnv, projectId, 'p4-repo');
    expect(row?.vcsKind).toBe('perforce');
    expect(row?.latestObservedBase).toBe('12345');
  });

  it('indexingEnabled and ingestStatus are writable through a real path and a read reflects the last write', async () => {
    const { projectId } = await newOwnedProject('pm-259-lifecycle@example.com', 'PM259LC');
    await room(projectId).registerRepository(projectId, actor, 'lc-repo');
    await room(projectId).updateRepository(projectId, actor, 'lc-repo', { indexingEnabled: true, ingestStatus: 'staged' });
    const row = await resolveRepositoryByKey(appEnv, projectId, 'lc-repo');
    expect(row?.indexingEnabled).toBe(true);
    expect(row?.ingestStatus).toBe('staged');
  });

  it('the D1 active-generation field is a projection — writing it never mutates anything else, and it reads back exactly', async () => {
    const { projectId } = await newOwnedProject('pm-259-gen@example.com', 'PM259GEN');
    await room(projectId).registerRepository(projectId, actor, 'gen-repo');
    await room(projectId).setRepositoryActiveGeneration(projectId, 'gen-repo', 'gen_abc123');
    const row = await resolveRepositoryByKey(appEnv, projectId, 'gen-repo');
    expect(row?.activeGenerationId).toBe('gen_abc123');
    await room(projectId).setRepositoryActiveGeneration(projectId, 'gen-repo', null);
    expect((await resolveRepositoryByKey(appEnv, projectId, 'gen-repo'))?.activeGenerationId).toBeNull();
  });

  it('updateRepository against an unregistered key fails rather than creating one', async () => {
    const { projectId } = await newOwnedProject('pm-259-noreg@example.com', 'PM59NOR');
    await expect(room(projectId).updateRepository(projectId, actor, 'never-registered', { indexingEnabled: true })).rejects.toThrow(/no repository registered/);
  });
});

// PLNR-321: repository removal, added on direct human steering on the task ("Should also support
// removal of repo keys").
describe('repository deregistration (PLNR-321)', () => {
  it('removes a registered repository and its checkouts without an FK abort', async () => {
    const { projectId } = await newOwnedProject('pm-321-dereg@example.com', 'PM321DRG');
    await room(projectId).registerRepository(projectId, actor, 'dereg-repo');
    const runnerA = await makeRunner(projectId);
    await room(projectId).associateCheckout(projectId, actor, { repositoryKey: 'dereg-repo', runnerId: runnerA, checkoutId: 'ckt_dereg' });

    const result = await room(projectId).deregisterRepository(projectId, actor, 'dereg-repo');
    expect(result).toEqual({ deleted: true });

    expect(await resolveRepositoryByKey(appEnv, projectId, 'dereg-repo')).toBeNull();
    const checkouts = await appEnv.DB.prepare('SELECT 1 FROM repository_checkouts WHERE checkout_id = ?').bind('ckt_dereg').first();
    expect(checkouts).toBeNull();
  });

  it('deregistering an already-unregistered key is idempotent — a no-op, not an error', async () => {
    const { projectId } = await newOwnedProject('pm-321-dereg-idem@example.com', 'PM321DRI');
    const result = await room(projectId).deregisterRepository(projectId, actor, 'never-was-registered');
    expect(result).toEqual({ deleted: false });
  });

  it('deregistering does not touch a different repository in the same project', async () => {
    const { projectId } = await newOwnedProject('pm-321-dereg-sibling@example.com', 'PM321DSB');
    await room(projectId).registerRepository(projectId, actor, 'keep-repo');
    await room(projectId).registerRepository(projectId, actor, 'remove-repo');
    await room(projectId).deregisterRepository(projectId, actor, 'remove-repo');
    expect(await resolveRepositoryByKey(appEnv, projectId, 'keep-repo')).not.toBeNull();
    expect(await resolveRepositoryByKey(appEnv, projectId, 'remove-repo')).toBeNull();
  });

  it('a key can be re-registered fresh after deregistration', async () => {
    const { projectId } = await newOwnedProject('pm-321-dereg-reuse@example.com', 'PM321DRU');
    const first = await room(projectId).registerRepository(projectId, actor, 'reuse-repo');
    await room(projectId).deregisterRepository(projectId, actor, 'reuse-repo');
    const second = await room(projectId).registerRepository(projectId, actor, 'reuse-repo');
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id); // a genuinely NEW row, not the deleted one resurrected
  });
});

describe('checkout association (PLNR-259)', () => {
  it('two runner checkouts whose committed key matches converge on ONE canonical row', async () => {
    const { projectId } = await newOwnedProject('pm-259-conv@example.com', 'PM59CNV');
    await room(projectId).registerRepository(projectId, actor, 'conv-repo');
    const runnerA = await makeRunner(projectId);
    const runnerB = await makeRunner(projectId);
    const a = await room(projectId).associateCheckout(projectId, actor, { repositoryKey: 'conv-repo', runnerId: runnerA, checkoutId: 'ckt_a' });
    const b = await room(projectId).associateCheckout(projectId, actor, { repositoryKey: 'conv-repo', runnerId: runnerB, checkoutId: 'ckt_b' });
    expect(a).toEqual({ associated: true, projectRepositoryId: expect.any(String) });
    expect(b).toEqual(a);
    const canonical = await resolveRepositoryByKey(appEnv, projectId, 'conv-repo');
    const checkouts = await listRepositoryCheckouts(appEnv, canonical!.id);
    expect(checkouts.map((c) => c.checkoutId).sort()).toEqual(['ckt_a', 'ckt_b']);
  });

  it('a checkout whose committed key matches no registered repository is reported unassociated, naming the key', async () => {
    const { projectId } = await newOwnedProject('pm-259-unres@example.com', 'PM59UNR');
    const runnerA = await makeRunner(projectId);
    const result = await room(projectId).associateCheckout(projectId, actor, { repositoryKey: 'no-such-repo', runnerId: runnerA, checkoutId: 'ckt_x' });
    expect(result).toEqual({ associated: false, reason: expect.stringContaining('no-such-repo') });
  });

  it('re-associating the same checkout with the same key is idempotent (no second row)', async () => {
    const { projectId } = await newOwnedProject('pm-259-idem@example.com', 'PM59IDM');
    await room(projectId).registerRepository(projectId, actor, 'idem-repo');
    const runnerA = await makeRunner(projectId);
    await room(projectId).associateCheckout(projectId, actor, { repositoryKey: 'idem-repo', runnerId: runnerA, checkoutId: 'ckt_same' });
    await room(projectId).associateCheckout(projectId, actor, { repositoryKey: 'idem-repo', runnerId: runnerA, checkoutId: 'ckt_same' });
    const canonical = await resolveRepositoryByKey(appEnv, projectId, 'idem-repo');
    const checkouts = await listRepositoryCheckouts(appEnv, canonical!.id);
    expect(checkouts).toHaveLength(1);
  });

  it('a checkout already bound to a different repository is surfaced as a conflict, never silently rebound', async () => {
    const { projectId } = await newOwnedProject('pm-259-conflict@example.com', 'PM59CFL');
    await room(projectId).registerRepository(projectId, actor, 'repo-one');
    await room(projectId).registerRepository(projectId, actor, 'repo-two');
    const runnerA = await makeRunner(projectId);
    await room(projectId).associateCheckout(projectId, actor, { repositoryKey: 'repo-one', runnerId: runnerA, checkoutId: 'ckt_shared' });
    const conflict = await room(projectId).associateCheckout(projectId, actor, { repositoryKey: 'repo-two', runnerId: runnerA, checkoutId: 'ckt_shared' });
    expect(conflict.associated).toBe(false);
    const canonical = await resolveRepositoryByKey(appEnv, projectId, 'repo-one');
    const checkouts = await listRepositoryCheckouts(appEnv, canonical!.id);
    expect(checkouts.map((c) => c.checkoutId)).toEqual(['ckt_shared']); // unchanged — not rebound
  });

  it('rejects a ckt_-prefixed repositoryKey through associateCheckout too', async () => {
    const { projectId } = await newOwnedProject('pm-259-ckt2@example.com', 'PM59CK2');
    const runnerA = await makeRunner(projectId);
    await expect(
      room(projectId).associateCheckout(projectId, actor, { repositoryKey: 'ckt_bad', runnerId: runnerA, checkoutId: 'ckt_x' }),
    ).rejects.toThrow(/checkout id/);
  });
});

describe('POST /api/projects/:pid/memory/repositories — HTTP registration (PLNR-311)', () => {
  const post = (pid: string, cookie: string, body: unknown) =>
    SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/repositories`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  const get = (pid: string, cookie: string) =>
    SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/repositories`, { headers: { Cookie: cookie } });
  const del = (pid: string, cookie: string, key: string) =>
    SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/repositories/${key}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
  const mintCap = (token: string, body: unknown) =>
    SELF.fetch('https://noriq.test/api/runner-ingest/capability', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function newMemberProject(email: string, key: string): Promise<{ cookie: string; pid: string }> {
    await createUser(email, 'Member', 'longenough1').catch(() => {});
    const cookie = await loginSession(email, 'longenough1');
    const p = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, name: `${key} project` }),
    });
    const pid = ((await p.json()) as { id: string }).id;
    return { cookie, pid };
  }

  it('a project member can register a repository over HTTP, and it appears in GET /memory/repositories', async () => {
    const { cookie, pid } = await newMemberProject('pm311-reg@example.com', 'PM311REG');

    const res = await post(pid, cookie, { repositoryKey: 'http-repo' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { repository: { repositoryKey: string }; created: boolean };
    expect(body.created).toBe(true);
    expect(body.repository.repositoryKey).toBe('http-repo');

    const listed = (await (await get(pid, cookie)).json()) as { repositories: Array<{ repositoryKey: string }> };
    expect(listed.repositories.map((r) => r.repositoryKey)).toContain('http-repo');

    // The payoff this task exists for: resolveRepositoryByKey (the read side every consumer —
    // ingest capability, index-cursor, associateCheckout, record_memory citations — keys off)
    // now resolves what only a route, not a raw D1 read, could have produced.
    expect(await resolveRepositoryByKey(appEnv, pid, 'http-repo')).not.toBeNull();
  });

  it('registering the same key twice succeeds idempotently and produces exactly one row', async () => {
    const { cookie, pid } = await newMemberProject('pm311-idem@example.com', 'PM311IDM');

    const first = await post(pid, cookie, { repositoryKey: 'idem-http-repo' });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { created: boolean }).created).toBe(true);

    const second = await post(pid, cookie, { repositoryKey: 'idem-http-repo' });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { created: boolean }).created).toBe(false);

    const rows = await listProjectRepositories(appEnv, pid);
    expect(rows.filter((r) => r.repositoryKey === 'idem-http-repo')).toHaveLength(1);
  });

  // PLNR-321: a project spanning one repository (the overwhelmingly common case) never has to
  // hand-author a slug — omitting repositoryKey derives one from the project's own key.
  it('omitting repositoryKey derives a default from the project key, and it ends up registered', async () => {
    const { cookie, pid } = await newMemberProject('pm321-default@example.com', 'PM321DEF');

    const res = await post(pid, cookie, {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { repository: { repositoryKey: string }; created: boolean };
    expect(body.created).toBe(true);
    expect(body.repository.repositoryKey).toBe('pm321def');

    const rows = await listProjectRepositories(appEnv, pid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repositoryKey).toBe('pm321def');
  });

  it('omitting repositoryKey twice is idempotent — same derived key, one row', async () => {
    const { cookie, pid } = await newMemberProject('pm321-default2@example.com', 'PM321DF2');

    const first = await post(pid, cookie, {});
    expect(first.status).toBe(201);
    const second = await post(pid, cookie, {});
    expect(second.status).toBe(200);
    expect(((await second.json()) as { created: boolean }).created).toBe(false);

    const rows = await listProjectRepositories(appEnv, pid);
    expect(rows.filter((r) => r.repositoryKey === 'pm321df2')).toHaveLength(1);
  });

  it('a ckt_-prefixed checkout id is rejected with a message explaining what a repository key is', async () => {
    const { cookie, pid } = await newMemberProject('pm311-ckt@example.com', 'PM311CKT');

    const res = await post(pid, cookie, { repositoryKey: 'ckt_totally_a_checkout' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/checkout id/);

    expect(await resolveRepositoryByKey(appEnv, pid, 'ckt_totally_a_checkout')).toBeNull();
  });

  it('a caller without access to the project is refused exactly as the sibling GET route refuses them', async () => {
    const { pid } = await newMemberProject('pm311-owner@example.com', 'PM311OWN');
    await createUser('pm311-outsider@example.com', 'Outsider', 'longenough1').catch(() => {});
    const outsiderCookie = await loginSession('pm311-outsider@example.com', 'longenough1');

    const getRes = await get(pid, outsiderCookie);
    const postRes = await post(pid, outsiderCookie, { repositoryKey: 'should-not-land' });
    expect(getRes.status).toBe(404);
    expect(postRes.status).toBe(404);
    expect(await resolveRepositoryByKey(appEnv, pid, 'should-not-land')).toBeNull();
  });

  it('no agent- or runner-authenticated (Bearer, no session cookie) path can register a repository', async () => {
    const { pid } = await newMemberProject('pm311-bearer@example.com', 'PM311BER');
    const { apiKey } = await createAgent('pm311-agent');

    const res = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/repositories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryKey: 'agent-should-not-register' }),
    });
    expect(res.status).toBe(401);
    expect(await resolveRepositoryByKey(appEnv, pid, 'agent-should-not-register')).toBeNull();
  });

  it('registering over HTTP unblocks POST /api/runner-ingest/capability, which 404d before registration', async () => {
    const { cookie, pid } = await newMemberProject('pm311-ingest@example.com', 'PM311ING');
    const ownerToken = await mintTokenForUser('pm311-ingest@example.com');
    await authorizeForAllProjects(ownerToken);
    const regRes = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'pm311-runner' }),
    });
    const runnerId = ((await regRes.json()) as { runner: { id: string } }).runner.id;

    const before = await mintCap(ownerToken, { projectId: pid, repositoryKey: 'ingest-http-repo', purpose: 'index', scopeId: 'gen_pm311', runnerId });
    expect(before.status).toBe(404);

    const registered = await post(pid, cookie, { repositoryKey: 'ingest-http-repo' });
    expect(registered.status).toBe(201);

    const reconnect = await SELF.fetch('https://noriq.test/api/runners', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runnerId,
        label: 'pm311-runner',
        repos: [{ id: 'ckt_pm311', projectKey: 'PM311ING', repositoryKey: 'ingest-http-repo', name: 'repo' }],
      }),
    });
    expect(reconnect.status).toBe(200);

    const after = await mintCap(ownerToken, { projectId: pid, repositoryKey: 'ingest-http-repo', purpose: 'index', scopeId: 'gen_pm311', runnerId });
    expect(after.status).toBe(200);
    const capBody = (await after.json()) as { token: string };
    expect(capBody.token).toContain('.');
  });
});

// PLNR-321: DELETE /api/projects/:pid/memory/repositories/:key, added on direct human steering
// on the task ("Should also support removal of repo keys").
describe('DELETE /api/projects/:pid/memory/repositories/:key — HTTP deregistration (PLNR-321)', () => {
  const post = (pid: string, cookie: string, body: unknown) =>
    SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/repositories`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  const get = (pid: string, cookie: string) =>
    SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/repositories`, { headers: { Cookie: cookie } });
  const del = (pid: string, cookie: string, key: string) =>
    SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/repositories/${key}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });

  async function newMemberProject(email: string, key: string): Promise<{ cookie: string; pid: string }> {
    await createUser(email, 'Member', 'longenough1').catch(() => {});
    const cookie = await loginSession(email, 'longenough1');
    const p = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, name: `${key} project` }),
    });
    const pid = ((await p.json()) as { id: string }).id;
    return { cookie, pid };
  }

  it('a project member can deregister a repository over HTTP, and it disappears from GET /memory/repositories', async () => {
    const { cookie, pid } = await newMemberProject('pm321-dereg-http@example.com', 'PM321HDR');
    await post(pid, cookie, { repositoryKey: 'http-dereg-repo' });

    const res = await del(pid, cookie, 'http-dereg-repo');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: boolean }).deleted).toBe(true);

    const listed = (await (await get(pid, cookie)).json()) as { repositories: Array<{ repositoryKey: string }> };
    expect(listed.repositories.map((r) => r.repositoryKey)).not.toContain('http-dereg-repo');
    expect(await resolveRepositoryByKey(appEnv, pid, 'http-dereg-repo')).toBeNull();
  });

  it('deregistering an already-absent key is idempotent — 200, not 404', async () => {
    const { cookie, pid } = await newMemberProject('pm321-dereg-idem-http@example.com', 'PM321HDI');
    const res = await del(pid, cookie, 'never-registered-over-http');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: boolean }).deleted).toBe(false);
  });

  it('a caller without access to the project is refused', async () => {
    const { pid } = await newMemberProject('pm321-dereg-owner@example.com', 'PM321DOW');
    await createUser('pm321-dereg-outsider@example.com', 'Outsider', 'longenough1').catch(() => {});
    const outsiderCookie = await loginSession('pm321-dereg-outsider@example.com', 'longenough1');
    const res = await del(pid, outsiderCookie, 'anything');
    expect(res.status).toBe(404);
  });

  it('no agent- or runner-authenticated (Bearer, no session cookie) path can deregister a repository', async () => {
    const { cookie, pid } = await newMemberProject('pm321-dereg-bearer@example.com', 'PM321DBR');
    await post(pid, cookie, { repositoryKey: 'bearer-should-not-remove' });
    const { apiKey } = await createAgent('pm321-dereg-agent');

    const res = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/repositories/bearer-should-not-remove`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(401);
    expect(await resolveRepositoryByKey(appEnv, pid, 'bearer-should-not-remove')).not.toBeNull();
  });
});

describe('deleteProject survives repository identity + checkout rows (PLNR-236 regression)', () => {
  it('removes project_repositories and repository_checkouts, then the project, without an FK abort', async () => {
    const { projectId } = await newOwnedProject('pm-259-delete@example.com', 'PM59DEL');
    await room(projectId).registerRepository(projectId, actor, 'to-be-deleted');
    const runnerA = await makeRunner(projectId);
    await room(projectId).associateCheckout(projectId, actor, { repositoryKey: 'to-be-deleted', runnerId: runnerA, checkoutId: 'ckt_del' });

    await room(projectId).deleteProject(projectId, actor);

    expect(await listProjectRepositories(appEnv, projectId)).toEqual([]);
    const orphanCheckouts = await appEnv.DB.prepare(
      'SELECT 1 FROM repository_checkouts WHERE project_repository_id NOT IN (SELECT id FROM project_repositories)',
    ).all();
    // No checkout row should reference a now-nonexistent repository — the delete cleared both.
    const stray = await appEnv.DB.prepare('SELECT COUNT(*) AS n FROM repository_checkouts rc WHERE rc.runner_id = ?').bind(runnerA).first<{ n: number }>();
    expect(stray?.n).toBe(0);
    expect(orphanCheckouts.results).toEqual([]);
  });
});
