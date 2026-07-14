// Branded HTML error pages for direct/non-API navigation (PLNR, error-pages ask).
// API routes keep returning JSON; this is for humans landing on a bad URL or a
// server fault. Theme-aware via prefers-color-scheme.

const MESSAGES: Record<number, { title: string; detail: string }> = {
  400: { title: 'Bad request', detail: 'The request was malformed or missing something required.' },
  401: { title: 'Not signed in', detail: 'You need to sign in to view this.' },
  403: { title: 'Forbidden', detail: "You're signed in, but this isn't yours to access." },
  404: { title: 'Not found', detail: 'That page or resource does not exist.' },
  413: { title: 'Too large', detail: 'The upload exceeded the size limit.' },
  429: { title: 'Slow down', detail: 'Too many requests. Give it a moment and try again.' },
  500: { title: 'Something broke', detail: 'An unexpected error occurred on our end.' },
  501: { title: 'Not implemented', detail: 'That capability is not available yet.' },
  502: { title: 'Upstream error', detail: 'A service Noriq depends on failed.' },
  503: { title: 'Unavailable', detail: 'This feature is not configured on this instance.' },
};

export function errorPage(status: number, override?: string): string {
  const m = MESSAGES[status] ?? { title: 'Error', detail: 'An error occurred.' };
  const detail = override ?? m.detail;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status} · Noriq</title><style>
    :root { color-scheme: light dark; --bg:#0a0b0d; --card:#0c0d10; --text:#e6e8ec; --dim:#8a8f98; --faint:#4b5563; --accent:#c6f24e; --line:rgba(255,255,255,.1) }
    @media (prefers-color-scheme: light) { :root { --bg:#f2f3f6; --card:#fff; --text:#171a20; --dim:#59606d; --faint:#99a0ac; --line:rgba(0,0,0,.1) } }
    * { box-sizing:border-box } html,body { margin:0;height:100% }
    body { background:var(--bg); color:var(--text); font-family:'Space Grotesk',system-ui,-apple-system,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh }
    .card { text-align:center; max-width:420px; padding:40px 32px }
    .logo { width:40px;height:40px;border-radius:11px;background:var(--accent);display:inline-flex;align-items:center;justify-content:center;margin-bottom:24px }
    .logo div { width:16px;height:16px;background:var(--bg);transform:rotate(45deg) }
    .code { font-family:ui-monospace,'IBM Plex Mono',monospace; font-size:64px; font-weight:700; letter-spacing:-.03em; line-height:1; margin:0 0 8px; color:var(--accent) }
    h1 { font-size:20px; font-weight:600; margin:0 0 10px; letter-spacing:-.01em }
    p { font-size:14px; color:var(--dim); line-height:1.6; margin:0 0 26px }
    a { display:inline-block; text-decoration:none; background:var(--accent); color:#0a0b0d; font-weight:600; font-size:13.5px; padding:11px 22px; border-radius:9px }
    .foot { margin-top:22px; font-family:ui-monospace,monospace; font-size:10px; color:var(--faint) }
  </style></head><body><div class="card">
    <div class="logo"><div></div></div>
    <p class="code">${status}</p>
    <h1>${escapeHtml(m.title)}</h1>
    <p>${escapeHtml(detail)}</p>
    <a href="/">← Back to Noriq</a>
    <div class="foot">Noriq · AI-native project management</div>
  </div></body></html>`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** True when the client is navigating (wants HTML), not an API/programmatic call. */
export function wantsHtml(req: Request): boolean {
  const p = new URL(req.url).pathname;
  if (p.startsWith('/api/') || p === '/mcp' || p.startsWith('/ws')) return false;
  return (req.headers.get('Accept') ?? '').includes('text/html');
}
