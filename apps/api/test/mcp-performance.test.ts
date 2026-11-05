import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Env } from '../src/env';
import type { AgentIdentity } from '../src/auth';
import { buildMcpServer } from '../src/mcp';
import { collectUpdates, computeUpdates, formatNotices } from '../src/sync';
import { filterFreshTasks } from '../src/lib/readiness-queue';
import { subjectFreshness, recordValidation } from '../src/lib/entity-validation-store';
import { batchedFreshnessReads } from '../src/lib/batched-freshness-reads';
import { instrumentMcpDatabase, measureMcpTool } from '../src/lib/mcp-performance';
import { createAgent, mcpCall } from './helpers';

const appEnv = env as unknown as Env;
let agent: AgentIdentity;
let projectId: string;
let tasks: Array<{ id: string; projectId: string }>;

beforeAll(async () => {
  const made = await createAgent('performance-agent');
  projectId = (await mcpCall(made.apiKey, 'create_project', { key: 'PERF', name: 'Performance' })).body.id;
  agent = (await env.DB.prepare('SELECT id, name, role, kind, user_id AS userId FROM agents WHERE id = ?')
    .bind(made.id).first<AgentIdentity>())!;
  const milestone = await env.DB.prepare('SELECT id FROM milestones WHERE project_id = ?').bind(projectId).first<{ id: string }>();
  await env.DB.prepare("UPDATE agents SET project_id = ? WHERE id = ?").bind(projectId, agent.id).run();
  await env.DB.prepare("UPDATE projects SET validation_policy = 'strict' WHERE id = ?").bind(projectId).run();
  tasks = Array.from({ length: 20 }, (_, i) => ({ id: `perf-task-${i}`, projectId }));
  await env.DB.batch(tasks.map((t, i) => env.DB.prepare(
    'INSERT INTO tasks(id,project_id,key,title,body,milestone_id) VALUES(?,?,?,?,?,?)',
  ).bind(t.id, projectId, `PERF-${i + 1}`, `Candidate ${i}`, 'Original intent', milestone!.id)));
  // Mixed results: a current passing task, a failed task and a task changed after evidence.
  for (const [i, outcome] of [[0, 'passed'], [1, 'failed'], [2, 'passed']] as const) {
    await recordValidation(env.DB, projectId, { kind: 'human', id: agent.userId, name: 'Reviewer' }, {
      subjectType: 'task', subjectId: tasks[i]!.id,
      assessment: { purpose: 'readiness', outcome, scope: 'non_code',
        summary: 'Inspected task intent against the acceptance criteria.',
        evidence: [{ kind: 'inspection', reference: 'fixture', result: 'Checked current intent.' }] },
    });
  }
  await env.DB.prepare('UPDATE tasks SET body = ? WHERE id = ?').bind('Changed intent', tasks[2]!.id).run();
});

async function measured<T>(fn: (db: D1Database) => Promise<T>) {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const value = await measureMcpTool('test', () => fn(instrumentMcpDatabase(env.DB)));
    const metrics = log.mock.calls.map(c => c[0]).find(m => m?.event === 'mcp.tool.performance');
    return { value, metrics };
  } finally { log.mockRestore(); }
}

describe('MCP performance without changing readiness or delivery', () => {
  it('batches twenty strict candidates with the same eligibility and fewer round trips', async () => {
    const baseline = await measured(async db => {
      const eligible = [];
      for (const task of tasks) {
        if (!(await subjectFreshness(db, projectId, 'task', task.id)).criticalCauses.length) eligible.push(task);
      }
      return eligible;
    });
    const batched = await measured(db => filterFreshTasks(db, tasks));
    expect(batched.value).toEqual(baseline.value);
    expect(batched.value.map(t => t.id)).toEqual([tasks[0]!.id]);
    expect(batched.metrics.dbCalls).toBeLessThan(baseline.metrics.dbCalls / 2);
    expect(batched.metrics.dbQueries).toBeLessThan(baseline.metrics.dbQueries);
    console.log('Freshness baseline vs batched', { baseline: baseline.metrics, batched: batched.metrics });
  });

  it('does not reuse stale reads after a batch has finished', async () => {
    const db = batchedFreshnessReads(env.DB);
    const sql = 'SELECT title FROM tasks WHERE id = ?';
    const before = await db.prepare(sql).bind(tasks[19]!.id).first<{ title: string }>();
    await env.DB.prepare('UPDATE tasks SET title = ? WHERE id = ?').bind('Updated title', tasks[19]!.id).run();
    expect(await db.prepare(sql).bind(tasks[19]!.id).first('title')).toBe('Updated title');
    expect(before!.title).not.toBe('Updated title');
    expect(() => db.prepare('DELETE FROM tasks')).toThrow('only supports SELECT');
    const failed = await Promise.allSettled([
      db.prepare('SELECT * FROM no_such_freshness_table').all(),
      db.prepare('SELECT title FROM tasks WHERE id = ?').bind(tasks[0]!.id).all(),
    ]);
    expect(failed.every(r => r.status === 'rejected')).toBe(true);
  });

  it('notices-only reads skip candidate assessment work but preserve notice text', async () => {
    const full = await measured(db => collectUpdates({ ...appEnv, DB: db }, agent));
    const notices = await measured(db => collectUpdates({ ...appEnv, DB: db }, agent, { noticesOnly: true }));
    expect(formatNotices(notices.value.updates)).toEqual(formatNotices(full.value.updates));
    expect(notices.value.updates.claimable).toEqual([]);
    expect(notices.value.updates.messages).toEqual([]);
    expect(notices.metrics.dbQueries).toBeLessThan(full.metrics.dbQueries / 2);
  });

  it('notices still validate new tasks, including windows larger than the D1 bind limit', async () => {
    await computeUpdates(appEnv, agent);
    const last = await env.DB.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project_id = ?')
      .bind(projectId).first<{ seq: number }>();
    // Most event subjects have since disappeared; one is ready and one lacks evidence.
    await env.DB.batch(Array.from({ length: 110 }, (_, i) => env.DB.prepare(
      `INSERT INTO events(id,project_id,seq,actor_kind,actor_id,verb,subject_type,subject_id,payload)
       VALUES(?,?,?,'human','sender','task.created','task',?,?)`,
    ).bind(`perf-created-${i}`, projectId, last!.seq + i + 1,
      i < 2 ? tasks[i]!.id : `deleted-perf-${i}`,
      JSON.stringify({ key: `PERF-${i + 1}`, title: `Candidate ${i}` }))));
    const delivery = await collectUpdates(appEnv, agent, { noticesOnly: true });
    expect(delivery.updates.notices).toHaveLength(1);
    expect(delivery.updates.notices[0]).toContain('PERF-1');
    await delivery.complete();
  });

  it('acknowledges only the collected window and never moves a newer cursor backwards', async () => {
    await computeUpdates(appEnv, agent);
    const event = async (id: string, body: string) => {
      await env.DB.prepare(`INSERT INTO events(id,project_id,seq,actor_kind,actor_id,verb,subject_type,subject_id,payload)
        SELECT ?, ?, COALESCE(MAX(seq),0)+1, 'human', 'sender', 'message.sent', 'message', ?, ? FROM events WHERE project_id = ?`)
        .bind(id, projectId, id, JSON.stringify({ to: agent.id, body, actorName: 'Sender' }), projectId).run();
    };
    await event('perf-first-event', 'First delivery');
    const older = await collectUpdates(appEnv, agent, { noticesOnly: true });
    expect(formatNotices(older.updates)).toContain('First delivery');
    await event('perf-second-event', 'Second delivery');
    await older.complete();
    const newer = await collectUpdates(appEnv, agent, { noticesOnly: true });
    expect(formatNotices(newer.updates)).toContain('Second delivery');
    expect(formatNotices(newer.updates)).not.toContain('First delivery');
    await newer.complete();
    await older.complete();
    const next = await collectUpdates(appEnv, agent, { noticesOnly: true });
    expect(next.updates.notices).toEqual([]);
  });

  it('briefing and updates collect once and ordinary tools avoid the full queue', async () => {
    const server = buildMcpServer(appEnv, agent);
    const client = new Client({ name: 'performance-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const briefing = await client.callTool({ name: 'get_briefing', arguments: {} });
      expect(briefing.isError).not.toBe(true);
      const updates = await client.callTool({ name: 'my_updates', arguments: {} });
      expect(updates.isError).not.toBe(true);
      await client.callTool({ name: 'list_boards', arguments: { projectId } });
      const summaries = log.mock.calls.map(c => c[0]).filter(m => m?.event === 'mcp.tool.performance');
      expect(summaries.map(m => m.tool)).toEqual(['get_briefing', 'my_updates', 'list_boards']);
      expect(summaries.every(m => m.outcome === 'ok')).toBe(true);
      const standalone = await measured(db => collectUpdates({ ...appEnv, DB: db }, agent));
      expect(summaries[1].dbQueries).toBe(standalone.metrics.dbQueries);
      expect(summaries[0].dbQueries).toBeLessThan(standalone.metrics.dbQueries + 10);
      expect(summaries[2].dbQueries).toBeLessThan(standalone.metrics.dbQueries / 2);
      expect(JSON.stringify(summaries)).not.toContain(projectId);
    } finally {
      log.mockRestore();
      await client.close();
      await server.close();
    }
  });

  it('isolates concurrent invocation metrics and records both errors and exceptions', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const db = instrumentMcpDatabase(env.DB);
    try {
      await Promise.all([
        measureMcpTool('one', () => db.prepare('SELECT 1 AS n').first()),
        measureMcpTool('two', async () => {
          await db.batch([db.prepare('SELECT 2 AS n'), db.prepare('SELECT 3 AS n')]);
          return { isError: true };
        }),
      ]);
      await expect(measureMcpTool('throws', async () => { throw new Error('private error'); })).rejects.toThrow();
      const byName = Object.fromEntries(log.mock.calls.map(c => [c[0].tool, c[0]]));
      expect(byName.one.dbQueries).toBe(1);
      expect(byName.two.dbQueries).toBe(2);
      expect(byName.two.dbCalls).toBe(1);
      expect(byName.two.dbResultsWithMeta).toBe(2);
      expect(byName.two.outcome).toBe('error');
      expect(byName.throws.outcome).toBe('exception');
      expect(JSON.stringify(byName)).not.toContain('private error');
    } finally { log.mockRestore(); }
  });
});
