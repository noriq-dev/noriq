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
  const t = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'has a screenshot' });
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

    const pngRes = await SELF.fetch(`https://planar.test/api/attachments/${png.body.id}`, { headers: { Cookie: cookie } });
    expect(pngRes.headers.get('Content-Type')).toBe('image/png');
    expect(pngRes.headers.get('Content-Disposition')).toMatch(/^inline/);

    const logRes = await SELF.fetch(`https://planar.test/api/attachments/${log.body.id}`, { headers: { Cookie: cookie } });
    expect(logRes.headers.get('Content-Disposition')).toMatch(/^attachment/);
  });

  it('rejects a bad task', async () => {
    const r = await mcpCall(agent.apiKey, 'add_attachment', {
      projectId, taskId: 'task_nope', filename: 'x.png', data: PNG_B64,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });
});
