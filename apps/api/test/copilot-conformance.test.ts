// PLNR-359: scenario-level gates for the Copilot behavior the Noriq skill teaches. These are
// deliberately end-to-end MCP/REST journeys, not string checks: they prove the advised sequence
// is possible and that each server response tells the Copilot what to do next.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authorizeForAllProjects, createAgent, createUser, loginSession, mcpCall } from './helpers';

let copilot: { id: string; apiKey: string };
let humanCookie: string;

beforeAll(async () => {
  copilot = await createAgent('conformance-copilot');
  await createUser('conformance-human@example.com', 'Conformance Human', 'longenough1', 'admin').catch(() => {});
  humanCookie = await loginSession('conformance-human@example.com', 'longenough1');
}, 60_000);

describe('Noriq-first Copilot conformance', () => {
  it('backs material work with a claim, retrieves memory context, and moves on from a blocking gate', async () => {
    const project = await mcpCall(copilot.apiKey, 'create_project', { key: 'CNF', name: 'Copilot conformance' });
    const projectId = project.body.id as string;
    await authorizeForAllProjects(copilot.apiKey);
    const first = (await mcpCall(copilot.apiKey, 'create_task', {
      projectId, title: 'Protect the cobalt shared cache', tags: ['copilot-conformance'],
    })).body;
    const independent = (await mcpCall(copilot.apiKey, 'create_task', {
      projectId, title: 'Document the independent health probe', tags: ['copilot-conformance'],
    })).body;

    // Ordinary task activity does not manufacture low-value memory just to satisfy the loop.
    const initiallyEmpty = await mcpCall(copilot.apiKey, 'search_project_memory', {
      projectId, query: 'cobalt shared cache',
    });
    expect(initiallyEmpty.isError).toBe(false);
    expect(initiallyEmpty.body.results).toEqual([]);

    await mcpCall(copilot.apiKey, 'record_memory', {
      projectId,
      kind: 'hazard',
      statement: 'Protect the cobalt shared cache by requiring the project lock before mutation.',
    });
    const claim = await mcpCall(copilot.apiKey, 'claim_task', { projectId, taskId: first.key });
    expect(claim.isError).toBe(false);
    expect(claim.body.nextAction).toMatch(/get_task_context/i);

    const context = await mcpCall(copilot.apiKey, 'get_task_context', {
      projectId, taskId: first.id, budgetTokens: 10_000,
    });
    expect(context.isError).toBe(false);
    expect(JSON.stringify(context.body)).toContain('Protect the cobalt shared cache by requiring the project lock');

    const gate = await mcpCall(copilot.apiKey, 'request_input', {
      projectId,
      taskId: first.id,
      title: 'Choose the cache lock scope',
      questions: [{ question: 'Should the lock cover the whole cache?', kind: 'confirm' }],
    });
    expect(gate.body).toMatchObject({ parked: true, blocking: true });
    expect(gate.body.nextAction).toMatch(/do not wait in chat.*next_claimable/i);

    const next = await mcpCall(copilot.apiKey, 'next_claimable', { projectId });
    expect(next.body.task.id).toBe(independent.id);

    const secondClaim = await mcpCall(copilot.apiKey, 'claim_task', { projectId, taskId: independent.id });
    expect(secondClaim.isError).toBe(false);
    const advisory = await mcpCall(copilot.apiKey, 'request_input', {
      projectId,
      taskId: independent.id,
      title: 'Preferred probe wording',
      body: 'This answer improves the document but does not block the implementation.',
      blocking: false,
    });
    expect(advisory.body).toMatchObject({ parked: false, blocking: false });
    expect(advisory.body.nextAction).toMatch(/continue the current task/i);
    const stillHeld = await mcpCall(copilot.apiKey, 'get_task', { taskId: independent.id });
    expect(stillHeld.body.task.status).toBe('in_progress');
  });

  it('acknowledges one human steering comment without pretending it is resolved', async () => {
    const project = await mcpCall(copilot.apiKey, 'create_project', { key: 'ACKC', name: 'Acknowledgement conformance' });
    const projectId = project.body.id as string;
    await authorizeForAllProjects(copilot.apiKey);
    const task = (await mcpCall(copilot.apiKey, 'create_task', {
      projectId, title: 'Apply human steering', tags: ['copilot-conformance'],
    })).body;
    await mcpCall(copilot.apiKey, 'claim_task', { projectId, taskId: task.id });

    const posted = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks/${task.id}/comments`, {
      method: 'POST',
      headers: { Cookie: humanCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'instruction', body: 'Keep the compatibility alias.' }),
    });
    expect(posted.status).toBe(200);
    const commentId = ((await posted.json()) as { id: string }).id;

    const ack = await mcpCall(copilot.apiKey, 'acknowledge_comment', { projectId, commentId });
    expect(ack.body).toMatchObject({ acknowledged: true, taskId: task.id });
    expect(ack.body.nextAction).toMatch(/resolve_comment only when substantively addressed/i);
    const premature = await mcpCall(copilot.apiKey, 'release_task', {
      projectId, taskId: task.id, toStatus: 'done',
    });
    expect(premature.isError).toBe(true);
    expect(premature.text).toMatch(/unresolved comment/i);

    const resolved = await mcpCall(copilot.apiKey, 'resolve_comment', {
      projectId,
      commentId,
      resolution: 'addressed',
      reply: 'The compatibility alias remains covered by the implementation and tests.',
    });
    expect(resolved.isError).toBe(false);
    const done = await mcpCall(copilot.apiKey, 'release_task', {
      projectId, taskId: task.id, toStatus: 'done',
    });
    expect(done.body.status).toBe('done');
  });
});
