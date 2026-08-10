import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiConstellationV2CommunityPage, type ApiConstellationV2Revision } from '../api';

vi.mock('./MemoryConstellation3D', () => ({
  default: (props: { onRendererFailure?: (reason: string) => void }) => {
    useEffect(() => props.onRendererFailure?.('WebGL2 unavailable in test'), [props.onRendererFailure]);
    return null;
  },
}));

import { MemoryConstellationV2 } from './MemoryConstellationV2';

const revision: ApiConstellationV2Revision = { contract: 'constellation-v2', generationId: 'g1', sourceRevision: 1, currentRevision: 1, topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1', state: 'current', generatedAt: 'now' };
const rootCommunity = { id: 'root', parentId: null, level: 0, label: 'Root community', memberCount: 2, childCommunityCount: 0, typeCounts: { memory: 2 }, internalEdgeCount: 1, internalWeight: 1, normalizedCohesion: 1, boundaryWeight: 0, anchor: [0, 0, 0] as [number, number, number] };
const entity = (id: string) => ({ nodeId: id, uri: `noriq://memory/${id}`, type: 'memory', kind: 'learning', label: `Memory ${id}`, authority: 3, validity: 'active', isLead: true, leadReasons: [], degree: 1, boundaryDegree: 0, groupKey: 'memory', communityId: 'root', position: [0, 0, 0] as [number, number, number] });
const page = (id: string, nextCursor: string | null): ApiConstellationV2CommunityPage => ({
  revision, community: rootCommunity, kind: 'entities', communities: [], entities: [entity(id)], backboneEdges: [], routes: [], externalCommunities: [], nextCursor,
  coverage: { complete: nextCursor === null, reasons: nextCursor ? ['page-limit-reached'] : [] },
});

let host: HTMLDivElement;
let root: Root | null = null;
const tick = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

afterEach(() => {
  act(() => root?.unmount()); root = null; host?.remove(); vi.restoreAllMocks();
});

describe('MemoryConstellationV2 graceful textual parity', () => {
  it('routes an off-page search hit into the paginated leaf and preserves inspector/ego actions without WebGL', async () => {
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    vi.spyOn(api, 'memoryConstellationV2Community').mockImplementation(async (_pid, _community, input) => input?.cursor ? page('b', null) : page('a', 'more'));
    vi.spyOn(api, 'memoryConstellationV2Route').mockResolvedValue({ revision, nodeId: 'b', uri: 'noriq://memory/b', communityPath: [rootCommunity] });
    vi.spyOn(api, 'memoryConstellationV2Incidents').mockResolvedValue({ revision, node: { nodeId: 'b', uri: 'noriq://memory/b', type: 'memory', label: 'Memory b', communityPath: [rootCommunity] }, edges: [], nextCursor: null, coverage: { complete: true, reasons: [] } });
    vi.spyOn(api, 'memorySearch').mockResolvedValue({ mode: 'keyword', results: [{ entityType: 'memory', id: 'b', uri: 'noriq://memory/b', title: 'Off-page memory', snippet: '', stage: 'lexical', score: 1, isLead: true, leadReasons: [], finalScore: 1 }], evidenceFrame: { text: '', itemsIncluded: 0, itemsOmitted: 0, truncated: false, charsUsed: 0, suspiciousCount: 0 } });
    const openEgo = vi.fn(), openInspector = vi.fn();
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" onOpenEgoNetwork={openEgo} onOpenInspector={openInspector} />));
    await tick(); await tick();
    expect(host.textContent).toContain('3D view unavailable — textual navigation remains active');
    expect(host.textContent).toContain('Root community');

    const search = host.querySelector('input[placeholder^="Search memory"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'off page');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tick(350); await tick();
    const hit = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Off-page memory'))!;
    act(() => hit.click());
    await tick(); await tick();

    expect(api.memoryConstellationV2Community).toHaveBeenCalledWith('p1', 'root', expect.objectContaining({ cursor: 'more' }), undefined);
    expect(host.textContent).toContain('Memory b');
    const memoryB = [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Memory b'))!;
    const fallbackRow = memoryB.parentElement!;
    const ego = [...fallbackRow.querySelectorAll('button')].find((button) => button.textContent === 'ego')!;
    const evidence = [...fallbackRow.querySelectorAll('button')].find((button) => button.textContent === 'evidence')!;
    act(() => { ego.click(); evidence.click(); });
    expect(openEgo).toHaveBeenCalledWith('noriq://memory/b');
    expect(openInspector).toHaveBeenCalledWith('noriq://memory/b');
  });
});
