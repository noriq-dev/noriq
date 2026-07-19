// PLNR-200: plan-local docs — working documents scoped to one plan. The three ways they
// diverge from project docs are the point, and each is asserted here: NOT indexed / not a
// project doc, NO settled-only contract (open questions allowed), and scoped to the plan
// (they die with it).
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

describe('plan-local docs (PLNR-200)', () => {
  let apiKey: string;
  let projectId: string;
  let planId: string;
  let cookie: string;

  beforeAll(async () => {
    const agent = await createAgent('plan-docs-agent');
    apiKey = agent.apiKey;
    projectId = (await mcpCall(apiKey, 'create_project', { key: 'PLDC', name: 'plandocs' })).body.id;
    planId = (await mcpCall(apiKey, 'create_plan', {
      projectId, title: 'Rebuild checkout', body: '# Goals\n\nShip it.',
      phases: [{ title: 'Phase 1', newTasks: [{ title: 'task a' }] }],
    })).body.id;
    // A human session that owns the project — create_project ran as the agent-mint user, who
    // is an admin, so this cookie can drive the REST + delete paths below.
    cookie = await loginSession('agent-mint@example.com', 'longenough1').catch(async () => {
      await createUser('agent-mint@example.com', 'Agent Mint', 'longenough1', 'admin');
      return loginSession('agent-mint@example.com', 'longenough1');
    });
  }, 60000);

  it('surfaces in get_plans (summary) + get_plan_doc (full body), and is NOT a project doc', async () => {
    const created = await mcpCall(apiKey, 'create_plan_doc', {
      projectId, planId, name: 'Design notes', description: 'gateway sketch', body: '# Sketch\n\nProvisional.',
    });
    expect(created.isError).toBeFalsy();
    const docId = created.body.id;

    const plan = (await mcpCall(apiKey, 'get_plans', { projectId })).body.plans.find((p: { id: string }) => p.id === planId);
    const summary = plan.docs.find((d: { name: string }) => d.name === 'Design notes');
    expect(summary).toBeTruthy();
    expect(summary.body).toBeUndefined(); // summaries only — body fetched on demand

    const full = await mcpCall(apiKey, 'get_plan_doc', { projectId, docId });
    expect(full.body.doc.body).toContain('Provisional');
    expect(full.body.doc.planId).toBe(planId);

    // The key divergence: a plan doc is never indexed and never appears among PROJECT docs.
    const docs = (await mcpCall(apiKey, 'list_docs', { projectId })).body.docs;
    expect(docs).toHaveLength(0);
  });

  it('carries NO settled-only contract — TBD / open-question bodies are accepted', async () => {
    const created = await mcpCall(apiKey, 'create_plan_doc', {
      projectId, planId, name: 'Open items',
      body: '# Open\n\nTBD: shard key.\nShould we shard by user or by project?',
    });
    expect(created.isError).toBeFalsy(); // create_doc would REJECT this body (doclint)
    const upd = await mcpCall(apiKey, 'update_plan_doc', { projectId, docId: created.body.id, body: 'still WIP — open question?' });
    expect(upd.isError).toBeFalsy();
  });

  it('is scoped to its plan — a second plan sees none of the first plan’s docs', async () => {
    const plan2 = (await mcpCall(apiKey, 'create_plan', {
      projectId, title: 'Other plan', phases: [{ title: 'P1', newTasks: [{ title: 'x' }] }],
    })).body.id;
    const plan = (await mcpCall(apiKey, 'get_plans', { projectId })).body.plans.find((p: { id: string }) => p.id === plan2);
    expect(plan.docs).toHaveLength(0);
  });

  it('human REST: create / patch / delete, and the snapshot carries planDocs with body', async () => {
    const rest = (path: string, method: string, body?: unknown) =>
      SELF.fetch(`https://noriq.test/api/projects/${projectId}${path}`, {
        method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });

    const create = await rest(`/plans/${planId}/docs`, 'POST', { name: 'Human note', body: 'from the UI' });
    expect(create.status).toBe(200);
    const { id } = (await create.json()) as { id: string };

    const snap = (await (await rest('/snapshot', 'GET')).json()) as { planDocs: Array<{ id: string; planId: string; body: string }> };
    const inSnap = snap.planDocs.find((d) => d.id === id)!;
    expect(inSnap.body).toBe('from the UI');
    expect(inSnap.planId).toBe(planId);

    expect((await rest(`/plans/${planId}/docs/${id}`, 'PATCH', { body: 'edited' })).status).toBe(200);
    expect((await rest(`/plans/${planId}/docs/${id}`, 'DELETE')).status).toBe(200);
  });

  it('deleting a plan reaps its plan docs (cascade)', async () => {
    const doomed = (await mcpCall(apiKey, 'create_plan', {
      projectId, title: 'Doomed', phases: [{ title: 'P1', newTasks: [{ title: 'x' }] }],
    })).body.id;
    const docId = (await mcpCall(apiKey, 'create_plan_doc', { projectId, planId: doomed, name: 'ephemeral' })).body.id;
    const del = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/plans/${doomed}`, { method: 'DELETE', headers: { Cookie: cookie } });
    expect(del.status).toBe(200);
    const row = await env.DB.prepare('SELECT id FROM plan_docs WHERE id = ?').bind(docId).first();
    expect(row).toBeNull();
  });

  it('deleting the project reaps plan docs (cascade)', async () => {
    const pid = (await mcpCall(apiKey, 'create_project', { key: 'PLDD', name: 'doomed proj' })).body.id;
    const plan = (await mcpCall(apiKey, 'create_plan', { projectId: pid, title: 'P', phases: [{ title: 'P1', newTasks: [{ title: 'x' }] }] })).body.id;
    const docId = (await mcpCall(apiKey, 'create_plan_doc', { projectId: pid, planId: plan, name: 'gone-soon' })).body.id;
    const del = await SELF.fetch(`https://noriq.test/api/projects/${pid}`, { method: 'DELETE', headers: { Cookie: cookie } });
    expect(del.status).toBe(200);
    const row = await env.DB.prepare('SELECT id FROM plan_docs WHERE id = ?').bind(docId).first();
    expect(row).toBeNull();
  });
});
