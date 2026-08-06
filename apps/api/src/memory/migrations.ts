// The ordered manifest of ProjectMemory's internal SQLite migrations (PLNR-245).
//
// The migrations themselves are real `.sql` files in `apps/api/memory-migrations/`, which holds
// NOTHING ELSE — same convention as `apps/api/migrations/`. This manifest is code, so it lives
// here in `src/` beside the rest of the memory subsystem (backup/restore/lifecycle) rather than
// polluting a SQL directory with a TypeScript file.
//
// `memory-migrations/` is a SIBLING of `migrations/`, not part of it, and the distinction is
// load-bearing:
//
//   apps/api/migrations/*.sql         D1's schema. Applied by the wrangler CLI at deploy time
//                                     (`migrations_dir` in wrangler.jsonc) and by
//                                     readD1Migrations() in the test harness — i.e. applied
//                                     WHOLESALE to D1.
//   apps/api/memory-migrations/*.sql  The ProjectMemory Durable Object's OWN SQLite schema.
//                                     Applied inside the DO at construction, gated by a durable
//                                     `_meta.schema_version`, so it has to be carried in the
//                                     Worker bundle (a Worker has no runtime filesystem).
//
// Putting a memory migration in `migrations/` would make wrangler create the memory tables in D1
// and record them in `d1_migrations` — never do that.
//
// TO ADD A MIGRATION:
//   1. Create `apps/api/memory-migrations/NNNN_short_name.sql` beside 0001.
//   2. `import` it below and append one entry to MEMORY_MIGRATIONS. `version` MUST equal the
//      entry's array index + 1 (asserted at module load).
//   3. Never edit an already-shipped migration's SQL — a store that already ran it will not
//      re-run it, so an edit silently means "new stores get a different schema than old ones".
//      Add a new migration instead, exactly as with D1's numbered files.
//
// Migrations must be ADDITIVE (new tables, `ALTER TABLE ADD COLUMN`). That is a softer
// constraint than D1's — this is real SQLite, so a rebuild is technically possible — but
// dropping or rebuilding a table that `restoreSnapshot` copies, or that another table
// references, is exactly the class of change that breaks a restore in a way tests won't catch
// until someone needs one. Prefer additive.
//
// HOW THE `.sql` IMPORT RESOLVES TO A STRING — two places, both required:
//   • wrangler:  NOTHING to configure. Wrangler ships a DEFAULT Text module rule covering
//                `**/*.sql`, so the build emits the file as a text module the Worker imports.
//                Do NOT add a `rules` entry for .sql: a custom rule SHADOWS the default unless
//                it sets `fallthrough: true`, and the build then fails outright with "matched a
//                module rule … but was ignored".
//   • vitest.workspace.ts  the `sql-as-text` pre-transform plugin — the pool builds with vite,
//                which knows nothing about wrangler's rules and would otherwise try to parse
//                the SQL as JavaScript.
//   • src/sql-modules.d.ts  `declare module '*.sql'` — the typecheck path.
// If a `.sql` import ever fails, it is one of the latter two.
import sql0001 from '../../memory-migrations/0001_initial.sql';

export interface MemoryMigration {
  /** 1-based, contiguous, and equal to this entry's array index + 1. */
  version: number;
  /** For logs and error messages — the file's basename. */
  name: string;
  /** The file's full text; `SqlStorage.exec()` runs it in a single multi-statement call. */
  sql: string;
}

export const MEMORY_MIGRATIONS: readonly MemoryMigration[] = [
  { version: 1, name: '0001_initial', sql: sql0001 },
];

/** The schema version a freshly-migrated store lands on. */
export const LATEST_MEMORY_SCHEMA_VERSION = MEMORY_MIGRATIONS.length;

// A contiguous, correctly-numbered list is load-bearing: migrate() applies every entry whose
// version exceeds the store's current one, so a mis-numbered entry would record the wrong
// version and either skip a migration or re-run one. Assert at module load — this throws on the
// first request to any ProjectMemory rather than corrupting a schema.
for (const [i, m] of MEMORY_MIGRATIONS.entries()) {
  if (m.version !== i + 1) {
    throw new Error(`MEMORY_MIGRATIONS[${i}] declares version ${m.version}; expected ${i + 1}`);
  }
  if (typeof m.sql !== 'string' || m.sql.trim().length === 0) {
    // Guards the .sql-import wiring above: if a bundler resolved the import to something other
    // than text (a URL, an empty module), fail loudly here instead of "migrating" to an empty
    // schema and reporting success.
    throw new Error(`MEMORY_MIGRATIONS[${i}] (${m.name}) has no SQL text — check the .sql import wiring`);
  }
}
