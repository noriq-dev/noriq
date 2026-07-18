// PLNR-67: input requests (decision gates, auto-park) and alerts (non-blocking).
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, createUser, loginSession, mcpCall } from './helpers';

let agent: { id: string; apiKey: string };
let projectId: string;
let cookie: string;

const snapshot = async () =>
  (await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json()) as {
    signals: Array<{ id: string; type: string; severity: string; title: string; taskKey: string | null }>;
    tasks: Array<{ id: string; key: string; status: string }>;
  };

beforeAll(async () => {
  agent = await createAgent('signal-agent');
  await createUser('signal-human@example.com', 'Signal Human', 'longenough1', 'admin').catch(() => {});
  cookie = await loginSession('signal-human@example.com', 'longenough1');
  const proj = await mcpCall(agent.apiKey, 'create_project', { key: 'SIG', name: 'signals' });
  projectId = proj.body.id;
}, 60000);

describe('input requests (decision gates)', () => {
  it('parks the held task, and answering returns it to the queue + notifies the agent', async () => {
    const t = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'needs a call' })).body;
    await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId: t.id });

    const req = await mcpCall(agent.apiKey, 'request_input', {
      projectId, taskId: t.id, title: 'Which datastore?', body: 'KV vs D1 for the cache', options: ['KV', 'D1'],
    });
    expect(req.isError).toBe(false);
    expect(req.body.parked).toBe(true);

    // Task is parked to blocked (not claimable); signal shows in the snapshot.
    let snap = await snapshot();
    expect(snap.tasks.find((x) => x.id === t.id)!.status).toBe('blocked');
    const sig = snap.signals.find((s) => s.title === 'Which datastore?');
    expect(sig?.type).toBe('input_request');

    // Can't finish while the gate is open (task is blocked anyway, but assert the guard).
    // Human answers → task back to todo.
    const ans = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/signals/${sig!.id}/answer`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ response: 'Use D1' }),
    });
    expect(ans.status).toBe(200);
    snap = await snapshot();
    expect(snap.tasks.find((x) => x.id === t.id)!.status).toBe('todo');
    expect(snap.signals.find((s) => s.id === sig!.id)).toBeUndefined(); // no longer open

    // The requesting agent is notified of the answer.
    const upd = await mcpCall(agent.apiKey, 'get_project', { projectId });
    expect(upd.notices ?? '').toMatch(/Use D1|input request/);
  });

  it('blocks done while an input request is open', async () => {
    const t = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'gated finish' })).body;
    // Raise the request before claiming, so the task isn't auto-parked and stays claimable.
    await mcpCall(agent.apiKey, 'request_input', { projectId, taskId: t.id, title: 'ok to ship?' });
    await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId: t.id });
    const done = await mcpCall(agent.apiKey, 'release_task', { projectId, taskId: t.id, toStatus: 'done' });
    expect(done.isError).toBe(true);
    expect(done.text).toMatch(/open input request/);
  });
});

describe('alerts (non-blocking)', () => {
  it('raises an alert without parking anything', async () => {
    const t = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'has a deviation' })).body;
    await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId: t.id });
    const a = await mcpCall(agent.apiKey, 'raise_alert', {
      projectId, taskId: t.id, title: 'API returns 500s intermittently', severity: 'critical',
    });
    expect(a.isError).toBe(false);
    expect(a.body.parked).toBe(false);
    const snap = await snapshot();
    expect(snap.tasks.find((x) => x.id === t.id)!.status).toBe('in_progress'); // still held/working
    const alert = snap.signals.find((s) => s.title.startsWith('API returns'));
    expect(alert?.type).toBe('alert');
    expect(alert?.severity).toBe('critical');
  });

  it('a human can acknowledge an alert', async () => {
    const a = (await mcpCall(agent.apiKey, 'raise_alert', { projectId, title: 'heads up' })).body;
    const ack = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/signals/${a.id}/acknowledge`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(ack.status).toBe(200);
    const snap = await snapshot();
    expect(snap.signals.find((s) => s.id === a.id)).toBeUndefined();
  });
});

// ---- PLNR-131: batched, structured input requests ----------------------------------
describe('multi-question input requests', () => {
  it('questions ride the signal to every read; the formatted answer reaches the agent', async () => {
    const { createAgent, mcpCall, authorizeForAllProjects, createUser, loginSession } = await import('./helpers');
    const agent = await createAgent('batch-asker');
    const pid = (await mcpCall(agent.apiKey, 'create_project', { key: 'ASKB', name: 'ask-batch' })).body.id;
    await authorizeForAllProjects(agent.apiKey);
    const t = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId: pid, title: 'needs decisions' })).body;
    await mcpCall(agent.apiKey, 'claim_task', { projectId: pid, taskId: t.id });

    const raised = await mcpCall(agent.apiKey, 'request_input', {
      projectId: pid, taskId: t.id, title: 'Architecture decisions',
      questions: [
        { question: 'Which database?', header: 'DB', options: ['sqlite', 'postgres'] },
        { question: 'Which caches?', multi: true, options: ['redis', 'memcached'] },
        { question: 'Anything else to consider?' },
      ],
    });
    expect(raised.isError).toBe(false);
    expect(raised.body.parked).toBe(true);

    await createUser('asker-admin@example.com', 'Asker', 'longenough1', 'admin').catch(() => {});
    const cookie = await loginSession('asker-admin@example.com', 'longenough1');

    // The batch structure reaches the snapshot (what all three UIs render).
    const snap = (await (await SELF.fetch(`https://noriq.test/api/projects/${pid}/snapshot`, {
      headers: { Cookie: cookie },
    })).json()) as { signals: Array<{ id: string; questions: Array<{ question: string; multi?: boolean }> | null }> };
    const sig = snap.signals.find((x) => x.questions);
    expect(sig).toBeTruthy();
    expect(sig!.questions).toHaveLength(3);
    expect(sig!.questions![1]!.multi).toBe(true);

    // Answer as the UI would: one formatted string for the whole batch.
    const answer = 'Which database? → postgres\nWhich caches? → redis, other: disk tier\nAnything else to consider? → keep it simple';
    const res = await SELF.fetch(`https://noriq.test/api/projects/${pid}/signals/${sig!.id}/answer`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: answer }),
    });
    expect(res.status).toBe(200);

    // The agent hears the whole formatted answer and the task is back in the queue.
    const upd = await mcpCall(agent.apiKey, 'my_updates', {});
    const notice = upd.body.notices.find((n: string) => n.includes('Architecture decisions'));
    expect(notice).toBeTruthy();
    expect(notice).toContain('postgres');
    expect(notice).toContain('disk tier');
    const reclaim = await mcpCall(agent.apiKey, 'claim_task', { projectId: pid, taskId: t.id });
    expect(reclaim.isError).toBe(false);
  });
});

// ---- PLNR-185: typed answer kinds, structured answers, multi-round threads -------------
describe('request_input v2', () => {
  it('typed questions round-trip; structured answers land in response_json and derive the text form', async () => {
    const t = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'v2 decisions' })).body;
    await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId: t.id });
    const raised = await mcpCall(agent.apiKey, 'request_input', {
      projectId, taskId: t.id, title: 'Sizing decisions',
      questions: [
        { question: 'Which tier?', kind: 'select', options: ['small', 'large'] },
        { question: 'Max concurrent runs?', kind: 'number' },
        { question: 'Enable autoscale?', kind: 'confirm' },
      ],
    });
    expect(raised.isError).toBe(false);

    // Structure (incl. kind) reaches the snapshot for the answer form.
    const snap = (await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/snapshot`, { headers: { Cookie: cookie } })).json()) as {
      signals: Array<{ id: string; title: string; questions: Array<{ kind?: string }> | null }>;
    };
    const sig = snap.signals.find((s) => s.title === 'Sizing decisions')!;
    expect(sig.questions![1]!.kind).toBe('number');

    // Human answers structurally; the flat text form is derived server-side.
    const res = await SELF.fetch(`https://noriq.test/api/projects/${projectId}/signals/${sig.id}/answer`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [
        { question: 'Which tier?', answer: 'large' },
        { question: 'Max concurrent runs?', answer: 8 },
        { question: 'Enable autoscale?', answer: true },
      ] }),
    });
    expect(res.status).toBe(200);

    // The agent sees both forms on the task's signal.
    const detail = await mcpCall(agent.apiKey, 'get_task', { taskId: t.id });
    const answered = detail.body.signals.find((s: { id: string }) => s.id === sig.id);
    expect(answered.response).toContain('Which tier? → large');
    expect(answered.response).toContain('Max concurrent runs? → 8');
    expect(answered.responseJson).toHaveLength(3);
    expect(answered.responseJson[2]).toEqual({ question: 'Enable autoscale?', answer: true });
  });

  it('followUpTo threads rounds, inherits the parked task, and serves the thread endpoint', async () => {
    const t = (await mcpCall(agent.apiKey, 'create_task', { tags: ['test-fixture'], projectId, title: 'multi-round' })).body;
    await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId: t.id });
    const round1 = (await mcpCall(agent.apiKey, 'request_input', {
      projectId, taskId: t.id, title: 'Which region?', options: ['us', 'eu'],
    })).body;
    await SELF.fetch(`https://noriq.test/api/projects/${projectId}/signals/${round1.id}/answer`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: 'eu' }),
    });

    // Task returned to the queue; the follow-up round re-parks it WITHOUT taskId given.
    await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId: t.id });
    const round2 = await mcpCall(agent.apiKey, 'request_input', {
      projectId, title: 'eu-west or eu-central?', options: ['eu-west', 'eu-central'], followUpTo: round1.id,
    });
    expect(round2.isError).toBe(false);
    expect(round2.body.parked).toBe(true); // inherited the parent's task and parked it
    expect(round2.body.taskKey).toBe(t.key);

    const thread = (await (await SELF.fetch(`https://noriq.test/api/projects/${projectId}/signals/${round2.body.id}/thread`, {
      headers: { Cookie: cookie },
    })).json()) as { thread: Array<{ id: string; title: string; status: string; response: string | null }> };
    expect(thread.thread.map((s) => s.title)).toEqual(['Which region?', 'eu-west or eu-central?']);
    expect(thread.thread[0]!.status).toBe('answered');
    expect(thread.thread[0]!.response).toBe('eu');

    const bad = await mcpCall(agent.apiKey, 'request_input', {
      projectId, title: 'dangling round', followUpTo: 'sig_missing',
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('not an input request in this project');
  });
});
