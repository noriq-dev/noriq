# Runner cutover (complete — coordination-only)

Noriq is **coordination-only**: projects, tasks, claims, plans, docs, memory/Ask, and MCP
**copilots**. The `@noriq-dev/runner` daemon, `RunnerHub`, `/ws/runner`, run/job dispatch, and
runner-spawned `kind: agent` paths are **removed from the product surface**.

## Operator actions (self-host / production)

| Step | Action |
|------|--------|
| 1 | Deploy a build that includes the greenfield excision (no `RUNNER_HUB` binding, no `/ws/runner` handler) |
| 2 | Stop and uninstall `noriq-runner` / `@noriq-dev/runner` on every host |
| 3 | Use external coding agents (Cursor, Claude Code, …) via MCP for execution |
| 4 | Archive / npm-deprecate the runner package (see [noriq-dev/runner](https://github.com/noriq-dev/runner)) |

There is **no** `RUNNER_DISABLED` kill-switch anymore — the plane code is gone. Historical D1
tables (`runners`, `runs`, `runner_jobs`, …) may still exist (additive migrations only; do not
drop with FK-breaking rebuilds). They are not part of the live product API or UI.

## Still works

- Human Mission Control (Board, Plans, Docs, Memory, Ask, Agents = **copilots only**)
- MCP copilots (OAuth + device grant for headless clients)
- Claims, boards, plans, execution specs as planning artifacts
- Project Memory **read/Ask** on already-indexed data

## Deferred

- Non-daemon repository indexer (memory ingest was runner-driven)
- Public landing-site copy may lag this repo until updated separately

## Schema leftovers (do not destructively drop)

D1 still carries runner-era tables from additive migrations. Code paths no longer write them for
the product surface. A future maintenance migration may archive/null them; until then treat them
as inert history in backups.
