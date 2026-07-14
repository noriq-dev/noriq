import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('noriq worker', () => {
  it('health check reports D1 connectivity', async () => {
    const res = await SELF.fetch('https://planar.test/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'noriq' });
  });

  it('UI API requires a session', async () => {
    const res = await SELF.fetch('https://planar.test/api/projects');
    expect(res.status).toBe(401);
  });

  it('ws route requires an upgrade', async () => {
    const res = await SELF.fetch('https://planar.test/ws/projects/demo');
    expect(res.status).toBe(426);
  });
});
