/**
 * Copilot session-key resolution (PLNR-552).
 *
 * Noriq's working identity is one session_copilot per key, not per OAuth token.
 * Clients disagree about what that key is:
 *  - Claude Code echoes `Mcp-Session-Id` from initialize (server-minted UUID).
 *  - OpenAI/Codex bridges mint a fresh transport session per tool call and carry
 *    the stable conversation id on `_meta["openai/session"]`.
 *  - Grok (rmcp streamable HTTP) also re-initializes per `use_tool`. It documents
 *    `x-mcp-session-id = "{{session_id}}"` as the conversation id, and may send
 *    `_meta["grok/session"]`. Unconfigured Grok sends neither, and is detected
 *    via `User-Agent: grok-cli/…`.
 *
 * Precedence (first match wins):
 *  1. `_meta["openai/session"]` → `openai:{id}`  (existing OpenAI contract)
 *  2. `_meta["grok/session"]`   → `grok:{id}`    (Grok first-class, same shape)
 *  3. `Mcp-Session-Id`          → as-is         (prefer the standard header)
 *  4. `x-mcp-session-id`        → `grok:{id}`    (Grok's documented fallback)
 *  5. `stateless:{tokenId}`     — last resort, except a non-Grok legacy
 *     `initialize` still mints a UUID so concurrent Claude chats stay distinct.
 */

export const OPENAI_SESSION_META = 'openai/session';
export const GROK_SESSION_META = 'grok/session';

export type CopilotSessionKeySource =
  | 'openai-meta'
  | 'grok-meta'
  | 'mcp-session-id'
  | 'x-mcp-session-id'
  | 'stateless-token'
  | 'mint';

export type CopilotSessionKey = {
  key: string;
  source: CopilotSessionKeySource;
};

export type RpcSessionMessage = {
  params?: { _meta?: Record<string, unknown> };
} | null | undefined;

export type ResolveCopilotSessionKeyInput = {
  messages?: RpcSessionMessage[];
  mcpSessionId?: string | null;
  xMcpSessionId?: string | null;
  tokenId: string;
  userAgent?: string | null;
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

export function resolveCopilotSessionKey(input: ResolveCopilotSessionKeyInput): CopilotSessionKey {
  const openai = firstMeta(input.messages, OPENAI_SESSION_META);
  if (openai) return { key: `openai:${openai}`, source: 'openai-meta' };

  const grok = firstMeta(input.messages, GROK_SESSION_META);
  if (grok) return { key: `grok:${grok}`, source: 'grok-meta' };

  const mcpSessionId = presented(input.mcpSessionId);
  if (mcpSessionId) return { key: mcpSessionId, source: 'mcp-session-id' };

  const xMcpSessionId = presented(input.xMcpSessionId);
  if (xMcpSessionId) return { key: `grok:${xMcpSessionId}`, source: 'x-mcp-session-id' };

  // Non-Grok initialize: mint a UUID and return it as Mcp-Session-Id so the client
  // can echo a per-chat identity (Claude Code). Grok re-inits without echoing, so a
  // UUID here would mint a new copilot on every tool call — fall through to the token.
  if (input.isInitialize && !isGrokCliUserAgent(input.userAgent)) {
    return { key: (input.mint ?? crypto.randomUUID.bind(crypto))(), source: 'mint' };
  }

  return { key: `stateless:${input.tokenId}`, source: 'stateless-token' };
}
