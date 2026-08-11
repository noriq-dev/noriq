import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Three from 'three';
import {
  buildConstellation3DRenderPlan, communityEntitySubtext, communityIgniteSubtext, communityTooltipContent,
  constellation3DColorType, constellation3DCommunityWellScale, constellation3DIsDimmed, constellation3DIsRootScene,
  constellation3DNodeEncoding, constellation3DStarPositions, CONSTELLATION_IGNITE_DIM_OPACITY,
  isOffPageIncidentEdge, placeConstellation3DLabels, promotedEdgeLabelText, truncateConstellationLabel, type Constellation3DEdge,
  type Constellation3DEdgeSegment, type ConstellationCommunityTooltip, type Constellation3DNode,
  type Constellation3DNodeInstance, type Constellation3DShape, type Constellation3DLabelPriority,
} from './constellation-3d-buffers';
import { encodingForType, resolveConstellationToken } from './constellation-encoding';
import {
  buildConstellation3DSpatialIndex, computeConstellation3DLayoutOffThread, nearestDirectionalConstellationNode,
} from './constellation-3d-layout';
import {
  CONSTELLATION_3D_PREFS_VERSION, constellationCameraPosition, createCameraTransition, dollyConstellationCamera,
  fitConstellationCamera, fitConstellationClusterCamera, focusConstellationCamera, loadConstellation3DPreferences, orbitConstellationCamera,
  panConstellationCamera, sampleCameraTransition, saveConstellation3DPreferences, type CameraTransition,
  type Constellation3DCamera,
} from './constellation-3d-navigation';

const LABEL_BUDGET = 24;
const COMMUNITY_LABEL_WIDTH_PX = 180;
const ENTITY_LABEL_WIDTH_PX = 260;
const PROMOTED_LABEL_WIDTH_PX = 220;
const COMMUNITY_LABEL_MAX_CHARACTERS = 28;
const ENTITY_LABEL_MAX_CHARACTERS = 42;
const PROMOTED_LABEL_MAX_CHARACTERS = 34;
// Camera controls (PLNR-447, screen spec "Camera controls") — the 30×30 chip is a fixed-dark panel
// in BOTH themes, same reasoning as ConstellationInspector.tsx / MemoryConstellationV2.tsx's
// PLNR-443 audit fix (see 2c80d5d): `var(--text*)`/`var(--w-12)` flip to near-black-on-light-text
// values in light theme, which against this panel's own always-dark `rgba(16,18,22,.9)` fill would
// render illegibly. These are the dark theme's own `--text`/`--text-faint`/`--w-12` values, inlined
// as constants so the chip reads correctly regardless of the app's theme toggle.
const CAMERA_CTRL_BG = 'rgba(16,18,22,.9)';
const CAMERA_CTRL_BORDER = 'rgba(255,255,255,.12)';
const CAMERA_CTRL_TEXT = '#e6e8ec';
const CAMERA_CTRL_TEXT_FAINT = '#4b5563';
const CAMERA_CTRL_STYLE: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 7, background: CAMERA_CTRL_BG, border: `1px solid ${CAMERA_CTRL_BORDER}`,
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, lineHeight: 1,
};
// Population-sized layered falloff (PLNR-457/461): the core keeps connectivity honest while these
// broad, low-alpha shells supply community presence. Dark mode can add light; light mode must only
// tint, hence the per-theme blending choice at material construction below.
const COMMUNITY_WELL_MID_RATIO = 1.75;
const COMMUNITY_WELL_OUTER_RATIO = 3;
const FIT_ENTITY_FOOTPRINT_RATIO = 1.9;
const CONSTELLATION_STAR_COUNT = 360;
export const CONSTELLATION_DOUBLE_CLICK_MS = 350;
export const CONSTELLATION_DRAG_THRESHOLD_PX = 3;

export interface Constellation3DClickState { nodeId: string; at: number }

/** Drag classification is hysteretic: once the pointer crosses the threshold, returning near the
 * origin cannot turn that camera gesture back into a click on pointer-up. */
export function constellation3DHasDragged(alreadyDragged: boolean, distance: number): boolean {
  return alreadyDragged || distance > CONSTELLATION_DRAG_THRESHOLD_PX;
}

export function constellation3DKeyboardZoomIntent(key: string, selectedNodeId: string | null): boolean {
  return key === 'Enter' && selectedNodeId !== null;
}

/** Resolves click sequencing independently of raycasting: a drag or background hit breaks the
 * sequence, and only a second click on the same node inside Montana's window requests zoom. */
export function constellation3DClickIntent(
  previous: Constellation3DClickState | null,
  nodeId: string | null,
  at: number,
  dragDistance: number,
): { next: Constellation3DClickState | null; zoom: boolean } {
  if (dragDistance > CONSTELLATION_DRAG_THRESHOLD_PX || nodeId === null) return { next: null, zoom: false };
  const elapsed = previous ? at - previous.at : Infinity;
  const zoom = previous?.nodeId === nodeId && elapsed >= 0 && elapsed <= CONSTELLATION_DOUBLE_CLICK_MS;
  return { next: zoom ? null : { nodeId, at }, zoom };
}

/** Direct member nodes are the visible body of a community in continuous space. The anchor itself
 * is deliberately excluded: fitting it again would make a large well dominate its own fly-in. */
export function constellation3DCommunityCluster(
  nodes: readonly Constellation3DNode[],
  communityId: string,
): Constellation3DNode[] {
  return nodes.filter((node) => node.id !== communityId && node.parentId === communityId && !node.offPageStandIn);
}

export function constellation3DCommunityClusterCamera(
  nodes: readonly Constellation3DNode[],
  communityId: string,
  aspect: number,
  camera: Constellation3DCamera,
): Constellation3DCamera | null {
  const members = constellation3DCommunityCluster(nodes, communityId);
  if (members.length === 0) return null;
  return fitConstellationClusterCamera(members.map((member) => {
    const encoded = constellation3DNodeEncoding(member);
    return {
      position: member.position,
      radius: member.community
        ? constellation3DCommunityWellScale(encoded) * COMMUNITY_WELL_OUTER_RATIO
        : encoded.scale * FIT_ENTITY_FOOTPRINT_RATIO,
    };
  }), { aspect, camera });
}
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
  /** Entity AND community node ids an active search has matched — the SAME field drives entity
   *  ignite (unchanged from the pre-PLNR-441 highlight mechanism) and community-flare eligibility;
   *  see constellation-3d-buffers.ts's ignite-budget comment for why one field, not two. */
  highlightedNodeIds?: string[];
  /** True whenever the search box carries a non-empty query (MemoryConstellationV2.tsx's
   *  `searchActive`) — distinct from `highlightedNodeIds.length > 0`: a zero-hit or not-yet-routed
   *  search must still dim the field (screen spec 1c honesty rule), so dimming cannot wait on a
   *  match being known. */
  searchActive?: boolean;
  /** Community node id -> ignited match count (root-level communities only, computed in
   *  MemoryConstellationV2.tsx from the search hits' resolved routes). Subtext-only: it never
   *  changes which draw-call bucket a community lands in (see constellation-3d-buffers.ts). */
  igniteMatchCounts?: ReadonlyMap<string, number>;
  theme?: 'dark' | 'light';
  reducedMotion?: boolean;
  residentCommunityIds?: string[];
  focusRequest?: { nodeId: string; serial: number } | null;
  onSelectNode?: (nodeId: string | null) => void;
  onEnsureCommunityResident?: (communityId: string) => Promise<boolean>;
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
  width: number;
  height: number;
  priority: Constellation3DLabelPriority;
  community?: boolean;
  memberCount?: number;
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
  // Non-interactive: gravity wells, starfield, root orbit guides, and hover/selection chrome.
  // Disposed alongside nodeMeshes but never raycast against — a giant translucent well must not
  // steal clicks from whatever it visually surrounds.
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

function ambienceFrame(nodes: readonly Constellation3DNodeInstance[]): {
  center: [number, number, number];
  radius: number;
} {
  if (nodes.length === 0) return { center: [0, 0, 0], radius: 900 };
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const node of nodes) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, node.position[axis]!);
      maximum[axis] = Math.max(maximum[axis]!, node.position[axis]!);
    }
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]!) / 2) as [number, number, number];
  const radius = nodes.reduce((largest, node) => Math.max(largest, Math.hypot(
    node.position[0] - center[0], node.position[1] - center[1], node.position[2] - center[2],
  )), 0);
  return { center, radius: Math.max(500, radius) };
}

function orbitGuideGeometry(THREE: typeof Three, radius: number, flattening: number): Three.BufferGeometry {
  const segments = 128;
  const positions = new Float32Array(segments * 3);
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.set([Math.cos(angle) * radius, 0, Math.sin(angle) * radius * flattening], index * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** Rendered world-space footprints used by the pure navigation fit. Off-page stand-ins contribute
 * their truthful terminus position but not a fake community well; ordinary nodes reserve enough
 * room for their largest reusable selection chrome. */
function fitCameraToScene(nodes: readonly Constellation3DNode[], aspect = 1): Constellation3DCamera {
  return fitConstellationCamera(nodes.map((node) => {
    const encoded = constellation3DNodeEncoding(node);
    const radius = node.offPageStandIn
      ? 1
      : node.community
        ? constellation3DCommunityWellScale(encoded) * COMMUNITY_WELL_OUTER_RATIO
        : encoded.scale * FIT_ENTITY_FOOTPRINT_RATIO;
    return { position: node.position, radius };
  }), { aspect });
}

/** Lazy Three/WebGL renderer. The scene contains bounded instanced meshes and buffer geometries;
 * React only owns the canvas, failure state, and a fixed label budget. The v2 controller hands
 * renderer failures to its full textual peer. */
export function MemoryConstellation3D({
  projectId, generationId, layoutVersion, nodes, edges, selectedNodeId, highlightedNodeIds = [],
  searchActive = false, igniteMatchCounts, theme = 'dark', reducedMotion = false,
  residentCommunityIds = [], focusRequest, onSelectNode, onEnsureCommunityResident,
  onOpenEgoNetwork, onOpenInspector, onRendererFailure,
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
  const generationLayoutKey = `${generationId}:${layoutVersion}`;
  const initialFitKeyRef = useRef<string | null>(null);
  const [cameraState, setCameraState] = useState<Constellation3DCamera>(() => {
    const fitted = fitCameraToScene(nodes);
    const preferences = loadConstellation3DPreferences(projectId, layoutVersion, localStorage, fitted, generationId);
    initialFitKeyRef.current = preferences.cameraSource === 'fallback' ? generationLayoutKey : null;
    return preferences.camera;
  });
  const transitionRef = useRef<CameraTransition | null>(null);
  const transitionFrameRef = useRef(0);
  const dragRef = useRef<{
    mode: 'orbit' | 'pan'; x: number; y: number; camera: Constellation3DCamera; dragged: boolean;
  } | null>(null);
  const lastClickRef = useRef<Constellation3DClickState | null>(null);
  const pendingCommunityZoomRef = useRef<string | null>(null);
  const handledFocusRequestRef = useRef(0);
  const residentCommunityIdSet = useMemo(() => new Set(residentCommunityIds), [residentCommunityIds]);

  useEffect(() => {
    const controller = new AbortController();
    computeConstellation3DLayoutOffThread({ generationId, layoutVersion, nodes, edges, prior: priorLayoutRef.current }, controller.signal)
      .then((result) => {
        priorLayoutRef.current = result;
        const nextNodes = nodes.map((node) => ({ ...node, position: result.positions[node.id] ?? node.position }));
        setLayoutNodes(nextNodes);
        if (initialFitKeyRef.current === generationLayoutKey) {
          initialFitKeyRef.current = null;
          const host = hostRef.current;
          const aspect = host ? Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight) : 1;
          setCameraState(fitCameraToScene(nextNodes, aspect));
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLayoutNodes(nodes);
        if (initialFitKeyRef.current === generationLayoutKey) {
          initialFitKeyRef.current = null;
          const host = hostRef.current;
          const aspect = host ? Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight) : 1;
          setCameraState(fitCameraToScene(nodes, aspect));
        }
      });
    return () => controller.abort();
  }, [generationId, generationLayoutKey, layoutVersion, nodes, edges]);

  useEffect(() => {
    const host = hostRef.current;
    const aspect = host ? Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight) : 1;
    const fitted = fitCameraToScene(nodes, aspect);
    const preferences = loadConstellation3DPreferences(projectId, layoutVersion, localStorage, fitted, generationId);
    initialFitKeyRef.current = preferences.cameraSource === 'fallback' ? generationLayoutKey : null;
    setCameraState(preferences.camera);
  // A resident-page expansion within one generation deliberately does not force camera motion;
  // Home computes a fresh fit for the current resident scene when the user asks for one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, generationId, generationLayoutKey, layoutVersion]);

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

        // Galaxy ambience (PLNR-461): one deterministic Points draw everywhere, plus exactly three
        // root-only LineLoops. All four are scene geometry (never DOM/sprites), never enter the
        // node raycast list, and resolve their neutral tint from the live theme token cascade.
        const residentNodes = [...nodeById.values()].filter((node) => !node.offPageStandIn);
        const ambience = ambienceFrame(residentNodes);
        const ambienceTint = new THREE.Color(resolveConstellationToken('--text-faint'));
        const starGeometry = new THREE.BufferGeometry();
        starGeometry.setAttribute('position', new THREE.BufferAttribute(
          constellation3DStarPositions(`${generationId}:${layoutVersion}`, CONSTELLATION_STAR_COUNT), 3,
        ));
        starGeometry.computeBoundingSphere();
        const stars = new THREE.Points(
          starGeometry,
          new THREE.PointsMaterial({
            color: ambienceTint,
            transparent: true,
            opacity: theme === 'dark' ? 0.3 : 0.1,
            size: theme === 'dark' ? 1.7 : 1.25,
            sizeAttenuation: false,
            depthWrite: false,
          }),
        );
        stars.position.set(...ambience.center);
        stars.scale.setScalar(ambience.radius * 2.6);
        stars.renderOrder = -6;
        stars.raycast = () => undefined;
        scene.add(stars);
        decorativeMeshes.push(stars);

        if (constellation3DIsRootScene(layoutNodes)) {
          const guideRatios = [0.46, 0.72, 1.02] as const;
          guideRatios.forEach((ratio, index) => {
            const guide = new THREE.LineLoop(
              orbitGuideGeometry(THREE, ambience.radius * ratio, 0.72 + index * 0.08),
              new THREE.LineDashedMaterial({
                color: ambienceTint,
                transparent: true,
                opacity: theme === 'dark' ? 0.1 : 0.055,
                dashSize: 22 + index * 4,
                gapSize: 18 + index * 5,
                depthWrite: false,
              }),
            );
            guide.computeLineDistances();
            guide.position.set(...ambience.center);
            guide.renderOrder = -5;
            guide.raycast = () => undefined;
            scene.add(guide);
            decorativeMeshes.push(guide);
          });
        }

        for (const [shape, instances] of plan.nodeGroups) {
          for (const faded of [false, true]) {
            // Same two buckets as before PLNR-441 — search only changes which predicate decides
            // membership (constellation3DIsDimmed), never the bucket count, so this costs zero new
            // draw calls: the ignite budget note in constellation-3d-buffers.ts is what this reuses.
            const group = instances.filter((node) => constellation3DIsDimmed(node, searchActive) === faded);
            if (group.length === 0) continue;
            const geometry = geometryFor(THREE, shape);
            // Geometry vertex colors have no attribute here and would multiply instance tints into black.
            const material = new THREE.MeshBasicMaterial({ transparent: faded, opacity: faded ? (searchActive ? CONSTELLATION_IGNITE_DIM_OPACITY : 0.42) : 1 });
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

        // Community gravity wells (PLNR-457/461): two population-sized low-opacity layers per
        // community. The standard core pass remains the third, innermost layer and retains its
        // unmodified connectivity encoding, so this still adds exactly two calls total (not two
        // per community). Dark mode adds the tint as light; normal blending avoids bleaching the
        // light canvas. depthWrite stays off so the falloff never occludes its own surroundings.
        // PLNR-448: excludes off-page stand-ins — a stand-in gets its own dedicated terminus glyph
        // (the offPagePromotedEdges pass below), never the full gravity-well/core-sphere treatment
        // the PLNR-379 honesty rule reserves for a genuinely resident community.
        const communityNodes = [...nodeById.values()].filter((node) => node.community && !node.offPageStandIn);
        if (communityNodes.length > 0) {
          // Geometry vertex colors have no attribute here and would multiply instance tints into black.
          const outer = new THREE.InstancedMesh(
            new THREE.SphereGeometry(1, 12, 8),
            new THREE.MeshBasicMaterial({
              transparent: true,
              opacity: theme === 'dark' ? 0.055 : 0.022,
              depthWrite: false,
              blending: theme === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending,
            }),
            communityNodes.length,
          );
          const mid = new THREE.InstancedMesh(
            new THREE.SphereGeometry(1, 12, 8),
            new THREE.MeshBasicMaterial({
              transparent: true,
              opacity: theme === 'dark' ? 0.14 : 0.065,
              depthWrite: false,
              blending: theme === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending,
            }),
            communityNodes.length,
          );
          outer.renderOrder = -2;
          mid.renderOrder = -1;
          communityNodes.forEach((node, index) => {
            const color = colorForType(constellation3DColorType(node));
            // Ignite flare rides the SAME highlighted-scale boost the core sphere pass below already
            // applies (PLNR-441) rather than a second, well-specific opacity bucket — a matched
            // community's well grows with its core for zero extra draw calls (see the ignite-budget
            // comment in constellation-3d-buffers.ts: ambience raises the measured ceiling, but
            // ignite itself still has no call available for a new well-specific pass).
            const boost = node.highlighted ? 1.3 : 1;
            const wellScale = constellation3DCommunityWellScale(node);
            const outerScale = wellScale * boost * COMMUNITY_WELL_OUTER_RATIO;
            matrix.makeScale(outerScale, outerScale, outerScale);
            matrix.setPosition(...node.position);
            outer.setMatrixAt(index, matrix);
            outer.setColorAt(index, color);
            const midScale = wellScale * boost * COMMUNITY_WELL_MID_RATIO;
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
          const candidates: LabelPosition[] = [];
          for (const node of labelNodes) {
            const point = new THREE.Vector3(...node.position).project(camera);
            if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) continue;
            // Two-line label for a community: name + entity count (PLNR-438) — one budget entry,
            // same as before, just carrying a second rendered line. While a search is active and
            // this community has at least one ignited match, the second line reports the match
            // count instead (screen spec 1c "+N matches") — entities are not resident at this
            // level, so the count is the only truthful thing to say about what matched here.
            const igniteCount = searchActive ? igniteMatchCounts?.get(node.id) : undefined;
            const subtext = node.community
              ? (igniteCount ? communityIgniteSubtext(igniteCount) : communityEntitySubtext(node.memberCount ?? 0))
              : undefined;
            const pinned = node.id === selection;
            const y = (1 - point.y) * height / 2;
            candidates.push({
              key: `node:${node.id}`,
              text: truncateConstellationLabel(node.label, node.community ? COMMUNITY_LABEL_MAX_CHARACTERS : ENTITY_LABEL_MAX_CHARACTERS),
              subtext, x: (point.x + 1) * width / 2, y: pinned ? y - PINNED_TITLE_OFFSET_PX : y,
              width: node.community ? COMMUNITY_LABEL_WIDTH_PX : ENTITY_LABEL_WIDTH_PX,
              height: node.community ? 30 : 18, priority: pinned ? 'selected' : 'ambient',
              community: node.community, memberCount: node.memberCount, promoted: false, pinned,
            });
          }
          for (const edge of promoted.slice(0, LABEL_BUDGET)) {
            const point = new THREE.Vector3(...midpoint(edge)).project(camera);
            if (point.z < -1 || point.z > 1) continue;
            const otherId = edge.fromId === selection ? edge.toId : edge.fromId;
            const targetLabel = nodeById.get(otherId)?.label ?? '';
            candidates.push({
              key: `edge:${edge.id}`,
              text: truncateConstellationLabel(promotedEdgeLabelText(edge, targetLabel), PROMOTED_LABEL_MAX_CHARACTERS),
              x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2,
              width: PROMOTED_LABEL_WIDTH_PX, height: 18, priority: 'promoted', promoted: true,
            });
          }
          // Projection only runs for scene/selection/resize changes and active camera movement;
          // this DOM collision pass therefore does no canvas work and never spins while idle.
          setLabels(placeConstellation3DLabels(candidates, LABEL_BUDGET));
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
          const ringScale = (node.community ? constellation3DCommunityWellScale(node) : node.scale)
            * COMMUNITY_WELL_OUTER_RATIO * 1.08;
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
          // Field dim during search (screen spec 1c: "drops to ~32% opacity as a whole — stars,
          // routes, and unmatched communities together") reuses the SAME base/aggregate line
          // objects, just at a lower opacity — no edge is individually classified as
          // matched/unmatched (only nodes are search results), so this is a uniform dim of the
          // whole unselected route field rather than a second bucketed pass. A pinned selection
          // still wins (0.1/0.12): the promoted incident edges are the thing to look at then.
          const base = lineObject(THREE, rawBaseEdges, theme === 'dark' ? 0x7790aa : 0x506070, selection ? 0.1 : searchActive ? CONSTELLATION_IGNITE_DIM_OPACITY : 0.38, 0);
          if (base) { scene.add(base); edgeObjects.push(base); }
          if (aggregateBaseEdges.length > 0) {
            const routes = new THREE.InstancedMesh(
              new THREE.CylinderGeometry(1, 1, 1, 5, 1, true),
              new THREE.MeshBasicMaterial({
                color: theme === 'dark' ? 0x7790aa : 0x506070,
                transparent: true,
                opacity: selection ? 0.12 : searchActive ? CONSTELLATION_IGNITE_DIM_OPACITY : theme === 'dark' ? 0.58 : 0.48,
                depthWrite: false,
              }),
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
              // The plan normalized this against every aggregate edge before selection split, so
              // using its width keeps surviving root routes from rescaling when one is promoted.
              const radius = edge.width;
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
          // PLNR-455 artifact audit: when a selection has an off-page edge, this pass draws a long
          // low-opacity dotted span from the entity's ±80-local position to a substituted ±1000
          // community anchor — under the old fixed camera, mostly off-frame, leaving an orphaned
          // middle segment. That is intentional truthful selection chrome (and Home now fits the
          // stand-in terminus into frame). Whether it is ALSO the vertical dotted artifact in the
          // live-project screenshot is NOT settled: every dashed canvas path (this one, historical
          // above, hover ring, reticle) is selection-dependent, no DOM dotted border spans the
          // canvas, and that screenshot shows no docked inspector — i.e. no live selection. The
          // artifact still needs one live reproduction (devtools: DOM or canvas?) to be named.
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
    // searchActive/igniteMatchCounts join highlightedNodeIds here for the same reason that field
    // already triggers a rebuild: ignite changes which material bucket nodes/wells/routes land in
    // and what a community's label subtext says, all baked in at scene-build time, not per-frame.
  }, [layoutNodes, edges, highlightedNodeIds, searchActive, igniteMatchCounts, theme, generationId, layoutVersion, onRendererFailure]);

  useEffect(() => { rendererRef.current?.renderEdges(selectedNodeId); }, [selectedNodeId]);
  useEffect(() => { rendererRef.current?.applyCamera(cameraState); }, [cameraState]);
  useEffect(() => {
    const timeout = setTimeout(() => saveConstellation3DPreferences(projectId, {
      version: CONSTELLATION_3D_PREFS_VERSION, layoutVersion, generationId, camera: cameraState, expandedCommunityIds: [],
    }), 150);
    return () => clearTimeout(timeout);
  }, [cameraState, projectId, generationId, layoutVersion]);

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

  const zoomToNode = (node: Constellation3DNode) => {
    if (!node.community) {
      transitionTo(focusConstellationCamera(cameraState, node.position, node.radius ?? 18));
      return;
    }
    const host = hostRef.current;
    const aspect = host ? Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight) : 1;
    const clusterCamera = constellation3DCommunityClusterCamera(layoutNodes, node.id, aspect, cameraState);
    if (clusterCamera) {
      transitionTo(clusterCamera);
      return;
    }
    if (residentCommunityIdSet.has(node.id)) {
      // Empty or type-filtered resident systems still have a truthful anchor to focus.
      transitionTo(focusConstellationCamera(cameraState, node.position, node.radius ?? 70));
      return;
    }
    pendingCommunityZoomRef.current = node.id;
    void onEnsureCommunityResident?.(node.id).then((loaded) => {
      if (!loaded && pendingCommunityZoomRef.current === node.id) pendingCommunityZoomRef.current = null;
    });
  };

  // A non-resident double-click cannot fit until React has integrated the fetched page and the
  // worker has laid out its members. Wait for both facts; never fly to a fake placeholder cluster.
  useEffect(() => {
    const communityId = pendingCommunityZoomRef.current;
    if (!communityId || !residentCommunityIdSet.has(communityId)) return;
    const sourceHasMembers = constellation3DCommunityCluster(nodes, communityId).length > 0;
    const layoutHasMembers = constellation3DCommunityCluster(layoutNodes, communityId).length > 0;
    if (sourceHasMembers && !layoutHasMembers) return;
    const community = layoutNodes.find((node) => node.id === communityId);
    if (!community) return;
    pendingCommunityZoomRef.current = null;
    zoomToNode(community);
  // `zoomToNode` intentionally uses the camera from the render that observes the completed layout.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutNodes, nodes, residentCommunityIdSet]);

  // Search and textual Catalogue focus use the same in-place camera seam as pointer/Enter zoom.
  useEffect(() => {
    if (!focusRequest || handledFocusRequestRef.current === focusRequest.serial) return;
    const node = layoutNodes.find((candidate) => candidate.id === focusRequest.nodeId);
    if (!node) return;
    handledFocusRequestRef.current = focusRequest.serial;
    zoomToNode(node);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, layoutNodes]);

  const nodeAt = (event: React.PointerEvent<HTMLCanvasElement>): string | null | undefined => {
    const state = rendererRef.current;
    if (!state) return undefined;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = new state.THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new state.THREE.Raycaster();
    raycaster.setFromCamera(pointer, state.camera);
    for (const hit of raycaster.intersectObjects(state.nodeMeshes, false)) {
      if (hit.instanceId === undefined) continue;
      const nodeId = (hit.object.userData.nodeIds as string[] | undefined)?.[hit.instanceId];
      if (nodeId) return nodeId;
    }
    return null;
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
    dragRef.current = {
      mode: event.shiftKey || event.button === 1 || event.button === 2 ? 'pan' : 'orbit',
      x: event.clientX, y: event.clientY, camera: cameraState, dragged: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) { hoverAt(event); return; }
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!constellation3DHasDragged(drag.dragged, Math.hypot(dx, dy))) return;
    drag.dragged = true;
    setCameraState(drag.mode === 'orbit' ? orbitConstellationCamera(drag.camera, dx, dy) : panConstellationCamera(drag.camera, dx, dy));
  };
  const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const dragDistance = drag ? Math.hypot(event.clientX - drag.x, event.clientY - drag.y) : 0;
    if (constellation3DHasDragged(drag?.dragged ?? false, dragDistance)) {
      lastClickRef.current = null;
      return;
    }
    const nodeId = nodeAt(event);
    if (nodeId === undefined) return;
    const intent = constellation3DClickIntent(lastClickRef.current, nodeId, event.timeStamp, dragDistance);
    lastClickRef.current = intent.next;
    onSelectNode?.(nodeId);
    if (intent.zoom && nodeId) {
      const node = layoutNodes.find((candidate) => candidate.id === nodeId);
      if (node) zoomToNode(node);
    }
  };

  const keyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    lastClickRef.current = null;
    const directions: Record<string, [number, number, number]> = { ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0], ArrowUp: [0, 1, 0], ArrowDown: [0, -1, 0] };
    const direction = directions[event.key];
    if (direction && selectedNodeId) {
      event.preventDefault();
      const next = nearestDirectionalConstellationNode(spatialIndex, selectedNodeId, direction);
      if (next) onSelectNode?.(next);
      return;
    }
    const selected = selectedNodeId ? layoutNodes.find((node) => node.id === selectedNodeId) : null;
    if (selected && constellation3DKeyboardZoomIntent(event.key, selectedNodeId)) {
      event.preventDefault(); zoomToNode(selected); return;
    }
    if (selected?.uri && event.key.toLowerCase() === 'e') onOpenEgoNetwork?.(selected.uri);
    if (selected?.uri && event.key.toLowerCase() === 'i') onOpenInspector?.(selected.uri);
    if (event.key === 'Escape') onSelectNode?.(null);
  };

  return (
    <div ref={hostRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} data-reduced-motion={reducedMotion ? 'true' : 'false'}>
      <canvas ref={canvasRef} tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerLeave={clearHover} onWheel={dolly} onKeyDown={keyDown} onContextMenu={(event) => event.preventDefault()} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} aria-label={`3D memory constellation with ${layoutNodes.length} visible items. Single-click pins; double-click or Enter zooms; arrow keys move selection; E opens ego network; I opens evidence inspector.`} />
      <div style={{ position: 'absolute', right: 10, bottom: 10, display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="camera-ctrl-btn"
          aria-label="Fit camera to whole scene"
          onClick={() => {
            const host = hostRef.current;
            const aspect = host ? Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight) : 1;
            transitionTo(fitCameraToScene(layoutNodes, aspect));
          }}
          style={{ ...CAMERA_CTRL_STYLE, color: CAMERA_CTRL_TEXT, cursor: 'pointer' }}
        >
          ◎
        </button>
        {/* Kept keyboard-reachable even with nothing selected (Navigator conventions doc §8) — a
            native `disabled` button drops out of the tab order, so the no-selection state is
            conveyed via `aria-disabled` + a guarded click/keyboard handler instead. The dimming is
            applied to the GLYPH only (not a button-level `opacity`, which would fade the chip's own
            background too and break the "fixed-dark panel in both themes" rule this task is about —
            confirmed against a light-theme screenshot during verification); `aria-disabled` plus the
            default cursor add non-colour signal on top of the faint-text colour itself. */}
        <button
          type="button"
          className="camera-ctrl-btn"
          aria-label="Focus camera on selection"
          aria-disabled={!selectedNodeId}
          onClick={() => {
            if (!selectedNodeId) return;
            const selected = layoutNodes.find((node) => node.id === selectedNodeId);
            if (selected) zoomToNode(selected);
          }}
          style={{ ...CAMERA_CTRL_STYLE, cursor: selectedNodeId ? 'pointer' : 'default' }}
        >
          <span style={{ color: selectedNodeId ? CAMERA_CTRL_TEXT : CAMERA_CTRL_TEXT_FAINT, opacity: selectedNodeId ? 1 : 0.75 }}>⌖</span>
        </button>
      </div>
      {labels.map((label) => (
        <div key={label.key} style={{ position: 'absolute', left: label.x, top: label.y, width: label.width, transform: 'translate(-50%, -50%)', pointerEvents: 'none', textAlign: 'center', textShadow: '0 1px 4px var(--bg)' }}>
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
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
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
// PLNR-451: this tooltip's own background (`rgba(16,18,22,.94)` below) is fixed dark in BOTH
// themes, same "HUD panel over the canvas" as the camera controls (CAMERA_CTRL_* above) and the
// docked inspector / search matches panel (2c80d5d, PLNR-443). Its border and text were still
// following var(--w-1)/var(--text*) — which flip to near-black in light theme (theme.css's light
// block) — rendering dark-on-dark against this panel's own always-dark fill. Reusing CAMERA_CTRL_TEXT
// (--text) and CAMERA_CTRL_TEXT_FAINT (--text-faint) for the two colours they already cover, and
// pinning the remaining --text-dim/--w-1/--w-06/--w-07 uses to the dark theme's own literal values
// as local constants — the same fix pattern 2c80d5d established. `encoding.token` (the type-chip
// text colour) is left following the theme: --accent/--blue/--purple/--steel/--green have no
// light-theme override in theme.css, so they read identically in both themes already.
const TOOLTIP_TEXT_DIM = '#6b7280';
const TOOLTIP_BORDER = 'rgba(255,255,255,.1)';
const TOOLTIP_CHIP_BG = 'rgba(255,255,255,.06)';
const TOOLTIP_DIVIDER = 'rgba(255,255,255,.07)';

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
        background: 'rgba(16,18,22,.94)', border: `1px solid ${TOOLTIP_BORDER}`, borderRadius: 9, backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: CAMERA_CTRL_TEXT }}>{tooltip.content.name}</div>
      <div style={{ marginTop: 3, fontFamily: 'var(--mono)', fontSize: 9.5, color: TOOLTIP_TEXT_DIM }}>
        {tooltip.content.entityCount.toLocaleString()} entities · {tooltip.content.boundaryRouteCount.toLocaleString()} boundary routes
      </div>
      {tooltip.content.topTypeCounts.length > 0 && (
        <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>
          {tooltip.content.topTypeCounts.map(({ type, count }) => {
            const encoding = encodingForType(type);
            return (
              <span key={type} style={{ fontFamily: 'var(--mono)', fontSize: 9, padding: '1px 6px', borderRadius: 4, background: TOOLTIP_CHIP_BG, color: `var(${encoding.token})` }}>
                {encoding.label.toLowerCase()} {count}
              </span>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${TOOLTIP_DIVIDER}`, fontFamily: 'var(--mono)', fontSize: 9, color: CAMERA_CTRL_TEXT_FAINT }}>
        {tooltip.content.affordance}
      </div>
    </div>
  );
}

export default MemoryConstellation3D;
