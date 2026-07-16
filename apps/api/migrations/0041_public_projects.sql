-- PLNR-78: opt-in public READ-ONLY visibility for a project. Deliberately a separate,
-- explicit flag consumed only by the dedicated /api/public/... read route — the authed
-- visibility rules (PLNR-91→116 hardening) are untouched, and no write path ever
-- consults this column.
ALTER TABLE projects ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
