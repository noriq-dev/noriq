import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

describe('catalog revision 2 minimum Runner version gate', () => {
  let cookie: string;
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    const email = 'runner-version-gate@example.com';
    await createUser(email, 'Runner Version Gate', 'longenough1', 'member').catch(() => {});
    cookie = await loginSession(email, 'longenough1');
    ownerId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind(email).first<{ id: string }>())!.id;
    const project = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'RVGATE', name: 'Runner version gate' }),
    });
    projectId = ((await project.json()) as { id: string }).id;
  }, 60_000);

  async function dispatchWithVersion(version: string | null): Promise<Response> {
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const runnerId = `rnr_gate_${suffix}`;
    const repoRef = `repo_gate_${suffix}`;
    const repos = JSON.stringify([{
      id: repoRef,
      repoRef,
      projectId,
      baseRevision: 'a'.repeat(40),
    }]);
    await env.DB.prepare(
      "INSERT INTO runners (id, owner_user_id, label, status, repos, version) VALUES (?, ?, 'version gate', 'online', ?, ?)",
    ).bind(runnerId, ownerId, repos, version).run();
    const task = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Version gate ${suffix}` }),
    });
    const taskId = ((await task.json()) as { id: string }).id;
    return SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks/${taskId}/runner-jobs`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, repoRef }),
    });
  }

  it('refuses old and unknown Runners with an explicit upgrade response', async () => {
    for (const version of ['0.15.9', null]) {
      const response = await dispatchWithVersion(version);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'runner 0.16.0 or newer is required for MCP catalog revision 2',
        runnerVersion: version,
      });
    }
  });

  it('allows a compatible Runner to commission a new RunnerJob', async () => {
    const response = await dispatchWithVersion('v0.16.0');
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ job: { status: 'queued' } });
  });
});
