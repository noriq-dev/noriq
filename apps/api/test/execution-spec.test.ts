// RUN-134: the execution spec — what a task tells a builder before it is allowed to spend
// anything. Pure schema, so this is a plain unit test with no worker, no DO, no D1.
//
// The schema and nothing else: nothing carries a spec yet (a task field is RUN-135, the MCP
// surface RUN-136), so these tests exercise the shape, not an end-to-end dispatch.
//
// Two properties the rest of the plan rests on: every field is optional (a spec filled in halfway
// is valid), and "present but empty" is distinguishable from "someone filled this in" — which is
// what decides whether the planner stage has work to do.
import { describe, expect, it } from 'vitest';
import {
  AnticipatedFile,
  ExecutionSpec,
  ExpectedArtifact,
  RepoPath,
  emptyExecutionSpec,
  hasExecutionSpec,
} from '@noriq-dev/shared';

describe('ExecutionSpec — the empty shape', () => {
  it('parses {} into every field, empty', () => {
    expect(ExecutionSpec.parse({})).toEqual({
      requirementIds: [],
      anticipatedFiles: [],
      requiredReading: [],
      lockedDecisions: [],
      discretion: [],
      deferred: [],
      acceptance: { observableTruths: [], artifacts: [], links: [] },
    });
  });

  it('emptyExecutionSpec() is that value, with every collection freshly allocated', () => {
    const a = emptyExecutionSpec();
    const b = emptyExecutionSpec();
    expect(a).toEqual(ExecutionSpec.parse({}));
    // A shared mutable default is how one task's spec ends up carrying another's anticipated
    // files. Check the NESTED collections too — the object and its arrays are separate defaults,
    // and a singleton `acceptance` would leak just as thoroughly as a singleton root.
    expect(a).not.toBe(b);
    expect(a.anticipatedFiles).not.toBe(b.anticipatedFiles);
    expect(a.requirementIds).not.toBe(b.requirementIds);
    expect(a.acceptance).not.toBe(b.acceptance);
    expect(a.acceptance.artifacts).not.toBe(b.acceptance.artifacts);
    expect(a.acceptance.links).not.toBe(b.acceptance.links);
  });

  // Half a spec is a valid spec — a planner fills what it can and the checker (RUN-141) judges
  // the result; rejecting an incomplete one here would move that judgement into zod.
  it('accepts a partially filled spec without demanding the rest', () => {
    const spec = ExecutionSpec.parse({ requiredReading: ['THREAT-MODEL.md'] });
    expect(spec.requiredReading).toEqual(['THREAT-MODEL.md']);
    expect(spec.anticipatedFiles).toEqual([]);
    expect(spec.acceptance.observableTruths).toEqual([]);
  });

  // `undefined` is not a spec. Reading a nullable field means `spec ?? emptyExecutionSpec()`, not
  // handing nothing to the parser and hoping.
  it('does not treat undefined as the empty spec', () => {
    expect(ExecutionSpec.safeParse(undefined).success).toBe(false);
  });
});

describe('ExecutionSpec — the full shape', () => {
  const full = {
    requirementIds: ['RUN-134', 'PLNR-223'],
    anticipatedFiles: [
      { path: 'packages/shared/src/execution-spec.ts', change: 'create', why: 'the schema itself' },
      { path: 'packages/shared/src/index.ts' },
    ],
    requiredReading: ['doc_ms2frj9q4o1e6e236r21', 'packages/shared/src/manifest.ts'],
    lockedDecisions: [
      {
        decision: 'the spec lives in the server contract, not the runner',
        because: 'a runner-local copy would be a second source of truth',
        source: 'doc_ms2frj9q4o1e6e236r21',
      },
      { decision: 'every field is optional' },
    ],
    discretion: ['how the fields are named'],
    deferred: ['the dashboard editor (RUN-137)'],
    acceptance: {
      observableTruths: ['a task with no spec still dispatches'],
      artifacts: [
        {
          path: 'packages/shared/src/execution-spec.ts',
          provides: 'the ExecutionSpec zod schema',
          exports: ['ExecutionSpec', 'hasExecutionSpec'],
        },
        { path: 'packages/shared/src/index.ts' },
      ],
      links: [
        { from: 'packages/shared/src/index.ts', to: './execution-spec', via: 'export *' },
        { from: 'a', to: 'b' },
      ],
    },
  };

  it('round-trips every field, applying each nested default to what was left out', () => {
    expect(ExecutionSpec.parse(full)).toEqual({
      requirementIds: ['RUN-134', 'PLNR-223'],
      anticipatedFiles: [
        { path: 'packages/shared/src/execution-spec.ts', change: 'create', why: 'the schema itself' },
        { path: 'packages/shared/src/index.ts', change: 'modify', why: '' },
      ],
      requiredReading: ['doc_ms2frj9q4o1e6e236r21', 'packages/shared/src/manifest.ts'],
      lockedDecisions: [
        {
          decision: 'the spec lives in the server contract, not the runner',
          because: 'a runner-local copy would be a second source of truth',
          source: 'doc_ms2frj9q4o1e6e236r21',
        },
        { decision: 'every field is optional', because: '', source: '' },
      ],
      discretion: ['how the fields are named'],
      deferred: ['the dashboard editor (RUN-137)'],
      acceptance: {
        observableTruths: ['a task with no spec still dispatches'],
        artifacts: [
          {
            path: 'packages/shared/src/execution-spec.ts',
            provides: 'the ExecutionSpec zod schema',
            exports: ['ExecutionSpec', 'hasExecutionSpec'],
          },
          { path: 'packages/shared/src/index.ts', provides: '', exports: [] },
        ],
        links: [
          { from: 'packages/shared/src/index.ts', to: './execution-spec', via: 'export *' },
          { from: 'a', to: 'b', via: '' },
        ],
      },
    });
  });

  // Orientation only — nothing branches on it today. `modify` is the default because it is both
  // the common case and the conservative one.
  it('defaults a file with no declared change to modify, and refuses an unknown one', () => {
    expect(AnticipatedFile.parse({ path: 'src/a.ts' }).change).toBe('modify');
    expect(() => AnticipatedFile.parse({ path: 'src/a.ts', change: 'refactor' })).toThrow();
    // A rename is two paths and this carries one — say it as a delete plus a create.
    expect(() => AnticipatedFile.parse({ path: 'src/a.ts', change: 'rename' })).toThrow();
  });
});

describe('hasExecutionSpec separates "nobody planned this" from "planned, and it is small"', () => {
  it('is false for null, undefined, and the empty spec', () => {
    expect(hasExecutionSpec(null)).toBe(false);
    expect(hasExecutionSpec(undefined)).toBe(false);
    expect(hasExecutionSpec(emptyExecutionSpec())).toBe(false);
  });

  // Every field on its own is enough — a spec that says only "read this first" was still written
  // by someone, and re-planning it would discard what they said.
  it.each([
    ['requirementIds', { requirementIds: ['RUN-1'] }],
    ['anticipatedFiles', { anticipatedFiles: [{ path: 'src/a.ts' }] }],
    ['requiredReading', { requiredReading: ['README.md'] }],
    ['lockedDecisions', { lockedDecisions: [{ decision: 'ESM only' }] }],
    ['discretion', { discretion: ['naming'] }],
    ['deferred', { deferred: ['the CLI flag'] }],
    ['acceptance.observableTruths', { acceptance: { observableTruths: ['it builds'] } }],
    ['acceptance.artifacts', { acceptance: { artifacts: [{ path: 'src/a.ts' }] } }],
    ['acceptance.links', { acceptance: { links: [{ from: 'a', to: 'b' }] } }],
  ])('is true when only %s is filled in', (_field, input) => {
    expect(hasExecutionSpec(ExecutionSpec.parse(input))).toBe(true);
  });

  // The list above must stay exhaustive, and the `satisfies` map in the schema is what makes a
  // forgotten field a type error rather than a wrong answer. This is the runtime half: if a field
  // is added and no case above covers it, the count diverges and this fails.
  it('covers every top-level field of the schema', () => {
    expect(Object.keys(emptyExecutionSpec()).sort()).toEqual([
      'acceptance',
      'anticipatedFiles',
      'deferred',
      'discretion',
      'lockedDecisions',
      'requiredReading',
      'requirementIds',
    ]);
  });
});

// Well-formedness, NOT a boundary: the daemon resolves against the worktree root and verifies
// containment on the opened descriptor (RUN-151). This keeps shapes that could never be right in
// a committed cross-platform contract from being stored in the first place.
describe('RepoPath insists on a git-style relative path', () => {
  it.each([
    ['a posix absolute path', '/etc/passwd'],
    ['a drive letter', 'C:/Windows/system32'],
    ['a backslashed drive letter', 'C:\\Windows\\system32'],
    ['a backslash-rooted path', '\\rooted\\file'],
    ['a UNC share', '\\\\server\\share'],
    ['a windows device path', '\\\\?\\C:\\x'],
    ['a windows-spelled relative path', 'src\\a.ts'],
    ['parent traversal', '../../.ssh/id_rsa'],
    ['traversal mid-path', 'src/../../secrets'],
    ['a bare ..', '..'],
    ['a trailing ..', 'src/..'],
    ['blank', '   '],
    ['empty', ''],
  ])('rejects %s', (_why, p) => {
    expect(RepoPath.safeParse(p).success).toBe(false);
  });

  it.each([
    'src/a.ts',
    'a.ts',
    'deep/nested/path/file.test.ts',
    'src/..hidden/x.ts', // four dots and a name are a filename, not a traversal
    '.noriq/project.toml',
  ])('accepts %s', (p) => {
    expect(RepoPath.safeParse(p).success).toBe(true);
  });

  it('applies wherever a repo path appears, not just in isolation', () => {
    expect(() => AnticipatedFile.parse({ path: '../outside.ts' })).toThrow();
    expect(() => ExpectedArtifact.parse({ path: '/abs.ts' })).toThrow();
    expect(ExecutionSpec.safeParse({ anticipatedFiles: [{ path: '../x' }] }).success).toBe(false);
    expect(ExecutionSpec.safeParse({ acceptance: { artifacts: [{ path: 'C:/x' }] } }).success).toBe(false);
  });
});
