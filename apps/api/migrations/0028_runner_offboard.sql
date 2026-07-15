-- 0028: a runner can be cut off (RUN-35).
--
-- Until now a runner could be created and never removed, and there was no way to stop one that
-- had gone wrong: register, heartbeat, list — no delete, no offboard, no rename, nothing in the
-- dashboard. A box that is lost, compromised, or running away had no off switch.
--
-- The blocker was only ever a missing column. Offboarding means revoking the TOKEN — that is
-- what actually severs dispatch, MCP, and reporting — but `runners` recorded owner_user_id and
-- nothing else, so there was no way to say WHICH token belongs to a runner. Meanwhile
-- agentAuth has been setting `connection.tokenId` all along, and POST /api/runners reads
-- `connection.userId` off that same object: the token id was right there, unstored.

ALTER TABLE runners ADD COLUMN token_id TEXT REFERENCES oauth_tokens(id);

-- Not a new `status` value, deliberately. status carries a CHECK — ('online','offline',
-- 'draining') — and widening it means rebuilding the table, which is impossible here: runners
-- is referenced by runs.runner_id and (since 0026) agents.runner_id, and D1 cannot rebuild a
-- table with inbound FKs (see PLNR-143 for the receipts). A timestamp is additive, and it
-- answers "when", which a status value cannot.
--
-- It is also the more honest shape: offboarded is not a liveness state that heartbeats move in
-- and out of, it is a decision a human made at a moment in time. The wire shape derives
-- status='offboarded' from it.
ALTER TABLE runners ADD COLUMN offboarded_at TEXT;

-- "Which runner does this token belong to" — the offboard read, and the reverse of the
-- question the Settings connections list asks.
CREATE INDEX idx_runners_token ON runners (token_id) WHERE token_id IS NOT NULL;
