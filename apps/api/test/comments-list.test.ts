import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authorizeForAllProjects, createAgent, createUser, loginSession, mcpCall } from './helpers';

const db = () => (env as unknown as { DB: D1Database }).DB;

async function insertComment(row: {
  id: string; taskId: string; authorKind: 'agent' | 'human'; authorId: string;
  kind?: string; body: string; status: string; createdAt: string;
}) {
  await db().prepare(
    `INSERT INTO comments (id, task_id, author_kind, author_id, kind, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id, row.taskId, row.authorKind, row.authorId, row.kind ?? 'comment',
    row.body, row.status, row.createdAt,
  ).run();
}

describe('bounded task comments', () => {
  let agent: { id: string; apiKey: string };
  let cookie: string;
  let projectId: string;
  let taskId: string;
  let taskKey: string;
  let foreignTaskId: string;

  beforeAll(async () => {
    agent = await createAgent('cmt-lister', 'orchestrator');
    await createUser('cmt-human@example.com', 'Cmt Human', 'longenough1', 'admin');
    cookie = await loginSession('cmt-human@example.com', 'longenough1');

    const proj = await mcpCall(agent.apiKey, 'create_project', { key: 'CMT', name: 'comment-bounds' });
    projectId = proj.body.id as string;
    await authorizeForAllProjects(agent.apiKey);
    const task = (await mcpCall(agent.apiKey, 'create_task', {
      tags: ['test-fixture'], projectId, title: 'busy journal',
    })).body;
    taskId = task.id as string;
    taskKey = task.key as string;

    const other = await mcpCall(agent.apiKey, 'create_project', { key: 'CMX', name: 'other' });
    await authorizeForAllProjects(agent.apiKey);
    foreignTaskId = ((await mcpCall(agent.apiKey, 'create_task', {
      tags: ['test-fixture'], projectId: other.body.id, title: 'elsewhere',
    })).body.id as string);

    for (let i = 0; i < 8; i++) {
      await insertComment({
        id: `cmt_open_${String(i).padStart(3, '0')}`,
        taskId, authorKind: 'human', authorId: 'usr_cmt',
        kind: 'question', body: `open ${i}`, status: 'open',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    for (let i = 0; i < 70; i++) {
      await insertComment({
        id: `cmt_res_${String(i).padStart(3, '0')}`,
        taskId, authorKind: 'agent', authorId: agent.id,
        body: `note ${i}`, status: 'addressed',
        createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString(),
      });
    }
  }, 60_000);

  it('get_task returns every open comment plus a 5-note resolved tail', async () => {
    const gt = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(gt.isError).toBe(false);
    const comments = gt.body.comments as Array<{ id: string; status: string; body: string }>;
    const open = comments.filter((c) => c.status === 'open');
    const resolved = comments.filter((c) => c.status !== 'open' && c.status !== 'acknowledged');
    expect(open).toHaveLength(8);
    expect(open.map((c) => c.body)).toEqual([
      'open 0', 'open 1', 'open 2', 'open 3', 'open 4', 'open 5', 'open 6', 'open 7',
    ]);
    expect(resolved).toHaveLength(5);
    expect(resolved.map((c) => c.body)).toEqual(['note 69', 'note 68', 'note 67', 'note 66', 'note 65']);
    expect(gt.body.moreResolvedComments).toBe(65);
    expect(gt.body.commentCounts).toEqual({ open: 8, resolved: 70, total: 78 });
  });

  it('list_comments pages newest-first and filters', async () => {
    const first = await mcpCall(agent.apiKey, 'list_comments', { taskId: taskKey, status: 'resolved', limit: 20 });
    expect(first.isError).toBe(false);
    expect(first.body.total).toBe(70);
    expect(first.body.hasMore).toBe(true);
    const page = first.body.comments as Array<{ id: string; body: string }>;
    expect(page).toHaveLength(20);
    expect(page[0]!.body).toBe('note 69');
    expect(page[19]!.body).toBe('note 50');
    expect(first.body.nextBefore).toBe(page[19]!.id);

    const second = await mcpCall(agent.apiKey, 'list_comments', {
      taskId, status: 'resolved', limit: 20, before: first.body.nextBefore,
    });
    expect(second.isError).toBe(false);
    const page2 = second.body.comments as Array<{ body: string }>;
    expect(page2[0]!.body).toBe('note 49');
    expect(page2).toHaveLength(20);

    const open = await mcpCall(agent.apiKey, 'list_comments', { taskId, status: 'open' });
    expect((open.body.comments as unknown[]).length).toBe(8);
    expect(open.body.total).toBe(8);
    expect(open.body.hasMore).toBe(false);

    const humans = await mcpCall(agent.apiKey, 'list_comments', { taskId, authorKind: 'human' });
    expect(humans.body.total).toBe(8);

    const missing = await mcpCall(agent.apiKey, 'list_comments', { taskId: 'CMT-9999' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/not found/i);

    const badCursor = await mcpCall(agent.apiKey, 'list_comments', { taskId, before: 'cmt_nope' });
    expect(badCursor.isError).toBe(true);
    expect(badCursor.text).toMatch(/not found on this task/i);
  });

  it('post_comment rejects bodies over 4000 characters', async () => {
    const t = (await mcpCall(agent.apiKey, 'create_task', {
      tags: ['test-fixture'], projectId, title: 'short notes only',
    })).body;
    const ok = await mcpCall(agent.apiKey, 'post_comment', {
      projectId, taskId: t.id, body: 'x'.repeat(4000),
    });
    expect(ok.isError).toBe(false);
    const tooLong = await mcpCall(agent.apiKey, 'post_comment', {
      projectId, taskId: t.id, body: 'x'.repeat(4001),
    });
    expect(tooLong.isError).toBe(true);
  });

  it('REST detail is bounded and the comments page is project-gated', async () => {
    const detail = await SELF.fetch(`https://noriq.test/api/tasks/${taskId}`, { headers: { Cookie: cookie } });
    expect(detail.status).toBe(200);
    const body = await detail.json() as {
      comments: Array<{ id: string; status: string }>;
      moreResolvedComments: number;
      commentCounts: { open: number; resolved: number; total: number };
    };
    expect(body.comments.filter((c) => c.status === 'open')).toHaveLength(8);
    expect(body.comments.filter((c) => c.status === 'addressed')).toHaveLength(20);
    expect(body.moreResolvedComments).toBe(50);
    expect(body.commentCounts).toEqual({ open: 8, resolved: 70, total: 78 });

    const page = await SELF.fetch(`https://noriq.test/api/tasks/${taskId}/comments?status=resolved&limit=10`, {
      headers: { Cookie: cookie },
    });
    expect(page.status).toBe(200);
    const listed = await page.json() as { comments: Array<{ body: string; id: string }>; hasMore: boolean; nextBefore: string };
    expect(listed.comments).toHaveLength(10);
    expect(listed.comments[0]!.body).toBe('note 69');
    expect(listed.hasMore).toBe(true);

    const next = await SELF.fetch(
      `https://noriq.test/api/tasks/${taskId}/comments?status=resolved&limit=10&before=${listed.nextBefore}`,
      { headers: { Cookie: cookie } },
    );
    expect(next.status).toBe(200);
    const page2 = await next.json() as { comments: Array<{ body: string }> };
    expect(page2.comments[0]!.body).toBe('note 59');

    const foreign = await mcpCall(agent.apiKey, 'list_comments', { taskId: foreignTaskId, limit: 1 });
    expect(foreign.isError).toBe(false);
  });
});
