import { describe, expect, it } from 'vitest';
import {
  aggregateRouteWidth, buildConstellation3DRenderPlan, communityEntitySubtext, communityIgniteSubtext, communityTooltipContent,
  constellation3DColorType, constellation3DIsDimmed, constellation3DNodeEncoding, CONSTELLATION_IGNITE_DIM_OPACITY,
  dominantCommunityType, isOffPageIncidentEdge, placeConstellation3DLabels, promotedEdgeLabelText, truncateConstellationLabel,
  type Constellation3DEdge, type Constellation3DLabelCandidate, type Constellation3DNode,
} from './constellation-3d-buffers';

const node = (id: string, type = 'task', overrides: Partial<Constellation3DNode> = {}): Constellation3DNode => ({
  id, uri: `noriq://${type}/${id}`, label: id, type, position: [id.charCodeAt(0), 0, 0], degree: 1, ...overrides,
});
describe('constellation 3D buffer planning', () => {
  it('keeps type, authority, lead, and validity legible without relying on colour', () => {
    const memory = constellation3DNodeEncoding(node('m', 'memory', { authority: 5, isLead: true, validity: 'stale', degree: 12 }));
    const task = constellation3DNodeEncoding(node('t', 'task', { authority: null, isLead: false, validity: 'active', degree: 1 }));
    expect(memory.shape).toBe('sphere');
    expect(task.shape).toBe('box');
    expect(memory.scale).toBeGreaterThan(task.scale);
    expect(memory.halo).toBe(true);
    expect(memory.opacity).toBeLessThan(task.opacity);
  });

  it('submits selected incidents in the final promoted pass while retaining direction and type', () => {
    const nodes = [node('a'), node('b', 'memory'), node('c', 'file')];
    const edges: Constellation3DEdge[] = [
      { id: 'selected', fromId: 'a', toId: 'b', type: 'observed_in', direction: 'reverse', weight: 3, aggregate: false },
      { id: 'unrelated', fromId: 'b', toId: 'c', type: 'depends_on', direction: 'forward', weight: 2, aggregate: true },
    ];
    const plan = buildConstellation3DRenderPlan(nodes, edges, 'a');
    expect(plan.baseEdges).toMatchObject([{ id: 'unrelated', state: 'unrelated-dimmed', opacity: 0.1 }]);
    expect(plan.promotedEdges).toMatchObject([{ id: 'selected', type: 'observed_in', direction: 'reverse', state: 'selected-incident', directionMarker: true }]);
    expect(plan.promotedEdges[0]!.width).toBeGreaterThan(plan.baseEdges[0]!.width);
    // The renderer submits baseEdges first and promotedEdges second; neither array creates a
    // Three object per relationship.
    expect(plan.baseEdges.length + plan.promotedEdges.length).toBe(edges.length);
  });

  it('groups a resident 12k-node scene into bounded draw calls and labels', () => {
    const types = ['task', 'memory', 'file', 'error', 'unknown'];
    const nodes = Array.from({ length: 12_000 }, (_, index) => node(`n${index}`, types[index % types.length], {
      position: [index % 100, Math.floor(index / 100), index % 31], degree: index % 20,
      validity: index % 11 === 0 ? 'stale' : 'active', isLead: index % 97 === 0,
    }));
    const plan = buildConstellation3DRenderPlan(nodes, [], 'n9999', 24);
    expect(plan.nodeCount).toBe(12_000);
    expect(plan.nodeGroups.size).toBeLessThanOrEqual(5);
    // No community node is present in this fixture, so PLNR-438's gravity-well falloff and
    // aggregate-route tube passes contribute nothing here — the ceiling stays exactly what it was
    // before PLNR-438 (nodeGroups.size*2 + halo + 3).
    expect(plan.drawCallCeiling).toBeLessThanOrEqual(14);
    expect(plan.labels).toHaveLength(24);
    expect(plan.labels[0]!.id).toBe('n9999');
  });

  it('keeps the overview scene (communities + aggregate routes, PLNR-371/438) within the same 14-draw-call ceiling', () => {
    // Nine communities, matching the actual root overview reference frame — the scene this task
    // adds the most rendering work to (gravity-well falloff, aggregate-route tubes).
    const communities = Array.from({ length: 9 }, (_, index) => node(`c${index}`, 'community', {
      community: true, position: [index * 10, 0, 0], degree: 5 + index,
      memberCount: 100 * (index + 1), typeCounts: { task: 5 + index, memory: 3, file: 1 },
    }));
    const routes: Constellation3DEdge[] = Array.from({ length: 8 }, (_, index) => ({
      id: `r${index}`, fromId: `c${index}`, toId: `c${index + 1}`, type: 'related_to',
      direction: 'forward', weight: 1 + index * 2, aggregate: true,
    }));
    const plan = buildConstellation3DRenderPlan(communities, routes, null, 24);
    expect(plan.nodeGroups.size).toBe(1); // every community renders as the single 'sphere' shape
    expect(plan.drawCallCeiling).toBeLessThanOrEqual(14);
    // Route width maps continuously to boundary weight (locked decision), min/max-normalized
    // against the 0.8–2.4 screen-spec range.
    expect(plan.baseEdges[0]!.width).toBeCloseTo(0.8);
    expect(plan.baseEdges.at(-1)!.width).toBeCloseTo(2.4);
    expect(plan.baseEdges.every((edge) => edge.width >= 0.8 - 1e-9 && edge.width <= 2.4 + 1e-9)).toBe(true);
  });

  it('gives a plan with one uniform aggregate weight the midpoint width rather than dividing by zero', () => {
    const nodes = [node('a', 'community', { community: true }), node('b', 'community', { community: true })];
    const edges: Constellation3DEdge[] = [{ id: 'r', fromId: 'a', toId: 'b', type: 'related_to', direction: 'forward', weight: 5, aggregate: true }];
    const plan = buildConstellation3DRenderPlan(nodes, edges, null);
    expect(plan.baseEdges[0]!.width).toBe(1.6);
  });
});

describe('constellation 3D DOM label placement (PLNR-454)', () => {
  const overlaps = (a: Constellation3DLabelCandidate, b: Constellation3DLabelCandidate, gap: number) =>
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap
    && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap;

  it('greedily culls a 30-label cluster without overlap, deterministically preserving selected/promoted priority', () => {
    const ambient: Constellation3DLabelCandidate[] = Array.from({ length: 30 }, (_, index) => ({
      key: `ambient-${index}`, x: 100 + (index % 6) * 20, y: 100 + Math.floor(index / 6) * 14,
      width: 50, height: 18, priority: 'ambient',
    }));
    // Deliberately appended after the ambient candidates and placed directly on ambient-0/-29:
    // priority, not input position, must decide which label owns each rectangle.
    const candidates: Constellation3DLabelCandidate[] = [
      ...ambient,
      { key: 'selected', x: ambient[0]!.x, y: ambient[0]!.y, width: 50, height: 18, priority: 'selected' },
      { key: 'promoted', x: ambient[29]!.x, y: ambient[29]!.y, width: 50, height: 18, priority: 'promoted' },
    ];
    const placed = placeConstellation3DLabels(candidates, 24, 4);
    const keys = placed.map(({ key }) => key);
    expect(keys).toEqual(placeConstellation3DLabels(candidates, 24, 4).map(({ key }) => key));
    expect(keys.slice(0, 2)).toEqual(['selected', 'promoted']);
    expect(keys).not.toContain('ambient-0');
    expect(keys).not.toContain('ambient-29');
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) expect(overlaps(placed[i]!, placed[j]!, 4)).toBe(false);
    }
  });

  it('truncates presentation text with an ellipsis without changing labels already within the designed width', () => {
    const full = 'This raw memory statement is intentionally sentence-length';
    expect(truncateConstellationLabel(full, 24)).toBe('This raw memory stateme…');
    expect(full).toBe('This raw memory statement is intentionally sentence-length');
    expect(truncateConstellationLabel('Coordination core', 24)).toBe('Coordination core');
  });

  it('pluralizes the community entity count', () => {
    expect(communityEntitySubtext(0)).toBe('0 entities');
    expect(communityEntitySubtext(1)).toBe('1 entity');
    expect(communityEntitySubtext(2)).toBe('2 entities');
    expect(communityEntitySubtext(1234)).toBe('1,234 entities');
  });
});

describe('community dominant-type colour (PLNR-438)', () => {
  it('resolves the dominant type as the highest-count entry in typeCounts, ties broken alphabetically', () => {
    expect(dominantCommunityType({ typeCounts: { task: 5, memory: 8, file: 2 } })).toBe('memory');
    expect(dominantCommunityType({ typeCounts: { task: 3, memory: 3 } })).toBe('memory'); // 'memory' < 'task'
    expect(dominantCommunityType({ typeCounts: undefined })).toBeNull();
    expect(dominantCommunityType({ typeCounts: {} })).toBeNull();
  });

  it('colours a community by its dominant type and every other node by its own type', () => {
    const community = node('c', 'community', { community: true, typeCounts: { file: 9, task: 1 } });
    const entity = node('e', 'memory');
    expect(constellation3DColorType(community)).toBe('file');
    expect(constellation3DColorType(entity)).toBe('memory');
    // A community with no typeCounts still resolves to a real, renderable key — never undefined.
    expect(constellation3DColorType(node('empty', 'community', { community: true }))).toBe('unknown');
  });
});

describe('community hover tooltip content (PLNR-438)', () => {
  it('is null for a non-community node — hover is scoped to community supernodes only', () => {
    expect(communityTooltipContent(node('e', 'memory'))).toBeNull();
  });

  it('carries name, entity/boundary counts, the top type counts, and the click/double-click affordance line', () => {
    const community = node('c', 'community', {
      community: true, label: 'Coordination core', memberCount: 733, boundaryRouteCount: 84,
      typeCounts: { task: 291, memory: 168, file: 274, plan: 2 },
    });
    const tooltip = communityTooltipContent(community);
    expect(tooltip).toMatchObject({ name: 'Coordination core', entityCount: 733, boundaryRouteCount: 84 });
    expect(tooltip!.topTypeCounts).toEqual([{ type: 'task', count: 291 }, { type: 'file', count: 274 }, { type: 'memory', count: 168 }]);
    expect(tooltip!.affordance).toBe('click to select · double-click to open');
  });

  it('defaults entity/boundary counts to zero and an empty top-types list rather than throwing when the fields are absent', () => {
    const tooltip = communityTooltipContent(node('c', 'community', { community: true }));
    expect(tooltip).toMatchObject({ entityCount: 0, boundaryRouteCount: 0, topTypeCounts: [] });
  });
});

describe('aggregate route width mapping (PLNR-438)', () => {
  it('maps weight linearly onto the 0.8–2.4 screen-spec range', () => {
    expect(aggregateRouteWidth(0, 0, 10)).toBeCloseTo(0.8);
    expect(aggregateRouteWidth(10, 0, 10)).toBeCloseTo(2.4);
    expect(aggregateRouteWidth(5, 0, 10)).toBeCloseTo(1.6);
  });

  it('returns the range midpoint when there is no weight variation to map, never NaN or Infinity', () => {
    expect(aggregateRouteWidth(5, 5, 5)).toBe(1.6);
    expect(aggregateRouteWidth(Number.NaN, 0, 10)).toBe(1.6);
  });
});

describe('off-page incident detection (PLNR-439)', () => {
  it('is true only for an incident: edge whose endpoint was substituted by a community', () => {
    expect(isOffPageIncidentEdge({ id: 'incident:x', aggregate: true })).toBe(true);
    expect(isOffPageIncidentEdge({ id: 'incident:x', aggregate: false })).toBe(false);
  });

  it('is false for a genuine community-to-community aggregate route, even though it also carries aggregate: true', () => {
    // Selecting a community node can promote one of its own boundary routes into promotedEdges —
    // that route's target is already resident on this page, not a truncated stand-in, so it must
    // never be mistaken for an off-page substitution just because both set `aggregate`.
    expect(isOffPageIncidentEdge({ id: 'aggregate:leaf:other', aggregate: true })).toBe(false);
  });
});

describe('promoted edge label text (PLNR-439)', () => {
  const base: Constellation3DEdge = { id: 'incident:e', fromId: 'a', toId: 'b', type: 'references', direction: 'forward', weight: 1, aggregate: false };

  it('renders a typed mono label with the direction arrow for a resident relationship', () => {
    expect(promotedEdgeLabelText(base, 'ignored')).toBe('→ references');
    expect(promotedEdgeLabelText({ ...base, direction: 'reverse' }, 'ignored')).toBe('← references');
    expect(promotedEdgeLabelText({ ...base, direction: 'both' }, 'ignored')).toBe('↔ references');
  });

  it('appends a "· historical" suffix without dropping the direction arrow or type', () => {
    expect(promotedEdgeLabelText({ ...base, historical: true }, 'ignored')).toBe('→ references · historical');
  });

  it('replaces the typed relationship text with a truthful off-page caption naming the containing community, never the raw type', () => {
    const offPage: Constellation3DEdge = { ...base, id: 'incident:e', aggregate: true };
    expect(promotedEdgeLabelText(offPage, 'Coordination core')).toBe('Coordination core · off-page ▸');
  });

  it('never gives a genuine aggregate community-to-community route the off-page caption', () => {
    const route: Constellation3DEdge = { ...base, id: 'aggregate:leaf:other', aggregate: true };
    expect(promotedEdgeLabelText(route, 'other')).toBe('→ references');
  });

  it('resolves to the off-page caption for an edge that is BOTH historical and off-page, never a hybrid or double-labelled text', () => {
    const both: Constellation3DEdge = { ...base, id: 'incident:e', aggregate: true, historical: true };
    expect(promotedEdgeLabelText(both, 'Coordination core')).toBe('Coordination core · off-page ▸');
  });
});

describe('draw-call ceiling accounts for promoted-edge passes (PLNR-439)', () => {
  const nodes: Constellation3DNode[] = [node('a'), node('b', 'memory'), node('c', 'file'), node('d', 'task')];

  it('adds nothing for promoted edges when nothing is selected', () => {
    const edges: Constellation3DEdge[] = [{ id: 'incident:x', fromId: 'a', toId: 'b', type: 'references', direction: 'forward', weight: 1, aggregate: false }];
    const withSelection = buildConstellation3DRenderPlan(nodes, edges, 'a');
    const withoutSelection = buildConstellation3DRenderPlan(nodes, edges, null);
    expect(withoutSelection.drawCallCeiling).toBeLessThan(withSelection.drawCallCeiling);
  });

  it('allots separate passes for current, historical, and off-page promoted edges plus direction markers', () => {
    const edges: Constellation3DEdge[] = [
      { id: 'incident:current', fromId: 'a', toId: 'b', type: 'references', direction: 'forward', weight: 1, aggregate: false },
      { id: 'incident:historical', fromId: 'a', toId: 'c', type: 'supersedes', direction: 'forward', weight: 1, aggregate: false, historical: true },
      { id: 'incident:offpage', fromId: 'a', toId: 'd', type: 'related_to', direction: 'forward', weight: 1, aggregate: true },
    ];
    // Same edges, unselected vs. selected. Unlike the other terms, the aggregate-route-tube term
    // does NOT cancel out of this diff: unselected, the off-page edge sits in baseEdges and trips
    // it (+1); selected, that same edge is incident to 'a' and moves into promotedEdges instead,
    // so the tube mesh never gets built and the term drops to 0 (-1) — see `hasAggregateRouteTube`.
    const unselected = buildConstellation3DRenderPlan(nodes, edges, null);
    const selected = buildConstellation3DRenderPlan(nodes, edges, 'a');
    // current(+1) + historical(+1) + off-page(+2: dashed line + terminus glyph) + direction
    // markers(+1, current+historical only — off-page never gets a cone) - aggregate-route-tube
    // lost to the promotion above (-1) = +4.
    expect(selected.drawCallCeiling).toBe(unselected.drawCallCeiling + 4);
  });

  it('stays within the PLNR-371 ceiling of 14 for a realistic single-selection incident fixture', () => {
    const edges: Constellation3DEdge[] = [
      { id: 'incident:current', fromId: 'a', toId: 'b', type: 'references', direction: 'forward', weight: 1, aggregate: false },
      { id: 'incident:historical', fromId: 'a', toId: 'c', type: 'supersedes', direction: 'forward', weight: 1, aggregate: false, historical: true },
      { id: 'incident:offpage', fromId: 'a', toId: 'd', type: 'related_to', direction: 'forward', weight: 1, aggregate: true },
    ];
    const plan = buildConstellation3DRenderPlan(nodes, edges, 'a');
    expect(plan.drawCallCeiling).toBeLessThanOrEqual(14);
  });

  it('excludes an off-page stand-in from the shape/instancing group and the label budget, but keeps it resolvable for edge geometry (PLNR-448)', () => {
    const standIn = node('outside-root', 'community', { community: true, offPageStandIn: true, memberCount: 40, typeCounts: { task: 5 } });
    const pin = node('pin', 'memory');
    const edges: Constellation3DEdge[] = [
      { id: 'incident:offpage', fromId: 'pin', toId: 'outside-root', type: 'related_to', direction: 'forward', weight: 1, aggregate: true },
    ];
    const plan = buildConstellation3DRenderPlan([pin, standIn], edges, 'pin', 24);
    // The stand-in never joins a shape group — only 'pin' (a sphere-shaped memory node) does.
    expect(plan.nodeGroups.get('sphere')?.map((n) => n.id)).toEqual(['pin']);
    // Nor does it ever earn a text label.
    expect(plan.labels.some((n) => n.id === 'outside-root')).toBe(false);
    // But the promoted edge still resolves both endpoints — the stand-in's position is intact.
    expect(plan.promotedEdges).toHaveLength(1);
    expect(plan.promotedEdges[0]).toMatchObject({ fromId: 'pin', toId: 'outside-root' });
  });

  it('does not allot the community gravity-well pass for a scene whose only community node is an off-page stand-in (PLNR-448)', () => {
    const standIn = node('outside-root', 'community', { community: true, offPageStandIn: true });
    const pin = node('pin', 'memory');
    const edges: Constellation3DEdge[] = [
      { id: 'incident:offpage', fromId: 'pin', toId: 'outside-root', type: 'related_to', direction: 'forward', weight: 1, aggregate: true },
    ];
    const withStandIn = buildConstellation3DRenderPlan([pin, standIn], edges, 'pin');
    const withoutStandIn = buildConstellation3DRenderPlan([pin], [], 'pin');
    // No +2 gravity-well term over the plain-pin baseline, and no separate sphere shape-group cost
    // either (the stand-in's own shape-group entry is excluded, same as the label above) — the
    // only extra draw calls come from the off-page promoted-edge pass itself (dashed line +
    // terminus glyph, +2) plus the base backbone pass gaining nothing since there was already one.
    expect(withStandIn.drawCallCeiling).toBe(withoutStandIn.drawCallCeiling + 2);
  });

  it('still allots the gravity-well pass when a genuinely resident community sits alongside an off-page stand-in — the exclusion must not leak onto real communities (PLNR-448)', () => {
    const standIn = node('outside-root', 'community', { community: true, offPageStandIn: true });
    const resident = node('neighbor', 'community', { community: true, memberCount: 40, typeCounts: { task: 2 } });
    const pin = node('pin', 'memory');
    const edges: Constellation3DEdge[] = [
      { id: 'incident:offpage', fromId: 'pin', toId: 'outside-root', type: 'related_to', direction: 'forward', weight: 1, aggregate: true },
      { id: 'aggregate:neighbor:other', fromId: 'neighbor', toId: 'pin', type: 'related_to', direction: 'forward', weight: 2, aggregate: true },
    ];
    const plan = buildConstellation3DRenderPlan([pin, standIn, resident], edges, null, 24);
    // The resident community still joins the sphere shape group and still gets its well pass —
    // only the stand-in is excluded.
    expect(plan.nodeGroups.get('sphere')?.map((n) => n.id).sort()).toEqual(['neighbor', 'pin']);
    expect(plan.drawCallCeiling).toBeGreaterThanOrEqual(2); // gravity-well pass is present
    expect(plan.labels.some((n) => n.id === 'neighbor')).toBe(true);
    expect(plan.labels.some((n) => n.id === 'outside-root')).toBe(false);
  });

  it('does not allot an aggregate-route-tube draw call for an aggregate edge that got promoted (off-page) rather than landing in baseEdges', () => {
    // A community-typed off-page target with a neighbour community also in frame — the aggregate
    // edge that substitutes it is INCIDENT to the selection, so it lands in promotedEdges (and
    // renders via the off-page pass), never in baseEdges. The base-pass aggregate-route TUBE mesh
    // (renderEdges's `aggregateBaseEdges`) is therefore never built for this plan, and the ceiling
    // must not allot a draw call for a mesh that never fires.
    const community = node('offpage-community', 'community', { community: true, memberCount: 40 });
    const pinNodes: Constellation3DNode[] = [node('pin', 'memory'), community];
    const edges: Constellation3DEdge[] = [
      { id: 'incident:offpage', fromId: 'pin', toId: 'offpage-community', type: 'related_to', direction: 'forward', weight: 1, aggregate: true },
    ];
    const plan = buildConstellation3DRenderPlan(pinNodes, edges, 'pin');
    // Both nodes share one shape group (memory and community both render as spheres): 1 group ×2
    // + community wells (+2) + base backbone (+1) + off-page pass (+2, dashed line + terminus
    // glyph) — no lead, no current/historical promoted, no direction markers (off-page never gets
    // one), and critically no aggregate-route-tube term since the edge never reaches baseEdges.
    expect(plan.drawCallCeiling).toBe(1 * 2 + 2 + 1 + 2);
  });
});

describe('search ignite draw-call budget (PLNR-441)', () => {
  // PLNR-439 measured a realistic pinned-selection scene at exactly 14 — the PLNR-371 ceiling —
  // with zero headroom. Ignite layers on top of selection (screen spec 1c), so this is the
  // combination most likely to blow the budget; per this task's brief, that combination must be
  // measured explicitly rather than assumed safe. It is verified here to add ZERO draw calls: the
  // unmatched-field dim reuses the existing faded/unfaded material bucket (constellation3DIsDimmed
  // just swaps which predicate decides membership) and a matched community's flare rides the same
  // highlighted-scale boost the core sphere pass already applies — no new mesh, no new pass.
  const pinNode = (id: string, type: string, overrides: Partial<Constellation3DNode> = {}) =>
    node(id, type, overrides);

  it('stays at the same ceiling with search ignite active on a realistic pinned-selection + neighbour-community scene', () => {
    // Mirrors PLNR-439's realistic fixture: two shape groups (memory + task, community also renders
    // as sphere so it does not add a third), a lead pin, current+historical+off-page promoted edges,
    // and an aggregate route-tube edge on a base (unselected-incident) pair — the exact combination
    // the PLNR-439 commit reports hit 15 before its own fix and exactly 14 after.
    const nodes: Constellation3DNode[] = [
      pinNode('pin', 'memory', { isLead: true }),
      pinNode('b', 'memory'),
      pinNode('c', 'memory', { validity: 'stale' }),
      pinNode('d', 'task'),
      pinNode('neighbor', 'community', { community: true, memberCount: 40, typeCounts: { task: 2 } }),
    ];
    const edges: Constellation3DEdge[] = [
      { id: 'incident:current', fromId: 'pin', toId: 'b', type: 'references', direction: 'forward', weight: 1, aggregate: false },
      { id: 'incident:historical', fromId: 'pin', toId: 'c', type: 'supersedes', direction: 'forward', weight: 1, aggregate: false, historical: true },
      { id: 'incident:offpage', fromId: 'pin', toId: 'neighbor', type: 'related_to', direction: 'forward', weight: 1, aggregate: true },
      { id: 'aggregate:d:neighbor', fromId: 'd', toId: 'neighbor', type: 'related_to', direction: 'forward', weight: 2, aggregate: true },
    ];
    const withoutSearch = buildConstellation3DRenderPlan(nodes, edges, 'pin');
    expect(withoutSearch.drawCallCeiling).toBeLessThanOrEqual(14);

    // The pin itself and the neighbour community are BOTH search matches — the exact "mixed
    // matched/unmatched community" case a naive well-opacity split would have to pay for with two
    // extra draw calls. The measured number is identical to the unselected-for-search baseline.
    const withSearch = buildConstellation3DRenderPlan(nodes, edges, 'pin', 24, new Set(['pin', 'neighbor']));
    expect(withSearch.drawCallCeiling).toBe(withoutSearch.drawCallCeiling);
    expect(withSearch.drawCallCeiling).toBeLessThanOrEqual(14);

    // And the case where only the pin matches (the neighbour community stays unmatched/dimmed) —
    // same result, confirming the ceiling does not depend on which nodes happen to be highlighted.
    const withSearchPinOnly = buildConstellation3DRenderPlan(nodes, edges, 'pin', 24, new Set(['pin']));
    expect(withSearchPinOnly.drawCallCeiling).toBe(withoutSearch.drawCallCeiling);
  });
});

describe('search ignite (PLNR-441)', () => {
  it('constellation3DIsDimmed: outside search, dims exactly the pre-existing validity-based faded set', () => {
    const active = { opacity: 1, highlighted: false };
    const stale = { opacity: 0.42, highlighted: false };
    expect(constellation3DIsDimmed(active, false)).toBe(false);
    expect(constellation3DIsDimmed(stale, false)).toBe(true);
  });

  it('constellation3DIsDimmed: during search, dims everything that is not a match — validity plays no part', () => {
    const matchedButStale = { opacity: 0.42, highlighted: true };
    const unmatchedButActive = { opacity: 1, highlighted: false };
    expect(constellation3DIsDimmed(matchedButStale, true)).toBe(false);
    expect(constellation3DIsDimmed(unmatchedButActive, true)).toBe(true);
  });

  it('CONSTELLATION_IGNITE_DIM_OPACITY sits within the screen spec\'s ~32% dim target', () => {
    expect(CONSTELLATION_IGNITE_DIM_OPACITY).toBeCloseTo(0.32);
  });

  it('communityIgniteSubtext pluralizes "match"/"matches" and formats the count with locale separators', () => {
    expect(communityIgniteSubtext(1)).toBe('+1 match');
    expect(communityIgniteSubtext(7)).toBe('+7 matches');
    expect(communityIgniteSubtext(0)).toBe('+0 matches');
    expect(communityIgniteSubtext(1234)).toBe('+1,234 matches');
  });
});
