-- PLNR-597 (P2-F): opt-in review inbox inclusion for pure never_validated.
-- Default 0/off — flood control keeps never_validated out of list_review_inbox
-- unless a project explicitly enables this. impact_unknown stays omitted either way.

ALTER TABLE projects ADD COLUMN inbox_include_never_validated INTEGER NOT NULL DEFAULT 0;
