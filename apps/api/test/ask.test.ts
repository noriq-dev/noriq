// PLNR-219: "ask the project" RAG. The workerd test env has no VECTORIZE binding, so
// retrieval runs the keyword fallback; generation is exercised with an injected fake (same
// pattern as search.test / cimd) since Workers AI inference isn't available in the pool.
// The generationClient gate (the 503 trigger) is unit-tested; the route tests prove
// validation + auth.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';
import { answerQuestion, buildMessages, generationClient, type ChatMessage, type GenerationClient } from '../src/ask';
import type { SearchHit } from '../src/search';
import type { Env } from '../src/env';

/** Fake generation client: records the prompts it saw, returns a canned answer. */
function fakeGen(canned = 'Grounded answer citing ASK-1.') {
  const calls: ChatMessage[][] = [];
  const gen: GenerationClient = {
    async generate(messages) { calls.push(messages); return canned; },
  };
  return { gen, calls };
}

// ---------------------------------------------------------------------------------------
// Unit: prompt construction (no D1)
// ---------------------------------------------------------------------------------------

describe('buildMessages (unit)', () => {
  it('pins the model to the context and forbids invention', () => {
    const msgs = buildMessages('what is the plan?', 'Proj', []);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toMatch(/ONLY from the CONTEXT/i);
    expect(msgs[0]!.content).toMatch(/never invent/i);
    expect(msgs[1]!.content).toContain('no matching project material');
    expect(msgs[1]!.content).toContain('QUESTION: what is the plan?');
  });

  it('numbers and labels each source block with its reference', () => {
    const hit: SearchHit = { kind: 'task', id: 't1', projectId: 'p', key: 'ASK-1', title: 'retry work', snippet: '', score: 1, status: 'todo' };
    const msgs = buildMessages('q?', 'Proj', [{ hit, text: 'the fuller body text' }]);
    expect(msgs[1]!.content).toContain('[1] TASK ASK-1 (retry work, todo)');
    expect(msgs[1]!.content).toContain('the fuller body text');
  });
});

// ---------------------------------------------------------------------------------------
// Integration: real keyword retrieval + a fake generator, over the real test D1
// ---------------------------------------------------------------------------------------

let agent: { id: string; apiKey: string };
let projectId: string;
let cookie: string;

beforeAll(async () => {
  agent = await createAgent('ask-agent');
  await createUser('ask@example.com', 'Ask Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('ask@example.com', 'longenough1');
  projectId = (await mcpCall(agent.apiKey, 'create_project', { key: 'ASK', name: 'askable' })).body.id;
  await mcpCall(agent.apiKey, 'create_task', {
    projectId, title: 'implement payment retry backoff', tags: ['payments'], body: 'Exponential backoff on PSP timeouts.',
  });
  // description is what the search snippet shows; the retry detail lives only in the BODY —
  // so seeing it in the prompt proves we re-read the fuller body, not just the snippet.
  await mcpCall(agent.apiKey, 'create_doc', {
    projectId, name: 'Payment gateway design', description: 'how payments flow',
    body: 'All payments go through the gateway service. The retry policy is exponential backoff, budget 3 attempts.',
  });
}, 60000);

describe('answerQuestion (retrieval + fake generation)', () => {
  it('grounds the prompt on retrieved material, hydrates fuller bodies, and returns sources', async () => {
    const { gen, calls } = fakeGen();
    const res = await answerQuestion(env as unknown as Env, gen, {
      question: 'payment retry backoff', projectId, projectName: 'askable',
    });
    expect(res.mode).toBe('keyword'); // no embeddings backend in workerd tests
    expect(res.answer).toContain('Grounded');
    expect(res.sources.length).toBeGreaterThan(0);
    expect(res.sources.some((s) => s.kind === 'doc')).toBe(true);

    const [system, user] = calls[0]!;
    expect(system!.role).toBe('system');
    expect(user!.content).toContain('QUESTION: payment retry backoff');
    // "budget 3 attempts" lives only in the doc BODY (snippet = its description) — its
    // presence proves the fuller-body hydration beyond the 200-char search snippet.
    expect(user!.content).toContain('budget 3 attempts');
  });

  it('still answers (with empty sources) when nothing matches', async () => {
    const { gen } = fakeGen('The project material retrieved does not cover that.');
    const res = await answerQuestion(env as unknown as Env, gen, {
      question: 'zzznonexistenttermxyz', projectId, projectName: 'askable',
    });
    expect(res.sources).toHaveLength(0);
    expect(res.answer).toContain('does not cover');
  });
});

describe('generationClient gate (unit) — the 503 trigger', () => {
  it('is null without the AI binding, present with it', () => {
    expect(generationClient({} as unknown as Env)).toBeNull();
    expect(generationClient({ AI: { run: async () => ({ response: 'x' }) } } as unknown as Env)).not.toBeNull();
  });
});

describe('REST /api/projects/:pid/ask', () => {
  it('rejects a missing question with 400', async () => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/ask`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/question/i);
  });

  it('requires a session', async () => {
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'anything' }),
    });
    expect(res.status).toBe(401);
  });
});
