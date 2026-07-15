-- 0027: a token reaches the projects a human ticked, and no others (RUN-38).
--
-- Today a runner's token inherits EVERYTHING its user can reach. Authorize a laptop and it
-- can touch every project on the account, because nothing narrows it and nothing checks.
-- The mechanism looked present but was inert: `oauth_tokens.scope` is stored, echoed in the
-- token response, and threaded through issueTokens — and `agentAuth` never read it. Every
-- token is issued `scope: 'mcp'` and every valid token passed. Half-built reads as working,
-- which is worse than absent.
--
-- A JOIN TABLE rather than scope strings, deliberately:
--   * `scopes_supported: ['mcp']` is advertised in the AS metadata, and RFC 8414 says that
--     list must be honest — minting `mcp:project:prj_x` strings would make discovery lie, or
--     force us to enumerate every project as a scope. The join table leaves discovery alone.
--   * it is queryable. "Which projects may this token reach" is a JOIN, not a LIKE over a
--     space-delimited string, and "which tokens reach this project" (the question RUN-35's
--     kill switch asks) is the same JOIN read the other way.
--   * it gets ugly at ten projects as a string. It does not as a table.
--
-- `scoped_at` is what says a token was ever put through the picker, and it exists because
-- row-absence cannot carry that meaning on its own. "No rows" would otherwise have to mean
-- BOTH "legacy token, reaches everything" and "scoped to nothing yet" — and those are exact
-- opposites, so collapsing them would eventually read a locked-down token as unrestricted.
-- The zero case is real, not hypothetical: a brand-new user has no projects to tick, and
-- `create_project` is an MCP tool, so a token scoped to nothing is precisely what bootstraps
-- the first project (which then joins its scope — see create_project).
--
--   scoped_at IS NULL  -> minted before scoping existed. Reaches everything its user can,
--                         exactly as before. Grandfathered DELIBERATELY: invalidating these
--                         would sign every human out and kill every live runner mid-run,
--                         which is not something to do as a side-effect of a schema change.
--   scoped_at IS NOT NULL -> a human chose. Reaches its rows below, and nothing else — even
--                         if there are none.
--
-- The cost of grandfathering is that enforcement stays ADVISORY for old tokens until they are
-- re-authorized. That is why `scoped` is surfaced per connection in Settings: a legacy token
-- becomes a visible thing a human can choose to revoke, rather than an invisible one.

ALTER TABLE oauth_tokens ADD COLUMN scoped_at TEXT;

CREATE TABLE oauth_token_projects (
  token_id   TEXT NOT NULL REFERENCES oauth_tokens(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (token_id, project_id)
);

-- "Which projects may this token reach" — the hot read, on every scoped MCP call.
CREATE INDEX idx_otp_token ON oauth_token_projects (token_id);
-- "Which tokens reach this project" — the reverse, for revocation and the connections UI.
CREATE INDEX idx_otp_project ON oauth_token_projects (project_id);

-- The grant flows carry the choice from consent → code → token, so the code rows need
-- somewhere to hold it between the human ticking boxes and the client exchanging the code.
-- JSON text, not a second join table: these rows are single-use and live for minutes
-- (CODE_TTL_S = 300, DEVICE_TTL_S = 600), so there is nothing to query and nothing to index —
-- the real table is the one above, written when the token is actually minted.
ALTER TABLE oauth_codes ADD COLUMN project_ids TEXT;
ALTER TABLE oauth_device_codes ADD COLUMN project_ids TEXT;
