import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

let adminCookie: string;
let ownerCookie: string;
let ownerId: string;
let successorId: string;
let projectId: string;

const json = { 'Content-Type': 'application/json' };

beforeAll(async () => {
  await createUser('lifecycle-admin@example.com', 'Lifecycle Admin', 'longenough1', 'admin').catch(() => {});
  await createUser('lifecycle-owner@example.com', 'Lifecycle Owner', 'longenough1').catch(() => {});
  await createUser('lifecycle-successor@example.com', 'Lifecycle Successor', 'longenough1').catch(() => {});
  adminCookie = await loginSession('lifecycle-admin@example.com', 'longenough1');
  ownerCookie = await loginSession('lifecycle-owner@example.com', 'longenough1');
  ownerId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'lifecycle-owner@example.com'")
    .first<{ id: string }>())!.id;
  successorId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'lifecycle-successor@example.com'")
    .first<{ id: string }>())!.id;

  const project = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST',
    headers: { Cookie: ownerCookie, ...json },
    body: JSON.stringify({ key: 'OWNLIFE', name: 'Ownership lifecycle' }),
  });
  projectId = (await project.json() as { id: string }).id;
}, 60000);

describe('project owner lifecycle (PLNR-327)', () => {
  it('does not allow project ownership to be cleared or transferred to a missing user', async () => {
    const clear = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/meta`, {
      method: 'PATCH', headers: { Cookie: adminCookie, ...json }, body: JSON.stringify({ ownerUserId: null }),
    });
    expect(clear.status).toBe(400);

    const missing = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/meta`, {
      method: 'PATCH', headers: { Cookie: adminCookie, ...json }, body: JSON.stringify({ ownerUserId: 'usr_missing' }),
    });
    expect(missing.status).toBe(400);
    expect((await env.DB.prepare('SELECT owner_user_id AS owner FROM projects WHERE id = ?')
      .bind(projectId).first<{ owner: string }>())!.owner).toBe(ownerId);
  });

  it('blocks user deletion until every owned project is explicitly transferred', async () => {
    const disable = await SELF.fetch(`https://noriq.test/api/users/${ownerId}`, {
      method: 'PATCH', headers: { Cookie: adminCookie, ...json }, body: JSON.stringify({ disabled: true }),
    });
    expect(disable.status).toBe(200);

    const blocked = await SELF.fetch(`https://noriq.test/api/users/${ownerId}`, {
      method: 'DELETE', headers: { Cookie: adminCookie },
    });
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json() as { ownedProjects: Array<{ id: string }> };
    expect(blockedBody.ownedProjects.map((p) => p.id)).toContain(projectId);
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(ownerId).first()).not.toBeNull();

    const transfer = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/meta`, {
      method: 'PATCH', headers: { Cookie: adminCookie, ...json }, body: JSON.stringify({ ownerUserId: successorId }),
    });
    expect(transfer.status).toBe(200);

    const removed = await SELF.fetch(`https://noriq.test/api/users/${ownerId}`, {
      method: 'DELETE', headers: { Cookie: adminCookie },
    });
    expect(removed.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(ownerId).first()).toBeNull();
    expect((await env.DB.prepare('SELECT owner_user_id AS owner FROM projects WHERE id = ?')
      .bind(projectId).first<{ owner: string }>())!.owner).toBe(successorId);
  });
});
