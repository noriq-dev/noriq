// PLNR-252: the kind-driven record_memory MCP tool and its human REST reads. Drives the tool
// over the real MCP HTTP surface (mcpCall/mcpList — same technique as the other MCP test
// files) rather than the ProjectMemory RPCs directly, since this task is about the AGENT-FACING
// surface PLNR-251's RPCs sit behind.
import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createUser, mintTokenForUser, mcpCall, mcpList, createRunAgent, loginSession } from './helpers';

async function newOwnedProject(email: string, key: string) {
  await createUser(email, 'Owner', 'longenough1');
  const token = await mintTokenForUser(email);
  const cookie = await loginSession(email, 'longenough1');
  const proj = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (proj.isError) throw new Error(`create_project(${key}) failed: ${proj.text}`);
  return { token, cookie, projectId: proj.body.id as string };
}

// REST reads (PLNR-252's human surface) are userAuth — a session cookie, not the MCP bearer
// token used above for record_memory itself.
async function restGet(cookie: string, path: string) {
  const res = await SELF.fetch(`https://noriq.test/api/projects/${path}`, { headers: { Cookie: cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('record_memory — registration and guidance', () => {
  it('registers exactly one new memory-WRITE tool, and its description carries the per-op/per-field guidance', async () => {
    const { token } = await newOwnedProject('pm-mcp-list@example.com', 'PMMCPLST');
    const tools = await mcpList(token);
    // search_project_memory (PLNR-257) is the read half, registered alongside record_memory —
    // this test is about record_memory's OWN registration/description, so it excludes it here
    // rather than widening the equality to two names every future memory tool would then break.
    const memoryTools = tools.filter((t) => (t.name.includes('memory') || t.name === 'record_memory') && t.name !== 'search_project_memory');
    expect(memoryTools.map((t) => t.name)).toEqual(['record_memory']);

    const desc = memoryTools[0]!.description;
    // Every MemoryKind, since the tool description enumerates them explicitly (zod's own
    // per-field .describe() is dropped by the SDK's zod3/4 mismatch — the guidance therefore
    // has to live in this top-level string, not on the `kind` field's schema metadata).
    for (const kind of ['learning', 'decision', 'failed_approach', 'procedure', 'requirement', 'hazard', 'unknown']) {
      expect(desc).toContain(kind);
    }
    expect(desc).toContain('op="contradict"');
    expect(desc).toContain('op="feedback"');
    expect(desc).toContain('supersedesMemoryId');
    expect(desc).toContain('evidence');
    expect(desc.toLowerCase()).toContain('clamp');
  });
});

describe('record_memory — op="record" across every kind', () => {
  it('records each MemoryKind successfully', async () => {
    const { token, projectId } = await newOwnedProject('pm-mcp-kinds@example.com', 'PMMCPKND');
    for (const kind of ['learning', 'decision', 'failed_approach', 'procedure', 'requirement', 'hazard', 'unknown']) {
      const res = await mcpCall(token, 'record_memory', { projectId, kind, statement: `a ${kind} statement` });
      expect(res.isError).toBeFalsy();
      expect(res.body.memoryId).toBeTruthy();
    }
  });

  it('records an evidence-backed memory, retrievable via the human REST read', async () => {
    const { token, cookie, projectId } = await newOwnedProject('pm-mcp-evidence@example.com', 'PMMCPEVD');
    const res = await mcpCall(token, 'record_memory', {
      projectId,
      kind: 'learning',
      statement: 'the retry logic lives in lib/retry.ts',
      evidence: [{ repositoryKey: 'repo-x', branch: 'main', baseId: 'deadbeef', path: 'lib/retry.ts' }],
    });
    expect(res.isError).toBeFalsy();
    const memoryId = res.body.memoryId as string;
    const rest = await restGet(cookie, `${projectId}/memory/items/${memoryId}`);
    expect(rest.status).toBe(200);
    expect(rest.body.evidence).toHaveLength(1);
    expect((rest.body.evidence as Array<{ path: string }>)[0]!.path).toBe('lib/retry.ts');
  });

  it('a statement with TBD/open-question phrasing records fine — doclint does not apply to memory', async () => {
    const { token, projectId } = await newOwnedProject('pm-mcp-tbd@example.com', 'PMMCPTBD');
    const res = await mcpCall(token, 'record_memory', {
      projectId,
      kind: 'unknown',
      statement: 'TBD: we have not decided how retries interact with rate limiting yet — open question',
    });
    expect(res.isError).toBeFalsy();
    expect(res.body.memoryId).toBeTruthy();
  });

  it('rejects a citation whose repositoryKey looks like a runner-local checkout id', async () => {
    const { token, projectId } = await newOwnedProject('pm-mcp-ckt@example.com', 'PMMCPCKT');
    const res = await mcpCall(token, 'record_memory', {
      projectId,
      kind: 'learning',
      statement: 'bad citation',
      evidence: [{ repositoryKey: 'ckt_abc123', branch: 'main', baseId: 'x', path: 'a.ts' }],
    });
    expect(res.isError).toBe(true);
  });
});

describe('record_memory — authority is clamped server-side regardless of what is asked for', () => {
  it('an explicit authority:5 request is stored as authority 2 at most', async () => {
    const { token, cookie, projectId } = await newOwnedProject('pm-mcp-auth@example.com', 'PMMCPAUT');
    const res = await mcpCall(token, 'record_memory', { projectId, kind: 'decision', statement: 'I hereby decide', authority: 5 });
    expect(res.isError).toBeFalsy();
    const rest = await restGet(cookie, `${projectId}/memory/items/${res.body.memoryId}`);
    expect((rest.body.authority as number)).toBeLessThanOrEqual(2);
  });
});

describe('record_memory — supersession (correction)', () => {
  it('supersedesMemoryId corrects a memory without editing or deleting the original', async () => {
    const { token, cookie, projectId } = await newOwnedProject('pm-mcp-super@example.com', 'PMMCPSUP');
    const original = await mcpCall(token, 'record_memory', { projectId, kind: 'learning', statement: 'the original claim' });
    expect(original.isError).toBeFalsy();
    const originalId = original.body.memoryId as string;

    const corrected = await mcpCall(token, 'record_memory', {
      projectId,
      kind: 'learning',
      statement: 'the corrected claim',
      supersedesMemoryId: originalId,
    });
    expect(corrected.isError).toBeFalsy();

    const rest = await restGet(cookie, `${projectId}/memory/items/${originalId}`);
    expect(rest.body.statement).toBe('the original claim'); // never rewritten
    const restCorrected = await restGet(cookie, `${projectId}/memory/items/${corrected.body.memoryId}`);
    expect(restCorrected.body.supersedesMemoryId).toBe(originalId);
  });
});

describe('record_memory — op="contradict"', () => {
  it('links two memories into one named contradiction set, both still independently readable', async () => {
    const { token, cookie, projectId } = await newOwnedProject('pm-mcp-contra@example.com', 'PMMCPCTR');
    const a = await mcpCall(token, 'record_memory', { projectId, kind: 'learning', statement: 'claim A' });
    const b = await mcpCall(token, 'record_memory', { projectId, kind: 'learning', statement: 'claim B contradicts A' });
    const linked = await mcpCall(token, 'record_memory', {
      projectId,
      op: 'contradict',
      memoryItemId: a.body.memoryId,
      contradictsMemoryItemId: b.body.memoryId,
    });
    expect(linked.isError).toBeFalsy();
    const setId = linked.body.setId as string;
    const rest = await restGet(cookie, `${projectId}/memory/contradictions/${setId}`);
    expect(new Set(rest.body.memoryItemIds as string[])).toEqual(new Set([a.body.memoryId, b.body.memoryId]));
  });
});

describe('record_memory — op="feedback"', () => {
  it('votes on a memory without touching its statement or evidence', async () => {
    const { token, cookie, projectId } = await newOwnedProject('pm-mcp-feedback@example.com', 'PMMCPFDB');
    const mem = await mcpCall(token, 'record_memory', { projectId, kind: 'procedure', statement: 'how to deploy' });
    const feedback = await mcpCall(token, 'record_memory', { projectId, op: 'feedback', memoryItemId: mem.body.memoryId, vote: 'up', reason: 'accurate' });
    expect(feedback.isError).toBeFalsy();
    expect(feedback.body.feedbackId).toBeTruthy();
    const rest = await restGet(cookie, `${projectId}/memory/items/${mem.body.memoryId}`);
    expect(rest.body.statement).toBe('how to deploy'); // unchanged by feedback
  });
});

describe('record_memory — runner-agent tool floor (RUN-47)', () => {
  it('is absent from tools/list for a floor that omits it, present and callable for one that includes it', async () => {
    const { token, projectId } = await newOwnedProject('pm-mcp-floor@example.com', 'PMMCPFLR');
    const withoutFloor = ['get_briefing', 'get_task', 'heartbeat'];
    const without = await createRunAgent(projectId, 'build', { ownerEmail: 'pm-mcp-floor@example.com', allowedTools: withoutFloor });
    const namesWithout = (await mcpList(without.apiKey)).map((t) => t.name);
    expect(namesWithout).not.toContain('record_memory');

    const withFloor = [...withoutFloor, 'record_memory'];
    const withIt = await createRunAgent(projectId, 'build', { ownerEmail: 'pm-mcp-floor@example.com', allowedTools: withFloor });
    const namesWith = (await mcpList(withIt.apiKey)).map((t) => t.name);
    expect(namesWith).toContain('record_memory');

    const called = await mcpCall(withIt.apiKey, 'record_memory', { projectId, kind: 'learning', statement: 'from a floor-permitted run agent' });
    expect(called.isError).toBeFalsy();
  });
});

describe('record_memory — project access is checked before any write', () => {
  it('refuses a project the caller cannot reach, not-found shaped', async () => {
    const { projectId: otherProjectId } = await newOwnedProject('pm-mcp-other@example.com', 'PMMCPOTH');
    const outsiderToken = await mintTokenForUser('pm-mcp-outsider@example.com');
    const res = await mcpCall(outsiderToken, 'record_memory', { projectId: otherProjectId, kind: 'learning', statement: 'should never land' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found|not accessible/);
  });
});
