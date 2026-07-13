import type { Env } from './env';

/**
 * Transactional email via Cloudflare Email Service (send_email binding).
 * OPTIONAL by design: self-hosted instances without an onboarded sending
 * domain simply get `sent: false` back and the UI falls back to a copyable
 * invite link. Configure with the EMAIL binding + EMAIL_FROM var.
 */
export async function sendInviteEmail(
  env: Env,
  opts: { to: string; toName: string; inviterName: string; inviteUrl: string; origin: string },
): Promise<boolean> {
  if (!env.EMAIL || !env.EMAIL_FROM) return false;
  const instance = new URL(opts.origin).hostname;
  try {
    await env.EMAIL.send({
      to: opts.to,
      from: { email: env.EMAIL_FROM, name: `planar · ${instance}` },
      subject: `${opts.inviterName} invited you to planar (${instance})`,
      text: [
        `${opts.inviterName} invited you to the planar instance at ${opts.origin}.`,
        '',
        'planar coordinates AI agents and the humans supervising them.',
        '',
        `Accept your invite and set up your account (passkey or password):`,
        opts.inviteUrl,
        '',
        'This link expires in 7 days. If you were not expecting this, ignore it.',
      ].join('\n'),
      html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <div style="display:inline-block;width:28px;height:28px;border-radius:7px;background:#c6f24e;text-align:center;line-height:28px;font-weight:bold;color:#0a0b0d">◆</div>
  <span style="font-size:18px;font-weight:700;vertical-align:top;line-height:28px"> planar</span>
  <p style="font-size:14px;color:#333;line-height:1.6">
    <b>${escapeHtml(opts.inviterName)}</b> invited you (<b>${escapeHtml(opts.toName)}</b>) to the planar
    instance at <b>${escapeHtml(instance)}</b> — a mission control where AI agents and humans work
    projects together.
  </p>
  <p style="margin:24px 0">
    <a href="${opts.inviteUrl}" style="background:#1a1a1a;color:#c6f24e;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600;font-size:14px">Accept invite &amp; create account</a>
  </p>
  <p style="font-size:12px;color:#888;line-height:1.6">
    You'll be able to sign in with a passkey (recommended) or a password.<br>
    This link expires in 7 days. Not expecting this? Ignore it.
  </p>
</div>`,
    });
    return true;
  } catch {
    // Unonboarded domain, suppressed recipient, etc. — fall back to the link.
    return false;
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
