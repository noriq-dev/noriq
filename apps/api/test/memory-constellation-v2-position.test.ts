import { describe, expect, it } from 'vitest';
import {
  constellationEntityCloudRadius, constellationEntityPosition,
} from '../src/memory/constellation-v2';

describe('Constellation v2 entity scatter (PLNR-465)', () => {
  it('decorrelates position axes for representative entity URIs', () => {
    const anchor: [number, number, number] = [120, -40, 15];
    const diagonalEpsilon = 2;
    for (const uri of [
      'noriq://task/task_01k4f8w0c3x7a9m2p6q1',
      'noriq://memory/mem_01k4f91b7r2d5h8n0v3z',
      'noriq://plan/plan_01k4f95j9s6t2c8w1y7e',
    ]) {
      const position = constellationEntityPosition(uri, anchor, 216);
      expect(constellationEntityPosition(uri, anchor, 216)).toEqual(position);
      const offsets = position.map((value, axis) => value - anchor[axis]!) as [number, number, number];
      expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(diagonalEpsilon);
    }
  });

  it('scales a deterministic uniform-ball cloud with population and stays inside its well', () => {
    const anchor: [number, number, number] = [-300, 90, 25];
    const uri = 'noriq://task/task_01k4fa2s8d6g0j3m9q5x';
    const distance = (memberCount: number) => {
      const position = constellationEntityPosition(uri, anchor, memberCount);
      return Math.hypot(...position.map((value, axis) => value - anchor[axis]!));
    };
    const smallRadius = constellationEntityCloudRadius(8);
    const largeRadius = constellationEntityCloudRadius(216);
    expect(largeRadius).toBeGreaterThan(smallRadius);
    expect(smallRadius).toBeCloseTo((24 + 17 * Math.cbrt(8)) * 0.75);
    expect(largeRadius).toBeCloseTo((24 + 17 * Math.cbrt(216)) * 0.75);
    expect(distance(8)).toBeLessThanOrEqual(smallRadius);
    expect(distance(216)).toBeLessThanOrEqual(largeRadius);
    expect(distance(216) / distance(8)).toBeCloseTo(largeRadius / smallRadius);
  });
});
