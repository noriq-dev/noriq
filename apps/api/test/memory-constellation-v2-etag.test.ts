import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/util';
import {
  constellationEtagInput, CONSTELLATION_READ_VERSION, type ConstellationV2Revision,
} from '../src/memory/constellation-v2';

const revision: ConstellationV2Revision = {
  contract: 'constellation-v2', generationId: 'generation-1', sourceRevision: 7,
  currentRevision: 7, topologyVersion: 'topology-v1', layoutVersion: 'layout-v1',
  state: 'current', generatedAt: '2026-08-11T00:00:00.000Z',
};

describe('Constellation v2 ETag identity (PLNR-466)', () => {
  it('is stable and includes the declared read-time serialization version', async () => {
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
