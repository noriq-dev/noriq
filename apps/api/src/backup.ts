// PLNR-21: D1 backup/export. A full logical snapshot of every user table, usable two
// ways: an admin-authenticated download endpoint, and a scheduled cron that writes the
// same snapshot to R2. Restore is documented in BACKUP.md. Tables are discovered from
// sqlite_master so the dump follows the live schema (no drift as migrations land).
import type { Env } from './env';

export type Snapshot = {
  noriq: 'd1-snapshot';
  version: 1;
  exportedAt: string;
  tables: Record<string, unknown[]>;
  counts: Record<string, number>;
};

/** List user tables (excluding SQLite/D1/Cloudflare internals). */
async function userTables(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'
     ORDER BY name`,
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function exportSnapshot(env: Env, exportedAt: string): Promise<Snapshot> {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const t of await userTables(env)) {
    // Table names come from sqlite_master (trusted), so this interpolation is safe.
    const { results } = await env.DB.prepare(`SELECT * FROM "${t}"`).all();
    tables[t] = results;
    counts[t] = results.length;
  }
  return { noriq: 'd1-snapshot', version: 1, exportedAt, tables, counts };
}

/** Write a timestamped snapshot to R2 (backups/…); no-op if R2 isn't configured. */
export async function backupToR2(env: Env, exportedAt: string): Promise<{ ok: boolean; key?: string; reason?: string }> {
  if (!env.FILES) return { ok: false, reason: 'R2 (FILES) not configured' };
  const snapshot = await exportSnapshot(env, exportedAt);
  const key = `backups/noriq-${exportedAt.replace(/[:.]/g, '-')}.json`;
  await env.FILES.put(key, JSON.stringify(snapshot), { httpMetadata: { contentType: 'application/json' } });
  return { ok: true, key };
}

// ---------------------------------------------------------------------------
// Import / restore (PLNR-218) — the inverse of exportSnapshot. A full REPLACE:
// the database is made to match the snapshot exactly (tables absent from the
// snapshot are emptied), so a restore is idempotent and an instance can be
// migrated wholesale.
//
// The one hazard a logical replay must solve is foreign keys: D1 enforces them
// and does NOT honor deferral across its batching (PLNR-143), so rows must load
// parents-before-children. We derive that order from the LIVE schema at import
// time (PRAGMA foreign_key_list) rather than a hard-coded list — mirroring the
// dynamic table discovery on the export side, so it never drifts as migrations
// land. True FK cycles (agents<->oauth_tokens, agents->runners->oauth_tokens)
// and self-references (tasks.parent_task_id, agents.parent_agent_id) are broken
// by DEFERRING a nullable, CHECK-free FK column: it loads NULL and is patched by
// an UPDATE once every row exists. (agents.runner_id is nullable but sits in a
// CHECK, so it is never chosen — the case scripts/reorder-d1-dump.py warns about.)
//
// The whole delete+insert+patch runs in ONE env.DB.batch() — an implicit
// transaction — so a failure rolls back and the database is left untouched.
//
// The notice-cursor needs no special handling: events.global_seq is a real
// column (migration 0056), so a SELECT *-based snapshot round-trips it, and the
// event_seq counter table is restored like any other.
// ---------------------------------------------------------------------------

export type ImportResult =
  | { ok: true; tables: number; imported: Record<string, number>; deferred: Record<string, string[]> }
  | { ok: false; error: string };

type ColInfo = { name: string; notnull: number; pk: number };
type TableSchema = { cols: ColInfo[]; fks: Array<{ table: string; from: string }>; checks: string };

// D1 caps bound parameters per query at 100; multi-row INSERTs chunk under this.
const MAX_BOUND_PARAMS = 90;

// Parent-row INSERT triggers can recreate these projection rows during a restore before the
// snapshot reaches the projection table itself. Clear the regenerated projection immediately
// before replaying its rows so even an empty snapshot is exact and every replayed INSERT stays
// strict.
const TRIGGER_POPULATED_TABLES = new Set(['agent_presences']);

// Structural execution parentage is protected by an immutability trigger, so restore must not
// use the generic NULL-then-patch cycle breaker for this self-reference. Parent-first row replay
// satisfies the FK without mutating an accepted node after insertion.
const ORDERED_SELF_REFERENCES = new Map<string, Set<string>>([
  ['agent_presences', new Set(['parent_presence_id'])],
  ['execution_nodes', new Set(['parent_execution_id'])],
]);
const IMMUTABLE_RESTORE_REFERENCES = new Map<string, Set<string>>([
  ['agent_presences', new Set(['parent_presence_id'])],
  ['execution_nodes', new Set(['parent_execution_id', 'task_id', 'plan_id', 'run_id'])],
]);

/** The parenthesized body of every CHECK(...) constraint in a CREATE TABLE, upper-cased —
 *  so a column a CHECK forbids from being NULL is never picked as a deferrable FK. */
function checkExpressions(sql: string): string {
  const exprs: string[] = [];
  const upper = sql.toUpperCase();
  let i = 0;
  while (i < sql.length) {
    const at = upper.indexOf('CHECK', i);
    if (at === -1) break;
    let j = at + 5;
    while (j < sql.length && /\s/.test(sql[j]!)) j++;
    if (sql[j] !== '(') { i = at + 5; continue; } // 'CHECK' not used as a constraint keyword here
    let depth = 0;
    let k = j;
    for (; k < sql.length; k++) {
      if (sql[k] === '(') depth++;
      else if (sql[k] === ')' && --depth === 0) { k++; break; }
    }
    exprs.push(sql.slice(j, k));
    i = k;
  }
  return exprs.join(' ').toUpperCase();
}

/** Read every user table's columns, foreign keys and CHECK bodies from the live schema. */
async function liveSchema(env: Env, tables: string[]): Promise<Map<string, TableSchema>> {
  const sqlRows = await env.DB.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table'`).all<{ name: string; sql: string | null }>();
  const sqlByName = new Map(sqlRows.results.map((r) => [r.name, r.sql ?? '']));
  const schema = new Map<string, TableSchema>();
  for (const t of tables) {
    // t comes from sqlite_master (trusted), so this interpolation is safe.
    const cols = await env.DB.prepare(`PRAGMA table_info("${t}")`).all<{ name: string; notnull: number; pk: number }>();
    const fks = await env.DB.prepare(`PRAGMA foreign_key_list("${t}")`).all<{ table: string; from: string }>();
    schema.set(t, {
      cols: cols.results.map((r) => ({ name: r.name, notnull: r.notnull, pk: r.pk })),
      fks: fks.results.map((r) => ({ table: r.table, from: r.from })),
      checks: checkExpressions(sqlByName.get(t) ?? ''),
    });
  }
  return schema;
}

/** FK-topological load order + the FK columns deferred (loaded NULL, patched later) to
 *  break cycles and self-references. Throws if a cycle has no nullable/CHECK-free edge. */
function planLoadOrder(schema: Map<string, TableSchema>): { order: string[]; deferred: Record<string, string[]> } {
  const tables = [...schema.keys()];
  const known = new Set(tables);
  const deferred: Record<string, string[]> = {};
  const defer = (t: string, c: string) => { (deferred[t] ??= []).push(c); };

  const deferrable = (t: string, col: string): boolean => {
    if (IMMUTABLE_RESTORE_REFERENCES.get(t)?.has(col)) return false;
    const ci = schema.get(t)!.cols.find((c) => c.name === col);
    if (!ci || ci.notnull) return false; // a NOT NULL column can't be transiently nulled
    return !new RegExp(`\\b${col.toUpperCase()}\\b`).test(schema.get(t)!.checks);
  };

  // Self-referential FK columns are deferred up front so intra-table row order never matters.
  for (const t of tables)
    for (const fk of schema.get(t)!.fks)
      if (fk.table === t) {
        if (ORDERED_SELF_REFERENCES.get(t)?.has(fk.from)) continue;
        if (!deferrable(t, fk.from)) throw new Error(`self-referential FK "${t}.${fk.from}" is not nullable/CHECK-free`);
        defer(t, fk.from);
      }

  // Cross-table dependency graph (self edges and already-deferred columns removed).
  const deps = new Map<string, Set<string>>();
  const edgeCols = new Map<string, string[]>(); // `${child}\0${parent}` -> the FK columns carrying that edge
  for (const t of tables) {
    const set = new Set<string>();
    for (const fk of schema.get(t)!.fks) {
      if (fk.table === t || !known.has(fk.table) || deferred[t]?.includes(fk.from)) continue;
      set.add(fk.table);
      const key = `${t} ${fk.table}`;
      const arr = edgeCols.get(key) ?? [];
      arr.push(fk.from);
      edgeCols.set(key, arr);
    }
    deps.set(t, set);
  }

  // Kahn topological sort; on a stall, defer one nullable/CHECK-free FK edge to break a cycle.
  const order: string[] = [];
  const done = new Set<string>();
  const pending = new Set(tables);
  while (pending.size) {
    const ready = [...pending].filter((t) => [...deps.get(t)!].every((p) => done.has(p))).sort();
    if (ready.length) {
      for (const t of ready) { order.push(t); done.add(t); pending.delete(t); }
      continue;
    }
    let broke = false;
    for (const t of [...pending].sort()) {
      for (const parent of [...deps.get(t)!].filter((p) => !done.has(p)).sort()) {
        const cols = edgeCols.get(`${t} ${parent}`)!;
        if (cols.every((c) => deferrable(t, c))) {
          cols.forEach((c) => defer(t, c));
          deps.get(t)!.delete(parent);
          broke = true;
          break;
        }
      }
      if (broke) break;
    }
    if (!broke) throw new Error(`unbreakable FK cycle among: ${[...pending].sort().join(', ')}`);
  }
  return { order, deferred };
}

function singlePk(cols: ColInfo[]): string | null {
  const pks = cols.filter((c) => c.pk > 0);
  return pks.length === 1 ? pks[0]!.name : null;
}

/** Coerce a JSON value back to something D1's bind() accepts (string | number | null). */
function bindable(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || typeof v === 'number') return v;
  return JSON.stringify(v); // a JSON/TEXT column dumped as an object — re-serialize it
}

function parentFirstRows(table: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const refs = ORDERED_SELF_REFERENCES.get(table);
  if (!refs?.size || rows.length < 2) return rows;
  const parentColumn = [...refs][0]!;
  const ids = new Set(rows.map((row) => String(row.id)));
  const emitted = new Set<string>();
  const pending = [...rows];
  const ordered: Array<Record<string, unknown>> = [];
  while (pending.length) {
    const before = pending.length;
    for (let i = pending.length - 1; i >= 0; i--) {
      const row = pending[i]!;
      const parent = row[parentColumn];
      if (parent != null && ids.has(String(parent)) && !emitted.has(String(parent))) continue;
      ordered.push(row);
      emitted.add(String(row.id));
      pending.splice(i, 1);
    }
    if (pending.length === before) throw new Error(`cyclic self-reference in snapshot table "${table}"`);
  }
  return ordered;
}

function prepareTriggerReplayRows(
  table: string,
  rows: Array<Record<string, unknown>>,
  snapshot: Record<string, Array<Record<string, unknown>>>,
): Array<Record<string, unknown>> {
  if (table === 'execution_nodes') {
    const replayed = new Set((snapshot.execution_lifecycle_events ?? []).map((event) => String(event.execution_id)));
    return rows.map((row) => replayed.has(String(row.id)) ? {
      ...row,
      status: 'pending', last_revision: 0,
      started_at: null, parked_at: null, finished_at: null, outcome_reason: null,
      updated_at: row.created_at,
    } : row);
  }
  if (table === 'execution_lifecycle_events') {
    return [...rows].sort((a, b) => (
      String(a.execution_id).localeCompare(String(b.execution_id))
      || Number(a.revision) - Number(b.revision)
    ));
  }
  return rows;
}

/** Restore a snapshot produced by exportSnapshot, REPLACING all current data. */
export async function importSnapshot(env: Env, raw: unknown): Promise<ImportResult> {
  const snap = raw as Partial<Snapshot> | null;
  if (!snap || typeof snap !== 'object' || (snap as Snapshot).noriq !== 'd1-snapshot')
    return { ok: false, error: 'not a Noriq snapshot (expected noriq: "d1-snapshot")' };
  if (snap.version !== 1) return { ok: false, error: `unsupported snapshot version: ${String(snap.version)}` };
  if (!snap.tables || typeof snap.tables !== 'object') return { ok: false, error: 'snapshot has no "tables"' };
  const snapTables = snap.tables as Record<string, Array<Record<string, unknown>>>;

  const tables = await userTables(env);
  const known = new Set(tables);
  const schema = await liveSchema(env, tables);

  // Refuse unknown tables/columns rather than silently dropping data (schema mismatch).
  for (const [t, rows] of Object.entries(snapTables)) {
    if (!known.has(t)) return { ok: false, error: `snapshot table "${t}" is not in this schema` };
    if (!Array.isArray(rows)) return { ok: false, error: `snapshot table "${t}" is not an array` };
    const live = new Set(schema.get(t)!.cols.map((c) => c.name));
    for (const c of rows.length ? Object.keys(rows[0]!) : [])
      if (!live.has(c)) return { ok: false, error: `snapshot table "${t}" has unknown column "${c}"` };
  }

  let order: string[];
  let deferred: Record<string, string[]>;
  try { ({ order, deferred } = planLoadOrder(schema)); }
  catch (e) { return { ok: false, error: (e as Error).message }; }

  const stmts: D1PreparedStatement[] = [];

  // 1. Null every deferred (cycle/self) reference so the wipe can delete in any FK order.
  for (const [t, cols] of Object.entries(deferred))
    stmts.push(env.DB.prepare(`UPDATE "${t}" SET ${[...new Set(cols)].map((c) => `"${c}" = NULL`).join(', ')}`));

  // 2. Empty every table, children before parents.
  for (const t of [...order].reverse()) stmts.push(env.DB.prepare(`DELETE FROM "${t}"`));

  // 3. Insert rows parents-first (deferred columns NULL), then 4. patch the deferred columns
  //    once every row exists (patches run after ALL inserts, so their targets are present).
  const patches: D1PreparedStatement[] = [];
  const imported: Record<string, number> = {};
  for (const t of order) {
    let rows = prepareTriggerReplayRows(t, snapTables[t] ?? [], snapTables);
    try { rows = parentFirstRows(t, rows); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
    imported[t] = rows.length;
    // Trigger-populated projections are replayed after every authoritative row and deferred FK
    // patch, because either operation may regenerate them.
    if (TRIGGER_POPULATED_TABLES.has(t)) continue;
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]!);
    const dcols = new Set(deferred[t] ?? []);
    const pk = singlePk(schema.get(t)!.cols);

    const perChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / cols.length));
    const tuple = `(${cols.map(() => '?').join(', ')})`;
    const colList = cols.map((c) => `"${c}"`).join(', ');
    for (let i = 0; i < rows.length; i += perChunk) {
      const chunk = rows.slice(i, i + perChunk);
      const binds: Array<string | number | null> = [];
      for (const row of chunk) for (const c of cols) binds.push(dcols.has(c) ? null : bindable(row[c]));
      stmts.push(env.DB.prepare(`INSERT INTO "${t}" (${colList}) VALUES ${chunk.map(() => tuple).join(', ')}`).bind(...binds));
    }

    for (const c of dcols) {
      if (!cols.includes(c)) continue;
      if (!pk) return { ok: false, error: `cannot restore deferred FK on "${t}" — no single-column primary key` };
      for (const row of rows) {
        if (row[c] == null) continue;
        patches.push(env.DB.prepare(`UPDATE "${t}" SET "${c}" = ? WHERE "${pk}" = ?`).bind(bindable(row[c]), bindable(row[pk])));
      }
    }
    // Classification triggers intentionally normalize old Worker INSERTs, but a restore is not
    // an old writer: it must preserve accepted lineage facts byte-for-byte. OAuth token replay
    // can also reclassify connection roots after the agent row is inserted, so apply these exact
    // snapshot values only after every authoritative row exists.
    if (t === 'agents' && pk) {
      for (const row of rows) {
        patches.push(env.DB.prepare(
          `UPDATE agents SET actor_class = ?, lineage_status = ?, lineage_reason = ?,
                             lifecycle_updated_at = ? WHERE id = ?`,
        ).bind(
          bindable(row.actor_class), bindable(row.lineage_status), bindable(row.lineage_reason),
          bindable(row.lifecycle_updated_at), bindable(row[pk]),
        ));
      }
    }
  }
  stmts.push(...patches);

  // 5. Replace ephemeral projections last. Their parents now exist and no later restore statement
  // can regenerate them, so an empty projection snapshot is also restored exactly.
  for (const t of order.filter((name) => TRIGGER_POPULATED_TABLES.has(name))) {
    stmts.push(env.DB.prepare(`DELETE FROM "${t}"`));
    const rows = snapTables[t] ?? [];
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]!);
    const perChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / cols.length));
    const tuple = `(${cols.map(() => '?').join(', ')})`;
    const colList = cols.map((c) => `"${c}"`).join(', ');
    for (let i = 0; i < rows.length; i += perChunk) {
      const chunk = rows.slice(i, i + perChunk);
      const binds: Array<string | number | null> = [];
      for (const row of chunk) for (const c of cols) binds.push(bindable(row[c]));
      stmts.push(env.DB.prepare(`INSERT INTO "${t}" (${colList}) VALUES ${chunk.map(() => tuple).join(', ')}`).bind(...binds));
    }
  }

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    return { ok: false, error: `import failed and rolled back: ${(e as Error).message}` };
  }
  return { ok: true, tables: order.length, imported, deferred };
}
