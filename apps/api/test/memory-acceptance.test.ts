import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import type { ContextPack, ContextPackSection } from '@noriq-dev/shared';
import { evaluateMemoryAcceptance } from '../src/memory/acceptance';
import { createUser, loginSession, mcpCall, mintTokenForUser } from './helpers';

const memory = (id: string, kind: 'decision' | 'learning') => ({
  excerptKind: 'memory' as const, id, memoryKind: kind, statement: `${kind} statement`, authority: 4 as const,
  confidence: null, validity: 'active', isLead: false, leadReasons: [], recordedByAgentId: 'agt_1',
  recordedAt: '2026-08-09T00:00:00.000Z', supersedesMemoryId: null,
  evidence: [{ repositoryKey: 'noriq', branch: 'main', baseId: 'base-1', path: 'src/x.ts', symbol: null,
    verificationState: 'valid' as const, lastVerifiedAt: '2026-08-09T00:00:00.000Z',
    lastVerifiedBaseId: 'base-1', lastVerifiedBranch: 'main', verifiedForCaller: true }],
});

const section = (id: ContextPackSection['id'], over: Partial<ContextPackSection> = {}): ContextPackSection => ({
  id, provenance: ['none'], notice: null, charsAllotted: 1000, charsUsed: 1,
  excerpts: [], graphEntities: [], coverage: null, items: [], ...over,
});

const passingPack = (): ContextPack => ({
  taskId: 'task_1', projectId: 'prj_1', branch: 'main', baseId: 'base-1', tokenBudget: 4000,
  verifiedDecisions: [], relevantEntities: [], similarEpisodes: ['ep_1'], knownHazards: [],
  affectedTests: ['noriq://test/one'], activeNeighboringWork: [], staleWarnings: [],
  generatedAt: '2026-08-09T00:00:00.000Z', role: 'verify', mode: 'keyword', charBudget: 14000,
  charsUsed: 100, notices: [],
  taskFacts: { taskId: 'task_1', key: 'PLNR-340', title: 'Verify memory', body: null, status: 'todo',
    priority: 1, claimedBy: null, claimExpiresAt: null, openComments: [], executionSpec: null, executionSpecUnreadable: false },
  sections: [
    section('active_decisions', { provenance: ['lexical'], excerpts: [memory('mem_dec', 'decision')] }),
    section('known_hazards'),
    section('failed_approaches'),
    section('relevant_memories', { provenance: ['lexical'], excerpts: [memory('mem_rel', 'learning')] }),
    section('similar_episodes', { provenance: ['similar-effort'], excerpts: [{ excerptKind: 'episode', id: 'ep_1', runId: 'run_1',
      taskId: 'task_old', taskKey: 'PLNR-1', runKind: 'implementation', outcome: 'done', landingOutcome: 'landed',
      whatWasAttempted: 'Changed the adapter', whatFailed: [], whatRemainsUncertain: [], support: [{ kind: 'file', detail: 'src/x.ts' }] }] }),
    section('graph_neighborhood', { provenance: ['graph'], coverage: { complete: true, reasons: [] },
      graphEntities: [{ uri: 'noriq://file/PLNR/noriq/src/x.ts', type: 'file', label: 'src/x.ts', depth: 1, edgePath: 'task>modifies>file' }] }),
    section('affected_tests', { provenance: ['graph'], coverage: { complete: true, reasons: [] },
      graphEntities: [{ uri: 'noriq://test/one', type: 'test', label: 'test one', depth: 2, edgePath: 'file>tests>test' }] }),
    section('active_neighboring_work'), section('uncertainty'),
    section('source_excerpts', { provenance: ['exact'], excerpts: [memory('mem_dec', 'decision'), memory('mem_rel', 'learning')] }),
  ],
});

const repository = {
  repositoryKey: 'noriq', latestObservedBase: 'base-1', stale: false, failedIngest: false,
  activeGeneration: { id: 'gen_1', branch: 'main', baseId: 'base-1', status: 'active' },
};

describe('Project Memory acceptance evaluator', () => {
  it('passes only when the full representative task context meets every deterministic threshold', () => {
    const report = evaluateMemoryAcceptance({ pack: passingPack(), repository, requested: { repositoryKey: 'noriq', branch: 'main', baseId: 'base-1' }, proof: 'fixture' });
    expect(report.proof).toBe('fixture');
    expect(report.passed).toBe(true);
    expect(report.summary).toEqual({ passed: 9, failed: 0, unanswerable: 0 });
  });

  it('reports missing graph capability as unanswerable and absent real data as failures', () => {
    const pack = passingPack();
    const graph = pack.sections.find((candidate) => candidate.id === 'graph_neighborhood')!;
    graph.coverage = { complete: false, reasons: ['no-writer-yet'] };
    graph.graphEntities = [];
    const episodes = pack.sections.find((candidate) => candidate.id === 'similar_episodes')!;
    episodes.excerpts = [];
    for (const candidate of pack.sections.flatMap((candidate) => candidate.excerpts)) {
      if (candidate.excerptKind === 'memory') candidate.evidence.forEach((citation) => { citation.verifiedForCaller = false; });
    }

    const report = evaluateMemoryAcceptance({ pack, repository, requested: { repositoryKey: 'noriq', branch: 'main', baseId: 'base-1' }, proof: 'fixture' });
    expect(report.passed).toBe(false);
    expect(report.criteria.find((criterion) => criterion.id === 'task_graph_seed')?.status).toBe('unanswerable');
    expect(report.criteria.find((criterion) => criterion.id === 'similar_episode_present')?.status).toBe('fail');
    expect(report.criteria.find((criterion) => criterion.id === 'episode_enriched')?.status).toBe('unanswerable');
    expect(report.criteria.find((criterion) => criterion.id === 'evidence_verified_for_scope')?.status).toBe('fail');
    expect(report.criteria.find((criterion) => criterion.id === 'required_context_sections')?.observed).toContain('similar_episodes');
  });

  it('labels the authenticated REST report as live proof and refuses to pass an unspecified checkout', async () => {
    const email = 'memory-acceptance-live@example.com';
    await createUser(email, 'Acceptance User', 'longenough1');
    const token = await mintTokenForUser(email);
    const cookie = await loginSession(email, 'longenough1');
    const project = await mcpCall(token, 'create_project', { key: 'PMACPT', name: 'Acceptance project' });
    expect(project.isError).toBe(false);
    const projectId = project.body.id as string;
    const task = await mcpCall(token, 'create_task', { projectId, title: 'Representative task', tags: ['memory-acceptance'], allowNewTags: true });
    if (task.isError) throw new Error(task.text);

    const response = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/memory/acceptance`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.body.key }),
    });
    expect(response.status).toBe(200);
    const report = await response.json() as ReturnType<typeof evaluateMemoryAcceptance>;
    expect(report.proof).toBe('live-environment');
    expect(report.passed).toBe(false);
    expect(report.criteria.find((criterion) => criterion.id === 'active_generation_fresh')).toMatchObject({ status: 'unanswerable' });
  });
});
