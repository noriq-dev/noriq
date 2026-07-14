// PLNR-88: MCP tools carry proper annotations (read-only vs write, non-destructive,
// idempotent where true, closed-world) instead of the spec defaults (write +
// destructive + open-world) for everything.
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgent, mcpList } from './helpers';

type Hints = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
type Tool = { name: string; annotations?: Hints };

let agent: { id: string; apiKey: string };
beforeAll(async () => {
  agent = await createAgent('annot-agent');
}, 60000);

describe('MCP tool annotations (PLNR-88)', () => {
  it('reads are read-only, writes are non-destructive, nothing is open-world', async () => {
    const tools = (await mcpList(agent.apiKey)) as Tool[];
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));

    // Every tool is annotated and closed-world (operates on this system, not the internet).
    for (const t of tools) {
      expect(t.annotations, `${t.name} is missing annotations`).toBeTruthy();
      expect(t.annotations!.openWorldHint, `${t.name} openWorldHint`).toBe(false);
    }
    for (const r of ['get_briefing', 'my_updates', 'list_projects', 'get_project', 'get_task', 'next_claimable', 'read_open_comments', 'get_plans']) {
      expect(by[r]?.readOnlyHint, r).toBe(true);
    }
    // Writes are not read-only and not destructive (no MCP tool deletes data).
    for (const w of ['create_task', 'create_project', 'claim_task', 'release_task', 'add_comment', 'request_input', 'raise_alert']) {
      expect(by[w]?.readOnlyHint, w).toBe(false);
      expect(by[w]?.destructiveHint, w).toBe(false);
    }
    // Idempotent writes are flagged as such.
    for (const i of ['heartbeat', 'update_task', 'update_plan', 'set_agent_identity', 'add_dependency', 'attach_ref']) {
      expect(by[i]?.readOnlyHint, i).toBe(false);
      expect(by[i]?.idempotentHint, i).toBe(true);
    }
  });
});
