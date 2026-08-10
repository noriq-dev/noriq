import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession } from './helpers';

let cookie: string;
let ownerId: string;
let projectId: string;
const fresh = new Date().toISOString();
const stale = '2020-01-01T00:00:00.000Z';

beforeAll(async () => {
  await createUser('runner-roster@example.com', 'Runner Owner', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('runner-roster@example.com', 'longenough1');
  ownerId = (await env.DB.prepare("SELECT id FROM users WHERE email = 'runner-roster@example.com'").first<{ id: string }>())!.id;
  const project = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'RNRS', name: 'Runner roster' }),
  });
  projectId = ((await project.json()) as { id: string }).id;
  const repos = JSON.stringify([{ id: 'repo', projectKey: 'RNRS', projectId, name: 'repo', defaultBranch: 'main', board: null, boardId: null, workflows: [] }]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO runners (id, owner_user_id, label, status, capabilities, repos, last_heartbeat_at, created_at)
       VALUES ('rnr_roster_active', ?, 'Active Runner', 'online', '{"tools":[],"kinds":[],"maxConcurrency":1}', ?, ?, ?)`,
    ).bind(ownerId, repos, fresh, fresh),
    env.DB.prepare(
      `INSERT INTO runners (id, owner_user_id, label, status, capabilities, repos, last_heartbeat_at, created_at)
       VALUES ('rnr_roster_dormant', ?, 'Dormant Runner', 'offline', '{"tools":[],"kinds":[],"maxConcurrency":1}', ?, ?, ?)`,
    ).bind(ownerId, repos, stale, stale),
    env.DB.prepare(
      `INSERT INTO runners (id, owner_user_id, label, status, capabilities, repos, last_heartbeat_at,
                            offboarded_at, retired_at, retire_reason, created_at)
       VALUES ('rnr_roster_history', ?, 'Historical Runner', 'offline', '{"tools":[],"kinds":[],"maxConcurrency":1}', ?, ?, ?, ?, 'runner_offboarded', ?)`,
    ).bind(ownerId, repos, stale, stale, stale, stale),
  ]);
});

async function roster(query: string) {
  const response = await SELF.fetch(`https://noriq.test/api/runners?${query}`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  return response.json<{
    runners: Array<{ id: string; lifecycle: string; retireReason: string | null; eligiblePurge: boolean }>;
    counts: { active: number; dormant: number; historical: number; total: number };
    page: { hasMore: boolean; nextCursor: string | null };
  }>();
}

describe('bounded Runner lifecycle roster (PLNR-368)', () => {
  it('separates Active, Dormant, and History using heartbeat and durable retirement facts', async () => {
    const active = await roster(`all=1&projectId=${projectId}&view=active`);
    const dormant = await roster(`all=1&projectId=${projectId}&view=dormant`);
    const history = await roster(`all=1&projectId=${projectId}&view=history&retireReason=runner_offboarded`);
    expect(active.runners.map((runner) => runner.id)).toContain('rnr_roster_active');
    expect(dormant.runners.map((runner) => runner.id)).toContain('rnr_roster_dormant');
    expect(history.runners).toContainEqual(expect.objectContaining({
      id: 'rnr_roster_history', lifecycle: 'retired', retireReason: 'runner_offboarded', eligiblePurge: true,
    }));
    expect(active.counts).toMatchObject({ active: 1, dormant: 1, historical: 1, total: 3 });
  });

  it('archives and restores visibility without reviving an offboarded Runner', async () => {
    const archived = await SELF.fetch('https://noriq.test/api/runners/rnr_roster_history/archive', {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(archived.status).toBe(200);
    expect((await roster(`all=1&projectId=${projectId}&lifecycle=archived`)).runners.map((runner) => runner.id))
      .toContain('rnr_roster_history');

    const restored = await SELF.fetch('https://noriq.test/api/runners/rnr_roster_history/restore-visibility', {
      method: 'POST', headers: { Cookie: cookie },
    });
    expect(restored.status).toBe(200);
    expect(await env.DB.prepare(
      'SELECT status, retired_at AS retiredAt, archived_at AS archivedAt FROM runners WHERE id = ?',
    ).bind('rnr_roster_history').first()).toMatchObject({ status: 'offline', retiredAt: stale, archivedAt: null });
  });

  it('rejects malformed lifecycle and cursor filters', async () => {
    expect((await SELF.fetch('https://noriq.test/api/runners?lifecycle=live', { headers: { Cookie: cookie } })).status).toBe(400);
    expect((await SELF.fetch('https://noriq.test/api/runners?cursor=bad', { headers: { Cookie: cookie } })).status).toBe(400);
  });
});
