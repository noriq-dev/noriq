// MCP attachments (add_attachment tool + noriq://attachment/<id> resource).
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall, mcpRpc } from './helpers';

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let agent: { id: string; apiKey: string };
let projectId: string;
let taskId: string;

beforeAll(async () => {
  agent = await createAgent('att-tester');
  const proj = await mcpCall(agent.apiKey, 'create_project', { key: 'ATT', name: 'attachments' });
  projectId = proj.body.id;
  const t = await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'has a screenshot' });
  taskId = t.body.id;
}, 60000);

describe('MCP attachments', () => {
  it('add_attachment stores bytes and returns a resource URI', async () => {
    const r = await mcpCall(agent.apiKey, 'add_attachment', {
      projectId, taskId, filename: 'shot.png', data: PNG_B64, contentType: 'image/png',
    });
    expect(r.isError).toBe(false);
    expect(r.body.resource).toBe(`noriq://attachment/${r.body.id}`);
    expect(r.body.contentType).toBe('image/png');
    expect(r.body.size).toBeGreaterThan(0);
  });

  it('resources/read returns the bytes back as base64 blob', async () => {
    const add = await mcpCall(agent.apiKey, 'add_attachment', {
      projectId, taskId, filename: 'again.png', data: PNG_B64, contentType: 'image/png',
    });
    const read = await mcpRpc(agent.apiKey, 'resources/read', { uri: add.body.resource });
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0].mimeType).toBe('image/png');
    // Round-trips exactly (standard base64).
    expect(read.contents[0].blob).toBe(PNG_B64);
    expect(read.contents[0].text).toBeUndefined();
  });

  it('text attachments come back as text, not blob', async () => {
    const body = 'hello from a log\nline two';
    const data = btoa(body);
    const add = await mcpCall(agent.apiKey, 'add_attachment', {
      projectId, taskId, filename: 'run.log', data, contentType: 'text/plain',
    });
    const read = await mcpRpc(agent.apiKey, 'resources/read', { uri: add.body.resource });
    expect(read.contents[0].text).toBe(body);
    expect(read.contents[0].blob).toBeUndefined();
  });

  it('get_task surfaces attachments with their resource URIs', async () => {
    const gt = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(gt.body.attachments.length).toBeGreaterThanOrEqual(3);
    for (const a of gt.body.attachments) {
      expect(a.resource).toBe(`noriq://attachment/${a.id}`);
    }
  });

  it('resources/list enumerates recent attachments', async () => {
    const list = await mcpRpc(agent.apiKey, 'resources/list', {});
    expect(Array.isArray(list.resources)).toBe(true);
    expect(list.resources.some((r: { uri: string }) => r.uri.startsWith('noriq://attachment/'))).toBe(true);
  });

  it('serves images inline (viewable), other types as download', async () => {
    await createUser('att-viewer@example.com', 'Att Viewer', 'longenough1', 'admin').catch(() => {});
    const cookie = await loginSession('att-viewer@example.com', 'longenough1');

    const png = await mcpCall(agent.apiKey, 'add_attachment', {
      projectId, taskId, filename: 'inline.png', data: PNG_B64, contentType: 'image/png',
    });
    const log = await mcpCall(agent.apiKey, 'add_attachment', {
      projectId, taskId, filename: 'notes.bin', data: btoa('bytes'), contentType: 'application/octet-stream',
    });

    const pngRes = await SELF.fetch(`https://noriq.test/api/attachments/${png.body.id}`, { headers: { Cookie: cookie } });
    expect(pngRes.headers.get('Content-Type')).toBe('image/png');
    expect(pngRes.headers.get('Content-Disposition')).toMatch(/^inline/);

    const logRes = await SELF.fetch(`https://noriq.test/api/attachments/${log.body.id}`, { headers: { Cookie: cookie } });
    expect(logRes.headers.get('Content-Disposition')).toMatch(/^attachment/);
  });

  it('forces download for scriptable same-origin markup (PLNR-99)', async () => {
    await createUser('att-xss@example.com', 'Att XSS', 'longenough1', 'admin').catch(() => {});
    const cookie = await loginSession('att-xss@example.com', 'longenough1');

    // text/html, svg and xhtml execute in the app origin if served inline — they MUST download.
    const scriptable = [
      { filename: 'evil.html', contentType: 'text/html' },
      { filename: 'evil.svg', contentType: 'image/svg+xml' },
      { filename: 'evil.xhtml', contentType: 'application/xhtml+xml' },
      { filename: 'evil.html', contentType: 'text/html; charset=utf-8' },
    ];
    for (const s of scriptable) {
      const att = await mcpCall(agent.apiKey, 'add_attachment', {
        projectId, taskId, data: btoa('<script>alert(1)</script>'), ...s,
      });
      const res = await SELF.fetch(`https://noriq.test/api/attachments/${att.body.id}`, { headers: { Cookie: cookie } });
      expect(res.headers.get('Content-Disposition'), s.contentType).toMatch(/^attachment/);
    }

    // A charset param on an allowlisted type still previews inline.
    const txt = await mcpCall(agent.apiKey, 'add_attachment', {
      projectId, taskId, filename: 'notes.txt', data: btoa('hello'), contentType: 'text/plain; charset=utf-8',
    });
    const txtRes = await SELF.fetch(`https://noriq.test/api/attachments/${txt.body.id}`, { headers: { Cookie: cookie } });
    expect(txtRes.headers.get('Content-Disposition')).toMatch(/^inline/);
  });

  it('rejects a bad task', async () => {
    const r = await mcpCall(agent.apiKey, 'add_attachment', {
      projectId, taskId: 'task_nope', filename: 'x.png', data: PNG_B64,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });

  it('caps inline add_attachment and points oversized payloads at the upload tool (PLNR-173)', async () => {
    const big = btoa('x'.repeat(17 * 1024)); // 17 KB decoded, over the 16 KB inline limit
    const r = await mcpCall(agent.apiKey, 'add_attachment', { projectId, taskId, filename: 'big.bin', data: big });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/create_attachment_upload/);
  });
});

describe('capability-token attachment upload (PLNR-173)', () => {
  const bytes = Uint8Array.from(atob(PNG_B64), (ch) => ch.charCodeAt(0));

  it('mints an upload URL, PUT lands the file, and it reads back through the resource URI', async () => {
    const mint = await mcpCall(agent.apiKey, 'create_attachment_upload', {
      projectId, taskId, filename: 'huge.png', contentType: 'image/png',
    });
    expect(mint.isError).toBe(false);
    expect(mint.body.uploadUrl).toContain('/api/attachments/upload/');
    expect(mint.body.resourceUri).toBe(`noriq://attachment/${mint.body.attachmentId}`);
    expect(mint.body.curl).toContain('--data-binary @<FILE>');

    const put = await SELF.fetch(mint.body.uploadUrl, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes,
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { size: number }).size).toBe(bytes.length);

    // The bytes never touched an MCP tool call, but read back the same way.
    const read = await mcpRpc(agent.apiKey, 'resources/read', { uri: mint.body.resourceUri });
    expect(read.contents[0].blob).toBe(PNG_B64);

    const gt = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(gt.body.attachments.some((a: { id: string }) => a.id === mint.body.attachmentId)).toBe(true);
  });

  it('a replayed PUT stays a single attachment row (idempotent on attachmentId)', async () => {
    const mint = await mcpCall(agent.apiKey, 'create_attachment_upload', { projectId, taskId, filename: 'once.png', contentType: 'image/png' });
    const put = () => SELF.fetch(mint.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes });
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(200);
    const gt = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(gt.body.attachments.filter((a: { id: string }) => a.id === mint.body.attachmentId)).toHaveLength(1);
  });

  it('rejects a tampered or bogus token', async () => {
    const mint = await mcpCall(agent.apiKey, 'create_attachment_upload', { projectId, taskId, filename: 'nope.png' });
    const tampered = mint.body.uploadUrl.slice(0, -2) + (mint.body.uploadUrl.endsWith('AA') ? 'BB' : 'AA');
    expect((await SELF.fetch(tampered, { method: 'PUT', body: bytes })).status).toBe(401);
    expect((await SELF.fetch('https://noriq.test/api/attachments/upload/not.a.token', { method: 'PUT', body: bytes })).status).toBe(401);
  });
});
