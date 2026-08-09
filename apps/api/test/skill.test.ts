// PLNR-310: the base skill split into a core entry point (SKILL_MD, served at /skill.md)
// plus on-demand references (file locks, planning, memory) — content MOVED out of the old
// single document, not rewritten. This file owns the general "does the split actually work
// end to end" concern: each reference is reachable both by its GET /skill/<slug>.md route and
// by its MCP resource URI, and the core stays useful standalone without inlining the full
// reference text (the same "points here, but does not inline it" shape doc-guide.test.ts
// already proves for the pre-existing doc-authoring skill).
import { SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, mcpRpc } from './helpers';
import { buildNoriqSkillArchive, noriqSkillFiles } from '../src/skill-archive';

let agent: { id: string; apiKey: string };

beforeAll(async () => {
  agent = await createAgent('skill-agent');
}, 60000);

const REFERENCES = [
  // `anchor` is each reference's frontmatter `name:` line — unique to that file, unlike its
  // markdown heading (e.g. "# Project memory" is a substring of core's own "## Project memory").
  { slug: 'file-locks', uri: 'noriq://skill/file-locks', anchor: 'name: noriq-file-locks' },
  { slug: 'planning', uri: 'noriq://skill/planning', anchor: 'name: noriq-planning' },
  { slug: 'memory', uri: 'noriq://skill/memory', anchor: 'name: noriq-memory' },
];

function readStoredZip(bytes: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 4 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const compression = view.getUint16(8, true);
    const size = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    expect(compression).toBe(0);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return entries;
}

describe('skill core (PLNR-310)', () => {
  it('stays useful standalone: states every topic and names each reference address', async () => {
    const res = await SELF.fetch('https://noriq.test/skill.md');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('get_briefing');
    expect(text).toContain('claim_task');
    expect(text).toContain('executionSpec');
    expect(text).toContain('anticipatedFiles');
    expect(text).toContain('Noriq is the channel of record');
    expect(text).toContain('focus_project');
    expect(text).toContain('get_task_context');
    expect(text).toMatch(/request_input[\s\S]+do not repeat the question in chat/i);
    expect(text).toMatch(/description:.*plan, implement, fix, review, investigate, continue/i);
    expect(text).toContain('noriq://skill/doc-authoring');
    for (const ref of REFERENCES) {
      expect(text).toContain(`GET /skill/${ref.slug}.md`);
      expect(text).toContain(ref.uri);
      // Points at the reference, but does not inline its full body — same shape as the
      // pre-existing doc-authoring split (doc-guide.test.ts).
      expect(text).not.toContain(ref.anchor);
    }
  });

  for (const ref of REFERENCES) {
    it(`${ref.slug} reference is served at GET /skill/${ref.slug}.md and as ${ref.uri}`, async () => {
      const res = await SELF.fetch(`https://noriq.test/skill/${ref.slug}.md`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/markdown');
      const routeText = await res.text();
      expect(routeText).toContain(ref.anchor);

      const r = (await mcpRpc(agent.apiKey, 'resources/read', { uri: ref.uri })) as {
        contents: Array<{ text: string; mimeType: string }>;
      };
      expect(r.contents[0]!.mimeType).toBe('text/markdown');
      expect(r.contents[0]!.text).toContain(ref.anchor);
      // Both addresses serve the identical text — one document, two ways in.
      expect(r.contents[0]!.text).toBe(routeText);
    });
  }

  it('serves the current core skill as a live MCP resource', async () => {
    const route = await (await SELF.fetch('https://noriq.test/skill.md')).text();
    const r = (await mcpRpc(agent.apiKey, 'resources/read', { uri: 'noriq://skill/core' })) as {
      contents: Array<{ text: string; mimeType: string }>;
    };
    expect(r.contents[0]!.mimeType).toBe('text/markdown');
    expect(r.contents[0]!.text).toBe(route);
  });

  it('builds and serves a deterministic installable archive that prefers live MCP guidance', async () => {
    expect(buildNoriqSkillArchive()).toEqual(buildNoriqSkillArchive());
    const canonical = await SELF.fetch('https://noriq.test/noriq.zip');
    const alias = await SELF.fetch('https://noriq.test/skill.zip');
    expect(canonical.status).toBe(200);
    expect(canonical.headers.get('Content-Type')).toBe('application/zip');
    expect(canonical.headers.get('Content-Disposition')).toContain('noriq.zip');
    expect(new Uint8Array(await alias.arrayBuffer())).toEqual(new Uint8Array(await canonical.clone().arrayBuffer()));

    const entries = readStoredZip(new Uint8Array(await canonical.arrayBuffer()));
    expect([...entries.keys()].sort()).toEqual(Object.keys(noriqSkillFiles()).sort());
    expect(entries.get('noriq/SKILL.md')).toContain('noriq://skill/core');
    expect(entries.get('noriq/SKILL.md')).toContain('live resource');
    expect(entries.get('noriq/README.md')).toMatch(/call\s+`get_briefing` first/);
    expect(entries.get('noriq/references/memory.md')).toContain('search_project_memory');
  });
});
