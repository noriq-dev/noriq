import type { Constellation3DEdge, Constellation3DNode } from './constellation-3d-buffers';

export const CONSTELLATION_3D_LAYOUT_VERSION = 'space-v1';
export const CONSTELLATION_3D_LAYOUT_PASSES = 8;

export interface Constellation3DLayoutInput {
  generationId: string;
  layoutVersion: string;
  nodes: Constellation3DNode[];
  edges: Constellation3DEdge[];
  prior?: { generationId: string; layoutVersion: string; positions: Record<string, [number, number, number]> };
}

export interface Constellation3DLayoutResult {
  generationId: string;
  layoutVersion: string;
  positions: Record<string, [number, number, number]>;
}

function hashUnit(value: string, salt: string): number {
  let hash = 0x811c9dc5;
  const input = `${value}:${salt}`;
  for (let index = 0; index < input.length; index++) { hash ^= input.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0) / 0x100000000;
}

function seededPosition(node: Constellation3DNode): [number, number, number] {
  const seed = node.uri ?? node.id;
  const radius = node.community ? 280 : 60;
  const theta = hashUnit(seed, 'theta') * Math.PI * 2;
  const z = hashUnit(seed, 'z') * 2 - 1;
  const ring = Math.sqrt(Math.max(0, 1 - z * z));
  return [Math.cos(theta) * ring * radius, Math.sin(theta) * ring * radius, z * radius];
}

const add = (a: [number, number, number], b: [number, number, number]): [number, number, number] =>
  [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Deterministic fixed-pass layout. Prior anchors only initialize a compatible client transition;
 * they are never written back to the server or treated as canonical hierarchy coordinates. */
export function computeConstellation3DLayout(input: Constellation3DLayoutInput): Constellation3DLayoutResult {
  const nodes = [...input.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...input.edges].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const compatiblePrior = input.prior?.layoutVersion === input.layoutVersion ? input.prior.positions : null;
  let positions = new Map<string, [number, number, number]>();
  for (const node of nodes) {
    const prior = compatiblePrior?.[node.id];
    const source = node.position.every(Number.isFinite) ? node.position : seededPosition(node);
    // Prior coordinates are only a warm start and are pulled toward the generation's own anchor
    // in every pass, preventing a stale local preference from becoming canonical placement.
    positions.set(node.id, prior ? [prior[0] * 0.7 + source[0] * 0.3, prior[1] * 0.7 + source[1] * 0.3, prior[2] * 0.7 + source[2] * 0.3] : [...source]);
  }

  for (let pass = 0; pass < CONSTELLATION_3D_LAYOUT_PASSES; pass++) {
    const deltas = new Map<string, [number, number, number]>();
    const nudge = (id: string, delta: [number, number, number]) => deltas.set(id, add(deltas.get(id) ?? [0, 0, 0], delta));
    for (const edge of edges) {
      const from = positions.get(edge.fromId), to = positions.get(edge.toId);
      if (!from || !to) continue;
      const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
      const distance = Math.hypot(dx, dy, dz) || 1;
      const desired = edge.aggregate ? 210 : 75;
      const force = Math.max(-18, Math.min(18, (distance - desired) * 0.035 * Math.min(4, Math.max(0.25, edge.weight))));
      const delta: [number, number, number] = [dx / distance * force, dy / distance * force, dz / distance * force];
      nudge(edge.fromId, delta); nudge(edge.toId, [-delta[0], -delta[1], -delta[2]]);
    }
    for (const node of nodes) {
      const current = positions.get(node.id)!;
      const anchor = node.position.every(Number.isFinite) ? node.position : seededPosition(node);
      const pull = node.community ? 0.025 : 0.08;
      const delta = deltas.get(node.id) ?? [0, 0, 0];
      let next: [number, number, number] = [
        current[0] + delta[0] + (anchor[0] - current[0]) * pull,
        current[1] + delta[1] + (anchor[1] - current[1]) * pull,
        current[2] + delta[2] + (anchor[2] - current[2]) * pull,
      ];
      if (node.parentId) {
        const parent = byId.get(node.parentId), parentPosition = positions.get(node.parentId);
        if (parent && parentPosition) {
          const radius = parent.radius ?? 120;
          const dx = next[0] - parentPosition[0], dy = next[1] - parentPosition[1], dz = next[2] - parentPosition[2];
          const distance = Math.hypot(dx, dy, dz);
          if (distance > radius) next = [parentPosition[0] + dx / distance * radius, parentPosition[1] + dy / distance * radius, parentPosition[2] + dz / distance * radius];
        }
      }
      positions.set(node.id, next.map((value) => Math.fround(value)) as [number, number, number]);
    }
  }
  return { generationId: input.generationId, layoutVersion: input.layoutVersion, positions: Object.fromEntries(positions) };
}

export interface Constellation3DSpatialIndex {
  cellSize: number;
  cells: Map<string, string[]>;
  positions: ReadonlyMap<string, [number, number, number]>;
}

export function buildConstellation3DSpatialIndex(positions: ReadonlyMap<string, [number, number, number]>, cellSize = 80): Constellation3DSpatialIndex {
  const cells = new Map<string, string[]>();
  for (const [id, position] of positions) {
    const key = position.map((value) => Math.floor(value / cellSize)).join(',');
    const cell = cells.get(key);
    if (cell) cell.push(id); else cells.set(key, [id]);
  }
  for (const ids of cells.values()) ids.sort();
  return { cellSize, cells, positions };
}

export function nearestConstellationNode(index: Constellation3DSpatialIndex, point: [number, number, number], maxDistance = 100): string | null {
  const cx = Math.floor(point[0] / index.cellSize), cy = Math.floor(point[1] / index.cellSize), cz = Math.floor(point[2] / index.cellSize);
  const reach = Math.max(1, Math.ceil(maxDistance / index.cellSize));
  let best: { id: string; distance: number } | null = null;
  for (let x = cx - reach; x <= cx + reach; x++) for (let y = cy - reach; y <= cy + reach; y++) for (let z = cz - reach; z <= cz + reach; z++) {
    for (const id of index.cells.get(`${x},${y},${z}`) ?? []) {
      const candidate = index.positions.get(id)!;
      const distance = Math.hypot(candidate[0] - point[0], candidate[1] - point[1], candidate[2] - point[2]);
      if (distance <= maxDistance && (!best || distance < best.distance || (distance === best.distance && id < best.id))) best = { id, distance };
    }
  }
  return best?.id ?? null;
}

export function nearestDirectionalConstellationNode(
  index: Constellation3DSpatialIndex,
  currentId: string,
  direction: [number, number, number],
): string | null {
  const current = index.positions.get(currentId);
  if (!current) return null;
  let best: { id: string; score: number } | null = null;
  for (const [id, candidate] of index.positions) {
    if (id === currentId) continue;
    const dx = candidate[0] - current[0], dy = candidate[1] - current[1], dz = candidate[2] - current[2];
    const distance = Math.hypot(dx, dy, dz) || 1;
    const alignment = (dx * direction[0] + dy * direction[1] + dz * direction[2]) / distance;
    if (alignment <= 0.15) continue;
    const score = distance / (alignment * alignment);
    if (!best || score < best.score || (score === best.score && id < best.id)) best = { id, score };
  }
  return best?.id ?? null;
}

export async function computeConstellation3DLayoutOffThread(input: Constellation3DLayoutInput, signal?: AbortSignal): Promise<Constellation3DLayoutResult> {
  if (signal?.aborted) throw new DOMException('Layout cancelled', 'AbortError');
  // A browser without workers keeps the server-authored deterministic anchors. It must not move
  // the same O(N+E) convergence work onto the UI thread as a hidden fallback.
  if (typeof Worker === 'undefined') return {
    generationId: input.generationId, layoutVersion: input.layoutVersion,
    positions: Object.fromEntries(input.nodes.map((node) => [node.id, node.position])),
  };
  const worker = new Worker(new URL('./constellation-3d-layout.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const stop = () => { worker.terminate(); reject(new DOMException('Layout cancelled', 'AbortError')); };
    signal?.addEventListener('abort', stop, { once: true });
    worker.onmessage = (event: MessageEvent<Constellation3DLayoutResult>) => {
      signal?.removeEventListener('abort', stop); worker.terminate(); resolve(event.data);
    };
    worker.onerror = (event) => {
      signal?.removeEventListener('abort', stop); worker.terminate(); reject(new Error(event.message || 'Layout worker failed'));
    };
    worker.postMessage(input);
  });
}
