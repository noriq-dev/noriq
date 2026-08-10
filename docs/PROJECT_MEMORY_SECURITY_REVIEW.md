# Project Memory security review

Status: reviewed for Phase 10 (PLNR-275), 2026-08-10.

Project Memory treats repository indexes, episode uploads, retrieved memory, verification
reports, and backup objects as untrusted input. Project membership and role checks remain the
authority boundary; graph proximity, retrieved text, task claims, agent identity, and model
output do not grant authority.

## Reviewed boundaries

| Boundary | Required property | Evidence |
| --- | --- | --- |
| Project reads and retrieval | A caller cannot retrieve another project's memory, graph, code index, or evidence | `memory-search.test.ts`, `memory-retrieval.test.ts`, `code-index.test.ts` |
| Ingest capabilities | Tokens are short-lived and fixed to one project, repository, runner, purpose, and scope; completed or revoked capabilities cannot be replayed | `memory-ingest.test.ts`, `memory-ingest-generations.test.ts` |
| Index payloads | Compressed and expanded bytes, batches, rows, files, generation totals, paths, symbols, graph endpoints, and content digests are validated before activation | `memory-ingest.test.ts`, `memory-ingest-generations.test.ts` |
| Retrieved evidence | Hostile labels and content are delimited, bounded, cited, and explicitly framed as evidence rather than instructions or authority | `memory-evidence-frame.test.ts` |
| Approval and authority | Human REST actions are the only authority-5 source; agents, merges, viewers, and claims cannot forge or escalate authority | `memory-approval.test.ts` |
| Verification | Reports bind to the exact project, repository, branch, base, run, and reporting agent; malformed or forged reports do not verify unrelated work | `memory-verification.test.ts` |
| Backup and restore | Project, format, schema, complete table/chunk inventory, checksums, byte/row limits, graph integrity, and row counts are checked before atomic activation | `memory-backup.test.ts`, `memory-restore.test.ts` |
| Erasure | Canonical, derived, staging, generation, ledger, and registry remnants are removed or tombstoned with retry-safe cleanup | `memory-lifecycle.test.ts` |

## Findings closed in Phase 10

Two implementation gaps were found and fixed:

1. Ingest and restore previously checked expanded payload size only after gzip decompression had
   accumulated the complete result. Decompression now stops while streaming as soon as the
   configured expanded-byte ceiling is crossed. Restore also rejects oversized compressed
   chunks and chunks above the exporter's row bound before parsing or staging them.
2. Restore previously accepted any positive backup format version and deferred incomplete or
   unknown table/chunk discovery until staging. It now requires the current backup format, the
   exact canonical table inventory, contiguous chunk numbering, count/chunk consistency, and an
   exact evidence-reference inventory before fetching a chunk or creating staging tables.

Checksums are still verified before JSON parsing, staging remains isolated from the live
generation, graph/evidence integrity is checked against staging, and activation remains atomic.

## Residual trust and operations

Snapshot checksums detect accidental corruption and an object replaced without a matching
manifest update. They are not signatures: an actor with write access to the R2 bucket can replace
both chunks and their checksums consistently. R2 write access is therefore backup authority and
must be restricted to the deployment identity and audited through the infrastructure provider.
Restore authorization and selection remain privileged application operations.

Optional bindings degrade explicitly: missing R2 disables backup/restore, and missing vector
infrastructure leaves canonical memory available while derived retrieval reports its reduced
capability. These states must not be represented as successful backup, restore, or vector health.

The remaining live backup/restore drill is deliberately separate from this code review. It must
use an approved non-destructive target and must not be inferred from local test success.
