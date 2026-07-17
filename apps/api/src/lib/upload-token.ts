// PLNR-173: a stateless capability token for agent attachment uploads. The MCP tool
// mints one; the PUT upload route verifies it. The token IS the authorization — it is
// safe to hand to an agent's shell (for curl) precisely because it is single-purpose and
// short-lived, unlike the agent's OAuth bearer, which the driver keeps out of the shell.
//
// Stateless by design (option A): everything the upload route needs is in the signed
// claims, and row creation is idempotent on the attachmentId, so no intent table is
// needed and a replayed PUT within the TTL just overwrites the same object.

export interface UploadClaims {
  aid: string; // attachmentId (also the R2 key segment and the resource id)
  tid: string; // resolved task id (opaque, not the display key)
  pid: string; // project id
  fn: string; // sanitized filename
  ct: string; // content type
  agentId: string; // who uploads — recorded as uploaded_by
  max: number; // byte ceiling
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

export async function signUploadToken(secret: string, claims: UploadClaims): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const sig = b64url(await hmac(secret, payload));
  return `${payload}.${sig}`;
}

/** Returns the claims if the token is authentic and unexpired, else null. */
export async function verifyUploadToken(secret: string, token: string, nowSec: number): Promise<UploadClaims | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(await hmac(secret, payload));
  if (!timingSafeEqual(sig, expected)) return null;
  let claims: UploadClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp < nowSec) return null;
  return claims;
}
