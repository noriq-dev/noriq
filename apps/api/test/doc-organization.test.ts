// PLNR-188: docs organization — folders (normalized path string, human browsing only)
// and tags (the project tag vocabulary shared with tasks), on MCP + REST + cascades.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let cookie: string;
let meshDoc: string;
let authDoc: string;

beforeAll(async () => {
  agent = await createAgent('docorg-agent');
  await createUser('docorg@example.com', 'Doc Org', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('docorg@example.com', 'longenough1');
  projectId = (await mcpCall(agent.apiKey, 'create_project', { key: 'DORG', name: 'organized' })).body.id;
  meshDoc = (await mcpCall(agent.apiKey, 'create_doc', {
    projectId, name: 'Mesh replication', description: 'the vehicle seam', folder: ' design / networking ',
    tags: ['mesh', 'networking'], body: 'Proxies interpolate; the driver is authoritative.',
  })).body.id;
  authDoc = (await mcpCall(agent.apiKey, 'create_doc', {
    projectId, name: 'Auth model', description: 'token rules', tags: ['oauth'],
    body: 'Access tokens live 15 minutes.',
  })).body.id;
}, 60000);

describe('doc folders + tags (PLNR-188)', () => {
  it('folder paths normalize and tags share the project tag vocabulary', async () => {
    const doc = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: meshDoc });
    expect(doc.body.folder).toBe('design/networking'); // trimmed segments
    expect(doc.body.tags.sort()).toEqual(['mesh', 'networking']);
    // The tags are real project tags — a task can carry the same one.
    const t = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'mesh work', tags: ['mesh'] });
    const proj = await mcpCall(agent.apiKey, 'get_project', { projectId });
    expect(proj.body.tags.filter((g: { name: string }) => g.name === 'mesh')).toHaveLength(1); // one vocabulary, no dupes
    expect(t.isError).toBe(false);
  });

  it('list_docs returns folder/tags and filters by tag and by folder subtree', async () => {
    const all = await mcpCall(agent.apiKey, 'list_docs', { projectId });
    expect(all.body.docs).toHaveLength(2);
    const byTag = await mcpCall(agent.apiKey, 'list_docs', { projectId, tag: 'oauth' });
    expect(byTag.body.docs.map((d: { id: string }) => d.id)).toEqual([authDoc]);
    const byFolder = await mcpCall(agent.apiKey, 'list_docs', { projectId, folder: 'design' });
    expect(byFolder.body.docs.map((d: { id: string }) => d.id)).toEqual([meshDoc]); // subtree match
    const miss = await mcpCall(agent.apiKey, 'list_docs', { projectId, tag: 'nope' });
    expect(miss.body.docs).toHaveLength(0);
  });

  it('update_doc moves folders and edits tags without clobbering', async () => {
    await mcpCall(agent.apiKey, 'update_doc', { projectId, docId: authDoc, folder: 'design/auth', addTags: ['tokens'] });
    let doc = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: authDoc });
    expect(doc.body.folder).toBe('design/auth');
    expect(doc.body.tags.sort()).toEqual(['oauth', 'tokens']);

    await mcpCall(agent.apiKey, 'update_doc', { projectId, docId: authDoc, removeTags: ['oauth'], folder: '' });
    doc = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: authDoc });
    expect(doc.body.folder).toBe(''); // back to root
    expect(doc.body.tags).toEqual(['tokens']);

    await mcpCall(agent.apiKey, 'update_doc', { projectId, docId: authDoc, tags: ['oauth'] }); // replace outright
    doc = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: authDoc });
    expect(doc.body.tags).toEqual(['oauth']);
  });

  it('REST list carries folder + tags for the UI', async () => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/docs`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { docs: Array<{ id: string; folder: string; tags: string[] }> };
    const mesh = j.docs.find((d) => d.id === meshDoc)!;
    expect(mesh.folder).toBe('design/networking');
    expect(mesh.tags).toContain('mesh');
  });

  it('deleting a tag detaches it from docs; deleting a doc cleans its tag rows', async () => {
    const proj = await mcpCall(agent.apiKey, 'get_project', { projectId });
    const mesh = proj.body.tags.find((g: { name: string }) => g.name === 'mesh')!;
    const del = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tags/${mesh.id}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);
    const doc = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: meshDoc });
    expect(doc.body.tags).toEqual(['networking']);

    const delDoc = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/docs/${meshDoc}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(delDoc.status).toBe(200);
    const left = await mcpCall(agent.apiKey, 'list_docs', { projectId });
    expect(left.body.docs.map((d: { id: string }) => d.id)).toEqual([authDoc]);
  });
});
