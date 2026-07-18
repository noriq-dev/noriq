// PLNR-190: the doc-authoring skill — separate from the base work-loop skill, elicited
// at doc-writing time as an MCP RESOURCE (noriq://skill/doc-authoring, pointed to from
// the doc tool descriptions and the lint rejection) plus the HTTP route.
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, mcpCall, mcpRpc } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;

beforeAll(async () => {
  agent = await createAgent('docguide-agent');
  projectId = (await mcpCall(agent.apiKey, 'create_project', { key: 'DGDE', name: 'guided' })).body.id;
}, 60000);

describe('doc-authoring skill (PLNR-190)', () => {
  it('is readable as the noriq://skill/doc-authoring resource', async () => {
    const r = (await mcpRpc(agent.apiKey, 'resources/read', { uri: 'noriq://skill/doc-authoring' })) as {
      contents: Array<{ text: string; mimeType: string }>;
    };
    expect(r.contents[0]!.mimeType).toBe('text/markdown');
    expect(r.contents[0]!.text).toContain('# Authoring Noriq docs');
    expect(r.contents[0]!.text).toContain('Game Design Document');
  });

  it('is served at /skill/docs.md and stays separate from the base skill', async () => {
    const res = await SELF.fetch('https://noriq.test/skill/docs.md');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('# Authoring Noriq docs');
    const base = await (await SELF.fetch('https://noriq.test/skill.md')).text();
    expect(base).toContain('noriq://skill/doc-authoring'); // base skill points here…
    expect(base).not.toContain('# Authoring Noriq docs'); // …but does not inline it
  });

  it('the lint rejection points at the guide resource', async () => {
    const r = await mcpCall(agent.apiKey, 'create_doc', {
      projectId, name: 'Half-baked', body: 'TBD: everything.',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('noriq://skill/doc-authoring');
  });
});
