// The vendored-contract guarantees (PLNR-238/242): the runner vendors this schema, so the
// promises "v1 parses byte-identically" and "new sections are optional" are load-bearing —
// an older daemon's manifest must never be rejected by a newer schema. Pinned HERE, at the
// source, because the runner's copy is a snapshot: a regression caught only by the runner's
// tests is caught after the contract already shipped broken.
import { describe, expect, it } from 'vitest';
import { ProjectManifest, SetupSpec, WorkflowDef } from '@noriq-dev/shared';

describe('WorkflowDef v2 contract (PLNR-238)', () => {
  it('parses a v1 declaration byte-identically', () => {
    const v1 = WorkflowDef.parse({ base: 'scope', prompt: 'explore the docs tree' });
    expect(v1).toEqual({
      base: 'scope',
      prompt: 'explore the docs tree',
      stages: null,
      description: null,
    });
    // bare-minimum v1: base only
    expect(WorkflowDef.parse({ base: 'build' }).prompt).toBeNull();
  });

  it('accepts prompt-by-file', () => {
    const wf = WorkflowDef.parse({ base: 'build', prompt: { file: 'plan.md' } });
    expect(wf.prompt).toEqual({ file: 'plan.md' });
  });

  it('accepts stages as a bare name list', () => {
    const wf = WorkflowDef.parse({ base: 'build', stages: ['plan', 'plan-check', 'execute'] });
    expect(wf.stages).toEqual(['plan', 'plan-check', 'execute']);
  });

  it('accepts stages as a table with per-stage agent coordinates', () => {
    const wf = WorkflowDef.parse({
      base: 'build',
      stages: {
        'plan': {},
        'plan-check': { agent: 'claude.fable-5.high' },
      },
    });
    expect(wf.stages).toEqual({
      'plan': { agent: null },
      'plan-check': { agent: 'claude.fable-5.high' },
    });
  });

  it('tolerates unknown keys (forward-compat, non-strict)', () => {
    expect(() => WorkflowDef.parse({ base: 'verify', futureKnob: true })).not.toThrow();
  });
});

describe('manifest [setup] contract (PLNR-242)', () => {
  it('is optional — a manifest without it parses unchanged', () => {
    const m = ProjectManifest.parse({ key: 'PLNR' });
    expect(m.setup).toBeNull();
  });

  it('carries ordered cmds with a per-command timeout default', () => {
    const s = SetupSpec.parse({ cmds: ['npm install', 'npm run codegen'] });
    expect(s.cmds).toEqual(['npm install', 'npm run codegen']);
    expect(s.timeoutSeconds).toBe(600);
  });

  it('rejects an empty command string', () => {
    expect(() => SetupSpec.parse({ cmds: [''] })).toThrow();
  });
});

describe('ProjectManifest end-to-end with v2 workflows', () => {
  it('parses a full modern manifest', () => {
    const m = ProjectManifest.parse({
      key: 'RUN',
      setup: { cmds: ['npm ci'] },
      workflows: {
        docs: { base: 'scope', prompt: 'document the subsystem' }, // v1 form survives beside v2
        feature: {
          base: 'build',
          prompt: { file: 'feature.md' },
          stages: { review: { agent: 'codex.gpt-5_6-sol.high' } },
          description: 'build with a codex adversary',
        },
      },
    });
    expect(m.workflows.docs!.stages).toBeNull();
    expect(m.workflows.feature!.description).toBe('build with a codex adversary');
  });
});
