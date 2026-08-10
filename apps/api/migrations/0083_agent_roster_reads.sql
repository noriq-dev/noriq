-- 0083: live-first, keyset-paginated actor rosters (PLNR-364).
--
-- Actor history grows forever by design. These indexes keep project/owner roster reads bounded
-- by their scope and make the live-presence EXISTS probe independent of historical presence rows.

CREATE INDEX idx_agents_project_roster
  ON agents (project_id, kind, archived_at, retired_at, last_seen_at DESC, id DESC);

CREATE INDEX idx_agents_owner_roster
  ON agents (user_id, kind, archived_at, retired_at, last_seen_at DESC, id DESC);

CREATE INDEX idx_agent_presences_live_actor
  ON agent_presences (actor_id, state, archived_at, last_seen_at DESC);
