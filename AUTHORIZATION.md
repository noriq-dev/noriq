# Authorization contract

Noriq authorization is layered. A successful decision must satisfy every applicable layer; a
credential or system role cannot silently widen the authority granted by another layer.

## Policy layers

1. **Account state** — disabled accounts have no access. `read_only` accounts may view resources
   they can otherwise reach, but cannot write, administer groups/projects, or create groups and
   projects. Instance defaults and nullable per-account overrides control creation capabilities.
2. **System role** — `admin` governs instance administration. Human REST routes may deliberately
   request the central admin override for project recovery; MCP, OAuth, and Runner boundaries never
   inherit ambient project authority from the system role.
3. **Group role** — accepted memberships have `owner`, `manager`, or `member` roles over the group
   itself. Pending invitations carry no authority. A group role does not imply project access.
4. **Project role** — `projects.owner_user_id` is the ownership root. `project_grants` may grant a
   user or group `manager`, `contributor`, or `viewer`. If several grants apply, the strongest wins.
5. **Credential scope** — a scoped OAuth token can only narrow its user's effective projects. It
   cannot make a project reachable or raise a role.

The project action thresholds are:

| Effective role | View | Contribute | Manage | Own |
|---|---:|---:|---:|---:|
| viewer | yes | no | no | no |
| contributor | yes | yes | no | no |
| manager | yes | yes | yes | no |
| owner | yes | yes | yes | yes |

A read-only account caps any otherwise stronger project role at `viewer`. Ownership remains stored
and can be restored to full effect by returning the account to `read_write`.

## Authoritative storage

- `users.access_mode`, `users.can_create_projects`, and `users.can_create_groups` store account
  ceilings and optional creation overrides.
- `authorization_settings` stores instance creation defaults.
- `user_groups.role` stores accepted group authority.
- `projects.owner_user_id` and `project_grants` are the only project authorization sources.
- `oauth_token_projects`, `oauth_tokens.scope_all`, and `oauth_tokens.scoped_at` narrow credentials.
- `authorization_audit_events` stores append-only policy changes and consequential denials.

`projects.group_id` is organizational metadata, not authorization. Assigning a project to a group
atomically writes a tagged `project_grants` contributor row; removing the group removes only that
link-derived row. The `legacy_group` source label records how a grant was derived and does not mean
the old implicit reach rule is active.

All code paths must use `resolveProjectAccess` for an action decision or `USER_PROJECT_WHERE` for a
project visibility query. Direct SQL that infers access from `projects.group_id` is forbidden. Run
`npm run check:authz` to enforce this source invariant; the parity auditor is the sole exception
because it intentionally compares the retired model with current grants.

## Administration and revocation

Project owners manage grants and transfer ownership. A transfer makes the selected active user the
owner and retains the former owner as a manager so the operation does not strand access. Group
owners manage owner membership, and the last accepted owner cannot be demoted, removed, or leave.

Instance administrators manage account state, creation policy, authorization inventory, parity,
and audit history from the Administration page. Opening a project through the UI's system override
requires explicit confirmation and records an audit event. Agent-facing credentials never receive
that override.

Authorization is re-evaluated at request boundaries. Project and Runner WebSockets also re-check
live account, token, and project policy when processing or delivering frames; revocation closes the
connection with policy code `1008`. Audit metadata contains actor/resource ids, policy reason,
transport, and action/tool identity only—never prompt text, request bodies, secrets, or content.

## Migration, backup, and recovery

Migrations `0078_layered_authorization.sql` and `0079_authoritative_project_grants.sql` create and
reconcile the layered model. Before or after an upgrade, an administrator can call
`POST /api/admin/authorization/parity-audit` with `{ "reconcile": false }` to compare retired
owner/group reach with ownership/grants. A non-zero `lost` count blocks the retirement gate. Calling
the same endpoint with `{ "reconcile": true }` idempotently recreates missing group-link grants and
reruns the audit; explicit grants are never overwritten.

The full-instance export/import endpoints discover every application table, so grants, settings,
group roles, account ceilings, credential scopes, and authorization audit history round-trip with
the rest of D1. Recovery procedure:

1. Put the instance in maintenance mode and export the current snapshot.
2. Run the parity audit. If `lost` is non-zero, reconcile and inspect remaining differences.
3. Restore a known-good full snapshot if policy rows were deleted or corrupted.
4. Re-run parity, verify representative owner/viewer/manager accounts, then remove maintenance mode.

The retired implicit `group_id` fallback must not be reintroduced as a quick recovery mechanism;
repair or restore the authoritative grant rows instead.
