// PLNR-204: the ProjectRoom file-lock arbiter. Drives the DO methods directly (the MCP surface is
// Phase 3) — same technique as board-lock.test.ts. Covers: opt-in gate, acquire/deny with structured
// holder info, idempotent re-acquire (= renewal), all-or-nothing multi-path, branch scoping, release,
// human-only force-release, auto-release on every task-settlement path, TTL expiry (arbiter + alarm),
// and the delete cascades (PLNR-203).
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { createUser, loginSession } from './helpers';

const appEnv = env as unknown as Env;
interface RoomRpc {
  setFileLocking(pid: string, opts: { enabled?: boolean; ttlSeconds?: number | null }): Promise<{ fileLockingEnabled: boolean; lockTtlSeconds: number }>;
  acquireLocks(pid: string, actor: Actor, agentId: string, input: { paths: string[]; branch?: string | null; allBranches?: boolean; taskId?: string | null }): Promise<any>;
  releaseLocks(pid: string, actor: Actor, agentId: string, input: { lockIds?: string[]; paths?: string[] }): Promise<{ released: string[] }>;
  renewLocks(pid: string, actor: Actor, agentId: string, input: { lockIds: string[] }): Promise<{ renewed: string[]; expiresAt: string | null }>;
  forceReleaseLock(pid: string, actor: Actor, lockId: string): Promise<any>;
  checkLocks(pid: string, actor: Actor, agentId: string, input: { paths: string[]; branch?: string | null; allBranches?: boolean }): Promise<any>;
  listLocks(pid: string, actor: Actor, filter?: { taskId?: string; agentId?: string }): Promise<{ enabled: boolean; locks: any[] }>;
  createTask(pid: string, actor: Actor, input: Record<string, unknown>): Promise<{ id: string }>;
  claimTask(pid: string, actor: Actor, taskId: string, agentId: string): Promise<any>;
  releaseTask(pid: string, actor: Actor, taskId: string, opts?: { toStatus?: string }): Promise<any>;
  updateTask(pid: string, actor: Actor, taskId: string, patch: Record<string, unknown>): Promise<any>;
  deleteTask(pid: string, actor: Actor, taskId: string): Promise<any>;
  deleteProject(pid: string, actor: Actor): Promise<any>;
  alarm(): Promise<void>;
}
const room = (pid: string) => appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as RoomRpc;

const human: Actor = { kind: 'human', id: 'usr_fl', name: 'Locker' };
let A: Actor;
let B: Actor;
let pid: string; // locking ENABLED
let pidOff: string; // locking OFF

async function seedAgent(pidFor: string, id: string): Promise<Actor> {
  // A copilot (a human's MCP session) — a natural lock holder, and needs no runner (the agents
  // CHECK requires kind='agent' rows to be runner-owned; PLNR-204 keys the holder on agent_id
  // regardless of kind).
  await env.DB.prepare("INSERT INTO agents (id, name, kind, project_id) VALUES (?, ?, 'copilot', ?)").bind(id, id, pidFor).run();
  return { kind: 'agent', id, name: id };
}
const liveRows = (pidFor: string, canon: string) =>
  env.DB.prepare('SELECT id, agent_id AS agentId, released_at AS releasedAt FROM file_locks WHERE project_id = ? AND canon_pattern = ? AND released_at IS NULL')
    .bind(pidFor, canon).all<{ id: string; agentId: string; releasedAt: string | null }>();
const anyRow = (canon: string) =>
  env.DB.prepare('SELECT id, released_at AS releasedAt FROM file_locks WHERE canon_pattern = ?').bind(canon).first<{ id: string; releasedAt: string | null }>();

async function mkProject(key: string, name: string, cookie: string): Promise<string> {
  const p = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, name }),
  });
  return ((await p.json()) as { id: string }).id;
}

beforeAll(async () => {
  await createUser('flock@example.com', 'F Lock', 'longenough1', 'admin').catch(() => {});
  const cookie = await loginSession('flock@example.com', 'longenough1');
  pid = await mkProject('FLK', 'file-locks', cookie);
  pidOff = await mkProject('FLKOFF', 'file-locks-off', cookie);
  await room(pid).setFileLocking(pid, { enabled: true });
  A = await seedAgent(pid, 'agt_flk_a');
  B = await seedAgent(pid, 'agt_flk_b');
}, 60000);

describe('opt-in gate (default OFF)', () => {
  it('acquire throws on a project that never enabled locking; check returns enabled:false', async () => {
    const offAgent = await seedAgent(pidOff, 'agt_off_a');
    await expect(room(pidOff).acquireLocks(pidOff, offAgent, offAgent.id, { paths: ['x.ts'], allBranches: true })).rejects.toThrow(/not enabled/);
    const chk = await room(pidOff).checkLocks(pidOff, offAgent, offAgent.id, { paths: ['x.ts'] });
    expect(chk.enabled).toBe(false);
  });
});

describe('acquire / deny', () => {
  it('grants a free path, then hard-denies an overlapping path from another session with holder info', async () => {
    const got = await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/auth.ts'], branch: 'main' });
    expect(got.ok).toBe(true);
    expect(got.locks[0].renewed).toBe(false);

    const denied = await room(pid).acquireLocks(pid, B, B.id, { paths: ['src/auth.ts'], branch: 'main' });
    expect(denied.ok).toBe(false);
    expect(denied.conflicts[0].holderAgentId).toBe(A.id);
    expect(denied.conflicts[0].path).toBe('src/auth.ts');
    expect(denied.conflicts[0].expiresAt).toBeTruthy();
  });

  it('re-acquiring your own lock is idempotent (renews in place, no second row)', async () => {
    const first = await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/idem.ts'], branch: 'main' });
    const second = await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/idem.ts'], branch: 'main' });
    expect(second.ok).toBe(true);
    expect(second.locks[0].renewed).toBe(true);
    expect(second.locks[0].id).toBe(first.locks[0].id);
    expect((await liveRows(pid, 'src/idem.ts')).results).toHaveLength(1);
  });

  it('is all-or-nothing: a partial conflict grants NOTHING', async () => {
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/aon.ts'], branch: 'main' });
    const res = await room(pid).acquireLocks(pid, B, B.id, { paths: ['lib/free.ts', 'src/aon.ts'], branch: 'main' });
    expect(res.ok).toBe(false);
    expect((await liveRows(pid, 'lib/free.ts')).results).toHaveLength(0); // B holds no partial lock
  });

  it('a disjoint path from another session is granted', async () => {
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/dir-a/x.ts'], branch: 'main' });
    const res = await room(pid).acquireLocks(pid, B, B.id, { paths: ['src/dir-b/y.ts'], branch: 'main' });
    expect(res.ok).toBe(true);
  });

  it('normalization errors surface; the path-count cap is enforced', async () => {
    await expect(room(pid).acquireLocks(pid, A, A.id, { paths: ['../etc/passwd'], allBranches: true })).rejects.toThrow();
    const many = Array.from({ length: 65 }, (_, i) => `src/many/f${i}.ts`);
    await expect(room(pid).acquireLocks(pid, A, A.id, { paths: many, allBranches: true })).rejects.toThrow(/too many paths/);
  });
});

describe('branch scope (§4)', () => {
  it('same path on a different branch does not conflict; missing scope downgrades to all-branches', async () => {
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/br.ts'], branch: 'main' });
    const otherBranch = await room(pid).acquireLocks(pid, B, B.id, { paths: ['src/br.ts'], branch: 'dev' });
    expect(otherBranch.ok).toBe(true);

    const dg = await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/dg.ts'] }); // neither branch nor allBranches
    expect(dg.ok).toBe(true);
    expect(dg.downgraded).toBe(true);
    expect(dg.allBranches).toBe(true);
  });

  it('an all-branches lock conflicts with a specific-branch acquire on the same path', async () => {
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/glob-branch.ts'], allBranches: true });
    const res = await room(pid).acquireLocks(pid, B, B.id, { paths: ['src/glob-branch.ts'], branch: 'feature-x' });
    expect(res.ok).toBe(false);
  });
});

describe('release + force-release (§7)', () => {
  it('holder releases its own; a peer agent cannot; a human force-releases; then the peer can take it', async () => {
    const got = await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/force.ts'], branch: 'main' });
    const lockId = got.locks[0].id;

    // A peer's normal release touches nothing it doesn't own.
    const peer = await room(pid).releaseLocks(pid, B, B.id, { paths: ['src/force.ts'] });
    expect(peer.released).toHaveLength(0);

    // Agent↔agent force-release is refused.
    await expect(room(pid).forceReleaseLock(pid, B, lockId)).rejects.toThrow(/only a human/);

    // Human override works, and now B can acquire.
    await room(pid).forceReleaseLock(pid, human, lockId);
    const afterForce = await room(pid).acquireLocks(pid, B, B.id, { paths: ['src/force.ts'], branch: 'main' });
    expect(afterForce.ok).toBe(true);
  });

  it('releaseLocks by path frees the lock for others', async () => {
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/rel.ts'], branch: 'main' });
    const rel = await room(pid).releaseLocks(pid, A, A.id, { paths: ['src/rel.ts'] });
    expect(rel.released).toHaveLength(1);
    const res = await room(pid).acquireLocks(pid, B, B.id, { paths: ['src/rel.ts'], branch: 'main' });
    expect(res.ok).toBe(true);
  });
});

describe('auto-release on task settle (§5)', () => {
  it('releaseTask (to review) drops the task’s locks', async () => {
    const t = await room(pid).createTask(pid, human, { title: 'lock via claim' });
    await room(pid).claimTask(pid, A, t.id, A.id);
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/via-release.ts'], branch: 'main', taskId: t.id });
    await room(pid).releaseTask(pid, A, t.id, { toStatus: 'review' });
    expect((await anyRow('src/via-release.ts'))!.releasedAt).toBeTruthy();
  });

  it('a supervisor status→done also drops the task’s locks (distinct path)', async () => {
    const t = await room(pid).createTask(pid, human, { title: 'lock via update' });
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/via-update.ts'], branch: 'main', taskId: t.id });
    await room(pid).updateTask(pid, human, t.id, { status: 'done' });
    expect((await anyRow('src/via-update.ts'))!.releasedAt).toBeTruthy();
  });
});

describe('TTL expiry (§5)', () => {
  it('an expired lock no longer conflicts (arbiter reads by server time)', async () => {
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/exp.ts'], branch: 'main' });
    await env.DB.prepare("UPDATE file_locks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE canon_pattern = 'src/exp.ts' AND released_at IS NULL").run();
    const res = await room(pid).acquireLocks(pid, B, B.id, { paths: ['src/exp.ts'], branch: 'main' });
    expect(res.ok).toBe(true); // A's lock is expired → not live → no conflict
  });

  it('expired locks are reaped (the alarm and acquire share this path)', async () => {
    // alarm() is a reserved DO method (not RPC-callable); it delegates to reapExpiredLocks, which
    // acquire also runs on entry. Expire a lock, trigger a reap via an unrelated acquire, and assert
    // the dead lock was released.
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/reap.ts'], branch: 'main' });
    await env.DB.prepare("UPDATE file_locks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE canon_pattern = 'src/reap.ts' AND released_at IS NULL").run();
    await room(pid).acquireLocks(pid, B, B.id, { paths: ['src/reap-trigger.ts'], branch: 'main' });
    expect((await anyRow('src/reap.ts'))!.releasedAt).toBeTruthy();
  });
});

describe('event log + WS fanout (PLNR-205)', () => {
  const lockEvents = (verb: string) =>
    env.DB.prepare("SELECT payload FROM events WHERE project_id = ? AND verb = ? ORDER BY seq DESC LIMIT 8").bind(pid, verb).all<{ payload: string }>();

  it('acquire / deny / release each append a lock.* event (the same emit() path that fans out over WS)', async () => {
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/evt.ts'], branch: 'main' });
    await room(pid).acquireLocks(pid, B, B.id, { paths: ['src/evt.ts'], branch: 'main' }); // denied
    await room(pid).releaseLocks(pid, A, A.id, { paths: ['src/evt.ts'] });

    expect((await lockEvents('lock.acquired')).results.some((e) => e.payload.includes('src/evt.ts'))).toBe(true);
    expect((await lockEvents('lock.denied')).results.some((e) => e.payload.includes('src/evt.ts'))).toBe(true);
    expect((await lockEvents('lock.released')).results.some((e) => e.payload.includes('src/evt.ts'))).toBe(true);
  });
});

describe('delete cascade (PLNR-203)', () => {
  it('deleteTask reaps the task’s locks', async () => {
    const t = await room(pid).createTask(pid, human, { title: 'doomed task' });
    await room(pid).acquireLocks(pid, A, A.id, { paths: ['src/cascade-task.ts'], branch: 'main', taskId: t.id });
    await room(pid).deleteTask(pid, human, t.id);
    expect(await anyRow('src/cascade-task.ts')).toBeNull();
  });

  it('deleteProject reaps all of a project’s locks', async () => {
    const cookie = await loginSession('flock@example.com', 'longenough1');
    const pidTmp = await mkProject('FLKTMP', 'file-locks-tmp', cookie);
    await room(pidTmp).setFileLocking(pidTmp, { enabled: true });
    const tmpAgent = await seedAgent(pidTmp, 'agt_tmp_a');
    await room(pidTmp).acquireLocks(pidTmp, tmpAgent, tmpAgent.id, { paths: ['src/cascade-proj.ts'], allBranches: true });
    await room(pidTmp).deleteProject(pidTmp, human);
    expect(await anyRow('src/cascade-proj.ts')).toBeNull();
  });
});
