# Changelog

## Unreleased

### Runner execution plane (coordination-only cutover)

Noriq is moving to **coordination-only** execution: MCP copilots and human Mission Control stay; the `noriq-runner` daemon and server-side dispatch are being retired.

**Operators (self-host and production):**

1. Stop accepting new runner work: set `RUNNER_DISABLED=1` on the Worker (`wrangler` `vars` or dashboard). Registration, dispatch, daemon WebSockets, and runner ingest return **HTTP 410** with `code: runner_plane_disabled`.
2. Drain in-flight work: `POST /api/admin/runner-plane/drain` with your `ADMIN_TOKEN` (cancels live runner jobs, legacy runs, and plan-dispatch pumps with reason `runner_plane_disabled`).
3. On every machine running the daemon: stop the service and uninstall `@noriq-dev/runner` / remove `runner.toml`.
4. Keep using MCP (Claude Code, Cursor, etc.) for claims, tasks, docs, and plans — execution specs on tasks remain as planning artifacts.

Device OAuth (RFC 8628) stays available for headless MCP clients. Project Memory **read/Ask** continues; runner-driven repository ingest is paused until a non-daemon indexer ships.

See [docs/RUNNER_CUTOVER.md](docs/RUNNER_CUTOVER.md).
