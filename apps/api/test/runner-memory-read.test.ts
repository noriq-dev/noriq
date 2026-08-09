// PLNR-306: the agentAuth Project Memory read surface for the runner daemon
// (POST /api/runner-memory/index-cursor, POST /api/runner-memory/context) — every existing
// memory read lives under /api/projects/:pid/* (userAuth-gated, index.ts:146), so a Bearer-only
// daemon could read none of it. These two routes live outside that subtree, mirroring
// POST /api/runner-ingest/capability's own gates (runner ownership -> 404, tokenCanReachProject
// -> 403, resolveRepositoryByKey's non-disclosing 404). Coverage: the auth boundary itself,
// cross-project scoping, non-disclosure, association state (not-associated/associated/conflict,
// derived live, never written by asking), cursor/staleness PARITY with the human-facing
// GET /api/projects/:pid/memory/repositories, and the context pack's 'build' role default.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import type { Env } from '../src/env';
import type { Actor } from '../src/do/ProjectRoom';
import { createUser, loginSession, mintTokenForUser, authorizeForAllProjects, projectRoom, SYSTEM_ACTOR } from './helpers';

const appEnv = env as unknown as Env;

interface RepoRpc {
  registerRepository(pid: string, actor: Actor, key: string, opts?: Record<string, unknown>): Promise<{ id: string }>;
  updateRepository(pid: string, actor: Actor, key: string, patch: Record<string, unknown>): Promise<unknown>;
  associateCheckout(
    pid: string,
    actor: Actor,
    input: { repositoryKey: string; runnerId: string; checkoutId: string },
  ): Promise<{ associated: true; projectRepositoryId: string } | { associated: false; reason: string }>;
}
interface MemRpc {
  beginIndexIngest(pid: string, manifest: Record<string, unknown>): Promise<{ ok: true }>;
  ingestIndexBatch(pid: string, batch: { generationId: string; batchNumber: number; batchHash: string }, rows: unknown[]): Promise<unknown>;
  completeIndexIngest(pid: string, generationId: string): Promise<unknown>;
  activateIndexGeneration(pid: string, generationId: string): Promise<unknown>;
}
const room = (pid: string) => projectRoom<RepoRpc>(pid);
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

const createProject = (cookie: string, key: string, name: string) =>
  SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name }),
  });

const register = (token: string, body: unknown) =>
  SELF.fetch('https://noriq.test/api/runners', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const cursor = (token: string | null, body: unknown) =>
  SELF.fetch('https://noriq.test/api/runner-memory/index-cursor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const context = (token: string | null, body: unknown) =>
  SELF.fetch('https://noriq.test/api/runner-memory/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const humanRepos = (cookie: string, pid: string) =>
  SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/repositories`, { headers: { Cookie: cookie } });

const humanContext = (cookie: string, pid: string, body: unknown) =>
  SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/context`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

let ownerToken: string;
let ownerCookie: string;
let projectId: string;
let runnerId: string;

beforeAll(async () => {
  await createUser('rmread-owner@example.com', 'RM Owner', 'longenough1').catch(() => {});
  ownerToken = await mintTokenForUser('rmread-owner@example.com');
  ownerCookie = await loginSession('rmread-owner@example.com', 'longenough1');
  const p = await createProject(ownerCookie, 'RMREAD', 'rmread');
  projectId = ((await p.json()) as { id: string }).id;
  await authorizeForAllProjects(ownerToken);
  const reg = await register(ownerToken, { label: 'rmread-runner' });
  runnerId = ((await reg.json()) as { runner: { id: string } }).runner.id;
  await room(projectId).registerRepository(projectId, SYSTEM_ACTOR as Actor, 'rmread-repo');
}, 60000);

describe('auth boundary (PLNR-306)', () => {
  it('refuses without a bearer token — no session cookie can substitute', async () => {
    expect((await cursor(null, { projectId, repositoryKey: 'rmread-repo', runnerId, checkoutId: 'ckt_noauth' })).status).toBe(401);
    expect((await context(null, { projectId, runnerId, taskId: 'task_x' })).status).toBe(401);
  });

  it('a runner not owned by this connection is refused with 404', async () => {
    const intruder = await mintTokenForUser('rmread-intruder@example.com');
    const res = await cursor(intruder, { projectId, repositoryKey: 'rmread-repo', runnerId, checkoutId: 'ckt_intruder' });
    expect(res.status).toBe(404);
  });

  it('a token scoped to another project gets 403 asking about it', async () => {
    await createUser('rmread-other@example.com', 'RM Other', 'longenough1').catch(() => {});
    const otherCookie = await loginSession('rmread-other@example.com', 'longenough1');
    const otherProj = await createProject(otherCookie, 'RMOTHR', 'rmothr');
    const otherPid = ((await otherProj.json()) as { id: string }).id;
    // ownerToken was scoped (authorizeForAllProjects) only to what ITS user can reach — never
    // RMOTHR, owned by a different user entirely.
    const res = await cursor(ownerToken, { projectId: otherPid, repositoryKey: 'rmread-repo', runnerId, checkoutId: 'ckt_scope' });
    expect(res.status).toBe(403);
  });

  it('a repositoryKey unregistered in this project is refused with the SAME non-disclosing message the capability route uses', async () => {
    const res = await cursor(ownerToken, { projectId, repositoryKey: 'no-such-repo', runnerId, checkoutId: 'ckt_unreg' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('no repository registered for key "no-such-repo" in this project');
  });

  it('a repositoryKey that exists in ANOTHER project reads identically — existence elsewhere is never disclosed', async () => {
    const elsewhere = await createProject(ownerCookie, 'RMELSE', 'rmelse');
    const elsewherePid = ((await elsewhere.json()) as { id: string }).id;
    await room(elsewherePid).registerRepository(elsewherePid, SYSTEM_ACTOR as Actor, 'elsewhere-only-repo');

    const hereRes = await cursor(ownerToken, { projectId, repositoryKey: 'elsewhere-only-repo', runnerId, checkoutId: 'ckt_x' });
    expect(hereRes.status).toBe(404);
    // The SAME generic template as "never registered anywhere" (the earlier test) — nothing here
    // hints that the key exists, just not in THIS project.
    const body = (await hereRes.json()) as { error: string };
    expect(body.error).toBe('no repository registered for key "elsewhere-only-repo" in this project');
  });
});

describe('association state — derived live from repository_checkouts, never written by asking (PLNR-306)', () => {
  it('not-associated when the checkout has never been recorded', async () => {
    const res = await cursor(ownerToken, { projectId, repositoryKey: 'rmread-repo', runnerId, checkoutId: 'ckt_never' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { association: unknown };
    expect(body.association).toEqual({ state: 'not-associated' });
  });

  it('associated once ProjectRoom.associateCheckout has bound it — a pure read never binds it itself', async () => {
    await room(projectId).associateCheckout(projectId, SYSTEM_ACTOR as Actor, { repositoryKey: 'rmread-repo', runnerId, checkoutId: 'ckt_bound' });
    const res = await cursor(ownerToken, { projectId, repositoryKey: 'rmread-repo', runnerId, checkoutId: 'ckt_bound' });
    const body = (await res.json()) as { association: { state: string; projectRepositoryId?: string } };
    expect(body.association.state).toBe('associated');
    expect(body.association.projectRepositoryId).toEqual(expect.any(String));
  });

  it('conflict — bound to a DIFFERENT canonical repository — is distinguishable from not-associated', async () => {
    await room(projectId).registerRepository(projectId, SYSTEM_ACTOR as Actor, 'rmread-repo-two');
    await room(projectId).associateCheckout(projectId, SYSTEM_ACTOR as Actor, { repositoryKey: 'rmread-repo', runnerId, checkoutId: 'ckt_conflict' });
    const res = await cursor(ownerToken, { projectId, repositoryKey: 'rmread-repo-two', runnerId, checkoutId: 'ckt_conflict' });
    const body = (await res.json()) as { association: { state: string; reason?: string } };
    expect(body.association.state).toBe('conflict');
    expect(body.association.reason).toMatch(/already associated with a different repository/);
  });

  it('this endpoint never writes — repeated asking leaves no repository_checkouts row behind', async () => {
    await cursor(ownerToken, { projectId, repositoryKey: 'rmread-repo', runnerId, checkoutId: 'ckt_readonly' });
    await cursor(ownerToken, { projectId, repositoryKey: 'rmread-repo', runnerId, checkoutId: 'ckt_readonly' });
    const row = await appEnv.DB.prepare('SELECT 1 FROM repository_checkouts WHERE runner_id = ? AND checkout_id = ?')
      .bind(runnerId, 'ckt_readonly').first();
    expect(row).toBeNull();
  });
});

describe('index cursor — parity with GET /api/projects/:pid/memory/repositories (PLNR-306)', () => {
  it('reports the SAME activeGeneration/stale/failedIngest the human-facing route computes — one shared derivation', async () => {
    await room(projectId).registerRepository(projectId, SYSTEM_ACTOR as Actor, 'cursor-repo');
    const m = memory(projectId);
    await m.beginIndexIngest(projectId, {
      generationId: 'gen_cursor_1', projectId, repositoryKey: 'cursor-repo', branch: 'main', baseId: 'sha_old',
      indexerVersion: 'v1', batchCount: 1, fileCount: 1, contentHash: 'sha256:x', deletions: [], createdAt: new Date().toISOString(),
    });
    await m.ingestIndexBatch(projectId, { generationId: 'gen_cursor_1', batchNumber: 0, batchHash: 'h' }, [
      { kind: 'node', uri: 'noriq://file/RMREAD/cursor-repo/a.ts', type: 'file', label: 'a.ts' },
    ]);
    await m.completeIndexIngest(projectId, 'gen_cursor_1');
    await m.activateIndexGeneration(projectId, 'gen_cursor_1');
    // Move the repository on past the generation's base — this is what "stale" means.
    await room(projectId).updateRepository(projectId, SYSTEM_ACTOR as Actor, 'cursor-repo', { latestObservedBase: 'sha_new' });

    const [cursorRes, reposRes] = await Promise.all([
      cursor(ownerToken, { projectId, repositoryKey: 'cursor-repo', runnerId, checkoutId: 'ckt_parity' }),
      humanRepos(ownerCookie, projectId),
    ]);
    expect(cursorRes.status).toBe(200);
    expect(reposRes.status).toBe(200);
    const cursorBody = (await cursorRes.json()) as {
      stale: boolean; failedIngest: boolean; latestObservedBase: string | null;
      activeGeneration: { baseId: string; branch: string; indexerVersion: string } | null;
    };
    const reposBody = (await reposRes.json()) as {
      repositories: Array<{ repositoryKey: string; stale: boolean; failedIngest: boolean; activeGeneration: { baseId: string } | null }>;
    };
    const humanRepo = reposBody.repositories.find((r) => r.repositoryKey === 'cursor-repo')!;

    expect(cursorBody.activeGeneration?.baseId).toBe('sha_old');
    expect(cursorBody.activeGeneration?.branch).toBe('main');
    expect(cursorBody.activeGeneration?.indexerVersion).toBe('v1');
    expect(cursorBody.latestObservedBase).toBe('sha_new');
    expect(cursorBody.stale).toBe(true);
    // Parity: the two surfaces never disagree, because they run the SAME derivation.
    expect(cursorBody.stale).toBe(humanRepo.stale);
    expect(cursorBody.failedIngest).toBe(humanRepo.failedIngest);
    expect(cursorBody.activeGeneration?.baseId).toBe(humanRepo.activeGeneration?.baseId);
  });
});

describe('context pack — reuses assembleContextPack unchanged, defaults role to build (PLNR-306)', () => {
  const taskId = 'task_rmread_ctx';

  beforeAll(async () => {
    await appEnv.DB.prepare(
      "INSERT INTO tasks (id, project_id, key, title, status) VALUES (?, ?, 'RMREAD-1', 'context task', 'todo')",
    ).bind(taskId, projectId).run();
  });

  it('returns the real task facts assembleContextPack produces', async () => {
    const res = await context(ownerToken, { projectId, runnerId, taskId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskFacts: { taskId: string; title: string } };
    expect(body.taskFacts.taskId).toBe(taskId);
    expect(body.taskFacts.title).toBe('context task');
  });

  it("defaults role to 'build', never the userAuth route's 'human' default", async () => {
    const [runnerRes, humanRes] = await Promise.all([
      context(ownerToken, { projectId, runnerId, taskId }),
      humanContext(ownerCookie, projectId, { taskId }),
    ]);
    expect(runnerRes.status).toBe(200);
    expect(humanRes.status).toBe(200);
    const runnerBody = (await runnerRes.json()) as { role: string };
    const humanBody = (await humanRes.json()) as { role: string };
    expect(runnerBody.role).toBe('build');
    expect(humanBody.role).toBe('human');
  });

  it('accepts an explicit role override', async () => {
    const res = await context(ownerToken, { projectId, runnerId, taskId, role: 'verify' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe('verify');
  });

  it('an unknown taskId is refused the same way a real one in another project would be', async () => {
    const res = await context(ownerToken, { projectId, runnerId, taskId: 'task_does_not_exist' });
    expect(res.status).toBe(404);
  });
});
