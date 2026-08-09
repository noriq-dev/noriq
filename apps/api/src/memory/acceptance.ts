import type { ContextPack, ContextPackMemoryExcerpt, ContextPackSection } from '@noriq-dev/shared';

export const MEMORY_ACCEPTANCE_THRESHOLDS = {
  minSimilarEpisodes: 1,
  minCodeEntities: 1,
  minAffectedTests: 1,
  minRelevantActiveMemories: 1,
  minVerifiedCitations: 1,
  requiredNonEmptySections: [
    'active_decisions', 'relevant_memories', 'similar_episodes',
    'graph_neighborhood', 'affected_tests', 'source_excerpts',
  ],
} as const;

export type MemoryAcceptanceStatus = 'pass' | 'fail' | 'unanswerable';
export interface MemoryAcceptanceCriterion {
  id: string;
  label: string;
  status: MemoryAcceptanceStatus;
  observed: string;
  requirement: string;
}

export interface MemoryAcceptanceRepositoryState {
  repositoryKey: string;
  latestObservedBase: string | null;
  activeGeneration: { id: string; branch: string; baseId: string; status: string } | null;
  stale: boolean;
  failedIngest: boolean;
}

export interface MemoryAcceptanceReport {
  schemaVersion: 1;
  proof: 'live-environment' | 'fixture';
  target: { projectId: string; taskId: string; taskKey: string; repositoryKey: string | null; branch: string | null; baseId: string | null };
  thresholds: typeof MEMORY_ACCEPTANCE_THRESHOLDS;
  passed: boolean;
  summary: { passed: number; failed: number; unanswerable: number };
  criteria: MemoryAcceptanceCriterion[];
  generatedAt: string;
}

const sectionContentCount = (section: ContextPackSection | undefined): number =>
  section ? section.excerpts.length + section.graphEntities.length + section.items.length : 0;

const memoryExcerpts = (sections: ContextPackSection[]): ContextPackMemoryExcerpt[] =>
  sections.flatMap((section) => section.excerpts.filter((excerpt): excerpt is ContextPackMemoryExcerpt => excerpt.excerptKind === 'memory'));

/** Deterministic evaluator only: it performs no I/O and never upgrades a missing surface to a
 * pass. The REST edge is responsible for gathering the live repository state and context pack;
 * fixture tests exercise this function, while the CLI exercises that live edge. */
export function evaluateMemoryAcceptance(input: {
  pack: ContextPack;
  repository: MemoryAcceptanceRepositoryState | null;
  requested: { repositoryKey?: string | null; branch?: string | null; baseId?: string | null };
  proof?: 'live-environment' | 'fixture';
}): MemoryAcceptanceReport {
  const { pack, repository, requested } = input;
  const byId = new Map(pack.sections.map((section) => [section.id, section]));
  const episodes = byId.get('similar_episodes')?.excerpts.filter((excerpt) => excerpt.excerptKind === 'episode') ?? [];
  const enrichedEpisodes = episodes.filter((episode) =>
    !!episode.whatWasAttempted.trim() && episode.support.length > 0
    && (episode.whatFailed.length > 0 || episode.whatRemainsUncertain.length > 0 || episode.landingOutcome !== 'pending'));
  const graph = byId.get('graph_neighborhood');
  const tests = byId.get('affected_tests');
  const codeTypes = new Set(['file', 'symbol', 'api', 'database_entity', 'test']);
  const codeEntities = graph?.graphEntities.filter((entity) => codeTypes.has(entity.type)) ?? [];
  const relevant = (byId.get('relevant_memories')?.excerpts ?? [])
    .filter((excerpt): excerpt is ContextPackMemoryExcerpt => excerpt.excerptKind === 'memory' && excerpt.validity === 'active');
  const cited = memoryExcerpts(pack.sections).filter((excerpt) => excerpt.validity === 'active' && excerpt.evidence.length > 0);
  const fullyVerified = cited.filter((excerpt) => excerpt.evidence.every((citation) => citation.verifiedForCaller));
  const verifiedCitationCount = fullyVerified.reduce((sum, excerpt) => sum + excerpt.evidence.length, 0);
  const requiredSections = MEMORY_ACCEPTANCE_THRESHOLDS.requiredNonEmptySections.map((id) => ({ id, count: sectionContentCount(byId.get(id)) }));
  const missingSections = requiredSections.filter(({ count }) => count === 0).map(({ id }) => id);

  const criteria: MemoryAcceptanceCriterion[] = [];
  const add = (criterion: MemoryAcceptanceCriterion) => criteria.push(criterion);
  if (!requested.repositoryKey || !requested.branch || !requested.baseId) {
    add({ id: 'active_generation_fresh', label: 'Active generation is current for the requested checkout', status: 'unanswerable', observed: 'repositoryKey, branch, and baseId were not all supplied', requirement: 'an explicit repositoryKey + branch + baseId scope' });
  } else if (!repository) {
    add({ id: 'active_generation_fresh', label: 'Active generation is current for the requested checkout', status: 'unanswerable', observed: `repository ${requested.repositoryKey} is not registered`, requirement: 'a registered repository with one active generation' });
  } else {
    const active = repository.activeGeneration;
    const fresh = !!active && !!repository.latestObservedBase && active.status === 'active' && !repository.stale && !repository.failedIngest
      && active.branch === requested.branch && active.baseId === requested.baseId
      && active.baseId === repository.latestObservedBase;
    add({ id: 'active_generation_fresh', label: 'Active generation is current for the requested checkout', status: fresh ? 'pass' : 'fail', observed: active ? `active ${active.branch}@${active.baseId}; latest observed ${repository.latestObservedBase ?? 'unknown'}; stale=${repository.stale}; failedIngest=${repository.failedIngest}` : 'no active generation', requirement: 'active generation matches the explicit branch/baseId and latest observed base, with no failed ingest' });
  }

  add({ id: 'similar_episode_present', label: 'Prior effort is retrievable', status: episodes.length >= MEMORY_ACCEPTANCE_THRESHOLDS.minSimilarEpisodes ? 'pass' : 'fail', observed: `${episodes.length} similar episode(s)`, requirement: `at least ${MEMORY_ACCEPTANCE_THRESHOLDS.minSimilarEpisodes}` });
  add({ id: 'episode_enriched', label: 'Prior effort carries actionable enrichment', status: enrichedEpisodes.length >= 1 ? 'pass' : episodes.length ? 'fail' : 'unanswerable', observed: `${enrichedEpisodes.length} enriched of ${episodes.length} episode(s)`, requirement: 'one episode with an attempted approach, inspectable support, and a terminal outcome/failure/uncertainty' });

  const graphUnanswerable = !graph?.coverage || graph.coverage.complete === false;
  add({ id: 'task_graph_seed', label: 'The task resolves to a graph seed', status: graphUnanswerable ? 'unanswerable' : 'pass', observed: graph?.coverage ? `complete=${graph.coverage.complete}; ${graph.coverage.reasons.join(', ') || 'no coverage warning'}` : 'no coverage marker', requirement: 'complete task-neighborhood coverage without seed-not-found/no-writer warnings' });
  add({ id: 'code_relationships', label: 'Task context reaches code entities', status: graphUnanswerable ? 'unanswerable' : codeEntities.length >= MEMORY_ACCEPTANCE_THRESHOLDS.minCodeEntities ? 'pass' : 'fail', observed: `${codeEntities.length} file/symbol/API/database/test graph entit${codeEntities.length === 1 ? 'y' : 'ies'}`, requirement: `at least ${MEMORY_ACCEPTANCE_THRESHOLDS.minCodeEntities}` });
  const testsUnanswerable = !tests?.coverage || tests.coverage.complete === false;
  add({ id: 'affected_tests', label: 'Task context reaches validating tests', status: testsUnanswerable ? 'unanswerable' : (tests?.graphEntities.length ?? 0) >= MEMORY_ACCEPTANCE_THRESHOLDS.minAffectedTests ? 'pass' : 'fail', observed: `${tests?.graphEntities.length ?? 0} affected test(s)${tests?.coverage ? `; complete=${tests.coverage.complete}` : ''}`, requirement: `at least ${MEMORY_ACCEPTANCE_THRESHOLDS.minAffectedTests} with complete coverage` });
  add({ id: 'relevant_active_memory', label: 'Relevant non-stale memory is retrieved', status: relevant.length >= MEMORY_ACCEPTANCE_THRESHOLDS.minRelevantActiveMemories ? 'pass' : 'fail', observed: `${relevant.length} active relevant memory excerpt(s)`, requirement: `at least ${MEMORY_ACCEPTANCE_THRESHOLDS.minRelevantActiveMemories}` });
  add({ id: 'evidence_verified_for_scope', label: 'Retrieved memory evidence verifies for this exact checkout', status: !requested.branch || !requested.baseId ? 'unanswerable' : verifiedCitationCount >= MEMORY_ACCEPTANCE_THRESHOLDS.minVerifiedCitations ? 'pass' : 'fail', observed: `${verifiedCitationCount} verified citation(s) across ${fullyVerified.length} fully verified memory item(s); ${cited.length} cited active item(s) considered`, requirement: `at least ${MEMORY_ACCEPTANCE_THRESHOLDS.minVerifiedCitations} citation on a memory whose complete evidence set is verifiedForCaller` });
  add({ id: 'required_context_sections', label: 'Required working-context sections are non-empty', status: missingSections.length ? 'fail' : 'pass', observed: missingSections.length ? `empty: ${missingSections.join(', ')}` : requiredSections.map(({ id, count }) => `${id}=${count}`).join(', '), requirement: `non-empty: ${MEMORY_ACCEPTANCE_THRESHOLDS.requiredNonEmptySections.join(', ')}` });

  const summary = {
    passed: criteria.filter((criterion) => criterion.status === 'pass').length,
    failed: criteria.filter((criterion) => criterion.status === 'fail').length,
    unanswerable: criteria.filter((criterion) => criterion.status === 'unanswerable').length,
  };
  return {
    schemaVersion: 1, proof: input.proof ?? 'fixture',
    target: { projectId: pack.projectId, taskId: pack.taskId, taskKey: pack.taskFacts.key, repositoryKey: requested.repositoryKey ?? null, branch: requested.branch ?? null, baseId: requested.baseId ?? null },
    thresholds: MEMORY_ACCEPTANCE_THRESHOLDS, passed: summary.failed === 0 && summary.unanswerable === 0,
    summary, criteria, generatedAt: pack.generatedAt,
  };
}
