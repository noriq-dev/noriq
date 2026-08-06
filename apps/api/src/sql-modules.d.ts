// `.sql` files import as their raw text — see memory-migrations/index.ts for the full note.
// Wrangler needs no config (it ships a default Text rule for **/*.sql); the vitest pool needs
// the `sql-as-text` plugin in vitest.workspace.ts; this declaration is the typecheck half.
declare module '*.sql' {
  const sql: string;
  export default sql;
}
