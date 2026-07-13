import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

// NOTE: runs in the same shared-storage suite as coordination.test.ts;
// setup endpoints are exercised first while no users beyond ours may exist.

describe('first-run setup', () => {
  it('reports and performs setup exactly once', async () => {
    const before = await SELF.fetch('https://planar.test/api/setup/status');
    const status = (await before.json()) as { needsSetup: boolean };

    if (status.needsSetup) {
      const res = await SELF.fetch('https://planar.test/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'founder@example.com', name: 'Founder', password: 'longenough1' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Set-Cookie')).toContain('planar_session=');
    }

    // Now configured: further setup attempts are refused.
    const after = await SELF.fetch('https://planar.test/api/setup/status');
    expect(((await after.json()) as { needsSetup: boolean }).needsSetup).toBe(false);
    const again = await SELF.fetch('https://planar.test/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'evil@example.com', name: 'X', password: 'hackhackhack' }),
    });
    expect(again.status).toBe(409);
  });
});

describe('plans & groups', () => {
  let planner: { id: string; apiKey: string };
  let worker: { id: string; apiKey: string };
  let cookie: string;
  let projectId: string;

  beforeAll(async () => {
    planner = await createAgent('planner', 'orchestrator');
    worker = await createAgent('drone');
    // Setup may have been consumed by another suite (shared storage) — ensure the user exists either way.
    cookie = await loginSession('founder@example.com', 'longenough1').catch(async () => {
      await createUser('founder@example.com', 'Founder', 'longenough1', 'admin');
      return loginSession('founder@example.com', 'longenough1');
    });
    const proj = await mcpCall(planner.apiKey, 'create_project', { key: 'PLZ', name: 'plans-project' });
    projectId = proj.body.id;
  });

  it('create_plan builds enforced phase ordering', async () => {
    const plan = await mcpCall(planner.apiKey, 'create_plan', {
      projectId,
      title: 'Ship the feature',
      description: 'One-line summary',
      body: '# Goals\n\nShip it **properly**.\n\n## Exit gate\n\nAll e2e green.',
      phases: [
        { title: 'Foundations', body: 'Schema first — see `docs/00`.', newTasks: [{ title: 'schema' }, { title: 'api scaffold' }] },
        { title: 'Build', newTasks: [{ title: 'implement endpoints' }] },
        { title: 'Verify', newTasks: [{ title: 'e2e tests' }] },
      ],
    });
    expect(plan.body.phases).toHaveLength(3);

    // Phase-2 task is dep-blocked until phase-1 tasks are done.
    const buildTask = plan.body.phases[1].taskIds[0];
    const blocked = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: buildTask });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('blocked');

    // Phase-1 tasks are claimable.
    const p1 = plan.body.phases[0].taskIds[0];
    const ok = await mcpCall(worker.apiKey, 'claim_task', { projectId, taskId: p1 });
    expect(ok.isError).toBe(false);
  });

  it('get_plans reports per-phase progress and carries the documents', async () => {
    const plans = await mcpCall(planner.apiKey, 'get_plans', { projectId });
    expect(plans.body.plans).toHaveLength(1);
    expect(plans.body.plans[0].body).toContain('# Goals');
    const phases = plans.body.plans[0].phases;
    expect(phases[0].total).toBe(2);
    expect(phases[0].done).toBe(0);
    expect(phases[0].body).toContain('Schema first');
    expect(phases[0].taskKeys).toContain('PLZ-1');
  });

  it('update_plan revises the document; phases patchable too', async () => {
    const plans = await mcpCall(planner.apiKey, 'get_plans', { projectId });
    const plan = plans.body.plans[0];
    const upd = await mcpCall(planner.apiKey, 'update_plan', {
      projectId, planId: plan.id,
      body: plan.body + '\n\n> **Status:** foundations landed.',
    });
    expect(upd.isError).toBe(false);
    const phaseUpd = await mcpCall(planner.apiKey, 'update_plan', {
      projectId, planId: plan.id, phaseId: plan.phases[0].id, phaseBody: 'Schema done — see migration 0001.',
    });
    expect(phaseUpd.isError).toBe(false);
    const after = await mcpCall(planner.apiKey, 'get_plans', { projectId });
    expect(after.body.plans[0].body).toContain('foundations landed');
    expect(after.body.plans[0].phases[0].body).toContain('migration 0001');
  });

  it('snapshot exposes plans/phases/phaseTasks for the UI', async () => {
    const res = await SELF.fetch(`https://planar.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } });
    const snap = (await res.json()) as any;
    expect(snap.plans).toHaveLength(1);
    expect(snap.phases).toHaveLength(3);
    expect(snap.phaseTasks.length).toBe(4);
  });

  it('new projects default to a 30-minute claim TTL', async () => {
    const proj = await mcpCall(planner.apiKey, 'get_project', { projectId });
    expect(proj.body.project.claimTtlSeconds).toBe(1800);
  });

  it('groups can be created and projects assigned', async () => {
    const g = await SELF.fetch('https://planar.test/api/groups', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Platform' }),
    });
    expect(g.status).toBe(200);
    const { id: groupId } = (await g.json()) as { id: string };
    const patch = await SELF.fetch(`https://planar.test/api/projects/${projectId}/meta`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    expect(patch.status).toBe(200);
    const list = await SELF.fetch('https://planar.test/api/projects', { headers: { Cookie: cookie } });
    const { projects } = (await list.json()) as { projects: Array<{ id: string; groupId: string | null }> };
    expect(projects.find((p) => p.id === projectId)?.groupId).toBe(groupId);
  });

  it('static key issuance is gone; revoking an OAuth agent kills its access', async () => {
    // The old issuance endpoint must be dead (OAuth-only — PLNR-52).
    const issue = await SELF.fetch('https://planar.test/api/agents', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ui-issued' }),
    });
    expect(issue.status).toBe(404);

    const doomed = await createAgent('doomed-agent');
    const before = await mcpCall(doomed.apiKey, 'get_briefing', {});
    expect(before.isError).toBe(false);
    const revoked = await SELF.fetch(`https://planar.test/api/agents/${doomed.id}/revoke`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(revoked.status).toBe(200);
    const rejected = await mcpCall(doomed.apiKey, 'get_briefing', {}).catch((e) => e);
    expect(String(rejected)).toContain('401');
  });
});
