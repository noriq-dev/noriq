import { SELF } from 'cloudflare:test';

export const ADMIN = 'test-admin-token';

// ---------------------------------------------------------------------------
// Agent minting via the REAL OAuth flow (static keys are retired — PLNR-52):
// one shared client + consent user, then set_agent_identity names the agent.
// ---------------------------------------------------------------------------

const MINT_REDIRECT = 'http://localhost:39999/cb';
let mintClientId: string | null = null;
let mintCookie: string | null = null;

async function s256b64url(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintBoot() {
  if (!mintCookie) {
    mintCookie = await loginSession('agent-mint@example.com', 'longenough1').catch(async () => {
      await createUser('agent-mint@example.com', 'Agent Mint', 'longenough1', 'admin');
      return loginSession('agent-mint@example.com', 'longenough1');
    });
  }
  if (!mintClientId) {
    const res = await SELF.fetch('https://planar.test/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'test-mint', redirect_uris: [MINT_REDIRECT] }),
    });
    mintClientId = ((await res.json()) as { client_id: string }).client_id;
  }
}

/** Full OAuth mint: consent → code → token → set_agent_identity(name, role). */
export async function createAgent(name: string, role: 'orchestrator' | 'worker' = 'worker') {
  await mintBoot();
  const verifier = `mint-verifier-${name}-`.padEnd(48, 'x');
  const q = new URLSearchParams({
    response_type: 'code', client_id: mintClientId!, redirect_uri: MINT_REDIRECT,
    code_challenge: await s256b64url(verifier), code_challenge_method: 'S256', scope: 'mcp', state: 'm',
  });
  const form = new URLSearchParams(Object.fromEntries(q.entries()));
  form.set('decision', 'approve');
  const approve = await SELF.fetch('https://planar.test/oauth/authorize', {
    method: 'POST',
    headers: { Cookie: mintCookie!, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  const code = new URL(approve.headers.get('Location')!).searchParams.get('code')!;
  const tokenRes = await SELF.fetch('https://planar.test/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: MINT_REDIRECT,
      client_id: mintClientId!, code_verifier: verifier,
    }).toString(),
  });
  const apiKey = ((await tokenRes.json()) as { access_token: string }).access_token;
  const set = await mcpCall(apiKey, 'set_agent_identity', { name, role });
  if (set.isError) throw new Error(`set_agent_identity failed for ${name}: ${set.text}`);
  return { id: set.body.actingAs.id as string, apiKey };
}

export async function createUser(email: string, name: string, password: string, role: 'admin' | 'member' = 'member') {
  const res = await SELF.fetch('https://planar.test/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, password, role }),
  });
  if (res.status !== 200) throw new Error(`createUser failed: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

let rpcId = 1;

/** Call an MCP tool over Streamable HTTP and return the parsed result body + notices. */
export async function mcpCall(apiKey: string, tool: string, args: Record<string, unknown> = {}) {
  const first = await mcpCallOnce(apiKey, tool, args);
  // vitest-pool-workers reloads the bundle between files, breaking in-flight DO
  // stubs exactly once ("invalidating this Durable Object ... Please retry").
  if (first.isError && first.text.includes('invalidating this Durable Object')) {
    return mcpCallOnce(apiKey, tool, args);
  }
  return first;
}

async function mcpCallOnce(apiKey: string, tool: string, args: Record<string, unknown> = {}) {
  const res = await SELF.fetch('https://planar.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const raw = await res.text();
  if (res.status !== 200) throw new Error(`mcp ${tool} → ${res.status}: ${raw}`);
  const message = parseRpcResponse(raw, res.headers.get('Content-Type') ?? '');
  if (message.error) throw new Error(`mcp ${tool} rpc error: ${JSON.stringify(message.error)}`);
  const text: string = message.result?.content?.[0]?.text ?? '';
  const isError = message.result?.isError === true;
  const [jsonPart, noticesPart] = text.split('\n\n--- notices ---\n');
  return {
    isError,
    text,
    body: isError ? null : safeParse(jsonPart ?? ''),
    notices: noticesPart ?? null,
  };
}

export async function mcpList(apiKey: string) {
  const res = await SELF.fetch('https://planar.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/list', params: {} }),
  });
  const message = parseRpcResponse(await res.text(), res.headers.get('Content-Type') ?? '');
  return message.result?.tools as Array<{ name: string; description: string }>;
}

function parseRpcResponse(raw: string, contentType: string): any {
  if (contentType.includes('text/event-stream')) {
    // SSE: take the last data: line containing our response.
    const datas = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (const d of datas.reverse()) {
      try {
        const parsed = JSON.parse(d);
        if (parsed.id !== undefined) return parsed;
      } catch {
        /* skip */
      }
    }
    throw new Error(`no JSON-RPC response found in SSE stream: ${raw.slice(0, 400)}`);
  }
  return JSON.parse(raw);
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function loginSession(email: string, password: string): Promise<string> {
  const res = await SELF.fetch('https://planar.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${await res.text()}`);
  const cookie = res.headers.get('Set-Cookie') ?? '';
  return cookie.split(';')[0] ?? '';
}
