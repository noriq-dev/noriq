-- PLNR-374: exact reconciliation needs the raw internal-edge count alongside normalized weight.
ALTER TABLE constellation_communities ADD COLUMN internal_edge_count INTEGER NOT NULL DEFAULT 0 CHECK (internal_edge_count >= 0);
