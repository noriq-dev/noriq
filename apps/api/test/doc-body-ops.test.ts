import { describe, expect, it } from 'vitest';
import {
  applyDocPatches,
  buildSegmentMap,
  decodeGrepDocsCursor,
  DocBodyError,
  encodeGrepDocsCursor,
  grepDocBody,
  hashDocBody,
  parseMarkdownOutline,
  resolveDocWriteBody,
  sliceBySection,
  sliceDocByLines,
} from '../src/lib/doc-body-ops';

const SAMPLE = `# Architecture

Intro paragraph.

## Storage

Storage overview.

### D1

D1 details with a unique token ALPHA.

### R2

R2 details.

## Auth

Auth overview.

\`\`\`
# Not a heading
## Also not
\`\`\`

## Storage

Ambiguous title peer.
`;

describe('parseMarkdownOutline', () => {
  it('builds nested paths and skips fenced # headings', () => {
    const outline = parseMarkdownOutline(SAMPLE);
    expect(outline.map((h) => h.path)).toEqual([
      'Architecture',
      'Architecture / Storage',
      'Architecture / Storage / D1',
      'Architecture / Storage / R2',
      'Architecture / Auth',
      'Architecture / Storage',
    ]);
    expect(outline.some((h) => h.title === 'Not a heading')).toBe(false);
    const d1 = outline.find((h) => h.path === 'Architecture / Storage / D1')!;
    expect(d1.level).toBe(3);
    expect(d1.startLine).toBeLessThan(d1.endLine);
    expect(d1.childCount).toBe(0);
    const storage = outline.find((h) => h.path === 'Architecture / Storage' && h.startLine < d1.startLine)!;
    expect(storage.childCount).toBe(2);
  });
});

describe('sliceBySection', () => {
  it('slices by path and by unique title', () => {
    const byPath = sliceBySection(SAMPLE, { path: 'Architecture / Storage / D1' });
    expect(byPath.body).toContain('ALPHA');
    expect(byPath.body).not.toContain('R2 details');
    expect(byPath.selection.mode).toBe('section');

    const byTitle = sliceBySection(SAMPLE, { title: 'Auth' });
    expect(byTitle.body).toContain('Auth overview');
    expect(byTitle.path).toBe('Architecture / Auth');
  });

  it('rejects ambiguous titles with candidates', () => {
    expect(() => sliceBySection(SAMPLE, { title: 'Storage' })).toThrow(DocBodyError);
    try {
      sliceBySection(SAMPLE, { title: 'Storage' });
    } catch (err) {
      expect(err).toBeInstanceOf(DocBodyError);
      expect((err as DocBodyError).code).toBe('section_ambiguous');
      expect((err as DocBodyError).details?.candidates).toEqual(expect.arrayContaining([
        'Architecture / Storage',
      ]));
    }
  });

  it('honors depth 0 (stop before any nested heading)', () => {
    const unique = `# Solo\n\n## Only\n\nOnly overview.\n\n### Child\n\nChild body.\n`;
    const depth0 = sliceBySection(unique, { path: 'Solo / Only' }, 0);
    expect(depth0.body).toContain('Only overview');
    expect(depth0.body).not.toContain('Child body');
    const full = sliceBySection(unique, { path: 'Solo / Only' });
    expect(full.body).toContain('Child body');
  });
});

describe('sliceDocByLines + segments', () => {
  it('marks included segments on partial reads', () => {
    const sliced = sliceDocByLines(SAMPLE, 8, 12);
    const segments = buildSegmentMap(SAMPLE, { startLine: sliced.startLine, endLine: sliced.endLine });
    expect(segments.some((s) => s.included)).toBe(true);
    expect(segments.some((s) => !s.included)).toBe(true);
  });
});

describe('applyDocPatches + resolveDocWriteBody', () => {
  it('applies unique oldText and rejects 0/>1 matches', () => {
    const next = applyDocPatches(SAMPLE, [{ oldText: 'unique token ALPHA', newText: 'unique token BETA' }]);
    expect(next).toContain('BETA');
    expect(next).not.toContain('ALPHA');
    expect(() => applyDocPatches(SAMPLE, [{ oldText: 'nope', newText: 'x' }])).toThrow(/not found/);
    expect(() => applyDocPatches(SAMPLE, [{ oldText: 'Storage', newText: 'Store' }])).toThrow(/matches/);
  });

  it('occurrence selects among multiple matches', () => {
    const body = 'aaa xxx aaa';
    expect(applyDocPatches(body, [{ oldText: 'aaa', newText: 'bbb', occurrence: 2 }])).toBe('aaa xxx bbb');
  });

  it('append and replace modes', () => {
    expect(resolveDocWriteBody({ mode: 'append', body: '\nmore', currentBody: 'base' }).nextBody).toBe('base\nmore');
    expect(resolveDocWriteBody({ mode: 'replace', body: 'new', currentBody: 'old' }).nextBody).toBe('new');
  });
});

describe('grepDocBody', () => {
  it('returns enclosing section ranges', () => {
    const hits = grepDocBody('doc_1', SAMPLE, 'ALPHA');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe('Architecture / Storage / D1');
    expect(hits[0]!.startLine).toBeLessThanOrEqual(hits[0]!.line);
    expect(hits[0]!.endLine).toBeGreaterThanOrEqual(hits[0]!.line);
  });

  it('treats pattern as literal substring (ReDoS-safe)', () => {
    const body = `${'a'.repeat(27)}!\nsettled ALPHA line\n`;
    const t0 = Date.now();
    const hits = grepDocBody('doc_redos', body, '(a+)+$');
    expect(Date.now() - t0).toBeLessThan(50);
    expect(hits).toHaveLength(0);
    expect(grepDocBody('doc_redos', body, 'ALPHA')).toHaveLength(1);
    // Regex metacharacters match literally, not as operators.
    expect(grepDocBody('doc_meta', 'cost is $5.00\n', '$5')).toHaveLength(1);
  });
});

describe('grep docs cursor', () => {
  it('round-trips updatedAt + id', () => {
    const enc = encodeGrepDocsCursor('2026-11-03T12:00:00.000Z', 'doc_abc');
    expect(decodeGrepDocsCursor(enc)).toEqual({
      updatedAt: '2026-11-03T12:00:00.000Z',
      id: 'doc_abc',
    });
    expect(decodeGrepDocsCursor('not-a-cursor')).toBeNull();
  });
});

describe('hashDocBody', () => {
  it('is stable sha-256 hex', async () => {
    const a = await hashDocBody('hello');
    const b = await hashDocBody('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
