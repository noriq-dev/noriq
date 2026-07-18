// PLNR-82: OAuth Client ID Metadata Documents (CIMD). An MCP client (e.g. an
// OpenAI app / ChatGPT) presents an HTTPS-URL client_id; the AS fetches +
// validates the metadata document and treats it as the client's registration.
//
// resolveCimdClient() takes an injectable fetch, so the document server is a
// deterministic stub here. The OAuth wiring is checked through SELF for the
// paths that need no outbound fetch (discovery flag, pre-fetch SSRF rejection).
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { ipIsBlocked, isCimdId, redirectUriAllowed, resolveCimdClient } from '../src/lib/cimd';
import type { HostResolver } from '../src/lib/cimd';

const env = (over: Partial<Env> = {}) => ({ ...over }) as Env;
const CLIENT = 'https://client.example.com/oauth/client.json';
/** Default resolver stub: every host resolves to a public IP (no network in tests). */
const pub: HostResolver = async () => ['93.184.216.34'];
/** Resolver that maps specific hosts to given IPs (for DNS-SSRF cases). */
const resolveTo = (map: Record<string, string[]>): HostResolver => async (h) => map[h] ?? ['93.184.216.34'];
/** A fetch stub that 302-redirects to `location`, then serves `body` on the next hop. */
function redirectThenServe(location: string, body: unknown) {
  let hop = 0;
  return vi.fn(async () => {
    if (hop++ === 0) return new Response(null, { status: 302, headers: { location } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}
const validDoc = {
  client_id: CLIENT,
  client_name: 'ChatGPT (test)',
  redirect_uris: ['https://client.example.com/callback', 'http://localhost:3000/cb'],
  grant_types: ['authorization_code'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};
/** A fetch stub that serves one canned response and records the requested URL. */
function serve(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}
const boom = vi.fn(async () => { throw new Error('unreachable'); }) as unknown as typeof fetch;

describe('redirectUriAllowed — loopback port flexibility (PLNR-82, RFC 8252)', () => {
  it('matches a dynamic loopback port against a port-less registration (Claude Code)', () => {
    const registered = ['http://localhost/callback', 'http://127.0.0.1/callback'];
    expect(redirectUriAllowed('http://localhost:3118/callback', registered)).toBe(true);
    expect(redirectUriAllowed('http://127.0.0.1:55044/callback', registered)).toBe(true);
    expect(redirectUriAllowed('http://localhost/callback', registered)).toBe(true); // exact still fine
  });
  it('requires exact match for non-loopback (https) redirects', () => {
    const registered = ['https://chatgpt.com/connector/oauth/abc'];
    expect(redirectUriAllowed('https://chatgpt.com/connector/oauth/abc', registered)).toBe(true);
    expect(redirectUriAllowed('https://chatgpt.com/connector/oauth/OTHER', registered)).toBe(false);
    expect(redirectUriAllowed('https://evil.example.com/cb', registered)).toBe(false);
  });
  it('loopback flexibility does not cross paths or hosts', () => {
    const registered = ['http://localhost/callback'];
    expect(redirectUriAllowed('http://localhost:3118/evil', registered)).toBe(false); // different path
    expect(redirectUriAllowed('http://evil.example.com:3118/callback', registered)).toBe(false); // not loopback
  });
});

describe('resolveCimdClient (PLNR-82)', () => {
  it('detects URL-formatted client_ids', () => {
    expect(isCimdId('https://x.example.com/c.json')).toBe(true);
    expect(isCimdId('client_abc123')).toBe(false);
  });

  it('fetches + validates a well-formed document', async () => {
    const c = await resolveCimdClient(env(), CLIENT, serve(200, validDoc), pub);
    expect(c.name).toBe('ChatGPT (test)');
    expect(c.redirectUris).toContain('https://client.example.com/callback');
    expect(c.redirectUris).toContain('http://localhost:3000/cb'); // loopback http allowed
  });

  it('rejects when the document client_id ≠ the URL', async () => {
    await expect(resolveCimdClient(env(), CLIENT, serve(200, { ...validDoc, client_id: 'https://client.example.com/OTHER.json' }), pub))
      .rejects.toThrow(/does not match/);
  });

  it('drops disallowed redirect_uris and rejects when none remain', async () => {
    await expect(resolveCimdClient(env(), CLIENT, serve(200, { ...validDoc, redirect_uris: ['http://evil.example.com/cb'] }), pub))
      .rejects.toThrow(/redirect_uris/);
  });

  it('rejects non-JSON and 404 documents', async () => {
    await expect(resolveCimdClient(env(), CLIENT, serve(200, 'not json'), pub)).rejects.toThrow(/valid JSON/);
    await expect(resolveCimdClient(env(), CLIENT, serve(404, 'nope'), pub)).rejects.toThrow(/returned 404/);
  });

  it('SSRF: rejects a domain whose DNS resolves to a private/link-local IP (PLNR-100)', async () => {
    // Literal-host guard passes (it is a plain domain), but the resolved A-record is internal.
    const metadata = resolveTo({ 'client.example.com': ['169.254.169.254'] });
    await expect(resolveCimdClient(env(), CLIENT, serve(200, validDoc), metadata))
      .rejects.toThrow(/non-public address/);
    const rfc1918 = resolveTo({ 'client.example.com': ['1.2.3.4', '10.0.0.5'] }); // one bad answer is enough
    await expect(resolveCimdClient(env(), CLIENT, serve(200, validDoc), rfc1918))
      .rejects.toThrow(/non-public address/);
  });

  it('SSRF: re-runs the guard on redirect hops — a redirect to an internal host is refused (PLNR-100)', async () => {
    const fetchStub = redirectThenServe('https://evil.example.com/doc.json', validDoc);
    const resolver = resolveTo({ 'evil.example.com': ['192.168.1.10'] });
    await expect(resolveCimdClient(env(), CLIENT, fetchStub, resolver))
      .rejects.toThrow(/non-public address/);
  });

  it('follows a redirect to another public host and validates there (PLNR-100)', async () => {
    // client_id in the doc must still equal the ORIGINAL URL, so identity is preserved.
    const fetchStub = redirectThenServe('https://cdn.example.net/doc.json', validDoc);
    const c = await resolveCimdClient(env(), CLIENT, fetchStub, pub);
    expect(c.name).toBe('ChatGPT (test)');
  });

  it('DoS: rejects a body that exceeds the size cap without buffering it whole (PLNR-100)', async () => {
    const huge = 'x'.repeat(70 * 1024); // > 64 KiB
    await expect(resolveCimdClient(env(), CLIENT, serve(200, huge), pub)).rejects.toThrow(/too large/);
  });

  it('SSRF: refuses IP-literal / local / non-https / path-less client_ids before fetching', async () => {
    await expect(resolveCimdClient(env(), 'https://169.254.169.254/c.json', boom)).rejects.toThrow(/not permitted/);
    await expect(resolveCimdClient(env(), 'https://localhost/c.json', boom)).rejects.toThrow(/not permitted/);
    await expect(resolveCimdClient(env(), 'http://client.example.com/c.json', boom)).rejects.toThrow(/https/);
    await expect(resolveCimdClient(env(), 'https://client.example.com', boom)).rejects.toThrow(/path component/);
    expect(boom).not.toHaveBeenCalled(); // all rejected before any network call
  });

  it('honors an optional host allowlist', async () => {
    await expect(resolveCimdClient(env({ CIMD_ALLOWED_HOSTS: 'chatgpt.com, claude.ai' }), CLIENT, boom))
      .rejects.toThrow(/allowlist/);
    const c = await resolveCimdClient(env({ CIMD_ALLOWED_HOSTS: 'client.example.com' }), CLIENT, serve(200, validDoc), pub);
    expect(c.name).toBe('ChatGPT (test)');
  });

  it('ipIsBlocked flags private/reserved addresses and passes public ones', () => {
    for (const bad of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(ipIsBlocked(bad)).toBe(true);
    }
    for (const ok of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(ipIsBlocked(ok)).toBe(false);
    }
  });
});

describe('CIMD OAuth wiring (PLNR-82)', () => {
  let cookie: string;
  beforeAll(async () => {
    const { createUser, loginSession } = await import('./helpers');
    await createUser('cimd-user@example.com', 'CIMD User', 'longenough1', 'admin').catch(() => {});
    cookie = await loginSession('cimd-user@example.com', 'longenough1');
  });

  it('discovery advertises client_id_metadata_document_supported (DCR kept too)', async () => {
    const as = await SELF.fetch('https://noriq.test/.well-known/oauth-authorization-server');
    const meta = (await as.json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.registration_endpoint).toContain('/oauth/register');
    expect(meta.authorization_response_iss_parameter_supported).toBe(true); // RFC 9207
    expect(as.headers.get('Cache-Control')).toBe('no-store'); // never edge-cache a stale (pre-CIMD) copy
  });

  it('the OIDC-discovery path also advertises CIMD (strict clients probe it — PLNR-82)', async () => {
    const oidc = await SELF.fetch('https://noriq.test/.well-known/openid-configuration');
    expect(oidc.status).toBe(200);
    const meta = (await oidc.json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.token_endpoint).toContain('/oauth/token');
  });

  it('protected-resource metadata is served at both root and the /mcp-scoped path', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const rs = await SELF.fetch(`https://noriq.test${path}`);
      expect(rs.status).toBe(200);
      const meta = (await rs.json()) as { resource: string; authorization_servers: string[] };
      expect(meta.resource).toContain('/mcp');
      expect(meta.authorization_servers[0]).toBe('https://noriq.test');
    }
  });

  it('CORS preflight is answered for /mcp', async () => {
    const pre = await SELF.fetch('https://noriq.test/mcp', {
      method: 'OPTIONS',
      headers: { Origin: 'https://chatgpt.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
  });

  it('authorize rejects a disallowed (SSRF) URL client_id before fetching', async () => {
    const q = new URLSearchParams({
      response_type: 'code', client_id: 'https://169.254.169.254/c.json', redirect_uri: 'https://x/cb',
      state: 's', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', scope: 'mcp',
    });
    const res = await SELF.fetch(`https://noriq.test/oauth/authorize?${q}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/host is not permitted|client metadata/);
  });
});
