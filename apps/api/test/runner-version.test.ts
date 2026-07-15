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
    // A runner registered before version reporting has none. "Unknown" and "old" are different.
    expect(isOutdated(null)).toBe(false);
  });
});

describe('runner version (RUN-36)', () => {
  it('publishes the current release, unauthenticated and curl-able', async () => {
    const res = await SELF.fetch('https://planar.test/api/runner/latest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; minimum: string | null };
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.headers.get('Cache-Control')).toContain('max-age');
  });

  it('records the version a runner reports, and derives outdated from it', async () => {
    const reg = await SELF.fetch('https://planar.test/api/runners', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'versioned', version: '0.0.1' }),
    });
    const { runner } = (await reg.json()) as { runner: { id: string; version: string; outdated: boolean } };
    expect(runner.version).toBe('0.0.1');
    // Derived, not stored: "current" moves when the server ships, so a stored flag would be
    // wrong the moment a release lands.
    expect(runner.outdated).toBe(true);
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
