// OAuth Client ID Metadata Documents (CIMD), per MCP 2025-11-25 authorization
// spec + draft-ietf-oauth-client-id-metadata-document-00 (PLNR-82).
//
// When an MCP client (e.g. ChatGPT / an OpenAI app) presents an HTTPS URL as its
// client_id, the authorization server fetches that URL, validates the JSON
// metadata document, and treats it as the client's registration — no prior
// relationship or dynamic registration needed. This is what lets any self-hosted
// Noriq instance accept these clients with zero per-instance setup.
import type { Env } from '../env';

export interface CimdClient {
  name: string;
  redirectUris: string[];
}

/** A client_id is a CIMD document reference when it's an https URL. */
export const isCimdId = (clientId: string) => clientId.startsWith('https://');

const FETCH_TIMEOUT_MS = 5000;   // overall deadline: DNS + connect + body read
const DNS_TIMEOUT_MS = 2000;
const MAX_DOC_BYTES = 64 * 1024;
const MAX_REDIRECT_URIS = 20;
const MAX_REDIRECTS = 3;

/** Block IP-literal and local hosts to blunt SSRF; CIMD hosts are always domains. */
function hostIsBlocked(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv6 literal (URL hostnames keep brackets stripped) — reject all; hosts should be names.
  if (h.includes(':')) return true;
  // IPv4 literal → reject private / loopback / link-local / CGNAT ranges (and, to be safe, any bare IPv4).
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) return true;
  return false;
}

/**
 * True if an *IP address* falls in a range we must never let CIMD reach:
 * loopback, private (RFC 1918 / ULA), link-local, CGNAT, unspecified, multicast,
 * and other reserved space. This is the check `hostIsBlocked` cannot do — a domain
 * whose A/AAAA record points at 169.254.169.254 or 10.x passes the string check but
 * must be caught here after DNS resolution. Accepts IPv4 dotted-quad and IPv6 forms.
 */
export function ipIsBlocked(ip: string): boolean {
  const raw = ip.trim().toLowerCase();
  // IPv4-mapped / -compatible IPv6 (::ffff:a.b.c.d or ::a.b.c.d) → test the embedded IPv4.
  const mapped = /^(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(raw);
  if (mapped) return ipv4IsBlocked(mapped[1] ?? '');
  if (raw.includes(':')) return ipv6IsBlocked(raw);
  return ipv4IsBlocked(raw);
}

function ipv4IsBlocked(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return true; // unparseable → treat as unsafe
  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4]);
  if ([a, b, c, d].some((n) => n > 255)) return true; // octet out of range
  if (a === 0) return true;                       // 0.0.0.0/8 "this network"
  if (a === 10) return true;                      // 10.0.0.0/8 private
  if (a === 127) return true;                     // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a >= 224) return true;                      // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function ipv6IsBlocked(ip: string): boolean {
  const h = ip.replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;     // loopback / unspecified
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  if (h.startsWith('ff')) return true;            // ff00::/8 multicast
  return false;
}

/** Resolve a hostname to its IP addresses. Injectable; defaults to DNS-over-HTTPS. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/**
 * Default resolver: Cloudflare DNS-over-HTTPS (JSON). Used to catch domains that
 * resolve to internal IPs *before* we connect. Best-effort: on a DoH error we
 * return `[]` and let the literal-host guard + the platform's own egress rules
 * stand — an attacker cannot suppress Cloudflare's resolver, so the only fail-open
 * case is a genuine DoH outage, not attacker-controlled. (Note: without socket
 * pinning this cannot fully stop DNS-rebinding between our lookup and the real
 * connect; it raises the bar rather than closing the hole absolutely.)
 */
export const resolveViaDoh: HostResolver = async (hostname) => {
  const ips: string[] = [];
  for (const type of ['A', 'AAAA']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DNS_TIMEOUT_MS);
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal: ctrl.signal,
      });
      if (!r.ok) continue;
      const data = (await r.json()) as { Answer?: Array<{ type: number; data: string }> };
      for (const ans of data.Answer ?? []) {
        if (ans.type === 1 || ans.type === 28) ips.push(ans.data); // A / AAAA
      }
    } catch {
      // Ignore this record type; other type / other guards still apply.
    } finally {
      clearTimeout(timer);
    }
  }
  return ips;
};

/**
 * Full pre-connect guard for one host: literal-host denylist, optional allowlist,
 * then DNS resolution with a per-IP private-range check. Re-run on every hop.
 */
async function assertHostAllowed(hostname: string, allow: string[], resolveHost: HostResolver): Promise<void> {
  if (hostIsBlocked(hostname)) throw new Error('client_id host is not permitted');
  if (allow.length && !allow.includes(hostname.toLowerCase())) {
    throw new Error('client_id host is not on this instance’s allowlist');
  }
  // DNS-resolve and reject if ANY address is in private/reserved space. An empty
  // result (DoH unreachable / NXDOMAIN) is not treated as a positive block — a bad
  // host is caught by the resolved-IP check above when DoH is reachable, and the
  // real connect fails for a genuinely unresolvable name.
  const ips = await resolveHost(hostname);
  const bad = ips.find((ip) => ipIsBlocked(ip));
  if (bad) throw new Error('client_id host resolves to a non-public address');
}

/** Read a response body under a running byte cap; abort (via the shared signal) bounds time. */
async function readCappedBody(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('client metadata document too large');
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopbackHttp = (u: URL) => u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);

/** A redirect URI is acceptable if it's https or a loopback http (localhost/127.0.0.1). */
function redirectUriOk(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || isLoopbackHttp(url);
  } catch {
    return false;
  }
}

/**
 * Whether a requested redirect_uri is permitted by a client's registered list.
 * Exact match, EXCEPT loopback (native-app) redirects match ignoring the port —
 * RFC 8252 §7.3: clients bind an ephemeral OS port at request time (e.g. Claude
 * Code's http://localhost:3118/callback vs the registered http://localhost/callback).
 */
export function redirectUriAllowed(requested: string, allowed: string[]): boolean {
  if (allowed.includes(requested)) return true;
  let req: URL;
  try { req = new URL(requested); } catch { return false; }
  if (!isLoopbackHttp(req)) return false; // non-loopback must match exactly
  return allowed.some((a) => {
    try {
      const au = new URL(a);
      return isLoopbackHttp(au) && au.hostname === req.hostname && au.pathname === req.pathname;
    } catch {
      return false;
    }
  });
}

/**
 * Fetch + validate a Client ID Metadata Document. Throws Error(reason) on any
 * failure (unreachable, malformed, mismatched client_id, disallowed host, …).
 *
 * SSRF/DoS hardening (PLNR-100): the host is DNS-resolved and rejected if it points
 * at any private/reserved address *before* connecting, redirects are followed manually
 * with the same guard re-run on every hop, and the body is streamed under a running
 * byte cap and a single overall deadline (no unbounded buffering, no slow-drip).
 * `doFetch` and `resolveHost` are injectable for testing; production uses the global
 * fetch and Cloudflare DoH.
 */
export async function resolveCimdClient(
  env: Env,
  clientId: string,
  doFetch: typeof fetch = fetch,
  resolveHost: HostResolver = resolveViaDoh,
): Promise<CimdClient> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new Error('client_id is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('client_id URL must use https');
  if (url.pathname === '/' || url.pathname === '') throw new Error('client_id URL must have a path component');
  if (url.hash) throw new Error('client_id URL must not contain a fragment');

  // Optional trust policy: restrict to an allowlist of hostnames when configured.
  const allow = (env.CIMD_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  // One deadline spans DNS + connect + redirects + body read, so a slow-drip body
  // can't outlive it. `redirect: 'manual'` lets us re-run the SSRF guard on every
  // hop instead of trusting fetch to follow into an internal host.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      await assertHostAllowed(current.hostname, allow, resolveHost); // pre-connect, every hop
      try {
        res = await doFetch(current.toString(), {
          method: 'GET',
          // A User-Agent avoids UA-less bot blocks. We handle redirects ourselves.
          headers: { Accept: 'application/json', 'User-Agent': 'Noriq-MCP/1.0 (+https://plan.frs.llc)' },
          redirect: 'manual',
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new Error(`could not fetch client metadata document (${e instanceof Error ? e.message : String(e)})`);
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects fetching client metadata document');
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('client metadata document redirected to an invalid URL');
      }
      if (next.protocol !== 'https:') throw new Error('client metadata document redirected to a non-https URL');
      current = next;
    }
    if (!res.ok) throw new Error(`client metadata document returned ${res.status}`);
    // Streamed, size-capped read (never buffers an unbounded body).
    text = await readCappedBody(res, MAX_DOC_BYTES);
  } finally {
    clearTimeout(timer);
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('client metadata document is not valid JSON');
  }

  // client_id in the document MUST equal the URL exactly.
  if (doc.client_id !== clientId) throw new Error('client_id in document does not match the URL');
  const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 80) : null;
  if (!name) throw new Error('client metadata document is missing client_name');
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (!uris.length) throw new Error('client metadata document has no redirect_uris');
  if (uris.length > MAX_REDIRECT_URIS) throw new Error('too many redirect_uris');
  const clean = uris.filter(redirectUriOk);
  if (!clean.length) throw new Error('no acceptable redirect_uris (https or loopback required)');

  return { name, redirectUris: clean };
}
