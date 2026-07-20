// PLNR-19: hammer the claim arbiter. The exactly-one-claim invariant is the
// foundation everything else stands on — prove it holds under a concurrent
// stampede, and that legitimate parallel work isn't serialized away.
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, mcpCall, authorizeForAllProjects } from './helpers';
import type { Env } from '../src/env';

const RACERS = 12;
const appEnv = env as unknown as Env;
const room = (pid: string) =>
  appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as {
    setFileLocking(pid: string, opts: { enabled?: boolean }): Promise<unknown>;
  };
const liveLockCount = (pid: string, canon: string) =>
  env.DB.prepare('SELECT COUNT(*) AS n FROM file_locks WHERE project_id = ? AND canon_pattern = ? AND released_at IS NULL')
    .bind(pid, canon).first<{ n: number }>();

let agents: Array<{ id: string; apiKey: string }> = [];
let projectId: string;

beforeAll(async () => {
  // Mint a swarm through the real OAuth flow.
  agents = [];
  for (let i = 0; i < RACERS; i++) {
    agents.push(await createAgent(`racer-${i}`));
  }
  const proj = await mcpCall(agents[0]!.apiKey, 'create_project', { key: 'LOAD', name: 'load-test' });
  projectId = proj.body.id;
  // Scoping (RUN-38): these agents were minted before the project existed, so each token is
  // scoped to nothing and only the CREATOR gains the new project. A human would authorize them
  // for it — say so explicitly rather than let the old implicit "every token sees everything"
  // creep back in.
  await authorizeForAllProjects(...agents.map((a) => a.apiKey));

}, 60000);

describe('claim arbiter under load', () => {
  it(`${RACERS} agents race ONE task → exactly one claim, clean rejections`, async () => {
    const t = await mcpCall(agents[0]!.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'the contested task' });
    const start = Date.now();
    const results = await Promise.all(
      agents.map((a) => mcpCall(a.apiKey, 'claim_task', { projectId, taskId: t.body.id })),
    );
    const elapsed = Date.now() - start;

    const wins = results.filter((r) => !r.isError);
    const losses = results.filter((r) => r.isError);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(RACERS - 1);
    for (const l of losses) {
      expect(l.text).toMatch(/already claimed|not claimable/);
    }
    // Wall-clock sanity: the DO serializes, but a stampede must not take seconds each.
    expect(elapsed).toBeLessThan(10_000);
    // eslint-disable-next-line no-console
    console.info(`[load] 1-task stampede: ${RACERS} racers in ${elapsed}ms (1 win, ${losses.length} clean rejections)`);
  }, 30000);

  it(`${RACERS} agents claim ${RACERS} distinct tasks in parallel → all succeed`, async () => {
    const tasks: string[] = [];
    for (let i = 0; i < RACERS; i++) {
      const t = await mcpCall(agents[0]!.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: `parallel work ${i}` });
      tasks.push(t.body.id);
    }
    const start = Date.now();
    const results = await Promise.all(
      agents.map((a, i) => mcpCall(a.apiKey, 'claim_task', { projectId, taskId: tasks[i]! })),
    );
    const elapsed = Date.now() - start;
    expect(results.filter((r) => !r.isError)).toHaveLength(RACERS);
    // Every claim is exclusive and attributed to the right agent.
    const proj = await mcpCall(agents[0]!.apiKey, 'get_project', { projectId });
    for (let i = 0; i < RACERS; i++) {
      const row = proj.body.tasks.find((x: { id: string }) => x.id === tasks[i]);
      expect(row.claimedBy).toBe(agents[i]!.id);
    }
    // eslint-disable-next-line no-console
    console.info(`[load] parallel claims: ${RACERS}/${RACERS} in ${elapsed}ms`);
    expect(elapsed).toBeLessThan(10_000);
  }, 30000);

  it('rapid claim/release cycling keeps state consistent', async () => {
    const t = await mcpCall(agents[0]!.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'hot potato' });
    for (let round = 0; round < 5; round++) {
      const holder = agents[round % agents.length]!;
      const claim = await mcpCall(holder.apiKey, 'claim_task', { projectId, taskId: t.body.id });
      expect(claim.isError).toBe(false);
      const rel = await mcpCall(holder.apiKey, 'release_task', { projectId, taskId: t.body.id, toStatus: 'todo' });
      expect(rel.isError).toBe(false);
    }
    const proj = await mcpCall(agents[0]!.apiKey, 'get_project', { projectId });
    const row = proj.body.tasks.find((x: { id: string }) => x.id === t.body.id);
    expect(row.claimedBy).toBeNull();
    expect(row.status).toBe('todo');
  }, 30000);
});

describe('file-lock arbiter under load (PLNR-214)', () => {
  beforeAll(async () => {
    await room(projectId).setFileLocking(projectId, { enabled: true });
  }, 30000);

  it(`${RACERS} agents race ONE path → exactly one lock granted, the rest denied`, async () => {
    const start = Date.now();
    const results = await Promise.all(
      agents.map((a) => mcpCall(a.apiKey, 'acquire_lock', { projectId, paths: ['src/contested.ts'], branch: 'main' })),
    );
    const elapsed = Date.now() - start;
    const wins = results.filter((r) => !r.isError && r.body?.ok === true);
    const denials = results.filter((r) => !r.isError && r.body?.ok === false);
    expect(wins).toHaveLength(1);
    expect(denials).toHaveLength(RACERS - 1);
    // The stored truth agrees: exactly ONE live lock on the contested path.
    expect((await liveLockCount(projectId, 'src/contested.ts'))!.n).toBe(1);
    // Every denial names the one holder + the same expiry.
    for (const d of denials) expect(d.body.conflicts[0].path).toBe('src/contested.ts');
    expect(elapsed).toBeLessThan(10_000);
    // eslint-disable-next-line no-console
    console.info(`[load] 1-path lock stampede: ${RACERS} racers in ${elapsed}ms (1 grant, ${denials.length} denials)`);
  }, 30000);

  it(`${RACERS} agents lock ${RACERS} DISTINCT paths in parallel → all granted`, async () => {
    const start = Date.now();
    const results = await Promise.all(
      agents.map((a, i) => mcpCall(a.apiKey, 'acquire_lock', { projectId, paths: [`src/lane-${i}.ts`], branch: 'main' })),
    );
    const elapsed = Date.now() - start;
    expect(results.filter((r) => !r.isError && r.body?.ok === true)).toHaveLength(RACERS);
    for (let i = 0; i < RACERS; i++) expect((await liveLockCount(projectId, `src/lane-${i}.ts`))!.n).toBe(1);
    expect(elapsed).toBeLessThan(10_000);
    // eslint-disable-next-line no-console
    console.info(`[load] parallel distinct-path locks: ${RACERS}/${RACERS} in ${elapsed}ms`);
  }, 30000);

  it('one agent hammering the same path concurrently is idempotent → one row', async () => {
    const holder = agents[0]!;
    const results = await Promise.all(
      Array.from({ length: RACERS }, () => mcpCall(holder.apiKey, 'acquire_lock', { projectId, paths: ['src/idem-load.ts'], branch: 'main' })),
    );
    expect(results.every((r) => !r.isError && r.body?.ok === true)).toBe(true);
    expect((await liveLockCount(projectId, 'src/idem-load.ts'))!.n).toBe(1); // renews in place, never duplicates
  }, 30000);
});
