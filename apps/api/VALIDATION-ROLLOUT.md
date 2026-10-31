# Validation rollout: v0.81.0 / catalog revision 7

Implementation is tracked by PLNR-620. Deployment and project activation are separate steps. No NOD content repair or evidence backfill is included.

## Deploy from Bazzite

Use the authenticated checkout at `/home/mtuska/git/noriq-dev/noriq`. Preserve local configuration and work; start from a clean checkout of tag `v0.81.0` (or its commit on main).

```sh
cd /home/mtuska/git/noriq-dev/noriq
git fetch origin --tags
git status --short
git checkout v0.81.0
npm ci
npm run db:migrate:remote --workspace @noriq-dev/api
npm run deploy
```

The existing scripts select `wrangler.production.jsonc` when present. Migration 0125 is additive and leaves every project's policy at `legacy`. Do not enable strict mode through SQL: the authenticated policy endpoint releases claims/locks, records the reason, and emits notices.

## Verify clients before activation

Check `/api/health` and the web version for `0.81.0`. In each supported client, refresh/reconnect its MCP connection as necessary. A successful deployment or version change does not prove that a host refreshed cached tool definitions.

Inspect the actual client-exposed catalog and exercise a dedicated smoke task. Verify:

- `record_validation`, `get_validation`, `get_freshness`, and `mark_changed_direction` are callable.
- `create_tasks` item assessments, `create_doc.assessment`, `update_doc.assessment`, `record_validation.assessment.reconciliation`, and claim repository coordinates are exposed.
- `get_project` returns `validationPolicy`; task context exposes effective evidence requirements and unresolved direction markers.
- Legacy `initialize`/`tools/list` and modern `server/discover`/`tools/list` advertise catalog revision 7 with these input schemas. Server schema tests do not replace checking the tools actually available inside your host.

If a host still omits fields/tools, leave policy unchanged and reconnect or repair that integration. Stale clients will receive actionable mutation errors once strict mode is enabled; there is no compatibility bypass.

## Enable and smoke-test

1. In **Project Settings → Validation policy**, enable strict for **NOD** and **Noriq (PLNR)** only, using a recorded rollout reason. Any human contributor can do this; agent credentials cannot. The result lists released task IDs, and events retain the audit history. Other projects remain unchanged.
2. Capture the released-task lists. The holders receive notices telling them to stop implementation, reassess and reclaim. Noriq cannot terminate an external agent process; check those sessions have received and acted on the notice.
3. Create a dedicated coordination smoke task in each project. Unverified creation should succeed; claiming and direct agent status completion should fail. Inspect the queue/context/Review agreement.
4. Record truthful readiness evidence for the smoke task, then claim it. Record separate implementation evidence for the smoke action and release it. If using repository scope, readiness names the starting revision and implementation names the resulting revision; do not fabricate a pre-start assessment.
5. On a second smoke task, mark an existing comment as changed direction during a claim. Verify the claim and task locks are released, heartbeat cannot revive them, and ordinary reclaim fails. Reconcile every current marker ID in passing readiness evidence, reclaim, and finish with separate implementation evidence.
6. Verify a strict settled-doc write without evidence fails and an assessed create/update succeeds. Keep smoke docs explicitly about the checks actually performed; plan drafts remain unrestricted.

Do not mark existing NOD work verified to make rollout pass. Task correction, inspection, and recording evidence remain available without claiming. Retrospective assessments retain their actual recording time.

## Reversal and limits

A human contributor may switch a project back to legacy with a reason. This does not restore released claims or disable an independently evidence-required plan. Re-enabling strict releases current claims again; repeated activation while already strict is idempotent. Keep the additive migration when rolling back application code; never rebuild referenced D1 tables.

Exceptions are human-only, scoped, context-bound and expiring. They cannot approve a proposed plan, bypass dependencies, or transfer another actor's ownership. Dismiss/snooze only affects reminder presentation. Evidence is actor-reported: Noriq verifies workflow and recorded context, not the truth or sufficiency of an external test result.
