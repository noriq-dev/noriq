// Out-of-band signal delivery (PLNR-120). request_input parks the agent and raise_alert
// can be critical — but both were only visible in an open SPA tab, so a parked agent
// could sit idle for hours while its supervisor was at lunch. This pushes the two
// signal shapes that genuinely block progress out to email (project owner) and an
// optional webhook. Both channels are optional and best-effort: notification failure
// must never fail the signal itself.
//
// `doFetch` is injectable because `fetchMock` can't intercept the worker isolate
// reached via SELF.fetch (CLAUDE.md) — unit tests pass a stub and assert the payload.
import type { Env } from '../env';

export interface SignalNotification {
  projectId: string;
  projectKey: string;
  type: 'input_request' | 'alert';
  severity: string;
  title: string;
  body?: string | null;
  taskKey?: string | null;
  agentName: string;
  options?: string[] | null;
}

/** Only what genuinely blocks progress goes out-of-band — everything else would train
 *  the recipient to ignore the channel. */
export function needsOutOfBand(type: string, severity: string): boolean {
  return type === 'input_request' || severity === 'critical';
}

/** Email the project owner. Same optional-send design as invites (email.ts). */
export async function sendSignalEmail(env: Env, to: string, n: SignalNotification): Promise<boolean> {
  if (!env.EMAIL || !env.EMAIL_FROM || !to) return false;
  const gate = n.type === 'input_request';
  const where = `${n.projectKey}${n.taskKey ? ` · ${n.taskKey}` : ''}`;
  const link = env.PUBLIC_ORIGIN ? `${env.PUBLIC_ORIGIN}/p/${encodeURIComponent(n.projectId)}` : null;
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.EMAIL_FROM, name: 'Noriq' },
      subject: gate
        ? `[${where}] ${n.agentName} needs a decision: ${n.title}`
        : `[${where}] CRITICAL alert from ${n.agentName}: ${n.title}`,
      text: [
        gate
          ? `${n.agentName} is BLOCKED waiting on your decision (the task is parked until you answer):`
          : `${n.agentName} raised a critical alert:`,
        '',
        n.title,
        ...(n.body ? ['', n.body] : []),
        ...(n.options?.length ? ['', `Options: ${n.options.join(' | ')}`] : []),
        ...(link ? ['', `Answer it: ${link}`] : []),
      ].join('\n'),
    });
    return true;
  } catch {
    return false;
  }
}

/** POST to the configured webhook, HMAC-signed when a secret is set. The payload also
 *  carries a Slack-compatible `text` so the URL can simply be a Slack incoming hook. */
export async function sendSignalWebhook(
  env: Env,
  n: SignalNotification,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  if (!env.SIGNAL_WEBHOOK_URL) return false;
  const gate = n.type === 'input_request';
  const where = `${n.projectKey}${n.taskKey ? ` · ${n.taskKey}` : ''}`;
  const text = gate
    ? `⏸ [${where}] ${n.agentName} needs a decision: *${n.title}*${n.options?.length ? ` (${n.options.join(' / ')})` : ''}`
    : `🚨 [${where}] critical alert from ${n.agentName}: *${n.title}*`;
  const body = JSON.stringify({ event: 'signal.raised', text, ...n });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.SIGNAL_WEBHOOK_SECRET) {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.SIGNAL_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    headers['X-Noriq-Signature'] = `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  try {
    const res = await doFetch(env.SIGNAL_WEBHOOK_URL, { method: 'POST', headers, body });
    return res.ok;
  } catch {
    return false;
  }
}
