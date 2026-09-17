import type { Env } from '../env';

/** Whether git-checkout repository index ingest and operator index-generation controls are
 *  exposed. Off by default after the coordination-only cut-over: local agents own code
 *  understanding. Set `REPOSITORY_INDEXING=1` only for regression tests or legacy ops. */
export function repositoryIndexingProductEnabled(env: Env): boolean {
  return env.REPOSITORY_INDEXING === '1';
}

export const REPOSITORY_INDEXING_DISABLED_MESSAGE =
  'Repository indexing is not a Noriq product capability; use local agent tooling for code understanding. Project Memory (decisions, hazards, episodes), project docs, and task/doc search remain supported.';
