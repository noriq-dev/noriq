import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONSTELLATION_3D_CAMERA, createCameraTransition, dollyConstellationCamera, focusConstellationCamera,
  fitConstellationCamera, loadConstellation3DPreferences, orbitConstellationCamera, sampleCameraTransition,
} from './constellation-3d-navigation';

describe('constellation 3D navigation and preferences', () => {
  it('clamps orbit/dolly and makes reduced-motion focus immediate', () => {
    const orbit = orbitConstellationCamera(DEFAULT_CONSTELLATION_3D_CAMERA, 0, -100_000);
    expect(orbit.pitch).toBeLessThan(Math.PI / 2);
    expect(dollyConstellationCamera(DEFAULT_CONSTELLATION_3D_CAMERA, 0).distance).toBe(35);
    const focused = focusConstellationCamera(DEFAULT_CONSTELLATION_3D_CAMERA, [4, 5, 6], 10);
    const sample = sampleCameraTransition(createCameraTransition(DEFAULT_CONSTELLATION_3D_CAMERA, focused, 10, true), 10);
    expect(sample).toMatchObject({ camera: focused, done: true });
  });

  it('rejects old 2D pins and incompatible layout preferences instead of coercing them', () => {
    const old2d = { getItem: () => JSON.stringify({ camera: { x: 10, y: 20, zoom: 2 }, pins: { a: { x: 1, y: 2 } } }) };
    expect(loadConstellation3DPreferences('p1', 'space-v1', old2d).camera).toEqual(DEFAULT_CONSTELLATION_3D_CAMERA);
    const wrongLayout = { getItem: () => JSON.stringify({ version: 1, layoutVersion: 'space-v0', camera: { ...DEFAULT_CONSTELLATION_3D_CAMERA }, expandedCommunityIds: ['c1'] }) };
    expect(loadConstellation3DPreferences('p1', 'space-v1', wrongLayout).expandedCommunityIds).toEqual([]);
  });

  it('centres resident bounds and places the padded bounding radius inside the limiting FOV', () => {
    const camera = fitConstellationCamera([
      { position: [-100, -20, 30], radius: 10 },
      { position: [100, 20, -30], radius: 10 },
    ], { aspect: 1, padding: 1.2 });
    expect(camera.target).toEqual([0, 0, 0]);
    const boundingRadius = Math.hypot(100, 20, 30) + 10;
    expect(camera.distance).toBeGreaterThanOrEqual(boundingRadius * 1.2 / Math.sin(24 * Math.PI / 180));
    expect(camera).toMatchObject({ yaw: DEFAULT_CONSTELLATION_3D_CAMERA.yaw, pitch: DEFAULT_CONSTELLATION_3D_CAMERA.pitch });
  });

  it('returns safe cameras for single-node and empty scenes', () => {
    const single = fitConstellationCamera([{ position: [4, 5, 6], scale: 0 }]);
    expect(single).toMatchObject({ target: [4, 5, 6], distance: 60 });
    expect(Number.isFinite(single.distance)).toBe(true);
    expect(fitConstellationCamera([])).toEqual(DEFAULT_CONSTELLATION_3D_CAMERA);
  });

  it('keeps only a stored camera from the same generation and layout', () => {
    const storedCamera = { ...DEFAULT_CONSTELLATION_3D_CAMERA, target: [9, 8, 7] as [number, number, number] };
    const storage = { getItem: () => JSON.stringify({ version: 1, generationId: 'g1', layoutVersion: 'space-v1', camera: storedCamera, expandedCommunityIds: [] }) };
    const fitted = fitConstellationCamera([{ position: [500, 0, 0], radius: 20 }]);
    expect(loadConstellation3DPreferences('p1', 'space-v1', storage, fitted, 'g1')).toMatchObject({ camera: storedCamera, cameraSource: 'stored' });
    expect(loadConstellation3DPreferences('p1', 'space-v1', storage, fitted, 'g2')).toMatchObject({ camera: fitted, cameraSource: 'fallback' });
  });
});
