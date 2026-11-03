// PLNR-627: large docs MCP — patch/append/upload writes + outline/section/grep reads.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;

const LARGE_BODY = `# Root

Preamble.

## Alpha

Alpha section body with TOKEN_ALPHA unique.

### Alpha Nested

Nested under alpha.

## Beta

Beta section body with TOKEN_BETA unique.

## Gamma

${'Settled fact line.\n'.repeat(40)}
`;

beforeAll(async () => {
  agent = await createAgent('large-docs-agent');
  projectId = (await mcpCall(agent.apiKey, 'create_project', { key: 'LDMC', name: 'large docs mcp' })).body.id;
}, 60_000);

describe('large docs MCP (PLNR-627)', () => {
  it('outline → section → patch with expectedVersion; conflict rejects', async () => {
    const created = await mcpCall(agent.apiKey, 'create_doc', {
      projectId,
      name: 'Large contract',
      description: 'settled large-doc fixture',
      body: LARGE_BODY,
    });
    expect(created.isError).toBe(false);
    expect(created.body.version).toBe(1);
    expect(created.body.bodyChars).toBeGreaterThan(100);
    expect(created.body.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.body.searchTruncated).toBe(false);

    const outline = await mcpCall(agent.apiKey, 'get_doc', {
      projectId, docId: created.body.id, view: 'outline',
    });
    expect(outline.isError).toBe(false);
    expect(outline.body.body).toBeUndefined();
    expect(outline.body.outline.map((h: { path: string }) => h.path)).toEqual(expect.arrayContaining([
      'Root', 'Root / Alpha', 'Root / Alpha / Alpha Nested', 'Root / Beta', 'Root / Gamma',
    ]));
    expect(outline.body.segments.every((s: { included: boolean }) => s.included === false)).toBe(true);

    const section = await mcpCall(agent.apiKey, 'get_doc', {
      projectId, docId: created.body.id, section: 'Root / Beta',
    });
    expect(section.isError).toBe(false);
    expect(section.body.body).toContain('TOKEN_BETA');
    expect(section.body.body).not.toContain('TOKEN_ALPHA');
    expect(section.body.selection.mode).toBe('section');
    expect(section.body.segments.some((s: { path: string; included: boolean }) => s.path === 'Root / Beta' && s.included)).toBe(true);
    expect(section.body.segments.some((s: { path: string; included: boolean }) => s.path === 'Root / Alpha' && !s.included)).toBe(true);

    const grep = await mcpCall(agent.apiKey, 'grep_docs', {
      projectId, docId: created.body.id, pattern: 'TOKEN_ALPHA',
    });
    expect(grep.isError).toBe(false);
    expect(grep.body.hits[0].path).toBe('Root / Alpha');
    expect(grep.body.hits[0].startLine).toBeLessThanOrEqual(grep.body.hits[0].line);

    const patched = await mcpCall(agent.apiKey, 'update_doc', {
      projectId,
      docId: created.body.id,
      expectedVersion: 1,
      mode: 'patch',
      edits: [{ oldText: 'TOKEN_BETA unique', newText: 'TOKEN_BETA patched' }],
    });
    expect(patched.isError).toBe(false);
    expect(patched.body.version).toBe(2);
    expect(patched.body.contentHash).toBeTruthy();

    const after = await mcpCall(agent.apiKey, 'get_doc', {
      projectId, docId: created.body.id, section: 'Root / Beta',
    });
    expect(after.body.body).toContain('TOKEN_BETA patched');

    const stale = await mcpCall(agent.apiKey, 'update_doc', {
      projectId,
      docId: created.body.id,
      expectedVersion: 1,
      mode: 'patch',
      edits: [{ oldText: 'TOKEN_BETA patched', newText: 'should fail' }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/conflict|expected 1|current is 2/i);

    const missingVersion = await mcpCall(agent.apiKey, 'update_doc', {
      projectId,
      docId: created.body.id,
      mode: 'append',
      body: '\n\nAppended settled line.',
    });
    expect(missingVersion.isError).toBe(true);
    expect(missingVersion.text).toMatch(/expectedVersion/i);

    const ambiguous = await mcpCall(agent.apiKey, 'update_doc', {
      projectId,
      docId: created.body.id,
      expectedVersion: 2,
      mode: 'patch',
      edits: [{ oldText: 'section body', newText: 'x' }],
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/match/i);
  });

  it('upload mint → PUT → commit for create and replace', async () => {
    const minted = await mcpCall(agent.apiKey, 'create_doc', {
      projectId,
      name: 'Uploaded contract',
      description: 'created via upload URL',
      bodySource: { kind: 'upload' },
      tags: ['docs'],
    });
    expect(minted.isError).toBe(false);
    expect(minted.body.pending).toBe(true);
    expect(minted.body.uploadUrl).toContain('/api/docs/upload/');
    expect(minted.body.docId).toMatch(/^doc_/);

    const markdown = '# Uploaded\n\nSettled uploaded body with UPLOAD_TOKEN.\n';
    const put = await SELF.fetch(minted.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: markdown,
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as { version: number; id: string; contentHash: string };
    expect(putBody.version).toBe(1);
    expect(putBody.id).toBe(minted.body.docId);

    const got = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: minted.body.docId });
    expect(got.body.body).toContain('UPLOAD_TOKEN');
    expect(got.body.version).toBe(1);

    const replaceMint = await mcpCall(agent.apiKey, 'update_doc', {
      projectId,
      docId: minted.body.docId,
      expectedVersion: 1,
      bodySource: { kind: 'upload' },
    });
    expect(replaceMint.isError).toBe(false);
    expect(replaceMint.body.uploadUrl).toBeTruthy();

    const put2 = await SELF.fetch(replaceMint.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: '# Uploaded\n\nReplaced settled body with REPLACE_TOKEN.\n',
    });
    expect(put2.status).toBe(200);
    const put2Body = await put2.json() as { version: number };
    expect(put2Body.version).toBe(2);

    const got2 = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: minted.body.docId });
    expect(got2.body.body).toContain('REPLACE_TOKEN');
    expect(got2.body.version).toBe(2);
  });

  it('plan_doc patch parity uses expectedContentHash', async () => {
    const plan = await mcpCall(agent.apiKey, 'create_plan', {
      projectId,
      title: 'Large doc plan',
      body: '# Goals\n\nScratch.',
      phases: [{ title: 'One', newTasks: [{ title: 'noop task', tags: ['docs'] }] }],
    });
    expect(plan.isError).toBe(false);
    const planId = plan.body.id;
    expect(planId).toBeTruthy();

    const pdoc = await mcpCall(agent.apiKey, 'create_plan_doc', {
      projectId,
      planId,
      name: 'Scratch notes',
      body: '# Scratch\n\n## Open\n\nMaybe later?\n',
    });
    expect(pdoc.isError).toBe(false);
    expect(pdoc.body.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const patched = await mcpCall(agent.apiKey, 'update_plan_doc', {
      projectId,
      docId: pdoc.body.id,
      expectedContentHash: pdoc.body.contentHash,
      mode: 'patch',
      edits: [{ oldText: 'Maybe later?', newText: 'Still open for now.' }],
    });
    expect(patched.isError).toBe(false);
    expect(patched.body.contentHash).not.toBe(pdoc.body.contentHash);

    const got = await mcpCall(agent.apiKey, 'get_plan_doc', {
      projectId, docId: pdoc.body.id, section: 'Scratch / Open',
    });
    expect(got.body.doc.body).toContain('Still open for now');
  });

  it('soft-max rejects oversized bodies', async () => {
    const huge = 'x'.repeat(512 * 1024 + 10);
    const r = await mcpCall(agent.apiKey, 'create_doc', {
      projectId,
      name: 'Too big',
      description: 'should fail',
      body: `# Big\n\n${huge}\n`,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/soft max|exceeds|Too big|524288/i);
  });
});
