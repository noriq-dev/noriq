// PLNR-400: the browser reads a purpose-built surface model. The full snapshot remains a
// compatibility/export contract, but common project entry paths must not pay for its 18 queries
// or ship every task/plan/document body on each WebSocket invalidation.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let cookie: string;
let projectId: string;
let taskId: string;
let apiKey: string;

const uiState = (surface: string) => SELF.fetch(
  `https://noriq.test/api/projects/${projectId}/ui-state?surface=${surface}`,
  { headers: { Cookie: cookie } },
);

beforeAll(async () => {
  const agent = await createAgent('ui-state-agent');
  apiKey = agent.apiKey;
  await createUser('ui-state-human@example.com', 'UI State Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('ui-state-human@example.com', 'longenough1');
  projectId = (await mcpCall(apiKey, 'create_project', { key: 'UISTATE', name: 'UI state' })).body.id;
  taskId = (await mcpCall(apiKey, 'create_task', {
    projectId,
    title: 'A review task',
    body: 'large body must stay behind the task-detail read',
    tags: ['test-fixture'],
  })).body.id;
  await mcpCall(apiKey, 'update_task', { projectId, taskId, status: 'review' });
}, 60_000);

describe('surface-scoped UI state (PLNR-400)', () => {
  it('loads metadata-only surfaces with one query and a live cursor, not project collections', async () => {
    const response = await uiState('project-settings');
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Noriq-UI-Surface')).toBe('project-settings');
    expect(response.headers.get('X-Noriq-Query-Count')).toBe('1');
    expect(response.headers.get('Server-Timing')).toMatch(/^ui-state;dur=\d+\.\d{2};desc="project-settings"$/);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');

    const state = await response.json() as {
      surface: string;
      project: { reviewTasks: number; eventSeq: number };
      tasks: unknown[]; plans: unknown[]; planDocs: unknown[]; events: unknown[];
    };
    expect(state.surface).toBe('project-settings');
    expect(state.project.reviewTasks).toBe(1);
    expect(state.project.eventSeq).toBeGreaterThan(0);
    expect(state.tasks).toEqual([]);
    expect(state.plans).toEqual([]);
    expect(state.planDocs).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it('gives the board relational summaries without task bodies or unrelated collections', async () => {
    const response = await uiState('board');
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('X-Noriq-Query-Count'))).toBeLessThan(18);
    const state = await response.json() as {
      tasks: Array<{ id: string; body: string }>;
      boards: unknown[];
      events: unknown[];
      taskDocs: unknown[];
      planDocs: unknown[];
    };
    expect(state.tasks.find((task) => task.id === taskId)?.body).toBe('');
    expect(state.boards.length).toBeGreaterThan(0);
    expect(state.events).toEqual([]);
    expect(state.taskDocs).toEqual([]);
    expect(state.planDocs).toEqual([]);
  });

  it('retains the heavyweight full snapshot only for explicit legacy callers', async () => {
    const response = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json() as { tasks: Array<{ id: string; body: string }> };
    expect(snapshot.tasks.find((task) => task.id === taskId)?.body)
      .toBe('large body must stay behind the task-detail read');
  });

  it('preserves body search through an on-demand bounded match page', async () => {
    const response = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/task-body-matches?q=${encodeURIComponent('large body')}&limit=256`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskIds: [taskId], nextCursor: null });
  });

  it('rejects unknown surfaces instead of silently falling back to the full snapshot', async () => {
    const response = await uiState('everything');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unknown UI surface' });
  });
});
