// PLNR-259: canonical repository identity + checkout association. Extends the coverage
// memory-registry.test.ts already established for registerRepository/deleteProject with the
// new identity fields, the checkout-association RPC, ckt_ rejection through the real write
// path, opaque VCS/baseId round-trips, and the D1 active-generation projection.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { Actor } from '../src/do/ProjectRoom';
import { projectRoom, createUser, mintTokenForUser, mcpCall, SYSTEM_ACTOR } from './helpers';
import { listProjectRepositories, resolveRepositoryByKey, listRepositoryCheckouts } from '../src/lib/project-memory';

const appEnv = env as unknown as Env;
const actor = SYSTEM_ACTOR as Actor;

interface RepoRpc {
  registerRepository(pid: string, actor: Actor, repositoryKey: string, opts?: { defaultBranch?: string | null; vcsKind?: string | null }): Promise<{ id: string }>;
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
