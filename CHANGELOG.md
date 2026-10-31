# Changelog

## Unreleased

## 0.81.1 - 2026-10-31

### Cohesive project settings + evidence UI (PLNR-622)

- Align Validation policy, Validity inbox, Dormancy, and evidence forms with Project Settings chrome (SectionLabel / Field kit).
- Group settings sections so validation sits with other policy controls instead of competing as a bare island.
- Restyle AssessmentForm, AssessmentHistory, ReadinessOverrideForm, DirectionMarkerAction, and ValidityStrip assessment summary to match drawer/Review language.

## 0.81.0 - 2026-10-31

### Enforceable project validation (PLNR-620)

- Opt projects into strict validation in Project Settings, with a human contributor reason and audit event. Existing and new projects default to legacy; independent plan requirements remain enforced.
- Strict activation and explicit changed-direction markers release agent claims and task locks, preserve history, and tell holders to stop, reassess and reclaim. Readiness gates cover standalone tasks, renewals, status transitions, queue selection and Project health.
- Require separate readiness and implementation evidence, preserving starting versus resulting revisions. Agents use claim/release; only human contributors grant scoped, expiring exceptions.
- Mark changed direction on comments or task-linked input answers; reconcile marker IDs and current intent with passing readiness evidence. Informational comments and comment resolution do not clear direction gates.
- Require passing assessments for agent-authored settled docs and substantive updates in strict projects. Commit immutable document versions and evidence atomically; plan working drafts remain available.
- Expose policy and direction remediation in context, settings, task and Review surfaces. MCP catalog revision 7 includes update assessments and direction markers; both discovery protocols are tested against their actual tool schemas.

**Upgrade:** apply additive migration `0125_project_validation_policy.sql`, then deploy the application. This release does not enable strict policy or backfill evidence for any project. Old agent-authored exceptions no longer authorize work. Follow [the rollout checklist](apps/api/VALIDATION-ROLLOUT.md), verify the connected host catalog, then enable NOD and Noriq through the human settings control. Evidence remains actor-reported; Noriq does not independently establish that a cited test proves its claim.

## 0.80.1 - 2026-10-30

### Theme Appearance popup (PLNR-618)

- Theme control opens an Appearance popup with a three-segment **Light · System · Dark** slider.
- Preference persists in `noriq.theme`; System follows `prefers-color-scheme`.

## 0.80.0 - 2026-10-26

### Evidence-backed verification and coordination surfaces (PLNR-609–617)

- Record structured readiness, implementation and document assessments with scoped evidence and actor attribution. Initial task/doc evidence can be supplied at creation; legacy attestations remain distinguishable.
- New plans require current task readiness and separate implementation evidence at completion. Later phases require rechecks after preceding work changes; human approval accepts plan direction without certifying every task.
- Keep critical claim blockers independent of reminder snooze/dismiss. Explicit, expiring overrides retain their reason, actor and context; assessment and exception history stays readable.
- Replace Intelligence's landing with live Project health, retaining historical analytics and lineage as secondary views and removing the mandatory request to a retired runner API.
- Open Memory to searchable knowledge, preserving maps, graphs and evidence workflows. Present Agents as Connected sessions with explicit roster scope, project claims/locks, and visible error/retry states.

**Upgrade:** apply additive D1 migrations `0123_entity_assessments.sql` and `0124_phase_readiness.sql` with the updated Worker and web assets. Existing plans retain legacy policy until explicitly enabled using `update_plan {requireTaskEvidence:true}`. Evidence remains actor-reported; Noriq does not execute the cited checks or independently inspect repository revisions.

### Memory/Intelligence copy post-runner + post-index-drop (PLNR-572)

- Memory Ops / Graph / Star Map no longer promise a Noriq repository reindex or ingest-client refresh; empty code-graph notices match the settled “local IDEs own code understanding” decision.
- Project Intelligence defaults to Copilot claims, labels runner capacity and RunnerJob history as archived, and points empty states at Copilot claims + Project Memory.

## 0.79.0 - 2026-09-17

### Repository indexing off by default (PLNR-573)

Git-checkout repository index ingest and operator generation controls are gated behind `REPOSITORY_INDEXING=1` (legacy/tests only). Project Memory, docs, and episode ingest stay. Memory Ops UI reports the capability honestly; `/api/memory-ingest` index purpose returns 410 unless the gate is on.

### Also

- Modularize `deleteProject` and add a cascade guard in CI (PLNR-560).

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

Device OAuth (RFC 8628) stays available for headless MCP clients. Project Memory **read/Ask** continues. **Repository code indexing** is off by default (`REPOSITORY_INDEXING` unset); episode ingest and Project Memory core remain; `/api/memory-ingest` index purpose returns 410 unless explicitly enabled for legacy/tests.

See [docs/RUNNER_CUTOVER.md](docs/RUNNER_CUTOVER.md).
