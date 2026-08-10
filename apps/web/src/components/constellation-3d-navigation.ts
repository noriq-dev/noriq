export const CONSTELLATION_3D_PREFS_VERSION = 1;

export interface Constellation3DCamera {
  target: [number, number, number];
  yaw: number;
  pitch: number;
  distance: number;
}

export interface Constellation3DPreferences {
  version: typeof CONSTELLATION_3D_PREFS_VERSION;
  layoutVersion: string;
  camera: Constellation3DCamera;
  expandedCommunityIds: string[];
}

export interface CameraTransition {
  from: Constellation3DCamera;
  to: Constellation3DCamera;
  startedAt: number;
  durationMs: number;
}

export const DEFAULT_CONSTELLATION_3D_CAMERA: Constellation3DCamera = { target: [0, 0, 0], yaw: 0, pitch: 0.2, distance: 900 };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function orbitConstellationCamera(camera: Constellation3DCamera, dx: number, dy: number): Constellation3DCamera {
  return { ...camera, yaw: camera.yaw - dx * 0.006, pitch: clamp(camera.pitch - dy * 0.006, -Math.PI * 0.48, Math.PI * 0.48) };
}

export function panConstellationCamera(camera: Constellation3DCamera, dx: number, dy: number): Constellation3DCamera {
  const scale = camera.distance / 700;
  const right: [number, number, number] = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
  const up: [number, number, number] = [0, 1, 0];
  return { ...camera, target: [
    camera.target[0] - right[0] * dx * scale + up[0] * dy * scale,
    camera.target[1] - right[1] * dx * scale + up[1] * dy * scale,
    camera.target[2] - right[2] * dx * scale + up[2] * dy * scale,
  ] };
}

export function dollyConstellationCamera(camera: Constellation3DCamera, factor: number): Constellation3DCamera {
  return { ...camera, distance: clamp(camera.distance * factor, 35, 12_000) };
}

export function focusConstellationCamera(camera: Constellation3DCamera, target: [number, number, number], radius = 20): Constellation3DCamera {
  return { ...camera, target: [...target], distance: clamp(radius * 5, 60, 2_000) };
}

export function constellationCameraPosition(camera: Constellation3DCamera): [number, number, number] {
  const horizontal = Math.cos(camera.pitch) * camera.distance;
  return [
    camera.target[0] + Math.sin(camera.yaw) * horizontal,
    camera.target[1] + Math.sin(camera.pitch) * camera.distance,
    camera.target[2] + Math.cos(camera.yaw) * horizontal,
  ];
}

export function createCameraTransition(from: Constellation3DCamera, to: Constellation3DCamera, now: number, reducedMotion: boolean): CameraTransition {
  return { from, to, startedAt: now, durationMs: reducedMotion ? 0 : 420 };
}

export function sampleCameraTransition(transition: CameraTransition, now: number): { camera: Constellation3DCamera; done: boolean } {
  const raw = transition.durationMs === 0 ? 1 : clamp((now - transition.startedAt) / transition.durationMs, 0, 1);
  const amount = 1 - Math.pow(1 - raw, 3);
  const lerp = (a: number, b: number) => a + (b - a) * amount;
  return {
    camera: {
      target: transition.from.target.map((value, index) => lerp(value, transition.to.target[index]!)) as [number, number, number],
      yaw: lerp(transition.from.yaw, transition.to.yaw), pitch: lerp(transition.from.pitch, transition.to.pitch),
      distance: lerp(transition.from.distance, transition.to.distance),
    },
    done: raw >= 1,
  };
}

export function constellation3DPrefsKey(projectId: string): string {
  return `noriq.memory.constellation3d.v${CONSTELLATION_3D_PREFS_VERSION}.${projectId}`;
}

function validCamera(value: unknown): value is Constellation3DCamera {
  if (!value || typeof value !== 'object') return false;
  const camera = value as Partial<Constellation3DCamera>;
  return Array.isArray(camera.target) && camera.target.length === 3 && camera.target.every(Number.isFinite)
    && Number.isFinite(camera.yaw) && Number.isFinite(camera.pitch) && Number.isFinite(camera.distance);
}

export function loadConstellation3DPreferences(projectId: string, layoutVersion: string, storage: Pick<Storage, 'getItem'> = localStorage): Constellation3DPreferences {
  const fallback: Constellation3DPreferences = { version: CONSTELLATION_3D_PREFS_VERSION, layoutVersion, camera: { ...DEFAULT_CONSTELLATION_3D_CAMERA, target: [...DEFAULT_CONSTELLATION_3D_CAMERA.target] }, expandedCommunityIds: [] };
  try {
    const parsed = JSON.parse(storage.getItem(constellation3DPrefsKey(projectId)) ?? 'null') as Partial<Constellation3DPreferences> | null;
    if (!parsed || parsed.version !== CONSTELLATION_3D_PREFS_VERSION || parsed.layoutVersion !== layoutVersion || !validCamera(parsed.camera)) return fallback;
    return { ...fallback, camera: parsed.camera, expandedCommunityIds: Array.isArray(parsed.expandedCommunityIds) ? parsed.expandedCommunityIds.filter((id): id is string => typeof id === 'string') : [] };
  } catch { return fallback; }
}

export function saveConstellation3DPreferences(projectId: string, preferences: Constellation3DPreferences, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try { storage.setItem(constellation3DPrefsKey(projectId), JSON.stringify(preferences)); } catch { /* preferences are optional */ }
}
