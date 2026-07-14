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

const FETCH_TIMEOUT_MS = 5000;
const MAX_DOC_BYTES = 64 * 1024;
const MAX_REDIRECT_URIS = 20;

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
 * `doFetch` is injectable for testing; production uses the global fetch.
 */
export async function resolveCimdClient(env: Env, clientId: string, doFetch: typeof fetch = fetch): Promise<CimdClient> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new Error('client_id is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('client_id URL must use https');
  if (url.pathname === '/' || url.pathname === '') throw new Error('client_id URL must have a path component');
  if (url.hash) throw new Error('client_id URL must not contain a fragment');
  if (hostIsBlocked(url.hostname)) throw new Error('client_id host is not permitted');

  // Optional trust policy: restrict to an allowlist of hostnames when configured.
  const allow = (env.CIMD_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(url.hostname.toLowerCase())) {
    throw new Error('client_id host is not on this instance’s allowlist');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      method: 'GET',
      // A User-Agent avoids UA-less bot blocks; follow redirects (some hosts, incl.
      // ChatGPT, redirect edge fetches). We re-check the final host for SSRF below
      // and still require doc.client_id to equal the original URL, so following a
      // redirect can't let a document from a different identity through.
      headers: { Accept: 'application/json', 'User-Agent': 'Noriq-MCP/1.0 (+https://plan.frs.llc)' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(`could not fetch client metadata document (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    clearTimeout(timer);
  }
  // Guard redirect-to-internal SSRF: the URL we ended up at must also be allowed.
  try {
    const finalHost = new URL(res.url || url.toString()).hostname;
    if (hostIsBlocked(finalHost)) throw new Error('client metadata document redirected to a disallowed host');
    if (allow.length && !allow.includes(finalHost.toLowerCase())) throw new Error('client metadata document redirected off the allowlist');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('client metadata')) throw e;
  }
  if (!res.ok) throw new Error(`client metadata document returned ${res.status}`);

  // Size-capped read.
  const text = (await res.text()).slice(0, MAX_DOC_BYTES + 1);
  if (text.length > MAX_DOC_BYTES) throw new Error('client metadata document too large');

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
