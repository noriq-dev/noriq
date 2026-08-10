import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONSTELLATION_3D_CAMERA, createCameraTransition, dollyConstellationCamera, focusConstellationCamera,
  loadConstellation3DPreferences, orbitConstellationCamera, sampleCameraTransition,
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
});
