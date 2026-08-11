import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ConstellationGenerationData } from '../src/do/ProjectMemory';
import type { Env } from '../src/env';
import { createUser, loginSession, mcpCall, mintTokenForUser } from './helpers';
import {
  compactConstellationCommunityPage,
  cursorMatches, decodeConstellationCursor, encodeConstellationCursor,
  type ConstellationV2CommunityPage, type ConstellationV2IncidentPage, type ConstellationV2Overview,
  type ConstellationV2Route, type ConstellationV2Unavailable,
} from '../src/memory/constellation-v2';
import { sha256Hex } from '../src/lib/util';

const appEnv = env as unknown as Env;
const SYSTEM = { kind: 'system', id: null };

interface MemoryRpc {
  writeNode(pid: string, input: { type: string; uri: string; label: string; actor: typeof SYSTEM }): Promise<{ nodeId: string }>;
  writeEdge(pid: string, input: { type: string; fromNodeId: string; toNodeId: string; actor: typeof SYSTEM }): Promise<{ edgeId: string }>;
  rebuildConstellationHierarchy(pid: string): Promise<{ ok: boolean }>;
  beginConstellationGeneration(pid: string, input: { topologyVersion: string; layoutVersion: string }): Promise<{ generationId: string }>;
  stageConstellationGeneration(pid: string, generationId: string, data: ConstellationGenerationData): Promise<{ ok: true }>;
  completeConstellationGeneration(pid: string, generationId: string): Promise<{ ok: true }>;
  activateConstellationGeneration(pid: string, generationId: string): Promise<{ activated: string }>;
  constellationV2Overview(pid: string, lens?: 'plans' | 'memories'): Promise<ConstellationV2Overview | ConstellationV2Unavailable>;
  constellationV2Community(pid: string, id: string, input?: { cursor?: string; limit?: number; lens?: 'plans' | 'memories' }): Promise<ConstellationV2CommunityPage | ConstellationV2Unavailable>;
  constellationV2Route(pid: string, uri: string, lens?: 'plans' | 'memories'): Promise<ConstellationV2Route | ConstellationV2Unavailable>;
  constellationV2Incidents(pid: string, nodeId: string, input?: { cursor?: string; limit?: number; lens?: 'plans' | 'memories' }): Promise<ConstellationV2IncidentPage | ConstellationV2Unavailable>;
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
    const community = { id: 'community-with-a-long-stable-id', parentId: null, level: 0, label: 'community', coreNodeId: 'node-core', memberCount: 100, childCommunityCount: 0, typeCounts: { memory: 100 }, internalEdgeCount: 99, internalWeight: 99, normalizedCohesion: 1, boundaryWeight: 0, anchor: [0, 0, 0] as [number, number, number] };
    const page: ConstellationV2CommunityPage = {
      revision, lens: 'memories', community, kind: 'entities', communities: [], backboneEdges: [], routes: [], externalCommunities: [], nextCursor: null,
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
  it('reports a pre-lens generation stale instead of confusing missing rows with a zero-anchor lens', async () => {
    const pid = await newOwnedProject('pm-v2-pre-lens@example.com', 'PMV2OLD');
    const generation = await memory(pid).beginConstellationGeneration(pid, { topologyVersion: 'semantic-roots-v4', layoutVersion: 'space-v1' });
    await memory(pid).completeConstellationGeneration(pid, generation.generationId);
    await memory(pid).activateConstellationGeneration(pid, generation.generationId);
    expect(await memory(pid).constellationV2Overview(pid, 'memories')).toMatchObject({ ok: false, error: 'generation-stale' });
  });

  it('persists both lenses: linked memories join plan systems while unlinked memories stay ambient under plans', async () => {
    const pid = await newOwnedProject('pm-v2-lenses@example.com', 'PMV2LENS');
    const { nodeId: plan } = await memory(pid).writeNode(pid, { type: 'plan', uri: 'noriq://plan/lens-plan', label: 'Plan system', actor: SYSTEM });
    const { nodeId: memoryId } = await memory(pid).writeNode(pid, { type: 'memory', uri: 'noriq://memory/lens-memory', label: 'Memory system', actor: SYSTEM });
    const { nodeId: unlinkedMemoryId } = await memory(pid).writeNode(pid, { type: 'memory', uri: 'noriq://memory/unlinked-memory', label: 'Unlinked memory', actor: SYSTEM });
    const { nodeId: task } = await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/lens-task', label: 'shared task', actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'related_to', fromNodeId: plan, toNodeId: task, actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'observed_in', fromNodeId: memoryId, toNodeId: task, actor: SYSTEM });
    expect((await memory(pid).rebuildConstellationHierarchy(pid)).ok).toBe(true);

    const plans = await memory(pid).constellationV2Overview(pid, 'plans') as ConstellationV2Overview;
    const memories = await memory(pid).constellationV2Overview(pid, 'memories') as ConstellationV2Overview;
    expect(plans).toMatchObject({ lens: 'plans', communities: [expect.objectContaining({ coreNodeId: plan, label: 'Plan system' })] });
    expect(memories).toMatchObject({ lens: 'memories' });
    expect(memories.communities).toHaveLength(2);
    expect(memories.communities).toEqual(expect.arrayContaining([
      expect.objectContaining({ coreNodeId: memoryId, label: 'Memory system' }),
      expect.objectContaining({ coreNodeId: unlinkedMemoryId, label: 'Unlinked memory' }),
    ]));
    expect(plans.communities[0]!.id).not.toBe(memories.communities.find((community) => community.coreNodeId === memoryId)!.id);

    // Project creation can also reconcile its unlinked Backlog milestone into the ambient field;
    // assert the lens semantics by entity identity instead of assuming this fixture owns the graph.
    const planAmbientIds = plans.ambient.entities.map((entity) => entity.nodeId);
    expect(planAmbientIds).toContain(unlinkedMemoryId);
    expect(planAmbientIds).not.toContain(memoryId);
    expect(await memory(pid).constellationV2Route(pid, 'noriq://memory/lens-memory', 'plans')).toMatchObject({
      lens: 'plans', ambient: false, communityPath: [expect.objectContaining({ coreNodeId: plan })],
    });
    expect(await memory(pid).constellationV2Route(pid, 'noriq://memory/unlinked-memory', 'plans')).toMatchObject({
      lens: 'plans', ambient: true, communityPath: [],
    });
    expect((await memory(pid).constellationV2Route(pid, 'noriq://task/lens-task', 'plans') as ConstellationV2Route).communityPath[0]!.coreNodeId).toBe(plan);
    expect((await memory(pid).constellationV2Route(pid, 'noriq://task/lens-task', 'memories') as ConstellationV2Route).communityPath[0]!.coreNodeId).toBe(memoryId);
    expect(await memory(pid).constellationV2Route(pid, 'noriq://memory/unlinked-memory', 'memories')).toMatchObject({
      lens: 'memories', ambient: false, communityPath: [expect.objectContaining({ coreNodeId: unlinkedMemoryId })],
    });

    const noAnchorPid = await newOwnedProject('pm-v2-no-memory-anchor@example.com', 'PMV2NOAN');
    const { nodeId: lonePlan } = await memory(noAnchorPid).writeNode(noAnchorPid, { type: 'plan', uri: 'noriq://plan/no-memory', label: 'Plan only', actor: SYSTEM });
    const { nodeId: loneTask } = await memory(noAnchorPid).writeNode(noAnchorPid, { type: 'task', uri: 'noriq://task/no-memory', label: 'task only', actor: SYSTEM });
    await memory(noAnchorPid).writeEdge(noAnchorPid, { type: 'related_to', fromNodeId: lonePlan, toNodeId: loneTask, actor: SYSTEM });
    await memory(noAnchorPid).rebuildConstellationHierarchy(noAnchorPid);
    const emptyMemories = await memory(noAnchorPid).constellationV2Overview(noAnchorPid, 'memories') as ConstellationV2Overview;
    expect(emptyMemories).toMatchObject({ lens: 'memories', communities: [], routes: [] });
    expect(emptyMemories.ambient.count).toBeGreaterThanOrEqual(2);
    expect(emptyMemories.ambient.entities.map((entity) => entity.nodeId)).toEqual(expect.arrayContaining([lonePlan, loneTask]));
    expect(emptyMemories.ambient.entities.every((entity) => entity.communityId === null)).toBe(true);
    expect(await memory(noAnchorPid).constellationV2Route(noAnchorPid, 'noriq://task/no-memory', 'memories')).toMatchObject({
      lens: 'memories', ambient: true, communityPath: [],
    });
  });

  it('pages a 128-child community without exceeding the SQLite variable ceiling', async () => {
    const pid = await newOwnedProject('pm-v2-wide@example.com', 'PMV2WIDE');
    const root = {
      id: 'wide-root', parentId: null, level: 0, label: 'wide root', memberCount: 128, childCount: 128,
      coreNodeId: null,
      typeCounts: { task: 128 }, internalEdgeCount: 0, internalWeight: 0, normalizedCohesion: 0,
      boundaryWeight: 0, anchor: [0, 0, 0] as [number, number, number],
    };
    const children = Array.from({ length: 128 }, (_, index) => ({
      id: `wide-child-${String(index).padStart(3, '0')}`, parentId: root.id, level: 1,
      coreNodeId: null,
      label: `child ${index}`, memberCount: 1, childCount: 0, typeCounts: { task: 1 },
      internalEdgeCount: 0, internalWeight: 0, normalizedCohesion: 0, boundaryWeight: 0,
      anchor: [index, 0, 0] as [number, number, number],
    }));
    const generation = await memory(pid).beginConstellationGeneration(pid, { topologyVersion: 'wide-test', layoutVersion: 'wide-test' });
    await memory(pid).stageConstellationGeneration(pid, generation.generationId, {
      lenses: [
        { lens: 'plans', nodeStats: [], communities: [root, ...children], memberships: [], ambientNodeIds: [], links: [
          { level: 1, fromCommunityId: children[0]!.id, toCommunityId: children[100]!.id, direction: 'forward', count: 1, weight: 10, byType: { related_to: 1 } },
          { level: 1, fromCommunityId: children[99]!.id, toCommunityId: children[101]!.id, direction: 'forward', count: 1, weight: 20, byType: { calls: 1 } },
        ] },
        { lens: 'memories', nodeStats: [], communities: [], memberships: [], ambientNodeIds: [], links: [] },
      ],
    });
    await memory(pid).completeConstellationGeneration(pid, generation.generationId);
    await memory(pid).activateConstellationGeneration(pid, generation.generationId);

    const page = await memory(pid).constellationV2Community(pid, root.id, { limit: 256 }) as ConstellationV2CommunityPage;
    expect(page.kind).toBe('communities');
    expect(page.communities).toHaveLength(128);
    expect(page.nextCursor).toBeNull();
    // The cross-batch route (child 0 -> child 100) matches both SQL batches, but appears once;
    // the merged page still follows the endpoint's global weight ordering.
    expect(page.routes.map((route) => [route.fromCommunityId, route.toCommunityId])).toEqual([
      [children[99]!.id, children[101]!.id],
      [children[0]!.id, children[100]!.id],
    ]);
  });

  it('returns direct plan-system members alongside phase child communities', async () => {
    const pid = await newOwnedProject('pm-v2-phase-direct@example.com', 'PMV2PHAS');
    const { nodeId: plan } = await memory(pid).writeNode(pid, { type: 'plan', uri: 'noriq://plan/phase-root', label: 'Plan sun', actor: SYSTEM });
    const { nodeId: agent } = await memory(pid).writeNode(pid, { type: 'agent', uri: 'noriq://agent/direct', label: 'Direct agent', actor: SYSTEM });
    const { nodeId: task } = await memory(pid).writeNode(pid, { type: 'task', uri: 'noriq://task/phase-member', label: 'Phase task', actor: SYSTEM });
    const root = {
      id: 'phase-root', parentId: null, level: 0, label: 'Plan sun', coreNodeId: plan, memberCount: 3, childCount: 1,
      typeCounts: { plan: 1, agent: 1, task: 1 }, internalEdgeCount: 0, internalWeight: 0, normalizedCohesion: 1,
      boundaryWeight: 0, anchor: [100, 50, -20] as [number, number, number],
    };
    const child = {
      id: 'phase-child', parentId: root.id, level: 1, label: 'Foundation', coreNodeId: null, memberCount: 1, childCount: 0,
      typeCounts: { task: 1 }, internalEdgeCount: 0, internalWeight: 0, normalizedCohesion: 1,
      boundaryWeight: 0, anchor: [130, 50, -20] as [number, number, number],
    };
    const generation = await memory(pid).beginConstellationGeneration(pid, { topologyVersion: 'anchor-lens-v2', layoutVersion: 'space-v1' });
    await memory(pid).stageConstellationGeneration(pid, generation.generationId, {
      lenses: [
        {
          lens: 'plans', communities: [root, child], links: [], ambientNodeIds: [],
          nodeStats: [plan, agent, task].map((nodeId) => ({ nodeId, degree: 0, weightedDegree: 0, rank: 0, boundaryDegree: 0 })),
          memberships: [
            { nodeId: plan, communityId: root.id, level: 0 },
            { nodeId: agent, communityId: root.id, level: 0 },
            { nodeId: task, communityId: child.id, level: 1 },
          ],
        },
        { lens: 'memories', nodeStats: [], communities: [], memberships: [], ambientNodeIds: [], links: [] },
      ],
    });
    await memory(pid).completeConstellationGeneration(pid, generation.generationId);
    await memory(pid).activateConstellationGeneration(pid, generation.generationId);

    const rootPage = await memory(pid).constellationV2Community(pid, root.id, { lens: 'plans', limit: 256 }) as ConstellationV2CommunityPage;
    expect(rootPage.kind).toBe('communities');
    expect(rootPage.communities).toEqual([expect.objectContaining({ id: child.id, label: 'Foundation' })]);
    expect(rootPage.entities.map((entity) => entity.nodeId).sort()).toEqual([agent, plan].sort());
    const childPage = await memory(pid).constellationV2Community(pid, child.id, { lens: 'plans', limit: 256 }) as ConstellationV2CommunityPage;
    expect(childPage.entities.map((entity) => entity.nodeId)).toEqual([task]);
  });

  it('enumerates every entity, resolves exact symbols, and pages incoming/outgoing incidents', async () => {
    const pid = await newOwnedProject('pm-v2-pages@example.com', 'PMV2PAGE');
    const { nodeId: center } = await memory(pid).writeNode(pid, { type: 'file', uri: 'noriq://file/v2-center', label: 'center', actor: SYSTEM });
    const { nodeId: symbol } = await memory(pid).writeNode(pid, { type: 'symbol', uri: 'noriq://symbol/v2-symbol', label: 'symbol', actor: SYSTEM });
    const { nodeId: memoryId } = await memory(pid).writeNode(pid, { type: 'memory', uri: 'noriq://memory/v2-memory', label: 'memory', actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'declares', fromNodeId: center, toNodeId: symbol, actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'observed_in', fromNodeId: memoryId, toNodeId: center, actor: SYSTEM });
    expect((await memory(pid).rebuildConstellationHierarchy(pid)).ok).toBe(true);

    const overview = await memory(pid).constellationV2Overview(pid, 'memories') as ConstellationV2Overview;
    expect(overview.lens).toBe('memories');
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
        const page = await memory(pid).constellationV2Community(pid, communityId, { cursor, limit: 1, lens: 'memories' }) as ConstellationV2CommunityPage;
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

    const route = await memory(pid).constellationV2Route(pid, 'noriq://symbol/v2-symbol', 'memories') as ConstellationV2Route;
    expect(route.nodeId).toBe(symbol);
    expect(overview.communities.map((community) => community.id)).toContain(route.communityPath[0]!.id);

    const directions: string[] = [];
    let incidentCursor: string | undefined;
    do {
      const page = await memory(pid).constellationV2Incidents(pid, center, { cursor: incidentCursor, limit: 1, lens: 'memories' }) as ConstellationV2IncidentPage;
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
    const { nodeId: plan } = await memory(pid).writeNode(pid, { type: 'plan', uri: 'noriq://plan/v2-plan', label: 'plan', actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'related_to', fromNodeId: a, toNodeId: b, actor: SYSTEM });
    await memory(pid).writeEdge(pid, { type: 'related_to', fromNodeId: plan, toNodeId: a, actor: SYSTEM });
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
    await memory(pid).writeNode(pid, { type: 'plan', uri: 'noriq://plan/v2-rest', label: 'rest', actor: SYSTEM });
    await memory(pid).rebuildConstellationHierarchy(pid);

    const overviewUrl = `https://noriq.test/api/projects/${pid}/memory/constellation/v2/overview`;
    const response = await SELF.fetch(overviewUrl, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const etag = response.headers.get('ETag');
    expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    expect(response.headers.get('X-Noriq-Constellation-Cache')).toBe('miss');
    expect(Number(response.headers.get('X-Noriq-Constellation-Rows'))).toBeGreaterThan(0);
    const overviewBody = await response.json() as ConstellationV2Overview;
    expect(overviewBody.lens).toBe('plans');
    expect(overviewBody.communities).toHaveLength(1);

    const memoriesResponse = await SELF.fetch(`${overviewUrl}?lens=memories`, { headers: { Cookie: cookie } });
    expect(memoriesResponse.status).toBe(200);
    expect(await memoriesResponse.json()).toMatchObject({ lens: 'memories', communities: [], ambient: { count: 1 } });
    expect((await SELF.fetch(`${overviewUrl}?lens=invalid`, { headers: { Cookie: cookie } })).status).toBe(400);

    const stable = await SELF.fetch(overviewUrl, { headers: { Cookie: cookie } });
    expect(stable.status).toBe(200);
    expect(stable.headers.get('ETag')).toBe(etag);
    expect(await stable.json()).toEqual(overviewBody);

    const unchanged = await SELF.fetch(overviewUrl, {
      headers: { Cookie: cookie, 'If-None-Match': etag! },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    expect(unchanged.headers.get('X-Noriq-Constellation-Cache')).toBe('hit');
    expect(unchanged.headers.get('X-Noriq-Constellation-Rows')).toBe('0');

    const oldEtagInput = [
      overviewBody.revision.contract, overviewBody.revision.generationId, overviewBody.revision.currentRevision,
      overviewBody.revision.topologyVersion, overviewBody.revision.layoutVersion,
      new URL(overviewUrl).pathname, 'verbose-v1',
    ].join('\n');
    const oldEtag = `"${(await sha256Hex(oldEtagInput)).slice(0, 32)}"`;
    expect(oldEtag).not.toBe(etag);
    const staleReadVersion = await SELF.fetch(overviewUrl, {
      headers: { Cookie: cookie, 'If-None-Match': oldEtag },
    });
    expect(staleReadVersion.status).toBe(200);
    expect(staleReadVersion.headers.get('ETag')).toBe(etag);
    expect(staleReadVersion.headers.get('X-Noriq-Constellation-Cache')).toBe('miss');
    expect(await staleReadVersion.json()).toEqual(overviewBody);

    await memory(pid).writeNode(pid, { type: 'plan', uri: 'noriq://plan/v2-rest-newer', label: 'newer', actor: SYSTEM });
    const stale = await SELF.fetch(overviewUrl, {
      headers: { Cookie: cookie, 'If-None-Match': etag! },
    });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('ETag')).not.toBe(etag);
    expect(stale.headers.get('X-Noriq-Constellation-Cache')).toBe('miss');
    expect(await stale.json()).toMatchObject({
      revision: { generationId: overviewBody.revision.generationId, state: 'stale', sourceRevision: overviewBody.revision.sourceRevision },
      communities: overviewBody.communities,
    });

    const compact = await SELF.fetch(`https://noriq.test/api/projects/${pid}/memory/constellation/v2/communities/${overviewBody.communities[0]!.id}?lens=plans`, {
      headers: { Cookie: cookie, Accept: 'application/vnd.noriq.constellation-v2.compact+json' },
    });
    expect(compact.status).toBe(200);
    expect(compact.headers.get('Content-Type')).toContain('application/vnd.noriq.constellation-v2.compact+json');
    expect(await compact.json()).toMatchObject({ encoding: 'constellation-v2-community-v1', dictionary: { ids: expect.any(Array) }, entities: expect.any(Array) });
    const wrongLensCommunity = await SELF.fetch(
      `https://noriq.test/api/projects/${pid}/memory/constellation/v2/communities/${overviewBody.communities[0]!.id}?lens=memories`,
      { headers: { Cookie: cookie } },
    );
    expect(wrongLensCommunity.status).toBe(404);
    const planRoute = await SELF.fetch(
      `https://noriq.test/api/projects/${pid}/memory/constellation/v2/route?uri=${encodeURIComponent('noriq://plan/v2-rest')}&lens=plans`,
      { headers: { Cookie: cookie } },
    );
    expect(await planRoute.json()).toMatchObject({ lens: 'plans', ambient: false, communityPath: [expect.objectContaining({ coreNodeId: expect.any(String) })] });
    const memoryRoute = await SELF.fetch(
      `https://noriq.test/api/projects/${pid}/memory/constellation/v2/route?uri=${encodeURIComponent('noriq://plan/v2-rest')}&lens=memories`,
      { headers: { Cookie: cookie } },
    );
    expect(await memoryRoute.json()).toMatchObject({ lens: 'memories', ambient: true, communityPath: [] });

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
