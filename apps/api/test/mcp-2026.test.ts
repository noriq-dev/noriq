import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createAgent, mcpCall } from './helpers';

/**
 * MCP 2026-07-28 ("modern") compat layer — PLNR-233.
 *
 * Modern requests carry their protocol version + client capabilities in `_meta` on every
 * request (no initialize handshake, no Mcp-Session-Id) and the mirrored Mcp-Method /
 * Mcp-Name headers; the server answers statelessly with resultType/serverInfo (+
 * ttlMs/cacheScope on cacheable results). The legacy session path must keep working
 * unchanged on the same endpoint — that IS the spec's dual-era fallback.
 */

const MODERN = '2026-07-28';
const V = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';

let rpcId = 9000;

/** POST one modern JSON-RPC request. Spec-compliant headers by default; each override
 *  (or `undefined` to omit) mis-shapes exactly one thing for the validation tests. */
async function modern(
  apiKey: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: {
    version?: string | null; // null → omit the _meta version entirely
    omitCaps?: boolean;
    headers?: Record<string, string | undefined>;
    id?: false; // send as a notification (no id)
  } = {},
) {
  const _meta: Record<string, unknown> = {
    ...(opts.version === null ? {} : { [V]: opts.version ?? MODERN }),
    ...(opts.omitCaps ? {} : { [CAPS]: {} }),
    'io.modelcontextprotocol/clientInfo': { name: 'vitest-modern', version: '1.0.0' },
  };
  const name = (params.name ?? params.uri) as string | undefined;
  const headers: Record<string, string | undefined> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': typeof _meta[V] === 'string' ? (_meta[V] as string) : MODERN,
    'Mcp-Method': method,
    ...(name !== undefined ? { 'Mcp-Name': name } : {}),
    ...opts.headers,
  };
  const res = await SELF.fetch('https://noriq.test/mcp', {
    method: 'POST',
    headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) as Record<string, string>,
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(opts.id === false ? {} : { id: rpcId++ }),
      method,
      params: { ...params, _meta },
    }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, contentType: res.headers.get('Content-Type') ?? '' };
}

/** Parse the JSON body a Noriq tool result carries in content[0].text (before notices). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolBody(result: any): any {
  const text: string = result?.content?.[0]?.text ?? '';
  return JSON.parse(text.split('\n\n--- notices ---\n')[0] ?? '');
}

let apiKey: string;

beforeAll(async () => {
  ({ apiKey } = await createAgent('modern-era-agent') as unknown as { apiKey: string });
});

describe('server/discover', () => {
  it('advertises modern + legacy versions, capabilities, instructions, and cache hints', async () => {
    const { status, body } = await modern(apiKey, 'server/discover');
    expect(status).toBe(200);
    const r = body.result;
    expect(r.resultType).toBe('complete');
    expect(r.supportedVersions).toContain('2026-07-28');
    expect(r.supportedVersions).toContain('2025-11-25');
    expect(r.supportedVersions).toContain('2025-03-26');
    expect(r.capabilities.tools).toBeDefined();
    expect(r.capabilities.resources).toBeDefined();
    expect(r.instructions).toContain('Noriq');
    expect(r.ttlMs).toBeGreaterThan(0);
    expect(r.cacheScope).toBe('private');
    expect(r._meta[SERVER_INFO_KEY].name).toBe('noriq');
  });

  it('works without the required-for-other-methods _meta fields (it is the probe)', async () => {
    const { status, body } = await modern(apiKey, 'server/discover', {}, { version: null, omitCaps: true, headers: { 'Mcp-Method': undefined } });
    expect(status).toBe(200);
    expect(body.result.supportedVersions).toContain(MODERN);
  });
});

describe('stateless requests (no initialize, no session)', () => {
  it('serves tools/call with resultType, serverInfo, and the notices contract intact', async () => {
    const { status, body } = await modern(apiKey, 'tools/call', { name: 'get_briefing', arguments: {} });
    expect(status).toBe(200);
    expect(body.result.resultType).toBe('complete');
    expect(body.result._meta[SERVER_INFO_KEY].name).toBe('noriq');
    expect(toolBody(body.result).you.name).toBeDefined();
  });

  it('resolves the SAME copilot for repeated modern calls on one token', async () => {
    const a = await modern(apiKey, 'tools/call', { name: 'get_briefing', arguments: {} });
    const b = await modern(apiKey, 'tools/call', { name: 'get_briefing', arguments: {} });
    const idA = toolBody(a.body.result).you.id;
    const idB = toolBody(b.body.result).you.id;
    expect(idA).toBeDefined();
    expect(idA).toBe(idB);
  });

  it('carries ttlMs + cacheScope on tools/list', async () => {
    const { status, body } = await modern(apiKey, 'tools/list', {});
    expect(status).toBe(200);
    expect(body.result.resultType).toBe('complete');
    expect(body.result.ttlMs).toBeGreaterThan(0);
    expect(body.result.cacheScope).toBe('private');
    expect(body.result.tools.length).toBeGreaterThan(10);
  });

  it('accepts a notification with 202 and no body', async () => {
    const { status, body } = await modern(apiKey, 'notifications/cancelled', { requestId: 1 }, { id: false });
    expect(status).toBe(202);
    expect(body).toBeNull();
  });

  it('decodes the base64 sentinel in Mcp-Name', async () => {
    const encoded = `=?base64?${btoa('get_briefing')}?=`;
    const { status, body } = await modern(apiKey, 'tools/call', { name: 'get_briefing', arguments: {} }, { headers: { 'Mcp-Name': encoded } });
    expect(status).toBe(200);
    expect(body.result.resultType).toBe('complete');
  });
});

describe('validation errors (modern JSON-RPC error bodies — what era detection runs on)', () => {
  it('unsupported protocol version → 400 + -32022 listing supported versions', async () => {
    const { status, body } = await modern(apiKey, 'tools/list', {}, { version: '1900-01-01', headers: { 'MCP-Protocol-Version': '1900-01-01' } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain('2026-07-28');
    expect(body.error.data.requested).toBe('1900-01-01');
  });

  it('missing required clientCapabilities → 400 + -32602', async () => {
    const { status, body } = await modern(apiKey, 'tools/list', {}, { omitCaps: true });
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32602);
  });

  it('Mcp-Name mismatching the body → 400 + -32020 HeaderMismatch', async () => {
    const { status, body } = await modern(apiKey, 'tools/call', { name: 'get_briefing', arguments: {} }, { headers: { 'Mcp-Name': 'someone_else' } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  it('missing Mcp-Method header → 400 + -32020', async () => {
    const { status, body } = await modern(apiKey, 'tools/list', {}, { headers: { 'Mcp-Method': undefined } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  it('MCP-Protocol-Version header disagreeing with _meta → 400 + -32020', async () => {
    const { status, body } = await modern(apiKey, 'tools/list', {}, { headers: { 'MCP-Protocol-Version': '2025-11-25' } });
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  it('unknown modern method → 404 + -32601 (ping and logging/setLevel are gone)', async () => {
    for (const method of ['ping', 'logging/setLevel', 'subscriptions/listen']) {
      const { status, body } = await modern(apiKey, method, {});
      expect(status).toBe(404);
      expect(body.error.code).toBe(-32601);
    }
  });
});

describe('dual-era coexistence', () => {
  it('legacy session-header calls keep working on the same endpoint and token', async () => {
    const legacy = await mcpCall(apiKey, 'get_briefing', {});
    expect(legacy.isError).toBe(false);
    expect(legacy.body.you.name).toBeDefined();
    // And a modern call right after — same token, no cross-talk.
    const { status } = await modern(apiKey, 'tools/call', { name: 'get_briefing', arguments: {} });
    expect(status).toBe(200);
  });

  it('legacy initialize still negotiates a legacy version (the required fallback)', async () => {
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId++,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy-client', version: '1.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Mcp-Session-Id')).toBeTruthy();
    const raw = await res.text();
    const data = raw.startsWith('event:') || raw.includes('data:')
      ? JSON.parse(raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).find((d) => d.includes('"result"'))!)
      : JSON.parse(raw);
    expect(data.result.protocolVersion).toBe('2025-11-25');
    expect(data.result.serverInfo.name).toBe('noriq');
  });
});
