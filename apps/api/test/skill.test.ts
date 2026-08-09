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

describe('skill core (PLNR-310)', () => {
  it('stays useful standalone: states every topic and names each reference address', async () => {
    const res = await SELF.fetch('https://noriq.test/skill.md');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('get_briefing');
    expect(text).toContain('claim_task');
    expect(text).toContain('executionSpec');
    expect(text).toContain('anticipatedFiles');
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
});
