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
