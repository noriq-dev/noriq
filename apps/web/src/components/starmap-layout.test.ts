// PLNR-285: coverage for the star map's pure layout/encoding/hit-testing core — the determinism,
// non-colour-channel encoding and uri-seeded stability acceptance lines all live here because they
// are provable ONLY against this DOM-free module (jsdom has no canvas 2D context).
import { describe, expect, it } from 'vitest';
import {
  applyPins, clampZoom, computeStarMap, decodeStarMapPrefs, DEFAULT_STAR_MAP_PREFS, encodeStarMapPrefs,
  fitCamera, hashString, hitTest, MAX_ZOOM, MIN_ZOOM, RELAXATION_PASSES, screenToWorld, selectLabels,
  starShapeFor, starVisual, worldToScreen,
  type StarMapInputEdge, type StarMapInputNode,
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

describe('stability under an unrelated node change (locked decision)', () => {
  // Two nodes of DIFFERENT types (different rings) with no edge between them. RING_GAP is sized
  // so cross-ring local repulsion is provably impossible (see the module's doc comment) — this is
  // the one case the module can GUARANTEE invariance for without needing to hand-verify hash
  // outputs, and it is the general case a client observes when the server's importance sampling
  // admits or drops one different, unrelated entity.
  const task = node({ nodeId: 'task-a', uri: 'noriq://task/stable-task', groupKey: 'task', type: 'task' });
  const memory = node({ nodeId: 'mem-a', uri: 'noriq://memory/stable-memory', groupKey: 'memory', type: 'memory' });

  it('leaves an unrelated, differently-typed star\'s position untouched when another node is added', () => {
    const before = computeStarMap([task, memory], []);
    const beforePos = before.byNodeId.get('task-a')!;

    const extra = node({ nodeId: 'file-x', uri: 'noriq://file/unrelated-new-file', groupKey: 'file', type: 'file', degree: 9 });
    const after = computeStarMap([task, memory, extra], []);
    const afterPos = after.byNodeId.get('task-a')!;

    expect([afterPos.x, afterPos.y]).toEqual([beforePos.x, beforePos.y]);
    // The memory star, also unrelated to the added file, is untouched too.
    const memBefore = before.byNodeId.get('mem-a')!;
    const memAfter = after.byNodeId.get('mem-a')!;
    expect([memAfter.x, memAfter.y]).toEqual([memBefore.x, memBefore.y]);
  });

  it('leaves an unrelated star\'s position untouched when another node is removed', () => {
    const extra = node({ nodeId: 'file-x', uri: 'noriq://file/unrelated-new-file', groupKey: 'file', type: 'file', degree: 9 });
    const withExtra = computeStarMap([task, memory, extra], []);
    const withoutExtra = computeStarMap([task, memory], []);
    const a = withExtra.byNodeId.get('task-a')!;
    const b = withoutExtra.byNodeId.get('task-a')!;
    expect([a.x, a.y]).toEqual([b.x, b.y]);
  });

  it('assigns a stable ring to a groupKey outside the current MemoryNodeType vocabulary, from its own hash alone', () => {
    const odd = node({ nodeId: 'odd-1', uri: 'noriq://unknown/odd-1', groupKey: 'not-a-real-type', type: 'unknown' });
    const a = computeStarMap([odd], []);
    const b = computeStarMap([odd, node({ nodeId: 'odd-2', uri: 'noriq://unknown/odd-2', groupKey: 'not-a-real-type', type: 'unknown' })], []);
    expect(a.byNodeId.get('odd-1')!.ring).toBe(b.byNodeId.get('odd-1')!.ring);
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
  // Same groupKey ('task') rings all 10 stars at radius up to RING_BASE + ring*RING_GAP +
  // RING_JITTER; large enough on every side that every star lands on-screen regardless of angle.
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
