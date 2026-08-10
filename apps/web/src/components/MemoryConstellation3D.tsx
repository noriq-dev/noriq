import { useEffect, useRef, useState } from 'react';
import type * as Three from 'three';
import {
  buildConstellation3DRenderPlan, constellation3DNodeEncoding, type Constellation3DEdge, type Constellation3DEdgeSegment,
  type Constellation3DNode, type Constellation3DNodeInstance, type Constellation3DShape,
} from './constellation-3d-buffers';

const LABEL_BUDGET = 24;

export interface MemoryConstellation3DProps {
  nodes: Constellation3DNode[];
  edges: Constellation3DEdge[];
  selectedNodeId: string | null;
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
  render: () => void;
  dispose: () => void;
}

function hueFor(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0) % 360;
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
 * React only owns the canvas, failure state, and a fixed label budget. It is intentionally not
 * wired into MemoryView until the cutover task establishes fallback and parity. */
export function MemoryConstellation3D({
  nodes, edges, selectedNodeId, theme = 'dark', reducedMotion = false,
  onSelectNode, onRendererFailure,
}: MemoryConstellation3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RendererState | null>(null);
  const [labels, setLabels] = useState<LabelPosition[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    void import('three').then((THREE) => {
      if (cancelled) return;
      try {
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
        if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 is unavailable');
        renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        renderer.setClearColor(theme === 'dark' ? 0x0c1017 : 0xf4f6fa, 1);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 20_000);
        camera.position.set(0, 0, 900);
        camera.lookAt(0, 0, 0);
        const plan = buildConstellation3DRenderPlan(nodes, edges, null, LABEL_BUDGET);
        const nodeMeshes: Three.InstancedMesh[] = [];
        const matrix = new THREE.Matrix4();
        const color = new THREE.Color();

        for (const [shape, instances] of plan.nodeGroups) {
          for (const faded of [false, true]) {
            const group = instances.filter((node) => (node.opacity < 1) === faded);
            if (group.length === 0) continue;
            const geometry = geometryFor(THREE, shape);
            const material = new THREE.MeshBasicMaterial({ transparent: faded, opacity: faded ? 0.42 : 1, vertexColors: true });
            const mesh = new THREE.InstancedMesh(geometry, material, group.length);
            mesh.userData.nodeIds = group.map((node) => node.id);
            group.forEach((node, index) => {
              matrix.makeScale(node.scale, node.scale, node.scale);
              matrix.setPosition(...node.position);
              mesh.setMatrixAt(index, matrix);
              color.setHSL(hueFor(node.type) / 360, theme === 'dark' ? 0.7 : 0.6, theme === 'dark' ? 0.62 : 0.42);
              mesh.setColorAt(index, color);
            });
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            mesh.computeBoundingSphere();
            scene.add(mesh);
            nodeMeshes.push(mesh);
          }
        }

        const leadNodes = nodes.map(constellation3DNodeEncoding).filter((node) => node.halo);
        if (leadNodes.length > 0) {
          const halo = new THREE.InstancedMesh(
            new THREE.TorusGeometry(1.35, 0.12, 5, 12),
            new THREE.MeshBasicMaterial({ color: theme === 'dark' ? 0xffd166 : 0x8a5a00, transparent: true, opacity: 0.9 }),
            leadNodes.length,
          );
          halo.userData.nodeIds = leadNodes.map((node) => node.id);
          leadNodes.forEach((node, index) => {
            matrix.makeScale(node.scale, node.scale, node.scale);
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

        const render = () => renderer.render(scene, camera);
        const renderEdges = (selection: string | null) => {
          clearEdges();
          const selectedPlan = buildConstellation3DRenderPlan(nodes, edges, selection, LABEL_BUDGET);
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
          projectLabels(selectedPlan.labels, selectedPlan.promotedEdges);
          render();
        };

        const resize = () => {
          const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderEdges(selectedNodeId);
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);

        rendererRef.current = {
          THREE, renderer, scene, camera, nodeMeshes, edgeObjects, renderEdges, render,
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
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    // Scene reconstruction is reserved for page integration/theme changes, not selection.
  }, [nodes, edges, theme, onRendererFailure]);

  useEffect(() => { rendererRef.current?.renderEdges(selectedNodeId); }, [selectedNodeId]);

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
    const state = rendererRef.current;
    if (!state) return;
    const factor = event.deltaY < 0 ? 0.88 : 1.14;
    state.camera.position.multiplyScalar(factor);
    state.camera.position.clampLength(80, 8_000);
    state.renderEdges(selectedNodeId);
  };

  return (
    <div ref={hostRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} data-reduced-motion={reducedMotion ? 'true' : 'false'}>
      <canvas ref={canvasRef} onPointerUp={selectAt} onWheel={dolly} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} aria-label={`3D memory constellation with ${nodes.length} visible items`} />
      {labels.map((label) => (
        <span key={label.key} style={{ position: 'absolute', left: label.x, top: label.y, transform: 'translate(-50%, -50%)', pointerEvents: 'none', fontFamily: 'var(--mono)', fontSize: label.promoted ? 11 : 10, fontWeight: label.promoted ? 700 : 500, color: label.promoted ? 'var(--amber)' : 'var(--text-soft)', textShadow: '0 1px 4px var(--bg)' }}>{label.text}</span>
      ))}
      {failure && <div role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-dim)', fontSize: 12 }}>3D view unavailable: {failure}</div>}
    </div>
  );
}

export default MemoryConstellation3D;
