// PLNR-627: large docs MCP — patch/append/upload writes + outline/section/grep reads.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let adminCookie: string;

const docAssessment = {
  purpose: 'document',
  outcome: 'passed',
  scope: 'non_code',
  summary: 'Inspected the markdown and confirmed it records settled facts only.',
  evidence: [{
    kind: 'inspection',
    reference: 'Doc body',
    result: 'Body contains only settled decisions and facts; no open questions.',
  }],
};

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
  adminCookie = await loginSession('agent-mint@example.com', 'longenough1');
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

  it('replace upload carries assessment + metadata through the signed token (strict)', async () => {
    const policy = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/validation-policy`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'strict', reason: 'Exercise replace-upload assessment binding.' }),
    });
    expect(policy.status).toBe(200);

    const created = await mcpCall(agent.apiKey, 'create_doc', {
      projectId,
      name: 'Strict upload base',
      description: 'needs assessed replace',
      body: '# Strict\n\nOriginal settled body.\n',
      folder: 'contracts',
      tags: ['docs'],
      assessment: docAssessment,
    });
    expect(created.isError).toBe(false);

    const bareMint = await mcpCall(agent.apiKey, 'update_doc', {
      projectId,
      docId: created.body.id,
      expectedVersion: 1,
      bodySource: { kind: 'upload' },
    });
    expect(bareMint.isError).toBe(false);
    const barePut = await SELF.fetch(bareMint.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: '# Strict\n\nUnassessed replace must fail.\n',
    });
    expect(barePut.status).toBe(400);
    expect(await barePut.text()).toMatch(/assessment/i);

    const assessedMint = await mcpCall(agent.apiKey, 'update_doc', {
      projectId,
      docId: created.body.id,
      expectedVersion: 1,
      bodySource: { kind: 'upload' },
      name: 'Strict upload renamed',
      description: 'replaced via assessed upload',
      folder: 'contracts/v2',
      addTags: ['alpha'],
      assessment: docAssessment,
    });
    expect(assessedMint.isError).toBe(false);
    expect(assessedMint.body.hint).toMatch(/Assessment/i);

    const put = await SELF.fetch(assessedMint.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: '# Strict\n\nAssessed REPLACE_META_TOKEN body.\n',
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as { version: number };
    expect(putBody.version).toBe(2);

    const got = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId: created.body.id });
    expect(got.body.body).toContain('REPLACE_META_TOKEN');
    expect(got.body.name).toBe('Strict upload renamed');
    expect(got.body.description).toBe('replaced via assessed upload');
    expect(got.body.folder).toBe('contracts/v2');
    expect(got.body.tags).toEqual(expect.arrayContaining(['docs', 'alpha']));
    expect(got.body.version).toBe(2);

    // Leave project legacy so subsequent suite cases are not gated.
    const legacy = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/validation-policy`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'legacy', reason: 'Restore legacy after replace-upload check.' }),
    });
    expect(legacy.status).toBe(200);
  });

  it('grep_docs is literal and pages project-wide scans with nextCursor', async () => {
    // Create oldest → newest. The unique old token lives only in the oldest of these three,
    // so scanLimit=2 (newest two) must miss it until the caller continues with nextCursor.
    const created: Array<{ id: string; token: string }> = [];
    for (const [name, token] of [
      ['Grep page old', 'GREP_UNIQUE_OLD_TOKEN'],
      ['Grep page mid', 'GREP_UNIQUE_MID_TOKEN'],
      ['Grep page new', 'GREP_UNIQUE_NEW_TOKEN'],
    ] as const) {
      const r = await mcpCall(agent.apiKey, 'create_doc', {
        projectId,
        name,
        description: 'grep paging fixture',
        body: `# ${name}\n\nSettled body with ${token}.\n`,
      });
      expect(r.isError).toBe(false);
      created.push({ id: r.body.id, token });
    }

    const redos = await mcpCall(agent.apiKey, 'grep_docs', {
      projectId,
      pattern: '(a+)+$',
      maxHits: 10,
    });
    expect(redos.isError).toBe(false);
    expect(redos.body.hits).toEqual([]);

    const page1 = await mcpCall(agent.apiKey, 'grep_docs', {
      projectId,
      pattern: 'GREP_UNIQUE_OLD_TOKEN',
      scanLimit: 2,
      maxHits: 50,
    });
    expect(page1.isError).toBe(false);
    expect(page1.body.scanned).toBe(2);
    expect(page1.body.scanLimit).toBe(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    expect(page1.body.truncated).toBe(true);
    expect(page1.body.hits).toHaveLength(0);

    const page2 = await mcpCall(agent.apiKey, 'grep_docs', {
      projectId,
      pattern: 'GREP_UNIQUE_OLD_TOKEN',
      scanLimit: 2,
      cursor: page1.body.nextCursor,
    });
    expect(page2.isError).toBe(false);
    expect(page2.body.hits.some((h: { preview: string }) => h.preview.includes('GREP_UNIQUE_OLD_TOKEN'))).toBe(true);

    const one = await mcpCall(agent.apiKey, 'grep_docs', {
      projectId,
      docId: created[0]!.id,
      pattern: 'GREP_UNIQUE_OLD_TOKEN',
    });
    expect(one.isError).toBe(false);
    expect(one.body.hits).toHaveLength(1);
    expect(one.body.nextCursor).toBeNull();
    expect(one.body.truncated).toBe(false);
  });

  it('grep_docs nextCursor advances from last searched when maxHits fills mid-page', async () => {
    // Newest doc alone saturates maxHits=1; sibling on the same fetch page must remain
    // reachable via nextCursor (not skipped, and not lost when nothing lies beyond the page).
    const sibling = await mcpCall(agent.apiKey, 'create_doc', {
      projectId,
      name: 'Grep hit-cap sibling',
      description: 'must be reachable after maxHits stop',
      body: '# Sibling\n\nSettled HITCAP_SHARED and HITCAP_SIBLING_ONLY.\n',
    });
    expect(sibling.isError).toBe(false);
    const newest = await mcpCall(agent.apiKey, 'create_doc', {
      projectId,
      name: 'Grep hit-cap newest',
      description: 'fills maxHits alone',
      body: '# Newest\n\nSettled HITCAP_SHARED line one.\nSettled HITCAP_SHARED line two.\n',
    });
    expect(newest.isError).toBe(false);

    const page1 = await mcpCall(agent.apiKey, 'grep_docs', {
      projectId,
      pattern: 'HITCAP_SHARED',
      scanLimit: 2,
      maxHits: 1,
    });
    expect(page1.isError).toBe(false);
    expect(page1.body.hits).toHaveLength(1);
    expect(page1.body.hits[0].docId).toBe(newest.body.id);
    expect(page1.body.scanned).toBe(1);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    expect(page1.body.truncated).toBe(true);

    // Same pattern continues mid-doc first; draining newest then reaches the sibling.
    const page2a = await mcpCall(agent.apiKey, 'grep_docs', {
      projectId,
      pattern: 'HITCAP_SHARED',
      scanLimit: 2,
      maxHits: 1,
      cursor: page1.body.nextCursor,
    });
    expect(page2a.isError).toBe(false);
    expect(page2a.body.hits).toHaveLength(1);
    expect(page2a.body.hits[0].docId).toBe(newest.body.id);
    expect(page2a.body.hits[0].line).toBeGreaterThan(page1.body.hits[0].line);

    const page2b = await mcpCall(agent.apiKey, 'grep_docs', {
      projectId,
      pattern: 'HITCAP_SIBLING_ONLY',
      scanLimit: 2,
      cursor: page2a.body.nextCursor,
    });
    expect(page2b.isError).toBe(false);
    expect(page2b.body.hits.some((h: { docId: string; preview: string }) => (
      h.docId === sibling.body.id && h.preview.includes('HITCAP_SIBLING_ONLY')
    ))).toBe(true);
  });

  it('grep_docs nextCursor retains line position for mid-doc maxHits (same pattern)', async () => {
    const created = await mcpCall(agent.apiKey, 'create_doc', {
      projectId,
      name: 'Grep mid-doc resume',
      description: 'two matching lines for hit-cap resume',
      body: '# Mid\n\nSettled MIDDOC_TOKEN first.\nplain line\nSettled MIDDOC_TOKEN second.\n',
    });
    expect(created.isError).toBe(false);

    const page1 = await mcpCall(agent.apiKey, 'grep_docs', {
      projectId,
      docId: created.body.id,
      pattern: 'MIDDOC_TOKEN',
      maxHits: 1,
    });
    expect(page1.isError).toBe(false);
    expect(page1.body.hits).toHaveLength(1);
    expect(page1.body.hits[0].line).toBe(3);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    expect(page1.body.truncated).toBe(true);

    const page2 = await mcpCall(agent.apiKey, 'grep_docs', {
      projectId,
      docId: created.body.id,
      pattern: 'MIDDOC_TOKEN',
      maxHits: 1,
      cursor: page1.body.nextCursor,
    });
    expect(page2.isError).toBe(false);
    expect(page2.body.hits).toHaveLength(1);
    expect(page2.body.hits[0].docId).toBe(created.body.id);
    expect(page2.body.hits[0].line).toBe(5);
    expect(page2.body.hits[0].preview).toContain('second');
  });
});
