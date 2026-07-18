// PLNR-111: the my_updates cursor rides events.global_seq — a counter that only ever
// climbs — instead of the table's implicit rowid. events.id is a TEXT PK, so rowid is
// non-AUTOINCREMENT and SQLite REUSES the max rowid after deleteProject removes it; an
// agent whose cursor already passed that value would then have `> cursor` silently
// exclude the reused-rowid event. global_seq is immune: deleteProject deletes events but
// never touches the event_seq counter.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createAgent, mcpCall } from './helpers';

// events has UNIQUE(project_id, seq); create_project/milestone already appended some
// events, so seed each project's counter above its current max seq before handing out more.
const nextSeq = new Map<string, number>();
const insertEvent = async (pid: string) => {
  if (!nextSeq.has(pid)) {
    const max = (await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE project_id = ?')
      .bind(pid).first<{ m: number }>())!.m;
    nextSeq.set(pid, max);
  }
  const seq = nextSeq.get(pid)! + 1;
  nextSeq.set(pid, seq);
  const id = `ev_${crypto.randomUUID().slice(0, 16)}`;
  await env.DB.prepare(
    `INSERT INTO events (id, project_id, seq, actor_kind, actor_id, verb, subject_type, subject_id, payload)
     VALUES (?, ?, ?, 'system', 'sys', 'test.evt', 'task', ?, '{}')`,
  ).bind(id, pid, seq, id).run();
  return (await env.DB.prepare('SELECT rowid AS r, global_seq AS g FROM events WHERE id = ?')
    .bind(id).first<{ r: number; g: number }>())!;
};

describe('events.global_seq (PLNR-111)', () => {
  it('is assigned monotonically by trigger and is never reused after a delete', async () => {
    const agent = await createAgent('evseq-agent');
    const keep = (await mcpCall(agent.apiKey, 'create_project', { key: 'EVSK', name: 'keep' })).body;
    const doomed = (await mcpCall(agent.apiKey, 'create_project', { key: 'EVSD', name: 'doomed' })).body;

    // The AFTER INSERT trigger assigns a positive, increasing global_seq.
    const a = await insertEvent(keep.id);
    expect(a.g).toBeGreaterThan(0);
    const b = await insertEvent(doomed.id);
    expect(b.g).toBeGreaterThan(a.g);

    // deleteProject removes a project's events (ProjectRoom.deleteProject). Simulate the
    // exact statement so SQLite is free to reuse the freed rowid on the next insert.
    await env.DB.prepare('DELETE FROM events WHERE project_id = ?').bind(doomed.id).run();

    const c = await insertEvent(keep.id);
    // global_seq keeps climbing past the deleted max — a cursor sitting at b.g still
    // sees c as new. (Under the old rowid cursor, c.r could be <= b.r and be dropped.)
    expect(c.g).toBeGreaterThan(b.g);
  });
});
