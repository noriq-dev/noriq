-- PLNR-469: persist both anchor lenses inside one disposable constellation generation.
-- New tables are required instead of adding `lens` to the old tables: their primary keys permit
-- only one membership per node/level and therefore cannot hold plans and memories concurrently.

CREATE TABLE constellation_lens_builds (
  generation_id TEXT NOT NULL REFERENCES constellation_generations(id) ON DELETE CASCADE,
  lens          TEXT NOT NULL CHECK (lens IN ('plans', 'memories')),
  anchor_count  INTEGER NOT NULL CHECK (anchor_count >= 0),
  ambient_count INTEGER NOT NULL CHECK (ambient_count >= 0),
  PRIMARY KEY (generation_id, lens)
);

CREATE TABLE constellation_lens_node_stats (
  generation_id   TEXT NOT NULL REFERENCES constellation_generations(id) ON DELETE CASCADE,
  lens            TEXT NOT NULL CHECK (lens IN ('plans', 'memories')),
  node_id         TEXT NOT NULL REFERENCES nodes(id),
  degree          INTEGER NOT NULL CHECK (degree >= 0),
  weighted_degree REAL NOT NULL CHECK (weighted_degree >= 0),
  rank            REAL NOT NULL,
  boundary_degree REAL NOT NULL DEFAULT 0 CHECK (boundary_degree >= 0),
  PRIMARY KEY (generation_id, lens, node_id)
);
CREATE INDEX idx_constellation_lens_node_rank
  ON constellation_lens_node_stats (generation_id, lens, rank DESC, node_id);

CREATE TABLE constellation_lens_communities (
  generation_id       TEXT NOT NULL REFERENCES constellation_generations(id) ON DELETE CASCADE,
  lens                TEXT NOT NULL CHECK (lens IN ('plans', 'memories')),
  id                  TEXT NOT NULL,
  parent_id           TEXT,
  level               INTEGER NOT NULL CHECK (level >= 0),
  label               TEXT NOT NULL,
  core_node_id        TEXT REFERENCES nodes(id),
  member_count        INTEGER NOT NULL CHECK (member_count >= 0),
  child_count         INTEGER NOT NULL CHECK (child_count >= 0),
  type_counts         TEXT NOT NULL,
  internal_edge_count INTEGER NOT NULL DEFAULT 0 CHECK (internal_edge_count >= 0),
  internal_weight     REAL NOT NULL CHECK (internal_weight >= 0),
  normalized_cohesion REAL NOT NULL CHECK (normalized_cohesion BETWEEN 0 AND 1),
  boundary_weight     REAL NOT NULL CHECK (boundary_weight >= 0),
  anchor_x            REAL NOT NULL,
  anchor_y            REAL NOT NULL,
  anchor_z            REAL NOT NULL,
  PRIMARY KEY (generation_id, lens, id),
  FOREIGN KEY (generation_id, lens, parent_id)
    REFERENCES constellation_lens_communities(generation_id, lens, id)
);
CREATE INDEX idx_constellation_lens_community_parent
  ON constellation_lens_communities (generation_id, lens, parent_id, level, id);

CREATE TABLE constellation_lens_memberships (
  generation_id TEXT NOT NULL REFERENCES constellation_generations(id) ON DELETE CASCADE,
  lens          TEXT NOT NULL CHECK (lens IN ('plans', 'memories')),
  node_id       TEXT NOT NULL REFERENCES nodes(id),
  community_id  TEXT NOT NULL,
  level         INTEGER NOT NULL CHECK (level >= 0),
  PRIMARY KEY (generation_id, lens, node_id, level),
  FOREIGN KEY (generation_id, lens, community_id)
    REFERENCES constellation_lens_communities(generation_id, lens, id)
);
CREATE INDEX idx_constellation_lens_membership_community
  ON constellation_lens_memberships (generation_id, lens, community_id, node_id);

CREATE TABLE constellation_lens_community_links (
  generation_id     TEXT NOT NULL REFERENCES constellation_generations(id) ON DELETE CASCADE,
  lens              TEXT NOT NULL CHECK (lens IN ('plans', 'memories')),
  level             INTEGER NOT NULL CHECK (level >= 0),
  from_community_id TEXT NOT NULL,
  to_community_id   TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('forward', 'reverse', 'both')),
  edge_count        INTEGER NOT NULL CHECK (edge_count > 0),
  weight            REAL NOT NULL CHECK (weight >= 0),
  by_type           TEXT NOT NULL,
  PRIMARY KEY (generation_id, lens, level, from_community_id, to_community_id),
  FOREIGN KEY (generation_id, lens, from_community_id)
    REFERENCES constellation_lens_communities(generation_id, lens, id),
  FOREIGN KEY (generation_id, lens, to_community_id)
    REFERENCES constellation_lens_communities(generation_id, lens, id)
);
CREATE INDEX idx_constellation_lens_links_from
  ON constellation_lens_community_links (generation_id, lens, level, from_community_id, weight DESC);
CREATE INDEX idx_constellation_lens_links_to
  ON constellation_lens_community_links (generation_id, lens, level, to_community_id, weight DESC);
