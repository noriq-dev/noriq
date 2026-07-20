// PLNR-206/207: the file-lock MCP surface end-to-end (real /mcp calls) + the REST opt-in toggle +
// the contended-holder notice. Two agents under one user contend for the same path.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, authorizeForAllProjects, createUser, loginSession, mcpCall } from './helpers';

describe('file-lock MCP tools + REST toggle (PLNR-206/207)', () => {
  let A: { id: string; apiKey: string };
  let B: { id: string; apiKey: string };
  let pid: string;
  let cookie: string;

  beforeAll(async () => {
    A = await createAgent('lockA');
    B = await createAgent('lockB');
    pid = (await mcpCall(A.apiKey, 'create_project', { key: 'MLK', name: 'mcp-locks' })).body.id;
    await authorizeForAllProjects(A.apiKey, B.apiKey);
    // The agent-mint user owns projects created via createAgent's shared user; log in to drive REST.
    cookie = await loginSession('agent-mint@example.com', 'longenough1').catch(async () => {
      await createUser('agent-mint@example.com', 'Agent Mint', 'longenough1', 'admin');
      return loginSession('agent-mint@example.com', 'longenough1');
    });
    // Opt in via REST PATCH /meta (the enable surface).
    const patch = await SELF.fetch(`https://noriq.test/api/projects/${pid}/meta`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileLocking: true }),
    });
    expect(patch.status).toBe(200);
  }, 60000);

  it('the REST toggle enables locking and the project GET reflects it', async () => {
    const proj = (await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/snapshot`, { headers: { Cookie: cookie } })).json()) as { project: { fileLockingEnabled: number } };
    expect(proj.project.fileLockingEnabled).toBe(1);
  });

  it('acquire_lock grants, and a peer acquiring the same path is denied with holder info', async () => {
    const got = await mcpCall(A.apiKey, 'acquire_lock', { projectId: pid, paths: ['src/api/handler.ts'], branch: 'main' });
    expect(got.isError).toBeFalsy();
    expect(got.body.ok).toBe(true);

    const denied = await mcpCall(B.apiKey, 'acquire_lock', { projectId: pid, paths: ['src/api/handler.ts'], branch: 'main' });
    expect(denied.body.ok).toBe(false);
    expect(denied.body.conflicts[0].holderAgentId).toBe(A.id);
    expect(denied.body.conflicts[0].path).toBe('src/api/handler.ts');
  });

  it('surfaces a "peer blocked on your file" notice to the holder (PLNR-207)', async () => {
    // A held src/api/handler.ts above; B was just denied → A's next call should carry the notice.
    const mu = await mcpCall(A.apiKey, 'my_updates', {});
    expect((mu.body.notices as string[]).some((n) => n.includes('blocked') && n.includes('src/api/handler.ts'))).toBe(true);
  });

  it('check_locks reports the conflict without acquiring; list_locks shows the holder', async () => {
    const chk = await mcpCall(B.apiKey, 'check_locks', { projectId: pid, paths: ['src/api/handler.ts'], branch: 'main' });
    expect(chk.body.enabled).toBe(true);
    expect(chk.body.conflicts.length).toBeGreaterThan(0);

    const listed = await mcpCall(A.apiKey, 'list_locks', { projectId: pid, mine: true });
    expect(listed.body.locks.some((l: { canonPattern: string }) => l.canonPattern === 'src/api/handler.ts')).toBe(true);
  });

  it('is all-or-nothing across the MCP surface; release_lock frees the path', async () => {
    const partial = await mcpCall(B.apiKey, 'acquire_lock', { projectId: pid, paths: ['src/free.ts', 'src/api/handler.ts'], branch: 'main' });
    expect(partial.body.ok).toBe(false);
    const bLocks = await mcpCall(B.apiKey, 'list_locks', { projectId: pid, mine: true });
    expect(bLocks.body.locks.some((l: { canonPattern: string }) => l.canonPattern === 'src/free.ts')).toBe(false); // no partial grant

    await mcpCall(A.apiKey, 'release_lock', { projectId: pid, paths: ['src/api/handler.ts'] });
    const afterRelease = await mcpCall(B.apiKey, 'acquire_lock', { projectId: pid, paths: ['src/api/handler.ts'], branch: 'main' });
    expect(afterRelease.body.ok).toBe(true);
  });

  it('exposes live locks in the snapshot and a human can force-release one (PLNR-212/213)', async () => {
    await mcpCall(A.apiKey, 'acquire_lock', { projectId: pid, paths: ['src/panel.ts'], branch: 'main' });
    const snapFor = async () => (await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/snapshot`, { headers: { Cookie: cookie } })).json()) as { locks: Array<{ id: string; path: string; agentId: string }> };

    const lock = (await snapFor()).locks.find((l) => l.path === 'src/panel.ts');
    expect(lock).toBeTruthy();
    expect(lock!.agentId).toBe(A.id);

    const fr = await SELF.fetch(`https://noriq.test/api/projects/${pid}/locks/${lock!.id}/force-release`, { method: 'POST', headers: { Cookie: cookie } });
    expect(fr.status).toBe(200);
    expect((await snapFor()).locks.find((l) => l.path === 'src/panel.ts')).toBeFalsy(); // gone after force-release
  });

  it('acquire_lock errors clearly on a project that has not enabled locking', async () => {
    const off = (await mcpCall(A.apiKey, 'create_project', { key: 'MLKOFF', name: 'mcp-locks-off' })).body.id;
    const res = await mcpCall(A.apiKey, 'acquire_lock', { projectId: off, paths: ['x.ts'], branch: 'main' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not enabled/);
  });
});
