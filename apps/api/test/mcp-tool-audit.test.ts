// PLNR-356: inventory-driven validation for every MCP tool. This test intentionally operates on
// the captured registration specs and on the real tools/list response; adding a tool without a
// policy, schema, authorization floor, or host-visible registration must fail here.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { auditMcpCatalog } from '../src/mcp-tool-audit';
import { MCP_TOOL_AUDIENCE, MCP_TOOL_POLICIES, mcpReferenceSpecs } from '../src/mcp';
import { authorizeForAllProjects, createUser, mcpCall, mcpList, mcpRpc, mintTokenForUser } from './helpers';

const REMOVED_TOOLS = ['create_task', 'decompose_task', 'spin_off_task', 'update_task', 'add_dependency', 'remove_dependency', 'attach_ref', 'add_comment', 'read_open_comments', 'list_projects', 'create_plan_from_template', 'get_task_intelligence', 'add_attachment', 'create_attachment_upload', 'set_agent_identity', 'focus_project'];

describe('complete MCP tool contract audit', () => {
  it('has one explicit, valid policy and schema for every registered tool', () => {
    const specs = mcpReferenceSpecs();
    const audit = auditMcpCatalog(specs);
    expect(audit.findings).toEqual([]);
    expect(audit.valid).toBe(true);
    expect(audit.toolCount).toBe(56);
    expect(Object.keys(MCP_TOOL_POLICIES).sort()).toEqual(specs.tools.map((tool) => tool.name).sort());
    expect(Object.keys(MCP_TOOL_AUDIENCE).sort()).toEqual(specs.tools.map((tool) => tool.name).sort());
    expect(specs.tools.filter((tool) => tool.audience === 'core')).toHaveLength(34);
  });

  it('Copilots receive every non-runner tool by default', async () => {
    const token = await mintTokenForUser('mcp-catalog-audit@example.com');
    const live = await mcpList(token) as Array<{
      name: string;
      description: string;
      inputSchema: { properties?: Record<string, unknown> };
      annotations: Record<string, unknown>;
    }>;
    const specs = mcpReferenceSpecs();
    expect(live.map((tool) => tool.name).sort()).toEqual(specs.tools.filter((tool) => tool.audience !== 'runner').map((tool) => tool.name).sort());
    expect(live).toHaveLength(55);
    expect(live.some((tool) => tool.name === 'can_claim')).toBe(false);
    const freshSession = await mcpList(token, 'fresh-copilot-session');
    expect(freshSession.map((tool) => tool.name).sort()).toEqual(live.map((tool) => tool.name).sort());
    for (const removed of REMOVED_TOOLS) {
      expect(live.some((tool) => tool.name === removed), removed).toBe(false);
    }
    for (const tool of live) {
      expect(tool.description.length, tool.name).toBeGreaterThan(39);
      expect(tool.annotations.openWorldHint, tool.name).toBe(false);
      expect(tool.inputSchema.properties, tool.name).toBeDefined();
    }
    expect(live.find((tool) => tool.name === 'request_input')!.inputSchema.properties).toHaveProperty('blocking');
  });

  it('rejects every removed tool name instead of preserving hidden aliases', async () => {
    const token = await mintTokenForUser('mcp-catalog-removed@example.com');
    for (const removed of REMOVED_TOOLS) {
      const result = await mcpRpc(token, 'tools/call', { name: removed, arguments: {} }) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      expect(result.isError, removed).toBe(true);
      expect(result.content?.[0]?.text, removed).toMatch(/not found/i);
    }
  });

  it('does not expose a self-service tool-catalog switch through configure_agent', async () => {
    const token = await mintTokenForUser('mcp-catalog-packs@example.com');
    const live = await mcpList(token) as Array<{
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
    }>;
    expect(live).toHaveLength(55);
    expect(live.some((tool) => tool.name === 'create_plan')).toBe(true);
    expect(live.some((tool) => tool.name === 'create_project')).toBe(true);
    expect(live.some((tool) => tool.name === 'create_orchestration')).toBe(true);

    const configure = live.find((tool) => tool.name === 'configure_agent')!;
    expect(configure.inputSchema.properties).not.toHaveProperty('toolPacks');

    const rejected = await mcpCall(token, 'configure_agent', { toolPacks: ['planning'] });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/requires at least one field/i);
    expect(await mcpList(token)).toHaveLength(55);
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
    const batch = (await mcpCall(alice, 'create_tasks', { projectId: source, tasks: [{ title: 'Do not plant through viewer access', tags: ['mcp-tools'] }] })).body;
    const task = batch.created[0];
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
