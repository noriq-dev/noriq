-- PLNR-266 — guidance_drift_findings: a maintenance defect report about NORIQ'S OWN agent-
-- guidance surfaces (INSTRUCTIONS / the get_briefing playbook / SKILL_MD / DOC_SKILL_MD), never
-- project knowledge. It does NOT belong in `memory_items` (0001): a memory_items row is
-- retrievable as evidence ABOUT THE PROJECT via search_project_memory/get_task_context, and §13
-- frames memory content as untrusted-but-presentable prompt evidence — neither framing fits a
-- server-generated report that "the doc-authoring rule is missing from SKILL_MD". This table is
-- read by humans (and future UI, Phase 8) directly, never surfaced through memory retrieval.
--
-- Spec correction: the task's execution spec names this file `0008_guidance_drift.sql`, but 0008
-- was already taken by PLNR-265's evidence-verification migration by the time this task started
-- (see that file's own spec-correction comment for the same pattern one task earlier). This is
-- 0009 — the directory listing is authoritative over the spec's literal filename.
CREATE TABLE guidance_drift_findings (
  id TEXT PRIMARY KEY,
  -- memory/guidance-drift.ts's findingHash(ruleId, sorted present/missing surfaces, quotes) —
  -- UNIQUE is what makes a re-scan of an unchanged repository idempotent: the same finding
  -- recomputes the same hash, so recordGuidanceDriftScan touches `last_seen_at` on the existing
  -- row instead of inserting a duplicate (stated acceptance: "deduplicated across repeated
  -- scans"). Deliberately excludes unavailable_surfaces/recommended_edit — see findingHash's own
  -- comment for why those two must never affect the dedup key.
  hash TEXT NOT NULL UNIQUE,
  rule_id TEXT NOT NULL,
  description TEXT NOT NULL,
  present_surfaces TEXT NOT NULL,     -- JSON array of surface ids, sorted
  missing_surfaces TEXT NOT NULL,     -- JSON array of surface ids, sorted — the actual drift
  unavailable_surfaces TEXT NOT NULL, -- JSON array of surface ids whose text could not be read;
                                       -- never treated as "missing" (honesty rule — see the
                                       -- module comment in memory/guidance-drift.ts)
  quotes TEXT NOT NULL,               -- JSON object: surfaceId -> the exact quoted matching text
  recommended_edit TEXT NOT NULL,     -- DATA only (locked decision) — nothing in this codebase
                                       -- reads this column back to write to a guidance file
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Findings are read per-rule far more often than by id (a human triaging "what's still drifting
-- on the priority-inversion rule").
CREATE INDEX idx_guidance_drift_findings_rule ON guidance_drift_findings(rule_id);
