// PLNR-244: shared Project Memory entities, stable URIs, and wire contracts — the shape and
// nothing else. No ProjectMemory DO, no D1 registry, no MCP tool exists yet; these are plain
// unit tests over @noriq-dev/shared's zod schemas.
import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_HUMAN_APPROVED,
  AUTHORITY_HYPOTHESIS,
  BaseId,
  ContextPack,
  EffortEpisode,
  EntityRef,
  EvidenceRef,
  IndexGenerationManifest,
  IndexSpec,
  MemoryBackupManifest,
  MemoryEdge,
  MemoryItem,
  MemoryNode,
  ProjectManifest,
  RepositoryKey,
  RunnerCheckoutId,
  buildEntityUri,
  parseEntityUri,
} from '@noriq-dev/shared';

describe('BaseId — opaque across VCS backends (§6)', () => {
  it('accepts a Git SHA, a Perforce changelist number, and a Diversion id identically', () => {
    expect(BaseId.parse('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')).toBe(
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    );
    expect(BaseId.parse('12345')).toBe('12345');
    expect(BaseId.parse('dv-9f3a-001')).toBe('dv-9f3a-001');
  });

  it('rejects only emptiness, never a shape — no schema treats it as hex', () => {
    expect(() => BaseId.parse('')).toThrow();
  });
});

describe('RepositoryKey vs RunnerCheckoutId (§6, §16)', () => {
  it('a canonical repository key parses', () => {
    expect(RepositoryKey.parse('noriq-web')).toBe('noriq-web');
  });

  it('rejects a runner-local checkout id even though it is a plain string', () => {
    expect(() => RepositoryKey.parse('ckt_a1b2c3')).toThrow();
  });

  it('RunnerCheckoutId rejects a canonical repository key\'s shape', () => {
    expect(() => RunnerCheckoutId.parse('noriq-web')).toThrow();
    expect(RunnerCheckoutId.parse('ckt_a1b2c3')).toBe('ckt_a1b2c3');
  });
});

describe('EvidenceRef round-trips (§1)', () => {
  it('parses a full citation', () => {
    const ev = EvidenceRef.parse({
      repositoryKey: 'noriq-web',
      branch: 'main',
      baseId: 'a1b2c3',
      path: 'apps/api/src/mcp.ts',
      symbol: 'buildMcpServer',
      contentHash: 'sha256:deadbeef',
      verificationState: 'valid',
    });
    expect(ev).toEqual({
      repositoryKey: 'noriq-web',
      branch: 'main',
      baseId: 'a1b2c3',
      path: 'apps/api/src/mcp.ts',
      symbol: 'buildMcpServer',
      contentHash: 'sha256:deadbeef',
      verificationState: 'valid',
    });
  });

  it('defaults symbol/contentHash to null and verificationState to unverifiable', () => {
    const ev = EvidenceRef.parse({
      repositoryKey: 'noriq-web',
      branch: 'main',
      baseId: 'a1b2c3',
      path: 'README.md',
    });
    expect(ev.symbol).toBeNull();
    expect(ev.contentHash).toBeNull();
    expect(ev.verificationState).toBe('unverifiable');
  });
});

describe('MemoryItem — the one kind-driven recording surface (§11)', () => {
  it('round-trips a representative record for every kind', () => {
    for (const kind of [
      'learning',
      'decision',
      'failed_approach',
      'procedure',
      'requirement',
      'hazard',
      'unknown',
    ] as const) {
      const item = MemoryItem.parse({
        id: 'mem_1',
        projectId: 'prj_plnr',
        kind,
        statement: 'the retriever verifies evidence before presenting a memory',
        authority: AUTHORITY_HYPOTHESIS,
        evidence: [],
        recordedAt: '2026-08-06T00:00:00.000Z',
      });
      expect(item.kind).toBe(kind);
    }
  });

  it('authority defaults to the lowest tier (hypothesis) — nothing is trusted by default', () => {
    const item = MemoryItem.parse({
      id: 'mem_1',
      projectId: 'prj_plnr',
      kind: 'learning',
      statement: 'x',
      recordedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(item.authority).toBe(AUTHORITY_HYPOTHESIS);
    expect(item.authority).toBeLessThan(AUTHORITY_HUMAN_APPROVED);
  });

  it('rejects an authority level outside 1..5', () => {
    expect(() =>
      MemoryItem.parse({
        id: 'mem_1',
        projectId: 'prj_plnr',
        kind: 'learning',
        statement: 'x',
        authority: 6,
        recordedAt: '2026-08-06T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('supersession links to a prior memory id rather than mutating it (§12)', () => {
    const item = MemoryItem.parse({
      id: 'mem_2',
      projectId: 'prj_plnr',
      kind: 'decision',
      statement: 'revised: use signed R2 URLs, not RunnerHub frames',
      supersedesMemoryId: 'mem_1',
      recordedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(item.supersedesMemoryId).toBe('mem_1');
  });
});

describe('EffortEpisode — deterministic skeleton required, self-summary optional (§14)', () => {
  const skeleton = {
    id: 'ep_1',
    projectId: 'prj_plnr',
    runId: 'run_1',
    createdAt: '2026-08-06T00:00:00.000Z',
  };

  it('parses valid with no self-summary at all', () => {
    const ep = EffortEpisode.parse(skeleton);
    expect(ep.selfSummary).toBeNull();
    expect(ep.landingOutcome).toBe('pending');
  });

  it('parses valid with a MALFORMED self-summary — it is enrichment, never a validity dependency', () => {
    const ep = EffortEpisode.parse({ ...skeleton, selfSummary: { rejectedHypotheses: 'not an array' } });
    expect(ep.selfSummary).toBeNull();
  });

  it('parses a full skeleton plus a well-formed self-summary', () => {
    const ep = EffortEpisode.parse({
      ...skeleton,
      repositoryKey: 'noriq-web',
      baseId: 'a1b2c3',
      timeline: [{ at: '2026-08-06T00:00:00.000Z', label: 'claimed' }],
      filesTouched: ['apps/api/src/mcp.ts'],
      commands: ['npm test'],
      testsRun: ['mcp.test.ts'],
      findings: [{ summary: 'no regression', severity: 'info' }],
      reviewRounds: 1,
      costUSD: 0.42,
      landingOutcome: 'landed',
      selfSummary: {
        approachSummary: 'read the doc, wrote the schema',
        durableLearnings: ['baseId must never be parsed'],
      },
    });
    expect(ep.selfSummary?.approachSummary).toBe('read the doc, wrote the schema');
    expect(ep.landingOutcome).toBe('landed');
  });

  it('a failed run still produces a valid, retrievable episode (§14)', () => {
    const ep = EffortEpisode.parse({ ...skeleton, landingOutcome: 'failed', failures: ['tsc: type error'] });
    expect(ep.landingOutcome).toBe('failed');
    expect(ep.failures).toEqual(['tsc: type error']);
  });
});

describe('IndexGenerationManifest and MemoryBackupManifest (§8, §17)', () => {
  it('round-trips a staged generation manifest', () => {
    const gen = IndexGenerationManifest.parse({
      generationId: 'gen_1',
      projectId: 'prj_plnr',
      repositoryKey: 'noriq-web',
      branch: 'main',
      baseId: 'a1b2c3',
      indexerVersion: '1.0.0',
      batchCount: 3,
      fileCount: 120,
      contentHash: 'sha256:deadbeef',
      createdAt: '2026-08-06T00:00:00.000Z',
    });
    expect(gen.deletions).toEqual([]);
  });

  it('round-trips a backup manifest', () => {
    const backup = MemoryBackupManifest.parse({
      formatVersion: 1,
      projectMemorySchemaVersion: 1,
      projectId: 'prj_plnr',
      memoryRevision: 42,
      exportedAt: '2026-08-06T00:00:00.000Z',
      tableCounts: { memories: 10, evidence: 30 },
      checksums: { memories: 'sha256:aaa' },
      activeIndexGenerations: [{ repositoryKey: 'noriq-web', generationId: 'gen_1' }],
    });
    expect(backup.tableCounts.memories).toBe(10);
  });
});

describe('ContextPack (§10)', () => {
  it('round-trips an assembled task context pack', () => {
    const pack = ContextPack.parse({
      taskId: 'task_1',
      projectId: 'prj_plnr',
      branch: 'main',
      baseId: 'a1b2c3',
      tokenBudget: 8000,
      relevantEntities: ['noriq://file/PLNR/noriq-web/apps/api/src/mcp.ts'],
      generatedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(pack.verifiedDecisions).toEqual([]);
    expect(pack.relevantEntities).toHaveLength(1);
  });
});

describe('Entity URIs — stable across index rebuilds (§18)', () => {
  const globalCases: EntityRef[] = [
    { kind: 'task', id: 'task_1' },
    { kind: 'plan', id: 'pln_1' },
    { kind: 'run', id: 'run_1' },
    { kind: 'decision', id: 'dec_1' },
    { kind: 'memory', id: 'mem_1' },
    { kind: 'episode', id: 'ep_1' },
    { kind: 'requirement', id: 'req_1' },
    { kind: 'procedure', id: 'proc_1' },
    { kind: 'hazard', id: 'haz_1' },
    { kind: 'artifact', id: 'art_1' },
    { kind: 'unknown', id: 'unk_1' },
  ];

  it('every global kind round-trips build -> parse', () => {
    for (const ref of globalCases) {
      expect(parseEntityUri(buildEntityUri(ref))).toEqual(ref);
    }
  });

  it('repository, file, symbol, and test round-trip build -> parse', () => {
    const repo: EntityRef = { kind: 'repository', projectKey: 'PLNR', repositoryKey: 'noriq-web' };
    const file: EntityRef = {
      kind: 'file',
      projectKey: 'PLNR',
      repositoryKey: 'noriq-web',
      path: 'apps/api/src/mcp.ts',
    };
    const symbol: EntityRef = {
      kind: 'symbol',
      projectKey: 'PLNR',
      repositoryKey: 'noriq-web',
      path: 'apps/api/src/mcp.ts',
      name: 'buildMcpServer',
    };
    const test: EntityRef = {
      kind: 'test',
      projectKey: 'PLNR',
      repositoryKey: 'noriq-web',
      path: 'apps/api/test/mcp.test.ts',
      name: 'notify path delivers on the in-flight SSE stream',
    };
    for (const ref of [repo, file, symbol, test]) {
      expect(parseEntityUri(buildEntityUri(ref))).toEqual(ref);
    }
  });

  it('a file/symbol URI embeds the canonical repository key, never a checkout id', () => {
    const uri = buildEntityUri({
      kind: 'file',
      projectKey: 'PLNR',
      repositoryKey: 'noriq-web',
      path: 'README.md',
    });
    expect(uri).toBe('noriq://file/PLNR/noriq-web/README.md');
    expect(uri).not.toContain('ckt_');
  });

  it('never embeds an index generation or a baseId in identity', () => {
    const uri = buildEntityUri({ kind: 'repository', projectKey: 'PLNR', repositoryKey: 'noriq-web' });
    expect(uri).not.toMatch(/gen_|[0-9a-f]{40}/);
  });

  it('rejects a syntactically invalid URI', () => {
    expect(() => parseEntityUri('not-a-uri')).toThrow();
    expect(() => parseEntityUri('noriq://')).toThrow();
    expect(() => parseEntityUri('noriq://not-a-real-kind/abc')).toThrow();
  });

  it('rejects a repository-scoped URI missing a segment', () => {
    expect(() => parseEntityUri('noriq://repository/PLNR')).toThrow();
  });

  it('rejects a symbol/test URI missing its #name', () => {
    expect(() => parseEntityUri('noriq://symbol/PLNR/noriq-web/apps/api/src/mcp.ts')).toThrow();
  });
});

describe('MemoryNode — rejects malformed and cross-project URIs (§5, §18)', () => {
  it('accepts a node whose uri belongs to its own project', () => {
    const node = MemoryNode.parse({
      id: 'node_1',
      projectKey: 'PLNR',
      type: 'file',
      uri: buildEntityUri({ kind: 'file', projectKey: 'PLNR', repositoryKey: 'noriq-web', path: 'README.md' }),
      label: 'README.md',
    });
    expect(node.projectKey).toBe('PLNR');
  });

  it('rejects a node whose uri names a DIFFERENT project (cross-project reference)', () => {
    expect(() =>
      MemoryNode.parse({
        id: 'node_1',
        projectKey: 'PLNR',
        type: 'file',
        uri: buildEntityUri({ kind: 'file', projectKey: 'RUN', repositoryKey: 'noriq-web', path: 'README.md' }),
        label: 'README.md',
      }),
    ).toThrow();
  });

  it('rejects a node with a syntactically malformed uri', () => {
    expect(() =>
      MemoryNode.parse({
        id: 'node_1',
        projectKey: 'PLNR',
        type: 'file',
        uri: 'not-a-uri',
        label: 'README.md',
      }),
    ).toThrow();
  });
});

describe('MemoryEdge (§5)', () => {
  it('round-trips a typed edge', () => {
    const edge = MemoryEdge.parse({
      projectKey: 'PLNR',
      type: 'depends_on',
      fromNodeId: 'node_1',
      toNodeId: 'node_2',
    });
    expect(edge.type).toBe('depends_on');
  });
});

describe('ProjectManifest — repositoryKey and [index] extension (PLNR-244)', () => {
  it('is optional — a manifest without either parses unchanged', () => {
    const m = ProjectManifest.parse({ key: 'PLNR' });
    expect(m.repositoryKey).toBeNull();
    expect(m.index).toBeNull();
  });

  it('accepts a committed repositoryKey and [index] section', () => {
    const m = ProjectManifest.parse({
      key: 'PLNR',
      repositoryKey: 'noriq-web',
      index: { enabled: true, include: ['apps/**'], exclude: ['**/*.test.ts'] },
    });
    expect(m.repositoryKey).toBe('noriq-web');
    expect(m.index).toEqual({ enabled: true, include: ['apps/**'], exclude: ['**/*.test.ts'] });
  });

  it('rejects a repositoryKey shaped like a runner-local checkout id', () => {
    expect(() => ProjectManifest.parse({ key: 'PLNR', repositoryKey: 'ckt_a1b2c3' })).toThrow();
  });

  it('IndexSpec defaults enabled to false — a repo never becomes indexed by omission', () => {
    expect(IndexSpec.parse({}).enabled).toBe(false);
  });
});
