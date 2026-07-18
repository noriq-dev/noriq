// PLNR-104: the GitHub webhook must fail closed when GITHUB_WEBHOOK_SECRET is unset
// (an unauthenticated caller must never be able to flip task state), and its signature
// check must be constant-time. We call the worker's fetch handler directly so the secret
// can be toggled per-case — mutating the `cloudflare:test` env does NOT propagate to the
// worker isolate reached via SELF.fetch. The `ping` event returns before any DB access,
// so no fixtures are needed.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

type FetchEnv = Parameters<typeof worker.fetch>[1];

const WEBHOOK = 'https://noriq.test/api/webhooks/github';

async function signature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function callWebhook(secret: string | undefined, payload: string, headers: Record<string, string>): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload });
  const res = await worker.fetch(req, { ...env, GITHUB_WEBHOOK_SECRET: secret } as unknown as FetchEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('GitHub webhook auth (PLNR-104)', () => {
  const payload = JSON.stringify({ zen: 'ping' });
  const secret = 'wh-secret-under-test';

  it('fails closed with 501 when no secret is configured (no silent bypass)', async () => {
    const r = await callWebhook(undefined, payload, { 'X-GitHub-Event': 'ping' });
    expect(r.status).toBe(501);
  });

  it('rejects a request with no signature', async () => {
    const r = await callWebhook(secret, payload, { 'X-GitHub-Event': 'ping' });
    expect(r.status).toBe(401);
  });

  it('rejects a request with a wrong signature', async () => {
    const r = await callWebhook(secret, payload, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) });
    expect(r.status).toBe(401);
  });

  it('rejects a valid signature computed with the wrong secret', async () => {
    const sig = await signature('some-other-secret', payload);
    const r = await callWebhook(secret, payload, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sig });
    expect(r.status).toBe(401);
  });

  it('accepts a correctly-signed payload', async () => {
    const sig = await signature(secret, payload);
    const r = await callWebhook(secret, payload, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sig });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, ignored: 'ping' });
  });
});
