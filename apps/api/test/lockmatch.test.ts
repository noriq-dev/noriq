// PLNR-204: the file-lock path engine (lib/lockmatch.ts). Pure — no DO. Two things matter:
//   1. normalization + kind classification (§2), and the concrete examples from the design doc (§3).
//   2. SOUNDNESS: patternsOverlap may over-lock (false conflict) but must NEVER under-lock. The fuzz
//      block is the mandated soundness oracle — if a concrete path matches BOTH patterns, the engine
//      must report them overlapping. Under-locking would let two agents clobber a file.
import { describe, expect, it } from 'vitest';
import {
  normalizePattern, patternsOverlap, matchesPath, matchSegment, branchScopesOverlap, LockPatternError,
} from '../src/lib/lockmatch';

const P = (s: string) => normalizePattern(s);
const overlap = (a: string, b: string) => patternsOverlap(P(a), P(b));

describe('normalizePattern (§2)', () => {
  it('classifies file / dir / glob', () => {
    expect(P('src/index.ts').kind).toBe('file');
    expect(P('src/').kind).toBe('dir');
    expect(P('src/**/*.ts').kind).toBe('glob');
    expect(P('*.ts').kind).toBe('glob');
  });
  it('canonicalizes: backslashes, ./, //, trailing slash, NFC', () => {
    expect(P('src\\a\\b.ts').canon).toBe('src/a/b.ts');
    expect(P('./src//a.ts').canon).toBe('src/a.ts');
    expect(P('src/sub/').canon).toBe('src/sub'); // trailing slash stripped, kind=dir
    expect(P('src/sub/').dir).toBe(true);
  });
  it('rejects absolute / .. / empty / NUL', () => {
    expect(() => P('/etc/passwd')).toThrow(LockPatternError);
    expect(() => P('../secrets')).toThrow(LockPatternError);
    expect(() => P('a/../b')).toThrow(LockPatternError);
    expect(() => P('   ')).toThrow(LockPatternError);
    expect(() => P('a\0b')).toThrow(LockPatternError);
  });
  it('rejects unbalanced glob syntax', () => {
    expect(() => P('src/[abc.ts')).toThrow(LockPatternError);
    expect(() => P('src/{a,b.ts')).toThrow(LockPatternError);
  });
});

describe('patternsOverlap — the doc examples (§3)', () => {
  it('exact same → overlap; sibling files → disjoint', () => {
    expect(overlap('src/a.ts', 'src/a.ts')).toBe(true);
    expect(overlap('src/a.ts', 'src/b.ts')).toBe(false);
  });
  it('dir covers node + descendants, component-boundary aware', () => {
    expect(overlap('src/', 'src/a.ts')).toBe(true); // descendant
    expect(overlap('src/', 'src')).toBe(true); // the node itself (dir vs exact file)
    expect(overlap('foo/', 'foobar')).toBe(false); // NOT a prefix-string match
    expect(overlap('src/', 'lib/a.ts')).toBe(false);
  });
  it('dir vs glob with no shared literal prefix', () => {
    expect(overlap('src/', '*/index.ts')).toBe(true); // */index.ts can be src/index.ts
    expect(overlap('src/', 'lib/*.ts')).toBe(false);
  });
  it('the wins over bare literal-prefix', () => {
    expect(overlap('src/**/*.ts', 'src/**/*.md')).toBe(false);
    expect(overlap('src/a/**', 'src/b/**')).toBe(false);
    expect(overlap('src/**/*.ts', 'src/**/*.ts')).toBe(true);
  });
  it('leading ** anchored by a fixed suffix', () => {
    expect(overlap('**/*.ts', 'src/foo.ts')).toBe(true);
    expect(overlap('**/*.ts', 'src/foo.md')).toBe(false);
    expect(overlap('**/foo.ts', '**/foo.md')).toBe(false);
  });
  it('single-segment glob suffix/prefix disjointness', () => {
    expect(overlap('*.ts', '*.md')).toBe(false);
    expect(overlap('*.ts', 'foo.ts')).toBe(true);
    expect(overlap('foo*', 'bar*')).toBe(false);
    expect(overlap('foo*', '*bar')).toBe(true); // foobar matches both
  });
  it('braces', () => {
    expect(overlap('{src,test}/**', 'docs/**')).toBe(false);
    expect(overlap('{src,test}/**', 'src/a.ts')).toBe(true);
  });
  it('is symmetric on the examples', () => {
    for (const [a, b] of [['src/', 'src/a.ts'], ['src/**/*.ts', 'src/**/*.md'], ['**/*.ts', 'src/foo.md']] as const) {
      expect(patternsOverlap(P(a), P(b))).toBe(patternsOverlap(P(b), P(a)));
    }
  });
});

describe('matchesPath (reference matcher)', () => {
  it('handles file / dir / glob / **', () => {
    expect(matchesPath(P('src/a.ts'), 'src/a.ts')).toBe(true);
    expect(matchesPath(P('src/a.ts'), 'src/b.ts')).toBe(false);
    expect(matchesPath(P('src/'), 'src/deep/a.ts')).toBe(true);
    expect(matchesPath(P('src/'), 'src')).toBe(true);
    expect(matchesPath(P('foo/'), 'foobar')).toBe(false);
    expect(matchesPath(P('src/**/*.ts'), 'src/a/b/c.ts')).toBe(true);
    expect(matchesPath(P('src/**/*.ts'), 'src/a/b/c.md')).toBe(false);
    expect(matchesPath(P('**/*.ts'), 'a.ts')).toBe(true);
    expect(matchesPath(P('*.ts'), 'a/b.ts')).toBe(false); // * stays within a segment
  });
});

describe('branchScopesOverlap (§4)', () => {
  const S = (branch: string | null, allBranches = branch === null) => ({ branch, allBranches });
  it('same branch overlaps; different branches do not; all-branches overlaps everything', () => {
    expect(branchScopesOverlap(S('main'), S('main'))).toBe(true);
    expect(branchScopesOverlap(S('main'), S('dev'))).toBe(false);
    expect(branchScopesOverlap(S(null, true), S('dev'))).toBe(true);
    expect(branchScopesOverlap(S('dev'), S(null, true))).toBe(true);
    expect(branchScopesOverlap(S(null, true), S(null, true))).toBe(true);
  });
});

describe('matcher is total + bounded (Codex review — no regex backtracking / throws)', () => {
  it('a star-heavy brace alternative matches linearly, never hangs', () => {
    const glob = `{${'a*'.repeat(20)}b}`; // one alternative, 20 stars — regex would backtrack catastrophically
    const t0 = Date.now();
    expect(matchSegment(glob, `${'a'.repeat(60)}c`)).toBe(false); // no trailing b → no match
    expect(matchSegment(glob, `${'a'.repeat(60)}b`)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000); // linear, not exponential
  });
  it('glob metachars inside braces keep glob semantics, and never throw', () => {
    expect(matchSegment('{*,a}', 'anything')).toBe(true); // '*' alternative
    expect(matchSegment('{*,a}', 'a')).toBe(true);
    expect(() => matchSegment('{*,a}', 'x')).not.toThrow();
  });
  it('degenerate char classes are literal, never throw', () => {
    expect(matchSegment('[z-a]', '-')).toBe(true); // descending range → literal z, -, a
    expect(matchSegment('[z-a]', 'z')).toBe(true);
    expect(matchSegment('[z-a]', 'b')).toBe(false);
    expect(matchSegment('[!a]', 'b')).toBe(true); // negation
    expect(matchSegment('[!a]', 'a')).toBe(false);
  });
  it('normalize rejects a brace pattern that would explode past the budget', () => {
    expect(() => normalizePattern(`${'{a,b}'.repeat(8)}.ts`)).toThrow(LockPatternError); // 2^8 = 256 > 64
    expect(normalizePattern('{a,b,c}/x.ts').kind).toBe('glob'); // a small one is fine
  });
});

// --- SOUNDNESS FUZZ: over-locking allowed, under-locking is a bug ---------------------------
describe('patternsOverlap soundness (fuzz)', () => {
  const rng = (seed: number) => {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  };
  const PATTERN_SEGS = ['a', 'b', 'sub', 'x.ts', 'x.md', '*', '*.ts', '*.md', '**', '?', 'f?o'];
  const PATH_SEGS = ['a', 'b', 'sub', 'x.ts', 'x.md', 'y.ts', 'foo', 'fno'];

  const pick = <T,>(r: () => number, arr: T[]) => arr[Math.floor(r() * arr.length)]!;
  const genPattern = (r: () => number): ReturnType<typeof normalizePattern> | null => {
    const n = 1 + Math.floor(r() * 4);
    const segs = Array.from({ length: n }, () => pick(r, PATTERN_SEGS));
    const s = segs.join('/') + (r() < 0.25 ? '/' : '');
    try { return normalizePattern(s); } catch { return null; }
  };
  const genPath = (r: () => number) =>
    Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, PATH_SEGS)).join('/');

  it('never reports disjoint when a concrete witness matches both patterns', () => {
    const r = rng(0xC0FFEE);
    let checked = 0;
    let witnessed = 0;
    for (let t = 0; t < 4000; t++) {
      const a = genPattern(r);
      const b = genPattern(r);
      if (!a || !b) continue;
      checked++;
      const claimedDisjoint = !patternsOverlap(a, b);
      if (!claimedDisjoint) continue; // over-lock is always allowed
      // The engine claims disjoint — PROVE it by finding no common witness among random paths.
      for (let k = 0; k < 24; k++) {
        const p = genPath(r);
        if (matchesPath(a, p) && matchesPath(b, p)) {
          witnessed++;
          throw new Error(`UNSOUND: "${a.raw}" ∩ "${b.raw}" claimed disjoint but "${p}" matches both`);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(witnessed).toBe(0);
  });
});
