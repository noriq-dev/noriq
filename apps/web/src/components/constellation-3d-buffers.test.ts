import { describe, expect, it } from 'vitest';
import {
  aggregateRouteWidth, buildConstellation3DRenderPlan, communityTooltipContent, constellation3DColorType,
  constellation3DNodeEncoding, dominantCommunityType,
  type Constellation3DEdge, type Constellation3DNode,
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
