# Changelog

## Unreleased

### Greenfield runner excision (coordination-only)

- Removed `RunnerHub`, `/ws/runner`, and remaining runner-plane kill-switch scaffolding (`RUNNER_DISABLED`).
- MCP no longer accepts runner-spawned agent credentials; shared runner contracts are off the public `@noriq-dev/shared` surface (API-only legacy re-export for historical rows).
- Agents page lists **copilots only** (no agents-vs-copilots toggle).
- Docs updated for coordination-only / no daemon. D1 runner-era tables remain as additive history (not dropped).

## 0.75.0 - 2026-09-17

### Runner execution plane (coordination-only cutover)

Noriq is **coordination-only**: MCP copilots and human Mission Control stay; the `noriq-runner` daemon and server-side dispatch are retired.

This release removed the Jobs view and runner roster from the SPA, and dropped runner REST routes. Subsequent greenfield commits on `main` remove `RunnerHub` / `/ws/runner` and the Phase-1 `RUNNER_DISABLED` kill-switch entirely.

**Operators (self-host and production):**

1. Deploy the excision build; remove any stale `RUNNER_HUB` Durable Object **binding** from instance wrangler configs (keep historical migration tag `v3` — never use `deleted_classes`).
2. On every machine that ran the daemon: stop the service and uninstall `@noriq-dev/runner` / remove `runner.toml`.
3. Keep using MCP (Claude Code, Cursor, etc.) for claims, tasks, docs, and plans — execution specs on tasks remain as planning artifacts.

Device OAuth (RFC 8628) stays available for headless MCP clients. Project Memory **read/Ask** continues; runner-driven repository ingest is paused until a non-daemon indexer ships.

See [docs/RUNNER_CUTOVER.md](docs/RUNNER_CUTOVER.md).
