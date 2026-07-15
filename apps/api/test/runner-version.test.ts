// RUN-36: a runner says what code it is running, and the server publishes what's current.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { compareVersions, isOutdated } from '../src/runner-release';
import { authorizeForAllProjects, createUser, loginSession, mintTokenForUser } from './helpers';

let token: string;
let cookie: string;

beforeAll(async () => {
  await createUser('version@example.com', 'Version', 'longenough1', 'member').catch(() => {});
  token = await mintTokenForUser('version@example.com');
  cookie = await loginSession('version@example.com', 'longenough1');
  await SELF.fetch('https://planar.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'VERS', name: 'version' }),
  });
  await authorizeForAllProjects(token);
}, 60000);

describe('compareVersions', () => {
  it('orders releases, and sorts a pre-release before its release', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0); // not string order
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
  });

  it('does not call an unknown version outdated — that would be inventing a fact', () => {
    // Unknown on EITHER side. A runner registered before version reporting has no version; and
    // a version feed we could not reach tells us nothing about the runner. "Unknown" and "old"
    // are different facts, and only one of them should nag.
    expect(isOutdated(null, '1.0.0')).toBe(false);
    expect(isOutdated('0.1.0', null)).toBe(false); // GitHub unreachable → not a verdict
    expect(isOutdated('0.1.0', '0.2.0')).toBe(true);
  });
});

describe('runner version (RUN-36)', () => {
  it('publishes the current release, unauthenticated and curl-able', async () => {
    // Proxies the runner repo's package.json (RUN-36). In the test worker the outbound fetch is
    // not available, so version may be null — the shape and the caching are what matter here,
    // and null-is-honest is asserted directly on isOutdated above.
    const res = await SELF.fetch('https://planar.test/api/runner/latest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string | null; minimum: string | null };
    expect(body).toHaveProperty('version');
    expect(res.headers.get('Cache-Control')).toContain('max-age');
  });

  it('records the version a runner reports, and derives outdated from it', async () => {
    const reg = await SELF.fetch('https://planar.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'versioned', version: '0.0.1' }),
    });
    const { runner } = (await reg.json()) as { runner: { id: string; version: string; outdated: boolean } };
    expect(runner.version).toBe('0.0.1');
    // `outdated` is derived against the live feed, so it is not asserted here — the test worker
    // has no outbound fetch, and a test that depended on GitHub would be flaky by construction.
    // The comparison itself is pinned on isOutdated/compareVersions above.
    expect(runner).toHaveProperty('outdated');
  });

  it('a runner that predates version reporting still registers, as unknown', async () => {
    const reg = await SELF.fetch('https://planar.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'ancient' }),
    });
    expect(reg.status).toBe(200);
    const { runner } = (await reg.json()) as { runner: { version: string | null; outdated: boolean } };
    expect(runner.version).toBeNull();
    expect(runner.outdated).toBe(false); // unknown ≠ outdated
  });
});
