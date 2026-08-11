import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api, clearConstellationV2PageCache,
  type ApiConstellationV2CommunityPage, type ApiConstellationV2Overview, type ApiConstellationV2Revision,
} from './api';

const revision = (generationId: string): ApiConstellationV2Revision => ({
  contract: 'constellation-v2', generationId, sourceRevision: 1, currentRevision: 1,
  topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1', state: 'current', generatedAt: '2026-08-10T00:00:00.000Z',
});

const overview = (generationId: string): ApiConstellationV2Overview => ({
  revision: revision(generationId), communities: [], routes: [], coverage: { complete: true, reasons: [] },
});

const community = (generationId: string): ApiConstellationV2CommunityPage => ({
  revision: revision(generationId),
  community: { id: 'c1', parentId: null, level: 0, label: 'root', memberCount: 0, childCommunityCount: 0, typeCounts: {}, internalEdgeCount: 0, internalWeight: 0, normalizedCohesion: 0, boundaryWeight: 0, anchor: [0, 0, 0] },
  kind: 'entities', communities: [], entities: [], backboneEdges: [], routes: [], externalCommunities: [], nextCursor: null,
  coverage: { complete: true, reasons: [] },
});

const jsonResponse = (value: unknown, etag: string) => new Response(JSON.stringify(value), {
  status: 200, headers: { 'Content-Type': 'application/json', ETag: etag },
});

afterEach(() => {
  clearConstellationV2PageCache();
  vi.unstubAllGlobals();
});

describe('Constellation v2 client cache', () => {
  it('threads the selected lens through overview, community, route, and incident requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...overview('g1'), lens: 'memories', ambient: { count: 0, entities: [] } }, '"o"'))
      .mockResolvedValueOnce(jsonResponse({ ...community('g1'), lens: 'memories' }, '"c"'))
      .mockResolvedValueOnce(jsonResponse({ revision: revision('g1'), lens: 'memories', nodeId: 'n1', uri: 'noriq://memory/n1', communityPath: [], ambient: true }, '"r"'))
      .mockResolvedValueOnce(jsonResponse({ revision: revision('g1'), lens: 'memories', node: { nodeId: 'n1', uri: 'noriq://memory/n1', type: 'memory', label: 'n1', communityPath: [] }, edges: [], nextCursor: null, coverage: { complete: true, reasons: [] } }, '"i"'));
    vi.stubGlobal('fetch', fetchMock);

    await api.memoryConstellationV2Overview('p1', 'memories');
    await api.memoryConstellationV2Community('p1', 'c1', { lens: 'memories' });
    await api.memoryConstellationV2Route('p1', 'noriq://memory/n1', 'memories');
    await api.memoryConstellationV2Incidents('p1', 'n1', { lens: 'memories' });

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('/overview?lens=memories'),
      expect.stringContaining('/communities/c1?lens=memories'),
      expect.stringContaining('/route?uri=noriq%3A%2F%2Fmemory%2Fn1&lens=memories'),
      expect.stringContaining('/entities/n1/incidents?lens=memories'),
    ]);
  });

  it('revalidates with ETag and reuses the cached object on 304', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview('g1'), '"etag-g1"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await api.memoryConstellationV2Overview('p1');
    const second = await api.memoryConstellationV2Overview('p1');

    expect(second).toBe(first);
    expect(fetchMock.mock.calls[1]![1]?.headers).toMatchObject({
      Accept: 'application/vnd.noriq.constellation-v2.compact+json',
      'If-None-Match': '"etag-g1"',
    });
  });

  it('evicts only cached pages for the project whose generation changes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview('g1'), '"overview-g1"'))
      .mockResolvedValueOnce(jsonResponse(community('g1'), '"community-g1"'))
      .mockResolvedValueOnce(jsonResponse(overview('g2'), '"overview-g2"'))
      .mockResolvedValueOnce(jsonResponse(community('g2'), '"community-g2"'));
    vi.stubGlobal('fetch', fetchMock);

    await api.memoryConstellationV2Overview('p1');
    await api.memoryConstellationV2Community('p1', 'c1');
    await api.memoryConstellationV2Overview('p1');
    await api.memoryConstellationV2Community('p1', 'c1');

    expect(fetchMock.mock.calls[2]![1]?.headers).toMatchObject({ 'If-None-Match': '"overview-g1"' });
    expect(fetchMock.mock.calls[3]![1]?.headers).not.toHaveProperty('If-None-Match');
  });

  it('returns the newest issued request when older network work completes last', async () => {
    let resolveOld!: (response: Response) => void;
    let resolveNew!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const newResponse = new Promise<Response>((resolve) => { resolveNew = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(oldResponse).mockReturnValueOnce(newResponse));

    const oldRequest = api.memoryConstellationV2Overview('p1');
    const newRequest = api.memoryConstellationV2Overview('p1');
    resolveNew(jsonResponse(overview('g2'), '"g2"'));
    expect((await newRequest).revision.generationId).toBe('g2');
    resolveOld(jsonResponse(overview('g1'), '"g1"'));
    expect((await oldRequest).revision.generationId).toBe('g2');
  });
});
