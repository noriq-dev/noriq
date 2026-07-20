// PLNR-219: "ask the project" — read-only RAG Q&A over a project's tasks/docs/plans.
//
// Retrieval REUSES the PLNR-184 search() (semantic when the AI + VECTORIZE bindings exist,
// keyword otherwise); generation runs on Workers AI (env.AI). This is a web-UI surface (a
// dedicated Ask tab) — NOT an MCP tool, and it creates NOTHING: retrieve → ground → answer,
// with a visible citation trail (the retrieved hits are returned as `sources`).
//
// The generation dependency is a narrow injected interface (mirrors EmbeddingClient in
// search.ts) so tests fake it and no real GPU runs in the workerd pool; the Workers AI
// binding only appears in generationClient(env). Generation REQUIRES env.AI — retrieval can
// still degrade to keyword without VECTORIZE, but there is no model to answer with, so the
// route 503s when AI is absent.

import type { Env } from './env';
import { search, type SearchHit } from './search';

// Strongest general model on Workers AI; still comfortably inside the free neuron allocation
// at low volume. Swap here if a cheaper/faster model is preferred (e.g. llama-3.1-8b).
const GENERATION_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// How many top hits feed the model, and how much of each body — keeps the prompt well under
// the model's context while giving it enough to answer from (the 200-char search snippet is
// too thin, so we re-read fuller bodies from D1).
const CONTEXT_HITS = 6;
const CONTEXT_CHARS = 1200;
const MAX_ANSWER_TOKENS = 700;
const MAX_QUESTION_CHARS = 2000;

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** Narrow generation dependency — one chat completion, returns the assistant text. */
export interface GenerationClient {
  generate(messages: ChatMessage[], opts: { maxTokens: number }): Promise<string>;
}

/** The live client from Worker bindings, or null when env.AI is absent (→ the route 503s). */
export function generationClient(env: Env): GenerationClient | null {
  if (!env.AI) return null;
  const ai = env.AI;
  return {
    async generate(messages, opts) {
      const res = (await ai.run(GENERATION_MODEL, { messages, max_tokens: opts.maxTokens })) as { response?: string };
      return (res.response ?? '').trim();
    },
  };
}

/** One grounding source behind an answer — a slimmed SearchHit (no snippet/body). */
export interface AskSource {
  kind: SearchHit['kind'];
  id: string;
  key?: string;
  title: string;
  status?: string;
  score: number;
}

export interface AskResult {
  answer: string;
  sources: AskSource[];
  /** Which retrieval ran — mirrors search(). */
  mode: 'semantic' | 'keyword';
}

/** Re-read fuller body text for the top hits (the 200-char search snippet is too thin to
 *  answer from). Grouped by kind, one query each; preserves the ranked order and falls back
 *  to the snippet for any row that lost its body between indexing and now. */
async function contextBlocks(db: D1Database, hits: SearchHit[]): Promise<Array<{ hit: SearchHit; text: string }>> {
  const ids: Record<SearchHit['kind'], string[]> = { task: [], doc: [], plan: [] };
  for (const h of hits) ids[h.kind].push(h.id);
  const body = new Map<string, string>();
  const inList = (a: string[]) => a.map(() => '?').join(',');
  const load = async (kind: SearchHit['kind'], table: string) => {
    if (!ids[kind].length) return;
    const { results } = await db
      .prepare(`SELECT id, substr(body, 1, ${CONTEXT_CHARS}) AS body FROM ${table} WHERE id IN (${inList(ids[kind])})`)
      .bind(...ids[kind])
      .all<{ id: string; body: string | null }>();
    for (const r of results) body.set(`${kind}:${r.id}`, r.body ?? '');
  };
  await load('task', 'tasks');
  await load('doc', 'docs');
  await load('plan', 'plans');
  return hits.map((hit) => {
    const full = body.get(`${hit.kind}:${hit.id}`);
    return { hit, text: full && full.trim() ? full : hit.snippet };
  });
}

const sourceLabel = (h: SearchHit): string => {
  const ref = h.key ?? h.id;
  const status = h.status ? `, ${h.status}` : '';
  return `${h.kind.toUpperCase()} ${ref} (${h.title}${status})`;
};

/** Build the grounded prompt. The system message pins the model to the retrieved context
 *  and forbids invention — cheap insurance against an open model confabulating. */
export function buildMessages(question: string, projectName: string, blocks: Array<{ hit: SearchHit; text: string }>): ChatMessage[] {
  const system = [
    `You are a concise assistant answering questions about the software project "${projectName}".`,
    'Answer ONLY from the CONTEXT below — project tasks, docs and plans retrieved for this question.',
    'If the context does not contain the answer, say so plainly ("The project material retrieved does not cover that") — never invent tasks, decisions, dates, or status.',
    'Cite the items you used by their reference (e.g. PLNR-166) inline. Keep it short and specific; use Markdown, and bullet points when listing several items.',
  ].join(' ');
  const context = blocks.length
    ? blocks.map((b, i) => `[${i + 1}] ${sourceLabel(b.hit)}\n${b.text}`).join('\n\n---\n\n')
    : '(no matching project material was found)';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `CONTEXT:\n\n${context}\n\n---\n\nQUESTION: ${question}` },
  ];
}

export interface AskOptions {
  question: string;
  projectId: string;
  projectName: string;
}

/** Retrieve → ground → generate. Returns the answer plus the sources it was grounded on. */
export async function answerQuestion(env: Env, gen: GenerationClient, opts: AskOptions): Promise<AskResult> {
  const question = opts.question.trim().slice(0, MAX_QUESTION_CHARS);
  const { mode, results } = await search(env, { q: question, projectIds: [opts.projectId], limit: CONTEXT_HITS });
  const blocks = await contextBlocks(env.DB, results);
  const answer = await gen.generate(buildMessages(question, opts.projectName, blocks), { maxTokens: MAX_ANSWER_TOKENS });
  const sources: AskSource[] = results.map((h) => ({
    kind: h.kind, id: h.id, key: h.key, title: h.title, status: h.status, score: h.score,
  }));
  return { answer, sources, mode };
}
