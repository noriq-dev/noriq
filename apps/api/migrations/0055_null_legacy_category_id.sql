-- PLNR-108: retire the legacy tasks.category_id data.
-- Migration 0004 added tasks.category_id REFERENCES categories(id); 0008 renamed
-- categories→tags (SQLite rewrote the FK to tags(id)) and copied each assignment into
-- task_tags, but left category_id populated. That stale FK is what makes deleteProject /
-- deleteTag FK-abort: they remove a project's tags while tasks still reference them.
-- The column is retired in place (no longer written), so nulling it globally is safe and
-- drops the only remaining tasks→tags reference outside task_tags. Data-only, additive.
UPDATE tasks SET category_id = NULL WHERE category_id IS NOT NULL;
