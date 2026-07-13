-- Claim TTL rework (PLNR-44): 5 minutes churns for long-form coding agents.
-- New default is 30 minutes; existing projects still on the old default move up.
UPDATE projects SET claim_ttl_seconds = 1800 WHERE claim_ttl_seconds = 300;

-- OAuth identity rework (PLNR-43): agents can be owned by (delegated from) a user.
ALTER TABLE agents ADD COLUMN user_id TEXT REFERENCES users(id);
