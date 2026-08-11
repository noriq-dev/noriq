import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiConstellationV2CommunityPage, type ApiConstellationV2Revision } from '../api';

// Mutable via `vi.hoisted` so individual tests can reach Space view (the mock stays a WebGL-free
// stand-in either way — real MemoryConstellation3D needs a WebGL context jsdom cannot provide —
// but most of this file wants the always-reachable Catalogue peer, and only the legend test
// (PLNR-438, Space-view-only chrome) needs to opt out of the forced failure).
const mockRenderer3D = vi.hoisted(() => ({ failOnMount: true }));
vi.mock('./MemoryConstellation3D', () => ({
  default: (props: { onRendererFailure?: (reason: string) => void }) => {
    useEffect(() => { if (mockRenderer3D.failOnMount) props.onRendererFailure?.('WebGL2 unavailable in test'); }, [props.onRendererFailure]);
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
  mockRenderer3D.failOnMount = true;
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
    // Fixed severity order: error -> stale -> building -> partial -> informational (Navigator
    // conventions doc §3). error/stale/partial are reachable simultaneously here, plus the renderer
    // failure this suite's default MemoryConstellation3D mock always triggers (PLNR-442: the
    // failure reason now rides this SAME status region, informational severity, rather than a
    // separate ad hoc box).
    expect(notices).toHaveLength(4);
    expect(notices[0]!.textContent).toContain('Incident boom');
    expect(notices[1]!.textContent).toContain('This generation is stale (source 3, current 7).');
    expect(notices[2]!.textContent).toContain('Partial level · bounded continuation available');
    expect(notices[3]!.textContent).toContain('3D view unavailable — textual navigation remains active');

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
    // Two informational-severity notices land together here: the pre-existing "no repository
    // entities" note, and (PLNR-442) the renderer-failure notice this suite's default mock always
    // triggers — both truthful capability statements, same tier, same container.
    expect(notices).toHaveLength(3);
    expect(notices[0]!.textContent).toContain('A newer hierarchy is building; this complete generation remains navigable.');
    expect(notices[1]!.textContent).toContain('No repository entities are present in this generation; repository indexing may not have run.');
    expect(notices[2]!.textContent).toContain('3D view unavailable — textual navigation remains active');
    expect(notices[0]!.parentElement).toBe(notices[1]!.parentElement);
    expect(notices[1]!.parentElement).toBe(notices[2]!.parentElement);
  });
});

describe('MemoryConstellationV2 encoding legend (PLNR-438)', () => {
  it('states the five primary type rows plus the size/brightness/halo/route sentence, and can be toggled', async () => {
    // Opts out of the file's default forced-failure mock so Space view (where the legend lives)
    // is actually reachable — this is the one thing in this suite that needs it.
    mockRenderer3D.failOnMount = false;
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    // Space view actually rendered (no forced Catalogue fallback this time).
    expect(host.textContent).not.toContain('3D view unavailable');
    const legend = host.querySelector('[aria-label="Constellation encoding legend"]') as HTMLElement;
    expect(legend).toBeTruthy();

    // Default open (this task's discretion) — every primary row from the Navigator conventions
    // doc §1 table, reading the exact same encoding table the renderer draws from.
    expect(legend.textContent).toContain('memory');
    expect(legend.textContent).toContain('task');
    expect(legend.textContent).toContain('doc');
    expect(legend.textContent).toContain('file');
    expect(legend.textContent).toContain('plan');
    expect(legend.textContent).toContain('size = connectivity · brightness = authority');
    expect(legend.textContent).toContain('amber halo = lead · amber route = selection');

    // Toggleable, per the screen spec ("which the design exposes as a toggle").
    const toggle = legend.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(legend.textContent).not.toContain('size = connectivity');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(legend.textContent).toContain('size = connectivity · brightness = authority');
  });
});

describe('MemoryConstellationV2 selection inspector overlay (PLNR-462)', () => {
  it('overlays the full-width canvas without a pointer-catching backdrop and keeps relationship coverage honest through a continuation', async () => {
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    vi.spyOn(api, 'memoryConstellationV2Community').mockResolvedValue(page('a', null));
    vi.spyOn(api, 'memoryConstellationV2Incidents').mockImplementation(async (_pid, _nodeId, input) => (input?.cursor ? {
      revision, node: { nodeId: 'a', uri: 'noriq://memory/a', type: 'memory', label: 'Memory a', communityPath: [] },
      edges: [{ edgeId: 'e2', type: 'related_to', direction: 'outgoing', provenance: null, endpoint: { nodeId: 'x2', uri: 'noriq://task/x2', type: 'task', label: 'Task X2', communityPath: [] } }],
      nextCursor: null, coverage: { complete: true, reasons: [] },
    } : {
      revision, node: { nodeId: 'a', uri: 'noriq://memory/a', type: 'memory', label: 'Memory a', communityPath: [] },
      edges: [{ edgeId: 'e1', type: 'references', direction: 'outgoing', provenance: null, endpoint: { nodeId: 'x1', uri: 'noriq://task/x1', type: 'task', label: 'Task X1', communityPath: [] } }],
      nextCursor: 'more', coverage: { complete: false, reasons: ['page-limit-reached'] },
    }));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    const openRoot = [...host.querySelectorAll('button')].find((button) => button.textContent === 'open')!;
    act(() => openRoot.click());
    await tick(); await tick();

    const entityRow = [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Memory a'))!;
    act(() => entityRow.click());
    await tick(); await tick();

    const inspector = host.querySelector('[aria-label="Selection inspector"]') as HTMLElement;
    expect(inspector).toBeTruthy();
    expect(inspector.style.position).toBe('absolute');
    expect(inspector.style.top).toBe('0px');
    expect(inspector.style.right).toBe('0px');
    expect(inspector.style.bottom).toBe('0px');
    expect(inspector.style.width).toBe('320px');
    expect(inspector.style.pointerEvents).toBe('auto');
    const canvasLayer = inspector.previousElementSibling as HTMLElement;
    expect(canvasLayer.style.position).toBe('absolute');
    expect(canvasLayer.style.inset).toBe('0');
    expect(inspector.parentElement!.style.position).toBe('relative');
    // No sibling around the aside covers the canvas to capture events outside the panel's box.
    expect(inspector.parentElement!.style.pointerEvents).toBe('');

    // The `entity()` fixture carries degree: 1, which the live cursor (still open) immediately
    // proves too low — the honest denominator corrects UP to match what is actually loaded rather
    // than parroting a stale snapshot number.
    expect(inspector.textContent).toContain('Relationships · 1 of 1');
    const loadMore = [...inspector.querySelectorAll('button')].find((button) => button.textContent?.startsWith('load next page'))!;
    act(() => loadMore.click());
    await tick(); await tick();
    expect(api.memoryConstellationV2Incidents).toHaveBeenCalledWith('p1', 'a', expect.objectContaining({ cursor: 'more' }), expect.any(AbortSignal));
    // The continuation completed (nextCursor null) — coverage is now exact, and the action is gone.
    expect(inspector.textContent).toContain('Relationships · 2 of 2');
    expect([...inspector.querySelectorAll('button')].some((button) => button.textContent?.startsWith('load next page'))).toBe(false);
  });

  it('shows the community aggregate view (never a relationship list) and wires "open community" through the same expand path the catalogue row uses', async () => {
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    vi.spyOn(api, 'memoryConstellationV2Community').mockResolvedValue(page('a', null));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    const communityRow = [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Root community'))!;
    act(() => communityRow.click());
    await tick();

    const inspector = host.querySelector('[aria-label="Selection inspector"]') as HTMLElement;
    expect(inspector.textContent).toContain('Root community');
    expect(inspector.textContent).toContain('2 entities');
    expect(inspector.textContent).not.toContain('Relationships');

    const openCommunity = [...inspector.querySelectorAll('button')].find((button) => button.textContent === 'open community')!;
    act(() => openCommunity.click());
    await tick(); await tick();
    // Same `expand()`/`api.memoryConstellationV2Community` path the catalogue row's own "open"
    // button already drives — the dock is a lens onto the existing expansion, not a second one.
    expect(api.memoryConstellationV2Community).toHaveBeenCalledWith('p1', 'root', expect.objectContaining({ limit: 256 }), undefined);
    expect(host.textContent).toContain('level 1');
  });
});

describe('MemoryConstellationV2 Catalogue as a designed peer view (PLNR-442)', () => {
  it('is selectable from the header while the renderer is healthy (not only entered by failure), switches back to Space, and the old <details> disclosure is gone entirely', async () => {
    mockRenderer3D.failOnMount = false; // renderer succeeds — no forced Catalogue
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    expect(host.textContent).not.toContain('3D view unavailable');
    // No disclosure widget anywhere — its function is fully absorbed by the Catalogue view
    // (audit doc pdoc_msopdg2u602z4b0q3i2n, "Fallbacks" disposition: Delete).
    expect(host.querySelector('details')).toBeNull();

    const spaceToggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Space')!;
    const catalogueToggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Catalogue')!;
    // Deliberately choosable — the Space segment is enabled (not the disabled-by-failure state).
    expect(spaceToggle.disabled).toBe(false);
    expect(catalogueToggle.getAttribute('aria-pressed')).toBe('false');

    act(() => catalogueToggle.click());
    await tick();
    expect(catalogueToggle.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[role="region"][aria-label="Textual memory constellation"]')).toBeTruthy();
    expect(host.textContent).toContain('Root community');
    // No renderer-failure notice: this is a deliberate choice, not a degradation. (The fixture's
    // root community has no file/symbol/repository counts, so the unrelated "unindexed" notice is
    // still legitimately present — this assertion is specifically about the renderer.)
    expect(host.textContent).not.toContain('3D view unavailable');
    expect(host.querySelector('details')).toBeNull();

    act(() => spaceToggle.click());
    await tick();
    expect(spaceToggle.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[role="region"][aria-label="Textual memory constellation"]')).toBeNull();
  });

  it('names the renderer failure as a status notice sharing the SAME severity-ordered region as every other truthful-degradation message, not a separate ad hoc box', async () => {
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    // Two informational-severity notices legitimately coexist with this fixture: the pre-existing
    // "no repository entities" note (the root community fixture has no file/symbol/repository
    // counts) and the renderer-failure notice this test is actually about — same tier, same
    // container, neither reads a pixel offset from the other's presence.
    const notices = [...host.querySelectorAll('[role="status"]')];
    expect(notices).toHaveLength(2);
    const failureNotice = notices.find((notice) => notice.textContent?.includes('3D view unavailable'))!;
    expect(failureNotice).toBeTruthy();
    expect(failureNotice.textContent).toContain('3D view unavailable — textual navigation remains active');
    expect(failureNotice.textContent).toContain('WebGL2 unavailable in test');
    // Same styled chip element every other notice uses — no bespoke bordered box.
    expect(failureNotice.getAttribute('role')).toBe('status');
    expect(failureNotice.parentElement).toBe(notices[0]!.parentElement);
  });
});

describe('MemoryConstellationV2 status notice does not overlap Catalogue rows (PLNR-449)', () => {
  it('promotes the status region into a flow slot above Catalogue instead of an overlay pinned on top of its rows', async () => {
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    // This suite's default mock forces Catalogue (renderer failure on mount) and the fixture root
    // community has members, so Catalogue actually renders a row the old overlay would sit on top of.
    const catalogueRegion = host.querySelector('[role="region"][aria-label="Textual memory constellation"]') as HTMLElement;
    expect(catalogueRegion).toBeTruthy();

    const notices = [...host.querySelectorAll('[role="status"]')];
    expect(notices.length).toBeGreaterThan(0);
    const noticeContainer = notices[0]!.parentElement!;

    // The notice stack is a normal-flow sibling ABOVE Catalogue, not an absolute overlay pinned at
    // left:14/top:12 on top of it — it carries no position/top/left of its own, and its height is
    // reserved by ordinary box layout, not by measuring anything.
    expect(noticeContainer.style.position).not.toBe('absolute');
    expect(noticeContainer.style.top).toBe('');
    expect(noticeContainer.style.left).toBe('');
    expect(noticeContainer.style.flex).toBe('0 0 auto'); // React's `flex: 'none'` shorthand, as jsdom expands it

    // Document order: the notice block precedes the Catalogue region — genuinely above it in flow,
    // not stacked on top of it via z-index.
    const position = noticeContainer.compareDocumentPosition(catalogueRegion);
    expect(Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    // Catalogue's own wrapper fills the REMAINING space below the notices (flex:1) — a fixed
    // structural sibling relationship, not a measured offset (the PLNR-436 pattern this must not
    // reintroduce).
    const catalogueFlexWrapper = catalogueRegion.parentElement!;
    expect(catalogueFlexWrapper.style.flex).toBe('1 1 0%'); // React's `flex: 1` shorthand, as jsdom expands it
  });

  it('leaves Space\'s status region as the unchanged translucent overlay, since nothing else occupies that corner there', async () => {
    mockRenderer3D.failOnMount = false; // renderer healthy — real Space view reachable
    const buildingRevision: ApiConstellationV2Revision = { ...revision, state: 'building' };
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision: buildingRevision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    expect(host.textContent).not.toContain('3D view unavailable');
    const notices = [...host.querySelectorAll('[role="status"]')];
    expect(notices.length).toBeGreaterThan(0);
    const noticeContainer = notices[0]!.parentElement!;
    expect(noticeContainer.style.position).toBe('absolute');
    expect(noticeContainer.style.left).toBe('14px');
    expect(noticeContainer.style.top).toBe('12px');
  });

  it('keeps the overlay (not the flow slot) when the hierarchy is empty, since there are no Catalogue rows to collide with', async () => {
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [], routes: [], coverage: { complete: true, reasons: [] } });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    expect(host.textContent).toContain('No memory entities are present in this completed generation.');
    const notices = [...host.querySelectorAll('[role="status"]')];
    expect(notices.length).toBeGreaterThan(0);
    const noticeContainer = notices[0]!.parentElement!;
    expect(noticeContainer.style.position).toBe('absolute');
  });
});

describe('MemoryConstellationV2 search ignite (PLNR-441)', () => {
  const hit = (overrides: Partial<{ id: string; uri: string; title: string }> = {}) => ({
    entityType: 'memory' as const, id: overrides.id ?? 'x', uri: overrides.uri ?? 'noriq://memory/x', kind: 'learning',
    title: overrides.title ?? 'Root memory X', snippet: '', stage: 'lexical' as const, score: 1, isLead: false, leadReasons: [], finalScore: 1,
  });
  const searchResult = (results: ReturnType<typeof hit>[]) => ({
    mode: 'keyword' as const, results, evidenceFrame: { text: '', itemsIncluded: 0, itemsOmitted: 0, truncated: false, charsUsed: 0, suspiciousCount: 0 },
  });
  const typeInto = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  it('states the total matches and community spread up front, marks the top hit, and names an off-page hit\'s routing community before it is picked', async () => {
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    // At root level nothing is resident, so `noriq://memory/x`'s only community exists via this
    // route lookup — the same endpoint focusHit already calls on pick, reused here purely to know
    // where the match lives before it is picked.
    vi.spyOn(api, 'memoryConstellationV2Route').mockResolvedValue({ revision, nodeId: 'x', uri: 'noriq://memory/x', communityPath: [rootCommunity] });
    vi.spyOn(api, 'memorySearch').mockResolvedValue(searchResult([hit()]));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    const search = host.querySelector('input[placeholder^="Search memory"]') as HTMLInputElement;
    typeInto(search, 'root');
    await tick(350); await tick(); await tick(); await tick();

    // The count and the community spread are stated BEFORE any dimming could be mistaken for a
    // filter having removed anything (Navigator conventions doc §4 "dimming is not filtering").
    // This suite's default mock forces Catalogue (renderer failure on mount), so this exercises
    // the TEXTUAL equivalent (PLNR-442): a flat list has no field to dim, so unmatched rows are
    // simply left unmarked rather than dimmed — never silently shortened to matches-only.
    expect(host.textContent).toContain('1 match ignited across 1 community · non-matches unmarked, not removed');

    const panel = host.querySelector('[aria-label="Search matches"]') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('1 · hybrid + exact URI');
    expect(panel.textContent).toContain('↵ focuses top');

    const row = [...panel.querySelectorAll('button')].find((button) => button.textContent?.includes('Root memory X'))!;
    // The Enter target is visually distinguished by more than colour alone (a border, not just a tint).
    expect(row.style.borderLeft).toContain('var(--accent)');
    // Off-page: not yet loaded anywhere on canvas, so picking it will fly the camera and load pages —
    // the routing community is named before that flight is committed to.
    expect(row.textContent).toContain('off-page · picking it routes via Root community');
  });

  it('does not call an already-resident match off-page, and Enter routes the top hit exactly like a click', async () => {
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    vi.spyOn(api, 'memoryConstellationV2Community').mockResolvedValue(page('a', null));
    vi.spyOn(api, 'memoryConstellationV2Route').mockResolvedValue({ revision, nodeId: 'a', uri: 'noriq://memory/a', communityPath: [rootCommunity] });
    vi.spyOn(api, 'memoryConstellationV2Incidents').mockResolvedValue({ revision, node: { nodeId: 'a', uri: 'noriq://memory/a', type: 'memory', label: 'Memory a', communityPath: [rootCommunity] }, edges: [], nextCursor: null, coverage: { complete: true, reasons: [] } });
    vi.spyOn(api, 'memorySearch').mockResolvedValue(searchResult([hit({ id: 'a', uri: 'noriq://memory/a', title: 'Memory a' })]));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    const openRoot = [...host.querySelectorAll('button')].find((button) => button.textContent === 'open')!;
    act(() => openRoot.click());
    await tick(); await tick();

    const search = host.querySelector('input[placeholder^="Search memory"]') as HTMLInputElement;
    typeInto(search, 'memory a');
    await tick(350); await tick(); await tick();

    const panel = host.querySelector('[aria-label="Search matches"]') as HTMLElement;
    const row = [...panel.querySelectorAll('button')].find((button) => button.textContent?.includes('Memory a'))!;
    // Resident (entity 'a' is on the currently loaded page) — the flight would be a no-op, so it
    // must never be labelled off-page.
    expect(row.textContent).not.toContain('off-page');

    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await tick(); await tick();
    // Same exact-URI route focusHit's click path already uses — preserved exactly, just reachable
    // from the keyboard too, matching the results header's own "↵ focuses top" hint.
    expect(api.memoryConstellationV2Route).toHaveBeenCalledWith('p1', 'noriq://memory/a');
  });

  it('replaces the encoding legend with the ignite legend while a search is active, and restores it when the query clears', async () => {
    mockRenderer3D.failOnMount = false; // reach Space view, where the legend lives (PLNR-438 precedent)
    vi.spyOn(api, 'memoryConstellationV2Overview').mockResolvedValue({ revision, communities: [rootCommunity], routes: [], coverage: { complete: true, reasons: [] } });
    vi.spyOn(api, 'memoryConstellationV2Route').mockResolvedValue({ revision, nodeId: 'x', uri: 'noriq://memory/x', communityPath: [rootCommunity] });
    vi.spyOn(api, 'memorySearch').mockResolvedValue(searchResult([hit()]));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<MemoryConstellationV2 pid="p1" />));
    await tick(); await tick();

    expect(host.querySelector('[aria-label="Constellation encoding legend"]')).toBeTruthy();

    const search = host.querySelector('input[placeholder^="Search memory"]') as HTMLInputElement;
    typeInto(search, 'root');
    await tick(350); await tick(); await tick();

    const igniteLegend = host.querySelector('[aria-label="Constellation ignite legend"]') as HTMLElement;
    expect(igniteLegend).toBeTruthy();
    expect(host.querySelector('[aria-label="Constellation encoding legend"]')).toBeFalsy();
    expect(igniteLegend.textContent).toContain('flare + count = matches inside community');
    expect(igniteLegend.textContent).toContain('field dims to 32% — off-page truth preserved');

    typeInto(search, '');
    await tick(350); await tick();
    expect(host.querySelector('[aria-label="Constellation encoding legend"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="Constellation ignite legend"]')).toBeFalsy();
  });
});
