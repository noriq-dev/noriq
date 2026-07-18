// PLNR-182: task↔doc relations — set at creation (create_task docIds), edited without
// clobbering (addDocIds/removeDocIds), visible from both sides (get_task.docs,
// get_doc.linkedTasks, snapshot.taskDocs), validated project-local, cascaded on delete.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let docA: string;
let docB: string;
let cookie: string;

const snapshot = async () =>
  (await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json()) as {
    taskDocs: Array<{ taskId: string; docId: string }>;
  };

beforeAll(async () => {
  agent = await createAgent('taskdocs-agent');
  await createUser('taskdocs@example.com', 'Doc Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('taskdocs@example.com', 'longenough1');
  const p = await mcpCall(agent.apiKey, 'create_project', { key: 'TDOC', name: 'task-docs' });
  projectId = p.body.id;
  docA = (await mcpCall(agent.apiKey, 'create_doc', {
    projectId, name: 'Auth design', description: 'Token model decisions', body: 'We use OAuth 2.1 with PKCE. Access tokens live 15 minutes.',
  })).body.id;
  docB = (await mcpCall(agent.apiKey, 'create_doc', {
    projectId, name: 'Board conventions', description: 'How boards are used', body: 'Each environment gets one board. The default board is Main.',
  })).body.id;
}, 60000);

describe('task↔doc links (PLNR-182)', () => {
  let taskId: string;

  it('create_task links docs at creation and get_task returns them', async () => {
    const r = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'implement token refresh', tags: ['oauth'], docIds: [docA],
    });
    taskId = r.body.id;
    const detail = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(detail.body.docs.map((d: { id: string }) => d.id)).toEqual([docA]);
    expect(detail.body.docs[0].resource).toContain(docA);
  });

  it('get_doc lists the linked tasks from the doc side', async () => {
    const doc = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: docA });
    expect(doc.body.linkedTasks.map((t: { id: string }) => t.id)).toContain(taskId);
    const idx = await mcpCall(agent.apiKey, 'list_docs', { projectId });
    expect(idx.body.docs.find((d: { id: string }) => d.id === docA)?.linkedTasks).toBe(1);
  });

  it('snapshot exposes the link pairs for the UI', async () => {
    const s = await snapshot();
    expect(s.taskDocs).toContainEqual({ taskId, docId: docA });
  });

  it('addDocIds/removeDocIds edit without clobbering; docIds replaces', async () => {
    await mcpCall(agent.apiKey, 'update_task', { projectId, taskId, addDocIds: [docB] });
    let detail = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(detail.body.docs).toHaveLength(2);

    await mcpCall(agent.apiKey, 'update_task', { projectId, taskId, removeDocIds: [docA] });
    detail = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(detail.body.docs.map((d: { id: string }) => d.id)).toEqual([docB]);

    await mcpCall(agent.apiKey, 'update_task', { projectId, taskId, docIds: [docA] });
    detail = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(detail.body.docs.map((d: { id: string }) => d.id)).toEqual([docA]);
  });

  it('a foreign or unknown doc id is a readable error and fails the create atomically', async () => {
    const r = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'nope', tags: ['oauth'], docIds: [docA, 'doc_missing'],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('doc_missing');
    expect(r.text).toContain('not found in this project');
    const search = await mcpCall(agent.apiKey, 'search_tasks', { projectId, text: 'nope' });
    expect(search.body.matched).toBe(0); // no half-created task
  });

  it('create_tasks defaults.docIds applies to every item', async () => {
    const r = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId,
      defaults: { docIds: [docB], tags: ['boards'] },
      tasks: [{ title: 'batch one' }, { title: 'batch two', docIds: [docA] }],
    });
    expect(r.body.failed).toBe(0);
    const [one, two] = r.body.created;
    const d1 = await mcpCall(agent.apiKey, 'get_task', { taskId: one.id });
    const d2 = await mcpCall(agent.apiKey, 'get_task', { taskId: two.id });
    expect(d1.body.docs.map((d: { id: string }) => d.id)).toEqual([docB]);
    expect(d2.body.docs.map((d: { id: string }) => d.id)).toEqual([docA]); // item wins over defaults
  });

  it('deleting a doc removes its links but not the tasks', async () => {
    const del = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/docs/${docB}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);
    const s = await snapshot();
    expect(s.taskDocs.some((l) => l.docId === docB)).toBe(false);
    const detail = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(detail.body.task).toBeTruthy(); // task intact, still linked to docA
    expect(detail.body.docs.map((d: { id: string }) => d.id)).toEqual([docA]);
  });
});
