// PLNR-285: coverage for the star map's pure layout/encoding/hit-testing core — the determinism,
// non-colour-channel encoding and uri-seeded stability acceptance lines all live here because they
// are provable ONLY against this DOM-free module (jsdom has no canvas 2D context).
import { describe, expect, it } from 'vitest';
import {
  applyPins, clampZoom, clusterLabelBudget, computeStarMap, decodeStarMapPrefs, DEFAULT_STAR_MAP_PREFS, deriveStarMapClusters, encodeStarMapPrefs,
  fitCamera, hashString, hitTest, MAX_ZOOM, MIN_ZOOM, RELAXATION_PASSES, screenToWorld, selectLabels,
  selectClusterLabels, starMapClusterRadius, starShapeFor, starVisual, worldToScreen, STAR_MAP_CLUSTER_GAP, STAR_MAP_CLUSTER_LABEL_MAX_LENGTH,
  STAR_MAP_DEFAULT_CLUSTER_LABEL_BUDGET, type LayoutCluster, type StarMapInputEdge, type StarMapInputNode,
} from './starmap-layout';

function node(overrides: Partial<StarMapInputNode> & { nodeId: string; uri: string }): StarMapInputNode {
  return {
    type: 'task', kind: null, label: overrides.uri, authority: null, validity: null,
    isLead: null, leadReasons: null, degree: 0, groupKey: 'task',
    ...overrides,
  };
}

describe('hashString', () => {
  it('is a pure function: identical input always yields identical output', () => {
    expect(hashString('noriq://task/task_1')).toBe(hashString('noriq://task/task_1'));
  });

  it('spreads distinct inputs across the output space (not a constant)', () => {
    const a = hashString('noriq://task/task_1');
    const b = hashString('noriq://memory/mem_2');
    const c = hashString('noriq://file/apps%2Fweb%2Fsrc%2Findex.ts');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('returns an unsigned 32-bit integer', () => {
    const h = hashString('anything');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe('computeStarMap determinism', () => {
  const nodes: StarMapInputNode[] = [
    node({ nodeId: 'n1', uri: 'noriq://task/t1', groupKey: 'task', degree: 3 }),
    node({ nodeId: 'n2', uri: 'noriq://memory/m1', type: 'memory', groupKey: 'memory', authority: 4, degree: 1 }),
    node({ nodeId: 'n3', uri: 'noriq://file/f1', type: 'file', groupKey: 'file', degree: 5 }),
  ];
  const edges: StarMapInputEdge[] = [
    { type: 'related_to', fromNodeId: 'n1', toNodeId: 'n2', provenance: null },
  ];

  it('produces byte-identical positions across repeated calls on the same input', () => {
    const a = computeStarMap(nodes, edges);
    const b = computeStarMap(nodes, edges);
    expect(a.stars.map((s) => [s.nodeId, s.x, s.y])).toEqual(b.stars.map((s) => [s.nodeId, s.x, s.y]));
  });

  it('is independent of input array order (never seeded from index)', () => {
    const forward = computeStarMap(nodes, edges);
    const reversed = computeStarMap([...nodes].reverse(), [...edges]);
    const posOf = (m: ReturnType<typeof computeStarMap>, id: string) => {
      const s = m.byNodeId.get(id)!;
      return [s.x, s.y];
    };
    for (const n of nodes) {
      expect(posOf(reversed, n.nodeId)).toEqual(posOf(forward, n.nodeId));
    }
  });

  it('runs a fixed, bounded relaxation pass count regardless of graph size', () => {
    expect(RELAXATION_PASSES).toBeGreaterThan(0);
    expect(RELAXATION_PASSES).toBeLessThan(100); // bounded — not "until convergence"
  });

  it('drops edges with a missing endpoint (defensive, mirrors the server\'s own pruning)', () => {
    const withDangling: StarMapInputEdge[] = [...edges, { type: 'blocks', fromNodeId: 'n1', toNodeId: 'ghost', provenance: null }];
    const result = computeStarMap(nodes, withDangling);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.toNodeId).toBe('n2');
  });

  it('indexes stars by BOTH nodeId and uri, as two separate maps', () => {
    const result = computeStarMap(nodes, edges);
    expect(result.byNodeId.get('n1')?.uri).toBe('noriq://task/t1');
    expect(result.byUri.get('noriq://task/t1')?.nodeId).toBe('n1');
    // Genuinely two maps, not one derived from the other by string surgery.
    expect(result.byNodeId).not.toBe(result.byUri as unknown as Map<string, unknown>);
  });

  it('handles an empty map without throwing and reports finite bounds', () => {
    const result = computeStarMap([], []);
    expect(result.stars).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(Number.isFinite(result.bounds.minX)).toBe(true);
    expect(Number.isFinite(result.bounds.maxX)).toBe(true);
  });
});

describe('graph-derived systems (PLNR-473)', () => {
  const planA = node({ nodeId: 'plan-a', uri: 'noriq://plan/a', type: 'plan', groupKey: 'plan', label: 'Security &amp; correctness remediation with a deliberately long title' });
  const planB = node({ nodeId: 'plan-b', uri: 'noriq://plan/b', type: 'plan', groupKey: 'plan', label: 'Delivery' });
  const a1 = node({ nodeId: 'a1', uri: 'noriq://task/a1' });
  const a2 = node({ nodeId: 'a2', uri: 'noriq://task/a2' });
  const tie = node({ nodeId: 'tie', uri: 'noriq://task/tie' });
  const b1 = node({ nodeId: 'b1', uri: 'noriq://task/b1' });
  const edges: StarMapInputEdge[] = [
    { type: 'related_to', fromNodeId: 'plan-a', toNodeId: 'a1', provenance: null },
    { type: 'related_to', fromNodeId: 'a1', toNodeId: 'a2', provenance: null },
    { type: 'related_to', fromNodeId: 'plan-a', toNodeId: 'tie', provenance: null },
    { type: 'related_to', fromNodeId: 'plan-b', toNodeId: 'tie', provenance: null },
    { type: 'related_to', fromNodeId: 'plan-b', toNodeId: 'b1', provenance: null },
  ];

  it('assigns nearest-anchor membership and breaks equal-hop ties by canonical seed uri', () => {
    const derived = deriveStarMapClusters([planB, tie, a2, planA, b1, a1], [...edges].reverse());
    const aCluster = derived.clusters.find((cluster) => cluster.anchorNodeId === 'plan-a')!;
    const bCluster = derived.clusters.find((cluster) => cluster.anchorNodeId === 'plan-b')!;
    expect(aCluster.memberNodeIds).toEqual(['plan-a', 'a1', 'a2', 'tie']);
    expect(bCluster.memberNodeIds).toEqual(['plan-b', 'b1']);
  });

  it('turns seedless components of three into mini-clusters and leaves smaller fragments ambient', () => {
    const loose = ['c1', 'c2', 'c3', 'dust-1', 'dust-2'].map((id) => node({ nodeId: id, uri: `noriq://task/${id}` }));
    const looseEdges: StarMapInputEdge[] = [
      { type: 'related_to', fromNodeId: 'c1', toNodeId: 'c2', provenance: null },
      { type: 'related_to', fromNodeId: 'c2', toNodeId: 'c3', provenance: null },
      { type: 'related_to', fromNodeId: 'dust-1', toNodeId: 'dust-2', provenance: null },
    ];
    const map = computeStarMap(loose, looseEdges);
    expect(map.clusters).toHaveLength(1);
    expect(map.clusters[0]).toMatchObject({ anchorNodeId: null, label: null });
    expect(map.clusters[0]!.memberNodeIds).toHaveLength(3);
    expect(map.ambientCount).toBe(2);
    expect(map.byNodeId.get('dust-1')?.clusterRole).toBe('ambient');
  });

  it('keeps every cluster disc separated by a real gap', () => {
    const many = Array.from({ length: 9 }, (_, index) => node({
      nodeId: `plan-${index}`, uri: `noriq://plan/${index}`, type: 'plan', groupKey: 'plan',
    }));
    const map = computeStarMap(many, []);
    for (let i = 0; i < map.clusters.length; i++) for (let j = i + 1; j < map.clusters.length; j++) {
      const a = map.clusters[i]!, b = map.clusters[j]!;
      expect(Math.hypot(a.x - b.x, a.y - b.y) + 1e-6).toBeGreaterThanOrEqual(a.radius + b.radius + STAR_MAP_CLUSTER_GAP);
    }
  });

  it('decodes and bounds anchor labels and makes the real anchor the centered sun', () => {
    const map = computeStarMap([planA, a1], [edges[0]!]);
    const cluster = map.clusters[0]!;
    expect(cluster.label).toContain('&');
    expect(cluster.label).not.toContain('&amp;');
    expect(Array.from(cluster.label!).length).toBeLessThanOrEqual(STAR_MAP_CLUSTER_LABEL_MAX_LENGTH);
    const sun = map.byNodeId.get('plan-a')!;
    expect(sun.clusterRole).toBe('sun');
    expect(sun.label).toContain('Security & correctness');
    expect(sun.label).not.toContain('&amp;');
    expect([sun.x, sun.y]).toEqual([cluster.x, cluster.y]);
    expect(sun.visual.radius).toBeGreaterThan(map.byNodeId.get('a1')!.visual.radius);
  });

  it('leaves cluster A byte-identical when a member is added only to cluster B', () => {
    const before = computeStarMap([planA, a1, a2, planB, b1], edges.filter((edge) => edge.toNodeId !== 'tie' && edge.fromNodeId !== 'tie'));
    const b2 = node({ nodeId: 'b2', uri: 'noriq://task/b2' });
    const after = computeStarMap(
      [planA, a1, a2, planB, b1, b2],
      [...edges.filter((edge) => edge.toNodeId !== 'tie' && edge.fromNodeId !== 'tie'), { type: 'related_to', fromNodeId: 'plan-b', toNodeId: 'b2', provenance: null }],
    );
    for (const id of ['plan-a', 'a1', 'a2']) {
      const a = before.byNodeId.get(id)!, b = after.byNodeId.get(id)!;
      expect([b.x, b.y]).toEqual([a.x, a.y]);
    }
  });

  it('scales system discs with sqrt membership while keeping a finite cap', () => {
    expect(starMapClusterRadius(216)).toBeGreaterThan(starMapClusterRadius(8));
    expect(starMapClusterRadius(100_000)).toBe(220);
  });
});

describe('visual encoding — non-colour channels', () => {
  it('gives distinct shapes to distinct type families', () => {
    expect(starShapeFor('task')).toBe('square');
    expect(starShapeFor('memory')).toBe('diamond');
    expect(starShapeFor('file')).toBe('triangle');
    expect(starShapeFor('error')).toBe('hex');
    expect(starShapeFor('totally-unknown-type')).toBe('circle');
  });

  it('renders a lead as hollow and a settled/non-memory node as solid — independent of colour', () => {
    const lead = starVisual(node({ nodeId: 'a', uri: 'u1', isLead: true }));
    const settled = starVisual(node({ nodeId: 'b', uri: 'u2', isLead: false }));
    const nonMemory = starVisual(node({ nodeId: 'c', uri: 'u3', isLead: null }));
    expect(lead.fill).toBe('hollow');
    expect(settled.fill).toBe('solid');
    expect(nonMemory.fill).toBe('solid');
  });

  it('gives stale and invalid distinct halo treatments, both distinct from active/null', () => {
    const stale = starVisual(node({ nodeId: 'a', uri: 'u1', validity: 'stale' }));
    const invalid = starVisual(node({ nodeId: 'b', uri: 'u2', validity: 'invalid' }));
    const active = starVisual(node({ nodeId: 'c', uri: 'u3', validity: 'active' }));
    expect(stale.halo).toBe('dashed');
    expect(invalid.halo).toBe('broken');
    expect(active.halo).toBe('none');
    expect(new Set([stale.halo, invalid.halo, active.halo]).size).toBe(3);
  });

  it('scales brightness with authority and gives non-memory nodes a fixed baseline', () => {
    const low = starVisual(node({ nodeId: 'a', uri: 'u1', authority: 1 }));
    const high = starVisual(node({ nodeId: 'b', uri: 'u2', authority: 5 }));
    const none = starVisual(node({ nodeId: 'c', uri: 'u3', authority: null }));
    expect(high.brightness).toBeGreaterThan(low.brightness);
    expect(none.brightness).toBeGreaterThan(0);
    expect(none.brightness).toBeLessThanOrEqual(1);
  });

  it('scales radius with degree (connectedness) and stays within sane render bounds', () => {
    const quiet = starVisual(node({ nodeId: 'a', uri: 'u1', degree: 0 }));
    const hub = starVisual(node({ nodeId: 'b', uri: 'u2', degree: 40 }));
    expect(hub.radius).toBeGreaterThan(quiet.radius);
    expect(quiet.radius).toBeGreaterThanOrEqual(3);
    expect(hub.radius).toBeLessThanOrEqual(13);
  });
});

describe('camera transforms', () => {
  const camera = { x: 10, y: -5, zoom: 2 };
  const viewport = { width: 800, height: 600 };

  it('round-trips world -> screen -> world', () => {
    const world = { x: 37, y: -12 };
    const screen = worldToScreen(world, camera, viewport);
    const back = screenToWorld(screen, camera, viewport);
    expect(back.x).toBeCloseTo(world.x, 6);
    expect(back.y).toBeCloseTo(world.y, 6);
  });

  it('centers the camera target on the viewport center', () => {
    const screen = worldToScreen({ x: camera.x, y: camera.y }, camera, viewport);
    expect(screen.x).toBeCloseTo(viewport.width / 2);
    expect(screen.y).toBeCloseTo(viewport.height / 2);
  });

  it('clamps zoom within [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });

  it('fitCamera centers on the bounds and stays within [MIN_ZOOM, MAX_ZOOM]', () => {
    const bounds = { minX: -100, minY: -50, maxX: 100, maxY: 50 };
    const cam = fitCamera(bounds, viewport);
    expect(cam.x).toBeCloseTo(0);
    expect(cam.y).toBeCloseTo(0);
    expect(cam.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(cam.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  });
});

describe('hitTest', () => {
  const nodes: StarMapInputNode[] = [
    node({ nodeId: 'n1', uri: 'noriq://task/t1', groupKey: 'task', degree: 2 }),
    node({ nodeId: 'n2', uri: 'noriq://memory/m1', type: 'memory', groupKey: 'memory', degree: 2 }),
  ];
  const map = computeStarMap(nodes, []);
  const camera = { x: 0, y: 0, zoom: 1 };
  const viewport = { width: 800, height: 600 };

  it('finds the star exactly under the pointer', () => {
    const target = map.stars[0]!;
    const screen = worldToScreen(target, camera, viewport);
    const hit = hitTest(map.stars, camera, viewport, screen);
    expect(hit?.nodeId).toBe(target.nodeId);
  });

  it('returns null when nothing is within tolerance', () => {
    const hit = hitTest(map.stars, camera, viewport, { x: -9999, y: -9999 });
    expect(hit).toBeNull();
  });

  it('honors zoom: a tolerance in world space shrinks on screen as zoom increases', () => {
    const target = map.stars[0]!;
    const near = { x: target.x + target.visual.radius + 1, y: target.y };
    const zoomedIn = { x: 0, y: 0, zoom: 3 };
    const screenNear = worldToScreen(near, zoomedIn, viewport);
    // Still findable at high zoom (screen tolerance scales down but stays usable).
    expect(hitTest(map.stars, zoomedIn, viewport, screenNear)?.nodeId).toBe(target.nodeId);
  });
});

describe('selectLabels', () => {
  const nodes: StarMapInputNode[] = Array.from({ length: 10 }, (_, i) =>
    node({ nodeId: `n${i}`, uri: `noriq://task/t${i}`, groupKey: 'task', degree: i }));
  const map = computeStarMap(nodes, []);
  const camera = { x: 0, y: 0, zoom: 1 };
  // Wide enough to include the deterministic ambient outer field regardless of seeded angle.
  const viewport = { width: 6000, height: 6000 };

  it('never exceeds the given budget', () => {
    const picked = selectLabels(map.stars, camera, viewport, 3);
    expect(picked.size).toBeLessThanOrEqual(3);
  });

  it('prefers higher-degree stars when budget is scarce', () => {
    const picked = selectLabels(map.stars, camera, viewport, 1);
    const [id] = [...picked];
    // The single highest-degree node is n9 (degree 9) — unless a screen collision knocked it out,
    // which can't happen when it's the only pick.
    expect(id).toBe('n9');
  });
});

describe('cluster label budget and framing', () => {
  const cluster = (id: string, x: number, memberCount: number, label = `System ${id}`): LayoutCluster => ({
    id, x, y: 100, radius: 40, anchorNodeId: `anchor-${id}`, label,
    memberNodeIds: Array.from({ length: memberCount }, (_, index) => `${id}-${index}`),
  });
  const viewport = { width: 800, height: 500 };
  const camera = { x: 100, y: 100, zoom: 1 };

  it('ranks by member count before greedily rejecting projected label collisions', () => {
    const selected = selectClusterLabels([
      cluster('small', 100, 3, 'Small overlapping system'),
      cluster('largest', 100, 80, 'Largest overlapping system'),
      cluster('separate', 350, 12),
    ], camera, viewport, 16);
    expect(selected.has('largest')).toBe(true);
    expect(selected.has('small')).toBe(false);
    expect(selected.has('separate')).toBe(true);
  });

  it('honors the default cap and raises it as zoom increases', () => {
    expect(clusterLabelBudget(0.4, 0.4)).toBe(STAR_MAP_DEFAULT_CLUSTER_LABEL_BUDGET);
    expect(clusterLabelBudget(1.6, 0.4)).toBeGreaterThan(STAR_MAP_DEFAULT_CLUSTER_LABEL_BUDGET);
  });

  it('reveals more non-colliding system labels when projected spacing grows', () => {
    const systems = [0, 70, 140, 210].map((x, index) => cluster(`c${index}`, x, 20 - index, 'A system label'));
    const overview = selectClusterLabels(systems, camera, viewport, 16);
    const zoomed = selectClusterLabels(systems, { ...camera, zoom: 2 }, viewport, 16);
    expect(zoomed.size).toBeGreaterThan(overview.size);
  });

  it('fits the meaningful cluster field more tightly than the ambient outer field', () => {
    const plan = node({ nodeId: 'frame-plan', uri: 'noriq://plan/frame', type: 'plan', groupKey: 'plan' });
    const ambient = Array.from({ length: 80 }, (_, index) => node({ nodeId: `ambient-${index}`, uri: `noriq://task/ambient-${index}` }));
    const map = computeStarMap([plan, ...ambient], []);
    const clusterFit = fitCamera(map.clusterBounds, viewport, 36);
    const wholeFieldFit = fitCamera(map.bounds, viewport, 36);
    expect(clusterFit.zoom).toBeGreaterThan(wholeFieldFit.zoom);
    expect(clusterFit.x).toBeCloseTo(map.clusters[0]!.x);
    expect(clusterFit.y).toBeCloseTo(map.clusters[0]!.y);
  });
});

describe('star map preferences (de)serialization', () => {
  it('round-trips through encode/decode', () => {
    const prefs = { camera: { x: 1, y: 2, zoom: 1.5 }, pins: { 'noriq://task/t1': { x: 5, y: 6 } }, hiddenGroups: ['file'], showEdges: false };
    expect(decodeStarMapPrefs(encodeStarMapPrefs(prefs))).toEqual(prefs);
  });

  it('falls back to defaults for missing or malformed stored data', () => {
    expect(decodeStarMapPrefs(null)).toEqual(DEFAULT_STAR_MAP_PREFS);
    expect(decodeStarMapPrefs('not json')).toEqual(DEFAULT_STAR_MAP_PREFS);
  });
});

describe('applyPins', () => {
  const nodes: StarMapInputNode[] = [
    node({ nodeId: 'n1', uri: 'noriq://task/t1', groupKey: 'task' }),
    node({ nodeId: 'n2', uri: 'noriq://task/t2', groupKey: 'task' }),
  ];
  const map = computeStarMap(nodes, []);

  it('overrides only the pinned star\'s position, never canonical data', () => {
    const pinned = applyPins(map, { 'noriq://task/t1': { x: 999, y: -999 } });
    expect(pinned.byUri.get('noriq://task/t1')!.x).toBe(999);
    expect(pinned.byUri.get('noriq://task/t1')!.y).toBe(-999);
    // The unpinned star's position is untouched.
    const original = map.byUri.get('noriq://task/t2')!;
    const stillOriginal = pinned.byUri.get('noriq://task/t2')!;
    expect([stillOriginal.x, stillOriginal.y]).toEqual([original.x, original.y]);
  });

  it('is a no-op for an empty pin set (identity, not a wasted rebuild)', () => {
    expect(applyPins(map, {})).toBe(map);
  });
});
