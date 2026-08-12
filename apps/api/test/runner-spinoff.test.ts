// PLNR-478: the daemon owns classified review follow-ups but deliberately has no run-agent
// credential. POST /api/runner-spinoffs accepts explicit provenance only after binding it back to
// the authenticated live runner and its canonical task-anchored run, then reuses PLNR-230's
// proposed-task gate unchanged.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RunnerSpinoffTaskResponse, type RunnerSpinoffTaskRequest } from '@noriq-dev/shared';
import type { Actor, CreateRunInput, RunPatch, RunView } from '../src/do/ProjectRoom';
import {
  SYSTEM_ACTOR, authorizeForAllProjects, createUser, loginSession, mintTokenForUser, projectRoom,
} from './helpers';

interface RoomRpc {
  createRun(projectId: string, actor: Actor, input: CreateRunInput): Promise<RunView>;
  transitionRun(projectId: string, actor: Actor, runId: string, patch: RunPatch): Promise<RunView>;
}

const db = () => (env as unknown as { DB: D1Database }).DB;
const room = (projectId: string) => projectRoom<RoomRpc>(projectId);

const createProject = (cookie: string, key: string) =>
  SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name: key.toLowerCase() }),
  });

const registerRunner = (token: string, projectKey: string, label: string) =>
  SELF.fetch('https://noriq.test/api/runners', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label, tools: ['claude'], kinds: ['build', 'verify'], maxConcurrency: 1,
      repos: [{ id: `repo_${label}`, projectKey }],
    }),
  });

describe('POST /api/runner-spinoffs (PLNR-478)', () => {
  let ownerToken: string;
  let ownerCookie: string;
  let projectId: string;
  let runnerId: string;
  let sourceTaskId: string;
  let sourceRunId: string;

  const createSource = async (suffix: string) => {
    const taskRes = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks`, {
      method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `source ${suffix}`, tags: ['runner-followups'] }),
    });
    expect(taskRes.status).toBe(200);
    const task = (await taskRes.json()) as { id: string };
    const run = await room(projectId).createRun(projectId, SYSTEM_ACTOR as Actor, {
      kind: 'build', repoRef: 'repo_runner-followups', agentTool: 'claude', runnerId,
      anchor: { type: 'task', id: task.id },
    });
    return { taskId: task.id, runId: run.id };
  };

  const requestBody = (overrides: Partial<RunnerSpinoffTaskRequest> = {}): RunnerSpinoffTaskRequest => ({
    projectId, runnerId, sourceRunId, sourceTaskId,
    title: 'Follow up the bounded retry telemetry',
    body: 'The discovery review found adjacent work that did not block this run.',
    finding: 'src/retry.ts:42 — retry exhaustion should publish a bounded counter',
    priority: 2, type: 'chore',
    ...overrides,
  });

  const file = (token: string | null, body: unknown = requestBody()) =>
    SELF.fetch('https://noriq.test/api/runner-spinoffs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    await createUser('runner-spinoff@example.com', 'Runner Spin-off', 'longenough1', 'member').catch(() => {});
    ownerToken = await mintTokenForUser('runner-spinoff@example.com');
    ownerCookie = await loginSession('runner-spinoff@example.com', 'longenough1');
    const project = await createProject(ownerCookie, 'RSPN');
    projectId = ((await project.json()) as { id: string }).id;
    await authorizeForAllProjects(ownerToken);
    const registration = await registerRunner(ownerToken, 'RSPN', 'runner-followups');
    expect(registration.status).toBe(200);
    runnerId = ((await registration.json()) as { runner: { id: string } }).runner.id;
    ({ taskId: sourceTaskId, runId: sourceRunId } = await createSource('primary'));
  }, 60_000);

  it('requires the daemon bearer; a human session is not a substitute', async () => {
    const res = await SELF.fetch('https://noriq.test/api/runner-spinoffs', {
      method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody()),
    });
    expect(res.status).toBe(401);
  });

  it('files a proposed task with exact validated provenance and the existing human gate', async () => {
    const res = await file(ownerToken);
    expect(res.status).toBe(200);
    const made = RunnerSpinoffTaskResponse.parse(await res.json());
    expect(made.status).toBe('proposed');

    const row = await db().prepare(
      `SELECT status, proposed_at AS proposedAt, spinoff_run_id AS runId,
              spinoff_source_task_id AS sourceTaskId, spinoff_finding AS finding
         FROM tasks WHERE id = ?`,
    ).bind(made.id).first<{
      status: string; proposedAt: string | null; runId: string; sourceTaskId: string; finding: string;
    }>();
    expect(row).toMatchObject({
      status: 'todo', runId: sourceRunId, sourceTaskId,
      finding: expect.stringContaining('bounded counter'),
    });
    expect(row!.proposedAt).toBeTruthy();
    const tags = await db().prepare(
      'SELECT tg.name FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.task_id = ?',
    ).bind(made.id).all<{ name: string }>();
    expect(tags.results.map((tag) => tag.name)).toEqual(['runner-followups']);

    const event = await db().prepare(
      "SELECT actor_kind AS actorKind, actor_id AS actorId FROM events WHERE subject_id = ? AND verb = 'task.spun_off'",
    ).bind(made.id).first<{ actorKind: string; actorId: string }>();
    expect(event).toEqual({ actorKind: 'system', actorId: runnerId });

    const accepted = await SELF.fetch(
      `https://noriq.test/api/projects/${projectId}/tasks/${made.id}/spinoff/accept`,
      { method: 'POST', headers: { Cookie: ownerCookie } },
    );
    expect(accepted.status).toBe(200);
    const after = await db().prepare(
      'SELECT status, proposed_at AS proposedAt, spinoff_run_id AS runId FROM tasks WHERE id = ?',
    ).bind(made.id).first<{ status: string; proposedAt: string | null; runId: string }>();
    expect(after).toEqual({ status: 'todo', proposedAt: null, runId: sourceRunId });
  });

  it('rejects a source task that is not the run anchor', async () => {
    const other = await createSource('wrong-anchor');
    const res = await file(ownerToken, requestBody({ sourceTaskId: other.taskId }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('live task-anchored run');
  });

  it('rejects a source run owned by a different runner', async () => {
    const registration = await registerRunner(ownerToken, 'RSPN', 'runner-followups-two');
    const otherRunnerId = ((await registration.json()) as { runner: { id: string } }).runner.id;
    const res = await file(ownerToken, requestBody({ runnerId: otherRunnerId }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('live task-anchored run');
  });

  it('rejects a terminal source run rather than minting historical provenance', async () => {
    const terminal = await createSource('terminal');
    await room(projectId).transitionRun(projectId, SYSTEM_ACTOR as Actor, terminal.runId, { status: 'running' });
    await room(projectId).transitionRun(projectId, SYSTEM_ACTOR as Actor, terminal.runId, { status: 'done' });
    const res = await file(ownerToken, requestBody({ sourceRunId: terminal.runId, sourceTaskId: terminal.taskId }));
    expect(res.status).toBe(409);
  });

  it('requires the daemon token to reach the source project', async () => {
    // ownerToken was scoped before this project existed. Ownership establishes the project role,
    // but the token's intentionally narrower project scope must still deny the write.
    const project = await createProject(ownerCookie, 'RSP2');
    const scopedProjectId = ((await project.json()) as { id: string }).id;
    const taskRes = await SELF.fetch(`https://noriq.test/api/projects/${scopedProjectId}/tasks`, {
      method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'out of token scope' }),
    });
    const task = (await taskRes.json()) as { id: string };
    const run = await room(scopedProjectId).createRun(scopedProjectId, SYSTEM_ACTOR as Actor, {
      kind: 'build', repoRef: 'repo_scoped', agentTool: 'claude', runnerId,
      anchor: { type: 'task', id: task.id },
    });
    const res = await file(ownerToken, requestBody({
      projectId: scopedProjectId, sourceRunId: run.id, sourceTaskId: task.id,
    }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('authorized projects');
  });

  it('binds the runner to the exact registered token, not merely the same owner', async () => {
    const secondToken = await mintTokenForUser('runner-spinoff@example.com');
    await authorizeForAllProjects(secondToken);
    const res = await file(secondToken);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not active on this connection');
  });

  it('rejects an explicit empty tag override at the wire boundary', async () => {
    const body = { ...requestBody(), tags: [] };
    const res = await file(ownerToken, body);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid runner spin-off request');
  });

  it('requires an explicit tag when the source task has no vocabulary to inherit', async () => {
    const taskRes = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/tasks`, {
      method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'untagged legacy source' }),
    });
    const task = (await taskRes.json()) as { id: string };
    const run = await room(projectId).createRun(projectId, SYSTEM_ACTOR as Actor, {
      kind: 'build', repoRef: 'repo_legacy', agentTool: 'claude', runnerId,
      anchor: { type: 'task', id: task.id },
    });
    const res = await file(ownerToken, requestBody({ sourceRunId: run.id, sourceTaskId: task.id }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('source task has no tags');
  });
});
