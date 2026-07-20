-- PLNR-203: file locking — advisory path locks so agents stop clobbering the same files where git
-- offers no locking. Additive only (D1 enforces FKs during apply + execute; CLAUDE.md).
-- Design authority: plan doc "Lock design — settled semantics & data model (v1)" (PLNR-201/202).
-- The ProjectRoom DO is the sole writer and the conflict arbiter; path-overlap detection lives in
-- the DO (lib/lockmatch.ts), NOT in SQL — the indexes below are storage + defense-in-depth only.

CREATE TABLE file_locks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  agent_id       TEXT NOT NULL REFERENCES agents(id),   -- holder = one MCP session (per-session id)
  task_id        TEXT REFERENCES tasks(id),             -- optional attribution + auto-release on settle
  kind           TEXT NOT NULL CHECK (kind IN ('file','dir','glob')),
  raw_pattern    TEXT NOT NULL,                         -- as supplied by the caller
  canon_pattern  TEXT NOT NULL,                         -- normalized, repo-relative POSIX (NFC)
  branch         TEXT,                                  -- NULL iff all_branches = 1
  all_branches   INTEGER NOT NULL DEFAULT 0,            -- 1 = explicit global scope
  mode           TEXT NOT NULL DEFAULT 'exclusive' CHECK (mode IN ('exclusive')),
  acquired_at    TEXT NOT NULL,
  expires_at     TEXT NOT NULL,                         -- server-set; never client-supplied
  released_at    TEXT                                   -- NULL = live
);
CREATE INDEX idx_file_locks_live   ON file_locks (project_id) WHERE released_at IS NULL;
CREATE INDEX idx_file_locks_agent  ON file_locks (agent_id)   WHERE released_at IS NULL;
CREATE INDEX idx_file_locks_task   ON file_locks (task_id)    WHERE released_at IS NULL;
CREATE INDEX idx_file_locks_expiry ON file_locks (expires_at) WHERE released_at IS NULL;
-- Overlap can't be a SQL constraint (globs/prefixes are the DO's job), but the exact-file,
-- same-branch double-lock is cheap to forbid at the storage layer as a backstop. The DO's
-- idempotent re-acquire UPDATEs in place and its conflict check denies before insert, so in
-- correct operation this index never fires — it only trips if a bug tried to double-insert.
CREATE UNIQUE INDEX idx_file_locks_exact ON file_locks (project_id, canon_pattern, branch)
  WHERE released_at IS NULL AND kind = 'file';

-- File locking is opt-in per project (default OFF) with its own TTL knob.
-- lock_ttl_seconds NULL → fall back to claim_ttl_seconds (itself defaulting to 1800s).
ALTER TABLE projects ADD COLUMN file_locking_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN lock_ttl_seconds INTEGER;
