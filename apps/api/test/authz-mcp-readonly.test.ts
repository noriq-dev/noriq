import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, mcpCall, mintTokenForUser } from './helpers';

const EMAIL = 'mcp-readonly-authz@example.com';
let token = '';
let userId = '';
let projectId = '';

describe('MCP account and project policy (PLNR-329)', () => {
  beforeAll(async () => {
    await createUser(EMAIL, 'MCP readonly', 'longenough1').catch(() => {});
    token = await mintTokenForUser(EMAIL);
    const identity = await mcpCall(token, 'set_agent_identity', { name: 'readonly-policy-agent', role: 'worker' });
    expect(identity.isError).toBe(false);
    const project = await mcpCall(token, 'create_project', { key: 'MROAZ', name: 'MCP readonly policy' });
    expect(project.isError).toBe(false);
    projectId = project.body.id;
    const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(EMAIL).first<{ id: string }>();
    userId = row!.id;
    await env.DB.prepare("UPDATE users SET access_mode = 'read_only' WHERE id = ?").bind(userId).run();
  });

  afterAll(async () => {
    if (userId) await env.DB.prepare("UPDATE users SET access_mode = 'read_write' WHERE id = ?").bind(userId).run();
  });

  it('keeps viewer tools available while applying the account-wide write ceiling', async () => {
    const read = await mcpCall(token, 'get_project', { projectId });
    expect(read.isError).toBe(false);

    const write = await mcpCall(token, 'create_task', {
      projectId,
      title: 'must not be created',
      tags: ['authorization'],
    });
    expect(write.isError).toBe(true);
    expect(write.text).toContain('account is read-only');

    const audit = await env.DB.prepare(
      `SELECT action, decision, reason, metadata
         FROM authorization_audit_events
        WHERE actor_kind = 'agent' AND resource_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(projectId).first<{ action: string; decision: string; reason: string; metadata: string }>();
    expect(audit).toMatchObject({ action: 'mcp.tool', decision: 'deny', reason: 'account_read_only' });
    expect(JSON.parse(audit!.metadata)).toEqual({
      tool: 'create_task', requiredAction: 'contribute', transport: 'mcp',
    });
  });
});
