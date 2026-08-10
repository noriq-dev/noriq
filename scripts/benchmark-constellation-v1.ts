import { gzipSync } from 'node:zlib';
import { constellation, type ConstellationInputRows } from '../apps/api/src/memory/graph-queries';
import { compactConstellationCommunityPage, type ConstellationV2CommunityPage } from '../apps/api/src/memory/constellation-v2';
import { computeStarMap, hitTest } from '../apps/web/src/components/starmap-layout';
import { buildConstellation3DRenderPlan, type Constellation3DEdge, type Constellation3DNode } from '../apps/web/src/components/constellation-3d-buffers';
import { computeConstellation3DLayout } from '../apps/web/src/components/constellation-3d-layout';

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
  const pageCommunity = { id: 'community-benchmark-leaf', parentId: 'community-benchmark-root', level: 1, label: `${spec.name} leaf`, memberCount: Math.min(500, rows.nodes.length), childCommunityCount: 0, typeCounts: {}, internalEdgeCount: 499, internalWeight: 499, normalizedCohesion: 1, boundaryWeight: 32, anchor: [0, 0, 0] as [number, number, number] };
  const v2Page: ConstellationV2CommunityPage = {
    revision: { contract: 'constellation-v2', generationId: 'benchmark-generation', sourceRevision: 42, currentRevision: 42, topologyVersion: 'connectivity-v1', layoutVersion: 'space-v1', state: 'current', generatedAt: '2026-08-10T00:00:00.000Z' },
    community: pageCommunity, kind: 'entities', communities: [], externalCommunities: [], nextCursor: 'opaque-benchmark-cursor', coverage: { complete: false, reasons: ['page-limit-reached'] },
    entities: rows.nodes.slice(0, 500).map((node, index) => ({
      nodeId: node.nodeId, uri: node.uri, type: node.type, kind: node.type === 'memory' ? 'learning' : null,
      label: node.label, authority: node.type === 'memory' ? 3 : null, validity: node.type === 'memory' ? 'active' : null,
      isLead: node.type === 'memory', leadReasons: node.type === 'memory' ? ['authority'] : null,
      degree: 8, boundaryDegree: index % 7 === 0 ? 1 : 0, groupKey: node.type, communityId: pageCommunity.id,
      position: [index % 20, Math.floor(index / 20), (index * 17) % 31],
    })),
    routes: Array.from({ length: 512 }, (_, index) => ({
      fromCommunityId: pageCommunity.id, toCommunityId: `community-boundary-${index % 64}`,
      direction: index % 2 ? 'forward' as const : 'reverse' as const, count: index + 1, weight: 512 - index,
      byType: { related_to: index + 1 },
    })),
  };
  const compactResponse = JSON.stringify(compactConstellationCommunityPage(v2Page));
  const compactBytes = Buffer.byteLength(compactResponse);
  const compactGzipBytes = gzipSync(compactResponse).byteLength;
  const compactBudgetPassed = compactBytes <= 512 * 1024 && compactGzipBytes <= 128 * 1024;
  results.push({ fixture: spec.name, inputNodes: rows.nodes.length, inputEdges: rows.edges.length, rowsRead: rows.nodes.length + rows.edges.length + rows.memoryItems.length + rows.episodes.length, inputMiB: Math.round(rawBytes / 1024 / 1024 * 100) / 100, outputNodes: result.nodes.length, outputEdges: result.edges.length, responseKiB: Math.round(responseBytes / 1024 * 100) / 100, gzipKiB: Math.round(gzipBytes / 1024 * 100) / 100, shapeMedianMs: median(shapeRuns), layoutMedianMs: median(layoutRuns), hitTest1kMs, v2CompactPageKiB: Math.round(compactBytes / 1024 * 100) / 100, v2CompactGzipKiB: Math.round(compactGzipBytes / 1024 * 100) / 100, compactBudgetPassed });
}

const rendererNodes: Constellation3DNode[] = Array.from({ length: 12_000 }, (_, index) => ({
  id: `render-node-${index}`, uri: `noriq://memory/render-node-${index}`, label: `node ${index}`,
  type: index % 5 === 0 ? 'memory' : index % 5 === 1 ? 'task' : index % 5 === 2 ? 'file' : index % 5 === 3 ? 'error' : 'unknown',
  position: [index % 100, Math.floor(index / 100), index % 31], degree: 4, validity: index % 17 === 0 ? 'stale' : 'active', isLead: index % 101 === 0,
}));
const rendererEdges: Constellation3DEdge[] = Array.from({ length: 24_000 }, (_, index) => ({
  id: `render-edge-${index}`, fromId: `render-node-${index % rendererNodes.length}`,
  toId: `render-node-${(index * 7919 + 1) % rendererNodes.length}`, type: index % 7 === 0 ? 'depends_on' : 'related_to',
  direction: 'forward', weight: 1, aggregate: index % 3 === 0,
}));
const rendererPlanRuns: number[] = [];
let rendererPlan = buildConstellation3DRenderPlan(rendererNodes, rendererEdges, 'render-node-42');
for (let index = 0; index < 5; index++) {
  const start = performance.now();
  rendererPlan = buildConstellation3DRenderPlan(rendererNodes, rendererEdges, 'render-node-42');
  rendererPlanRuns.push(ms(start));
}
const rendererBufferPlan = {
  nodes: rendererPlan.nodeCount, edges: rendererPlan.baseEdges.length + rendererPlan.promotedEdges.length,
  drawCallCeiling: rendererPlan.drawCallCeiling, labels: rendererPlan.labels.length,
  selectionPlanMedianMs: median(rendererPlanRuns), interactionBudgetPassed: median(rendererPlanRuns) <= 100,
};
const workerLayoutRuns: number[] = [];
for (let index = 0; index < 3; index++) {
  const start = performance.now();
  computeConstellation3DLayout({ generationId: 'benchmark', layoutVersion: 'space-v1', nodes: rendererNodes, edges: rendererEdges });
  workerLayoutRuns.push(ms(start));
}
const workerLayout = {
  passes: 8, medianMs: median(workerLayoutRuns), runsOffMainThread: true,
  generationBudgetPassed: median(workerLayoutRuns) <= 10_000,
};

console.log(JSON.stringify({ runtime: process.version, results, rendererBufferPlan, workerLayout }, null, 2));
if (results.some((result) => !result.compactBudgetPassed)) process.exitCode = 1;
if (!rendererBufferPlan.interactionBudgetPassed || rendererBufferPlan.drawCallCeiling > 14) process.exitCode = 1;
if (!workerLayout.generationBudgetPassed) process.exitCode = 1;
