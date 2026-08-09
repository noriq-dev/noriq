# Project Memory live acceptance

Unit tests prove the evaluator and context-pack contracts against controlled fixtures. They do
not prove that production Noriq or Runner projects have a current index, enriched episodes, a
connected graph, or useful memories. The live acceptance command makes that distinction explicit.

## Run the representative gate

Use a normal user session that can view both projects. The cookie is read from the environment and
is never printed.

```bash
export NORIQ_URL=https://your-noriq.example
export NORIQ_SESSION_COOKIE='noriq_session=...'
npm run memory:acceptance -- \
  --target PLNR:PLNR-340:noriq \
  --target RUN:RUN-236:runner
```

A target is `PROJECT_KEY:TASK_KEY:REPOSITORY_KEY[:BRANCH[:BASE_ID]]`. When branch/base are omitted,
the command reads them from that repository's active generation; the server still requires the
resolved values to equal the active generation and latest observed base. Use `--json` for a
machine-readable report. Exit status is `0` only when every criterion passes, `1` when a criterion
fails or is unanswerable, and `2` for credentials/configuration/transport errors.

## Deterministic thresholds

The server evaluates these fixed requirements in `apps/api/src/memory/acceptance.ts`:

- the named repository has an active generation matching the explicit branch/base and latest
  observed base, with neither stale state nor failed ingest;
- at least one similar effort episode is present, and at least one episode has an attempted
  approach, inspectable support, and a terminal outcome, failure, or uncertainty;
- the task graph seed is answerable and reaches at least one code entity;
- at least one affected test is present with complete graph coverage;
- at least one active relevant memory is present;
- at least one citation belongs to a fully scoped memory evidence set where every citation is
  `verifiedForCaller` for the requested branch/base;
- `active_decisions`, `relevant_memories`, `similar_episodes`, `graph_neighborhood`,
  `affected_tests`, and `source_excerpts` are all non-empty.

Missing scope, repository registration, graph writers, graph coverage, or evidence scope is
reported as `UNANSWERABLE`; missing data on an answerable surface is `FAIL`. Neither is accepted as
an empty success.

## CI and release evidence

`npm test` may exercise fixture reports (`proof: fixture`) but must not describe them as live
proof. The command above calls authenticated production REST reads and reports
`proof: live-environment`. It therefore requires a deployed environment, real project data, and a
session cookie; ordinary pull-request CI should record it as not run unless those credentials are
explicitly provided. A release checklist may attach the JSON report, but must not infer a pass
from mock or local Durable Object data.
