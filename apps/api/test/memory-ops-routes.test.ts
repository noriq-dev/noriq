// PLNR-273: the web-facing (session-cookie) operator routes for repository index / backup /
// restore / memory-health — GET reads any project member can see, POST actions gated on the
// admin role (the routes' own requireAdmin(c) check, distinct from the pre-existing ADMIN_TOKEN
// /api/admin/memory-* routes those actions internally mirror). Drives the routes over
// SELF.fetch with real session cookies (same technique as admin.test.ts), not the DO directly —
// the thing under test here is the REST layer itself: admin gating, the confirm=replace guard,
// and the enriched /repositories shape.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, loginSession, SYSTEM_ACTOR } from './helpers';
import { computeStagedContentHash } from '../src/memory/ingest';

const appEnv = env as unknown as Env;

async function ownedProject(cookie: string, key: string): Promise<string> {
  const res = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name: `${key} project` }),
  });
  const body = await res.json() as { id: string };
  return body.id;
}

const get = (path: string, cookie: string) => SELF.fetch(`https://noriq.test${path}`, { headers: { Cookie: cookie } });
const post = (path: string, cookie: string) => SELF.fetch(`https://noriq.test${path}`, { method: 'POST', headers: { Cookie: cookie } });

async function memoryRpc(pid: string) {
  return appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as {
    beginIndexIngest(pid: string, manifest: Record<string, unknown>): Promise<{ ok: true }>;
    ingestIndexBatch(pid: string, batch: { generationId: string; batchNumber: number; batchHash: string }, rows: unknown[]): Promise<unknown>;
    completeIndexIngest(pid: string, generationId: string): Promise<unknown>;
    activateIndexGeneration(pid: string, generationId: string): Promise<{ activated: string; superseded: string[] }>;
    health(pid: string): Promise<{ hasPriorGeneration: boolean }>;
  };
}

function roomFor(pid: string) {
  return appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as {
    registerRepository(pid: string, actor: { kind: string; id: string | null }, key: string, opts?: Record<string, unknown>): Promise<{ id: string }>;
    updateRepository(pid: string, actor: { kind: string; id: string | null }, key: string, patch: Record<string, unknown>): Promise<unknown>;
  };
}

describe('GET /api/projects/:pid/memory/ops-status (PLNR-273)', () => {
  it('a non-admin project member can read status — health, registry, capabilities', async () => {
    await createUser('mo-member@example.com', 'Member', 'longenough1').catch(() => {});
    const cookie = await loginSession('mo-member@example.com', 'longenough1');
    const pid = await ownedProject(cookie, 'MOMEM1');

    const res = await get(`/api/projects/${pid}/memory/ops-status`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      health: { hasPriorGeneration: boolean; sizeStatus: string };
      registry: unknown;
      hierarchy: { state: string; active: unknown };
      capabilities: { r2: boolean; vectorize: boolean; workersAI: boolean; codeVectorize: boolean };
    };
    expect(body.health.hasPriorGeneration).toBe(false);
    expect(body.registry).toBeNull(); // never touched its memory store yet
    expect(body.hierarchy).toMatchObject({ state: 'unavailable', active: null });
    expect(typeof body.capabilities.r2).toBe('boolean');
    expect(typeof body.capabilities.vectorize).toBe('boolean');
  });

  it('renders without crashing on a project with no repositories, generations, or backups', async () => {
    await createUser('mo-empty@example.com', 'Empty', 'longenough1').catch(() => {});
    const cookie = await loginSession('mo-empty@example.com', 'longenough1');
    const pid = await ownedProject(cookie, 'MOEMPTY');

    const [statusRes, reposRes, backupsRes] = await Promise.all([
      get(`/api/projects/${pid}/memory/ops-status`, cookie),
      get(`/api/projects/${pid}/memory/repositories`, cookie),
      get(`/api/projects/${pid}/memory/backups`, cookie),
    ]);
    expect(statusRes.status).toBe(200);
    expect(reposRes.status).toBe(200);
    expect(backupsRes.status).toBe(200);
    expect((await reposRes.json() as { repositories: unknown[] }).repositories).toEqual([]);
    expect((await backupsRes.json() as { backups: unknown[] }).backups).toEqual([]);
  });
});

describe('Constellation hierarchy operations (PLNR-382)', () => {
  it('allows a project owner/manager to rebuild without instance-admin authority and reports the active generation', async () => {
    await createUser('mo-hierarchy@example.com', 'Hierarchy owner', 'longenough1').catch(() => {});
    const cookie = await loginSession('mo-hierarchy@example.com', 'longenough1');
    const pid = await ownedProject(cookie, 'MOHIER1');

    const rebuilt = await post(`/api/projects/${pid}/memory/constellation/v2/rebuild`, cookie);
    expect(rebuilt.status).toBe(200);
    expect(await rebuilt.json()).toMatchObject({ ok: true, nodes: 0, edges: 0 });

    const status = await get(`/api/projects/${pid}/memory/ops-status`, cookie);
    expect(await status.json()).toMatchObject({
      hierarchy: {
        state: 'current', active: { status: 'active', sourceRevision: 0, currentRevision: 0 },
        rows: { nodeStats: 0, communities: 0, memberships: 0, links: 0 },
        cache: { policy: 'private-revalidate', compactPageHardLimitBytes: 524288 },
      },
    });
  });
});

describe('GET /api/projects/:pid/memory/repositories enrichment (PLNR-273)', () => {
  it('reports stale=true when the active generation base differs from the repository latest observed base', async () => {
    await createUser('mo-stale@example.com', 'Stale', 'longenough1').catch(() => {});
    const cookie = await loginSession('mo-stale@example.com', 'longenough1');
    const pid = await ownedProject(cookie, 'MOSTALE');
    const rpc = await memoryRpc(pid);
    const room = roomFor(pid);

    // Register the D1 repository row first — the DO's own index_generations table and D1's
    // project_repositories table are separate registries (§3); GET /repositories reads the D1
    // one, so it must exist before anything below matters to it.
    await room.registerRepository(pid, SYSTEM_ACTOR, 'stale-repo');
    const staleRows = [
      { kind: 'node', uri: `noriq://file/MOSTALE/stale-repo/a.ts`, type: 'file', label: 'a.ts' },
    ];

    await rpc.beginIndexIngest(pid, {
      generationId: 'gen_stale_1', projectId: pid, repositoryKey: 'stale-repo', branch: 'main', baseId: 'sha_old',
      indexerVersion: 'v1', batchCount: 1, fileCount: 1, contentHash: await computeStagedContentHash(staleRows as never), deletions: [], createdAt: new Date().toISOString(),
    });
    await rpc.ingestIndexBatch(pid, { generationId: 'gen_stale_1', batchNumber: 0, batchHash: 'h' }, staleRows);
    await rpc.completeIndexIngest(pid, 'gen_stale_1');
    // Activate directly through the DO (not REST — this test's subject is the read-side
    // enrichment, not the activate route) — activateIndexGeneration itself projects
    // activeGenerationId into the D1 row via ProjectRoom.
    await rpc.activateIndexGeneration(pid, 'gen_stale_1');
    // The repository has moved on since that generation was built.
    await room.updateRepository(pid, SYSTEM_ACTOR, 'stale-repo', { latestObservedBase: 'sha_new' });

    const res = await get(`/api/projects/${pid}/memory/repositories`, cookie);
    const body = await res.json() as { repositories: Array<{ repositoryKey: string; stale: boolean; activeGeneration: { baseId: string } | null }> };
    const repo = body.repositories.find((r) => r.repositoryKey === 'stale-repo');
    expect(repo?.activeGeneration?.baseId).toBe('sha_old');
    expect(repo?.stale).toBe(true);
  });

  it('a sealed generation that fails validation shows failedIngest with its problems, and is not offered as validated', async () => {
    await createUser('mo-failed@example.com', 'Failed', 'longenough1').catch(() => {});
    const cookie = await loginSession('mo-failed@example.com', 'longenough1');
    const pid = await ownedProject(cookie, 'MOFAIL1');
    const rpc = await memoryRpc(pid);
    const badRows = [
      { kind: 'node', uri: `noriq://file/MOFAIL1/bad-repo/a.ts`, type: 'file', label: 'a.ts' },
    ];

    await rpc.beginIndexIngest(pid, {
      generationId: 'gen_bad_1', projectId: pid, repositoryKey: 'bad-repo', branch: 'main', baseId: 'sha_1',
      indexerVersion: 'v1', batchCount: 1, fileCount: 9, contentHash: await computeStagedContentHash(badRows as never), deletions: [], createdAt: new Date().toISOString(),
    });
    await rpc.ingestIndexBatch(pid, { generationId: 'gen_bad_1', batchNumber: 0, batchHash: 'h' }, badRows); // 1, manifest says 9
    await rpc.completeIndexIngest(pid, 'gen_bad_1');
    await roomFor(pid).registerRepository(pid, SYSTEM_ACTOR, 'bad-repo');

    const res = await get(`/api/projects/${pid}/memory/repositories`, cookie);
    const body = await res.json() as {
      repositories: Array<{ repositoryKey: string; failedIngest: boolean; failedIngestProblems: string[]; stagedGenerations: Array<{ id: string; validated: boolean }> }>;
    };
    const repo = body.repositories.find((r) => r.repositoryKey === 'bad-repo')!;
    expect(repo.failedIngest).toBe(true);
    expect(repo.failedIngestProblems.join(' ')).toMatch(/fileCount 9/);
    expect(repo.stagedGenerations.find((g) => g.id === 'gen_bad_1')?.validated).toBe(false);
  });
});

describe('PLNR-273 operator action routes require the admin role', () => {
  it('a non-admin project owner is 403d off every destructive/action route, but reads still succeed', async () => {
    await createUser('mo-owner@example.com', 'Owner', 'longenough1').catch(() => {});
    const cookie = await loginSession('mo-owner@example.com', 'longenough1');
    const pid = await ownedProject(cookie, 'MOOWNR1');

    const actionRoutes = [
      `/api/projects/${pid}/memory/backup`,
      `/api/projects/${pid}/memory/restore/rollback`,
      `/api/projects/${pid}/memory/generations/prune-retained`,
      `/api/projects/${pid}/memory/generations/nonexistent/activate`,
      `/api/projects/${pid}/memory/generations/nonexistent/abort`,
      `/api/projects/${pid}/memory/vectors/rebuild`,
      `/api/projects/${pid}/memory/lifecycle-sweep`,
    ];
    for (const path of actionRoutes) {
      const res = await post(path, cookie);
      expect.soft(res.status, path).toBe(403);
    }
    const restoreRes = await post(`/api/projects/${pid}/memory/restore?confirm=replace&exportedAt=2026-01-01T00-00-00-000Z`, cookie);
    expect(restoreRes.status).toBe(403);

    // Reads are still fine for a non-admin — status without action.
    expect((await get(`/api/projects/${pid}/memory/ops-status`, cookie)).status).toBe(200);
  });

  it('an admin can trigger backup/rebuild/sweep on their own project', async () => {
    await createUser('mo-admin@example.com', 'Admin', 'longenough1', 'admin').catch(() => {});
    const cookie = await loginSession('mo-admin@example.com', 'longenough1');
    const pid = await ownedProject(cookie, 'MOADMN1');

    const backupRes = await post(`/api/projects/${pid}/memory/backup`, cookie);
    expect(backupRes.status).toBe(200);
    const backupBody = await backupRes.json() as { ok: boolean; manifestKey?: string };
    expect(backupBody.ok).toBe(true);
    expect(typeof backupBody.manifestKey).toBe('string');

    const rebuildRes = await post(`/api/projects/${pid}/memory/vectors/rebuild`, cookie);
    expect(rebuildRes.status).toBe(200);
    expect((await rebuildRes.json() as { ok: boolean }).ok).toBe(true);

    const sweepRes = await post(`/api/projects/${pid}/memory/lifecycle-sweep`, cookie);
    expect(sweepRes.status).toBe(200);
    const sweepBody = await sweepRes.json() as {
      projectId: string; backfilled: boolean; backfillNodesWritten: number; backfillEdgesWritten: number;
      errors: Array<{ step: string; message: string }>;
    };
    expect(sweepBody.projectId).toBe(pid);
    expect(sweepBody.backfilled).toBe(true);
    expect(sweepBody.backfillNodesWritten).toBeGreaterThanOrEqual(0);
    expect(sweepBody.backfillEdgesWritten).toBeGreaterThanOrEqual(0);
    expect(sweepBody.errors).toEqual([]);
  });
});

describe('PLNR-273 restore keeps the ?confirm=replace guard and cannot activate an unvalidated generation', () => {
  it('refuses restore without ?confirm=replace even for an admin', async () => {
    await createUser('mo-guard@example.com', 'Guard', 'longenough1', 'admin').catch(() => {});
    const cookie = await loginSession('mo-guard@example.com', 'longenough1');
    const pid = await ownedProject(cookie, 'MOGUARD');

    const res = await post(`/api/projects/${pid}/memory/restore?exportedAt=2026-01-01T00-00-00-000Z`, cookie);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/confirm=replace/);
  });

  it('refuses activation of a staged generation that has not been sealed/validated, with the server error surfaced', async () => {
    await createUser('mo-act@example.com', 'Act', 'longenough1', 'admin').catch(() => {});
    const cookie = await loginSession('mo-act@example.com', 'longenough1');
    const pid = await ownedProject(cookie, 'MOACT01');
    const rpc = await memoryRpc(pid);

    await rpc.beginIndexIngest(pid, {
      generationId: 'gen_unsealed', projectId: pid, repositoryKey: 'act-repo', branch: 'main', baseId: 'sha_1',
      indexerVersion: 'v1', batchCount: 1, fileCount: 1, contentHash: '0'.repeat(64), deletions: [], createdAt: new Date().toISOString(),
    });
    // Never sealed (no completeIndexIngest) — activation must be refused.
    const res = await post(`/api/projects/${pid}/memory/generations/gen_unsealed/activate`, cookie);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/has not completed ingest/);
  });

  it('activates a sealed, validated generation successfully', async () => {
    await createUser('mo-act2@example.com', 'Act2', 'longenough1', 'admin').catch(() => {});
    const cookie = await loginSession('mo-act2@example.com', 'longenough1');
    const pid = await ownedProject(cookie, 'MOACT02');
    const rpc = await memoryRpc(pid);
    await roomFor(pid).registerRepository(pid, SYSTEM_ACTOR, 'ok-repo'); // so the best-effort D1 projection has a row to update
    const okRows = [
      { kind: 'node', uri: `noriq://file/MOACT02/ok-repo/a.ts`, type: 'file', label: 'a.ts' },
    ];

    await rpc.beginIndexIngest(pid, {
      generationId: 'gen_ok', projectId: pid, repositoryKey: 'ok-repo', branch: 'main', baseId: 'sha_1',
      indexerVersion: 'v1', batchCount: 1, fileCount: 1, contentHash: await computeStagedContentHash(okRows as never), deletions: [], createdAt: new Date().toISOString(),
    });
    await rpc.ingestIndexBatch(pid, { generationId: 'gen_ok', batchNumber: 0, batchHash: 'h' }, okRows);
    await rpc.completeIndexIngest(pid, 'gen_ok');

    const res = await post(`/api/projects/${pid}/memory/generations/gen_ok/activate`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json() as { activated: string };
    expect(body.activated).toBe('gen_ok');
  });
});
