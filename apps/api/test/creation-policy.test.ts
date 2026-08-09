import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginSession, mcpCall, mintTokenForUser } from './helpers';

const EMAIL = 'creation-policy@example.com';
const json = { 'Content-Type': 'application/json' };
let cookie = '';
let token = '';
let userId = '';

beforeAll(async () => {
  await createUser(EMAIL, 'Creation policy', 'longenough1').catch(() => {});
  cookie = await loginSession(EMAIL, 'longenough1');
  token = await mintTokenForUser(EMAIL);
  const identity = await mcpCall(token, 'set_agent_identity', { name: 'creation-policy-agent', role: 'worker' });
  expect(identity.isError).toBe(false);
  userId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(EMAIL).first<{ id: string }>())!.id;
  await env.DB.prepare('UPDATE users SET can_create_projects = 0, can_create_groups = 0 WHERE id = ?').bind(userId).run();
});

describe('account creation policy (PLNR-330)', () => {
  it('denies REST project and group creation with capability-aware errors', async () => {
    const project = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, ...json }, body: JSON.stringify({ key: 'DENIED', name: 'Denied' }),
    });
    expect(project.status).toBe(403);
    expect(await project.json()).toMatchObject({ code: 'project_creation_denied', capability: 'canCreateProjects' });

    const group = await SELF.fetch('https://noriq.test/api/groups', {
      method: 'POST', headers: { Cookie: cookie, ...json }, body: JSON.stringify({ name: 'Denied' }),
    });
    expect(group.status).toBe(403);
    expect(await group.json()).toMatchObject({ code: 'group_creation_denied', capability: 'canCreateGroups' });
  });

  it('does not let MCP bypass the project creation policy', async () => {
    const result = await mcpCall(token, 'create_project', { key: 'MCPDENY', name: 'Denied' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('project creation denied');
  });
});
