import {
  CommissionedExecutionProfile,
  type CommissionedExecutionProfile as CommissionedExecutionProfileValue,
  type ExecutionProfileOffer,
  type RunnerRepo,
} from '@noriq-dev/shared';
import { RUNNER_HEARTBEAT_TTL_MS } from './runner-roster';

type ProfileRepo = Pick<RunnerRepo, 'id' | 'executionProfiles'>;

export class ExecutionProfileUnavailableError extends Error {}

function exactOffer(repo: ProfileRepo, profileId: string): ExecutionProfileOffer {
  const offers = repo.executionProfiles.filter((profile) => profile.id === profileId);
  if (offers.length === 0) throw new ExecutionProfileUnavailableError(`execution profile "${profileId}" is not advertised by repo "${repo.id}"`);
  if (offers.length !== 1) throw new ExecutionProfileUnavailableError(`execution profile "${profileId}" is advertised more than once`);
  return offers[0]!;
}

function assertUsable(offer: ExecutionProfileOffer, observedNow: number): void {
  if (offer.resolution !== 'resolved') {
    throw new ExecutionProfileUnavailableError(`execution profile "${offer.id}" is ${offer.resolution}`);
  }
  if (offer.health !== 'healthy') {
    throw new ExecutionProfileUnavailableError(`execution profile "${offer.id}" is ${offer.health}`);
  }
  if (!offer.attestationCapable || !offer.effectiveFingerprint) {
    throw new ExecutionProfileUnavailableError(`execution profile "${offer.id}" cannot attest its effective inventory`);
  }
  const observedAt = Date.parse(offer.observedAt);
  if (observedAt > observedNow + 30_000 || observedNow - observedAt > RUNNER_HEARTBEAT_TTL_MS) {
    throw new ExecutionProfileUnavailableError(`execution profile "${offer.id}" health is stale`);
  }
}

export function commissionExecutionProfile(
  repo: ProfileRepo,
  profileId: string,
  options: { observedNow?: number; requireCapacity?: boolean } = {},
): { offer: ExecutionProfileOffer; commissioned: CommissionedExecutionProfileValue } {
  const offer = exactOffer(repo, profileId);
  assertUsable(offer, options.observedNow ?? Date.now());
  if (options.requireCapacity !== false && offer.capacity.freeSlots < 1) {
    throw new ExecutionProfileUnavailableError(`execution profile "${profileId}" has no free capacity`);
  }
  return {
    offer,
    commissioned: CommissionedExecutionProfile.parse({
      id: offer.id,
      declarationFingerprint: offer.declarationFingerprint,
      effectiveFingerprint: offer.effectiveFingerprint,
      generation: offer.generation,
      attestationCapable: true,
    }),
  };
}

export function requireCommissionedExecutionProfile(
  repo: ProfileRepo,
  commissioned: CommissionedExecutionProfileValue,
  observedNow = Date.now(),
): ExecutionProfileOffer {
  const current = commissionExecutionProfile(repo, commissioned.id, {
    observedNow,
    requireCapacity: false,
  });
  if (JSON.stringify(current.commissioned) !== JSON.stringify(commissioned)) {
    throw new ExecutionProfileUnavailableError(`execution profile "${commissioned.id}" drifted after commissioning`);
  }
  return current.offer;
}

export function executionProfileSlots(offer: ExecutionProfileOffer, busy: number): number {
  return Math.max(0, Math.min(
    offer.capacity.freeSlots,
    offer.capacity.maxConcurrency - Math.max(0, busy),
  ));
}
