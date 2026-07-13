import { SELF } from 'cloudflare:test';

export const ADMIN = 'test-admin-token';

export async function createAgent(name: string, role: 'orchestrator' | 'worker' = 'worker') {
  const res = await SELF.fetch('https://planar.test/api/admin/agents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, role }),
  });
  if (res.status !== 200) throw new Error(`createAgent failed: ${await res.text()}`);
  return (await res.json()) as { id: string; apiKey: string };
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
