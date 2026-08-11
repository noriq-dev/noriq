import { describe, expect, it } from 'vitest';
import {
  buildConstellation3DSpatialIndex, computeConstellation3DLayout, nearestConstellationNode, nearestDirectionalConstellationNode,
  type Constellation3DLayoutInput,
} from './constellation-3d-layout';

const input: Constellation3DLayoutInput = {
  generationId: 'g1', layoutVersion: 'space-v1',
  nodes: [
    { id: 'root', uri: null, label: 'root', type: 'community', position: [0, 0, 0], degree: 2, community: true, radius: 100 },
    { id: 'a', uri: 'noriq://memory/a', label: 'a', type: 'memory', position: [200, 0, 0], degree: 1, parentId: 'root' },
    { id: 'b', uri: 'noriq://task/b', label: 'b', type: 'task', position: [-200, 0, 0], degree: 1, parentId: 'root' },
  ],
  edges: [{ id: 'edge', fromId: 'a', toId: 'b', type: 'related_to', direction: 'forward', weight: 1, aggregate: false }],
};

describe('deterministic constellation 3D layout', () => {
  it('returns byte-stable positions and keeps children inside the parent volume', () => {
    const first = computeConstellation3DLayout(input);
    const second = computeConstellation3DLayout({ ...input, nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() });
    expect(second).toEqual(first);
    for (const id of ['a', 'b']) expect(Math.hypot(...first.positions[id]!)).toBeLessThanOrEqual(100.001);
  });

  it('uses compatible prior anchors only as a bounded warm start', () => {
    const result = computeConstellation3DLayout({ ...input, prior: { generationId: 'older', layoutVersion: 'space-v1', positions: { a: [10_000, 0, 0] } } });
    expect(Math.hypot(...result.positions.a!)).toBeLessThanOrEqual(100.001);
    const incompatible = computeConstellation3DLayout({ ...input, prior: { generationId: 'older', layoutVersion: 'space-v0', positions: { a: [10_000, 0, 0] } } });
    expect(incompatible).toEqual(computeConstellation3DLayout(input));
  });

  it('keeps simultaneous resident systems clustered around their own parent anchors', () => {
    const multi: Constellation3DLayoutInput = {
      ...input,
      nodes: [
        { id: 'left', uri: null, label: 'left', type: 'community', position: [-400, 0, 0], degree: 1, community: true, radius: 90 },
        { id: 'left-a', uri: 'noriq://task/left-a', label: 'left-a', type: 'task', position: [-360, 0, 0], degree: 1, parentId: 'left' },
        { id: 'right', uri: null, label: 'right', type: 'community', position: [400, 0, 0], degree: 1, community: true, radius: 90 },
        { id: 'right-a', uri: 'noriq://task/right-a', label: 'right-a', type: 'task', position: [360, 0, 0], degree: 1, parentId: 'right' },
      ],
      edges: [],
    };
    const result = computeConstellation3DLayout(multi);
    expect(Math.abs(result.positions['left-a']![0] - result.positions.left![0])).toBeLessThanOrEqual(90.001);
    expect(Math.abs(result.positions['right-a']![0] - result.positions.right![0])).toBeLessThanOrEqual(90.001);
    expect(result.positions['left-a']![0]).toBeLessThan(0);
    expect(result.positions['right-a']![0]).toBeGreaterThan(0);
  });

  it('uses a bounded spatial grid with stable nearest tie-breaking', () => {
    const positions = new Map<string, [number, number, number]>([['b', [1, 0, 0]], ['a', [-1, 0, 0]], ['far', [500, 0, 0]]]);
    const index = buildConstellation3DSpatialIndex(positions, 20);
    expect(nearestConstellationNode(index, [0, 0, 0], 10)).toBe('a');
    expect(nearestConstellationNode(index, [0, 0, 0], 0.5)).toBeNull();
    expect(nearestDirectionalConstellationNode(index, 'a', [1, 0, 0])).toBe('b');
  });
});
