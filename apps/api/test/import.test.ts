// PLNR-218: admin D1 import endpoint — the inverse of /api/admin/export.
import { SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createAgent, mcpCall } from './helpers';

type Snap = {
  noriq: string;
  version: number;
  tables: Record<string, Array<Record<string, unknown>>>;
  counts: Record<string, number>;
};

async function exportSnap(): Promise<Snap> {
  const res = await SELF.fetch('https://noriq.test/api/admin/export', { headers: { Authorization: `Bearer ${ADMIN}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as Snap;
}

function importSnap(snap: unknown, confirm = true) {
  return SELF.fetch(`https://noriq.test/api/admin/import${confirm ? '?confirm=replace' : ''}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(snap),
  });
}

/** Rows as an order-independent multiset of canonical (sorted-key) JSON strings. */
const canon = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => JSON.stringify(Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]])))).sort();

describe('D1 import / restore (PLNR-218)', () => {
  let s0: Snap;

  beforeAll(async () => {
    // Seed a dataset that exercises the FK cycle (agents/oauth_tokens) and a self-reference
    // (tasks.parent_task_id), then snapshot the shared DB so afterAll can restore it exactly
    // (isolatedStorage is off — every file in the shard shares this D1).
    const { apiKey } = await createAgent('import-fixture');
    const proj = await mcpCall(apiKey, 'create_project', { key: 'IMPORT', name: 'Import Test' });
    const projectId = proj.body.id as string;
    const parent = await mcpCall(apiKey, 'create_task', { projectId, title: 'parent task', tags: ['import-test'], allowNewTags: true });
    await mcpCall(apiKey, 'create_task', { projectId, title: 'child task', tags: ['import-test'], allowNewTags: true, parentTaskId: parent.body.id });
    s0 = await exportSnap();
  });

  afterAll(async () => {
    // Put the shared DB back the way we found it, even if a test threw after a wipe.
    expect((await importSnap(s0)).status).toBe(200);
  });

  it('round-trips export → import → export with identical rows', async () => {
    const before = await exportSnap();
    // The fixture really did populate the cyclic + self-referential tables.
    expect(before.counts.agents).toBeGreaterThan(0);
    expect(before.counts.oauth_tokens).toBeGreaterThan(0);
    expect(before.tables.tasks!.some((t) => t.parent_task_id != null)).toBe(true);

    const res = await importSnap(before);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; imported: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.imported.tasks).toBe(before.counts.tasks);

    const after = await exportSnap();
    expect(after.counts).toEqual(before.counts);
    for (const t of Object.keys(before.tables)) {
      expect(canon(after.tables[t]!)).toEqual(canon(before.tables[t]!));
    }
  });

  it('REPLACES data — importing an older snapshot drops rows created since', async () => {
    const baseline = await exportSnap();
    const baseTasks = baseline.counts.tasks ?? 0;

    const { apiKey } = await createAgent('import-replace');
    const proj = await mcpCall(apiKey, 'create_project', { key: 'IMPORT2', name: 'Replace Test' });
    await mcpCall(apiKey, 'create_task', { projectId: proj.body.id, title: 'newer task', tags: ['import-test'], allowNewTags: true });

    const grown = await exportSnap();
    expect(grown.counts.tasks).toBe(baseTasks + 1);

    expect((await importSnap(baseline)).status).toBe(200);

    const restored = await exportSnap();
    expect(restored.counts.tasks).toBe(baseTasks);
    expect(restored.tables.tasks!.some((t) => t.title === 'newer task')).toBe(false);
  });

  it('guards the wipe behind ?confirm=replace', async () => {
    const snap = await exportSnap();
    const res = await importSnap(snap, false);
    expect(res.status).toBe(400);
    // The database was not touched.
    expect((await exportSnap()).counts).toEqual(snap.counts);
  });

  it('rejects a body that is not a snapshot', async () => {
    const res = await importSnap({ nope: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('rejects non-admin callers', async () => {
    const res = await SELF.fetch('https://noriq.test/api/admin/import?confirm=replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });
});
