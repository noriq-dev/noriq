import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Three from 'three';
import {
  buildConstellation3DRenderPlan, constellation3DNodeEncoding, type Constellation3DEdge, type Constellation3DEdgeSegment,
  type Constellation3DNode, type Constellation3DNodeInstance, type Constellation3DShape,
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
  x: number;
  y: number;
  promoted: boolean;
}

interface RendererState {
  THREE: typeof Three;
  renderer: Three.WebGLRenderer;
  scene: Three.Scene;
  camera: Three.PerspectiveCamera;
  nodeMeshes: Three.InstancedMesh[];
  edgeObjects: Three.Object3D[];
  renderEdges: (selectedNodeId: string | null) => void;
  applyCamera: (camera: Constellation3DCamera) => void;
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
              mesh.setColorAt(index, colorForType(node.type));
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

        const projectLabels = (labelNodes: Constellation3DNodeInstance[], promoted: Constellation3DEdgeSegment[]) => {
          const width = host.clientWidth || 1, height = host.clientHeight || 1;
          const visible: LabelPosition[] = [];
          for (const node of labelNodes) {
            const point = new THREE.Vector3(...node.position).project(camera);
            if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) continue;
            visible.push({ key: `node:${node.id}`, text: node.label, x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2, promoted: false });
          }
          for (const edge of promoted.slice(0, Math.max(0, LABEL_BUDGET - visible.length))) {
            const point = new THREE.Vector3(...midpoint(edge)).project(camera);
            if (point.z < -1 || point.z > 1) continue;
            visible.push({ key: `edge:${edge.id}`, text: `${edge.direction === 'reverse' ? '←' : edge.direction === 'both' ? '↔' : '→'} ${edge.type}`, x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2, promoted: true });
          }
          setLabels(visible.slice(0, LABEL_BUDGET));
        };

        let currentLabels = plan.labels;
        let currentPromoted: Constellation3DEdgeSegment[] = [];
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
        const renderEdges = (selection: string | null) => {
          clearEdges();
          const selectedPlan = buildConstellation3DRenderPlan(layoutNodes, edges, selection, LABEL_BUDGET, highlighted);
          const base = lineObject(THREE, selectedPlan.baseEdges, theme === 'dark' ? 0x7790aa : 0x506070, selection ? 0.1 : 0.38, 0);
          if (base) { scene.add(base); edgeObjects.push(base); }
          const promoted = lineObject(THREE, selectedPlan.promotedEdges, theme === 'dark' ? 0xffd166 : 0x8a5a00, 1, 10);
          if (promoted) { scene.add(promoted); edgeObjects.push(promoted); }
          const directed = selectedPlan.promotedEdges.filter((edge) => edge.directionMarker);
          if (directed.length > 0) {
            const markers = new THREE.InstancedMesh(new THREE.ConeGeometry(1.6, 4.8, 5), new THREE.MeshBasicMaterial({ color: theme === 'dark' ? 0xffd166 : 0x8a5a00, depthTest: false }), directed.length);
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
          currentLabels = selectedPlan.labels;
          currentPromoted = selectedPlan.promotedEdges;
          projectLabels(currentLabels, currentPromoted);
          render();
        };
        const applyCamera = (next: Constellation3DCamera) => {
          camera.position.set(...constellationCameraPosition(next));
          camera.lookAt(...next.target);
          projectLabels(currentLabels, currentPromoted);
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
          THREE, renderer, scene, camera, nodeMeshes, edgeObjects, renderEdges, applyCamera, render,
          dispose: () => {
            clearEdges();
            for (const mesh of nodeMeshes) {
              scene.remove(mesh); mesh.geometry.dispose();
              const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              materials.forEach((material) => material.dispose());
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
    if (!drag) return;
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
      <canvas ref={canvasRef} tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onWheel={dolly} onKeyDown={keyDown} onContextMenu={(event) => event.preventDefault()} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} aria-label={`3D memory constellation with ${layoutNodes.length} visible items. Arrow keys move selection; E opens ego network; I opens evidence inspector.`} />
      <div style={{ position: 'absolute', right: 10, top: 10, display: 'flex', gap: 6 }}>
        <button type="button" onClick={() => transitionTo(DEFAULT_CONSTELLATION_3D_CAMERA)}>home</button>
        <button type="button" disabled={!selectedNodeId} onClick={() => {
          const selected = layoutNodes.find((node) => node.id === selectedNodeId);
          if (selected) transitionTo(focusConstellationCamera(cameraState, selected.position, selected.radius ?? 18));
        }}>focus</button>
      </div>
      {labels.map((label) => (
        <span key={label.key} style={{ position: 'absolute', left: label.x, top: label.y, transform: 'translate(-50%, -50%)', pointerEvents: 'none', fontFamily: 'var(--mono)', fontSize: label.promoted ? 11 : 10, fontWeight: label.promoted ? 700 : 500, color: label.promoted ? 'var(--amber)' : 'var(--text-soft)', textShadow: '0 1px 4px var(--bg)' }}>{label.text}</span>
      ))}
      {failure && <div role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-dim)', fontSize: 12 }}>3D view unavailable: {failure}</div>}
    </div>
  );
}

export default MemoryConstellation3D;
