// PLNR-285: the memory star map's pure layout/encoding/hit-testing core. Zero DOM, zero canvas —
// jsdom implements no canvas 2D context, so anything computed inside the render loop is
// untestable in this repo's web test setup (locked decision). Every function here is a plain
// function of its arguments: same `ApiConstellation` payload in, same `ComputedStarMap` out, on
// every engine, forever. MemoryStarMap.tsx (the canvas + DOM-overlay component) is the only
// consumer of this module's canvas-facing values, and it never recomputes layout itself.
//
// --- Determinism (locked decision) ---------------------------------------------------------
// A star's position is seeded from its `uri` — never `nodeId`, never its index in the response
// array. `hashString`/`hashToUnit` below are ordinary integer arithmetic (Math.imul, no
// Math.random, no Date, no iteration-order dependence), so they return the identical value on
// every call, every engine, every process. `computeStarMap` runs the same fixed
// `RELAXATION_PASSES` every time it is called — never a live per-frame simulation — so calling it
// twice on byte-identical input rows produces byte-identical output positions.
//
// --- Stability under an unrelated node change (locked decision) ---------------------------
// A node's *ring* (its radial band) comes from `RING_ORDER`, a FIXED, static ordering over the
// complete `MemoryNodeType` vocabulary — never from which types happen to appear in this
// particular response. That is what stops an unrelated node of a *new* type from silently
// reshuffling every other type's ring. Within relaxation, repulsion is LOCAL: two stars only push
// on each other when they are within `INTERACTION_RADIUS` of one another, decided fresh from
// current positions each pass (grid-bucketed, so the cost stays near-linear at the 300-node
// ceiling). `RING_GAP` is chosen so that `RING_GAP - ringJitterMax(RING_GAP) > INTERACTION_RADIUS`
// — by the reverse triangle inequality, two points at different ring radii are *always* farther
// apart than that gap, so two stars in different rings can never land inside each other's
// interaction radius, regardless of how many other stars exist. A star's position is therefore
// fully determined by (a) its own uri's seed, (b) its ring (a static lookup, not data-dependent),
// (c) spring pulls from its OWN edges, and (d) repulsion from same-ring neighbors within
// `INTERACTION_RADIUS`. An unrelated star of a *different* type, added or removed anywhere in the
// map, changes none of those four inputs for an unconnected star — its position is untouched.
// Same-ring crowding can still shift a star's exact resting spot when a same-typed neighbor
// appears very close to it — that is the necessary, honest cost of collision avoidance, not an
// oversight.
// ---------------------------------------------------------------------------------------------

import { MemoryNodeType } from '@noriq-dev/shared';

// --- Input shapes (mirror ApiConstellationNode/Edge in api.ts; kept structurally compatible
// rather than imported, so this module can be unit-tested with zero dependency on api.ts). -----

export interface StarMapInputNode {
  nodeId: string;
  uri: string;
  type: string;
  kind: string | null;
  label: string;
  authority: number | null;
  validity: string | null;
  isLead: boolean | null;
  leadReasons: string[] | null;
  degree: number;
  groupKey: string;
}

export interface StarMapInputEdge {
  type: string;
  fromNodeId: string;
  toNodeId: string;
  provenance: string | null;
}

// --- Deterministic hashing --------------------------------------------------------------------

/** FNV-1a, 32-bit. Pure integer arithmetic (`Math.imul`) — no float rounding drift between
 *  engines, no Math.random, no external state. Exported so tests can assert on it directly. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A [0, 1) pseudo-random value deterministic in (seed, salt). Different salts on the same seed
 *  give independent-looking values without needing a stateful PRNG (which would reintroduce an
 *  iteration-order dependency between calls). */
function hashToUnit(seed: string, salt: string): number {
  return hashString(`${seed}#${salt}`) / 0x100000000;
}

// --- Ring assignment (groupKey -> radial band) ---------------------------------------------

/** The fixed, complete node-type vocabulary, in its declared order — NOT the set of groupKeys
 *  present in any one response. This is what makes ring assignment stable across reloads that add
 *  or drop node types from the sample (see module doc comment). */
const RING_ORDER: readonly string[] = MemoryNodeType.options;

export const RING_BASE = 90;
/** Must exceed `INTERACTION_RADIUS` by more than the max radial jitter within a ring (see module
 *  doc comment's reverse-triangle-inequality argument) so cross-ring local repulsion is
 *  impossible by construction. */
export const RING_GAP = 130;
export const RING_JITTER = RING_GAP * 0.6;
export const INTERACTION_RADIUS = 46;

function ringIndexFor(groupKey: string): number {
  const idx = RING_ORDER.indexOf(groupKey);
  if (idx >= 0) return idx;
  // Forward-compat: a groupKey outside the current MemoryNodeType vocabulary still gets a STABLE
  // ring, derived only from its own string — never from what else is present in this response.
  return RING_ORDER.length + (hashString(groupKey) % 8);
}

// --- Seeded initial placement ----------------------------------------------------------------

interface WorldPoint { x: number; y: number; }

function seedPosition(node: StarMapInputNode): WorldPoint {
  const ring = ringIndexFor(node.groupKey);
  const angle = hashToUnit(node.uri, 'angle') * Math.PI * 2;
  const radialJitter = hashToUnit(node.uri, 'radius') * RING_JITTER;
  const radius = RING_BASE + ring * RING_GAP + radialJitter;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

// --- Bounded relaxation ------------------------------------------------------------------------

/** Fixed, small, independent of node count — run ONCE per fetched map, never per frame. */
export const RELAXATION_PASSES = 14;
const SPRING_LENGTH = 64;
const SPRING_STRENGTH = 0.05;
const REPULSION_STRENGTH = 0.6;
const MAX_STEP_PER_PASS = 24;

/** Buckets current positions into `INTERACTION_RADIUS`-sized grid cells so neighbor lookups stay
 *  near-linear instead of the O(n^2) an all-pairs scan would cost at the 300-node ceiling. */
function buildGrid(positions: Map<string, WorldPoint>): Map<string, string[]> {
  const grid = new Map<string, string[]>();
  for (const [nodeId, p] of positions) {
    const key = `${Math.floor(p.x / INTERACTION_RADIUS)},${Math.floor(p.y / INTERACTION_RADIUS)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(nodeId);
    else grid.set(key, [nodeId]);
  }
  return grid;
}

function neighborsOf(nodeId: string, p: WorldPoint, grid: Map<string, string[]>): string[] {
  const cx = Math.floor(p.x / INTERACTION_RADIUS);
  const cy = Math.floor(p.y / INTERACTION_RADIUS);
  const out: string[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get(`${cx + dx},${cy + dy}`);
      if (!bucket) continue;
      for (const id of bucket) if (id !== nodeId) out.push(id);
    }
  }
  return out;
}

/** Relax seeded positions in place (a fresh Map, never mutating the caller's). Each pass computes
 *  every delta from the CURRENT (pre-pass) positions and applies them all together afterward —
 *  order-independent, so iterating nodes/edges in any order gives the same result. */
function relax(positions: Map<string, WorldPoint>, edgesByNodeId: StarMapInputEdge[]): Map<string, WorldPoint> {
  const current = new Map(positions);
  for (let pass = 0; pass < RELAXATION_PASSES; pass++) {
    const delta = new Map<string, WorldPoint>();
    const addDelta = (id: string, dx: number, dy: number) => {
      const d = delta.get(id) ?? { x: 0, y: 0 };
      delta.set(id, { x: d.x + dx, y: d.y + dy });
    };

    // Springs: pull edge endpoints toward SPRING_LENGTH apart. Only touches nodes that share a
    // real edge — never an "unrelated" pair.
    for (const e of edgesByNodeId) {
      const a = current.get(e.fromNodeId);
      const b = current.get(e.toNodeId);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const force = (dist - SPRING_LENGTH) * SPRING_STRENGTH;
      const ux = dx / dist;
      const uy = dy / dist;
      addDelta(e.fromNodeId, ux * force, uy * force);
      addDelta(e.toNodeId, -ux * force, -uy * force);
    }

    // Local repulsion: only among nodes within INTERACTION_RADIUS right now, via a spatial grid.
    // RING_GAP is sized so this can never fire across two different rings (module doc comment).
    const grid = buildGrid(current);
    for (const [nodeId, p] of current) {
      for (const otherId of neighborsOf(nodeId, p, grid)) {
        const o = current.get(otherId)!;
        const dx = p.x - o.x;
        const dy = p.y - o.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        if (dist >= INTERACTION_RADIUS) continue;
        const push = (INTERACTION_RADIUS - dist) * REPULSION_STRENGTH;
        addDelta(nodeId, (dx / dist) * push, (dy / dist) * push);
      }
    }

    for (const [id, d] of delta) {
      const p = current.get(id);
      if (!p) continue;
      const clampedDx = Math.max(-MAX_STEP_PER_PASS, Math.min(MAX_STEP_PER_PASS, d.x));
      const clampedDy = Math.max(-MAX_STEP_PER_PASS, Math.min(MAX_STEP_PER_PASS, d.y));
      current.set(id, { x: p.x + clampedDx, y: p.y + clampedDy });
    }
  }
  return current;
}

// --- Visual encoding (locked decision: every load-bearing distinction carries a non-colour
// channel — shape/fill/halo/size here, never colour alone) -----------------------------------

export type StarShape = 'circle' | 'diamond' | 'square' | 'triangle' | 'hex';

/** Coarse family per node type, chosen so a glance at SHAPE alone answers "what kind of thing is
 *  this": square = coordination/process (task/plan/run/agent/project), diamond = durable
 *  knowledge (memory/decision/requirement/procedure/episode/hazard-shaped kinds), triangle =
 *  repository/code structural fact (file/symbol/api/test/database_entity/repository/branch/
 *  revision), hex = anomaly/artifact (error/artifact), circle = everything else (unknown and any
 *  future type this table hasn't caught up with yet). */
const SHAPE_BY_TYPE: Record<string, StarShape> = {
  task: 'square', plan: 'square', run: 'square', agent: 'square', project: 'square',
  memory: 'diamond', decision: 'diamond', requirement: 'diamond', procedure: 'diamond', episode: 'diamond',
  file: 'triangle', symbol: 'triangle', api: 'triangle', database_entity: 'triangle', test: 'triangle',
  repository: 'triangle', branch: 'triangle', revision: 'triangle',
  error: 'hex', artifact: 'hex',
  unknown: 'circle',
};

export function starShapeFor(type: string): StarShape {
  return SHAPE_BY_TYPE[type] ?? 'circle';
}

export interface StarVisual {
  shape: StarShape;
  /** World-space radius in px at zoom=1. */
  radius: number;
  /** 0..1 fill alpha/luminance multiplier, driven by authority (memory-kind nodes) or a fixed
   *  baseline for everything else — never colour hue alone (colour is layered on TOP of this). */
  brightness: number;
  /** Lead vs settled — a HOLLOW (outline-only) star is a lead, a SOLID star is settled/non-memory.
   *  Never colour-only (mirrors MemoryView's LeadBadge convention). */
  fill: 'solid' | 'hollow';
  /** Validity treatment, independent of colour: 'dashed' = stale, 'broken' = invalid, 'none' =
   *  active or not applicable (non-memory node). */
  halo: 'none' | 'dashed' | 'broken';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function starVisual(node: StarMapInputNode): StarVisual {
  const radius = clamp(3 + Math.sqrt(node.degree + 1) * 2.2, 3, 13);
  const brightness = node.authority != null ? 0.32 + (clamp(node.authority, 1, 5) / 5) * 0.68 : 0.78;
  const fill: StarVisual['fill'] = node.isLead === true ? 'hollow' : 'solid';
  const halo: StarVisual['halo'] = node.validity === 'stale' ? 'dashed' : node.validity === 'invalid' ? 'broken' : 'none';
  return { shape: starShapeFor(node.type), radius, brightness, fill, halo };
}

// --- Computed layout -----------------------------------------------------------------------

export interface LayoutStar extends StarMapInputNode {
  x: number;
  y: number;
  ring: number;
  visual: StarVisual;
}

export interface LayoutEdge {
  type: string;
  fromNodeId: string;
  toNodeId: string;
  provenance: string | null;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number; }

export interface ComputedStarMap {
  stars: LayoutStar[];
  /** Edges whose BOTH endpoints resolved to a star in `stars` — mirrors the server's own
   *  dangling-edge pruning discipline, applied defensively here too (never trust a payload to be
   *  internally consistent). */
  edges: LayoutEdge[];
  bounds: Bounds;
  /** nodeId -> LayoutStar. Built once, reused for edge endpoint lookup and hit-testing. */
  byNodeId: Map<string, LayoutStar>;
  /** uri -> LayoutStar. A SEPARATE index (locked decision: index by both, never derive one key
   *  from the other) — this is the join PLNR-286's search highlight uses. */
  byUri: Map<string, LayoutStar>;
}

/** The one entry point: seed every node from its uri, relax a fixed number of passes, encode the
 *  visual channels, and index the result both ways. Call this ONCE per fetched constellation
 *  response (keyed by `memoryRevision` upstream) — never per frame, never per pan/zoom tick. */
export function computeStarMap(nodes: StarMapInputNode[], edges: StarMapInputEdge[]): ComputedStarMap {
  const seeded = new Map<string, WorldPoint>();
  for (const n of nodes) seeded.set(n.nodeId, seedPosition(n));

  const validEdges = edges.filter((e) => seeded.has(e.fromNodeId) && seeded.has(e.toNodeId));
  const relaxed = relax(seeded, validEdges);

  const byNodeId = new Map<string, LayoutStar>();
  const byUri = new Map<string, LayoutStar>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const stars: LayoutStar[] = nodes.map((n) => {
    const p = relaxed.get(n.nodeId) ?? seedPosition(n);
    const star: LayoutStar = { ...n, x: p.x, y: p.y, ring: ringIndexFor(n.groupKey), visual: starVisual(n) };
    byNodeId.set(n.nodeId, star);
    byUri.set(n.uri, star);
    minX = Math.min(minX, p.x - star.visual.radius);
    minY = Math.min(minY, p.y - star.visual.radius);
    maxX = Math.max(maxX, p.x + star.visual.radius);
    maxY = Math.max(maxY, p.y + star.visual.radius);
    return star;
  });

  if (!stars.length) { minX = -1; minY = -1; maxX = 1; maxY = 1; }

  return {
    stars,
    edges: validEdges.map((e) => ({ type: e.type, fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, provenance: e.provenance })),
    bounds: { minX, minY, maxX, maxY },
    byNodeId,
    byUri,
  };
}

// --- Camera + coordinate transforms ---------------------------------------------------------

export interface Camera { x: number; y: number; zoom: number; }
export interface Viewport { width: number; height: number; }

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };
export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 4;

export function clampZoom(zoom: number): number {
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

export function worldToScreen(p: WorldPoint, camera: Camera, viewport: Viewport): WorldPoint {
  return {
    x: (p.x - camera.x) * camera.zoom + viewport.width / 2,
    y: (p.y - camera.y) * camera.zoom + viewport.height / 2,
  };
}

export function screenToWorld(p: WorldPoint, camera: Camera, viewport: Viewport): WorldPoint {
  return {
    x: (p.x - viewport.width / 2) / camera.zoom + camera.x,
    y: (p.y - viewport.height / 2) / camera.zoom + camera.y,
  };
}

/** A camera that fits `bounds` inside `viewport` with `padding` px of margin, centered. Used for
 *  the initial view and a "reset view" action — never recomputed automatically after that (the
 *  human's pan/zoom, once made, persists). */
export function fitCamera(bounds: Bounds, viewport: Viewport, padding = 60): Camera {
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = clampZoom(Math.min((viewport.width - padding * 2) / w, (viewport.height - padding * 2) / h, 1.5));
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, zoom };
}

// --- Hit-testing (pointer -> star) ------------------------------------------------------------

/** Screen-space pointer -> the nearest star under it, honoring each star's own screen radius plus
 *  a small fixed hit-padding (world px, so it stays a constant screen tolerance regardless of
 *  zoom — a star is not harder to click just because it's small). Ties broken by nodeId ascending
 *  for a total, deterministic order. */
export function hitTest(stars: LayoutStar[], camera: Camera, viewport: Viewport, screenPoint: WorldPoint, hitPadPx = 5): LayoutStar | null {
  const world = screenToWorld(screenPoint, camera, viewport);
  let best: LayoutStar | null = null;
  let bestDist = Infinity;
  for (const s of stars) {
    const dx = s.x - world.x;
    const dy = s.y - world.y;
    const dist = Math.hypot(dx, dy);
    const tolerance = s.visual.radius + hitPadPx / camera.zoom;
    if (dist > tolerance) continue;
    if (dist < bestDist || (dist === bestDist && (!best || s.nodeId < best.nodeId))) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}

// --- Label decluttering -----------------------------------------------------------------------

/** Which stars get a text label at the current camera, out of a fixed on-screen budget. Ranked by
 *  degree then authority (server-provided importance signals, never re-derived classification) —
 *  then a simple greedy screen-space collision pass so labels never stack. Purely a function of
 *  (stars, camera, viewport, budget); the caller re-derives screen positions for the chosen set.
 *
 *  `priorityUris` (PLNR-286, optional — omitting it reproduces PLNR-285's exact ranking) puts
 *  every star whose uri is in the set at the FRONT of the ranking, ahead of degree/authority —
 *  during an active search, a match should get its label even if a higher-degree unrelated star
 *  would otherwise have won the budget. Ties within the priority group still break by
 *  degree/authority/nodeId, same as everything else. */
export function selectLabels(
  stars: LayoutStar[], camera: Camera, viewport: Viewport, budget: number, priorityUris?: ReadonlySet<string>,
): Set<string> {
  const visible = stars.filter((s) => {
    const p = worldToScreen(s, camera, viewport);
    return p.x >= -40 && p.x <= viewport.width + 40 && p.y >= -40 && p.y <= viewport.height + 40;
  });
  const ranked = [...visible].sort((a, b) => {
    if (priorityUris) {
      const ap = priorityUris.has(a.uri) ? 1 : 0;
      const bp = priorityUris.has(b.uri) ? 1 : 0;
      if (ap !== bp) return bp - ap;
    }
    if (b.degree !== a.degree) return b.degree - a.degree;
    const authDiff = (b.authority ?? 0) - (a.authority ?? 0);
    if (authDiff !== 0) return authDiff;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });

  const chosen: Array<{ id: string; x: number; y: number }> = [];
  const MIN_LABEL_GAP = 26;
  const picked = new Set<string>();
  for (const s of ranked) {
    if (picked.size >= budget) break;
    const p = worldToScreen(s, camera, viewport);
    const collides = chosen.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < MIN_LABEL_GAP);
    if (collides) continue;
    chosen.push({ id: s.nodeId, x: p.x, y: p.y });
    picked.add(s.nodeId);
  }
  return picked;
}

// --- Preference (de)serialization — pure encode/decode only; the component owns the actual
// localStorage.getItem/setItem calls (a DOM API), keeping this module DOM-free per the locked
// decision while still making the persisted shape testable without mounting anything. -----------

export interface StarMapPrefs {
  camera: Camera | null;
  /** uri -> manually dragged override position, world space. Never written back to any canonical
   *  node/edge (locked decision) — purely a client-side display override layered on top of the
   *  deterministic layout. */
  pins: Record<string, { x: number; y: number }>;
  /** groupKey values to hide. Empty = show every type. */
  hiddenGroups: string[];
  showEdges: boolean;
}

export const DEFAULT_STAR_MAP_PREFS: StarMapPrefs = { camera: null, pins: {}, hiddenGroups: [], showEdges: true };

export function decodeStarMapPrefs(raw: string | null): StarMapPrefs {
  if (!raw) return DEFAULT_STAR_MAP_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<StarMapPrefs>;
    return { ...DEFAULT_STAR_MAP_PREFS, ...parsed, pins: parsed.pins ?? {}, hiddenGroups: parsed.hiddenGroups ?? [] };
  } catch {
    return DEFAULT_STAR_MAP_PREFS;
  }
}

export function encodeStarMapPrefs(prefs: StarMapPrefs): string {
  return JSON.stringify(prefs);
}

/** Applies any pinned overrides on top of a computed layout's positions — pins take priority over
 *  the deterministic seed+relax position, exactly as MemoryGraph.tsx's own pin convention works. */
export function applyPins(map: ComputedStarMap, pins: Record<string, { x: number; y: number }>): ComputedStarMap {
  if (Object.keys(pins).length === 0) return map;
  const stars = map.stars.map((s) => {
    const pin = pins[s.uri];
    return pin ? { ...s, x: pin.x, y: pin.y } : s;
  });
  const byNodeId = new Map(stars.map((s) => [s.nodeId, s]));
  const byUri = new Map(stars.map((s) => [s.uri, s]));
  return { ...map, stars, byNodeId, byUri };
}

// --- Search highlight (PLNR-286): ignite matched stars, dim everything else -------------------
//
// Pure functions over (ComputedStarMap, hits) — same DOM/canvas-free discipline as the rest of
// this module (jsdom has no canvas 2D context, so anything the render loop reads must be provable
// out here). The component only reads the returned sets and modulates `ctx.globalAlpha`; it never
// re-derives which stars matched.
//
// Locked decisions this encodes: (1) the join is EXACT uri equality against `byUri` — never a
// label or id-substring heuristic, because a fuzzy join would ignite the WRONG star, which is
// worse than igniting none; (2) a hit with no uri, or whose uri is absent from `byUri`, is real
// work (the constellation is a bounded SAMPLE) and is counted in `unmatchedCount`, never silently
// dropped or silently matched; (3) non-matching stars DIM, they are never removed from `stars` —
// the caller still iterates every star in the layout, just at reduced alpha.

/** The minimal shape this module needs from a search hit — structurally compatible with
 *  `ApiMemoryHit` (api.ts) rather than importing it, matching `StarMapInputNode`'s own
 *  zero-dependency convention so this file stays unit-testable with plain object literals. */
export interface SearchHitRef {
  uri?: string | null;
}

export interface StarMapHighlight {
  /** uris of stars that are themselves a search hit, joined by exact `byUri` equality. Deduped —
   *  two hits sharing a uri ignite the same star once, not twice, so this can be SMALLER than
   *  `matchedHitCount` below. */
  matched: ReadonlySet<string>;
  /** uris of stars that are a one-hop neighbour of a matched star (via a real edge), excluding
   *  any star already in `matched` — the "context that makes a match meaningful". */
  halo: ReadonlySet<string>;
  /** How many HITS (not deduped stars) carried a uri that resolved to a star — a per-hit count,
   *  so `matchedHitCount + unmatchedCount === hitCount` always, exactly (the invariant "the count
   *  shown equals the hits returned" checks against). */
  matchedHitCount: number;
  /** Hits with no uri, or a uri absent from `byUri` — a real search hit legitimately outside the
   *  sampled field. Never hidden: the UI states this count rather than pretending it is 0. */
  unmatchedCount: number;
  /** Total hits the search returned. Always `matchedHitCount + unmatchedCount`. */
  hitCount: number;
}

/** The one entry point: join `hits` to `map.byUri` by exact equality, then expand one hop over
 *  `map.edges` to find the halo. Call this whenever the hit list changes — it is cheap (linear in
 *  hits + edges, both bounded) and holds no state of its own, unlike `computeStarMap` which is
 *  call-once-per-fetched-response. */
export function computeHighlight(map: ComputedStarMap, hits: readonly SearchHitRef[]): StarMapHighlight {
  const matched = new Set<string>();
  let matchedHitCount = 0;
  let unmatchedCount = 0;
  for (const hit of hits) {
    const uri = hit.uri;
    if (uri && map.byUri.has(uri)) { matched.add(uri); matchedHitCount++; }
    else unmatchedCount++;
  }

  const halo = new Set<string>();
  if (matched.size > 0) {
    for (const e of map.edges) {
      const a = map.byNodeId.get(e.fromNodeId);
      const b = map.byNodeId.get(e.toNodeId);
      if (!a || !b) continue;
      if (matched.has(a.uri) && !matched.has(b.uri)) halo.add(b.uri);
      if (matched.has(b.uri) && !matched.has(a.uri)) halo.add(a.uri);
    }
  }

  return { matched, halo, matchedHitCount, unmatchedCount, hitCount: hits.length };
}

export type StarHighlightState = 'match' | 'halo' | 'dim';

/** A star's highlight state given an active `StarMapHighlight`, or `null` when no query is active
 *  (the caller draws every star at its plain, un-modulated brightness in that case — "clearing the
 *  query restores the full field", not "every star quietly stays at dim's alpha"). */
export function highlightStateFor(highlight: StarMapHighlight | null, uri: string): StarHighlightState | null {
  if (!highlight) return null;
  if (highlight.matched.has(uri)) return 'match';
  if (highlight.halo.has(uri)) return 'halo';
  return 'dim';
}

/** Alpha multipliers applied ON TOP of a star's existing authority-driven brightness (multiply,
 *  never replace — PLNR-285's brightness channel keeps meaning a query is active) — dim is faint
 *  but never fully invisible (never removed, per the locked decision), halo sits just under full
 *  strength so a genuine match still reads as the brightest thing on screen. */
export const HIGHLIGHT_ALPHA_MULTIPLIER: Record<StarHighlightState, number> = {
  match: 1,
  halo: 0.82,
  dim: 0.15,
};

/** `null` (no active query) multiplies by 1 — every star draws exactly as PLNR-285 already did. */
export function highlightAlphaMultiplier(state: StarHighlightState | null): number {
  return state ? HIGHLIGHT_ALPHA_MULTIPLIER[state] : 1;
}

// --- Search/facet/selection URL state (PLNR-286) — encode/decode only, exactly the split
// `StarMapPrefs` above already uses: this module never reads `location` or calls `history.*`
// (DOM APIs), the component does, but the STRING <-> STATE mapping is a pure function so it is
// testable without mounting anything and without jsdom's canvas gap ever entering into it. -------

export interface StarMapSearchState {
  query: string;
  kind: string;
  minAuthority: string;
  validity: string;
  repositoryKey: string;
  branch: string;
  /** The selected star's stable uri, never its nodeId — a nodeId is only as durable as one
   *  fetched response, a uri is the thing worth putting in a link. */
  selectedUri: string | null;
}

export const DEFAULT_STAR_MAP_SEARCH_STATE: StarMapSearchState = {
  query: '', kind: '', minAuthority: '', validity: '', repositoryKey: '', branch: '', selectedUri: null,
};

/** Reads only the params this module owns out of a full query string (e.g. `location.search`) —
 *  every other param (the board view's `?task=`, etc.) is simply not looked at. */
export function decodeStarMapSearchState(search: string): StarMapSearchState {
  const params = new URLSearchParams(search);
  return {
    query: params.get('q') ?? '',
    kind: params.get('kind') ?? '',
    minAuthority: params.get('authority') ?? '',
    validity: params.get('validity') ?? '',
    repositoryKey: params.get('repo') ?? '',
    branch: params.get('branch') ?? '',
    selectedUri: params.get('sel'),
  };
}

/** Merges this module's own params onto an EXISTING query string, preserving every param it does
 *  not own — never a blind replace of `location.search`, so a link built while some other view's
 *  param is present does not silently drop it. An unset field deletes its key rather than writing
 *  an empty value, so a cleared search produces a clean URL, not `?q=&kind=&...`. */
export function encodeStarMapSearchState(search: string, state: StarMapSearchState): string {
  const params = new URLSearchParams(search);
  const setOrDelete = (key: string, value: string) => {
    if (value) params.set(key, value);
    else params.delete(key);
  };
  setOrDelete('q', state.query);
  setOrDelete('kind', state.kind);
  setOrDelete('authority', state.minAuthority);
  setOrDelete('validity', state.validity);
  setOrDelete('repo', state.repositoryKey);
  setOrDelete('branch', state.branch);
  setOrDelete('sel', state.selectedUri ?? '');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
