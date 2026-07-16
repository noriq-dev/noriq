-- 0026: copilots and runner-spawned agents become different things (RUN-43).
--
-- Until now one `agents` row covered two identities with opposite lifecycles, so every
-- feature downstream had to guess which one it held:
--
--                  copilot                          agent
--   created by     itself, at MCP initialize        a runner, on dispatch
--   lifetime       the human's terminal session     exactly one run
--   project        may hop mid-session              pinned at creation, for life
--   heartbeat      meaningless (a human is there)   the liveness signal that matters
--   dies by        a closed tab                     SIGTERM from the daemon
--
-- A copilot going quiet was indistinguishable from a runaway agent, and a runner-spawned
-- process inherited the "may hop projects" freedom it must never have.
--
-- A *connection* (one `claude mcp add`) stops being an agent here. It never was one: the
-- OAuth grant minted a row with project_id NULL forever that did no work and existed only
-- so oauth_tokens.agent_id had a target — while polluting every agent list and forming a
-- cycle with agents.oauth_token_id. A connection is now simply its oauth_tokens row.
--
-- ADDITIVE BY NECESSITY, NOT PREFERENCE. A table with inbound FKs cannot be rebuilt on
-- D1: `PRAGMA foreign_keys=off` (which SQLite's 12-step ALTER requires) is refused, and
-- `defer_foreign_keys` does not save you — deferred FK is a COUNTER, not a commit-time
-- re-scan, so DROP+RENAME leaves it dirty and fails at commit. Established by PLNR-65 and
-- re-confirmed here. What that costs us is tracked on PLNR-143, which folds the true
-- rebuild into the PLNR-143 DB cutover (it pays the export/import cost anyway).
--
-- What we DID get without a rebuild, contrary to the pessimistic reading: ADD COLUMN
-- accepts CHECK constraints, and a column CHECK may reference sibling columns. So the
-- copilot/agent invariant below is enforced by the SCHEMA, not by convention.

-- 1. Connections stop being agents ------------------------------------------------------
--
-- oauth_tokens.agent_id was NOT NULL and pointed at the connection agent. Drop and re-add
-- it NULLABLE, which both breaks the agents↔oauth_tokens cycle and repurposes the column:
--   NULL     -> resolve the working agent from the MCP session (a human's connection)
--   NOT NULL -> this token acts as exactly this agent (a runner's per-run token)
-- That second meaning is what lets a runner own an agent's identity instead of asking the
-- spawned process to invent one.
DROP INDEX idx_oauth_tokens_agent;
ALTER TABLE oauth_tokens DROP COLUMN agent_id;
ALTER TABLE oauth_tokens ADD COLUMN agent_id TEXT REFERENCES agents(id);
CREATE INDEX idx_oauth_tokens_agent ON oauth_tokens (agent_id) WHERE agent_id IS NOT NULL;

-- The grant flows no longer pre-mint an agent to carry through; the token's owner is the
-- user, and the working identity is resolved (or assigned) later.
ALTER TABLE oauth_codes DROP COLUMN agent_id;
ALTER TABLE oauth_device_codes DROP COLUMN agent_id;

-- 2. The split itself -------------------------------------------------------------------
--
-- Existing rows default to 'copilot': before the runner existed every agent was a human's
-- session, and the backfill in step 3 promotes the ones that demonstrably weren't.
ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'copilot'
  CHECK (kind IN ('copilot', 'agent'));

-- The invariant, in the schema rather than in a comment: an agent is always runner-owned
-- AND project-pinned; a copilot is never runner-owned. A CHECK on the new column may read
-- its siblings, so both directions are enforced by one constraint. Note this also makes
-- step 3's backfill self-policing — a promotion that cannot supply a runner and a project
-- fails loudly here rather than creating the exact ambiguity this migration removes.
ALTER TABLE agents ADD COLUMN runner_id TEXT REFERENCES runners(id)
  CHECK (CASE WHEN kind = 'agent'
              THEN runner_id IS NOT NULL AND project_id IS NOT NULL
              ELSE runner_id IS NULL END);

-- 3. Backfill: promote the agents that were really runner-spawned -----------------------
--
-- These are discoverable rather than guessable: runs.agent_id is the daemon's report of
-- "the process I supervised registered as this actor", so any agent named by a run with a
-- runner IS a runner-spawned agent. Everything else stays a copilot.
--
-- project_id is COALESCEd from the run because an agent that died before calling
-- set_agent_identity never got scoped, and the CHECK above would otherwise reject it.
UPDATE agents SET
  kind = 'agent',
  runner_id = (
    SELECT r.runner_id FROM runs r
    WHERE r.agent_id = agents.id AND r.runner_id IS NOT NULL
    ORDER BY r.created_at DESC LIMIT 1),
  project_id = COALESCE(project_id, (
    SELECT r.project_id FROM runs r
    WHERE r.agent_id = agents.id AND r.runner_id IS NOT NULL
    ORDER BY r.created_at DESC LIMIT 1))
WHERE id IN (SELECT agent_id FROM runs WHERE agent_id IS NOT NULL AND runner_id IS NOT NULL);

-- 4. Retire the connection agents -------------------------------------------------------
--
-- Path B rows (created by the OAuth grant, never bound to an MCP session) are identified
-- by session_id IS NULL. Only delete the ones that own NOTHING: a sessionless agent that
-- somehow holds work is from the legacy `defaultAgent` fallback era, and it is a copilot's
-- work in all but name — keep it rather than cascade-destroy real history.
--
-- Every subquery filters NULLs explicitly: `x NOT IN (SELECT col ...)` where col yields a
-- single NULL is never true, which would silently delete nothing at all.
--
-- messages.from_id is the trap here. It is NOT a foreign key (0008 reshaped messages to
-- from_kind + from_id, so the sender may be a user OR an agent), which means the FK
-- enforcement that would otherwise refuse a dangerous DELETE does not apply to it. Deleting
-- an agent that sent messages would leave from_id pointing at nothing, silently, and no
-- constraint would complain. It is checked by hand for exactly that reason.
DELETE FROM agents
WHERE session_id IS NULL
  AND kind = 'copilot'
  AND id NOT IN (SELECT agent_id        FROM claims       WHERE agent_id        IS NOT NULL)
  AND id NOT IN (SELECT claimed_by      FROM tasks        WHERE claimed_by      IS NOT NULL)
  AND id NOT IN (SELECT agent_id        FROM plans        WHERE agent_id        IS NOT NULL)
  AND id NOT IN (SELECT from_id         FROM messages     WHERE from_kind = 'agent')
  AND id NOT IN (SELECT to_agent_id     FROM messages     WHERE to_agent_id     IS NOT NULL)
  AND id NOT IN (SELECT agent_id        FROM signals      WHERE agent_id        IS NOT NULL)
  AND id NOT IN (SELECT agent_id        FROM runs         WHERE agent_id        IS NOT NULL)
  AND id NOT IN (SELECT parent_agent_id FROM agents       WHERE parent_agent_id IS NOT NULL)
  AND id NOT IN (SELECT agent_id        FROM oauth_tokens WHERE agent_id        IS NOT NULL);

-- 5. Drop the ballast -------------------------------------------------------------------
--
-- Static API keys were retired (PLNR-52). Both columns survived only as NOT NULL filler:
-- api_key_hash was stuffed with the SHA-256 of a random UUID at every insert (so no token
-- could ever hash to it) and idx_agents_key indexed those random values; `scopes` is named
-- in no INSERT or SELECT anywhere and silently took its '[]' default. Dropping the index
-- first is required — SQLite refuses to drop an indexed column.
DROP INDEX idx_agents_key;
ALTER TABLE agents DROP COLUMN api_key_hash;
ALTER TABLE agents DROP COLUMN scopes;

-- 6. Index the new access path ----------------------------------------------------------
-- "which agents does this runner own" is the lifecycle query (offboard/revoke, RUN-35).
CREATE INDEX idx_agents_runner ON agents (runner_id) WHERE runner_id IS NOT NULL;

-- NOT DONE HERE, deliberately: UNIQUE (project_id, label) would close the TOCTOU race in
-- set_agent_identity (SELECT-then-UPDATE, no index, no transaction — two sessions can take
-- the same label). It is a one-line CREATE UNIQUE INDEX and needs no rebuild, but it fails
-- outright if live data already holds a duplicate, and production reads were not available
-- to check. Verify with the query below, then add it in its own migration:
--   SELECT project_id, label, COUNT(*) c FROM agents
--    WHERE label IS NOT NULL GROUP BY 1,2 HAVING c > 1;
