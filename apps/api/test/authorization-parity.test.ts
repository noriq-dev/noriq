import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditAuthorizationParity, reconcileLegacyGroupGrants } from '../src/lib/authorization-parity';

const owner = 'usr_parity_owner';
const member = 'usr_parity_member';
const group = 'grp_parity';
const project = 'prj_parity';

describe('authorization migration parity gate (PLNR-336)', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, name, role) VALUES (?, 'parity-owner@example.test', 'Parity Owner', 'member')").bind(owner),
      env.DB.prepare("INSERT INTO users (id, email, name, role) VALUES (?, 'parity-member@example.test', 'Parity Member', 'member')").bind(member),
      env.DB.prepare('INSERT INTO groups (id, name, created_by) VALUES (?, ?, ?)').bind(group, 'Parity group', owner),
      env.DB.prepare("INSERT INTO user_groups (user_id, group_id, status, role) VALUES (?, ?, 'accepted', 'owner')").bind(owner, group),
      env.DB.prepare("INSERT INTO user_groups (user_id, group_id, status, role) VALUES (?, ?, 'accepted', 'member')").bind(member, group),
      env.DB.prepare("INSERT INTO projects (id, key, name, owner_user_id, group_id, claim_ttl_seconds) VALUES (?, 'PARITY', 'Parity project', ?, ?, 1800)").bind(project, owner, group),
    ]);
  });

  afterAll(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM project_grants WHERE project_id = ?').bind(project),
      env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(project),
      env.DB.prepare('DELETE FROM user_groups WHERE group_id = ?').bind(group),
      env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(group),
      env.DB.prepare('DELETE FROM users WHERE id IN (?, ?)').bind(owner, member),
    ]);
  });

  it('reports lost legacy access, reconciles it idempotently, and opens the retirement gate', async () => {
    const before = await auditAuthorizationParity(env.DB);
    expect(before.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: member, projectId: project, legacyReach: true, grantReach: false }),
    ]));
    expect(await reconcileLegacyGroupGrants(env.DB, project)).toBe(1);
    expect(await reconcileLegacyGroupGrants(env.DB, project)).toBe(0);
    const after = await auditAuthorizationParity(env.DB);
    expect(after.differences.find((d) => d.userId === member && d.projectId === project)).toBeUndefined();
  });
});
