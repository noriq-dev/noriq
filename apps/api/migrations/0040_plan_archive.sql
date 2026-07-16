-- PLNR-148: plans accumulate; finished ones clutter the Plans view forever. Archiving
-- is a DISPLAY concern (mirroring task archive, PLNR-150): the plan, its phases, and
-- the dependency edges it minted all stay — only the default listing hides it.
ALTER TABLE plans ADD COLUMN archived_at TEXT;
