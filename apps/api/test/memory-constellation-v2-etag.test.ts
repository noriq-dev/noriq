import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/util';
import {
  constellationAmbientPosition, constellationEtagInput, CONSTELLATION_READ_VERSION, type ConstellationV2Revision,
} from '../src/memory/constellation-v2';

const revision: ConstellationV2Revision = {
  contract: 'constellation-v2', generationId: 'generation-1', sourceRevision: 7,
  currentRevision: 7, topologyVersion: 'topology-v1', layoutVersion: 'layout-v1',
  state: 'current', generatedAt: '2026-08-11T00:00:00.000Z',
};

describe('Constellation v2 ETag identity (PLNR-466)', () => {
  it('is stable and includes the declared read-time serialization version', async () => {
    expect(CONSTELLATION_READ_VERSION).toBe('read-v3');
    const identity = '/api/projects/p1/memory/constellation/v2/overview';
    const current = constellationEtagInput(revision, identity, 'verbose-v1');
    const repeated = constellationEtagInput(revision, identity, 'verbose-v1');
    const old = [
      revision.contract, revision.generationId, revision.currentRevision, revision.topologyVersion,
      revision.layoutVersion, identity, 'verbose-v1',
    ].join('\n');

    expect(repeated).toBe(current);
    expect(current.split('\n')).toContain(CONSTELLATION_READ_VERSION);
    expect(await sha256Hex(current)).not.toBe(await sha256Hex(old));
  });
});

describe('constellation ambient positions', () => {
  it('deterministically spreads unanchored entities across a wide bounded field', () => {
    const first = constellationAmbientPosition('noriq://task/ambient-a', 245);
    expect(constellationAmbientPosition('noriq://task/ambient-a', 245)).toEqual(first);
    expect(constellationAmbientPosition('noriq://task/ambient-b', 245)).not.toEqual(first);
    const radius = Math.hypot(...first);
    expect(radius).toBeGreaterThan(100);
    expect(radius).toBeLessThanOrEqual(850);
  });
});
