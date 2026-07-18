// PLNR-104: the GitHub webhook must fail closed when GITHUB_WEBHOOK_SECRET is unset
// (an unauthenticated caller must never be able to flip task state), and its signature
// check must be constant-time. This drives the route end-to-end through the worker.
import { SELF, env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WEBHOOK = 'https://noriq.test/api/webhooks/github';
const e = env as unknown as { GITHUB_WEBHOOK_SECRET?: string };

async function signature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const post = (payload: string, headers: Record<string, string>) =>
  SELF.fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload });

const original = e.GITHUB_WEBHOOK_SECRET;
afterAll(() => {
  if (original === undefined) delete e.GITHUB_WEBHOOK_SECRET;
  else e.GITHUB_WEBHOOK_SECRET = original;
});

describe('GitHub webhook auth (PLNR-104)', () => {
  const payload = JSON.stringify({ zen: 'ping' });

  it('fails closed with 501 when no secret is configured (no silent bypass)', async () => {
    delete e.GITHUB_WEBHOOK_SECRET;
    const r = await post(payload, { 'X-GitHub-Event': 'ping' });
    expect(r.status).toBe(501);
  });

  describe('with a configured secret', () => {
    beforeAll(() => { e.GITHUB_WEBHOOK_SECRET = 'wh-secret-under-test'; });

    it('rejects a request with no signature', async () => {
      const r = await post(payload, { 'X-GitHub-Event': 'ping' });
      expect(r.status).toBe(401);
    });

    it('rejects a request with a wrong signature', async () => {
      const r = await post(payload, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) });
      expect(r.status).toBe(401);
    });

    it('rejects a valid signature computed with the wrong secret', async () => {
      const sig = await signature('some-other-secret', payload);
      const r = await post(payload, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sig });
      expect(r.status).toBe(401);
    });

    it('accepts a correctly-signed payload', async () => {
      const sig = await signature('wh-secret-under-test', payload);
      const r = await post(payload, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sig });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, ignored: 'ping' });
    });
  });
});
