-- PLNR-223 / RUN-114/121: the dispatch's agent COORDINATE and its selected repo-defined WORKFLOW.
--
-- The driver-seam generalization (RUN-109…122) let a dispatch name an agent as one coordinate
-- (`claude.opus-4_8.high`) instead of the tool+model+effort triple, and select a repo-defined
-- workflow (a named variant of a run kind that overrides only the PROMPT). The daemon accepts both
-- forms already; these two columns are the server half so the dashboard can emit them.
--
-- Both nullable and additive: a dispatch that sets neither behaves exactly as before — the daemon
-- synthesizes a coordinate from the legacy triple, and a null workflow means the built-in for `kind`.
--
-- NO CHECK on either, same reasoning as runs.model/effort (0033): `agent` embeds a vendor model id
-- (validated by the daemon's coordinate parser, not here), and `workflow` is a repo-local name whose
-- valid set lives in the committed manifest, invisible to the server. The zod contract validates
-- shape at the edge; a CHECK would only turn a bad value into a 500 at the write.
ALTER TABLE runs ADD COLUMN agent TEXT;
ALTER TABLE runs ADD COLUMN workflow TEXT;
