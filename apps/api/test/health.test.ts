import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

describe('noriq worker', () => {
  it('health check reports D1 connectivity and the real package version (PLNR-193)', async () => {
    const res = await SELF.fetch('https://noriq.test/api/health');
    expect(res.status).toBe(200);
    // version drives the SPA's deploy self-refresh — it must track package.json,
    // never a hardcoded string that goes stale.
    expect(await res.json()).toMatchObject({ ok: true, service: 'noriq', version: pkg.version });
  });

  it('UI API requires a session', async () => {
    const res = await SELF.fetch('https://noriq.test/api/projects');
    expect(res.status).toBe(401);
  });

  it('ws route requires an upgrade', async () => {
    const res = await SELF.fetch('https://noriq.test/ws/projects/demo');
    expect(res.status).toBe(426);
  });
});
