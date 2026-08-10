// Global Ask — multi-turn chat for humans across every project they can access.
//
// Retrieval reuses search() (semantic when AI + VECTORIZE exist, keyword otherwise), while
// generation runs on Workers AI. The caller supplies the user's accessible project set; this
// module never broadens it. Conversations remain browser-session state rather than durable
// project data, so Ask is read-only and needs no migration.

import type { Env } from './env';
import { search, type SearchHit } from './search';
import type { ProjectMemoryStub } from './lib/project-memory';
import { buildEntityUri, parseEntityUri } from '@noriq-dev/shared';
import { DEFAULT_ASK_MODEL_ID } from './ask-models';
import { NORIQ_ASK_SYSTEM_PROMPT } from './ask-system-prompt';

export const GENERATION_MODEL = DEFAULT_ASK_MODEL_ID;
const CONTEXT_HITS = 8;
const CONTEXT_CHARS = 1200;
export const DEFAULT_ASK_MAX_OUTPUT_TOKENS = 4096;
export const MIN_ASK_MAX_OUTPUT_TOKENS = 256;
export const MAX_ASK_MAX_OUTPUT_TOKENS = 32768;
const TOOL_DECISION_TOKENS = 256;
const MAX_QUESTION_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 4000;
const GRAPH_SEED_PROJECTS = 4;
const GRAPH_BOOST = 0.2;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type AskInputReference =
  | { kind: 'project'; id: string; token: string }
  | { kind: 'task'; id: string; key: string; token: string };

export interface AskHistoryMessage extends Pick<ChatMessage, 'role' | 'content'> {
  /** Server-stored composer selections. Client-supplied history never gets to populate this. */
  references?: AskInputReference[];
}

export interface GenerationClient {
  generate(messages: ChatMessage[], opts: { maxTokens: number }): Promise<string>;
}

export interface StreamingGenerationClient {
  stream(messages: ChatMessage[], opts: { maxTokens: number }): Promise<ReadableStream<Uint8Array>>;
}

/** Wrangler vars arrive as strings. Invalid values use the documented default; valid values are
 * clamped below GPT-OSS's 128k total context window so one deployment typo cannot exhaust it. */
export function askOutputTokenLimit(env: Pick<Env, 'ASK_MAX_OUTPUT_TOKENS'>): number {
  const parsed = Number.parseInt(env.ASK_MAX_OUTPUT_TOKENS ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_ASK_MAX_OUTPUT_TOKENS;
  return Math.min(Math.max(parsed, MIN_ASK_MAX_OUTPUT_TOKENS), MAX_ASK_MAX_OUTPUT_TOKENS);
}

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' ? value as JsonObject : null;
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Workers AI has served GPT-OSS through legacy text-generation, Chat Completions, and
 * Responses API envelopes. Parse all three deliberately; an unknown/empty envelope is an error,
 * never a successful blank answer. */
export function extractGeneratedText(value: unknown): string {
  const root = asObject(value);
  if (!root) return '';
  for (const candidate of [root.response, root.output_text]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const nested of [root.response, root.result]) {
    if (asObject(nested)) {
      const text = extractGeneratedText(nested);
      if (text) return text;
    }
  }
  const choice = asObject(asArray(root.choices)[0]);
  const choiceContent = asObject(choice?.message)?.content;
  if (typeof choiceContent === 'string' && choiceContent.trim()) return choiceContent.trim();

  const outputText: string[] = [];
  for (const itemValue of asArray(root.output)) {
    const item = asObject(itemValue);
    if (item?.type !== 'message') continue; // never surface hidden reasoning items
    for (const contentValue of asArray(item.content)) {
      const content = asObject(contentValue);
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') {
        outputText.push(content.text);
      }
    }
  }
  return outputText.join('').trim();
}

/** Extract only user-visible answer deltas, deliberately excluding reasoning events. */
export function extractStreamDelta(value: unknown): string {
  const root = asObject(value);
  if (!root) return '';
  if (root.type === 'response.output_text.delta' && typeof root.delta === 'string') return root.delta;
  if (typeof root.response === 'string') return root.response;
  const choice = asObject(asArray(root.choices)[0]);
  const content = asObject(choice?.delta)?.content;
  if (typeof content === 'string') return content;
  const delta = asObject(root.delta);
  return delta?.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : '';
}

/** Responses API may provide a model-authored public reasoning summary separately from hidden
 * reasoning tokens. Only that explicit summary channel is safe to expose in the UI. */
export function extractReasoningSummaryDelta(value: unknown): string {
  const root = asObject(value);
  return root?.type === 'response.reasoning_summary_text.delta' && typeof root.delta === 'string'
    ? root.delta
    : '';
}

export function generationClient(env: Env, model = GENERATION_MODEL): GenerationClient | null {
  if (!env.AI) return null;
  const ai = env.AI;
  return {
    async generate(messages, opts) {
      const res = await ai.run(model, { messages, max_tokens: opts.maxTokens });
      const text = extractGeneratedText(res);
      if (!text) throw new Error('Workers AI returned no answer text');
      return text;
    },
  };
}

export function streamingGenerationClient(env: Env, model = GENERATION_MODEL): StreamingGenerationClient | null {
  if (!env.AI) return null;
  const ai = env.AI;
  return {
    async stream(messages, opts) {
      const result = await ai.run(model, { messages, max_tokens: opts.maxTokens, stream: true });
      if (!(result instanceof ReadableStream)) throw new Error('Workers AI returned a non-streaming response');
      return result as ReadableStream<Uint8Array>;
    },
  };
}

export interface AskProject {
  id: string;
  key: string;
  name: string;
}

export interface AskProjectTag {
  tag: string;
  projectId: string;
  projectKey: string;
  projectName: string;
}

const MAX_ASK_INPUT_REFERENCES = 12;

/** Keep only the narrow data emitted by a picker selection. This metadata still grants no access:
 * project/task resolution applies the signed-in caller's workspace boundary again at use time. */
export function normalizeAskReferences(value: unknown): AskInputReference[] {
  if (!Array.isArray(value)) return [];
  const references: AskInputReference[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const item = asObject(candidate);
    if (!item || (item.kind !== 'project' && item.kind !== 'task')
      || typeof item.id !== 'string' || typeof item.token !== 'string') continue;
    const id = item.id.trim().slice(0, 128);
    const token = item.token.trim().slice(0, 80);
    const key = `${item.kind}:${id}`;
    if (!id || !token || seen.has(key)) continue;
    if (item.kind === 'project' && /^@[a-z0-9][a-z0-9_-]{0,63}$/i.test(token)) {
      references.push({ kind: 'project', id, token });
      seen.add(key);
    } else if (item.kind === 'task' && typeof item.key === 'string') {
      const taskKey = item.key.trim().toUpperCase();
      if (/^[A-Z][A-Z0-9]{0,7}-[1-9][0-9]*$/.test(taskKey) && token.toUpperCase() === `#${taskKey}`) {
        references.push({ kind: 'task', id, key: taskKey, token: `#${taskKey}` });
        seen.add(key);
      }
    }
    if (references.length >= MAX_ASK_INPUT_REFERENCES) break;
  }
  return references;
}

export function resolveAskProjectSelections(
  references: readonly AskInputReference[],
  projects: AskProject[],
): AskProjectTag[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return normalizeAskReferences(references).flatMap((reference) => {
    if (reference.kind !== 'project') return [];
    const project = byId.get(reference.id);
    return project ? [{
      tag: reference.token,
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
    }] : [];
  });
}

const projectNameTag = (name: string): string => name
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

/** Resolve only tags naming a project already inside the authenticated directory. Unknown @text
 * (people, model ids, email-like text) remains ordinary prompt content and cannot broaden scope. */
export function resolveAskProjectTags(question: string, projects: AskProject[]): AskProjectTag[] {
  const tags: AskProjectTag[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|[\s([{])@([a-z0-9][a-z0-9_-]{0,63})\b/gi;
  for (const match of question.matchAll(pattern)) {
    const token = match[1]!.toLowerCase();
    let candidates = projects.filter((project) => project.key.toLowerCase() === token);
    if (!candidates.length) candidates = projects.filter((project) => projectNameTag(project.name) === token);
    if (candidates.length !== 1 || seen.has(candidates[0]!.id)) continue;
    const project = candidates[0]!;
    seen.add(project.id);
    tags.push({
      tag: `@${match[1]}`,
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
    });
  }
  return tags;
}

const actionFollowUpPattern = /^(?:(?:yes|ok(?:ay)?|sure)[,.!]?\s+)?(?:(?:please|go\s+ahead\s+and)\s+)?(?:create|submit|propose|update|edit|change)\s+(?:it|that|this|the\s+task)(?:\s+(?:now|please))?[.!]?$/i;

export function isAskTaskActionFollowUp(question: string): boolean {
  return actionFollowUpPattern.test(question.trim());
}

/** A short action continuation may omit the @project tag because the user already supplied it in
 * the preceding request. Inherit only server-resolvable tags from prior USER messages, and only
 * for an explicit deictic task-action follow-up, so an unrelated next question never stays scoped. */
export function resolveAskProjectTagsForTurn(
  question: string,
  history: AskHistoryMessage[],
  projects: AskProject[],
  references: readonly AskInputReference[] = [],
): AskProjectTag[] {
  const current = resolveAskProjectSelections(references, projects);
  if (current.length || !isAskTaskActionFollowUp(question)) return current;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== 'user') continue;
    const inherited = resolveAskProjectSelections(message.references ?? [], projects);
    if (inherited.length) return inherited;
  }
  return [];
}

export type AskTaskActionIntent = 'create' | 'update';

/** Detect only narrow, singular task-action language. The model still validates whether the target
 * and fields are clear; this signal merely prevents a prose-only answer from skipping the durable
 * proposal route altogether. */
export function askTaskActionIntent(question: string): AskTaskActionIntent | null {
  const text = question.trim();
  if (!text || /\b(?:tasks|suites?|decompos(?:e|ition))\b/i.test(text)
    || /\b(?:create|add|draft|make)\s+(?:a\s+)?plan\b/i.test(text)) return null;
  if (isAskTaskActionFollowUp(text)) {
    return /\b(?:update|edit|change)\b/i.test(text) ? 'update' : 'create';
  }
  if (/\b(?:create|add|file|open)\b[\s\S]{0,80}\b(?:task|bug|feature|chore|research)\b/i.test(text)
    || /\b(?:task|bug|feature|chore|research)\b[\s\S]{0,80}\b(?:create|add|file|open)\b/i.test(text)) return 'create';
  if (/\b(?:update|edit|change)\b[\s\S]{0,80}\btask\b/i.test(text)) return 'update';
  return null;
}

export function stripAskProjectTags(question: string, tags: AskProjectTag[]): string {
  const values = new Set(tags.map((tag) => tag.tag.toLowerCase()));
  return question
    .split(/(\s+)/)
    .filter((part) => !values.has(part.replace(/^[([{]|[\])},.!?;:]+$/g, '').toLowerCase()))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export function askProjectTagSources(projectTags: AskProjectTag[]): AskSource[] {
  return projectTags.map((tag) => ({
    kind: 'project', id: tag.projectId, title: tag.projectName, score: 1,
    projectId: tag.projectId, projectKey: tag.projectKey, projectName: tag.projectName,
    citation: `${tag.projectKey} / project:${tag.projectId}`, tag: tag.tag, retrieval: 'live',
  }));
}

export type AskSourceKind = SearchHit['kind'] | 'project' | 'run' | 'signal' | 'comment';

export interface AskSource {
  kind: AskSourceKind;
  id: string;
  key?: string;
  title: string;
  status?: string;
  score: number;
  projectId: string;
  projectKey: string;
  projectName: string;
  authority?: number;
  validity?: string;
  isLead?: boolean;
  leadReasons?: string[];
  historical?: boolean;
  graphPath?: string;
  evidenceVerifiedForCaller?: Array<boolean | null>;
  citation?: string;
  updatedAt?: string;
  /** Explicit @project routing tag. Present only on the trusted project-scope source. */
  tag?: string;
  retrieval: 'semantic' | 'keyword' | 'graph' | 'hybrid' | 'live';
}

export interface AskResult {
  answer: string;
  sources: AskSource[];
  projectTags: AskProjectTag[];
  mode: 'semantic' | 'keyword' | null;
  model: string;
  graphEnhanced: boolean;
}

export interface PreparedAsk extends Omit<AskResult, 'answer' | 'projectTags'> {
  messages: ChatMessage[];
  projectTags?: AskProjectTag[];
}

export interface RetrievalDecisionClient {
  select(question: string, history: AskHistoryMessage[]): Promise<string | null>;
}

interface AskSearchHit extends SearchHit {
  retrieval: AskSource['retrieval'];
  graphPath?: string;
  isLead?: boolean;
  leadReasons?: string[];
  evidenceVerifiedForCaller?: Array<boolean | null>;
}

export interface AskFinishState { finishReason: string | null; truncated: boolean }

/** Normalize the finish metadata emitted by Responses and Chat Completions streams. */
export function extractFinishState(value: unknown): AskFinishState | null {
  const root = asObject(value);
  if (!root) return null;
  const choice = asObject(asArray(root.choices)[0]);
  if (typeof choice?.finish_reason === 'string') {
    return { finishReason: choice.finish_reason, truncated: choice.finish_reason === 'length' };
  }
  if (root.type !== 'response.completed' && root.type !== 'response.incomplete') return null;
  const response = asObject(root.response) ?? root;
  const incomplete = asObject(response.incomplete_details);
  const reason = typeof incomplete?.reason === 'string'
    ? incomplete.reason
    : root.type === 'response.completed' ? 'stop' : 'incomplete';
  return { finishReason: reason, truncated: root.type === 'response.incomplete' || response.status === 'incomplete' };
}

/** Read the traditional Chat Completions, legacy Workers AI, and Responses API tool-call shapes. */
export function extractRetrievalToolQuery(value: unknown): string | null {
  const root = asObject(value);
  if (!root) return null;
  const containers = [
    root,
    asObject(root.result),
    asObject(root.response),
    asObject(asObject(asArray(root.choices)[0])?.message),
  ].filter((item): item is JsonObject => !!item);
  const calls = containers.flatMap((container) => [
    ...asArray(container.tool_calls),
    ...asArray(container.output).filter((item) => asObject(item)?.type === 'function_call'),
  ]);
  for (const value of calls) {
    const call = asObject(value);
    const fn = asObject(call?.function);
    const name = typeof call?.name === 'string' ? call.name : typeof fn?.name === 'string' ? fn.name : '';
    if (name !== 'search_noriq') continue;
    const raw = call?.arguments ?? fn?.arguments;
    let args = asObject(raw);
    if (!args && typeof raw === 'string') {
      try { args = asObject(JSON.parse(raw)); } catch { /* malformed call falls back to question */ }
    }
    return typeof args?.query === 'string' && args.query.trim() ? args.query.trim().slice(0, MAX_QUESTION_CHARS) : '';
  }
  return null;
}

export function retrievalDecisionClient(env: Env, model = GENERATION_MODEL): RetrievalDecisionClient | null {
  if (!env.AI) return null;
  const ai = env.AI;
  return {
    async select(question, history) {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: [
            'Decide whether the latest request needs current or private evidence from the user\'s Noriq workspace.',
            'Call search_noriq exactly once when answering depends on their projects, tasks, plans, docs, runs, memories, decisions, or current state.',
            'Do not call it for greetings, casual conversation, general knowledge, generic writing, or brainstorming unrelated to their workspace.',
            'If no workspace evidence is needed, answer only NO_SEARCH.',
          ].join(' '),
        },
        ...normalizeHistory(history),
        { role: 'user', content: question },
      ];
      const result = await ai.run(model, {
        messages,
        tools: [{
          type: 'function',
          function: {
            name: 'search_noriq',
            description: 'Search the user\'s accessible Noriq tasks, plans, docs, memories, episodes, and knowledge-graph connections for current project evidence.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: 'A focused semantic query for the needed workspace evidence.' } },
              required: ['query'],
            },
          },
        }],
        max_tokens: TOOL_DECISION_TOKENS,
      });
      const query = extractRetrievalToolQuery(result);
      return query === '' ? question : query;
    },
  };
}

/** Accept only user/assistant content from the client. System messages are never
 * trusted, and both message count and individual content are bounded before reaching the model. */
export function normalizeHistory(value: unknown): AskHistoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is { role: 'user' | 'assistant'; content: string } =>
      !!m && typeof m === 'object'
      && ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant')
      && typeof (m as { content?: unknown }).content === 'string')
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_HISTORY_CHARS) }))
    .filter((m) => m.content.length > 0);
}

const projectMemory = (env: Env, projectId: string): ProjectMemoryStub =>
  env.PROJECT_MEMORY.get(env.PROJECT_MEMORY.idFromName(projectId)) as unknown as ProjectMemoryStub;

const graphSeedUri = (hit: SearchHit): string | null => {
  switch (hit.kind) {
    case 'task': return buildEntityUri({ kind: 'task', id: hit.id });
    case 'doc': return buildEntityUri({ kind: 'artifact', id: hit.id });
    case 'plan': return buildEntityUri({ kind: 'plan', id: hit.id });
    case 'memory': return buildEntityUri({ kind: 'memory', id: hit.id });
    case 'episode': return buildEntityUri({ kind: 'episode', id: hit.id });
  }
};

function graphNodeToHit(
  projectId: string,
  result: Awaited<ReturnType<ProjectMemoryStub['searchProjectMemory']>>['results'][number],
): AskSearchHit | null {
  if (result.stage !== 'graph' || !result.uri) return null;
  let ref;
  try { ref = parseEntityUri(result.uri); } catch { return null; }
  let kind: SearchHit['kind'];
  let id: string;
  switch (ref.kind) {
    case 'task': kind = 'task'; id = ref.id; break;
    case 'artifact': kind = 'doc'; id = ref.id; break;
    case 'plan': kind = 'plan'; id = ref.id; break;
    case 'memory': kind = 'memory'; id = ref.id; break;
    case 'episode': kind = 'episode'; id = ref.id; break;
    default: return null; // code/internal nodes are useful traversal bridges, not answer sources
  }
  return {
    kind,
    id,
    projectId,
    title: result.title,
    snippet: result.snippet,
    score: result.finalScore * 0.75,
    status: result.status,
    authority: result.authority,
    validity: result.validity,
    retrieval: 'graph',
    graphPath: result.edgePath,
  };
}

/** Hydrate graph-only candidates from their canonical stores so the model gets actual project
 * content rather than graph labels. Text-search hits are already hydrated by search.ts. */
async function hydrateGraphHits(env: Env, hits: AskSearchHit[]): Promise<AskSearchHit[]> {
  const graphHits = hits.filter((hit) => hit.retrieval === 'graph');
  const canonical = new Map<string, Partial<SearchHit>>();
  const ids = (kind: SearchHit['kind']) => graphHits.filter((hit) => hit.kind === kind).map((hit) => hit.id);
  const inList = (values: string[]) => values.map(() => '?').join(',');

  const taskIds = ids('task');
  if (taskIds.length) {
    const { results } = await env.DB.prepare(
      `SELECT id, key, title, substr(body, 1, 200) AS snippet,
              CASE WHEN failed_at IS NOT NULL THEN 'failed' ELSE status END AS status
         FROM tasks WHERE id IN (${inList(taskIds)})`,
    ).bind(...taskIds).all<{ id: string; key: string; title: string; snippet: string | null; status: string }>();
    for (const row of results) canonical.set(`task:${row.id}`, { ...row, snippet: row.snippet ?? '' });
  }
  const docIds = ids('doc');
  if (docIds.length) {
    const { results } = await env.DB.prepare(
      `SELECT id, name AS title, COALESCE(NULLIF(description, ''), substr(body, 1, 200), '') AS snippet
         FROM docs WHERE id IN (${inList(docIds)})`,
    ).bind(...docIds).all<{ id: string; title: string; snippet: string }>();
    for (const row of results) canonical.set(`doc:${row.id}`, row);
  }
  const planIds = ids('plan');
  if (planIds.length) {
    const { results } = await env.DB.prepare(
      `SELECT id, title, COALESCE(NULLIF(description, ''), substr(body, 1, 200), '') AS snippet, status
         FROM plans WHERE id IN (${inList(planIds)})`,
    ).bind(...planIds).all<{ id: string; title: string; snippet: string; status: string }>();
    for (const row of results) canonical.set(`plan:${row.id}`, row);
  }

  const memoryByProject = new Map<string, Array<{ kind: 'memory' | 'episode'; id: string }>>();
  for (const hit of graphHits) {
    if (hit.kind !== 'memory' && hit.kind !== 'episode') continue;
    const projectHits = memoryByProject.get(hit.projectId) ?? [];
    projectHits.push({ kind: hit.kind, id: hit.id });
    memoryByProject.set(hit.projectId, projectHits);
  }
  await Promise.all([...memoryByProject.entries()].map(async ([projectId, refs]) => {
    const rows = await projectMemory(env, projectId).hydrateSearchHits(projectId, refs);
    for (const row of rows) canonical.set(`${row.kind}:${row.id}`, row);
  }));

  return hits.flatMap((hit) => {
    if (hit.retrieval !== 'graph') return [hit];
    const row = canonical.get(`${hit.kind}:${hit.id}`);
    return row ? [{ ...hit, ...row, score: hit.score, retrieval: hit.retrieval, graphPath: hit.graphPath }] : [];
  });
}

/** Memory hits from the global search index only carry lightweight authority/validity fields.
 * Re-read selected memories through canonical ProjectMemory retrieval so Ask receives the same
 * lead and evidence-scope judgement as search_project_memory. */
async function enrichMemoryTruth(env: Env, hits: AskSearchHit[]): Promise<AskSearchHit[]> {
  return Promise.all(hits.map(async (hit) => {
    if (hit.kind !== 'memory') return hit;
    try {
      const exact = await projectMemory(env, hit.projectId).searchProjectMemory(hit.projectId, { memoryItemId: hit.id, limit: 1 });
      const canonical = exact.results.find((candidate) => candidate.entityType === 'memory' && candidate.id === hit.id);
      return canonical ? {
        ...hit,
        authority: canonical.authority,
        validity: canonical.validity,
        isLead: canonical.isLead,
        leadReasons: canonical.leadReasons,
        evidenceVerifiedForCaller: canonical.evidenceVerifiedForCaller,
      } : hit;
    } catch {
      return { ...hit, isLead: true, leadReasons: ['canonical-memory-unavailable'] };
    }
  }));
}

/** Text relevance stays the recall layer; the best hit in each matched project seeds one bounded
 * graph hop. A hit found both ways is boosted and labelled hybrid, while graph-only canonical
 * project entities can enter the context at a discounted score. */
async function hybridAskSearch(
  env: Env,
  question: string,
  projectIds: string[],
): Promise<{ mode: 'semantic' | 'keyword'; results: AskSearchHit[]; graphEnhanced: boolean }> {
  const initial = await search(env, { q: question, projectIds, limit: CONTEXT_HITS * 2 });
  const textHits: AskSearchHit[] = initial.results.map((hit) => ({ ...hit, retrieval: initial.mode }));
  const seededProjects = new Set<string>();
  const seeds: Array<{ projectId: string; uri: string }> = [];
  for (const hit of textHits) {
    if (seededProjects.has(hit.projectId)) continue;
    const uri = graphSeedUri(hit);
    if (!uri) continue;
    seededProjects.add(hit.projectId);
    seeds.push({ projectId: hit.projectId, uri });
    if (seeds.length >= GRAPH_SEED_PROJECTS) break;
  }
  const graphGroups = await Promise.all(seeds.map(async ({ projectId, uri }) => {
    try {
      const result = await projectMemory(env, projectId).searchProjectMemory(projectId, {
        seedEntityUri: uri,
        maxDepth: 1,
        limit: CONTEXT_HITS,
      });
      return result.results.flatMap((hit) => {
        const mapped = graphNodeToHit(projectId, hit);
        return mapped ? [mapped] : [];
      });
    } catch {
      return []; // graph availability enriches Ask; it never takes ordinary search down
    }
  }));
  const graphHits = await hydrateGraphHits(env, graphGroups.flat());
  const merged = new Map<string, AskSearchHit>();
  for (const hit of textHits) merged.set(`${hit.kind}:${hit.id}`, hit);
  for (const hit of graphHits) {
    const key = `${hit.kind}:${hit.id}`;
    const previous = merged.get(key);
    if (previous) {
      merged.set(key, {
        ...previous,
        score: previous.score + GRAPH_BOOST,
        retrieval: 'hybrid',
        graphPath: hit.graphPath,
      });
    } else {
      merged.set(key, hit);
    }
  }
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const results = ranked.slice(0, CONTEXT_HITS);
  const bestGraph = ranked.find((hit) => hit.retrieval === 'graph' || hit.retrieval === 'hybrid');
  if (bestGraph && !results.some((hit) => hit.retrieval === 'graph' || hit.retrieval === 'hybrid')) {
    if (results.length >= CONTEXT_HITS) results[results.length - 1] = bestGraph;
    else results.push(bestGraph);
  }
  const enriched = await enrichMemoryTruth(env, results);
  return { mode: initial.mode, results: enriched, graphEnhanced: enriched.some((hit) => hit.retrieval === 'graph' || hit.retrieval === 'hybrid') };
}

async function contextBlocks(env: Env, hits: AskSearchHit[]): Promise<Array<{ hit: AskSearchHit; text: string }>> {
  const db = env.DB;
  const ids: Partial<Record<SearchHit['kind'], string[]>> = {};
  for (const h of hits) (ids[h.kind] ??= []).push(h.id);
  const body = new Map<string, string>();
  const inList = (a: string[]) => a.map(() => '?').join(',');
  const load = async (kind: SearchHit['kind'], table: string) => {
    const kindIds = ids[kind];
    if (!kindIds?.length) return;
    const { results } = await db
      .prepare(`SELECT id, substr(body, 1, ${CONTEXT_CHARS}) AS body FROM ${table} WHERE id IN (${inList(kindIds)})`)
      .bind(...kindIds)
      .all<{ id: string; body: string | null }>();
    for (const r of results) body.set(`${kind}:${r.id}`, r.body ?? '');
  };
  await load('task', 'tasks');
  await load('doc', 'docs');
  await load('plan', 'plans');
  await Promise.all(hits.filter((hit) => hit.kind === 'memory').map(async (hit) => {
    try {
      const memory = await projectMemory(env, hit.projectId).getMemoryItem(hit.projectId, hit.id);
      if (memory) body.set(`memory:${hit.id}`, memory.statement.slice(0, CONTEXT_CHARS));
    } catch { /* the search snippet remains a safe degraded context */ }
  }));
  return hits.map((hit) => {
    const full = body.get(`${hit.kind}:${hit.id}`);
    const text = full && full.trim() ? full : hit.snippet;
    const historical = hit.kind === 'task' && (hit.status === 'done' || hit.status === 'cancelled');
    return { hit, text: historical ? `[HISTORICAL TASK BODY — status is ${hit.status}; this describes the problem/work at the time, not current system state.]\n${text}` : text };
  });
}

const sourceLabel = (h: SearchHit, project?: AskProject): string => {
  const ref = h.key ?? h.id;
  const status = h.status ? `, ${h.status}` : '';
  const authority = h.authority != null ? `, authority ${h.authority}` : '';
  const validity = h.validity ? `, ${h.validity}` : '';
  const projectRef = project ? `${project.key} / ` : '';
  const askHit = h as AskSearchHit;
  const historical = h.kind === 'task' && (h.status === 'done' || h.status === 'cancelled') ? ', HISTORICAL' : '';
  const lead = askHit.isLead ? `, LEAD: ${(askHit.leadReasons ?? []).join('|') || 'provisional'}` : '';
  const graph = askHit.graphPath ? `, GRAPH_PATH ${askHit.graphPath}` : '';
  return `${projectRef}${h.kind.toUpperCase()} ${ref} (${h.title}${status}${authority}${validity}${historical}${lead}${graph})`;
};

const sourceRef = (h: SearchHit, project?: AskProject): string => `${project?.key ?? h.projectId} / ${h.key ?? `${h.kind}:${h.id}`}`;

/** Build one general-assistant prompt with optional, untrusted project context. General questions
 * may be answered normally; project-specific claims must stay grounded in the supplied sources. */
export function buildMessages(
  question: string,
  projects: AskProject[],
  blocks: Array<{ hit: SearchHit; text: string }>,
  history: AskHistoryMessage[] = [],
  retrievalAttempted = true,
  projectTags: AskProjectTag[] = [],
): ChatMessage[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const context = blocks.length
    ? blocks.map((b) => `SOURCE_REF: ${sourceRef(b.hit, byId.get(b.hit.projectId))}\n${sourceLabel(b.hit, byId.get(b.hit.projectId))}\n${b.text}`).join('\n\n---\n\n')
    : '(search_noriq found no matching project material)';
  const latest = retrievalAttempted
    ? `PROJECT CONTEXT:\n\n${context}\n\n---\n\nCURRENT QUESTION: ${question}`
    : `CURRENT QUESTION: ${question}`;
  const scope = projectTags.length
    ? `PROJECT TAG SCOPE (trusted server-resolved routing metadata): ${JSON.stringify(projectTags)}. Workspace tools and project evidence for this turn are restricted to ${projectTags.length === 1 ? 'this project' : 'these projects'}.\n\n`
    : '';
  return [
    { role: 'system', content: NORIQ_ASK_SYSTEM_PROMPT },
    ...normalizeHistory(history),
    { role: 'user', content: scope + latest },
  ];
}

export interface AskOptions {
  question: string;
  projects: AskProject[];
  model?: string;
  history?: AskHistoryMessage[];
  references?: AskInputReference[];
  retrieval?: RetrievalDecisionClient | null;
  onRetrieval?: () => void | Promise<void>;
}

export interface AskWorkspaceSearchResult {
  content: string;
  sources: AskSource[];
  mode: 'semantic' | 'keyword';
  graphEnhanced: boolean;
  blocks: Array<{ hit: SearchHit; text: string }>;
}

/** Execute Ask's current semantic/graph workspace search and return a model-safe evidence block. */
export async function searchAskWorkspace(env: Env, query: string, projects: AskProject[]): Promise<AskWorkspaceSearchResult> {
  const { mode, results, graphEnhanced } = await hybridAskSearch(env, query, projects.map((project) => project.id));
  const blocks = await contextBlocks(env, results);
  const byId = new Map(projects.map((project) => [project.id, project]));
  const blockText = blocks.map((block) => {
    const project = byId.get(block.hit.projectId);
    return `SOURCE_REF: ${sourceRef(block.hit, project)}\n${sourceLabel(block.hit, project)}\n${block.text}`;
  }).join('\n\n---\n\n');
  const sources: AskSource[] = results.flatMap((hit) => {
    const project = byId.get(hit.projectId);
    return project ? [{
      kind: hit.kind,
      id: hit.id,
      key: hit.key,
      title: hit.title,
      status: hit.status,
      score: hit.score,
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
      authority: hit.authority,
      validity: hit.validity,
      isLead: hit.isLead,
      leadReasons: hit.leadReasons,
      historical: hit.kind === 'task' && (hit.status === 'done' || hit.status === 'cancelled'),
      graphPath: hit.graphPath,
      evidenceVerifiedForCaller: hit.evidenceVerifiedForCaller,
      retrieval: hit.retrieval,
    }] : [];
  });
  return {
    content: blockText || '(search_noriq found no matching project material)',
    sources,
    mode,
    graphEnhanced,
    blocks,
  };
}

export async function prepareQuestion(env: Env, opts: AskOptions): Promise<PreparedAsk> {
  const question = opts.question.trim().slice(0, MAX_QUESTION_CHARS);
  const history = normalizeHistory(opts.history);
  const model = opts.model ?? GENERATION_MODEL;
  const projectTags = resolveAskProjectTagsForTurn(question, opts.history ?? [], opts.projects, opts.references);
  const projects = projectTags.length
    ? opts.projects.filter((project) => projectTags.some((tag) => tag.projectId === project.id))
    : opts.projects;
  const tagSources = askProjectTagSources(projectTags);
  const retrieval = opts.retrieval === undefined ? retrievalDecisionClient(env, model) : opts.retrieval;
  const taggedQuery = stripAskProjectTags(question, projectTags)
    || projectTags.map((tag) => tag.projectName).join(' ');
  const retrievalQuery = projectTags.length ? taggedQuery : await retrieval?.select(question, history) ?? null;
  if (retrievalQuery === null) {
    return {
      messages: buildMessages(question, projects, [], history, false, projectTags),
      sources: tagSources,
      projectTags,
      mode: null,
      model,
      graphEnhanced: false,
    };
  }
  await opts.onRetrieval?.();
  const searched = await searchAskWorkspace(env, retrievalQuery, projects);
  return {
    messages: buildMessages(question, projects, searched.blocks, history, true, projectTags),
    sources: [...tagSources, ...searched.sources],
    projectTags,
    mode: searched.mode,
    model,
    graphEnhanced: searched.graphEnhanced,
  };
}

export async function answerQuestion(env: Env, gen: GenerationClient, opts: AskOptions): Promise<AskResult> {
  const prepared = await prepareQuestion(env, opts);
  const answer = (await gen.generate(prepared.messages, { maxTokens: askOutputTokenLimit(env) })).trim();
  if (!answer) throw new Error('Workers AI returned no answer text');
  return {
    answer,
    sources: prepared.sources,
    projectTags: prepared.projectTags ?? [],
    mode: prepared.mode,
    model: prepared.model,
    graphEnhanced: prepared.graphEnhanced,
  };
}

const sse = (event: string, data: unknown): Uint8Array =>
  new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export interface AskGenerationResult extends AskFinishState {
  answer: string;
  reasoning: string;
}

export interface AskGenerationCallbacks {
  onReasoning?: (delta: string) => void | Promise<void>;
  onDelta?: (delta: string) => void | Promise<void>;
  shouldContinue?: () => boolean | Promise<boolean>;
}

/** Consume one Workers AI stream independently of any browser response. This is the generation
 * primitive used by both the legacy direct SSE adapter and the alarm-owned durable job. */
export async function consumeAskGeneration(
  gen: StreamingGenerationClient,
  prepared: PreparedAsk,
  callbacks: AskGenerationCallbacks = {},
  maxTokens = DEFAULT_ASK_MAX_OUTPUT_TOKENS,
): Promise<AskGenerationResult | null> {
  const upstream = await gen.stream(prepared.messages, { maxTokens });
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let emitted = false;
  let finalCandidate = '';
  const answerParts: string[] = [];
  const reasoningParts: string[] = [];
  let finish: AskFinishState = { finishReason: null, truncated: false };

  const consumeLine = async (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { return; }
    const upstreamError = asObject(asObject(payload)?.error)?.message ?? asObject(payload)?.error;
    if (typeof upstreamError === 'string') throw new Error(`Workers AI: ${upstreamError}`);
    finish = extractFinishState(payload) ?? finish;
    const reasoningSummary = extractReasoningSummaryDelta(payload);
    if (reasoningSummary) {
      reasoningParts.push(reasoningSummary);
      await callbacks.onReasoning?.(reasoningSummary);
    }
    const delta = extractStreamDelta(payload);
    if (delta) {
      emitted = true;
      answerParts.push(delta);
      await callbacks.onDelta?.(delta);
    } else {
      const candidate = extractGeneratedText(payload);
      if (candidate) finalCandidate = candidate;
    }
  };

  try {
    while (await callbacks.shouldContinue?.() ?? true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) await consumeLine(line);
    }
    if (callbacks.shouldContinue && !await callbacks.shouldContinue()) {
      await reader.cancel();
      return null;
    }
    buffer += decoder.decode();
    if (buffer) await consumeLine(buffer);
    if (!emitted && finalCandidate) {
      emitted = true;
      answerParts.push(finalCandidate);
      await callbacks.onDelta?.(finalCandidate);
    }
    if (!emitted) throw new Error('Workers AI stream contained no answer text');
    return {
      answer: answerParts.join('').trim(),
      reasoning: reasoningParts.join('').trim(),
      ...finish,
    };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export interface AskEventStreamOptions {
  thread?: { id: string; title: string };
  onComplete?: (result: { answer: string; reasoning: string } & AskFinishState) => Promise<void>;
}

/** Translate Workers AI's own SSE dialect into the small, stable stream consumed by the web UI.
 * Sources arrive before inference begins; answer tokens follow as `delta` events. */
export function askEventStream(
  gen: StreamingGenerationClient,
  prepared: PreparedAsk,
  options: AskEventStreamOptions = {},
): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (options.thread) controller.enqueue(sse('thread', options.thread));
      controller.enqueue(sse('meta', {
        sources: prepared.sources,
        projectTags: prepared.projectTags ?? [],
        mode: prepared.mode,
        model: prepared.model,
        graphEnhanced: prepared.graphEnhanced,
      }));
      controller.enqueue(sse('status', { phase: 'generating' }));
      try {
        const result = await consumeAskGeneration(gen, prepared, {
          shouldContinue: () => !cancelled,
          onReasoning: (text) => controller.enqueue(sse('reasoning', { text })),
          onDelta: (text) => controller.enqueue(sse('delta', { text })),
        });
        if (!result || cancelled) return;
        await options.onComplete?.(result);
        controller.enqueue(sse('done', { finishReason: result.finishReason, truncated: result.truncated }));
        controller.close();
      } catch (error) {
        if (cancelled) return;
        controller.enqueue(sse('error', { error: error instanceof Error ? error.message : 'generation failed' }));
        controller.close();
      }
    },
    async cancel() {
      cancelled = true;
    },
  });
}
