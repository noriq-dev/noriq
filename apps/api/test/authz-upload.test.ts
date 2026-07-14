// PLNR-98: attachment upload must (a) require project access on the target task,
// and (b) size the file from the stored bytes, not the client Content-Length.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

let ownerCookie: string;
let outsiderCookie: string;
let taskId: string;

const upload = (tid: string, cookie: string, body: BodyInit, init: RequestInit = {}) =>
  SELF.fetch(`https://planar.test/api/tasks/${tid}/attachments?filename=f.txt`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body, ...init,
  });

beforeAll(async () => {
  await createUser('up-owner@example.com', 'UP Owner', 'longenough1').catch(() => {});
  await createUser('up-out@example.com', 'UP Out', 'longenough1').catch(() => {});
  ownerCookie = await loginSession('up-owner@example.com', 'longenough1');
  outsiderCookie = await loginSession('up-out@example.com', 'longenough1');
  const p = await SELF.fetch('https://planar.test/api/projects', {
    method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'UPP', name: 'Upload' }),
  });
  const pid = (await p.json() as { id: string }).id;
  const t = await SELF.fetch(`https://planar.test/api/projects/${pid}/tasks`, {
    method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'target' }),
  });
  taskId = (await t.json() as { id: string }).id;
}, 60000);

describe('attachment upload authz + real size (PLNR-98)', () => {
  it("an outsider cannot upload to another user's task", async () => {
    expect((await upload(taskId, outsiderCookie, 'sneaky')).status).toBe(404);
  });

  it('the owner can upload; stored size is the actual byte length', async () => {
    const r = await upload(taskId, ownerCookie, 'hello world'); // 11 bytes
    expect(r.status).toBe(200);
    expect((await r.json() as { size: number }).size).toBe(11);
  });

  it('sizes a streamed (no Content-Length) upload from the stored bytes, not the header', async () => {
    const stream = new Response('streamed-content').body!; // 16 bytes, chunked → no Content-Length
    const r = await upload(taskId, ownerCookie, stream, { duplex: 'half' } as RequestInit);
    expect(r.status).toBe(200);
    expect((await r.json() as { size: number }).size).toBe(16);
  });
});
