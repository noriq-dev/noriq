-- Plans as full documents (PLNR-46): the plan carries the agent's complete
-- written readout (goals, approach, status, exit gate — markdown), and each
-- phase carries its own explicit details. Tasks stay linked per phase.
ALTER TABLE plans ADD COLUMN body TEXT NOT NULL DEFAULT '';
ALTER TABLE phases ADD COLUMN body TEXT NOT NULL DEFAULT '';
