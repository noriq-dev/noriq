-- 0010: per-project agent display names, without dropping the (heavily-referenced)
-- agents table. D1 enforces foreign keys during both migrations and `d1 execute` and
-- ignores PRAGMA toggles, so the column-level UNIQUE(name) can't be relaxed in place
-- (PLNR-65). Instead we split identity:
--   * `name`  — stable, globally-unique internal handle (system-generated). Never shown
--               to pick; used for attribution.
--   * `label` — the human display name, unique PER PROJECT (enforced in application code
--               via set_agent_identity). NULL falls back to `name`.
-- This lets the same friendly label ("worker") exist in different projects.
ALTER TABLE agents ADD COLUMN label TEXT;
CREATE INDEX idx_agents_project_label ON agents (project_id, label);
