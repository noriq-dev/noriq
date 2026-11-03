import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { syncCopilotSession } from '../src/lib/copilot-session';
import { createOrchestration, declareExecution } from '../src/lib/orchestration-store';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;

async function fixture(name: string) {
  const agent = await createAgent(name);
  const projectId = (await mcpCall(agent.apiKey, 'create_project', {
    key: name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8), name,
  })).body.id as string;
  const actor = await env.DB.prepare(
    'SELECT user_id AS userId, role, oauth_token_id AS tokenId FROM agents WHERE id = ?',
  ).bind(agent.id).first<{ userId: string; role: 'worker' | 'orchestrator'; tokenId: string }>();
  const presence = await env.DB.prepare(
    `SELECT id, actor_id AS actorId, parent_presence_id AS parentPresenceId,
            state, ended_at AS endedAt FROM agent_presences WHERE actor_id = ? AND kind = 'mcp_session'`,
  ).bind(agent.id).first<{ id: string; actorId: string; parentPresenceId: string | null; state: string; endedAt: string | null }>();
  if (!actor || !presence) throw new Error('missing session fixture');
  const sync = () => syncCopilotSession(appEnv, actor.tokenId,
    { id: agent.id, userId: actor.userId, role: actor.role },
    { meaningful: true, projectId });
  return { agent, actor, presence, projectId, sync };
}

describe('Copilot session execution recovery', () => {
  it('converges concurrent session requests on one node and one orchestration', async () => {
    const { agent, presence, projectId, sync } = await fixture('session-bootstrap-race');
    await Promise.all(Array.from({ length: 8 }, () => sync()));
    const nodes = await env.DB.prepare(
      `SELECT id, status, orchestration_id AS orchestrationId FROM execution_nodes
        WHERE producer_scope = ? AND local_node_key = 'session'`,
    ).bind(`mcp-session/${presence.id}/${projectId}`).all<{
      id: string; status: string; orchestrationId: string;
    }>();
    expect(nodes.results).toHaveLength(1);
    expect(nodes.results[0]?.status).toBe('running');
    const roots = await env.DB.prepare(
      'SELECT id, root_execution_id AS rootId FROM orchestrations WHERE project_id = ? AND created_by_id = ?',
    ).bind(projectId, agent.id).all<{ id: string; rootId: string | null }>();
    expect(roots.results).toEqual([{ id: nodes.results[0]?.orchestrationId, rootId: nodes.results[0]?.id }]);
  });

  it('finishes a committed pending node and repairs a stale orchestration on retry', async () => {
    const { agent, presence, projectId, sync } = await fixture('session-start-recovery');
    const orchestration = await createOrchestration(appEnv, {
      projectId, anchor: { type: 'none' }, createdBy: { kind: 'copilot', id: agent.id },
      completeness: { status: 'partial', missing: ['parent'], reason: 'immediate_parent_unknown' },
    });
    const node = await declareExecution(appEnv, {
      projectId, orchestrationId: orchestration.id,
      producerScope: `mcp-session/${presence.id}/${projectId}`, localNodeKey: 'session',
      kind: 'copilot_session', role: 'worker', actor: { kind: 'copilot', id: agent.id },
      presenceId: presence.id,
      completeness: { status: 'partial', missing: ['parent'], reason: 'immediate_parent_unknown' },
      observedAt: new Date().toISOString(),
    });
    await sync();
    expect(await env.DB.prepare('SELECT status, last_revision AS revision FROM execution_nodes WHERE id = ?')
      .bind(node.id).first()).toMatchObject({ status: 'running', revision: 1 });
    await env.DB.prepare("UPDATE orchestrations SET status = 'pending' WHERE id = ?")
      .bind(orchestration.id).run();
    await sync();
    expect(await env.DB.prepare('SELECT status FROM orchestrations WHERE id = ?')
      .bind(orchestration.id).first()).toMatchObject({ status: 'running' });
  });

  it('keeps a later conflicting parent hint rejected', async () => {
    const { agent, actor, projectId, sync } = await fixture('session-parent-guard');
    await sync();
    const parentOrchestration = await createOrchestration(appEnv, {
      projectId, anchor: { type: 'none' }, createdBy: { kind: 'copilot', id: agent.id },
    });
    const parent = await declareExecution(appEnv, {
      projectId, orchestrationId: parentOrchestration.id,
      producerScope: `test-parent/${agent.id}`, localNodeKey: 'parent',
      kind: 'stage', role: 'worker', actor: { kind: 'copilot', id: agent.id },
      observedAt: new Date().toISOString(),
    });
    await expect(syncCopilotSession(appEnv, actor.tokenId,
      { id: agent.id, userId: actor.userId, role: actor.role },
      { meaningful: true, projectId, lineage: { parentExecutionId: parent.id } },
    )).rejects.toThrow('session execution already has a different immutable parent');
  });
});
