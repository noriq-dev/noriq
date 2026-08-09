import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectAccess } from '../src/lib/authorization';

const OWNER = 'usr_authz_perf_owner';
const USER = 'usr_authz_perf_user';
const PROJECT = 'prj_authz_perf';
const GROUP_COUNT = 160;
const groups = Array.from({ length: GROUP_COUNT }, (_, index) => `grp_authz_perf_${index}`);

async function batches(statements: D1PreparedStatement[], size = 80): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += size) {
    await env.DB.batch(statements.slice(offset, offset + size));
  }
}

describe('authorization at high-cardinality group membership (PLNR-337)', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Authz perf owner', 'member')")
        .bind(OWNER, 'authz-perf-owner@example.test'),
      env.DB.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Authz perf user', 'member')")
        .bind(USER, 'authz-perf-user@example.test'),
      env.DB.prepare("INSERT INTO projects (id, key, name, owner_user_id) VALUES (?, 'AUTHPERF', 'Authorization performance', ?)")
        .bind(PROJECT, OWNER),
    ]);
    await batches(groups.map((group, index) => env.DB.prepare(
      'INSERT INTO groups (id, name, created_by) VALUES (?, ?, ?)',
    ).bind(group, `Authorization performance ${index}`, OWNER)));
    await batches(groups.map((group) => env.DB.prepare(
      "INSERT INTO user_groups (user_id, group_id, status, role) VALUES (?, ?, 'accepted', 'member')",
    ).bind(USER, group)));
    await batches(groups.map((group, index) => env.DB.prepare(
      `INSERT INTO project_grants (project_id, principal_type, principal_id, role)
       VALUES (?, 'group', ?, ?)`,
    ).bind(PROJECT, group, index === GROUP_COUNT - 1 ? 'manager' : index % 2 ? 'contributor' : 'viewer')));
  });

  afterAll(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM project_grants WHERE project_id = ?').bind(PROJECT),
      env.DB.prepare('DELETE FROM user_groups WHERE user_id = ?').bind(USER),
      env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(PROJECT),
    ]);
    await batches(groups.map((group) => env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(group)));
    await env.DB.prepare('DELETE FROM users WHERE id IN (?, ?)').bind(OWNER, USER).run();
  });

  it('selects the strongest grant without scanning unrelated authorization rows', async () => {
    const started = performance.now();
    const access = await resolveProjectAccess(env.DB, USER, PROJECT);
    const elapsedMs = performance.now() - started;

    expect(access.role).toBe('manager');
    expect(access.source).toBe('group_grant');
    // A deliberately loose regression ceiling: this catches accidental N+1/group-by-group
    // authorization while leaving ample room for shared CI hosts and workerd startup noise.
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it('uses indexed lookups for the group-grant join', async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT pg.role
         FROM project_grants pg
         JOIN user_groups ug ON ug.group_id = pg.principal_id
        WHERE pg.project_id = ?
          AND pg.principal_type = 'group'
          AND ug.user_id = ?
          AND ug.status = 'accepted'`,
    ).bind(PROJECT, USER).all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join('\n');
    expect(detail).toMatch(/(?:sqlite_autoindex_project_grants|idx_project_grants)/);
    expect(detail).toMatch(/(?:sqlite_autoindex_user_groups|idx_user_groups)/);
  });
});
