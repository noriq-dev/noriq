# Runner cutover (coordination-only)

Noriq keeps **projects, tasks, claims, plans, docs, memory/Ask, and MCP copilots**. The `@noriq-dev/runner` daemon and server dispatch plane are being removed.

## Phase 1 — stop new work (this release)

| Step | Action |
|------|--------|
| 1 | `POST /api/admin/runner-plane/drain` with `ADMIN_TOKEN` to cancel live jobs/runs/dispatches |
| 2 | Set `RUNNER_DISABLED=1` on the Worker |
| 3 | Stop and uninstall `noriq-runner` on all hosts |
| 4 | Use external coding agents (Cursor, Claude Code, …) via MCP for execution |

While `RUNNER_DISABLED` is set:

- **410:** `POST /api/runners`, heartbeats, runner-job dispatch, runner ingest/spinoffs/coordination, `/ws/runner/:id`
- **Still works:** human UI, MCP copilots, claims, boards, plans, docs, Ask/Memory reads

`/api/health` reports `runnerDisabled: true` when the flag is on.

## Decisions (locked)

- **Device grant:** kept for future headless MCP clients
- **Execution specs on tasks:** kept as planning artifacts
- **Memory:** runner ingest paused; indexed data and Ask remain readable

## Later PRs

Later slices remove the Jobs UI, runner REST/DO wiring, MCP dispatch guidance, and archive the `runner` repository.
