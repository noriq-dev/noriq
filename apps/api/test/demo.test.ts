// PLNR-146: demo mode — one-click login, lazily seeded showcase project, nightly reset.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('demo mode', () => {
  it('advertises itself, mints a session, and seeds a showcase project', async () => {
    const status = (await (await SELF.fetch('https://planar.test/api/demo/status')).json()) as { enabled: boolean };
    expect(status.enabled).toBe(true);

    const login = await SELF.fetch('https://planar.test/api/demo/login', { method: 'POST' });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0]!;
    const { user } = (await login.json()) as { user: { role: string; name: string } };
    expect(user.role).toBe('member');

    // The seeded project reads as ALIVE: plan with a finished phase, review + overdue
    // tasks, a doc, a milestone — the feature set on display.
    const snap = (await (await SELF.fetch('https://planar.test/api/projects/prj_demo/snapshot', {
      headers: { Cookie: cookie },
    })).json()) as {
      tasks: Array<{ status: string; dueAt: string | null }>;
      plans: unknown[]; milestones: unknown[];
    };
    expect(snap.plans).toHaveLength(1);
    expect(snap.milestones.length).toBeGreaterThan(0);
    expect(snap.tasks.some((t) => t.status === 'done')).toBe(true);
    expect(snap.tasks.some((t) => t.status === 'review')).toBe(true);
    expect(snap.tasks.some((t) => t.dueAt && new Date(t.dueAt).getTime() < Date.now())).toBe(true);

    const docs = (await (await SELF.fetch('https://planar.test/api/projects/prj_demo/docs', {
      headers: { Cookie: cookie },
    })).json()) as { docs: Array<{ name: string }> };
    expect(docs.docs.some((d) => d.name === 'Architecture notes')).toBe(true);

    // Reset is idempotent end-to-end: second login (project exists) still works.
    const again = await SELF.fetch('https://planar.test/api/demo/login', { method: 'POST' });
    expect(again.status).toBe(200);
  });
});
