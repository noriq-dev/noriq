// PLNR-23: the generated MCP reference must list the real tools/resources.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('MCP tool reference', () => {
  it('/reference.md lists tools, params, and resources', async () => {
    const res = await SELF.fetch('https://noriq.test/reference.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    const md = await res.text();
    // Core tools present.
    for (const t of ['get_briefing', 'claim_task', 'release_task', 'add_attachment', 'create_plan']) {
      expect(md).toContain(`\`${t}\``);
    }
    // Params rendered from the zod schema (required/optional flags, types).
    expect(md).toMatch(/`projectId` \*\*string\*\* \(required\)/);
    expect(md).toMatch(/\(optional\)/);
    // The attachment resource template.
    expect(md).toContain('noriq://attachment/{id}');
  });

  it('/reference.json exposes JSON Schema per tool', async () => {
    const res = await SELF.fetch('https://noriq.test/reference.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { tools: Array<{ name: string; inputSchema: any }>; resources: unknown[] };
    const claim = doc.tools.find((t) => t.name === 'claim_task');
    expect(claim).toBeTruthy();
    expect(claim!.inputSchema.properties.taskId.type).toBe('string');
    expect(doc.resources.length).toBeGreaterThanOrEqual(1);
  });
});
