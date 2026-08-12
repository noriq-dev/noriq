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
    const doc = (await res.json()) as {
      serverInfo: { name: string; version: string };
      catalog: { valid: boolean; toolCount: number; findings: unknown[] };
      tools: Array<{ name: string; minimumProjectAction: string; annotations: Record<string, unknown>; inputSchema: any }>;
      resources: Array<{ minimumProjectAction: string }>;
    };
    expect(doc.serverInfo.name).toBe('noriq');
    expect(doc.catalog).toMatchObject({ valid: true, toolCount: 70, findings: [] });
    const claim = doc.tools.find((t) => t.name === 'claim_task');
    expect(claim).toBeTruthy();
    expect(claim!.minimumProjectAction).toBe('contribute');
    expect(claim!.annotations.openWorldHint).toBe(false);
    expect(claim!.inputSchema.properties.taskId.type).toBe('string');
    expect(doc.resources.length).toBeGreaterThanOrEqual(1);
    expect(doc.resources.every((r) => r.minimumProjectAction === 'view')).toBe(true);
  });
});
