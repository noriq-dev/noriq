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
  /** A camera is reusable only for the generation whose resident layout it describes. Older
   * preferences did not carry this field and safely fall back to fit-to-content on first load. */
  generationId?: string;
  camera: Constellation3DCamera;
  expandedCommunityIds: string[];
}

export interface LoadedConstellation3DPreferences extends Constellation3DPreferences {
  cameraSource: 'stored' | 'fallback';
}

export interface CameraTransition {
  from: Constellation3DCamera;
  to: Constellation3DCamera;
  startedAt: number;
  durationMs: number;
}

export const DEFAULT_CONSTELLATION_3D_CAMERA: Constellation3DCamera = { target: [0, 0, 0], yaw: 0, pitch: 0.2, distance: 900 };
export const CONSTELLATION_3D_VERTICAL_FOV_DEGREES = 48;
export const CONSTELLATION_3D_FIT_PADDING = 1.06;

export interface Constellation3DFitItem {
  position: [number, number, number];
  /** World-space rendered radius. `scale` is also accepted so callers can pass either form. */
  radius?: number;
  scale?: number;
}

export interface Constellation3DFitOptions {
  aspect?: number;
  verticalFovDegrees?: number;
  padding?: number;
  minDistance?: number;
  maxDistance?: number;
  camera?: Constellation3DCamera;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Frames every resident footprint in the actual camera basis. A bounding-sphere fit makes a wide,
 * flat anchor cloud pay its horizontal radius against the much narrower vertical FOV, wasting the
 * sides of a landscape viewport; per-axis perspective constraints keep the padded wells in frame
 * while allowing the anchor spread itself to occupy roughly 80% of a 1440×790 view (PLNR-457). */
export function fitConstellationCamera(
  items: readonly Constellation3DFitItem[],
  options: Constellation3DFitOptions = {},
): Constellation3DCamera {
  const base = options.camera ?? DEFAULT_CONSTELLATION_3D_CAMERA;
  const valid = items.flatMap((item) => {
    if (!item.position.every(Number.isFinite)) return [];
    const extent = Math.max(
      Number.isFinite(item.radius) ? Math.max(0, item.radius!) : 0,
      Number.isFinite(item.scale) ? Math.max(0, item.scale!) : 0,
    );
    return [{ position: item.position, extent }];
  });
  if (valid.length === 0) return { ...base, target: [...base.target] };

  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { position, extent } of valid) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, position[axis]! - extent);
      maximum[axis] = Math.max(maximum[axis]!, position[axis]! + extent);
    }
  }
  const target = minimum.map((value, axis) => (value + maximum[axis]!) / 2) as [number, number, number];
  const verticalHalfFov = clamp(
    (Number.isFinite(options.verticalFovDegrees) ? options.verticalFovDegrees! : CONSTELLATION_3D_VERTICAL_FOV_DEGREES) * Math.PI / 360,
    Math.PI / 180,
    Math.PI * 0.49,
  );
  const aspect = Number.isFinite(options.aspect) && options.aspect! > 0 ? options.aspect! : 1;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect);
  const padding = Number.isFinite(options.padding) ? Math.max(1, options.padding!) : CONSTELLATION_3D_FIT_PADDING;
  const minDistance = Number.isFinite(options.minDistance) ? Math.max(0, options.minDistance!) : 60;
  const maxDistance = Number.isFinite(options.maxDistance) ? Math.max(minDistance, options.maxDistance!) : 12_000;
  const backward: [number, number, number] = [
    Math.sin(base.yaw) * Math.cos(base.pitch),
    Math.sin(base.pitch),
    Math.cos(base.yaw) * Math.cos(base.pitch),
  ];
  const right: [number, number, number] = [Math.cos(base.yaw), 0, -Math.sin(base.yaw)];
  const up: [number, number, number] = [
    -Math.sin(base.yaw) * Math.sin(base.pitch),
    Math.cos(base.pitch),
    -Math.cos(base.yaw) * Math.sin(base.pitch),
  ];
  const dot = (vector: readonly number[], basis: readonly number[]) =>
    vector[0]! * basis[0]! + vector[1]! * basis[1]! + vector[2]! * basis[2]!;
  const distance = clamp(valid.reduce((required, item) => {
    const relative = item.position.map((value, axis) => value - target[axis]!) as [number, number, number];
    const towardCamera = dot(relative, backward) + item.extent;
    const horizontal = Math.abs(dot(relative, right)) + item.extent;
    const vertical = Math.abs(dot(relative, up)) + item.extent;
    return Math.max(
      required,
      towardCamera + horizontal * padding / Math.tan(horizontalHalfFov),
      towardCamera + vertical * padding / Math.tan(verticalHalfFov),
    );
  }, 0), minDistance, maxDistance);
  return { target, yaw: base.yaw, pitch: base.pitch, distance };
}

/** Community fly-in uses the same camera-basis fit as Home, but with a little more breathing room
 * and the normal focus distance ceiling so a system reads as a place rather than another overview. */
export function fitConstellationClusterCamera(
  items: readonly Constellation3DFitItem[],
  options: Constellation3DFitOptions = {},
): Constellation3DCamera {
  return fitConstellationCamera(items, {
    ...options,
    padding: options.padding ?? 1.16,
    minDistance: options.minDistance ?? 60,
    maxDistance: options.maxDistance ?? 2_000,
  });
}

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

export function loadConstellation3DPreferences(
  projectId: string,
  layoutVersion: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
  fallbackCamera: Constellation3DCamera = DEFAULT_CONSTELLATION_3D_CAMERA,
  generationId?: string,
): LoadedConstellation3DPreferences {
  const fallback: LoadedConstellation3DPreferences = {
    version: CONSTELLATION_3D_PREFS_VERSION, layoutVersion, generationId,
    camera: { ...fallbackCamera, target: [...fallbackCamera.target] }, expandedCommunityIds: [], cameraSource: 'fallback',
  };
  try {
    const parsed = JSON.parse(storage.getItem(constellation3DPrefsKey(projectId)) ?? 'null') as Partial<Constellation3DPreferences> | null;
    if (!parsed || parsed.version !== CONSTELLATION_3D_PREFS_VERSION || parsed.layoutVersion !== layoutVersion
      || (generationId !== undefined && parsed.generationId !== generationId) || !validCamera(parsed.camera)) return fallback;
    return {
      ...fallback, camera: parsed.camera, cameraSource: 'stored',
      expandedCommunityIds: Array.isArray(parsed.expandedCommunityIds) ? parsed.expandedCommunityIds.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch { return fallback; }
}

export function saveConstellation3DPreferences(projectId: string, preferences: Constellation3DPreferences, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try { storage.setItem(constellation3DPrefsKey(projectId), JSON.stringify(preferences)); } catch { /* preferences are optional */ }
}
