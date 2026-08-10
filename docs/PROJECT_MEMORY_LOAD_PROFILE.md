# Project Memory load profile and budgets

Status: measured for Phase 10 (PLNR-276), 2026-08-10.

The reproducible profile lives in `apps/api/test/memory-load.test.ts` and runs only through
`npm run test:load`. It uses the real ProjectMemory Durable Object SQLite store and the test R2
binding; it does not replace a production-environment readiness drill.

## Measured profile

The local workerd run used 1,500 code nodes with 12 cyclic imports per node, 200 effort episodes,
six retained superseded index generations plus the active large generation, 16 queued traversal
reads, and one complete export/restore. The runtime used the installed workerd compatibility
fallback (2025-09-06) for the application's requested 2026-06-01 date.

| Measurement | Observed |
| --- | ---: |
| Canonical code graph | 1,500 files, 18,000 import edges |
| Store after episodes and projection | 1,907 nodes, 18,400 edges, 200 episodes |
| Durable Object SQLite size | 12,824,576 bytes |
| Large generation ingest and activation | 485 ms |
| 200 episode writes | 442 ms |
| Depth-4 adversarial traversal | 737 ms, 19 unique results, incomplete coverage reported |
| Lexical retrieval over the episode history | 4 ms, capped at 100 results |
| ProjectRoom task creation during 16 queued ProjectMemory traversals | 369 ms |
| Snapshot export | 182 ms |
| Snapshot storage | 89 gzip chunks, 438,080 compressed bytes |
| Snapshot restore and atomic activation | 1,123 ms |

These figures are a regression baseline, not a production latency promise. The load test applies
measured guardrails with CI headroom: 15 seconds for large ingest, episode history, or restore;
10 seconds for export; 5 seconds for traversal or concurrent coordination; and 2 seconds for
bounded lexical retrieval.

## Enforced budgets

The profile exercises the following production limits:

| Surface | Enforced budget |
| --- | --- |
| Index upload | 8 MiB compressed per batch; 16 MiB expanded per batch |
| Index generation | 64 MiB canonical content, 1,000,000 rows, 256 batches, 100,000 files |
| Retrieval | 20 results by default, 100 maximum |
| Graph output | depth 2 and 25 results by default; depth 4 and 100 results maximum |
| Recursive graph work | 1,000 recursive rows, including duplicate paths |
| Snapshot chunk | 500 rows; 32 MiB compressed and 32 MiB expanded restore ceilings |
| Backup retention | seven complete generations |
| Store visibility | warning at 500 MiB; critical at 1 GiB; neither silently rejects canonical writes |

The recursive-work ceiling is the Phase 10 hardening added from this profile. A final result limit
alone does not bound a recursive CTE: dense cycles can generate many distinct paths before the
outer `LIMIT` runs. The recursive SELECT now stops at 1,000 rows, ten times the maximum result
page, and reports `row-limit-reached` when that work budget is consumed. In the measured cyclic
graph, duplicate paths consumed the budget after 19 unique results; the API correctly returned a
partial answer rather than implying completeness.

Snapshot export and restore stream one bounded chunk at a time. A restore is resumable at the
operation level by retrying from its immutable manifest; no partial staging generation becomes
active. Checksums, row counts, graph integrity, and the complete manifest inventory are validated
before atomic activation.

## Scope of the evidence

ProjectRoom and ProjectMemory are separate Durable Objects. The concurrent measurement confirms
that queued memory reads did not serialize the ProjectRoom task write in this profile. The test
also verifies retrieval/result caps and byte-identical canonical table counts after restore.

Local workerd does not expose per-request Worker CPU time or peak isolate memory. The default test
configuration has no VECTORIZE or CODE_VECTORIZE index, so this profile records zero meaningful
Vectorize operation or cost evidence; the R2 figure is bytes written, not a provider invoice.
Those environment-specific measurements belong to the separately approved live readiness drill.
They must not be inferred from this local pass, and the live drill must use a non-destructive
target selected by a human.
