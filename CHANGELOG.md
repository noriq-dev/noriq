# Changelog

## Unreleased

## 0.75.0 - 2026-09-17

### Runner execution plane (coordination-only cutover)

Noriq is now **coordination-only**: MCP copilots and human Mission Control stay; the `noriq-runner` daemon and server-side dispatch are retired.

This release removes the Jobs view and runner roster from the SPA, and drops runner REST routes. Leftover `/ws/runner/:id` is refused with **HTTP 410** (`code: runner_plane_disabled`) when `RUNNER_DISABLED=1` is set.

**Operators (self-host and production):**

1. Set `RUNNER_DISABLED=1` on the Worker (`wrangler` `vars` or dashboard).
2. On every machine running the daemon: stop the service and uninstall `@noriq-dev/runner` / remove `runner.toml`.
3. Keep using MCP (Claude Code, Cursor, etc.) for claims, tasks, docs, and plans — execution specs on tasks remain as planning artifacts.

Device OAuth (RFC 8628) stays available for headless MCP clients. Project Memory **read/Ask** continues; runner-driven repository ingest is paused until a non-daemon indexer ships.

See [docs/RUNNER_CUTOVER.md](docs/RUNNER_CUTOVER.md).
