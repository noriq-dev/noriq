-- PLNR-194: per-project tag governance. 'open' (default) auto-creates tags as before,
-- with near-duplicate rejection; 'curated' means only humans mint tags — agents must
-- use the existing vocabulary (errors suggest the closest matches). Additive.
ALTER TABLE projects ADD COLUMN tag_policy TEXT NOT NULL DEFAULT 'open';
