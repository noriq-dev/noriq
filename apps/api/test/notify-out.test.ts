// PLNR-120: out-of-band signal delivery. fetchMock can't reach the worker isolate
// (CLAUDE.md), so the webhook sender takes an injected fetch and is unit-tested here;
// the email path is exercised with a stub EMAIL binding the same way.
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { needsOutOfBand, sendSignalEmail, sendSignalWebhook, type SignalNotification } from '../src/lib/notify-out';

const N: SignalNotification = {
  projectId: 'prj_x', projectKey: 'X', type: 'input_request', severity: 'info',
  title: 'Which database?', body: 'sqlite keeps it simple', taskKey: 'X-7',
  agentName: 'builder', options: ['sqlite', 'postgres'],
};

describe('out-of-band signal delivery', () => {
  it('only blocking decisions and critical alerts leave the building', () => {
    expect(needsOutOfBand('input_request', 'info')).toBe(true);
    expect(needsOutOfBand('alert', 'critical')).toBe(true);
    expect(needsOutOfBand('alert', 'warning')).toBe(false);
    expect(needsOutOfBand('alert', 'info')).toBe(false);
  });

  it('webhook: signs the exact body, carries a Slack-compatible text, and never throws', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const doFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const env = { SIGNAL_WEBHOOK_URL: 'https://hooks.example.com/x', SIGNAL_WEBHOOK_SECRET: 's3cret' } as Env;
    expect(await sendSignalWebhook(env, N, doFetch)).toBe(true);
    expect(seen).toHaveLength(1);

    const body = String(seen[0]!.init.body);
    const payload = JSON.parse(body) as { event: string; text: string; options: string[] };
    expect(payload.event).toBe('signal.raised');
    expect(payload.text).toContain('needs a decision');
    expect(payload.text).toContain('X · X-7');
    expect(payload.options).toEqual(['sqlite', 'postgres']);

    // The signature verifies against the body actually sent.
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('s3cret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect((seen[0]!.init.headers as Record<string, string>)['X-Noriq-Signature']).toBe(`sha256=${hex}`);

    // No URL configured → quietly does nothing.
    expect(await sendSignalWebhook({} as Env, N, doFetch)).toBe(false);
    // A hook that explodes must not take the signal down with it.
    const boom = (async () => { throw new Error('net down'); }) as unknown as typeof fetch;
    expect(await sendSignalWebhook(env, N, boom)).toBe(false);
  });

  it('email: optional-send — absent binding is a quiet no; present binding gets the decision', async () => {
    expect(await sendSignalEmail({} as Env, 'own@example.com', N)).toBe(false);

    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const env = {
      EMAIL: { send: async (m: { to: string; subject: string; text: string }) => { sent.push(m); } },
      EMAIL_FROM: 'noriq@example.com',
      PUBLIC_ORIGIN: 'https://plan.example.com',
    } as unknown as Env;
    expect(await sendSignalEmail(env, 'own@example.com', N)).toBe(true);
    expect(sent[0]!.subject).toContain('needs a decision');
    expect(sent[0]!.text).toContain('Options: sqlite | postgres');
    expect(sent[0]!.text).toContain('https://plan.example.com/p/prj_x');
  });
});
