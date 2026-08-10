import { gzipSync } from 'node:zlib';
import { constellation, type ConstellationInputRows } from '../apps/api/src/memory/graph-queries';
import { computeStarMap, hitTest } from '../apps/web/src/components/starmap-layout';

type FixtureName = 'dense-hub' | 'disconnected-islands' | 'code-heavy' | 'memory-heavy';

interface FixtureSpec {
  name: FixtureName;
  nodes: number;
  edges: number;
  memories: number;
  symbols: number;
}

const SPECS: FixtureSpec[] = [
  { name: 'dense-hub', nodes: 12_000, edges: 48_000, memories: 800, symbols: 0 },
  { name: 'disconnected-islands', nodes: 18_000, edges: 17_920, memories: 1_200, symbols: 0 },
  { name: 'code-heavy', nodes: 60_000, edges: 120_000, memories: 500, symbols: 48_000 },
  { name: 'memory-heavy', nodes: 24_000, edges: 72_000, memories: 12_000, symbols: 0 },
];

function fixture(spec: FixtureSpec): ConstellationInputRows {
  const nodes: ConstellationInputRows['nodes'] = [];
  const memoryItems: ConstellationInputRows['memoryItems'] = [];
  const episodes: ConstellationInputRows['episodes'] = [];
  for (let i = 0; i < spec.nodes; i++) {
    const isSymbol = i >= spec.nodes - spec.symbols;
    const isMemory = !isSymbol && i < spec.memories;
    const type = isSymbol ? 'symbol' : isMemory ? 'memory' : i % 13 === 0 ? 'file' : i % 7 === 0 ? 'plan' : 'task';
    const id = `n${i}`;
    nodes.push({ nodeId: id, uri: `noriq://${type}/${id}`, type, label: `${type} ${i}`, createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString() });
    if (isMemory) memoryItems.push({ id, kind: i % 5 === 0 ? 'decision' : 'learning', authority: (i % 5) + 1, validity: i % 19 === 0 ? 'stale' : 'active' });
  }

  const edges: ConstellationInputRows['edges'] = [];
  const eligible = Math.max(1, spec.nodes - spec.symbols);
  for (let i = 0; i < spec.edges; i++) {
    let from: number;
    let to: number;
    if (spec.name === 'dense-hub') {
      from = i % 24;
      to = 24 + ((i * 7919) % Math.max(1, spec.nodes - 24));
    } else if (spec.name === 'disconnected-islands') {
      const islandStart = Math.floor((i % eligible) / 100) * 100;
      from = i % eligible;
      to = islandStart + ((i * 17 + 1) % Math.min(100, eligible - islandStart));
    } else {
      from = i % spec.nodes;
      to = (i * 7919 + 104729) % spec.nodes;
    }
    if (from === to) to = (to + 1) % spec.nodes;
    edges.push({ edgeId: `e${i}`, type: i % 9 === 0 ? 'depends_on' : 'related_to', fromNodeId: `n${from}`, toNodeId: `n${to}`, provenance: i % 3 === 0 ? 'benchmark' : null });
  }
  return { nodes, edges, memoryItems, episodes };
}

function ms(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]! * 100) / 100;
}

const results = [];
for (const spec of SPECS) {
  const rows = fixture(spec);
  const rawBytes = Buffer.byteLength(JSON.stringify(rows));
  const shapeRuns: number[] = [];
  let result = constellation(42, rows, { codeGraphPopulated: true }); // warm module/JIT paths
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    result = constellation(42, rows, { codeGraphPopulated: true });
    shapeRuns.push(ms(start));
  }
  const response = JSON.stringify(result);
  const responseBytes = Buffer.byteLength(response);
  const gzipBytes = gzipSync(response).byteLength;
  const layoutRuns: number[] = [];
  let layout = computeStarMap(result.nodes, result.edges);
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    layout = computeStarMap(result.nodes, result.edges);
    layoutRuns.push(ms(start));
  }
  const interactionStart = performance.now();
  for (let i = 0; i < 1000; i++) hitTest(layout.stars, { x: 0, y: 0, zoom: 1 }, { width: 1440, height: 900 }, { x: i % 1440, y: (i * 17) % 900 });
  const hitTest1kMs = ms(interactionStart);
  results.push({ fixture: spec.name, inputNodes: rows.nodes.length, inputEdges: rows.edges.length, rowsRead: rows.nodes.length + rows.edges.length + rows.memoryItems.length + rows.episodes.length, inputMiB: Math.round(rawBytes / 1024 / 1024 * 100) / 100, outputNodes: result.nodes.length, outputEdges: result.edges.length, responseKiB: Math.round(responseBytes / 1024 * 100) / 100, gzipKiB: Math.round(gzipBytes / 1024 * 100) / 100, shapeMedianMs: median(shapeRuns), layoutMedianMs: median(layoutRuns), hitTest1kMs });
}

console.log(JSON.stringify({ runtime: process.version, results }, null, 2));
