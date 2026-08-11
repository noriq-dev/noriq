import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConstellationV2CommunityPage, ApiConstellationV2Revision } from '../api';
import type { Constellation3DNode } from './constellation-3d-buffers';
import { ConstellationCatalogue } from './ConstellationCatalogue';

const revision: ApiConstellationV2Revision = {
  contract: 'constellation-v2', generationId: 'g1', sourceRevision: 1, currentRevision: 1,
  topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1', state: 'current', generatedAt: 'now',
};

const memoryEntity: Constellation3DNode = {
  id: 'a', uri: 'noriq://memory/a', label: 'API keys are OAuth-only', type: 'memory',
  position: [0, 0, 0], degree: 23, authority: 5, validity: 'active', isLead: false,
};
const taskEntity: Constellation3DNode = {
  id: 't', uri: 'noriq://task/t1', label: 'Ship the rate limiter', type: 'task',
  position: [0, 0, 0], degree: 4, authority: null, validity: null, isLead: false,
};
const community: Constellation3DNode = {
  id: 'c1', uri: null, label: 'Coordination core', type: 'community', position: [0, 0, 0], degree: 9,
  community: true, memberCount: 120, typeCounts: { task: 80, memory: 40 }, boundaryRouteCount: 14,
};
// PLNR-452: the same stand-in shape constellation-v2-scene.ts's `assembleConstellationV2Scene`
// creates for an off-page incident edge's non-resident endpoint — a REAL community's id/label/
// counts (never fabricated), just not resident at the current level, with `offPageStandIn: true`
// so the canvas (PLNR-448) and now Catalogue both know not to treat it as an ordinary loaded row.
const offPageCommunity: Constellation3DNode = {
  id: 'c2', uri: null, label: 'Ask subsystem', type: 'community', position: [0, 0, 0], degree: 3,
  community: true, memberCount: 512, typeCounts: { task: 400 }, boundaryRouteCount: 0, offPageStandIn: true,
};

const communityPage = (overrides: Partial<ApiConstellationV2CommunityPage> = {}): ApiConstellationV2CommunityPage => ({
  revision,
  community: { id: 'c1', parentId: null, level: 0, label: 'Coordination core', memberCount: 120, childCommunityCount: 0, typeCounts: { task: 80, memory: 40 }, internalEdgeCount: 9, internalWeight: 1, normalizedCohesion: 1, boundaryWeight: 0, anchor: [0, 0, 0] },
  kind: 'entities', communities: [], entities: [], backboneEdges: [], routes: [], externalCommunities: [],
  nextCursor: null, coverage: { complete: true, reasons: [] },
  ...overrides,
});

let host: HTMLDivElement;
let root: Root | null = null;

afterEach(() => { act(() => root?.unmount()); root = null; host?.remove(); vi.restoreAllMocks(); });

function render(props: Partial<React.ComponentProps<typeof ConstellationCatalogue>> = {}) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root!.render(
    <ConstellationCatalogue
      nodes={[memoryEntity, taskEntity, community]}
      highlightedNodeIds={new Set()}
      matchCounts={new Map()}
      searchActive={false}
      selectedNodeId={null}
      currentPage={null}
      expanding={false}
      onSelectNode={() => {}}
      onExpandCommunity={() => {}}
      onLoadNextPage={() => {}}
      {...props}
    />,
  ));
}

describe('ConstellationCatalogue rows (PLNR-442)', () => {
  it('carries type chip/glyph, canonical URI, degree, authority and validity per entity row, using the shared encoding', () => {
    render();
    expect(host.textContent).toContain('API keys are OAuth-only');
    expect(host.textContent).toContain('noriq://memory/a');
    expect(host.textContent).toContain('degree 23');
    expect(host.textContent).toContain('human-approved'); // authority 5
    expect(host.textContent).toContain('validity active');
    // Shared encoding table (constellation-encoding.ts) — a memory row carries the same shape glyph
    // and label the 3D renderer and the legend both draw from (PLNR-437 "same colour source").
    expect(host.textContent).toContain('memory');

    // A task entity with null authority/validity omits those fields rather than rendering "null".
    expect(host.textContent).toContain('Ship the rate limiter');
    expect(host.textContent).toContain('degree 4');
    expect(host.textContent).not.toContain('null');
  });

  it('marks a community row as community (not a bare type) and shows its member count, without a relationship list', () => {
    render();
    expect(host.textContent).toContain('Coordination core');
    expect(host.textContent).toContain('community');
    expect(host.textContent).toContain('120 entities');
    // Communities have no degree/authority/validity line — that vocabulary is entity-only.
    const communityButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Coordination core'))!;
    expect(communityButton.textContent).not.toContain('degree');
  });

  it('every interactive control is a real <button> (keyboard reachability falls out of ordinary DOM structure)', () => {
    render({ currentPage: communityPage({ nextCursor: 'more' }) });
    const interactiveLikelyElements = [...host.querySelectorAll('[onclick], [role="button"]')];
    expect(interactiveLikelyElements).toHaveLength(0); // nothing faking a button
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      // No manual tabIndex tampering — default browser tab order applies, so every control is
      // reachable purely from being a real, undisabled <button> in normal DOM order.
      expect(button.hasAttribute('tabindex')).toBe(false);
      expect(button.disabled).toBe(false);
    }
  });
});

describe('ConstellationCatalogue community rows expandable inline (PLNR-442)', () => {
  it('toggles an inline preview (entity count, boundary routes, top type chips) without navigating or firing onExpandCommunity', () => {
    const onExpandCommunity = vi.fn();
    render({ nodes: [community], onExpandCommunity });
    expect(host.textContent).not.toContain('boundary routes');

    const toggle = host.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('120 entities · 14 boundary routes');
    expect(host.textContent).toContain('task'); // top type count row
    expect(onExpandCommunity).not.toHaveBeenCalled();

    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('boundary routes');
  });

  it('still lets "open" descend into the community via the same onExpandCommunity/expand path as before, independent of the preview toggle', () => {
    const onExpandCommunity = vi.fn();
    render({ nodes: [community], onExpandCommunity });
    const open = [...host.querySelectorAll('button')].find((button) => button.textContent === 'open')!;
    act(() => open.click());
    expect(onExpandCommunity).toHaveBeenCalledWith('c1');
  });
});

describe('ConstellationCatalogue off-page stand-in rows (PLNR-452)', () => {
  it('labels an off-page stand-in row instead of showing its member count, and hides the preview toggle', () => {
    render({ nodes: [offPageCommunity] });
    expect(host.textContent).toContain('Ask subsystem');
    expect(host.textContent).toContain('off-page ▸');
    expect(host.textContent).not.toContain('512 entities');
    // No preview disclosure control — the stand-in's boundaryRouteCount is never computed
    // (constellation-v2-scene.ts), so a preview would show a fabricated "0 boundary routes"
    // rather than the truthful "not known here".
    expect(host.querySelector('button[aria-expanded]')).toBeNull();
  });

  it('keeps the off-page row\'s "open" action wired — the stand-in id is a real, navigable community', () => {
    const onExpandCommunity = vi.fn();
    render({ nodes: [offPageCommunity], onExpandCommunity });
    const open = [...host.querySelectorAll('button')].find((button) => button.textContent === 'open')!;
    act(() => open.click());
    expect(onExpandCommunity).toHaveBeenCalledWith('c2');
  });

  it('does not affect an ordinary resident community row in the same list', () => {
    render({ nodes: [community, offPageCommunity] });
    expect(host.textContent).toContain('120 entities');
    expect(host.querySelectorAll('button[aria-expanded]')).toHaveLength(1); // only the resident row gets a preview toggle
  });
});

describe('ConstellationCatalogue coverage honesty (PLNR-442)', () => {
  it('states remaining count on the load-next-page action rather than a bare "load more"', () => {
    const onLoadNextPage = vi.fn();
    render({
      nodes: [memoryEntity],
      currentPage: communityPage({ entities: [{ nodeId: 'a', uri: 'noriq://memory/a', type: 'memory', kind: 'learning', label: memoryEntity.label, authority: 5, validity: 'active', isLead: false, leadReasons: [], degree: 23, boundaryDegree: 0, groupKey: 'memory', communityId: 'c1', position: [0, 0, 0] }], nextCursor: 'cursor-2' }),
      onLoadNextPage,
    });
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('load next catalogue page'))!;
    expect(button.textContent).toBe('load next catalogue page · 119 more');
    act(() => button.click());
    expect(onLoadNextPage).toHaveBeenCalled();
  });

  it('omits the load-next-page action once the cursor is exhausted (never a dangling control)', () => {
    render({ nodes: [memoryEntity], currentPage: communityPage({ nextCursor: null }) });
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.startsWith('load next catalogue page'))).toBe(false);
  });
});

describe('ConstellationCatalogue search-ignite textual equivalent (PLNR-442)', () => {
  it('never removes a non-matching row — every node stays listed, only matches are marked', () => {
    render({
      nodes: [memoryEntity, taskEntity, community],
      highlightedNodeIds: new Set(['a']),
      matchCounts: new Map(),
      searchActive: true,
    });
    // All three rows are still present — dimming-is-not-filtering's textual equivalent never
    // shortens the list to matches-only.
    expect(host.textContent).toContain('API keys are OAuth-only');
    expect(host.textContent).toContain('Ship the rate limiter');
    expect(host.textContent).toContain('Coordination core');

    const matchTags = [...host.querySelectorAll('span')].filter((span) => span.textContent === 'match');
    expect(matchTags).toHaveLength(1); // only the matched entity carries the ignite mark
  });

  it('shows a community\'s match count subtext, mirroring the overview scene\'s own "+N matches" flare', () => {
    render({
      nodes: [community],
      highlightedNodeIds: new Set(['c1']),
      matchCounts: new Map([['c1', 7]]),
      searchActive: true,
    });
    expect(host.textContent).toContain('+7 matches');
  });

  it('marks nothing when a search is not active, even if highlightedNodeIds is non-empty (stale ignite state from a cleared query)', () => {
    render({ nodes: [memoryEntity], highlightedNodeIds: new Set(['a']), searchActive: false });
    expect([...host.querySelectorAll('span')].some((span) => span.textContent === 'match')).toBe(false);
  });
});

describe('ConstellationCatalogue reachable handoffs (PLNR-442)', () => {
  it('wires select, ego and evidence for a memory entity, and select + ego only (no evidence) for a non-memory entity', () => {
    const onSelectNode = vi.fn();
    const onOpenEgoNetwork = vi.fn();
    const onOpenInspector = vi.fn();
    render({ nodes: [memoryEntity, taskEntity], onSelectNode, onOpenEgoNetwork, onOpenInspector });

    const memoryRow = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('API keys are OAuth-only'))!.parentElement!;
    const selectButton = [...memoryRow.querySelectorAll('button')].find((b) => b.textContent?.startsWith('API keys are OAuth-only'))!;
    act(() => selectButton.click());
    expect(onSelectNode).toHaveBeenCalledWith('a');
    const evidenceButton = [...memoryRow.querySelectorAll('button')].find((b) => b.textContent === 'evidence')!;
    act(() => evidenceButton.click());
    expect(onOpenInspector).toHaveBeenCalledWith('noriq://memory/a');
    const egoButton = [...memoryRow.querySelectorAll('button')].find((b) => b.textContent === 'ego')!;
    act(() => egoButton.click());
    expect(onOpenEgoNetwork).toHaveBeenCalledWith('noriq://memory/a');

    const taskRow = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Ship the rate limiter'))!.parentElement!;
    expect([...taskRow.querySelectorAll('button')].some((b) => b.textContent === 'evidence')).toBe(false);
    expect([...taskRow.querySelectorAll('button')].some((b) => b.textContent === 'ego')).toBe(true);
  });
});
