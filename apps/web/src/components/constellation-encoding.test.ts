import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryNodeType } from '@noriq-dev/shared';
import { describe, expect, it } from 'vitest';
import {
  CONSTELLATION_SHAPE_GLYPH, CONSTELLATION_TYPE_ENCODING, type Constellation3DShape, encodingForType, resolveConstellationToken,
} from './constellation-encoding';

// theme.css itself, read as text — same pattern theme.mobile.test.ts already uses to assert on
// the stylesheet without a jsdom CSS engine standing in for a real browser cascade.
const themeCss = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');

describe('constellation type encoding (PLNR-437)', () => {
  it('has a row for every real MemoryNodeType value — no silent fallthrough to the default encoding', () => {
    for (const type of MemoryNodeType.options) {
      expect(CONSTELLATION_TYPE_ENCODING[type], `missing encoding for MemoryNodeType "${type}"`).toBeDefined();
    }
    expect(Object.keys(CONSTELLATION_TYPE_ENCODING)).toHaveLength(MemoryNodeType.options.length);
  });

  it('matches the Navigator conventions doc table for the 7 primary types', () => {
    expect(encodingForType('memory')).toMatchObject({ shape: 'sphere', token: '--accent' });
    expect(encodingForType('task')).toMatchObject({ shape: 'box', token: '--blue' });
    expect(encodingForType('plan')).toMatchObject({ shape: 'dodecahedron', token: '--green' });
    expect(encodingForType('file')).toMatchObject({ shape: 'cone', token: '--steel' });
    expect(encodingForType('symbol')).toMatchObject({ shape: 'cone', token: '--steel' });
    expect(encodingForType('repository')).toMatchObject({ shape: 'cone', token: '--steel' });
    // The design doc's "doc" row has no matching MemoryNodeType — project docs are projected as
    // `artifact` nodes (apps/api/src/memory/projection.ts). `artifact` carries that row instead.
    expect(encodingForType('artifact')).toMatchObject({ shape: 'octahedron', token: '--purple', label: 'Doc' });
  });

  it('gives the cone family (file/symbol/repository) a distinct scale so type stays legible where colour and shape are shared', () => {
    const file = encodingForType('file');
    const symbol = encodingForType('symbol');
    const repository = encodingForType('repository');
    expect(symbol.scaleMultiplier).toBeLessThan(file.scaleMultiplier);
    expect(repository.scaleMultiplier).toBeGreaterThan(file.scaleMultiplier);
  });

  it('keeps every one of the 7 primary/canonical types distinguishable by shape (or, within the cone family, by scale) with colour removed', () => {
    const primary = ['memory', 'task', 'plan', 'artifact', 'file', 'symbol', 'repository'] as const;
    const byShape = new Map<string, string[]>();
    for (const type of primary) {
      const { shape, scaleMultiplier } = encodingForType(type);
      const key = `${shape}:${scaleMultiplier}`;
      byShape.set(key, [...(byShape.get(key) ?? []), type]);
    }
    for (const [key, types] of byShape) expect(types, `types sharing shape+scale ${key} are indistinguishable without colour`).toHaveLength(1);
  });

  it('resolves colour only from a theme.css custom property, never from a computed/hashed HSL value', () => {
    for (const encoding of Object.values(CONSTELLATION_TYPE_ENCODING)) {
      expect(encoding.token.startsWith('--'), `${encoding.type}'s token "${encoding.token}" is not a CSS custom property`).toBe(true);
      // The token must actually be defined in theme.css — not a typo'd or orphaned name.
      expect(themeCss.includes(`${encoding.token}:`), `theme.css never defines ${encoding.token}`).toBe(true);
    }
  });

  it('falls back to the unknown encoding, never throws or returns undefined, for a type the table has not been told about', () => {
    expect(encodingForType('__not_a_real_type__')).toBe(CONSTELLATION_TYPE_ENCODING.unknown);
  });

  it('resolveConstellationToken degrades to its fallback when the token is not defined on the current cascade', () => {
    // This test's jsdom document has no theme.css loaded, so the custom property resolves empty —
    // the same branch a non-browser context (`typeof document === 'undefined'`) takes.
    expect(resolveConstellationToken('--accent', '#fallback')).toBe('#fallback');
  });

  it('has a distinct DOM glyph for every Constellation3DShape (PLNR-438 legend)', () => {
    const shapes: Constellation3DShape[] = ['sphere', 'box', 'octahedron', 'cone', 'dodecahedron'];
    for (const shape of shapes) expect(CONSTELLATION_SHAPE_GLYPH[shape], `no glyph for shape "${shape}"`).toBeTruthy();
    expect(new Set(Object.values(CONSTELLATION_SHAPE_GLYPH)).size).toBe(shapes.length);
  });
});
