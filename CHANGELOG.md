# Changelog

## Unreleased

## 0.78.0 - 2026-09-17

### Copilot lifecycle + Cursor identity (PLNR-568, PLNR-569)

- **Lifecycle sweep apply:** staging example config sets `AGENT_LIFECYCLE_SWEEP_APPLY=true`; production remains opt-in after dry-run review. Project-scoped sweeps retire `session_copilot` rows only (never `connection_copilot`). OAuth revoke paths set `retired_at` with `connection_authorization_ended`.
- **Honest counts:** project `agentCount` / session connection counts / roster `counts.total` / private snapshots exclude retired and archived copilots by default.
- **Cursor session keys:** `cursor:{bcId}` via `_meta["cursor/agent"]` or `x-cursor-agent-id`; Cursor clients skip per-initialize UUID minting (stable `stateless:{token}` or bound agent id). `cursor:` keys are durable across transport DELETE like `grok:` / `stateless:`.

### Also

- Harden dual-plane backup restore ops (PLNR-561).
- Run `check:authz`, `check:wrangler`, and `test:hooks` in CI (PLNR-559).

## 0.77.0 - 2026-09-17

### Project archive (PLNR-567)

Soft-archive and restore projects. Reuses `projects.status` (`active` | `archived`) with `ProjectRoom` as the sole writer, owner-gated REST archive/restore, `?archived=1` listing, WS events, and SPA controls in project settings plus Home archived restore.

## 0.76.1 - 2026-09-17

Keep a no-op `RunnerHub` class export so existing Durable Object instances can keep storage. `deleted_classes` is still forbidden; instance wrangler configs still omit the `RUNNER_HUB` binding.

## 0.76.0 - 2026-09-17

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
