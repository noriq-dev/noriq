/**
 * Copilot session-key resolution (PLNR-552, PLNR-557, PLNR-558, PLNR-569).
 *
 * Noriq's working identity is one session_copilot per key, not per OAuth token.
 * Clients disagree about what that key is:
 *  - Claude Code echoes `Mcp-Session-Id` from initialize (server-minted UUID).
 *  - OpenAI/Codex bridges mint a fresh transport session per tool call and carry
 *    the stable conversation id on `_meta["openai/session"]`.
 *  - Cursor (IDE + Cloud Agents) should bind to `cursor:{bcId}` via
 *    `_meta["cursor/agent"]` or `x-cursor-agent-id` when available; otherwise
 *    `stateless:{tokenId}` — never a per-initialize UUID mint.
 *  - Grok (rmcp streamable HTTP, both `grok-cli` and the TUI whose OAuth client
 *    is named `Grok`) re-initializes per `use_tool` and DELETE's the transport
 *    session after. The TUI conversation id is `x-mcp-session-id` (config
 *    `headers = { "x-mcp-session-id" = "{{session_id}}" }`). Unconfigured Grok
 *    sends a fresh UUID `Mcp-Session-Id` that is NOT a conversation id.
 *    Detected via User-Agent `grok-cli/…`, OAuth `clientName`, or initialize
 *    `clientInfo.name`.
 *
 * Precedence (first match wins):
 *  1. `_meta["openai/session"]` → `openai:{id}`  (existing OpenAI contract)
 *  2. `_meta["cursor/agent"]` or `x-cursor-agent-id` → `cursor:{id}`
 *  3. Grok `x-mcp-session-id`   → `grok:{id}`    (TUI session, preferred over
 *     the transport UUID)
 *  4. `Mcp-Session-Id`          → as-is, except Grok/Cursor ignore an ephemeral UUID
 *     (keep `stateless:` / `grok:` / `openai:` / `cursor:` prefixes)
 *  5. non-Grok `x-mcp-session-id` → `grok:{id}`
 *  6. `stateless:{tokenId}`     — last resort, except a non-Grok/non-Cursor legacy
 *     `initialize` still mints a UUID so concurrent Claude chats stay distinct.
 *
 * DELETE `/mcp` of a `stateless:`, `grok:`, or `cursor:` key is a 204 no-op: Grok's
 * transport teardown is not the end of the copilot. Claude UUID-keyed DELETE
 * still retires. A `stateless:` copilot is all-projects (never pinned).
 */

export const OPENAI_SESSION_META = 'openai/session';
export const CURSOR_AGENT_META = 'cursor/agent';

export type CopilotSessionKeySource =
  | 'openai-meta'
  | 'cursor-agent'
  | 'mcp-session-id'
  | 'x-mcp-session-id'
  | 'stateless-token'
  | 'mint';

export type CopilotSessionKey = {
  key: string;
  source: CopilotSessionKeySource;
};

export type RpcSessionMessage = {
  params?: { _meta?: Record<string, unknown>; clientInfo?: { name?: unknown } };
} | null | undefined;

export type ResolveCopilotSessionKeyInput = {
  messages?: RpcSessionMessage[];
  mcpSessionId?: string | null;
  xMcpSessionId?: string | null;
  /** Cursor Cloud Agent id (`bc-…`) when the client supplies it (PLNR-569). */
  xCursorAgentId?: string | null;
  tokenId: string;
  userAgent?: string | null;
  /** OAuth client name (`oauth_clients.name`) — the Grok TUI registers as `Grok`. */
  clientName?: string | null;
  /** Legacy `initialize` handshake. Unused on the 2026-07-28 path. */
  isInitialize?: boolean;
  /** Injected in tests; defaults to `crypto.randomUUID`. */
  mint?: () => string;
};

function presented(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstMeta(messages: RpcSessionMessage[] | undefined, key: string): string | undefined {
  if (!messages) return undefined;
  for (const message of messages) {
    const value = message?.params?._meta?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Grok CLI's default User-Agent is `grok-cli/<version>` (bare `grok-cli` also matches). */
export function isGrokCliUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return /^grok-cli(?:\/|\s|$)/i.test(userAgent.trim());
}

/** OAuth `client_name` / initialize `clientInfo.name` for Grok CLI and the Grok TUI. */
export function isGrokClientName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return n === 'grok' || n.startsWith('grok-') || n.startsWith('grok ') || n.startsWith('grok/');
}

function clientInfoName(messages: RpcSessionMessage[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (const message of messages) {
    const name = message?.params?.clientInfo?.name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return undefined;
}

/** True when this request is from grok-cli or the Grok TUI (OAuth client / clientInfo `Grok`). */
export function isGrokClient(input: Pick<ResolveCopilotSessionKeyInput, 'userAgent' | 'clientName' | 'messages'>): boolean {
  return isGrokCliUserAgent(input.userAgent)
    || isGrokClientName(input.clientName)
    || isGrokClientName(clientInfoName(input.messages));
}

/** Cursor IDE / Cloud Agent MCP clients (not grok-cli). */
export function isCursorClientName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return n === 'cursor' || n.startsWith('cursor-') || n.startsWith('cursor ') || n.startsWith('cursor/');
}

export function isCursorUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const ua = userAgent.trim();
  if (isGrokCliUserAgent(ua)) return false;
  return /\bcursor\b/i.test(ua) || /^cursor(?:\/|\s|$)/i.test(ua);
}

export function isCursorClient(input: Pick<ResolveCopilotSessionKeyInput, 'userAgent' | 'clientName' | 'messages'>): boolean {
  return isCursorUserAgent(input.userAgent)
    || isCursorClientName(input.clientName)
    || isCursorClientName(clientInfoName(input.messages));
}

/** Prefixes that are conversation-stable, not a per-call transport UUID. */
export function isStablePresentedSessionId(id: string): boolean {
  return id.startsWith('stateless:') || id.startsWith('grok:') || id.startsWith('openai:') || id.startsWith('cursor:');
}

/** Token-keyed, Grok-session, and Cursor-agent copilots survive transport DELETE `/mcp`. */
export function isDurableCopilotKey(key: string): boolean {
  return key.startsWith('stateless:') || key.startsWith('grok:') || key.startsWith('cursor:');
}

export function resolveCopilotSessionKey(input: ResolveCopilotSessionKeyInput): CopilotSessionKey {
  const grok = isGrokClient(input);
  const cursor = isCursorClient(input);

  const openai = firstMeta(input.messages, OPENAI_SESSION_META);
  if (openai) return { key: `openai:${openai}`, source: 'openai-meta' };

  const cursorAgent = firstMeta(input.messages, CURSOR_AGENT_META) ?? presented(input.xCursorAgentId);
  if (cursorAgent) return { key: `cursor:${cursorAgent}`, source: 'cursor-agent' };

  const xMcpSessionId = presented(input.xMcpSessionId);
  // Grok's conversation id is x-mcp-session-id (TUI `{{session_id}}`). Prefer it over
  // Mcp-Session-Id, which is a per-call transport UUID (PLNR-558).
  if (grok && xMcpSessionId) return { key: `grok:${xMcpSessionId}`, source: 'x-mcp-session-id' };

  const mcpSessionId = presented(input.mcpSessionId);
  const transportEphemeral = (grok || cursor) && mcpSessionId && !isStablePresentedSessionId(mcpSessionId);
  // Grok's Mcp-Session-Id is a transport UUID (re-minted per use_tool). Preferring it
  // over the token is what made PLNR-552 a no-op for the TUI (PLNR-557). Cursor can
  // behave similarly — honor only stable echoed keys (PLNR-569).
  if (mcpSessionId && !transportEphemeral) {
    return { key: mcpSessionId, source: 'mcp-session-id' };
  }

  if (xMcpSessionId) return { key: `grok:${xMcpSessionId}`, source: 'x-mcp-session-id' };

  // Non-Grok/non-Cursor initialize: mint a UUID and return it as Mcp-Session-Id so the client
  // can echo a per-chat identity (Claude Code). Grok and Cursor re-init without echoing a
  // stable id — fall through to the token (Grok) or token / cursor meta (Cursor).
  if (input.isInitialize && !grok && !cursor) {
    return { key: (input.mint ?? crypto.randomUUID.bind(crypto))(), source: 'mint' };
  }

  return { key: `stateless:${input.tokenId}`, source: 'stateless-token' };
}
