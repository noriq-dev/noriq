import { describe, expect, it } from 'vitest';
import {
  buildConstellation3DRenderPlan, constellation3DNodeEncoding,
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
    expect(plan.drawCallCeiling).toBeLessThanOrEqual(14);
    expect(plan.labels).toHaveLength(24);
    expect(plan.labels[0]!.id).toBe('n9999');
  });
});
