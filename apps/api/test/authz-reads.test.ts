// PLNR-97: unscoped REST reads (task detail, task events, agent roster, agent
// events, attachment download) must be gated to a project the caller can reach.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

let ownerCookie: string;
let outsiderCookie: string;
let adminCookie: string;
let projectId: string;
let taskId: string;
let attId: string;

const get = (path: string, cookie: string) =>
  SELF.fetch(`https://planar.test${path}`, { headers: { Cookie: cookie } });

beforeAll(async () => {
  await createUser('rd-owner@example.com', 'RD Owner', 'longenough1').catch(() => {});
  await createUser('rd-out@example.com', 'RD Out', 'longenough1').catch(() => {});
  await createUser('rd-admin@example.com', 'RD Admin', 'longenough1', 'admin').catch(() => {});
  ownerCookie = await loginSession('rd-owner@example.com', 'longenough1');
  outsiderCookie = await loginSession('rd-out@example.com', 'longenough1');
  adminCookie = await loginSession('rd-admin@example.com', 'longenough1');

  const p = await SELF.fetch('https://planar.test/api/projects', {
    method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'RDP', name: 'Reads' }),
  });
  projectId = (await p.json() as { id: string }).id;
  const t = await SELF.fetch(`https://planar.test/api/projects/${projectId}/tasks`, {
    method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'private task' }),
  });
  taskId = (await t.json() as { id: string }).id;
  const a = await SELF.fetch(`https://planar.test/api/tasks/${taskId}/attachments?filename=s.txt`, {
    method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'text/plain' }, body: 'secret',
  });
  attId = (await a.json() as { id: string }).id;
}, 60000);

describe('unscoped REST reads are project-gated (PLNR-97)', () => {
  it('GET /api/tasks/:tid — outsider 404, owner + admin 200', async () => {
    expect((await get(`/api/tasks/${taskId}`, outsiderCookie)).status).toBe(404);
    expect((await get(`/api/tasks/${taskId}`, ownerCookie)).status).toBe(200);
    expect((await get(`/api/tasks/${taskId}`, adminCookie)).status).toBe(200);
  });

  it('GET /api/tasks/:tid/events — outsider 404, owner 200', async () => {
    expect((await get(`/api/tasks/${taskId}/events`, outsiderCookie)).status).toBe(404);
    expect((await get(`/api/tasks/${taskId}/events`, ownerCookie)).status).toBe(200);
  });

  it('GET /api/agents?projectId — outsider 404, owner 200', async () => {
    expect((await get(`/api/agents?projectId=${projectId}`, outsiderCookie)).status).toBe(404);
    expect((await get(`/api/agents?projectId=${projectId}`, ownerCookie)).status).toBe(200);
  });

  it('GET /api/attachments/:aid — outsider 404, owner 200', async () => {
    expect((await get(`/api/attachments/${attId}`, outsiderCookie)).status).toBe(404);
    expect((await get(`/api/attachments/${attId}`, ownerCookie)).status).toBe(200);
  });
});
