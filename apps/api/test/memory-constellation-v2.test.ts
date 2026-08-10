import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createUser, loginSession, mcpCall, mintTokenForUser } from './helpers';
import {
  compactConstellationCommunityPage,
  cursorMatches, decodeConstellationCursor, encodeConstellationCursor,
  type ConstellationV2CommunityPage, type ConstellationV2IncidentPage, type ConstellationV2Overview,
  type ConstellationV2Route, type ConstellationV2Unavailable,
} from '../src/memory/constellation-v2';

const appEnv = env as unknown as Env;
const SYSTEM = { kind: 'system', id: null };

interface MemoryRpc {
  writeNode(pid: string, input: { type: string; uri: string; label: string; actor: typeof SYSTEM }): Promise<{ nodeId: string }>;
  writeEdge(pid: string, input: { type: string; fromNodeId: string; toNodeId: string; actor: typeof SYSTEM }): Promise<{ edgeId: string }>;
  rebuildConstellationHierarchy(pid: string): Promise<{ ok: boolean }>;
  constellationV2Overview(pid: string): Promise<ConstellationV2Overview | ConstellationV2Unavailable>;
  constellationV2Community(pid: string, id: string, input?: { cursor?: string; limit?: number }): Promise<ConstellationV2CommunityPage | ConstellationV2Unavailable>;
  constellationV2Route(pid: string, uri: string): Promise<ConstellationV2Route | ConstellationV2Unavailable>;
  constellationV2Incidents(pid: string, nodeId: string, input?: { cursor?: string; limit?: number }): Promise<ConstellationV2IncidentPage | ConstellationV2Unavailable>;
}

const memory = (pid: string) => appEnv.PROJECT_MEMORY.get(appEnv.PROJECT_MEMORY.idFromName(pid)) as unknown as MemoryRpc;

async function newOwnedProject(email: string, key: string) {
  await createUser(email, 'Owner', 'longenough1').catch(() => {});
  const token = await mintTokenForUser(email);
  const project = await mcpCall(token, 'create_project', { key, name: `${key} project` });
  if (project.isError) throw new Error(project.text);
  return project.body.id as string;
}

describe('Constellation v2 cursors', () => {
  it('round-trips an opaque generation/scope cursor and rejects malformed or mismatched use', () => {
    const encoded = encodeConstellationCursor({ generationId: 'g1', currentRevision: 7, scope: 'community:c1', after: '[1,"n1"]' });
    expect(encoded).not.toContain('{');
    const decoded = decodeConstellationCursor(encoded);
    expect(decoded).toMatchObject({ generationId: 'g1', currentRevision: 7, scope: 'community:c1' });
    expect(cursorMatches(decoded, 'g1', 7, 'community:c1')).toBe(true);
    expect(cursorMatches(decoded, 'g2', 7, 'community:c1')).toBe(false);
    expect(decodeConstellationCursor('not-a-cursor')).toBeNull();
  });
});

describe('Constellation v2 compact encoding', () => {
  it('dictionary-encodes repeated entity identity fields below the verbose page size', () => {
    const revision = { contract: 'constellation-v2' as const, generationId: 'generation-with-a-long-stable-id', sourceRevision: 1, currentRevision: 1, topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1', state: 'current' as const, generatedAt: '2026-08-10T00:00:00.000Z' };
    const community = { id: 'community-with-a-long-stable-id', parentId: null, level: 0, label: 'community', memberCount: 100, childCommunityCount: 0, typeCounts: { memory: 100 }, internalEdgeCount: 99, internalWeight: 99, normalizedCohesion: 1, boundaryWeight: 0, anchor: [0, 0, 0] as [number, number, number] };
    const page: ConstellationV2CommunityPage = {
      revision, community, kind: 'entities', communities: [], backboneEdges: [], routes: [], externalCommunities: [], nextCursor: null,
      coverage: { complete: true, reasons: [] },
      entities: Array.from({ length: 100 }, (_, index) => ({
        nodeId: `node-with-a-long-stable-id-${index}`, uri: `noriq://memory/memory-with-a-long-stable-id-${index}`,
        type: 'memory', kind: 'observation', label: `Memory item ${index}`, authority: 0.8, validity: 'current',
        isLead: true, leadReasons: ['authority'], degree: 3, boundaryDegree: 1, groupKey: 'memory',
        communityId: community.id, position: [index, index / 2, -index],
      })),
    };
    expect(JSON.stringify(compactConstellationCommunityPage(page)).length).toBeLessThan(JSON.stringify(page).length * 0.7);
  });
});

describe('ProjectMemory Constellation v2 bounded reads', () => {
  it('enumerates every entity, resolves exact symbols, and pages incoming/outgoing incidents', async () => {
    const pid = await newOwnedProject('pm-v2-pages@example.com', 'PMV2PAGE');
    const { nodeId: center } = await memory(pid).writeNode(pid, { type: 'file', uri: 'noriq://file/v2-center', label: 'center', actor: SYSTEM });
    const { nodeId: symbol } = await memory(pid).writeNode(pid, { type: 'symbol', uri: 'noriq://symbol/v2-symbol', label: 'symbol', actor: SYSTEM });
    const { nodeId: memoryId } = await memory(pid).writeNode(pid, { type: 'memory', uri: 'noriq://memory/v2-memory', label: 'memory', actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'declares', fromNodeId: center, toNodeId: symbol, actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'observed_in', fromNodeId: memoryId, toNodeId: center, actor: SYSTEM });
    expect((await memory(pid).rebuildConstellationHierarchy(pid)).ok).toBe(true);

    const overview = await memory(pid).constellationV2Overview(pid) as ConstellationV2Overview;
    expect(overview.revision.contract).toBe('constellation-v2');
    expect(overview.communities.length).toBeGreaterThan(0);
    expect(overview.communities.reduce<Record<string, number>>((totals, community) => {
      for (const [type, count] of Object.entries(community.typeCounts)) totals[type] = (totals[type] ?? 0) + count;
      return totals;
    }, {})).toMatchObject({ file: 1, symbol: 1, memory: 1 });

    const seen: string[] = [];
    const visit = async (communityId: string): Promise<void> => {
      let cursor: string | undefined;
      do {
        const page = await memory(pid).constellationV2Community(pid, communityId, { cursor, limit: 1 }) as ConstellationV2CommunityPage;
        if (page.kind === 'communities') {
          for (const child of page.communities) await visit(child.id);
        } else {
          seen.push(...page.entities.map((entity) => entity.uri));
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    };
    for (const community of overview.communities) await visit(community.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(['noriq://file/v2-center', 'noriq://memory/v2-memory', 'noriq://symbol/v2-symbol']));

    const route = await memory(pid).constellationV2Route(pid, 'noriq://symbol/v2-symbol') as ConstellationV2Route;
    expect(route.nodeId).toBe(symbol);
    expect(overview.communities.map((community) => community.id)).toContain(route.communityPath[0]!.id);

    const directions: string[] = [];
    let incidentCursor: string | undefined;
    do {
      const page = await memory(pid).constellationV2Incidents(pid, center, { cursor: incidentCursor, limit: 1 }) as ConstellationV2IncidentPage;
      directions.push(...page.edges.map((edge) => `${edge.direction}:${edge.type}:${edge.endpoint.uri}`));
      expect(page.edges.every((edge) => edge.endpoint.communityPath.length > 0)).toBe(true);
      incidentCursor = page.nextCursor ?? undefined;
    } while (incidentCursor);
    expect(directions.sort()).toEqual([
      'incoming:observed_in:noriq://memory/v2-memory',
      'outgoing:declares:noriq://symbol/v2-symbol',
    ]);
  });

  it('rejects a continuation after canonical revision changes instead of replaying it against new data', async () => {
    const pid = await newOwnedProject('pm-v2-cursor@example.com', 'PMV2CURS');
    const { nodeId: a } = await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/v2-a', label: 'a', actor: SYSTEM });
    const { nodeId: b } = await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/v2-b', label: 'b', actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'related_to', fromNodeId: a, toNodeId: b, actor: SYSTEM });
    await memory(pid).rebuildConstellationHierarchy(pid);
    const overview = await memory(pid).constellationV2Overview(pid) as ConstellationV2Overview;
    const first = await memory(pid).constellationV2Community(pid, overview.communities[0]!.id, { limit: 1 }) as ConstellationV2CommunityPage;
    expect(first.nextCursor).toEqual(expect.any(String));

    await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/v2-newer', label: 'newer', actor: SYSTEM });
    expect(await memory(pid).constellationV2Community(pid, overview.communities[0]!.id, { cursor: first.nextCursor!, limit: 1 }))
      .toMatchObject({ ok: false, error: 'cursor-stale' });
  });
});

describe('Constellation v2 REST authorization and availability', () => {
  it('serves an authenticated project member and collapses an outsider to 404', async () => {
    await createUser('pm-v2-rest@example.com', 'Owner', 'longenough1').catch(() => {});
    const cookie = await loginSession('pm-v2-rest@example.com', 'longenough1');
    const created = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'PMV2REST', name: 'v2' }),
    });
    const pid = (await created.json() as { id: string }).id;
    await memory(pid).writeNode(pid, { type: 'memory', uri: 'noriq://memory/v2-rest', label: 'rest', actor: SYSTEM });
    await memory(pid).rebuildConstellationHierarchy(pid);

    const response = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/constellation/v2/overview`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const etag = response.headers.get('ETag');
    expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    expect(response.headers.get('X-Noriq-Constellation-Cache')).toBe('miss');
    expect(Number(response.headers.get('X-Noriq-Constellation-Rows'))).toBeGreaterThan(0);
    const overviewBody = await response.json() as ConstellationV2Overview;
    expect(overviewBody.communities).toHaveLength(1);

    const unchanged = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/constellation/v2/overview`, {
      headers: { Cookie: cookie, 'If-None-Match': etag! },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    expect(unchanged.headers.get('X-Noriq-Constellation-Cache')).toBe('hit');
    expect(unchanged.headers.get('X-Noriq-Constellation-Rows')).toBe('0');

    await memory(pid).writeNode(pid, { type: 'memory', uri: 'noriq://memory/v2-rest-newer', label: 'newer', actor: SYSTEM });
    const stale = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/constellation/v2/overview`, {
      headers: { Cookie: cookie, 'If-None-Match': etag! },
    });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('ETag')).not.toBe(etag);
    expect(stale.headers.get('X-Noriq-Constellation-Cache')).toBe('miss');
    expect(await stale.json()).toMatchObject({
      revision: { generationId: overviewBody.revision.generationId, state: 'stale', sourceRevision: overviewBody.revision.sourceRevision },
      communities: overviewBody.communities,
    });

    const compact = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/constellation/v2/communities/${overviewBody.communities[0]!.id}`, {
      headers: { Cookie: cookie, Accept: 'application/vnd.noriq.constellation-v2.compact+json' },
    });
    expect(compact.status).toBe(200);
    expect(compact.headers.get('Content-Type')).toContain('application/vnd.noriq.constellation-v2.compact+json');
    expect(await compact.json()).toMatchObject({ encoding: 'constellation-v2-community-v1', dictionary: { ids: expect.any(Array) }, entities: expect.any(Array) });

    await createUser('pm-v2-outsider@example.com', 'Outsider', 'longenough1').catch(() => {});
    const outsider = await loginSession('pm-v2-outsider@example.com', 'longenough1');
    expect((await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/constellation/v2/overview`, { headers: { Cookie: outsider } })).status).toBe(404);
  });

  it('returns a truthful 503 instead of scanning v1 when no complete generation exists', async () => {
    await createUser('pm-v2-empty@example.com', 'Owner', 'longenough1').catch(() => {});
    const cookie = await loginSession('pm-v2-empty@example.com', 'longenough1');
    const created = await SELF.fetch('https://noriq.test/api/projects', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'PMV2EMPT', name: 'empty' }),
    });
    const pid = (await created.json() as { id: string }).id;
    const response = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/constellation/v2/overview`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'constellation_generation_unavailable' });
    expect(response.headers.get('Retry-After')).toBe('5');
  });
});
