/**
 * ProjectMemory DO SQLite table manifests — shared by backup/restore, health, and erase().
 * Kept out of ProjectMemory.ts so the DO class file stays focused on behavior.
 */

export const CANONICAL_TABLES = [
  'repositories',
  'index_generations',
  'index_batches',
  'index_staged_entities',
  'index_staged_edges',
  'nodes',
  'edges',
  'memory_items',
  'evidence',
  'feedback',
  'contradiction_sets',
  'contradictions',
  'memory_authority_transitions',
  'episodes',
  'outbox',
] as const;

export const CONSTELLATION_DERIVED_TABLES = [
  'constellation_generations',
  'constellation_node_stats',
  'constellation_communities',
  'constellation_memberships',
  'constellation_community_links',
  'constellation_lens_builds',
  'constellation_lens_node_stats',
  'constellation_lens_communities',
  'constellation_lens_memberships',
  'constellation_lens_community_links',
] as const;

export const SCHEMA_TABLES = [...CANONICAL_TABLES, ...CONSTELLATION_DERIVED_TABLES] as const;

export const OPERATIONAL_TABLES = ['applied_operations', 'memory_revision', 'projector_cursor'] as const;

export const BACKUP_TABLES = [...CANONICAL_TABLES, ...OPERATIONAL_TABLES] as const;

export const MEMORY_BACKUP_EXPORT_CHUNKS_PER_INVOCATION = 4;
export const MEMORY_BACKUP_EXPORT_CHUNK_TARGET_BYTES = 2 * 1024 * 1024;
export const MEMORY_BACKUP_EXPORT_READ_PAGE_ROWS = 32;
export const MEMORY_BACKUP_SNAPSHOT_ROWS_PER_BATCH = 500;
export const MEMORY_BACKUP_SNAPSHOT_BATCHES_PER_INVOCATION = 4;
export const MEMORY_BACKUP_RECOVERY_ROWS_PER_INVOCATION = 500;
export const MEMORY_BACKUP_EXPORT_SESSION_TTL_MS = 60 * 60 * 1000;
