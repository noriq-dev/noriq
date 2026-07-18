// PLNR-183: the docs contract — docs are static, complete records of explicit decisions
// and facts. Open-ended bodies (TBD/TODO, open questions, "we should discuss") are
// rejected at the write seam with the offending lines listed.
import { describe, expect, it, beforeAll } from 'vitest';
import { lintDocBody } from '../src/lib/doclint';
import { createAgent, mcpCall } from './helpers';

describe('lintDocBody (unit)', () => {
  it('passes decision-and-fact prose', () => {
    expect(lintDocBody(
      '# Auth model\n\nWe use OAuth 2.1 with PKCE. Access tokens live 15 minutes.\nRefresh rotation is mandatory; reuse revokes the family.',
    )).toEqual([]);
  });

  it('flags unfinished-work markers and pending decisions with line numbers', () => {
    const v = lintDocBody('# Plan\n\nTODO: pick a queue.\nThe retention window is to be decided.\nWe should discuss sharding.');
    expect(v.map((x) => x.line)).toEqual([3, 4, 5]);
  });

  it('flags lines that end with a question', () => {
    const v = lintDocBody('# Cache\n\nShould we use KV or D1 for this?');
    expect(v).toHaveLength(1);
    expect(v[0]!.reason).toContain('question');
  });

  it('exempts fenced code blocks', () => {
    expect(lintDocBody('# Usage\n\n```ts\n// TODO in example code is fine?\nconst x = a ?? b;\n```\nThe fallback operator is `??`.')).toEqual([]);
  });

  it('lower-case "todo" (the task status) is not a marker', () => {
    expect(lintDocBody('New tasks start in the todo column.')).toEqual([]);
  });
});

describe('docs contract at the write seam', () => {
  let agent: { id: string; apiKey: string };
  let projectId: string;
  let docId: string;

  beforeAll(async () => {
    agent = await createAgent('doc-contract-agent');
    projectId = (await mcpCall(agent.apiKey, 'create_project', { key: 'DCON', name: 'contract' })).body.id;
    docId = (await mcpCall(agent.apiKey, 'create_doc', {
      projectId, name: 'Session storage', description: 'where sessions live', body: 'Sessions live in the session store, keyed by cookie id.',
    })).body.id;
  }, 60000);

  it('create_doc rejects an open-ended body, listing the violations', async () => {
    const r = await mcpCall(agent.apiKey, 'create_doc', {
      projectId, name: 'Open questions', description: 'undecided things',
      body: '# Sharding\n\nTBD: shard key.\nShould we shard by user or by project?',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('line 3');
    expect(r.text).toContain('line 4');
    expect(r.text).toContain('request_input');
  });

  it('update_doc enforces the same contract', async () => {
    const r = await mcpCall(agent.apiKey, 'update_doc', {
      projectId, docId, body: 'We need to decide where sessions live.',
    });
    expect(r.isError).toBe(true);
    const reread = await mcpCall(agent.apiKey, 'get_doc', { projectId, docId });
    expect(reread.body.body).toContain('session store'); // unchanged
  });

  it('a clean revision passes', async () => {
    const r = await mcpCall(agent.apiKey, 'update_doc', {
      projectId, docId, body: 'Sessions live in the session store DO, keyed by cookie id. TTL is 30 days.',
    });
    expect(r.isError).toBe(false);
  });
});
