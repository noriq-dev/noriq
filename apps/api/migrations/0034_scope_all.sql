-- 0034: "All projects" — a grant that follows the user instead of freezing a list (RUN-58).
--
-- RUN-38 gave a token a fixed set of projects. That is right for a runner and wrong for a
-- human's own client: every new project meant re-authorizing, because a scoped token has no
-- in-band way to widen (create_project joins its own scope; nothing else can reach it).
--
-- A THIRD state, rather than reusing scoped_at IS NULL — deliberately. NULL already means
-- "legacy, grandfathered". Making it ALSO mean "a human chose everything" would collapse two
-- different facts into one row shape: precisely the mistake 0027 introduced scoped_at to
-- avoid. "Which connections are wide open, and did someone actually choose that?" would stop
-- being answerable — and that is the question RUN-35's kill switch and any audit asks.
--
--   scoped_at NULL                -> legacy. Reaches everything its user can. Unchanged.
--   scoped_at SET + scope_all = 1 -> deliberately all, future projects included.
--   scoped_at SET + scope_all = 0 -> exactly the rows in oauth_token_projects (today).
--
-- scope_all composes with USER_PROJECT_WHERE rather than bypassing it, so "all" still cannot
-- exceed its user. That composition is also why "future projects" needs no backfill and no
-- bookkeeping: the token asks the same question the user does, every time it is asked.
--
-- On the two code tables: the choice is made at consent but spent at the token endpoint, so
-- it has to survive that hop the same way project_ids does.
--
-- Additive; DEFAULT 0 leaves every existing row reading exactly as it does today.
ALTER TABLE oauth_tokens ADD COLUMN scope_all INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oauth_codes ADD COLUMN scope_all INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oauth_device_codes ADD COLUMN scope_all INTEGER NOT NULL DEFAULT 0;
