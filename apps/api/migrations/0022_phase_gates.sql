-- RUN-21: phase-boundary verify gating with bounded retries. Interposes verify at
-- the review→done transition (which, via the existing phase-dependency chain,
-- unblocks the next phase). Tracks per-phase verify attempts so we stop auto-
-- retrying after K failed cycles (default 2) and escalate to a human instead of a
-- fix→fail→fix budget sink. Additive-only.
CREATE TABLE phase_gates (
  phase_id   TEXT PRIMARY KEY,
  attempts   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','passed','retrying','escalated')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
