// RUN-136: the MCP surface. `create_task`, `create_tasks`, `update_task`, `update_tasks` and
// `get_task` carry the execution spec, so a scoping run can hand its findings forward as
// structure rather than prose. The column and the DO persistence are RUN-135.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, mcpCall, authorizeForAllProjects } from './helpers';

const SPEC = {
  requirementIds: ['RUN-136'],
  anticipatedFiles: [{ path: 'apps/api/src/mcp.ts', change: 'modify', why: 'the tool surface' }],
  requiredReading: ['doc_arch'],
  lockedDecisions: [{ decision: 'one shared description string', because: 'five tools carry it' }],
  discretion: ['wording'],
  deferred: ['the dashboard'],
  acceptance: {
    observableTruths: ['create_task accepts a spec and get_task returns it'],
    artifacts: [{ path: 'apps/api/src/mcp.ts', provides: 'the tools', exports: [] }],
    links: [{ from: 'create_task', to: 'tasks.execution_spec', via: 'ProjectRoom.createTask' }],
  },
};

describe('the execution spec on the MCP task tools (RUN-136)', () => {
  let agent: { id: string; apiKey: string };
  let projectId: string;
  const specOf = async (taskId: string) =>
    (await mcpCall(agent.apiKey, 'get_task', { taskId })).body.task.executionSpec;

  beforeAll(async () => {
    agent = await createAgent('spec-tools', 'orchestrator');
    const proj = await mcpCall(agent.apiKey, 'create_project', { key: 'XST', name: 'exec-spec-tools' });
    projectId = proj.body.id;
    await authorizeForAllProjects(agent.apiKey);
  });

  it('create_task accepts one and get_task returns it', async () => {
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId,
      title: 'planned at creation',
      tags: ['exec-spec'],
      allowNewTags: true,
      executionSpec: SPEC,
    });
    expect(made.isError).toBeFalsy();
    const spec = await specOf(made.body.id);
    expect(spec.requirementIds).toEqual(['RUN-136']);
    expect(spec.acceptance.links[0].via).toBe('ProjectRoom.createTask');
    // Normalised on the way in — the caller omitted `source`.
    expect(spec.lockedDecisions[0].source).toBe('');
  });

  it('create_task without one still works, and the task reads back unplanned', async () => {
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId,
      title: 'unplanned at creation',
      tags: ['exec-spec'],
    });
    expect(made.isError).toBeFalsy();
    expect(await specOf(made.body.id)).toBeNull();
  });

  it('create_tasks carries a spec per item', async () => {
    const made = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId,
      defaults: { tags: ['exec-spec'] },
      tasks: [
        { ref: 'a', title: 'batch planned', executionSpec: { requirementIds: ['A'] } },
        { ref: 'b', title: 'batch unplanned' },
      ],
    });
    expect(made.body.failed).toBe(0);
    const [a, b] = made.body.created as Array<{ ref: string; id: string }>;
    expect((await specOf(a!.id)).requirementIds).toEqual(['A']);
    expect(await specOf(b!.id)).toBeNull();
  });

  it('update_task replaces the spec outright, and null clears it', async () => {
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'editable via mcp', tags: ['exec-spec'], executionSpec: SPEC,
    });
    const replaced = await mcpCall(agent.apiKey, 'update_task', {
      projectId, taskId: made.body.id, executionSpec: { discretion: ['everything'] },
    });
    expect(replaced.isError).toBeFalsy();
    const after = await specOf(made.body.id);
    expect(after.discretion).toEqual(['everything']);
    expect(after.requirementIds).toEqual([]); // replaced, not merged

    await mcpCall(agent.apiKey, 'update_task', { projectId, taskId: made.body.id, executionSpec: null });
    expect(await specOf(made.body.id)).toBeNull();
  });

  it('update_task by display key works, like every other field', async () => {
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'by key', tags: ['exec-spec'],
    });
    const task = await mcpCall(agent.apiKey, 'get_task', { taskId: made.body.id });
    const res = await mcpCall(agent.apiKey, 'update_task', {
      projectId, taskId: task.body.task.key, executionSpec: { requirementIds: ['BY-KEY'] },
    });
    expect(res.isError).toBeFalsy();
    expect((await specOf(made.body.id)).requirementIds).toEqual(['BY-KEY']);
  });

  // Bulk set AND bulk clear. A first cut allowed only the clear, on the grounds that a spec names
  // one piece of work; review pushed back with cases that genuinely coincide across a phase —
  // shared required reading, one architecture decision — and noted that bulk status and bulk tag
  // replacement are no less dangerous and are not second-guessed. The warning lives in the
  // description now, not in the schema.
  it('update_tasks sets and clears specs in bulk', async () => {
    const one = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'bulk one', tags: ['exec-spec'], executionSpec: { requirementIds: ['X'] },
    });
    const two = await mcpCall(agent.apiKey, 'create_task', {
      projectId, title: 'bulk two', tags: ['exec-spec'], executionSpec: { requirementIds: ['Y'] },
    });

    const stamp = await mcpCall(agent.apiKey, 'update_tasks', {
      projectId,
      taskIds: [one.body.id, two.body.id],
      set: { executionSpec: { requiredReading: ['ARCHITECTURE.md'] } },
    });
    expect(stamp.body.failed).toBe(0);
    for (const t of [one, two]) {
      const spec = await specOf(t.body.id);
      expect(spec.requiredReading).toEqual(['ARCHITECTURE.md']);
      expect(spec.requirementIds).toEqual([]); // replaced, not merged
    }

    const cleared = await mcpCall(agent.apiKey, 'update_tasks', {
      projectId, taskIds: [one.body.id, two.body.id], set: { executionSpec: null },
    });
    expect(cleared.body.failed).toBe(0);
    expect(await specOf(one.body.id)).toBeNull();
    expect(await specOf(two.body.id)).toBeNull();
  });

  // Zod strips unknown keys and the advertised schema carries no `additionalProperties: false`,
  // so a spec sent in `defaults` used to vanish: a batch of unplanned tasks and a success
  // response. It is honoured rather than silently dropped.
  it('create_tasks honours a spec in defaults, and an item overrides it wholesale', async () => {
    const made = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId,
      defaults: { tags: ['exec-spec'], executionSpec: { requiredReading: ['SHARED.md'] } },
      tasks: [
        { ref: 'inherits', title: 'inherits the default spec' },
        { ref: 'overrides', title: 'brings its own', executionSpec: { requirementIds: ['OWN'] } },
      ],
    });
    expect(made.body.failed).toBe(0);
    const [a, b] = made.body.created as Array<{ id: string }>;
    expect((await specOf(a!.id)).requiredReading).toEqual(['SHARED.md']);
    const own = await specOf(b!.id);
    expect(own.requirementIds).toEqual(['OWN']);
    expect(own.requiredReading).toEqual([]); // replaced wholesale, never merged with the default
  });

  // "Accept a spec and return it" — a caller should not need a second round-trip per task to see
  // what its spec became, and normalisation is exactly the part it did not write.
  it('echoes the normalised spec back from create_task and update_task', async () => {
    const made = await mcpCall(agent.apiKey, 'create_task', {
      projectId,
      title: 'echoed',
      tags: ['exec-spec'],
      executionSpec: { anticipatedFiles: [{ path: 'src/a.ts' }] },
    });
    // `change` and `why` were defaulted in — the caller sent neither.
    expect(made.body.executionSpec.anticipatedFiles).toEqual([{ path: 'src/a.ts', change: 'modify', why: '' }]);

    const cleared = await mcpCall(agent.apiKey, 'update_task', {
      projectId, taskId: made.body.id, executionSpec: null,
    });
    expect(cleared.body.executionSpec).toBeNull();

    // A patch that never mentions the spec says nothing about it, rather than implying a change.
    const unrelated = await mcpCall(agent.apiKey, 'update_task', { projectId, taskId: made.body.id, title: 'x' });
    expect(unrelated.body).not.toHaveProperty('executionSpec');
  });

  // A malformed field is caught by the tool schema, which rejects the WHOLE call — so a bad spec
  // on the last item does not leave the earlier ones created. Distinct from the per-item errors
  // the description talks about (a bad ref, a rejected tag), which happen after validation.
  it('a bad spec on the last batch item creates none of them', async () => {
    const made = await mcpCall(agent.apiKey, 'create_tasks', {
      projectId,
      defaults: { tags: ['exec-spec'] },
      tasks: [
        { title: 'batch-atomic-first' },
        { title: 'batch-atomic-last', executionSpec: { anticipatedFiles: [{ path: '/etc/passwd' }] } },
      ],
    });
    expect(made.isError).toBe(true);
    const found = await mcpCall(agent.apiKey, 'search_tasks', { projectId, query: 'batch-atomic' });
    expect((found.body.tasks as Array<{ title: string }>).map((t) => t.title)).not.toContain('batch-atomic-first');
  });

  // The tool schema is the first gate — a bad path must not reach the DO at all.
  it('rejects a spec that reaches outside the repo, at the tool boundary', async () => {
    const bad = await mcpCall(agent.apiKey, 'create_task', {
      projectId,
      title: 'escapes',
      tags: ['exec-spec'],
      executionSpec: { anticipatedFiles: [{ path: '../../.ssh/id_rsa' }] },
    });
    expect(bad.isError).toBe(true);
  });

  // Agent-facing guidance lives in three overlapping places that drift silently (root CLAUDE.md).
  // An agent that never hears about the spec will never write one, whatever the schema allows.
  // The ticket's actual requirement: "tool descriptions must state what the spec is for — an
  // agent that cannot tell when to fill it in will not fill it in." `.describe()` on the FIELD
  // does not satisfy it on its own: until PLNR-549 the SDK converted our schemas with a
  // mismatched zod copy and dropped every field description, and the tool description is
  // still what an agent reads first. This asserts on what an agent actually receives.
  it('states what the spec is for in the tool descriptions an agent actually sees', async () => {
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agent.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': 'tools-list-probe',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const raw = await res.text();
    const listed = JSON.parse(raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())[0] ?? raw);
    const tools = new Map<string, { description: string; inputSchema: unknown }>(
      (listed.result.tools as Array<{ name: string; description: string; inputSchema: unknown }>).map((t) => [t.name, t]),
    );

    for (const name of ['create_tasks', 'update_tasks', 'create_plan']) {
      const d = tools.get(name)!.description;
      // Not just the word: what it is FOR, and when to write one.
      expect(d, name).toContain('executionSpec');
      expect(d, name).toContain('lockedDecisions');
      expect(d, name).toContain('observableTruths');
      expect(d, name).toMatch(/whenever you know more about the work than its title and body say/);
    }
    // The reading side says what to DO with one, which is a different instruction.
    const getTask = tools.get('get_task')!.description;
    expect(getTask).toContain('lockedDecisions bind you');
    expect(getTask).toContain('executionSpecUnreadable');
    // The bulk tool warns rather than forbids.
    expect(tools.get('update_tasks')!.description).toMatch(/same contract genuinely applies to every item/);
    // …and the field really is in the advertised schema, not merely described.
    expect(JSON.stringify(tools.get('create_tasks')!.inputSchema)).toContain('anticipatedFiles');
  });

  it('tells agents about the spec in all three guidance surfaces', async () => {
    // 1. the get_briefing playbook — what a working agent reads every session
    const briefing = await mcpCall(agent.apiKey, 'get_briefing', {});
    expect(JSON.stringify(briefing.body.playbook)).toContain('executionSpec');

    // 2. SKILL_MD — served at /skill.md, and not registered as an MCP resource, which is why it
    //    cannot simply point at the others
    const skill = await SELF.fetch('https://noriq.test/skill.md');
    const skillText = await skill.text();
    expect(skillText).toContain('executionSpec');
    expect(skillText).toContain('anticipatedFiles');

    // 3. the MCP `instructions` string, sent once on initialize
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agent.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'spec-test', version: '1' },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('executionSpec');
  });
});
