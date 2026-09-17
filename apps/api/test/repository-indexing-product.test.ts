// Product gate: repository index ingest and operator generation routes are off unless REPOSITORY_INDEXING=1.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  createUser, loginSession, mintTestIngestToken, mintTokenForUser, seedOnlineRunnerForToken, SYSTEM_ACTOR,
} from './helpers';

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

describe('repository indexing product gate (default off)', () => {
  it('ops-status reports repositoryIndexing=false', async () => {
    await createUser('rix-status@example.com', 'Rix', 'longenough1').catch(() => {});
    const cookie = await loginSession('rix-status@example.com', 'longenough1');
    const projectId = await ownedProject(cookie, 'RIXST1');
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/ops-status`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { capabilities: { repositoryIndexing: boolean } };
    expect(body.capabilities.repositoryIndexing).toBe(false);
  });

  it('rejects index-purpose memory-ingest with 410', async () => {
    await createUser('rix-ingest@example.com', 'RixIn', 'longenough1').catch(() => {});
    const cookie = await loginSession('rix-ingest@example.com', 'longenough1');
    const projectId = await ownedProject(cookie, 'RIXING');
    const ownerToken = await mintTokenForUser('rix-ingest@example.com');
    const runnerId = await seedOnlineRunnerForToken(ownerToken, { projectId });
    const cap = await mintTestIngestToken(ownerToken, {
      projectId,
      repositoryKey: 'repo-a',
      purpose: 'index',
      scopeId: 'gen_gate',
      runnerId,
      checkoutId: 'ckt_gate',
    });
    const res = await SELF.fetch(`https://noriq.test/api/memory-ingest/${cap}/begin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generationId: 'gen_gate',
        branch: 'main',
        baseId: 'sha',
        indexerVersion: 'v1',
        batchCount: 1,
        fileCount: 0,
        contentHash: '0'.repeat(64),
        deletions: [],
        createdAt: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(410);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not a Noriq product capability/i);
  });

  it('admin activate/abort generation routes return 410', async () => {
    await createUser('rix-admin@example.com', 'RixAd', 'longenough1', 'admin').catch(() => {});
    const cookie = await loginSession('rix-admin@example.com', 'longenough1');
    const projectId = await ownedProject(cookie, 'RIXADM');
    for (const path of [
      `/api/projects/${projectId}/memory/generations/gen_x/activate`,
      `/api/projects/${projectId}/memory/generations/gen_x/abort`,
    ]) {
      const res = await SELF.fetch(`https://noriq.test${path}`, { method: 'POST', headers: { Cookie: cookie } });
      expect(res.status).toBe(410);
    }
  });

  it('GET repositories omits index-generation enrichment when indexing is off', async () => {
    await createUser('rix-repo@example.com', 'RixRepo', 'longenough1').catch(() => {});
    const cookie = await loginSession('rix-repo@example.com', 'longenough1');
    const projectId = await ownedProject(cookie, 'RIXREP');
    const room = appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(projectId)) as unknown as {
      registerRepository(pid: string, actor: { kind: string; id: string | null }, key: string): Promise<unknown>;
    };
    await room.registerRepository(projectId, SYSTEM_ACTOR, 'legacy-repo');
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/repositories`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { repositories: Array<{ repositoryKey: string; stale: boolean; stagedGenerations: unknown[] }> };
    const repo = body.repositories.find((r) => r.repositoryKey === 'legacy-repo');
    expect(repo?.stale).toBe(false);
    expect(repo?.stagedGenerations).toEqual([]);
  });
});
