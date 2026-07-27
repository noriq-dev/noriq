// RUN-74: the run transcript — append-only, role-labeled, idempotent. The "why was it
// refused" surface: log_tail is one last-writer-wins blob from the core agent, and the
// reviewer's report never reached the server at all.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { createUser, loginSession } from './helpers';

const appEnv = env as unknown as Env;
const actor: Actor = { kind: 'human', id: 'usr_rl', name: 'Log Tester' };

interface RoomRpc {
  createRun(projectId: string, actor: Actor, input: Record<string, unknown>): Promise<{ id: string }>;
  appendRunLog(projectId: string, runId: string, segments: Array<Record<string, unknown>>): Promise<void>;
  getRunLog(projectId: string, runId: string): Promise<{ segments: Array<{ seq: number; role: string; round: number | null; step: string | null; text: string }> }>;
}
const room = (pid: string) =>
  appEnv.PROJECT_ROOM.get(appEnv.PROJECT_ROOM.idFromName(pid)) as unknown as RoomRpc;

let cookie: string;
let pid: string;
let runId: string;

const seg = (seq: number, role: string, text: string, round: number | null = null) => ({
  seq, role, round, step: null as string | null, text, at: '2026-07-16T23:00:00.000Z',
});

beforeAll(async () => {
  await createUser('run-log@example.com', 'Run Log', 'longenough1', 'member').catch(() => {});
  cookie = await loginSession('run-log@example.com', 'longenough1');
  const p = await SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'RLOG', name: 'run-log' }),
  });
  pid = ((await p.json()) as { id: string }).id;
  await env.DB.prepare("INSERT OR IGNORE INTO runners (id, label) VALUES ('rnr_rl', 'rl')").run();
  runId = (await room(pid).createRun(pid, actor, {
    kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_rl',
  })).id;
}, 60000);

describe('the run transcript (RUN-74)', () => {
  it('appends in daemon order and reads back as the stream a human needs: build → reviewer → fix → re-review', async () => {
    await room(pid).appendRunLog(pid, runId, [
      seg(0, 'agent', 'implementing the thing…'),
      seg(1, 'verify', 'npm run check → exit 0'),
      seg(2, 'reviewer', 'The error path is untested.\nVERDICT: FAIL', 1),
      seg(3, 'system', 'reviewer refused — handing the report to the live agent (round 1/2)'),
    ]);
    await room(pid).appendRunLog(pid, runId, [
      seg(4, 'agent', 'adding the missing test…'),
      seg(5, 'reviewer', 'VERDICT: PASS', 2),
    ]);
    const { segments } = await room(pid).getRunLog(pid, runId);
    expect(segments.map((s) => s.role)).toEqual(['agent', 'verify', 'reviewer', 'system', 'agent', 'reviewer']);
    expect(segments[2]).toMatchObject({ round: 1, text: expect.stringContaining('VERDICT: FAIL') });
    expect(segments[5]).toMatchObject({ round: 2 });
  });

  // RUN-150. A five-step run read as one undifferentiated stream, so an operator watching it had
  // no idea what was actually happening — which is the whole reason a decomposition is worth
  // watching. The step rides ALONGSIDE the round rather than replacing it: a chain's step three can
  // still be on its second reviewer round, and one label could not say which.
  it('carries which step spoke, alongside the reviewer round', async () => {
    const r3 = (await room(pid).createRun(pid, actor, {
      kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_rl',
    })).id;
    await room(pid).appendRunLog(pid, r3, [
      { seq: 0, role: 'agent', round: null, step: 's1', text: 'landing the contract', at: '2026-07-16T23:00:00.000Z' },
      { seq: 1, role: 'agent', round: null, step: 's2', text: 'consuming it', at: '2026-07-16T23:00:00.000Z' },
      { seq: 2, role: 'reviewer', round: 2, step: 's2', text: 'VERDICT: PASS', at: '2026-07-16T23:00:00.000Z' },
    ]);
    const { segments } = await room(pid).getRunLog(pid, r3);
    expect(segments.map((x) => x.step)).toEqual(['s1', 's2', 's2']);
    expect(segments[2]).toMatchObject({ round: 2, step: 's2' });
  });

  // Most runs are undecomposed, and every segment written before the column existed has no step.
  it('is null for a run with no steps, rather than absent or empty', async () => {
    const { segments } = await room(pid).getRunLog(pid, runId);
    expect(segments.every((x) => x.step === null)).toBe(true);
  });

  it('redelivery is a no-op — (run_id, seq) OR IGNORE, the same idempotency every daemon frame gets', async () => {
    await room(pid).appendRunLog(pid, runId, [seg(2, 'reviewer', 'REPLAYED DIFFERENT TEXT', 1)]);
    const { segments } = await room(pid).getRunLog(pid, runId);
    expect(segments.filter((s) => s.seq === 2)).toHaveLength(1);
    expect(segments[2]!.text).toContain('The error path is untested'); // first write wins
  });

  it('caps the per-run segment count, marking the cut instead of growing without bound', async () => {
    const r2 = (await room(pid).createRun(pid, actor, {
      kind: 'build', repoRef: 'r', agentTool: 'claude', runnerId: 'rnr_rl',
    })).id;
    await room(pid).appendRunLog(pid, r2, [seg(1999, 'agent', 'last kept'), seg(2000, 'agent', 'dropped'), seg(2001, 'agent', 'dropped too')]);
    const { segments } = await room(pid).getRunLog(pid, r2);
    expect(segments.map((s) => s.seq)).toEqual([1999, 2000]);
    expect(segments[1]!.role).toBe('system');
    expect(segments[1]!.text).toMatch(/truncated/);
  });

  it('GET /api/runs/:runId/log serves it, project-reach gated', async () => {
    const ok = await SELF.fetch(`https://noriq.test/api/runs/${runId}/log`, { headers: { Cookie: cookie } });
    expect(ok.status).toBe(200);
    const { segments } = (await ok.json()) as { segments: Array<{ role: string }> };
    expect(segments.length).toBeGreaterThanOrEqual(6);
    // A user with no reach into the project sees 404, not the transcript.
    await createUser('rl-outsider@example.com', 'Outsider', 'longenough1', 'member').catch(() => {});
    const outsider = await loginSession('rl-outsider@example.com', 'longenough1');
    const denied = await SELF.fetch(`https://noriq.test/api/runs/${runId}/log`, { headers: { Cookie: outsider } });
    expect(denied.status).toBe(404);
  });

  it('a run the project does not own appends nothing (the RunnerHub ownership rule, room-side)', async () => {
    await room(pid).appendRunLog(pid, 'run_not_ours', [seg(0, 'agent', 'spoofed')]);
    const { segments } = await room(pid).getRunLog(pid, 'run_not_ours');
    expect(segments).toEqual([]);
  });
});
