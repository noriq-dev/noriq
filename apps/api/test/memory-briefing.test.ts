// PLNR-268: get_briefing/my_updates evolve with memory-aware project context. Same cheapest-first
// split as PLNR-267's own suite (memory-context-pack.test.ts):
//   - assembleProjectMemoryPulse (sync.ts) directly — bounding (item/char caps) and degradation
//     (ProjectMemory unreachable, same contract as loadPriorEffort/lib/project-memory.ts) without
//     HTTP/MCP noise.
//   - the real get_briefing/my_updates MCP tools end to end — additive shape, canonical stale
//     state (never a heuristic recomputed here), supplemental-not-authoritative evidence, and the
//     pre-existing notices/state fields left untouched.
// The guidance-drift dogfood scan (INSTRUCTIONS/GET_BRIEFING_PLAYBOOK/SKILL_MD staying in sync) is
// NOT re-duplicated here — memory-guidance-drift.test.ts's existing live-surface scan already
// covers the unmodified repository, INCLUDING this task's edits, on every run.
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import type { Env } from '../src/env';
import { createAgent, createRunAgent, createUser, mintTokenForUser, mcpCall } from './helpers';
import { assembleProjectMemoryPulse, BRIEFING_PULSE_CHAR_BUDGET } from '../src/sync';
import { GET_BRIEFING_PLAYBOOK } from '../src/mcp';
import { ProjectMemoryPulse } from '@noriq-dev/shared';

const appEnv = env as unknown as Env;

interface MemRpc {
  drainOutbox(pid: string): Promise<{ delivered: number; failed: number }>;
  transitionMemoryValidity(
    pid: string,
    input: { memoryItemId: string; validity: 'active' | 'stale' | 'invalid'; reason?: string | null; actor: { kind: string; id: string | null } },
  ): Promise<{ ok: true }>;
}
const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemRpc;

let owner: { id: string; apiKey: string };
async function newProject(key: string): Promise<string> {
  const r = await mcpCall(owner.apiKey, 'create_project', { key, name: `${key} project` });
  if (r.isError) throw new Error(`create_project(${key}) failed: ${r.text}`);
  return r.body.id as string;
}

beforeAll(async () => {
  owner = await createAgent('memory-briefing-owner');
}, 60000);

// -------------------------------------------------------------------------------------------
// Layer 1 — assembleProjectMemoryPulse directly: bounding and degradation
// -------------------------------------------------------------------------------------------

describe('assembleProjectMemoryPulse — bounded, and degrades to null rather than throwing', () => {
  it('caps items per section and the whole block never exceeds its declared character budget', async () => {
    const projectId = await newProject('MPB1');
    const agent = await createRunAgent(projectId, 'scope');
    for (let i = 0; i < 10; i++) {
      await mcpCall(agent.apiKey, 'record_memory', {
        projectId, kind: 'hazard',
        statement: `hazard number ${i} — a real risk worth knowing before touching this area of the codebase, repeated so it has real size`,
      });
    }
    await memory(projectId).drainOutbox(projectId);

    const pulse = await assembleProjectMemoryPulse(appEnv, projectId, agent.agentId);
    expect(pulse).toBeTruthy();
    expect(pulse!.knownHazards.length).toBeLessThanOrEqual(5); // PULSE_MAX_ITEMS_PER_SECTION
    expect(pulse!.charBudget).toBe(BRIEFING_PULSE_CHAR_BUDGET);
    expect(pulse!.charsUsed).toBeLessThanOrEqual(pulse!.charBudget);
    // Ten hazards recorded but the section capped at 5 — the overflow must be DECLARED, not
    // silently dropped (locked decision: a fixed cap enforced before assembly, honestly noticed).
    expect(pulse!.notices.some((n) => n.kind === 'truncated' && n.reason.includes('known_hazards'))).toBe(true);
  });

  it('excerpts production-sized statements instead of returning empty sections with unused budget', async () => {
    const projectId = await newProject('MPBLONG');
    const agent = await createRunAgent(projectId, 'scope');
    await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'decision', statement: `decision ${'D'.repeat(3500)}` });
    await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'hazard', statement: `hazard ${'H'.repeat(3500)}` });
    await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'unknown', statement: `unknown ${'U'.repeat(3500)}` });
    await memory(projectId).drainOutbox(projectId);

    const pulse = await assembleProjectMemoryPulse(appEnv, projectId, agent.agentId);
    expect(pulse).toBeTruthy();
    expect(() => ProjectMemoryPulse.parse(pulse)).not.toThrow();
    const surfaced = [pulse!.activeDecisions[0], pulse!.knownHazards[0], pulse!.unresolvedUnknowns[0]];
    for (const item of surfaced) {
      expect(item).toBeTruthy();
      expect(item!.statementTruncated).toBe(true);
      expect(item!.statement.endsWith('…')).toBe(true);
      expect(pulse!.evidenceFrame.text).toContain(item!.statement);
    }
    expect(pulse!.charsUsed).toBeGreaterThan(575);
    expect(pulse!.charsUsed).toBeLessThanOrEqual(BRIEFING_PULSE_CHAR_BUDGET);
    expect(pulse!.notices.filter((n) => n.reason.includes('item(s) excerpted')).length).toBe(3);
  });

  it('swallows a thrown error from the ProjectMemory stub and returns null — same degradation contract as loadPriorEffort (§19)', async () => {
    const projectId = await newProject('MPB2');
    const agent = await createRunAgent(projectId, 'scope');
    // A real memory.changed event must exist first, or the candidate list is empty and the
    // throwing stub below is never actually invoked — this would silently test nothing.
    const rec = await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'decision', statement: 'a decision that will never be read back' });
    expect(rec.isError).toBeFalsy();
    await memory(projectId).drainOutbox(projectId);

    const throwingEnv = {
      ...appEnv,
      PROJECT_MEMORY: {
        idFromName: () => 'fake',
        get: () => ({ getMemoryItem: async () => { throw new Error('ProjectMemory unreachable (test)'); } }),
      },
    } as unknown as Env;
    const pulse = await assembleProjectMemoryPulse(throwingEnv, projectId, agent.agentId);
    expect(pulse).toBeNull();
  });

  it('a memory that fell off "active" surfaces ONLY as a stale warning, with the canonical validity/reason — never recomputed here', async () => {
    const projectId = await newProject('MPB3');
    const agent = await createRunAgent(projectId, 'scope');
    const rec = await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'hazard', statement: 'the export path leaks file handles under load' });
    const memoryId = rec.body.memoryId as string;
    await memory(projectId).drainOutbox(projectId);
    await memory(projectId).transitionMemoryValidity(projectId, {
      memoryItemId: memoryId, validity: 'stale', reason: 'superseded by the connection-pool rewrite', actor: { kind: 'system', id: null },
    });
    await memory(projectId).drainOutbox(projectId);

    const pulse = await assembleProjectMemoryPulse(appEnv, projectId, agent.agentId);
    expect(pulse).toBeTruthy();
    // Never ALSO shown as a currently-active hazard — one truth, not two.
    expect(pulse!.knownHazards.some((h) => h.id === memoryId)).toBe(false);
    const warning = pulse!.staleWarnings.find((w) => w.memoryItemId === memoryId);
    expect(warning).toBeTruthy();
    expect(warning!.validity).toBe('stale');
    expect(warning!.reason).toBe('superseded by the connection-pool rewrite');
  });
});

// -------------------------------------------------------------------------------------------
// Layer 2 — get_briefing / my_updates end to end
// -------------------------------------------------------------------------------------------

describe('get_briefing — additive `memory` block', () => {
  it('is null (not an error) when the agent has no localized project — every pre-existing field is still present', async () => {
    await createUser('mpb-nolocal@example.com', 'Owner', 'longenough1');
    const token = await mintTokenForUser('mpb-nolocal@example.com');
    const b = await mcpCall(token, 'get_briefing', {});
    expect(b.isError).toBe(false);
    expect(b.body.you).toBeTruthy();
    expect(Array.isArray(b.body.playbook)).toBe(true);
    expect(Array.isArray(b.body.projects)).toBe(true);
    expect(b.body.state).toBeTruthy();
    expect(Array.isArray(b.body.state.claimable)).toBe(true);
    expect(b.body.memory).toBeNull();
  });

  it('carries a well-formed, bounded memory block once localized, and every item states its own authority/validity/evidence', async () => {
    const projectId = await newProject('MPB4');
    const agent = await createRunAgent(projectId, 'scope'); // pinned to projectId by construction (RUN-160)
    await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'hazard', statement: 'touching the throttle without the shared lock corrupts state' });
    await mcpCall(agent.apiKey, 'record_memory', { projectId, kind: 'unknown', statement: 'unclear whether the legacy importer still runs in prod' });
    await memory(projectId).drainOutbox(projectId);

    const b = await mcpCall(agent.apiKey, 'get_briefing', {});
    expect(b.isError).toBe(false);
    expect(b.body.memory).toBeTruthy();
    const mem = b.body.memory as {
      projectId: string; generatedAt: string; charBudget: number; charsUsed: number;
      knownHazards: Array<{ id: string; authority: number; validity: string; evidence: unknown[] }>;
      unresolvedUnknowns: Array<{ id: string; authority: number; validity: string; evidence: unknown[] }>;
    };
    expect(mem.projectId).toBe(projectId);
    expect(typeof mem.generatedAt).toBe('string');
    expect(mem.charsUsed).toBeLessThanOrEqual(mem.charBudget);
    expect(mem.knownHazards.length).toBeGreaterThan(0);
    expect(mem.unresolvedUnknowns.length).toBeGreaterThan(0);
    for (const item of [...mem.knownHazards, ...mem.unresolvedUnknowns]) {
      expect(typeof item.authority).toBe('number');
      expect(typeof item.validity).toBe('string');
      expect(Array.isArray(item.evidence)).toBe(true);
    }
    // Pre-existing fields are untouched by the new field's presence.
    expect(b.body.you.kind).toBe('agent');
    expect(Array.isArray(b.body.playbook)).toBe(true);
    expect(b.body.playbook).toEqual(GET_BRIEFING_PLAYBOOK);
  });

  it('a memory that disagrees with a task never changes the coordination facts alongside it — only appears as labelled evidence', async () => {
    const projectId = await newProject('MPB5');
    const agent = await createRunAgent(projectId, 'scope');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Ship the throttle fix', tags: ['briefing-test'] });
    const taskId = made.body.id as string;
    // A decision that claims something FALSE about the task's real state.
    await mcpCall(agent.apiKey, 'record_memory', {
      projectId, kind: 'decision', statement: 'Ship the throttle fix is already done and needs no further work',
    });
    await memory(projectId).drainOutbox(projectId);

    const b = await mcpCall(agent.apiKey, 'get_briefing', {});
    const decisions = (b.body.memory as { activeDecisions: Array<{ statement: string; isLead: boolean }> }).activeDecisions;
    const disagreeing = decisions.find((d) => d.statement.includes('already done'));
    expect(disagreeing).toBeTruthy();
    // Agent-recorded decisions are clamped to low authority (PLNR-251/253) — presented as a LEAD
    // to weigh, never as settled fact, which is exactly what "labelled evidence" means here.
    expect(disagreeing!.isLead).toBe(true);

    // The REAL task is untouched by what the memory claims — still todo, unaffected either way.
    const task = await mcpCall(agent.apiKey, 'get_task', { taskId });
    expect(task.body.task.status).toBe('todo');
  });

  it('the notices text block still delivers exactly as before, alongside the new field', async () => {
    const projectId = await newProject('MPB6');
    const agent = await createRunAgent(projectId, 'scope');
    const made = await mcpCall(agent.apiKey, 'create_task', { projectId, title: 'Notices probe', tags: ['briefing-test'] });
    const taskId = made.body.id as string;
    const claimed = await mcpCall(agent.apiKey, 'claim_task', { projectId, taskId });
    expect(claimed.isError).toBeFalsy();

    const other = await createRunAgent(projectId, 'build');
    const commented = await mcpCall(other.apiKey, 'post_comment', { projectId, taskId, body: 'please double-check the retry budget', kind: 'question' });
    expect(commented.isError).toBeFalsy();

    // The "--- notices ---" footer is built by a SEPARATE computeUpdates call the `tool()`
    // wrapper (mcp.ts) makes AFTER every handler, cursor-gated — so the FIRST call to observe a
    // new event is the one whose footer carries it (a SECOND call afterward would see nothing
    // new, since the first already advanced the cursor). Use a plain, unrelated tool call
    // (list_projects) as that first observer, exactly like any real working agent's next call
    // would.
    const probe = await mcpCall(agent.apiKey, 'list_projects', {});
    expect(probe.notices).toBeTruthy();
    expect(probe.notices).toContain('retry budget');

    // A later my_updates call carries the additive memoryChanges/agentProjectId fields alongside,
    // not instead of, the existing state shape it has always returned.
    const updates = await mcpCall(agent.apiKey, 'my_updates', {});
    expect(updates.isError).toBeFalsy();
    expect(Array.isArray(updates.body.claimable)).toBe(true);
    expect(Array.isArray(updates.body.memoryChanges)).toBe(true);
    expect(updates.body.agentProjectId).toBe(projectId);
  });
});
