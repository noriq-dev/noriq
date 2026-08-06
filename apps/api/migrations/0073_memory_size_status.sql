-- PLNR-250: visible per-project memory size status, projected from ProjectMemory's own
-- SqlStorage.databaseSize (the one real size measurement the platform exposes) via
-- ProjectRoom's upsertMemoryHealth. Visibility only — nothing reads this to refuse a write; the
-- point (§18) is a warning surfaces before the store becomes operationally unsafe, not that
-- writes get blocked at a hard cap.
ALTER TABLE project_memory_registry ADD COLUMN size_bytes INTEGER;
ALTER TABLE project_memory_registry ADD COLUMN size_status TEXT NOT NULL DEFAULT 'ok' CHECK (size_status IN ('ok', 'warn', 'critical'));
