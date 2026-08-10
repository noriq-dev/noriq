-- PLNR-299: retrieval-quality evidence is deliberately separate from ProjectMemory feedback.
-- An occurrence records what the retriever surfaced; a judgment appends a human assessment.
-- Neither table owns, edits, or suppresses the historical episode it names.
CREATE TABLE similar_effort_occurrences (
  id                        TEXT PRIMARY KEY,
  project_id                TEXT NOT NULL REFERENCES projects(id),
  task_id                   TEXT NOT NULL,
  query_context_fingerprint TEXT NOT NULL,
  query_context_class       TEXT NOT NULL,
  retrieval_version         TEXT NOT NULL,
  support_combination       TEXT NOT NULL,
  repository_key            TEXT,
  branch_filter             TEXT,
  preferred_branch          TEXT,
  base_id                   TEXT,
  candidate_episode_id      TEXT NOT NULL,
  candidate_run_id          TEXT NOT NULL,
  candidate_sitting         INTEGER NOT NULL CHECK (candidate_sitting > 0),
  rank                      INTEGER NOT NULL CHECK (rank > 0),
  observed_at               TEXT NOT NULL
);

CREATE INDEX idx_similar_effort_occurrences_project_time
  ON similar_effort_occurrences (project_id, observed_at, id);
CREATE INDEX idx_similar_effort_occurrences_candidate
  ON similar_effort_occurrences (project_id, candidate_episode_id);

CREATE TABLE similar_effort_feedback (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  operation_key         TEXT NOT NULL,
  operation_fingerprint TEXT NOT NULL,
  occurrence_id         TEXT NOT NULL REFERENCES similar_effort_occurrences(id),
  judgment              TEXT NOT NULL CHECK (judgment IN ('relevant','partially_relevant','not_similar')),
  reason_code           TEXT CHECK (reason_code IS NULL OR reason_code IN (
                            'wrong_subsystem','superficial_wording','different_task_shape',
                            'outdated_implementation','branch_revision_mismatch','duplicate_case','other'
                          )),
  reason                TEXT,
  actor_user_id         TEXT NOT NULL,
  supersedes_feedback_id TEXT REFERENCES similar_effort_feedback(id),
  created_at            TEXT NOT NULL,
  UNIQUE (project_id, operation_key)
);

CREATE INDEX idx_similar_effort_feedback_occurrence
  ON similar_effort_feedback (project_id, occurrence_id, created_at, id);
CREATE UNIQUE INDEX idx_similar_effort_feedback_one_superseder
  ON similar_effort_feedback (supersedes_feedback_id)
  WHERE supersedes_feedback_id IS NOT NULL;
