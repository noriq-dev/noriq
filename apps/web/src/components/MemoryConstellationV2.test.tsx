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

describe('MemoryConstellationV2 header band, breadcrumb row, and resident meter (PLNR-435)', () => {
  it('shows generation/counts chrome, keeps every breadcrumb crumb a real focusable button with the trailing one current, and tracks the resident meter through expand and collapse', async () => {
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    vi.spyOn(api, 'memoryConstellationV2Community').mockResolvedValue(page('a', null));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    // Header band: eyebrow, title, v2 chip, generation chip (id · state), root-level counts chip.
    expect(host.textContent).toContain('MEMORY');
    expect(host.textContent).toContain('Constellation');
    expect(host.textContent).toContain('v2');
    expect(host.textContent).toContain('g1 · current');
    expect(host.textContent).toContain('1 community · 2 entities');

    // Renderer failure (forced by the MemoryConstellation3D mock above) puts the view toggle into
    // Catalogue and disables the now-meaningless Space segment — it stays visible, not hidden.
    const spaceToggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Space')!;
    const catalogueToggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Catalogue')!;
    expect(spaceToggle.disabled).toBe(true);
    expect(catalogueToggle.getAttribute('aria-pressed')).toBe('true');
    // Styled, not bare native buttons.
    expect(spaceToggle.style.padding).not.toBe('');
    expect(catalogueToggle.style.background).not.toBe('');

    // Breadcrumb row: a single "Project" crumb at root, styled as the current (trailing) crumb.
    const crumbs = () => [...host.querySelectorAll('button')].filter((button) => button.textContent === 'Project' || button.textContent === 'Root community');
    expect(crumbs()).toHaveLength(1);
    const rootCrumb = crumbs()[0]!;
    expect(rootCrumb.tagName).toBe('BUTTON');
    expect(rootCrumb.getAttribute('aria-current')).toBe('location');
    expect(rootCrumb.tabIndex).not.toBe(-1);
    expect(rootCrumb.style.color).not.toBe('');
    expect(host.textContent).toContain('root level · double-click a community to open it');

    // Resident meter starts at zero — nothing has been fetched into residency yet.
    const meter = () => host.querySelector('[role="img"][aria-label^="Resident nodes"]')!;
    expect(host.textContent).toContain('resident 0 / 12,000 nodes');
    expect(meter().getAttribute('aria-label')).toBe('Resident nodes: 0 of 12,000 budget');

    // Expand the root community — the fallback catalogue's "open" button next to it.
    const openRoot = [...host.querySelectorAll('button')].find((button) => button.textContent === 'open')!;
    act(() => openRoot.click());
    await tick(); await tick();

    // Meter tracks the expansion: the fetched page (1 entity) is now resident.
    expect(host.textContent).toContain('resident 1 / 12,000 nodes');
    expect(meter().getAttribute('aria-label')).toBe('Resident nodes: 1 of 12,000 budget');
    // Breadcrumb grew a second, now-trailing crumb for the opened community; "Project" demoted to ancestor styling.
    expect(crumbs()).toHaveLength(2);
    const [projectCrumb, communityCrumb] = crumbs() as [HTMLButtonElement, HTMLButtonElement];
    expect(projectCrumb.textContent).toBe('Project');
    expect(projectCrumb.getAttribute('aria-current')).toBeNull();
    expect(communityCrumb.textContent).toBe('Root community');
    expect(communityCrumb.getAttribute('aria-current')).toBe('location');
    expect(host.textContent).toContain('level 1');

    // Collapse back to root via the "Project" crumb.
    act(() => projectCrumb.click());
    await tick();

    expect(crumbs()).toHaveLength(1);
    expect(crumbs()[0]!.getAttribute('aria-current')).toBe('location');
    // The fetched page stays resident after collapsing (eviction is lazy, keyed off the next store, not
    // off leaving a level) — the meter keeps reporting the true resident count rather than resetting to
    // zero as if nothing were loaded.
    expect(host.textContent).toContain('resident 1 / 12,000 nodes');
  });
});

describe('MemoryConstellationV2 status region (PLNR-436)', () => {
  it('stacks error, stale, and partial notices as ordered siblings in one flow container with no positional coupling, and the partial notice carries its own continue action', async () => {
    const staleRevision: ApiConstellationV2Revision = { ...revision, state: 'stale', sourceRevision: 3, currentRevision: 7 };
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision: staleRevision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    vi.spyOn(api, 'memoryConstellationV2Community').mockImplementation(async () => ({ ...page('a', 'more'), revision: staleRevision }));
    vi.spyOn(api, 'memoryConstellationV2Incidents').mockRejectedValue(new Error('Incident boom'));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    // Expand the root community: entities page has a nextCursor, so scene.partial becomes true.
    const openRoot = [...host.querySelectorAll('button')].find((button) => button.textContent === 'open')!;
    act(() => openRoot.click());
    await tick(); await tick();

    // Select the resident entity: the mocked incident fetch rejects, driving the error notice.
    const entityRow = [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Memory a'))!;
    act(() => entityRow.click());
    await tick(); await tick();

    const notices = [...host.querySelectorAll('[role="status"]')];
    expect(notices).toHaveLength(3);
    // Fixed severity order: error -> stale -> building -> partial -> informational (Navigator
    // conventions doc §3). Only error/stale/partial are reachable simultaneously here.
    expect(notices[0]!.textContent).toContain('Incident boom');
    expect(notices[1]!.textContent).toContain('This generation is stale (source 3, current 7).');
    expect(notices[2]!.textContent).toContain('Partial level · bounded continuation available');

    // All three are siblings under the same flow container — not independently offset elements.
    const parent = notices[0]!.parentElement!;
    expect(notices.every((notice) => notice.parentElement === parent)).toBe(true);
    expect(parent.style.display).toBe('flex');
    expect(parent.style.flexDirection).toBe('column');
    // No notice computes its own position — only the shared container is positioned.
    for (const notice of notices) {
      expect((notice as HTMLElement).style.position).toBe('');
      expect((notice as HTMLElement).style.top).toBe('');
      expect((notice as HTMLElement).style.left).toBe('');
    }

    // The former standalone "load more in community" button is now this notice's inline action.
    const continueAction = notices[2]!.querySelector('button')!;
    expect(continueAction.textContent).toBe('continue');
    act(() => continueAction.click());
    await tick();
    expect(api.memoryConstellationV2Community).toHaveBeenCalledWith('p1', 'root', expect.objectContaining({ cursor: 'more' }), undefined);
  });

  it('stacks building and informational (unindexed) notices together at root, in severity order, without reading each other\'s presence', async () => {
    const buildingRevision: ApiConstellationV2Revision = { ...revision, state: 'building' };
    // No file/symbol/repository counts anywhere, so codeEntities === 0 at root.
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision: buildingRevision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    const notices = [...host.querySelectorAll('[role="status"]')];
    expect(notices).toHaveLength(2);
    expect(notices[0]!.textContent).toContain('A newer hierarchy is building; this complete generation remains navigable.');
    expect(notices[1]!.textContent).toContain('No repository entities are present in this generation; repository indexing may not have run.');
    expect(notices[0]!.parentElement).toBe(notices[1]!.parentElement);
    // Note: the accessible-list <details> panel (Space view only) is unreachable in this file's
    // suite — the top-of-file MemoryConstellation3D mock always fires onRendererFailure, which
    // forces Catalogue. Its no-longer-conditional `top: 42` offset is verified by reading the
    // component source, not by a DOM assertion here.
  });
});
