import { describe, expect, it } from 'vitest';
import {
  CONSTELLATION_DOUBLE_CLICK_MS, CONSTELLATION_DRAG_THRESHOLD_PX, constellation3DClickIntent,
  constellation3DCommunityCluster, constellation3DCommunityClusterCamera, constellation3DHasDragged, constellation3DKeyboardZoomIntent,
} from './MemoryConstellation3D';
import { DEFAULT_CONSTELLATION_3D_CAMERA } from './constellation-3d-navigation';

describe('MemoryConstellation3D click intent (PLNR-463)', () => {
  it('keeps a single node click selection-only and recognizes the same node inside the double-click window', () => {
    const first = constellation3DClickIntent(null, 'node-a', 1_000, 0);
    expect(first).toEqual({ next: { nodeId: 'node-a', at: 1_000 }, zoom: false });
    expect(constellation3DClickIntent(first.next, 'node-a', 1_000 + CONSTELLATION_DOUBLE_CLICK_MS, 0))
      .toEqual({ next: null, zoom: true });
  });

  it('does not zoom across different nodes or after the timing window', () => {
    const previous = { nodeId: 'node-a', at: 1_000 };
    expect(constellation3DClickIntent(previous, 'node-b', 1_100, 0).zoom).toBe(false);
    expect(constellation3DClickIntent(previous, 'node-a', 1_000 + CONSTELLATION_DOUBLE_CLICK_MS + 1, 0).zoom).toBe(false);
  });

  it('lets the existing three-pixel threshold pass clicks but makes a drag veto and reset the sequence', () => {
    const previous = { nodeId: 'node-a', at: 1_000 };
    expect(constellation3DClickIntent(previous, 'node-a', 1_100, CONSTELLATION_DRAG_THRESHOLD_PX).zoom).toBe(true);
    expect(constellation3DClickIntent(previous, 'node-a', 1_100, CONSTELLATION_DRAG_THRESHOLD_PX + 0.01))
      .toEqual({ next: null, zoom: false });
    expect(constellation3DHasDragged(false, CONSTELLATION_DRAG_THRESHOLD_PX)).toBe(false);
    expect(constellation3DHasDragged(false, CONSTELLATION_DRAG_THRESHOLD_PX + 0.01)).toBe(true);
    expect(constellation3DHasDragged(true, 0)).toBe(true);
  });

  it('clears a pending node click when the next click hits the background', () => {
    expect(constellation3DClickIntent({ nodeId: 'node-a', at: 1_000 }, null, 1_100, 0))
      .toEqual({ next: null, zoom: false });
  });

  it('reserves camera zoom for Enter on a pinned selection, never arrow-key selection', () => {
    expect(constellation3DKeyboardZoomIntent('Enter', 'node-a')).toBe(true);
    expect(constellation3DKeyboardZoomIntent('ArrowRight', 'node-a')).toBe(false);
    expect(constellation3DKeyboardZoomIntent('Enter', null)).toBe(false);
  });

  it('turns a community double-click into its member cluster, not the anchor supernode', () => {
    const intent = constellation3DClickIntent({ nodeId: 'system', at: 1_000 }, 'system', 1_100, 0);
    const nodes = [
      { id: 'system', uri: null, label: 'System', type: 'community', position: [0, 0, 0] as [number, number, number], degree: 2, community: true, parentId: null },
      { id: 'member-a', uri: 'noriq://task/a', label: 'A', type: 'task', position: [-20, 0, 0] as [number, number, number], degree: 1, parentId: 'system' },
      { id: 'member-b', uri: 'noriq://task/b', label: 'B', type: 'task', position: [20, 0, 0] as [number, number, number], degree: 1, parentId: 'system' },
      { id: 'other', uri: 'noriq://task/c', label: 'C', type: 'task', position: [500, 0, 0] as [number, number, number], degree: 1, parentId: 'other-system' },
    ];
    expect(intent.zoom).toBe(true);
    expect(constellation3DCommunityCluster(nodes, 'system').map((node) => node.id)).toEqual(['member-a', 'member-b']);
    expect(constellation3DCommunityClusterCamera(nodes, 'system', 1.5, DEFAULT_CONSTELLATION_3D_CAMERA)).toMatchObject({
      target: [0, 0, 0],
    });
  });

  it('fits a real anchor-entity sun and a phase sub-well through their canonical system ids', () => {
    const nodes = [
      { id: 'plan-node', systemId: 'root-community', uri: 'noriq://plan/a', label: 'Plan', type: 'plan', position: [0, 0, 0] as [number, number, number], degree: 4, community: true, anchorEntity: true, parentId: null },
      { id: 'phase-community', systemId: 'phase-community', uri: null, label: 'Phase 1', type: 'community', position: [40, 0, 0] as [number, number, number], degree: 2, community: true, communityLevel: 1, parentId: 'plan-node' },
      { id: 'phase-a', uri: 'noriq://task/a', label: 'A', type: 'task', position: [34, 0, 0] as [number, number, number], degree: 1, parentId: 'phase-community' },
      { id: 'phase-b', uri: 'noriq://task/b', label: 'B', type: 'task', position: [46, 0, 0] as [number, number, number], degree: 1, parentId: 'phase-community' },
      { id: 'direct', uri: 'noriq://agent/a', label: 'Agent', type: 'agent', position: [-20, 0, 0] as [number, number, number], degree: 1, parentId: 'plan-node' },
    ];
    expect(constellation3DCommunityCluster(nodes, 'root-community').map((node) => node.id)).toEqual(['phase-community', 'phase-a', 'phase-b', 'direct']);
    expect(constellation3DCommunityCluster(nodes, 'phase-community').map((node) => node.id)).toEqual(['phase-a', 'phase-b']);
    expect(constellation3DCommunityClusterCamera(nodes, 'phase-community', 1.5, DEFAULT_CONSTELLATION_3D_CAMERA)?.target[0]).toBeCloseTo(40);
  });
});
