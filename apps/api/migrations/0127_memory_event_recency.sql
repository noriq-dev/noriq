-- The briefing pulse selects recent memory changes for one project. Match both
-- equality predicates and its ordering so LIMIT 40 does not scan/sort project history.
CREATE INDEX idx_events_project_verb_global_seq ON events (project_id, verb, global_seq DESC);
