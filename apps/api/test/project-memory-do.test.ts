// PLNR-245: the ProjectMemory Durable Object and its local schema migrator. Drives the DO's
// public RPC methods directly via its stub (same technique as file-locks.test.ts) — no HTTP
// surface exists yet, since REST/MCP wiring is a later phase.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { ProjectMemoryHealth } from '../src/do/ProjectMemory';

const appEnv = env as unknown as Env;

interface ProjectMemoryRpc {
  health(pid: string): Promise<ProjectMemoryHealth>;
  writeNode(pid: string, input: { type: string; uri: string; label: string; actor: { kind: string; id: string | null } }): Promise<{ nodeId: string }>;
  _countNodes(pid: string): Promise<number>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as ProjectMemoryRpc;
const SYSTEM = { kind: 'system', id: null };

describe('ProjectMemory — schema migrator', () => {
  it('initializes to the current schema version with every canonical table empty', async () => {
    const pid = 'prj_pm_fresh';
    const h = await memory(pid).health(pid);
    expect(h.schemaVersion).toBe(13);
    expect(h.memoryRevision).toBe(0);
    expect(Object.values(h.tableCounts).every((n) => n === 0)).toBe(true);
    expect(h.tableCounts.nodes).toBe(0);
  });

  it('is repeatable: re-touching an already-migrated store preserves seeded data', async () => {
    const pid = 'prj_pm_repeat';
    await memory(pid).health(pid); // first construction — runs the migrator
    await memory(pid).writeNode(pid, { type: 'unknown', uri: `noriq://unknown/seed_1`, label: 'seeded node', actor: SYSTEM });

    // A second stub handle for the SAME idFromName — whether the runtime reuses the live
    // instance or reconstructs it from storage, the migrator must not re-run destructively.
    const again = await memory(pid).health(pid);
    expect(again.schemaVersion).toBe(13);
    expect(again.tableCounts.nodes).toBe(1);

    const count = await memory(pid)._countNodes(pid);
    expect(count).toBe(1);
  });

  it('answers its health RPC with no VECTORIZE, Queues, or Workflows bound (this suite binds none)', async () => {
    const pid = 'prj_pm_no_optional_bindings';
    expect(appEnv.VECTORIZE).toBeUndefined();
    const h = await memory(pid).health(pid);
    expect(h.schemaVersion).toBe(13);
  });
});

describe('ProjectMemory — project isolation', () => {
  it('two project ids are physically isolated stores', async () => {
    const pidA = 'prj_pm_iso_a';
    const pidB = 'prj_pm_iso_b';
    await memory(pidA).writeNode(pidA, { type: 'unknown', uri: 'noriq://unknown/a', label: 'a', actor: SYSTEM });
    await memory(pidA).writeNode(pidA, { type: 'unknown', uri: 'noriq://unknown/a2', label: 'a2', actor: SYSTEM });

    const healthA = await memory(pidA).health(pidA);
    const healthB = await memory(pidB).health(pidB);
    expect(healthA.tableCounts.nodes).toBe(2);
    expect(healthB.tableCounts.nodes).toBe(0);
  });

  it('rejects an RPC whose projectId does not match the bound instance', async () => {
    const pidA = 'prj_pm_wrong_a';
    const pidB = 'prj_pm_wrong_b';
    const stub = memory(pidA);
    await stub.health(pidA); // binds this instance to pidA
    await expect(stub.writeNode(pidB, { type: 'unknown', uri: 'noriq://unknown/x', label: 'x', actor: SYSTEM })).rejects.toThrow(/projectId mismatch/);
  });
});
