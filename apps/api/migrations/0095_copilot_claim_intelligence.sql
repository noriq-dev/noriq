-- PLNR-482: a task claim may identify the IDE Copilot's work role and canonical MCP-session
-- execution. Both are nullable so every existing Runner, human override, and legacy Copilot
-- caller remains valid.

ALTER TABLE claims ADD COLUMN work_role TEXT
  CHECK (work_role IS NULL OR work_role IN ('scope', 'build', 'verify'));
ALTER TABLE claims ADD COLUMN execution_id TEXT;

CREATE INDEX idx_claims_execution_live
  ON claims (execution_id) WHERE released_at IS NULL AND execution_id IS NOT NULL;
