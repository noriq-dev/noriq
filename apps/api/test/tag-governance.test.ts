// PLNR-194: tag governance — the near-duplicate mint guard, the curated tag policy,
// merge_tags consolidation, and the tag_report health check.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let cookie: string;

beforeAll(async () => {
  agent = await createAgent('taggov-agent');
  await createUser('taggov@example.com', 'Tag Gov', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('taggov@example.com', 'longenough1');
  projectId = (await mcpCall(agent.apiKey, 'create_project', { key: 'TGOV', name: 'governed' })).body.id;
  await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'seed', tags: ['building', 'inventory'] });
}, 60000);

describe('near-duplicate mint guard', () => {
  it('rejects a near-duplicate with suggestions; allowNewTags overrides; distinct names pass', async () => {
    const dupe = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'sprawl', tags: ['building-system'] });
    expect(dupe.isError).toBe(true);
    expect(dupe.text).toContain('building');
    expect(dupe.text).toContain('allowNewTags');

    const forced = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'genuinely distinct', tags: ['building-system'], allowNewTags: true,
    });
    expect(forced.isError).toBe(false);

    const fresh = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'new area', tags: ['weather'] });
    expect(fresh.isError).toBe(false); // no near-match → mints without ceremony
  });

  it('applies to doc tags too', async () => {
    const r = await mcpCall(agent.apiKey, 'create_doc', {
      projectId, name: 'Inventory rules', body: 'Stacks cap at 50.', tags: ['inventories'],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('inventory');
  });

  it('doc tags run through the descriptive-tag validation', async () => {
    const r = await mcpCall(agent.apiKey, 'create_doc', {
      projectId, name: 'Bug list', body: 'The gateway limit is 2 MB.', tags: ['bug'],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not a descriptive tag');
  });
});

describe('curated tag policy', () => {
  it('blocks agent minting entirely; existing tags and human minting still work', async () => {
    const set = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/meta`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagPolicy: 'curated' }),
    });
    expect(set.status).toBe(200);

    const mint = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'nope', tags: ['economy'] });
    expect(mint.isError).toBe(true);
    expect(mint.text).toContain('curated');

    const reuse = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'fine', tags: ['inventory'] });
    expect(reuse.isError).toBe(false);

    // allowNewTags does NOT bypass curated — only humans mint there.
    const forced = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'still nope', tags: ['economy'], allowNewTags: true });
    expect(forced.isError).toBe(true);

    // A human (REST) mints freely — they are the curator.
    const t = (await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'human-tagged later', tags: ['inventory'] })).body;
    const human = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks/${t.id}`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ addTags: ['economy'] }),
    });
    expect(human.status).toBe(200);

    // back to open for the remaining tests
    await SELF.fetch(`https://noriq.test/api/projects/${projectId}/meta`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagPolicy: 'open' }),
    });
  });
});

describe('merge_tags + tag_report', () => {
  it('merge re-points tasks and docs, deletes the source, and reports counts', async () => {
    await mcpCall(agent.apiKey, 'create_doc', {
      projectId, name: 'Building shells', body: 'Walls carry load; roofs do not.', tags: ['building-system'], allowNewTags: true,
    });
    const merged = await mcpCall(agent.apiKey, 'merge_tags', { projectId, from: 'building-system', into: 'building' });
    expect(merged.isError).toBe(false);
    expect(merged.body.retaggedTasks).toBe(1); // the 'genuinely distinct' task
    expect(merged.body.retaggedDocs).toBe(1);

    const proj = await mcpCall(agent.apiKey, 'get_project', { projectId });
    expect(proj.body.tags.some((g: { name: string }) => g.name === 'building-system')).toBe(false);
    const doc = await mcpCall(agent.apiKey, 'list_docs', { projectId, tag: 'building' });
    expect(doc.body.docs.some((d: { name: string }) => d.name === 'Building shells')).toBe(true);

    const missing = await mcpCall(agent.apiKey, 'merge_tags', { projectId, from: 'building', into: 'ghost' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('must already exist');
  });

  it('tag_report surfaces usage, single-use tags, and near-duplicate clusters', async () => {
    await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'dupe seed', tags: ['inventory', 'inventories'], allowNewTags: true });
    const r = await mcpCall(agent.apiKey, 'tag_report', { projectId });
    expect(r.isError).toBe(false);
    expect(r.body.tagPolicy).toBe('open');
    const inv = r.body.tags.find((t: { name: string }) => t.name === 'inventory');
    expect(inv.total).toBeGreaterThanOrEqual(2);
    expect(r.body.singleUse).toContain('weather');
    expect(r.body.nearDuplicateGroups.some((g: string[]) => g.includes('inventory') && g.includes('inventories'))).toBe(true);
  });
});
