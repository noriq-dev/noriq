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
