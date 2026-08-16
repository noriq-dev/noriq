import type { Context } from 'hono';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Env } from './env';
import { resolveSessionAgent, type AppContext, type Connection } from './auth';
import { buildMcpServer, INSTRUCTIONS, serverInfoForAgent } from './mcp';
import { handleSubscriptionsListen } from './mcp-listen';
import { copilotSessionContextFromMessages } from './lib/copilot-session';

/**
 * MCP 2026-07-28 ("modern") compatibility layer — PLNR-233.
 *
 * The 2026-07-28 revision made MCP stateless: no `initialize` handshake, no
 * `Mcp-Session-Id`; every request carries its protocol version and client capabilities
 * in `_meta`, servers MUST implement `server/discover`, results carry `resultType` (+
 * `ttlMs`/`cacheScope` on list/read results), and the `Mcp-Method`/`Mcp-Name` headers
 * mirror the body for intermediaries and MUST be validated against it.
 *
 * The official TypeScript SDK still tops out at 2025-11-25, so this layer sits at the
 * HTTP boundary IN FRONT of the SDK server: it validates the modern envelope itself,
 * answers `server/discover` directly, and bridges everything else into the same
 * `buildMcpServer` instance the legacy path uses — over an in-memory transport pair,
 * because the SDK dispatches requests without an initialization gate. The legacy
 * `initialize`/`Mcp-Session-Id` path in index.ts is untouched; per the spec's dual-era
 * rules an `initialize` request selects legacy semantics and a request carrying modern
 * per-request `_meta` is served statelessly, on the same endpoint.
 *
 * Two deliberate narrowings, both spec-clean:
 *  - Modern responses are always `application/json` (a server chooses per request between
 *    JSON and SSE). Server notifications are NOT forwarded — the spec forbids
 *    `notifications/message` for requests that did not opt in via `_meta` logLevel, and
 *    the notices text block is Noriq's documented reliable channel anyway.
 *  - Identity: 2026-07-28 removed protocol sessions (SEP-2567), so a modern copilot is
 *    keyed by its OAuth token (`stateless:{tokenId}`) — one working identity per
 *    connection — or by `_meta["openai/session"]` when a bridge supplies one, using the
 *    same `openai:` key the legacy path uses so one conversation stays one copilot
 *    across eras. Runner tokens are bound to their agent and unaffected.
 */

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** The modern revisions this layer serves statelessly. */
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'];
/** Everything the deployment speaks, newest first: modern (this file) + legacy (SDK). */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// MCP-reserved JSON-RPC error codes (2026-07-28 error-code allocation policy).
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INVALID_REQUEST = -32600;
const PARSE_ERROR = -32700;
/** Legacy resource-not-found; 2026-07-28 forbids emitting it (replaced by -32602). */
const LEGACY_RESOURCE_NOT_FOUND = -32002;

/** Methods the modern layer forwards into the SDK server. `subscriptions/listen` is
 *  handled natively (mcp-listen.ts); anything else — including the removed `ping` and
 *  `logging/setLevel` — is 404 + -32601 per the transport spec. */
const FORWARDED_METHODS = new Set(['tools/list', 'tools/call', 'resources/list', 'resources/read', 'resources/templates/list']);

/** Freshness hints for CacheableResult methods. All private: tools/list varies with the
 *  agent's tool floor and every read is behind the caller's token. */
const CACHE_TTLS: Record<string, number> = {
  // A deploy can change the catalogue. The server-info version is the durable cache revision, while
  // this short TTL keeps hosts that ignore it from holding a stale Copilot surface for an hour.
  'tools/list': 60_000,
  'resources/list': 60_000,
  'resources/read': 0, // docs are mutable; attachments are cheap to re-read
  'resources/templates/list': 3_600_000,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RpcMessage = { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: unknown; uri?: unknown; _meta?: Record<string, unknown> } } & Record<string, any>;

/**
 * Is this POST body a modern (2026-07-28+) request? Per the dual-era rules the body's
 * per-request `_meta` is the discriminator; `server/discover` is the modern probe; and a
 * modern `MCP-Protocol-Version` header catches a malformed modern request early enough
 * to answer it with a modern error (which is what tells a dual-era client NOT to fall
 * back). Legacy clients (which send `initialize`, or a 2025-* version header on
 * subsequent requests) never trip any of these.
 */
export function isModernMcpRequest(headerVersion: string | undefined, msgs: RpcMessage[]): boolean {
  if (msgs.some((m) => m?.method === 'server/discover')) return true;
  if (msgs.some((m) => m?.params?._meta?.[META_VERSION] !== undefined)) return true;
  // Protocol revisions are ISO dates, so lexicographic compare is chronological.
  if (headerVersion && headerVersion >= '2026-07-28') return true;
  return false;
}

/** Decode the `=?base64?...?=` sentinel the transport uses for non-ASCII header values. */
function decodeHeaderValue(value: string): string {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  try {
    const bytes = Uint8Array.from(atob(value.slice(9, -2)), (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value; // malformed sentinel → compared verbatim, which will (correctly) mismatch
  }
}

export async function handleModernMcp(c: Context<AppContext>, env: Env, conn: Connection, msgs: RpcMessage[]): Promise<Response> {
  const rpcError = (status: 200 | 400 | 404 | 500, id: string | number | null, code: number, message: string, data?: unknown) =>
    c.json({ jsonrpc: '2.0' as const, id, error: { code, message, ...(data !== undefined ? { data } : {}) } }, status);

  if (msgs.length !== 1) {
    // JSON-RPC batching left the spec in 2025-06-18; a modern POST body is one message.
    return rpcError(400, null, INVALID_REQUEST, 'expected a single JSON-RPC request or notification per POST');
  }
  const msg = msgs[0]!;
  if ('result' in msg || 'error' in msg) {
    return rpcError(400, null, INVALID_REQUEST, 'clients MUST NOT send JSON-RPC responses to the MCP endpoint');
  }
  if (typeof msg.method !== 'string') {
    return rpcError(400, null, PARSE_ERROR, 'malformed JSON-RPC message: no method');
  }
  // The core protocol defines no client-to-server notifications over Streamable HTTP
  // (cancellation is closing the response stream) — accept and discard.
  if (msg.id === undefined) return c.body(null, 202);
  const id = msg.id;
  const method = msg.method;
  const isDiscover = method === 'server/discover';
  const meta = (msg.params?._meta ?? {}) as Record<string, unknown>;

  // --- version negotiation (per request; no handshake) ---
  const requested = meta[META_VERSION];
  if (requested !== undefined && typeof requested !== 'string') {
    return rpcError(400, id, INVALID_PARAMS, `_meta["${META_VERSION}"] must be a string`);
  }
  if (typeof requested === 'string' && !MODERN_PROTOCOL_VERSIONS.includes(requested)) {
    // Includes legacy revisions in `supported`: they are real fallbacks for a dual-era
    // client (via initialize), and honesty here is what the negotiation flow runs on.
    return rpcError(400, id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: SUPPORTED_PROTOCOL_VERSIONS,
      requested,
    });
  }
  // server/discover is the version-agnostic probe — everything else must carry the
  // required per-request fields (a request missing one is malformed per the spec).
  if (!isDiscover) {
    if (requested === undefined) {
      return rpcError(400, id, INVALID_PARAMS, `missing required _meta["${META_VERSION}"]`);
    }
    if (meta[META_CAPS] === undefined) {
      return rpcError(400, id, INVALID_PARAMS, `missing required _meta["${META_CAPS}"]`);
    }
  }

  // --- header/body validation (Mcp-Method / Mcp-Name / MCP-Protocol-Version) ---
  // Mirrored headers exist so intermediaries can route without parsing the body; a
  // mismatch means two components would act on different truths, so it is fatal.
  const headerVersion = c.req.header('mcp-protocol-version');
  if (headerVersion !== undefined && typeof requested === 'string' && headerVersion !== requested) {
    return rpcError(400, id, HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match _meta value '${requested}'`);
  }
  const mcpMethod = c.req.header('mcp-method');
  if (mcpMethod !== undefined && decodeHeaderValue(mcpMethod) !== method) {
    return rpcError(400, id, HEADER_MISMATCH, `Header mismatch: Mcp-Method '${mcpMethod}' does not match body method '${method}'`);
  }
  if (mcpMethod === undefined && !isDiscover) {
    // Required standard header; missing is a validation failure. server/discover is
    // exempted as the probe minimal clients send first.
    return rpcError(400, id, HEADER_MISMATCH, 'Header mismatch: required Mcp-Method header is missing');
  }
  const nameSource = method === 'tools/call' ? msg.params?.name
    : method === 'resources/read' ? msg.params?.uri
    : method === 'prompts/get' ? msg.params?.name
    : undefined;
  const mcpName = c.req.header('mcp-name');
  if (typeof nameSource === 'string') {
    if (mcpName === undefined) {
      return rpcError(400, id, HEADER_MISMATCH, `Header mismatch: required Mcp-Name header is missing for ${method}`);
    }
    if (decodeHeaderValue(mcpName) !== nameSource) {
      return rpcError(400, id, HEADER_MISMATCH, `Header mismatch: Mcp-Name header value '${mcpName}' does not match body value '${nameSource}'`);
    }
  }

  // --- server/discover: answered directly, no SDK involved ---
  if (isDiscover) {
    let discoveryAgent = conn.boundAgent;
    if (!discoveryAgent) {
      const openAiSession = meta['openai/session'];
      const discoverySessionKey = typeof openAiSession === 'string' && openAiSession.length > 0
        ? `openai:${openAiSession}`
        : `stateless:${conn.tokenId}`;
      try {
        discoveryAgent = await resolveSessionAgent(
          env,
          conn,
          discoverySessionKey,
          copilotSessionContextFromMessages([msg]),
        );
      } catch (e) {
        const message = (e as Error).message;
        const authFailure = /does not belong|revoked|session has ended/i.test(message);
        return c.json({ error: message }, authFailure ? 401 : 400);
      }
    }
    return c.json({
      jsonrpc: '2.0' as const,
      id,
      result: {
        resultType: 'complete',
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        // Matches what the legacy initialize result advertises (registration adds
        // tools/resources; logging is deprecated in 2026-07-28 so it is not offered here).
        // Resource listChanged/subscribe are honored on a subscriptions/listen stream (PLNR-234).
        capabilities: { tools: {}, resources: { listChanged: true, subscribe: true }, experimental: { 'claude/channel': {} } },
        instructions: INSTRUCTIONS,
        ttlMs: 60_000,
        cacheScope: 'private' as const,
        _meta: { [META_SERVER_INFO]: serverInfoForAgent() },
      },
    }, 200);
  }

  // Long-lived change-notification stream — handled natively, scoped by the token
  // itself (no per-session identity to resolve; visibility is user ∩ token).
  if (method === 'subscriptions/listen') {
    return handleSubscriptionsListen(c, env, conn, { id, params: msg.params as Record<string, unknown> | undefined });
  }

  // Unknown-method must be 404 + -32601 on modern requests — the JSON-RPC body is what
  // distinguishes us from a legacy HTTP+SSE server's plain 404 during era detection.
  if (!FORWARDED_METHODS.has(method)) {
    return rpcError(404, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  // --- identity (no protocol sessions in 2026-07-28 — see module docs) ---
  let agent = conn.boundAgent;
  let sessionKey: string | undefined;
  if (!agent) {
    const openAiSession = meta['openai/session'];
    sessionKey = typeof openAiSession === 'string' && openAiSession.length > 0
      ? `openai:${openAiSession}`
      : `stateless:${conn.tokenId}`;
    try {
      agent = await resolveSessionAgent(env, conn, sessionKey, copilotSessionContextFromMessages([msg]));
    } catch (e) {
      const message = (e as Error).message;
      const authFailure = /does not belong|revoked|session has ended/i.test(message);
      return c.json({ error: message }, authFailure ? 401 : 400);
    }
  }

  // --- bridge into the SDK server over an in-memory pair ---
  const server = buildMcpServer(env, agent, {
    oauthTokenId: conn.tokenId, sessionId: sessionKey, origin: new URL(c.req.url).origin,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const responseP = new Promise<RpcMessage>((resolve) => {
    // Notifications (no id) are dropped by design — see module docs.
    clientT.onmessage = (m) => {
      const rm = m as RpcMessage;
      if (rm && rm.id !== undefined && ('result' in rm || 'error' in rm)) resolve(rm);
    };
  });
  try {
    await server.connect(serverT);
    await clientT.start();
    await clientT.send({ jsonrpc: '2.0', id, method, params: msg.params } as never);
    const resp = await responseP;

    if (resp.error) {
      // 2026-07-28 forbids the legacy resource-not-found code; it is Invalid Params now.
      const code = resp.error.code === LEGACY_RESOURCE_NOT_FOUND ? INVALID_PARAMS : resp.error.code;
      const status = code === METHOD_NOT_FOUND ? 404
        : code === INVALID_PARAMS || code === INVALID_REQUEST || code === PARSE_ERROR ? 400
        : 200;
      return rpcError(status, id, code, resp.error.message ?? 'error', resp.error.data);
    }
    const result = (resp.result ?? {}) as Record<string, unknown>;
    result.resultType ??= 'complete';
    result._meta = {
      ...(result._meta as Record<string, unknown> ?? {}),
      [META_SERVER_INFO]: serverInfoForAgent(),
    };
    const ttl = CACHE_TTLS[method];
    if (ttl !== undefined) {
      result.ttlMs ??= ttl;
      result.cacheScope ??= 'private';
    }
    return c.json({ jsonrpc: '2.0' as const, id, result }, 200);
  } finally {
    await server.close().catch(() => {});
    await clientT.close().catch(() => {});
  }
}
