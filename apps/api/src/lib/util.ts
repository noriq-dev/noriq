/** Crockford-ish sortable id: millisecond timestamp + random suffix. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(r, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  return `${prefix}_${t}${s}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** base64 <-> bytes, chunked so large blobs don't blow the argument stack. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a raw agent API key. Only the SHA-256 of this is stored. */
export function newApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `plnr_${b64}`;
}

// PBKDF2 for human passwords (Workers WebCrypto has no bcrypt/argon2).
const PBKDF2_ITER = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt);
  return `pbkdf2$${PBKDF2_ITER}$${hex(salt)}$${hex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterStr || !saltHex || !hashHex) return false;
  const bits = await pbkdf2(password, unhex(saltHex), Number(iterStr));
  return timingSafeEqualHex(hex(bits), hashHex);
}

// A well-formed dummy hash (correct scheme/iters/lengths so verifyPassword runs the full
// PBKDF2) used to burn identical work when no account or password hash exists.
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITER}$${'0'.repeat(32)}$${'0'.repeat(64)}`;

// Timing-side-channel-safe verify (PLNR-105): always runs one PBKDF2 verify regardless of
// whether the account/hash exists, so the response time doesn't reveal account existence.
// A missing hash verifies against a constant fake and always returns false.
export async function verifyPasswordConstantTime(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const ok = await verifyPassword(password, stored || DUMMY_HASH);
  return stored ? ok : false;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations = PBKDF2_ITER): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array((s.match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
