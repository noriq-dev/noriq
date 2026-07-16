// Demo mode (PLNR-146). With DEMO_MODE set, the login page offers "Try the demo" —
// one click mints a session as a seeded member user whose sample project shows the
// product working: a plan mid-flight, tasks in every column with tags/priorities/due
// dates, a doc, a milestone. The nightly cron re-seeds so visitors always land on a
// clean, alive-looking board no matter what the previous visitor did.
import type { Env } from '../env';
import type { ProjectRoom } from '../do/ProjectRoom';
import { hashPassword, newId, nowIso } from './util';

export const DEMO_EMAIL = 'demo@noriq.example';
const DEMO_PROJECT_ID = 'prj_demo';

const room = (env: Env, pid: string): DurableObjectStub<ProjectRoom> =>
  env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(pid));

/** Create the demo user if missing; returns its id. The password is random and never
 *  shown — the only way in is the demo-login route, and only while DEMO_MODE is set. */
export async function ensureDemoUser(env: Env): Promise<string> {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(DEMO_EMAIL).first<{ id: string }>();
  if (existing) return existing.id;
  const id = newId('usr');
  await env.DB.prepare(
    'INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, DEMO_EMAIL, 'Demo Visitor', 'member', await hashPassword(crypto.randomUUID() + crypto.randomUUID()), nowIso()).run();
  return id;
}

/** Drop and re-seed the demo project. Idempotent; safe to run from the cron. */
export async function resetDemo(env: Env): Promise<void> {
  const userId = await ensureDemoUser(env);
  const sys = { kind: 'system' as const, id: 'demo-seed', name: 'demo' };

  const existing = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(DEMO_PROJECT_ID).first();
  if (existing) await room(env, DEMO_PROJECT_ID).deleteProject(DEMO_PROJECT_ID, sys);

  await env.DB.prepare(
    `INSERT INTO projects (id, key, name, description, status, claim_ttl_seconds, owner_user_id, created_at)
     VALUES (?, 'DEMO', 'Checkout Revamp', 'AI agents rebuilding the checkout flow — humans supervising', 'active', 1800, ?, ?)`,
  ).bind(DEMO_PROJECT_ID, userId, nowIso()).run();

  const r = room(env, DEMO_PROJECT_ID);
  await r.createBoard(DEMO_PROJECT_ID, sys, 'Main');
  const ms = await r.createMilestone(DEMO_PROJECT_ID, sys, 'v2 launch', new Date(Date.now() + 12 * 86400_000).toISOString(), 'Done when: new checkout serves 100% of traffic.');

  await r.createDoc(DEMO_PROJECT_ID, sys, {
    name: 'Architecture notes',
    description: 'how the checkout services fit together',
    body: '# Checkout v2\n\nPayments go through the **gateway service**; cart state lives in the session store.\n\n- Never call the PSP directly from the SPA\n- Feature-flag everything behind `checkout_v2`',
  });

  // A plan mid-flight: phase 1 done, phase 2 in progress — the board reads as alive.
  const plan = await r.createPlan(DEMO_PROJECT_ID, sys, {
    title: 'Rebuild checkout in three phases',
    description: 'API first, then UI, then cutover',
    body: '# Goals\n\nReplace the legacy checkout without a big-bang release.\n\n## Exit gate\n\nConversion neutral-or-better over 7 days.',
    taskDefaults: { milestoneId: ms.id },
    phases: [
      { title: 'Payment API', newTasks: [
        { title: 'Design payment-intent schema', type: 'chore', priority: 3, tags: ['api'] },
        { title: 'Implement gateway adapter', type: 'feature', priority: 3, tags: ['api'] },
      ] },
      { title: 'Checkout UI', newTasks: [
        { title: 'Cart summary component', type: 'feature', priority: 2, tags: ['ui'] },
        { title: 'Payment form with validation', type: 'feature', priority: 3, tags: ['ui'] },
      ] },
      { title: 'Cutover', newTasks: [
        { title: 'Feature-flag rollout plan', type: 'chore', priority: 2, tags: ['ops'], dueAt: new Date(Date.now() + 10 * 86400_000).toISOString() },
      ] },
    ],
  });
  // Finish phase 1 so phase 2 is claimable and the progress rails show movement.
  for (const tid of plan.phases[0]!.taskIds) {
    await r.updateTask(DEMO_PROJECT_ID, sys, tid, { status: 'done' });
  }

  // Loose tasks in the other columns, one overdue — the badges have something to show.
  const rev = await r.createTask(DEMO_PROJECT_ID, sys, {
    title: 'Add retry/backoff to webhook consumer', type: 'feature', priority: 4, tags: ['api'], milestoneId: ms.id,
  });
  await r.updateTask(DEMO_PROJECT_ID, sys, rev.id, { status: 'review' });
  await r.createTask(DEMO_PROJECT_ID, sys, {
    title: 'Chase declined-card error taxonomy', type: 'research', priority: 2,
    dueAt: new Date(Date.now() - 2 * 86400_000).toISOString(), milestoneId: ms.id,
  });
}
