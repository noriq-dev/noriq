-- PLNR-374: a derived generation must never block canonical node deletion through its FKs.
-- Any node removal invalidates the whole disposable generation before the canonical DELETE.
CREATE TRIGGER invalidate_constellation_before_node_delete
BEFORE DELETE ON nodes
BEGIN
  DELETE FROM constellation_community_links;
  DELETE FROM constellation_memberships;
  DELETE FROM constellation_communities;
  DELETE FROM constellation_node_stats;
  DELETE FROM constellation_generations;
END;
