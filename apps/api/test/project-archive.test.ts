// PLNR-567: project soft-archive / restore via projects.status.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let cookie: string;
let agent: { id: string; apiKey: string };

beforeAll(async () => {
  agent = await createAgent('arch-proj-agent');
  await createUser('arch-proj@example.com', 'Arch Proj', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('arch-proj@example.com', 'longenough1');
}, 60000);

const list = (qs = '') =>
  SELF.fetch(`https://noriq.test/api/projects${qs}`, { headers: { Cookie: cookie } });

describe('project archive (PLNR-567)', () => {
  it('archives out of the default list, keeps data, and restores', async () => {
    // Create via REST so the session user owns it (MCP mint agents own their creates;
    // admin default list is own-projects-only — PLNR-83).
    const created = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'ARCHP', name: 'Archive Me' }),
    });
    expect(created.status).toBe(200);
    const p = await created.json() as { id: string; key: string };
    const taskRes = await SELF.fetch(`https://noriq.test/api/projects/${p.id}/tasks`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'survives archive', tags: ['test-fixture'] }),
    });
    expect(taskRes.status).toBe(200);

    const before = await (await list()).json() as { projects: Array<{ id: string; status: string }> };
    expect(before.projects.some((row) => row.id === p.id)).toBe(true);

    const archived = await SELF.fetch(`https://noriq.test/api/projects/${p.id}/archive`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(archived.status).toBe(200);
    const archivedBody = await archived.json() as { ok: true; status: string; archived: boolean };
    expect(archivedBody).toMatchObject({ ok: true, status: 'archived', archived: true });

    const active = await (await list()).json() as { projects: Array<{ id: string }> };
    expect(active.projects.some((row) => row.id === p.id)).toBe(false);

    const hidden = await (await list('?archived=1')).json() as { projects: Array<{ id: string; status: string; key: string }> };
    const row = hidden.projects.find((item) => item.id === p.id);
    expect(row).toMatchObject({ id: p.id, key: 'ARCHP', status: 'archived' });

    // Data is intact — snapshot still works for an archived project.
    const snap = await SELF.fetch(`https://noriq.test/api/projects/${p.id}/snapshot`, { headers: { Cookie: cookie } });
    expect(snap.status).toBe(200);
    const snapBody = await snap.json() as { tasks: Array<{ title: string }> };
    expect(snapBody.tasks.some((t) => t.title === 'survives archive')).toBe(true);

    const status = await env.DB.prepare('SELECT status FROM projects WHERE id = ?').bind(p.id).first<{ status: string }>();
    expect(status?.status).toBe('archived');

    const restored = await SELF.fetch(`https://noriq.test/api/projects/${p.id}/restore`, {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ ok: true, status: 'active', archived: false });

    const again = await (await list()).json() as { projects: Array<{ id: string; status: string }> };
    expect(again.projects.find((item) => item.id === p.id)?.status).toBe('active');
    expect((await (await list('?archived=1')).json() as { projects: Array<{ id: string }> }).projects.some((item) => item.id === p.id)).toBe(false);
  });

  it('emits project.archived / project.restored events', async () => {
    const p = (await mcpCall(agent.apiKey, 'create_project', { key: 'ARCHE', name: 'Event Archive' })).body as { id: string };
    expect((await SELF.fetch(`https://noriq.test/api/projects/${p.id}/archive`, {
      method: 'POST', headers: { Cookie: cookie },
    })).status).toBe(200);
    const afterArchive = await env.DB.prepare(
      "SELECT verb FROM events WHERE project_id = ? AND verb = 'project.archived' ORDER BY seq DESC LIMIT 1",
    ).bind(p.id).first<{ verb: string }>();
    expect(afterArchive?.verb).toBe('project.archived');

    expect((await SELF.fetch(`https://noriq.test/api/projects/${p.id}/restore`, {
      method: 'POST', headers: { Cookie: cookie },
    })).status).toBe(200);
    const afterRestore = await env.DB.prepare(
      "SELECT verb FROM events WHERE project_id = ? AND verb = 'project.restored' ORDER BY seq DESC LIMIT 1",
    ).bind(p.id).first<{ verb: string }>();
    expect(afterRestore?.verb).toBe('project.restored');
  });

  it('refuses archive/restore without owner role', async () => {
    const p = (await mcpCall(agent.apiKey, 'create_project', { key: 'ARCHZ', name: 'No Own' })).body as { id: string };
    await createUser('arch-viewer@example.com', 'Arch Viewer', 'longenough1', 'member').catch(() => {});
    const viewerCookie = await loginSession('arch-viewer@example.com', 'longenough1');
    await env.DB.prepare(
      "INSERT INTO project_grants (project_id, principal_type, principal_id, role) VALUES (?, 'user', (SELECT id FROM users WHERE email = ?), 'viewer')",
    ).bind(p.id, 'arch-viewer@example.com').run();

    const denied = await SELF.fetch(`https://noriq.test/api/projects/${p.id}/archive`, {
      method: 'POST', headers: { Cookie: viewerCookie },
    });
    expect(denied.status).toBe(403);
  });
});
