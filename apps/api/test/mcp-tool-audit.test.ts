// PLNR-356: inventory-driven validation for every MCP tool. This test intentionally operates on
// the captured registration specs and on the real tools/list response; adding a tool without a
// policy, schema, authorization floor, or host-visible registration must fail here.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { auditMcpCatalog } from '../src/mcp-tool-audit';
import { MCP_TOOL_POLICIES, mcpReferenceSpecs } from '../src/mcp';
import { authorizeForAllProjects, createUser, mcpCall, mcpList, mintTokenForUser } from './helpers';

describe('complete MCP tool contract audit', () => {
  it('has one explicit, valid policy and schema for every registered tool', () => {
    const specs = mcpReferenceSpecs();
    const audit = auditMcpCatalog(specs);
    expect(audit.findings).toEqual([]);
    expect(audit.valid).toBe(true);
    expect(audit.toolCount).toBe(69);
    expect(Object.keys(MCP_TOOL_POLICIES).sort()).toEqual(specs.tools.map((tool) => tool.name).sort());
  });

  it('legacy Copilots receive the same complete names, schemas, annotations, and floors', async () => {
    const token = await mintTokenForUser('mcp-catalog-audit@example.com');
    const live = await mcpList(token) as Array<{
      name: string;
      description: string;
      inputSchema: { properties?: Record<string, unknown> };
      annotations: Record<string, unknown>;
    }>;
    const specs = mcpReferenceSpecs();
    expect(live.map((tool) => tool.name).sort()).toEqual(specs.tools.map((tool) => tool.name).sort());
    for (const tool of live) {
      expect(tool.description.length, tool.name).toBeGreaterThan(39);
      expect(tool.annotations.openWorldHint, tool.name).toBe(false);
      expect(tool.inputSchema.properties, tool.name).toBeDefined();
    }
    expect(live.find((tool) => tool.name === 'request_input')!.inputSchema.properties).toHaveProperty('blocking');
  });

  it('requires contributor access on both sides of a cross-project task move', async () => {
    const aliceEmail = 'mcp-move-source@example.com';
    const bobEmail = 'mcp-move-target@example.com';
    await createUser(aliceEmail, 'Alice', 'longenough1').catch(() => {});
    await createUser(bobEmail, 'Bob', 'longenough1').catch(() => {});
    const alice = await mintTokenForUser(aliceEmail);
    const bob = await mintTokenForUser(bobEmail);
    const source = (await mcpCall(alice, 'create_project', { key: 'AUDSRC', name: 'Audit source' })).body.id as string;
    const target = (await mcpCall(bob, 'create_project', { key: 'AUDTGT', name: 'Audit target' })).body.id as string;
    const task = (await mcpCall(alice, 'create_task', { projectId: source, title: 'Do not plant through viewer access', tags: ['mcp-tools'] })).body;
    const aliceUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(aliceEmail).first<{ id: string }>();
    await env.DB.prepare("INSERT INTO project_grants (project_id, principal_type, principal_id, role) VALUES (?, 'user', ?, 'viewer')")
      .bind(target, aliceUser!.id).run();
    await authorizeForAllProjects(alice);

    const denied = await mcpCall(alice, 'move_task', { projectId: source, taskId: task.id, toProjectId: target });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/target project contributor role required/i);

    await env.DB.prepare("UPDATE project_grants SET role = 'contributor' WHERE project_id = ? AND principal_type = 'user' AND principal_id = ?")
      .bind(target, aliceUser!.id).run();
    const moved = await mcpCall(alice, 'move_task', { projectId: source, taskId: task.id, toProjectId: target });
    expect(moved.isError).toBe(false);
    expect(moved.body.projectId).toBe(target);
  });
});
