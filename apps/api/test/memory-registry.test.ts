// PLNR-246: the D1 Project Memory registry (migration 0069) — repository associations,
// health projection, routing authorization, and deletion coverage. Drives ProjectRoom's new
// registry RPCs directly (projectRoom helper, same technique as file-locks.test.ts) and the
// lib/project-memory.ts routing helper as a plain function call.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { Actor } from '../src/do/ProjectRoom';
import { projectRoom, createUser, mintTokenForUser, mcpCall, SYSTEM_ACTOR } from './helpers';
import { projectMemory, listProjectRepositories } from '../src/lib/project-memory';

const appEnv = env as unknown as Env;
const actor = SYSTEM_ACTOR as Actor;

interface RegistryRpc {
  registerRepository(pid: string, actor: Actor, repositoryKey: string): Promise<{ id: string }>;
  upsertMemoryHealth(pid: string, health: { schemaVersion: number; memoryRevision: number }): Promise<{ ok: true }>;
  deleteProject(pid: string, actor: Actor): Promise<{ ok: true; key: string; name: string }>;
  health(pid: string): Promise<{ schemaVersion: number; memoryRevision: number; tableCounts: Record<string, number> }>;
}

const room = (pid: string) => projectRoom<RegistryRpc>(pid);
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as { health: RegistryRpc['health'] };

async function newOwnedProject(email: string, key: string) {
  const user = await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  return { userId: user.id, projectId: proj.body.id as string };
}

describe('project_repositories registry', () => {
  it('registers two repositories with distinct keys in one project', async () => {
    const { projectId } = await newOwnedProject('pm-reg-a@example.com', 'PMREGA');
    await room(projectId).registerRepository(projectId, actor, 'repo-one');
    await room(projectId).registerRepository(projectId, actor, 'repo-two');
    const repos = await listProjectRepositories(appEnv, projectId);
    expect(repos.map((r) => r.repositoryKey).sort()).toEqual(['repo-one', 'repo-two']);
  });

  it('rejects a duplicate (project_id, repository_key)', async () => {
    const { projectId } = await newOwnedProject('pm-reg-b@example.com', 'PMREGB');
    await room(projectId).registerRepository(projectId, actor, 'dup-key');
    await expect(room(projectId).registerRepository(projectId, actor, 'dup-key')).rejects.toThrow(/already registered/);
  });

  it('the SAME repository key succeeds in a DIFFERENT project', async () => {
    const { projectId: pidA } = await newOwnedProject('pm-reg-c1@example.com', 'PMREGC1');
    const { projectId: pidB } = await newOwnedProject('pm-reg-c2@example.com', 'PMREGC2');
    await room(pidA).registerRepository(pidA, actor, 'shared-key');
    await room(pidB).registerRepository(pidB, actor, 'shared-key');
    expect((await listProjectRepositories(appEnv, pidA)).map((r) => r.repositoryKey)).toEqual(['shared-key']);
    expect((await listProjectRepositories(appEnv, pidB)).map((r) => r.repositoryKey)).toEqual(['shared-key']);
  });
});

describe('project_memory_registry health projection', () => {
  it('upserts and updates in place', async () => {
    const { projectId } = await newOwnedProject('pm-health@example.com', 'PMHEALTH');
    await room(projectId).upsertMemoryHealth(projectId, { schemaVersion: 1, memoryRevision: 0 });
    await room(projectId).upsertMemoryHealth(projectId, { schemaVersion: 1, memoryRevision: 5 });
    const row = await appEnv.DB.prepare('SELECT schema_version, memory_revision FROM project_memory_registry WHERE project_id = ?')
      .bind(projectId)
      .first<{ schema_version: number; memory_revision: number }>();
    expect(row).toEqual({ schema_version: 1, memory_revision: 5 });
  });
});

describe('projectMemory() routing — authorizes before routing, never the other way round', () => {
  it('returns a working stub for a user who can access the project', async () => {
    const { userId, projectId } = await newOwnedProject('pm-route-owner@example.com', 'PMROUTE1');
    const stub = await projectMemory(appEnv, userId, projectId);
    const h = await stub.health(projectId);
    expect(h.schemaVersion).toBe(5);
  });

  it('refuses a user who cannot access the project — a registry row grants nothing by itself', async () => {
    const { projectId } = await newOwnedProject('pm-route-owner2@example.com', 'PMROUTE2');
    await room(projectId).registerRepository(projectId, actor, 'some-repo');
    const outsider = await createUser('pm-route-outsider@example.com', 'Outsider', 'longenough1');
    await expect(projectMemory(appEnv, outsider.id, projectId)).rejects.toThrow(/not found/);
  });
});

describe('project deletion cascade (PLNR-246)', () => {
  it('removes registry/association rows and schedules ProjectMemory erasure', async () => {
    const { projectId } = await newOwnedProject('pm-delete@example.com', 'PMDELETE');
    await room(projectId).registerRepository(projectId, actor, 'to-be-deleted');
    await room(projectId).upsertMemoryHealth(projectId, { schemaVersion: 1, memoryRevision: 0 });
    await memory(projectId).health(projectId); // touch the DO so it has a live store to erase
    // Write a node directly so erase() has something to prove it removed.
    const stub = appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(projectId)) as unknown as {
      writeNode(pid: string, input: { type: string; uri: string; label: string; actor: { kind: string; id: string | null } }): Promise<{ nodeId: string }>;
    };
    await stub.writeNode(projectId, { type: 'unknown', uri: 'noriq://unknown/pre-delete', label: 'pre-delete', actor: { kind: 'system', id: null } });

    await room(projectId).deleteProject(projectId, actor);

    const repoRow = await appEnv.DB.prepare('SELECT 1 FROM project_repositories WHERE project_id = ?').bind(projectId).first();
    const healthRow = await appEnv.DB.prepare('SELECT 1 FROM project_memory_registry WHERE project_id = ?').bind(projectId).first();
    expect(repoRow).toBeNull();
    expect(healthRow).toBeNull();

    // Erasure is fire-and-forget (never blocks deleteProject) — poll briefly for it to land,
    // same technique dependencies.test.ts uses for onExternalBlockerSettled's cross-room notify.
    let erased = false;
    for (let i = 0; i < 10 && !erased; i++) {
      const h = await memory(projectId).health(projectId);
      erased = h.tableCounts.nodes === 0;
      if (!erased) await new Promise((r) => setTimeout(r, 50));
    }
    expect(erased).toBe(true);
  });
});
