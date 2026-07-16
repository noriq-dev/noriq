// PLNR-21: admin D1 export endpoint.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ADMIN } from './helpers';

describe('D1 backup/export', () => {
  it('admin export returns a full snapshot of the live schema', async () => {
    const res = await SELF.fetch('https://planar.test/api/admin/export', {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename="noriq-/);
    const snap = (await res.json()) as { noriq: string; tables: Record<string, unknown[]>; counts: Record<string, number> };
    expect(snap.noriq).toBe('d1-snapshot');
    // Core tables present, discovered from sqlite_master (not a hard-coded list).
    for (const t of ['users', 'projects', 'tasks', 'agents']) {
      const rows = snap.tables[t];
      expect(Array.isArray(rows)).toBe(true);
      expect(snap.counts[t]).toBe(rows!.length);
    }
    // D1/SQLite internals are excluded.
    expect(snap.tables['d1_migrations']).toBeUndefined();
  });

  it('rejects non-admin callers', async () => {
    const res = await SELF.fetch('https://planar.test/api/admin/export');
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });
});
