// PLNR-539: project docs retain immutable revisions while only the current active revision
// participates in discovery. Archive is reversible retention; DELETE remains destruction.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let cookie: string;

const rest = (path: string, method = 'GET', body?: unknown) => SELF.fetch(
  `https://noriq.test/api/projects/${projectId}${path}`,
  {
    method,
    headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  },
);

beforeAll(async () => {
  agent = await createAgent('doc-lifecycle-agent');
  await createUser('doc-lifecycle@example.com', 'Doc Lifecycle', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('doc-lifecycle@example.com', 'longenough1');
  projectId = (await mcpCall(agent.apiKey, 'create_project', { key: 'DVER', name: 'versioned docs' })).body.id;
}, 60_000);

describe('project doc versions and archive lifecycle', () => {
  it('snapshots every effective update and reads historical bodies without indexing them as entities', async () => {
    const made = await mcpCall(agent.apiKey, 'create_doc', {
      projectId,
      name: 'Runtime contract',
      description: 'the initial settled contract',
      body: 'The runtime uses protocol one.',
      folder: 'design/runtime',
      tags: ['protocol'],
    });
    expect(made.body.version).toBe(1);

    const updated = await mcpCall(agent.apiKey, 'update_doc', {
      projectId,
      docId: made.body.id,
      name: 'Runtime protocol contract',
      description: 'the current settled contract',
      body: 'The runtime uses protocol two.',
      folder: 'architecture/runtime',
      tags: ['protocol', 'server'],
    });
    expect(updated.body.version).toBe(2);

    const current = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: made.body.id });
    expect(current.body).toMatchObject({
      version: 2,
      currentVersion: 2,
      name: 'Runtime protocol contract',
      body: 'The runtime uses protocol two.',
      folder: 'architecture/runtime',
      tags: ['protocol', 'server'],
    });
    expect(current.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    const historical = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: made.body.id, version: 1 });
    expect(historical.body).toMatchObject({
      version: 1,
      currentVersion: 2,
      name: 'Runtime contract',
      body: 'The runtime uses protocol one.',
      folder: 'design/runtime',
      tags: ['protocol'],
    });

    const versions = await rest(`/docs/${made.body.id}/versions`);
    expect(versions.status).toBe(200);
    expect((await versions.json()) as unknown).toMatchObject({ currentVersion: 2, versions: [{ version: 2 }, { version: 1 }] });
    const v1 = await rest(`/docs/${made.body.id}/versions/1`);
    expect(v1.status).toBe(200);
    expect((await v1.json()) as unknown).toMatchObject({ version: 1, body: 'The runtime uses protocol one.', tags: ['protocol'] });

    // A linked task loses the archived doc from its active context without destroying the link.
    const task = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'Implement runtime contract', tags: ['protocol'], docIds: [made.body.id],
    });
    expect((await mcpCall(agent.apiKey, 'get_task', { taskId: task.body.id })).body.docs).toHaveLength(1);

    const archived = await rest(`/docs/${made.body.id}/archive`, 'POST');
    expect(archived.status).toBe(200);
    expect((await archived.json()) as unknown).toMatchObject({ archived: true, version: 2 });
    expect(((await (await rest('/docs')).json()) as { docs: unknown[] }).docs).toHaveLength(0);
    expect(((await (await rest('/docs?archived=1')).json()) as { docs: Array<{ id: string; version: number }> }).docs)
      .toEqual([expect.objectContaining({ id: made.body.id, version: 2 })]);
    expect((await mcpCall(agent.apiKey, 'list_docs', { projectId })).body.docs).toHaveLength(0);
    expect((await mcpCall(agent.apiKey, 'get_task', { taskId: task.body.id })).body.docs).toHaveLength(0);

    const searchArchived = await mcpCall(agent.apiKey, 'semantic_search', {
      projectId, query: 'runtime protocol two', kinds: ['doc'],
    });
    expect(searchArchived.body.results).toHaveLength(0);
    const exactArchived = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: made.body.id });
    expect(exactArchived.body.archivedAt).toEqual(expect.any(String));
    const refused = await mcpCall(agent.apiKey, 'update_doc', { projectId, docId: made.body.id, body: 'A hidden edit.' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('restore this doc before updating');

    const restored = await rest(`/docs/${made.body.id}/restore`, 'POST');
    expect(restored.status).toBe(200);
    expect((await restored.json()) as unknown).toMatchObject({ archived: false, version: 2 });
    expect((await mcpCall(agent.apiKey, 'list_docs', { projectId })).body.docs).toHaveLength(1);
    expect((await mcpCall(agent.apiKey, 'get_task', { taskId: task.body.id })).body.docs).toHaveLength(1);
    const searchRestored = await mcpCall(agent.apiKey, 'semantic_search', {
      projectId, query: 'runtime protocol two', kinds: ['doc'],
    });
    expect(searchRestored.body.results.map((hit: { id: string }) => hit.id)).toContain(made.body.id);

    const deleted = await rest(`/docs/${made.body.id}`, 'DELETE');
    expect(deleted.status).toBe(200);
    const retained = await env.DB.prepare('SELECT COUNT(*) AS n FROM doc_versions WHERE doc_id = ?')
      .bind(made.body.id).first<{ n: number }>();
    expect(retained?.n).toBe(0);
  });
});
