-- PLNR-373: disposable Constellation v2 hierarchy generations.
-- Canonical nodes/edges remain authoritative. Every table here can be dropped/rebuilt from them.

CREATE TABLE constellation_generations (
  id               TEXT PRIMARY KEY,
  source_revision  INTEGER NOT NULL,
  topology_version TEXT NOT NULL,
  layout_version   TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('building', 'complete', 'active', 'superseded', 'failed')),
  created_at       TEXT NOT NULL,
  completed_at     TEXT,
  activated_at     TEXT,
  failure_reason   TEXT
);
CREATE UNIQUE INDEX idx_constellation_one_active
  ON constellation_generations (status) WHERE status = 'active';
CREATE INDEX idx_constellation_generation_source
  ON constellation_generations (source_revision, created_at);

CREATE TABLE constellation_node_stats (
  generation_id  TEXT NOT NULL REFERENCES constellation_generations(id) ON DELETE CASCADE,
  node_id        TEXT NOT NULL REFERENCES nodes(id),
  degree         INTEGER NOT NULL CHECK (degree >= 0),
  weighted_degree REAL NOT NULL CHECK (weighted_degree >= 0),
  rank           REAL NOT NULL,
  boundary_degree REAL NOT NULL DEFAULT 0 CHECK (boundary_degree >= 0),
  PRIMARY KEY (generation_id, node_id)
);
CREATE INDEX idx_constellation_node_rank
  ON constellation_node_stats (generation_id, rank DESC, node_id);

CREATE TABLE constellation_communities (
  generation_id       TEXT NOT NULL REFERENCES constellation_generations(id) ON DELETE CASCADE,
  id                  TEXT NOT NULL,
  parent_id           TEXT,
  level               INTEGER NOT NULL CHECK (level >= 0),
  label               TEXT NOT NULL,
  member_count        INTEGER NOT NULL CHECK (member_count >= 0),
  child_count         INTEGER NOT NULL CHECK (child_count >= 0),
  type_counts         TEXT NOT NULL,
  internal_weight     REAL NOT NULL CHECK (internal_weight >= 0),
  normalized_cohesion REAL NOT NULL CHECK (normalized_cohesion BETWEEN 0 AND 1),
  boundary_weight     REAL NOT NULL CHECK (boundary_weight >= 0),
  anchor_x            REAL NOT NULL,
  anchor_y            REAL NOT NULL,
  anchor_z            REAL NOT NULL,
  PRIMARY KEY (generation_id, id),
  FOREIGN KEY (generation_id, parent_id) REFERENCES constellation_communities(generation_id, id)
);
CREATE INDEX idx_constellation_community_parent
  ON constellation_communities (generation_id, parent_id, level, id);

CREATE TABLE constellation_memberships (
  generation_id TEXT NOT NULL REFERENCES constellation_generations(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES nodes(id),
  community_id  TEXT NOT NULL,
  level         INTEGER NOT NULL CHECK (level >= 0),
  PRIMARY KEY (generation_id, node_id, level),
  FOREIGN KEY (generation_id, community_id) REFERENCES constellation_communities(generation_id, id)
);
CREATE INDEX idx_constellation_membership_community
  ON constellation_memberships (generation_id, community_id, node_id);

CREATE TABLE constellation_community_links (
  generation_id    TEXT NOT NULL REFERENCES constellation_generations(id) ON DELETE CASCADE,
  level            INTEGER NOT NULL CHECK (level >= 0),
  from_community_id TEXT NOT NULL,
  to_community_id   TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('forward', 'reverse', 'both')),
  edge_count        INTEGER NOT NULL CHECK (edge_count > 0),
  weight            REAL NOT NULL CHECK (weight >= 0),
  by_type           TEXT NOT NULL,
  PRIMARY KEY (generation_id, level, from_community_id, to_community_id),
  FOREIGN KEY (generation_id, from_community_id) REFERENCES constellation_communities(generation_id, id),
  FOREIGN KEY (generation_id, to_community_id) REFERENCES constellation_communities(generation_id, id)
);
CREATE INDEX idx_constellation_links_from
  ON constellation_community_links (generation_id, level, from_community_id, weight DESC);
CREATE INDEX idx_constellation_links_to
  ON constellation_community_links (generation_id, level, to_community_id, weight DESC);
