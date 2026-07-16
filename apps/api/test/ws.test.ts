// PLNR-91: the /ws/projects/:id upgrade must be authenticated + authorized.
// Previously it forwarded straight to the ProjectRoom DO with no check, so an
// anonymous client could `subscribe` and stream any project's entire event log
// (task/comment/message bodies) — ids are the guessable prj_<key>.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

let ownerCookie: string;
let outsiderCookie: string;
let projectId: string;

const wsFetch = (pid: string, headers: Record<string, string>) =>
  SELF.fetch(`https://noriq.test/ws/projects/${pid}`, { headers: { Upgrade: 'websocket', ...headers } });

beforeAll(async () => {
  await createUser('ws-owner@example.com', 'WS Owner', 'longenough1').catch(() => {});
  await createUser('ws-outsider@example.com', 'WS Outsider', 'longenough1').catch(() => {});
  ownerCookie = await loginSession('ws-owner@example.com', 'longenough1');
  outsiderCookie = await loginSession('ws-outsider@example.com', 'longenough1');
  const p = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'WSP', name: 'WS project' }),
  });
  projectId = (await p.json() as { id: string }).id;
}, 60000);

describe('WebSocket upgrade is authenticated + authorized (PLNR-91)', () => {
  it('rejects an anonymous (no-cookie) upgrade with 401', async () => {
    expect((await wsFetch(projectId, {})).status).toBe(401);
  });

  it("rejects a signed-in outsider who can't see the project (404)", async () => {
    expect((await wsFetch(projectId, { Cookie: outsiderCookie })).status).toBe(404);
  });

  it('refuses a cross-origin upgrade (403) even with a valid cookie', async () => {
    expect((await wsFetch(projectId, { Cookie: ownerCookie, Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('treats a malformed Origin as cross-origin (403, not a 500 crash)', async () => {
    expect((await wsFetch(projectId, { Cookie: ownerCookie, Origin: 'not-a-url' })).status).toBe(403);
  });

  it('lets the owner complete the upgrade (101)', async () => {
    const res = await wsFetch(projectId, { Cookie: ownerCookie });
    expect(res.status).toBe(101); // upgrade accepted for a project the user can reach
  });

  it('still returns 426 for a non-upgrade GET', async () => {
    const res = await SELF.fetch(`https://noriq.test/ws/projects/${projectId}`, { headers: { Cookie: ownerCookie } });
    expect(res.status).toBe(426);
  });
});
