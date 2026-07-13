import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('planar worker', () => {
  it('health check reports D1 connectivity', async () => {
    const res = await SELF.fetch('https://planar.test/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'planar' });
  });

  it('lists projects from D1', async () => {
    const res = await SELF.fetch('https://planar.test/api/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    expect(Array.isArray(body.projects)).toBe(true);
  });

  it('MCP endpoint is stubbed with 501', async () => {
    const res = await SELF.fetch('https://planar.test/mcp', { method: 'POST' });
    expect(res.status).toBe(501);
  });

  it('ws route requires an upgrade', async () => {
    const res = await SELF.fetch('https://planar.test/ws/projects/demo');
    expect(res.status).toBe(426);
  });
});
