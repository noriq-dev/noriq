// PLNR-173: a stateless capability token for agent attachment uploads. The MCP tool
// mints one; the PUT upload route verifies it. The token IS the authorization — it is
// safe to hand to an agent's shell (for curl) precisely because it is single-purpose and
// short-lived, unlike the agent's OAuth bearer, which the driver keeps out of the shell.
//
// Stateless by design (option A): everything the upload route needs is in the signed
// claims, and row creation is idempotent on the attachmentId, so no intent table is
// needed and a replayed PUT within the TTL just overwrites the same object.
//
// PLNR-260 adds a SECOND token flavour (repository/episode ingest capabilities, minted for a
// runner rather than an agent) signed with the same secret. Before that addition the two would
// have been structurally interchangeable — same HMAC, same shape, nothing to tell them apart —
// so every claims shape now carries a `typ` domain separator that verification requires and
// mismatches on, mutually: an attachment token is refused by an ingest route and vice versa.

import type { Env } from '../env';

export interface AttachmentUploadClaims {
  typ: 'attachment';
  aid: string; // attachmentId (also the R2 key segment and the resource id)
  tid: string; // resolved task id (opaque, not the display key)
  pid: string; // project id
  fn: string; // sanitized filename
  ct: string; // content type
  agentId: string; // who uploads — recorded as uploaded_by
  max: number; // byte ceiling
  exp: number; // expiry, epoch seconds
}
/** @deprecated kept as an alias so existing imports keep working; prefer AttachmentUploadClaims. */
export type UploadClaims = AttachmentUploadClaims;

/**
 * A repository-index or episode ingest capability (PLNR-260, §8). Scoped to exactly one
 * (project, repository, purpose, scopeId) — `scopeId` is an IndexGenerationManifest.generationId
 * for `purpose: 'index'`, or a caller-supplied episode upload id for `purpose: 'episode'` — and
 * to the runner that requested it. `max` bounds a SINGLE batch, not the whole generation.
 */
export interface IngestClaims {
  typ: 'ingest';
  pid: string; // project id
  repositoryKey: string;
  purpose: 'index' | 'episode';
  scopeId: string; // generationId (index) or an episode upload id
  runnerId: string;
  max: number; // per-batch byte ceiling
  exp: number; // expiry, epoch seconds
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

/** Constant-time string compare — the signatures are secrets, so don't leak length-of-match. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

type AnyClaims = { typ: string; exp: number };

async function signToken<T extends AnyClaims>(secret: string, claims: T): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const sig = b64url(await hmac(secret, payload));
  return `${payload}.${sig}`;
}

/** Returns the claims if the token is authentic, unexpired, and carries the EXPECTED `typ` —
 *  else null. An absent or mismatched `typ` is a rejection, not a default: that mutual check is
 *  what keeps two token flavours signed with the same secret from being interchangeable. */
async function verifyToken<T extends AnyClaims>(secret: string, token: string, nowSec: number, expectedTyp: T['typ']): Promise<T | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(await hmac(secret, payload));
  if (!timingSafeEqual(sig, expected)) return null;
  let claims: T;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  } catch {
    return null;
  }
  if (claims.typ !== expectedTyp) return null;
  if (typeof claims.exp !== 'number' || claims.exp < nowSec) return null;
  return claims;
}

export const signUploadToken = (secret: string, claims: AttachmentUploadClaims): Promise<string> => signToken(secret, claims);
export const verifyUploadToken = (secret: string, token: string, nowSec: number): Promise<AttachmentUploadClaims | null> =>
  verifyToken<AttachmentUploadClaims>(secret, token, nowSec, 'attachment');

export const signIngestToken = (secret: string, claims: IngestClaims): Promise<string> => signToken(secret, claims);
export const verifyIngestToken = (secret: string, token: string, nowSec: number): Promise<IngestClaims | null> =>
  verifyToken<IngestClaims>(secret, token, nowSec, 'ingest');

/** The ONE place both the mint side (mcp.ts, the ingest capability route) and the consume side
 *  (the attachment/ingest routes here) resolve the signing secret — previously duplicated as the
 *  same `env.ATTACHMENT_UPLOAD_SECRET ?? env.ADMIN_TOKEN` expression in two files, which is safe
 *  only as long as both copies agree. Both token flavours share this secret (a self-host runs
 *  one fewer required env var; either flavour can still be rotated by rotating this one). */
export function resolveUploadSecret(env: Env): string | undefined {
  return env.ATTACHMENT_UPLOAD_SECRET ?? env.ADMIN_TOKEN;
}
