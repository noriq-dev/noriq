import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Three from 'three';
import {
  aggregateRouteWidth, buildConstellation3DRenderPlan, communityTooltipContent, constellation3DColorType,
  constellation3DNodeEncoding, isOffPageIncidentEdge, promotedEdgeLabelText, type Constellation3DEdge,
  type Constellation3DEdgeSegment, type ConstellationCommunityTooltip, type Constellation3DNode,
  type Constellation3DNodeInstance, type Constellation3DShape,
} from './constellation-3d-buffers';
import { encodingForType, resolveConstellationToken } from './constellation-encoding';
import {
  buildConstellation3DSpatialIndex, computeConstellation3DLayoutOffThread, nearestDirectionalConstellationNode,
} from './constellation-3d-layout';
import {
  CONSTELLATION_3D_PREFS_VERSION, constellationCameraPosition, createCameraTransition, DEFAULT_CONSTELLATION_3D_CAMERA,
  dollyConstellationCamera, focusConstellationCamera, loadConstellation3DPreferences, orbitConstellationCamera,
  panConstellationCamera, sampleCameraTransition, saveConstellation3DPreferences, type CameraTransition,
  type Constellation3DCamera,
} from './constellation-3d-navigation';

const LABEL_BUDGET = 24;
// Layered radial falloff (PLNR-438): outer well at 10% opacity, mid at 22%, both tinted by the
// community's dominant type — sized as a fixed ratio of the solid core sphere the standard node
// pass already renders, so "outer radius from aggregate connectivity" (the core's own scale,
// computed by constellation3DNodeEncoding from degree+authority) drives every layer together
// rather than needing a second connectivity computation.
const COMMUNITY_WELL_MID_RATIO = 1.6;
const COMMUNITY_WELL_OUTER_RATIO = 2.4;
// Selection reticle (PLNR-439, screen spec 1b "the pin") — every radius is a ratio of the
// selected node's own connectivity-derived scale, the same pattern PLNR-438 established for the
// community wells and hover ring, so the reticle grows/shrinks with whatever it is pinned to
// instead of carrying an independent, undesigned size. Reticle tick geometry and ring radii are
// this task's discretion (executionSpec).
const RETICLE_RING_RATIO = 1.55;
const RETICLE_DASH_RING_RATIO = 1.05;
const RETICLE_GLOW_RATIO = 0.62;
const RETICLE_TICK_INNER_RATIO = 1.5;
const RETICLE_TICK_OUTER_RATIO = 1.9;
// The pin's title is promoted above the standard label treatment and drawn 40px above the node
// (screen spec 1b) rather than centred on it — the deliberate offset is what keeps it clear of a
// promoted edge label pinned at 72% along the edge (see `midpoint` below): a true midpoint would
// land squarely on this same title.
const PINNED_TITLE_OFFSET_PX = 40;

export interface MemoryConstellation3DProps {
  projectId: string;
  generationId: string;
  layoutVersion: string;
  nodes: Constellation3DNode[];
  edges: Constellation3DEdge[];
  selectedNodeId: string | null;
  highlightedNodeIds?: string[];
  theme?: 'dark' | 'light';
  reducedMotion?: boolean;
  onSelectNode?: (nodeId: string | null) => void;
  onOpenEgoNetwork?: (uri: string) => void;
  onOpenInspector?: (uri: string) => void;
  onRendererFailure?: (reason: string) => void;
}

interface LabelPosition {
  key: string;
  text: string;
  /** Second line, community labels only — "N entities" beneath the name (PLNR-438). Undefined
   *  keeps every other label exactly as single-line as before. */
  subtext?: string;
  x: number;
  y: number;
  promoted: boolean;
  /** The pinned node's own title (PLNR-439) — distinct from `promoted` (which styles a promoted
   *  EDGE label amber): the title stays `--text` coloured but grows to the promoted type scale and
   *  renders offset above the node instead of centred on it. */
  pinned?: boolean;
}

interface HoverTooltip {
  nodeId: string;
  content: ConstellationCommunityTooltip;
  x: number;
  y: number;
}

interface RendererState {
  THREE: typeof Three;
  renderer: Three.WebGLRenderer;
  scene: Three.Scene;
  camera: Three.PerspectiveCamera;
  nodeMeshes: Three.InstancedMesh[];
  // Non-interactive: community gravity-well falloff layers + the hover ring. Disposed alongside
  // nodeMeshes but never raycast against — intersecting a giant 10%-opacity outer well would steal
  // clicks from whatever it visually surrounds.
  decorativeMeshes: Three.Object3D[];
  edgeObjects: Three.Object3D[];
  nodeById: Map<string, Constellation3DNodeInstance>;
  renderEdges: (selectedNodeId: string | null) => void;
  applyCamera: (camera: Constellation3DCamera) => void;
  setHover: (node: Constellation3DNodeInstance | null) => void;
  setSelection: (node: Constellation3DNodeInstance | null) => void;
  render: () => void;
  dispose: () => void;
}

function geometryFor(THREE: typeof Three, shape: Constellation3DShape): Three.BufferGeometry {
  switch (shape) {
    case 'box': return new THREE.BoxGeometry(1.5, 1.5, 1.5);
    case 'octahedron': return new THREE.OctahedronGeometry(1.2, 0);
    case 'cone': return new THREE.ConeGeometry(1, 2.1, 5);
    case 'dodecahedron': return new THREE.DodecahedronGeometry(1.1, 0);
    default: return new THREE.SphereGeometry(1, 8, 6);
  }
}

function lineObject(
  THREE: typeof Three,
  segments: Constellation3DEdgeSegment[],
  color: number,
  opacity: number,
  renderOrder: number,
): Three.LineSegments | null {
  if (segments.length === 0) return null;
  const positions = new Float32Array(segments.length * 6);
  segments.forEach((edge, index) => positions.set([...edge.from, ...edge.to], index * 6));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: renderOrder === 0 });
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = renderOrder;
  lines.frustumCulled = true;
  return lines;
}

function midpoint(edge: Constellation3DEdgeSegment): [number, number, number] {
  const forward = edge.direction !== 'reverse';
  const from = forward ? edge.from : edge.to;
  const to = forward ? edge.to : edge.from;
  return [from[0] + (to[0] - from[0]) * 0.72, from[1] + (to[1] - from[1]) * 0.72, from[2] + (to[2] - from[2]) * 0.72];
}

/** Dashed variant of `lineObject` (PLNR-439: historical and off-page promoted edges, screen spec
 * 1b). Deliberately does NOT use `Line.computeLineDistances()` — that method accumulates distance
 * across the WHOLE buffer, so every segment after the first would inherit the prior segments'
 * cumulative length and its dash phase would drift instead of starting fresh. Each independent
 * relationship gets its own dash pattern reset to 0 at its own start. */
function dashedLineObject(
  THREE: typeof Three,
  segments: Constellation3DEdgeSegment[],
  color: number,
  opacity: number,
  dashSize: number,
  gapSize: number,
  renderOrder: number,
): Three.LineSegments | null {
  if (segments.length === 0) return null;
  const positions = new Float32Array(segments.length * 6);
  const lineDistances = new Float32Array(segments.length * 2);
  segments.forEach((edge, index) => {
    positions.set([...edge.from, ...edge.to], index * 6);
    const dx = edge.to[0] - edge.from[0], dy = edge.to[1] - edge.from[1], dz = edge.to[2] - edge.from[2];
    lineDistances[index * 2] = 0;
    lineDistances[index * 2 + 1] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('lineDistance', new THREE.BufferAttribute(lineDistances, 1));
  geometry.computeBoundingSphere();
  const material = new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize, gapSize, depthWrite: false });
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = renderOrder;
  lines.frustumCulled = true;
  return lines;
}

/** Unit-radius ring geometry for the selection reticle's concentric rings, scaled by `radius`
 * directly (not via object.scale) so a single reticle Object3D group can be repositioned/rescaled
 * uniformly by the pinned node's own scale in `setSelection` while each ring keeps its own ratio. */
function reticleCircleGeometry(THREE: typeof Three, radius: number, segments = 48): Three.BufferGeometry {
  const positions = new Float32Array(segments * 3);
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    positions.set([Math.cos(angle) * radius, Math.sin(angle) * radius, 0], index * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** Four cardinal tick marks, r `innerRadius` → `outerRadius`, same unit-radius convention as
 * `reticleCircleGeometry`. */
function reticleTickGeometry(THREE: typeof Three, innerRadius: number, outerRadius: number): Three.BufferGeometry {
  const axes: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const positions = new Float32Array(axes.length * 2 * 3);
  axes.forEach(([dx, dy], index) => {
    positions.set([dx * innerRadius, dy * innerRadius, 0, dx * outerRadius, dy * outerRadius, 0], index * 6);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** Lazy Three/WebGL renderer. The scene contains bounded instanced meshes and buffer geometries;
 * React only owns the canvas, failure state, and a fixed label budget. The v2 controller hands
 * renderer failures to its full textual peer. */
export function MemoryConstellation3D({
  projectId, generationId, layoutVersion, nodes, edges, selectedNodeId, highlightedNodeIds = [], theme = 'dark', reducedMotion = false,
  onSelectNode, onOpenEgoNetwork, onOpenInspector, onRendererFailure,
}: MemoryConstellation3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RendererState | null>(null);
  const [labels, setLabels] = useState<LabelPosition[]>([]);
  // Hover is entirely separate state from `selectedNodeId` (the pin) — nothing in this file ever
  // writes `hoveredTooltip` into `selectedNodeId`, or calls `onSelectNode` from a hover path. That
  // separation IS the "hover never overrides a pinned selection" guarantee (PLNR-379/PLNR-438):
  // there is no shared variable left for a hover to steal.
  const [hoveredTooltip, setHoveredTooltip] = useState<HoverTooltip | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [layoutNodes, setLayoutNodes] = useState(nodes);
  const priorLayoutRef = useRef<{ generationId: string; layoutVersion: string; positions: Record<string, [number, number, number]> } | undefined>();
  const [cameraState, setCameraState] = useState<Constellation3DCamera>(() => loadConstellation3DPreferences(projectId, layoutVersion).camera);
  const transitionRef = useRef<CameraTransition | null>(null);
  const transitionFrameRef = useRef(0);
  const dragRef = useRef<{ mode: 'orbit' | 'pan'; x: number; y: number; camera: Constellation3DCamera } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    computeConstellation3DLayoutOffThread({ generationId, layoutVersion, nodes, edges, prior: priorLayoutRef.current }, controller.signal)
      .then((result) => {
        priorLayoutRef.current = result;
        setLayoutNodes(nodes.map((node) => ({ ...node, position: result.positions[node.id] ?? node.position })));
      })
      .catch((error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) setLayoutNodes(nodes); });
    return () => controller.abort();
  }, [generationId, layoutVersion, nodes, edges]);

  useEffect(() => {
    setCameraState(loadConstellation3DPreferences(projectId, layoutVersion).camera);
  }, [projectId, layoutVersion]);

  const positions = useMemo(() => new Map(layoutNodes.map((node) => [node.id, node.position] as const)), [layoutNodes]);
  const spatialIndex = useMemo(() => buildConstellation3DSpatialIndex(positions), [positions]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    let removeResizeListener: (() => void) | null = null;
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      const reason = 'WebGL context was lost';
      setFailure(reason);
      onRendererFailure?.(reason);
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);

    void import('three').then((THREE) => {
      if (cancelled) return;
      try {
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
        if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 is unavailable');
        renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        renderer.setClearColor(theme === 'dark' ? 0x0c1017 : 0xf4f6fa, 1);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 20_000);
        const initialCameraPosition = constellationCameraPosition(cameraState);
        camera.position.set(...initialCameraPosition);
        camera.lookAt(...cameraState.target);
        const highlighted = new Set(highlightedNodeIds);
        const plan = buildConstellation3DRenderPlan(layoutNodes, edges, null, LABEL_BUDGET, highlighted);
        const nodeMeshes: Three.InstancedMesh[] = [];
        const decorativeMeshes: Three.Object3D[] = [];
        const nodeById = new Map<string, Constellation3DNodeInstance>(layoutNodes.map((node) => {
          const encoded = constellation3DNodeEncoding(node);
          encoded.highlighted = highlighted.has(node.id);
          return [node.id, encoded];
        }));
        const matrix = new THREE.Matrix4();
        // Type colour is a theme.css token, resolved live off the cascade and cached per token
        // (not per node) — a handful of getComputedStyle calls per scene rebuild, not one per
        // instance. Replaces hueFor()'s hash-derived HSL (PLNR-437).
        const tokenColors = new Map<string, Three.Color>();
        const colorForType = (type: string) => {
          const token = encodingForType(type).token;
          let cached = tokenColors.get(token);
          if (!cached) { cached = new THREE.Color(resolveConstellationToken(token)); tokenColors.set(token, cached); }
          return cached;
        };

        for (const [shape, instances] of plan.nodeGroups) {
          for (const faded of [false, true]) {
            const group = instances.filter((node) => (node.opacity < 1) === faded);
            if (group.length === 0) continue;
            const geometry = geometryFor(THREE, shape);
            const material = new THREE.MeshBasicMaterial({ transparent: faded, opacity: faded ? 0.42 : 1, vertexColors: true });
            const mesh = new THREE.InstancedMesh(geometry, material, group.length);
            mesh.userData.nodeIds = group.map((node) => node.id);
            group.forEach((node, index) => {
              const scale = node.scale * (node.highlighted ? 1.3 : 1);
              matrix.makeScale(scale, scale, scale);
              matrix.setPosition(...node.position);
              mesh.setMatrixAt(index, matrix);
              // Community aggregates tint by dominant type (PLNR-438 locked decision); every other
              // node keeps tinting by its own type exactly as PLNR-437 shipped.
              mesh.setColorAt(index, colorForType(constellation3DColorType(node)));
            });
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            mesh.computeBoundingSphere();
            scene.add(mesh);
            nodeMeshes.push(mesh);
          }
        }

        const leadNodes = layoutNodes.map(constellation3DNodeEncoding).filter((node) => node.halo);
        if (leadNodes.length > 0) {
          const halo = new THREE.InstancedMesh(
            new THREE.TorusGeometry(1.35, 0.12, 5, 12),
            new THREE.MeshBasicMaterial({ color: theme === 'dark' ? 0xffd166 : 0x8a5a00, transparent: true, opacity: 0.9 }),
            leadNodes.length,
          );
          halo.userData.nodeIds = leadNodes.map((node) => node.id);
          leadNodes.forEach((node, index) => {
            const scale = node.scale * (highlighted.has(node.id) ? 1.3 : 1);
            matrix.makeScale(scale, scale, scale);
            matrix.setPosition(...node.position);
            halo.setMatrixAt(index, matrix);
          });
          halo.instanceMatrix.needsUpdate = true;
          halo.computeBoundingSphere();
          scene.add(halo);
          nodeMeshes.push(halo);
        }

        // Community gravity wells (PLNR-438): two extra low-opacity layers per community, sized as
        // a fixed ratio of the solid core sphere the standard node pass above already drew for
        // every community node — that core IS the third, innermost falloff layer, so this adds
        // exactly two draw calls total (not two per community) regardless of how many communities
        // are in the reference frame. depthWrite is off so the layers blend into the well rather
        // than occluding whatever sits behind them.
        const communityNodes = [...nodeById.values()].filter((node) => node.community);
        if (communityNodes.length > 0) {
          const outer = new THREE.InstancedMesh(
            new THREE.SphereGeometry(1, 12, 8),
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.1, vertexColors: true, depthWrite: false }),
            communityNodes.length,
          );
          const mid = new THREE.InstancedMesh(
            new THREE.SphereGeometry(1, 12, 8),
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, vertexColors: true, depthWrite: false }),
            communityNodes.length,
          );
          outer.renderOrder = -2;
          mid.renderOrder = -1;
          communityNodes.forEach((node, index) => {
            const color = colorForType(constellation3DColorType(node));
            const outerScale = node.scale * COMMUNITY_WELL_OUTER_RATIO;
            matrix.makeScale(outerScale, outerScale, outerScale);
            matrix.setPosition(...node.position);
            outer.setMatrixAt(index, matrix);
            outer.setColorAt(index, color);
            const midScale = node.scale * COMMUNITY_WELL_MID_RATIO;
            matrix.makeScale(midScale, midScale, midScale);
            matrix.setPosition(...node.position);
            mid.setMatrixAt(index, matrix);
            mid.setColorAt(index, color);
          });
          outer.instanceMatrix.needsUpdate = true;
          mid.instanceMatrix.needsUpdate = true;
          if (outer.instanceColor) outer.instanceColor.needsUpdate = true;
          if (mid.instanceColor) mid.instanceColor.needsUpdate = true;
          outer.computeBoundingSphere();
          mid.computeBoundingSphere();
          scene.add(outer);
          scene.add(mid);
          decorativeMeshes.push(outer, mid);
        }

        // Hover pre-selection ring (PLNR-438): one reusable dashed LineLoop, built once at a unit
        // radius and repositioned/rescaled per hover via `setHover` below — never rebuilt, so hover
        // never adds a draw call beyond this single, always-present object. Deliberately NOT
        // billboarded, matching the existing lead-halo Torus's convention of sitting in its default
        // plane rather than always facing the camera.
        const ringSegments = 64;
        const ringPositions = new Float32Array(ringSegments * 3);
        for (let index = 0; index < ringSegments; index += 1) {
          const angle = (index / ringSegments) * Math.PI * 2;
          ringPositions.set([Math.cos(angle), Math.sin(angle), 0], index * 3);
        }
        const ringGeometry = new THREE.BufferGeometry();
        ringGeometry.setAttribute('position', new THREE.BufferAttribute(ringPositions, 3));
        const hoverRing = new THREE.LineLoop(
          ringGeometry,
          new THREE.LineDashedMaterial({ color: 0xffd166, transparent: true, opacity: 0.8, dashSize: 0.35, gapSize: 0.28, depthTest: false }),
        );
        hoverRing.computeLineDistances();
        hoverRing.visible = false;
        hoverRing.renderOrder = 20;
        scene.add(hoverRing);
        decorativeMeshes.push(hoverRing);

        // Selection reticle (PLNR-439, screen spec 1b "the pin"): concentric solid ring, a dashed
        // inner ring, four cardinal tick marks, and an inner glow ring — four small, reusable
        // objects built once here and only repositioned/rescaled by `setSelection` below, the exact
        // same "never rebuild, never touch node buffers" convention `hoverRing` already established.
        // Deliberately a richer composition than the single-ring hover treatment so the two read as
        // different states even before colour: a hover is provisional, a pin is a lock.
        const reticleAmber = theme === 'dark' ? 0xffd166 : 0x8a5a00;
        const reticleRing = new THREE.LineLoop(
          reticleCircleGeometry(THREE, RETICLE_RING_RATIO),
          new THREE.LineBasicMaterial({ color: reticleAmber, transparent: true, opacity: 0.35, depthTest: false }),
        );
        const reticleDashedRing = new THREE.LineLoop(
          reticleCircleGeometry(THREE, RETICLE_DASH_RING_RATIO),
          new THREE.LineDashedMaterial({ color: reticleAmber, transparent: true, opacity: 1, dashSize: 0.18, gapSize: 0.12, depthTest: false }),
        );
        reticleDashedRing.computeLineDistances();
        const reticleGlow = new THREE.LineLoop(
          reticleCircleGeometry(THREE, RETICLE_GLOW_RATIO, 32),
          new THREE.LineBasicMaterial({ color: reticleAmber, transparent: true, opacity: 0.2, depthTest: false }),
        );
        const reticleTicks = new THREE.LineSegments(
          reticleTickGeometry(THREE, RETICLE_TICK_INNER_RATIO, RETICLE_TICK_OUTER_RATIO),
          new THREE.LineBasicMaterial({ color: reticleAmber, transparent: true, opacity: 0.9, depthTest: false }),
        );
        const reticleParts: Three.Object3D[] = [reticleRing, reticleDashedRing, reticleGlow, reticleTicks];
        for (const part of reticleParts) {
          part.visible = false;
          part.renderOrder = 15;
          scene.add(part);
          decorativeMeshes.push(part);
        }

        const edgeObjects: Three.Object3D[] = [];
        const clearEdges = () => {
          for (const object of edgeObjects.splice(0)) {
            scene.remove(object);
            const renderable = object as Three.LineSegments | Three.InstancedMesh;
            renderable.geometry?.dispose();
            const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
            materials.filter(Boolean).forEach((material) => material.dispose());
          }
        };

        const projectLabels = (labelNodes: Constellation3DNodeInstance[], promoted: Constellation3DEdgeSegment[], selection: string | null) => {
          const width = host.clientWidth || 1, height = host.clientHeight || 1;
          const visible: LabelPosition[] = [];
          for (const node of labelNodes) {
            const point = new THREE.Vector3(...node.position).project(camera);
            if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) continue;
            // Two-line label for a community: name + entity count (PLNR-438) — one budget entry,
            // same as before, just carrying a second rendered line.
            const subtext = node.community ? `${(node.memberCount ?? 0).toLocaleString()} entities` : undefined;
            const pinned = node.id === selection;
            const y = (1 - point.y) * height / 2;
            // The pin's title renders 40px above the node instead of centred on it (screen spec
            // 1b) — that offset, together with promoted edge labels sitting at 72% along the edge
            // rather than the midpoint, is the whole collision-avoidance mechanism: nothing here
            // computes an overlap check, the two placements are just designed apart.
            visible.push({
              key: `node:${node.id}`, text: node.label, subtext, x: (point.x + 1) * width / 2,
              y: pinned ? y - PINNED_TITLE_OFFSET_PX : y, promoted: false, pinned,
            });
          }
          for (const edge of promoted.slice(0, Math.max(0, LABEL_BUDGET - visible.length))) {
            const point = new THREE.Vector3(...midpoint(edge)).project(camera);
            if (point.z < -1 || point.z > 1) continue;
            const otherId = edge.fromId === selection ? edge.toId : edge.fromId;
            const targetLabel = nodeById.get(otherId)?.label ?? '';
            visible.push({
              key: `edge:${edge.id}`, text: promotedEdgeLabelText(edge, targetLabel),
              x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2, promoted: true,
            });
          }
          setLabels(visible.slice(0, LABEL_BUDGET));
        };

        let currentLabels = plan.labels;
        let currentPromoted: Constellation3DEdgeSegment[] = [];
        let currentSelection: string | null = null;
        let consecutiveOverBudgetFrames = 0;
        let performanceFailureReported = false;
        const render = () => {
          const started = performance.now();
          renderer.render(scene, camera);
          const elapsed = performance.now() - started;
          consecutiveOverBudgetFrames = elapsed > 33 ? consecutiveOverBudgetFrames + 1 : 0;
          if (consecutiveOverBudgetFrames >= 3 && !performanceFailureReported) {
            performanceFailureReported = true;
            const reason = `3D rendering exceeded the 33 ms weak-client budget for ${consecutiveOverBudgetFrames} consecutive frames`;
            setFailure(reason);
            onRendererFailure?.(reason);
          }
        };
        const setHover = (node: Constellation3DNodeInstance | null) => {
          if (!node) { if (hoverRing.visible) { hoverRing.visible = false; render(); } return; }
          const ringScale = node.scale * COMMUNITY_WELL_OUTER_RATIO * 1.08;
          hoverRing.position.set(...node.position);
          hoverRing.scale.setScalar(ringScale);
          hoverRing.visible = true;
          render();
        };
        // Reticle update: only repositions/rescales the four fixed parts built above — never
        // rebuilds geometry, never touches the (potentially 12k-instance) node buffers. This is
        // the "selection updates touch only the bounded relevant buffers" budget (PLNR-371/377)
        // applied to the pin itself.
        const setSelection = (node: Constellation3DNodeInstance | null) => {
          for (const part of reticleParts) {
            if (node) { part.position.set(...node.position); part.scale.setScalar(node.scale); }
            part.visible = node !== null;
          }
          render();
        };
        const renderEdges = (selection: string | null) => {
          clearEdges();
          const selectedPlan = buildConstellation3DRenderPlan(layoutNodes, edges, selection, LABEL_BUDGET, highlighted);
          // Aggregate community-to-community routes render as instanced tubes, not thin lines — a
          // `LineBasicMaterial.linewidth` is silently clamped to 1px on most WebGL backends, so it
          // cannot honestly carry "route thickness maps to boundary weight" (PLNR-438 locked
          // decision). A tube radius can. This is also what keeps aggregate routes visually
          // distinct from raw entity edges (PLNR-379): different geometry, not just a numeric
          // width difference on the same thin-line pass.
          const rawBaseEdges = selectedPlan.baseEdges.filter((edge) => !edge.aggregate);
          const aggregateBaseEdges = selectedPlan.baseEdges.filter((edge) => edge.aggregate);
          const base = lineObject(THREE, rawBaseEdges, theme === 'dark' ? 0x7790aa : 0x506070, selection ? 0.1 : 0.38, 0);
          if (base) { scene.add(base); edgeObjects.push(base); }
          if (aggregateBaseEdges.length > 0) {
            const weights = aggregateBaseEdges.map((edge) => edge.weight);
            const minWeight = Math.min(...weights), maxWeight = Math.max(...weights);
            const routes = new THREE.InstancedMesh(
              new THREE.CylinderGeometry(1, 1, 1, 5, 1, true),
              new THREE.MeshBasicMaterial({ color: theme === 'dark' ? 0x7790aa : 0x506070, transparent: true, opacity: selection ? 0.12 : 0.32, depthWrite: false }),
              aggregateBaseEdges.length,
            );
            routes.renderOrder = 1;
            const up = new THREE.Vector3(0, 1, 0);
            aggregateBaseEdges.forEach((edge, index) => {
              const from = new THREE.Vector3(...edge.from), to = new THREE.Vector3(...edge.to);
              const mid = from.clone().add(to).multiplyScalar(0.5);
              const length = Math.max(0.01, from.distanceTo(to));
              const direction = to.clone().sub(from).normalize();
              const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);
              const radius = aggregateRouteWidth(edge.weight, minWeight, maxWeight) * 0.5;
              matrix.compose(mid, quaternion, new THREE.Vector3(radius, length, radius));
              routes.setMatrixAt(index, matrix);
            });
            routes.instanceMatrix.needsUpdate = true;
            routes.computeBoundingSphere();
            scene.add(routes);
            edgeObjects.push(routes);
          }
          const promotedAmber = theme === 'dark' ? 0xffd166 : 0x8a5a00;
          // Promoted incident edges split into three passes so historical and off-page
          // relationships carry their OWN dash pattern/opacity instead of sharing the one solid
          // line every other promoted edge gets (PLNR-379: historical stays visible but reads as
          // superseded; off-page is named, never faked). All three still render above the dimmed
          // backbone (renderOrder 10, vs. the backbone's 0).
          // Mutually exclusive and exhaustive over promotedEdges: an edge that happens to be BOTH
          // historical AND off-page (e.g. a superseded relationship whose endpoint isn't resident)
          // gets the off-page treatment, never both dashed passes layered on the same segment —
          // "where does this actually point" outranks "when was this true" for what the line itself
          // has to say; the typed label still appends "· historical" regardless (see
          // promotedEdgeLabelText, though the off-page caption currently wins the label text too).
          const offPagePromotedEdges = selectedPlan.promotedEdges.filter((edge) => isOffPageIncidentEdge(edge));
          const historicalPromotedEdges = selectedPlan.promotedEdges.filter((edge) => edge.historical && !isOffPageIncidentEdge(edge));
          const currentPromotedEdges = selectedPlan.promotedEdges.filter((edge) => !edge.historical && !isOffPageIncidentEdge(edge));
          const current = lineObject(THREE, currentPromotedEdges, promotedAmber, 1, 10);
          if (current) { scene.add(current); edgeObjects.push(current); }
          const historical = dashedLineObject(THREE, historicalPromotedEdges, promotedAmber, 0.75, 2.2, 1.6, 10);
          if (historical) { scene.add(historical); edgeObjects.push(historical); }
          // Off-page routes get a visibly weaker, differently-dashed line (short dash, long gap,
          // 60% opacity — distinct from historical's even dash/gap) so the truncation itself reads
          // on canvas before the DOM caption below even loads.
          const offPage = dashedLineObject(THREE, offPagePromotedEdges, promotedAmber, 0.6, 1.1, 2.8, 10);
          if (offPage) { scene.add(offPage); edgeObjects.push(offPage); }
          // Off-page edges never get a direction cone — a cone implies "this points at the real
          // target"; an off-page route points at a community stand-in instead, and gets its own
          // terminus glyph below rather than borrowing the incident-edge affordance.
          const directed = [...currentPromotedEdges, ...historicalPromotedEdges].filter((edge) => edge.directionMarker);
          if (directed.length > 0) {
            const markers = new THREE.InstancedMesh(new THREE.ConeGeometry(1.6, 4.8, 5), new THREE.MeshBasicMaterial({ color: promotedAmber, transparent: true, depthTest: false }), directed.length);
            markers.renderOrder = 11;
            directed.forEach((edge, index) => {
              const at = midpoint(edge);
              const from = edge.direction === 'reverse' ? edge.to : edge.from;
              const to = edge.direction === 'reverse' ? edge.from : edge.to;
              const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize());
              matrix.compose(new THREE.Vector3(...at), quaternion, new THREE.Vector3(1, 1, 1));
              markers.setMatrixAt(index, matrix);
            });
            markers.instanceMatrix.needsUpdate = true;
            markers.computeBoundingSphere();
            scene.add(markers);
            edgeObjects.push(markers);
          }
          if (offPagePromotedEdges.length > 0) {
            // Truthful terminus (PLNR-379: no synthesized node) — a small dashed-reading ring at
            // the community stand-in's own real position, one instanced draw call regardless of
            // how many off-page edges the selection has.
            const glyphs = new THREE.InstancedMesh(
              new THREE.TorusGeometry(0.85, 0.09, 5, 16),
              new THREE.MeshBasicMaterial({ color: promotedAmber, transparent: true, opacity: 0.6, depthTest: false }),
              offPagePromotedEdges.length,
            );
            glyphs.renderOrder = 11;
            offPagePromotedEdges.forEach((edge, index) => {
              const far = edge.fromId === selection ? edge.to : edge.from;
              matrix.makeTranslation(...far);
              glyphs.setMatrixAt(index, matrix);
            });
            glyphs.instanceMatrix.needsUpdate = true;
            glyphs.computeBoundingSphere();
            scene.add(glyphs);
            edgeObjects.push(glyphs);
          }
          currentLabels = selectedPlan.labels;
          currentPromoted = selectedPlan.promotedEdges;
          currentSelection = selection;
          projectLabels(currentLabels, currentPromoted, currentSelection);
          setSelection(selection ? nodeById.get(selection) ?? null : null);
        };
        const applyCamera = (next: Constellation3DCamera) => {
          camera.position.set(...constellationCameraPosition(next));
          camera.lookAt(...next.target);
          projectLabels(currentLabels, currentPromoted, currentSelection);
          render();
        };

        const resize = () => {
          const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderEdges(selectedNodeId);
        };
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(resize);
          resizeObserver.observe(host);
        } else {
          window.addEventListener('resize', resize);
          removeResizeListener = () => window.removeEventListener('resize', resize);
        }

        rendererRef.current = {
          THREE, renderer, scene, camera, nodeMeshes, decorativeMeshes, edgeObjects, nodeById, renderEdges, applyCamera, setHover, setSelection, render,
          dispose: () => {
            clearEdges();
            for (const mesh of [...nodeMeshes, ...decorativeMeshes]) {
              scene.remove(mesh);
              const renderable = mesh as Three.LineLoop | Three.InstancedMesh;
              renderable.geometry?.dispose();
              const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
              materials.filter(Boolean).forEach((material) => material.dispose());
            }
            renderer.dispose();
          },
        };
        resize();
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'WebGL renderer failed';
        setFailure(reason);
        onRendererFailure?.(reason);
      }
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'Three.js failed to load';
      setFailure(reason);
      onRendererFailure?.(reason);
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      removeResizeListener?.();
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    // Scene reconstruction is reserved for page integration/theme changes, not selection.
  }, [layoutNodes, edges, highlightedNodeIds, theme, onRendererFailure]);

  useEffect(() => { rendererRef.current?.renderEdges(selectedNodeId); }, [selectedNodeId]);
  useEffect(() => { rendererRef.current?.applyCamera(cameraState); }, [cameraState]);
  useEffect(() => {
    const timeout = setTimeout(() => saveConstellation3DPreferences(projectId, {
      version: CONSTELLATION_3D_PREFS_VERSION, layoutVersion, camera: cameraState, expandedCommunityIds: [],
    }), 150);
    return () => clearTimeout(timeout);
  }, [cameraState, projectId, layoutVersion]);

  const cancelTransition = () => {
    transitionRef.current = null;
    cancelAnimationFrame(transitionFrameRef.current);
  };
  useEffect(() => () => cancelTransition(), []);

  const transitionTo = (next: Constellation3DCamera) => {
    cancelTransition();
    const transition = createCameraTransition(cameraState, next, performance.now(), reducedMotion);
    transitionRef.current = transition;
    const step = (now: number) => {
      if (transitionRef.current !== transition) return;
      const sample = sampleCameraTransition(transition, now);
      setCameraState(sample.camera);
      if (sample.done) transitionRef.current = null;
      else transitionFrameRef.current = requestAnimationFrame(step);
    };
    step(performance.now());
  };

  useEffect(() => {
    if (!selectedNodeId) return;
    const selected = layoutNodes.find((node) => node.id === selectedNodeId);
    if (selected) transitionTo(focusConstellationCamera(cameraState, selected.position, selected.radius ?? (selected.community ? 70 : 18)));
    // Selection is the trigger; camera changes during the flight must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId, layoutNodes]);

  const selectAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = rendererRef.current;
    if (!state) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = new state.THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new state.THREE.Raycaster();
    raycaster.setFromCamera(pointer, state.camera);
    for (const hit of raycaster.intersectObjects(state.nodeMeshes, false)) {
      if (hit.instanceId === undefined) continue;
      const nodeId = (hit.object.userData.nodeIds as string[] | undefined)?.[hit.instanceId];
      if (nodeId) { onSelectNode?.(nodeId); return; }
    }
    onSelectNode?.(null);
  };

  // Hover is scoped to community supernodes only — entity-level hover belongs to the deferred
  // Phase 3 selection/promoted-edge treatment. Every path here writes local `hoveredTooltip` state
  // (or the renderer's own hover-ring visibility) and NEVER `selectedNodeId`/`onSelectNode` — that
  // is the entire mechanism behind "hover never overrides a pinned selection" (PLNR-379/PLNR-438).
  const hoverAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = rendererRef.current;
    if (!state) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = new state.THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new state.THREE.Raycaster();
    raycaster.setFromCamera(pointer, state.camera);
    // Only the frontmost real hit decides — mirroring `selectAt`'s own semantics. Scanning past it
    // to find a community further along the ray would let a foreground entity become see-through,
    // surfacing a tooltip for something the cursor isn't actually over.
    const hit = raycaster.intersectObjects(state.nodeMeshes, false).find((candidate) => candidate.instanceId !== undefined);
    const nodeId = hit ? (hit.object.userData.nodeIds as string[] | undefined)?.[hit.instanceId!] : undefined;
    const node = nodeId ? state.nodeById.get(nodeId) : undefined;
    const content = node ? communityTooltipContent(node) : null;
    if (node && content) {
      const point = new state.THREE.Vector3(...node.position).project(state.camera);
      const width = rect.width || 1, height = rect.height || 1;
      state.setHover(node);
      setHoveredTooltip({ nodeId: node.id, content, x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 });
      return;
    }
    state.setHover(null);
    setHoveredTooltip(null);
  };
  const clearHover = () => { rendererRef.current?.setHover(null); setHoveredTooltip(null); };

  const dolly = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    cancelTransition();
    setCameraState((camera) => dollyConstellationCamera(camera, event.deltaY < 0 ? 0.88 : 1.14));
  };

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    cancelTransition();
    dragRef.current = { mode: event.shiftKey || event.button === 1 || event.button === 2 ? 'pan' : 'orbit', x: event.clientX, y: event.clientY, camera: cameraState };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) { hoverAt(event); return; }
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    setCameraState(drag.mode === 'orbit' ? orbitConstellationCamera(drag.camera, dx, dy) : panConstellationCamera(drag.camera, dx, dy));
  };
  const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 3) return;
    selectAt(event);
  };

  const keyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const directions: Record<string, [number, number, number]> = { ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0], ArrowUp: [0, 1, 0], ArrowDown: [0, -1, 0] };
    const direction = directions[event.key];
    if (direction && selectedNodeId) {
      event.preventDefault();
      const next = nearestDirectionalConstellationNode(spatialIndex, selectedNodeId, direction);
      if (next) onSelectNode?.(next);
      return;
    }
    const selected = selectedNodeId ? layoutNodes.find((node) => node.id === selectedNodeId) : null;
    if (selected?.uri && event.key.toLowerCase() === 'e') onOpenEgoNetwork?.(selected.uri);
    if (selected?.uri && event.key.toLowerCase() === 'i') onOpenInspector?.(selected.uri);
    if (event.key === 'Escape') { cancelTransition(); onSelectNode?.(null); }
  };

  return (
    <div ref={hostRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} data-reduced-motion={reducedMotion ? 'true' : 'false'}>
      <canvas ref={canvasRef} tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerLeave={clearHover} onWheel={dolly} onKeyDown={keyDown} onContextMenu={(event) => event.preventDefault()} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} aria-label={`3D memory constellation with ${layoutNodes.length} visible items. Arrow keys move selection; E opens ego network; I opens evidence inspector.`} />
      <div style={{ position: 'absolute', right: 10, top: 10, display: 'flex', gap: 6 }}>
        <button type="button" onClick={() => transitionTo(DEFAULT_CONSTELLATION_3D_CAMERA)}>home</button>
        <button type="button" disabled={!selectedNodeId} onClick={() => {
          const selected = layoutNodes.find((node) => node.id === selectedNodeId);
          if (selected) transitionTo(focusConstellationCamera(cameraState, selected.position, selected.radius ?? 18));
        }}>focus</button>
      </div>
      {labels.map((label) => (
        <div key={label.key} style={{ position: 'absolute', left: label.x, top: label.y, transform: 'translate(-50%, -50%)', pointerEvents: 'none', textAlign: 'center', textShadow: '0 1px 4px var(--bg)' }}>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: label.promoted ? 11 : label.pinned ? 11.5 : 10.5,
              fontWeight: label.promoted || label.pinned ? 700 : 500,
              // `--amber-select` (#ffd166) is the SELECTION amber, deliberately distinct from
              // `--amber` (#f5a623, status/degraded-data amber) — see theme.css and the Navigator
              // conventions doc §2. A promoted edge label is a selection response, never a status.
              // The pin's own title stays `--text` (screen spec 1b) — the reticle already carries
              // the amber "this is picked" signal, so the title itself does not need to repeat it.
              color: label.promoted ? 'var(--amber-select)' : label.pinned ? 'var(--text)' : 'var(--text-soft)',
            }}
          >
            {label.text}
          </div>
          {label.subtext && <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-dim)' }}>{label.subtext}</div>}
        </div>
      ))}
      {hoveredTooltip && <ConstellationHoverTooltip tooltip={hoveredTooltip} hostRef={hostRef} />}
      {failure && <div role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-dim)', fontSize: 12 }}>3D view unavailable: {failure}</div>}
    </div>
  );
}

const TOOLTIP_WIDTH = 230;

/** The overview hover tooltip (PLNR-438) — DOM over canvas, positioned from the already-projected
 * screen coordinates `hoverAt` computed (the same technique labels already use), clamped so it
 * never runs off the viewport edge (this task's placement-strategy discretion). Content comes
 * entirely from `communityTooltipContent`, a pure function unit-tested in
 * constellation-3d-buffers.test.ts without WebGL. */
function ConstellationHoverTooltip({ tooltip, hostRef }: { tooltip: HoverTooltip; hostRef: React.RefObject<HTMLDivElement> }) {
  const hostWidth = hostRef.current?.clientWidth ?? TOOLTIP_WIDTH + 40;
  const hostHeight = hostRef.current?.clientHeight ?? 300;
  const left = Math.min(Math.max(tooltip.x + 16, 8), Math.max(8, hostWidth - TOOLTIP_WIDTH - 8));
  const top = Math.min(Math.max(tooltip.y - 24, 8), Math.max(8, hostHeight - 140));
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute', left, top, width: TOOLTIP_WIDTH, padding: 10, pointerEvents: 'none', zIndex: 2,
        background: 'rgba(16,18,22,.94)', border: '1px solid var(--w-1)', borderRadius: 9, backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{tooltip.content.name}</div>
      <div style={{ marginTop: 3, fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>
        {tooltip.content.entityCount.toLocaleString()} entities · {tooltip.content.boundaryRouteCount.toLocaleString()} boundary routes
      </div>
      {tooltip.content.topTypeCounts.length > 0 && (
        <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>
          {tooltip.content.topTypeCounts.map(({ type, count }) => {
            const encoding = encodingForType(type);
            return (
              <span key={type} style={{ fontFamily: 'var(--mono)', fontSize: 9, padding: '1px 6px', borderRadius: 4, background: 'var(--w-06)', color: `var(${encoding.token})` }}>
                {encoding.label.toLowerCase()} {count}
              </span>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--w-07)', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>
        {tooltip.content.affordance}
      </div>
    </div>
  );
}

export default MemoryConstellation3D;
