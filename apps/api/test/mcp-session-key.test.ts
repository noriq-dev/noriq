import { describe, expect, it, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createAgent, mcpCall } from './helpers';
import {
  isGrokCliUserAgent,
  resolveCopilotSessionKey,
} from '../src/lib/mcp-session-key';

describe('resolveCopilotSessionKey (PLNR-552)', () => {
  const tokenId = 'oat_testtoken';
  const mint = () => 'minted-uuid';

  it('openai/session wins over grok meta and both headers', () => {
    const r = resolveCopilotSessionKey({
      messages: [{ params: { _meta: { 'openai/session': 'oa', 'grok/session': 'gk' } } }],
      mcpSessionId: 'mcp-id',
      xMcpSessionId: 'x-id',
      tokenId,
    });
    expect(r).toEqual({ key: 'openai:oa', source: 'openai-meta' });
  });

  it('grok/session wins over both headers', () => {
    const r = resolveCopilotSessionKey({
      messages: [{ params: { _meta: { 'grok/session': 'conv-1' } } }],
      mcpSessionId: 'mcp-id',
      xMcpSessionId: 'x-id',
      tokenId,
    });
    expect(r).toEqual({ key: 'grok:conv-1', source: 'grok-meta' });
  });

  it('Mcp-Session-Id wins over x-mcp-session-id', () => {
    const r = resolveCopilotSessionKey({
      mcpSessionId: 'transport-A',
      xMcpSessionId: 'conversation-B',
      tokenId,
    });
    expect(r).toEqual({ key: 'transport-A', source: 'mcp-session-id' });
  });

  it('x-mcp-session-id maps to the same grok: prefix as grok/session', () => {
    const fromHeader = resolveCopilotSessionKey({ xMcpSessionId: 'conv-1', tokenId });
    const fromMeta = resolveCopilotSessionKey({
      messages: [{ params: { _meta: { 'grok/session': 'conv-1' } } }],
      tokenId,
    });
    expect(fromHeader).toEqual({ key: 'grok:conv-1', source: 'x-mcp-session-id' });
    expect(fromMeta.key).toBe(fromHeader.key);
  });

  it('non-Grok initialize without a session key mints a UUID', () => {
    const r = resolveCopilotSessionKey({
      tokenId, isInitialize: true, mint, userAgent: 'claude-code/1.0',
    });
    expect(r).toEqual({ key: 'minted-uuid', source: 'mint' });
  });

  it('Grok initialize without a session key uses the token', () => {
    const r = resolveCopilotSessionKey({
      tokenId, isInitialize: true, mint, userAgent: 'grok-cli/1.0.13',
    });
    expect(r).toEqual({ key: `stateless:${tokenId}`, source: 'stateless-token' });
  });

  it('sessionless tools/call uses the token even without a Grok User-Agent', () => {
    const r = resolveCopilotSessionKey({ tokenId, isInitialize: false, mint });
    expect(r).toEqual({ key: `stateless:${tokenId}`, source: 'stateless-token' });
  });

  it('isGrokCliUserAgent matches grok-cli and grok-cli/<version>', () => {
    expect(isGrokCliUserAgent('grok-cli/1.0.13')).toBe(true);
    expect(isGrokCliUserAgent('grok-cli')).toBe(true);
    expect(isGrokCliUserAgent('Grok-CLI/2')).toBe(true);
    expect(isGrokCliUserAgent('claude-code/1.0')).toBe(false);
    expect(isGrokCliUserAgent('not-grok-cli/1')).toBe(false);
    expect(isGrokCliUserAgent(undefined)).toBe(false);
  });
});

describe('legacy MCP identity (PLNR-552)', () => {
  let apiKey: string;

  beforeAll(async () => {
    ({ apiKey } = await createAgent('session-key-legacy') as unknown as { apiKey: string });
  }, 60_000);

  async function briefing(headers: Record<string, string> = {}, meta?: Record<string, unknown>) {
    const r = await mcpCall(apiKey, 'get_briefing', {}, headers['Mcp-Session-Id'], meta);
    return r.body.you.id as string;
  }

  async function briefingRaw(headers: Record<string, string>, meta?: Record<string, unknown>) {
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_briefing', arguments: {}, ...(meta ? { _meta: meta } : {}) },
      }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const dataLine = raw.split('\n').filter((l) => l.startsWith('data:')).at(-1)?.slice(5).trim() ?? raw;
    const message = JSON.parse(dataLine);
    const text: string = message.result?.content?.[0]?.text ?? '';
    return JSON.parse(text.split('\n\n--- notices ---\n')[0] ?? '').you.id as string;
  }

  it('two calls with the same x-mcp-session-id and no Mcp-Session-Id are one copilot', async () => {
    const a = await briefingRaw({ 'x-mcp-session-id': 'grok-conv-stable' });
    const b = await briefingRaw({ 'x-mcp-session-id': 'grok-conv-stable' });
    const other = await briefingRaw({ 'x-mcp-session-id': 'grok-conv-other' });
    expect(a).toBe(b);
    expect(other).not.toBe(a);
  });

  it('Mcp-Session-Id wins over x-mcp-session-id when both are present', async () => {
    const viaMcp = await briefingRaw({
      'Mcp-Session-Id': 'prefer-mcp',
      'x-mcp-session-id': 'ignore-x',
    });
    const viaMcpAgain = await briefing({ 'Mcp-Session-Id': 'prefer-mcp' });
    const viaX = await briefingRaw({ 'x-mcp-session-id': 'ignore-x' });
    expect(viaMcp).toBe(viaMcpAgain);
    expect(viaX).not.toBe(viaMcp);
  });

  it('openai/session still wins over both headers', async () => {
    const a = await briefingRaw(
      { 'Mcp-Session-Id': 'transport-1', 'x-mcp-session-id': 'x-1' },
      { 'openai/session': 'oa-stable' },
    );
    const b = await briefingRaw(
      { 'Mcp-Session-Id': 'transport-2', 'x-mcp-session-id': 'x-2' },
      { 'openai/session': 'oa-stable' },
    );
    expect(a).toBe(b);
  });

  it('grok/session shares the grok: prefix with x-mcp-session-id', async () => {
    const fromMeta = await briefingRaw({}, { 'grok/session': 'same-conv' });
    const fromHeader = await briefingRaw({ 'x-mcp-session-id': 'same-conv' });
    expect(fromMeta).toBe(fromHeader);
  });

  it('sessionless tools/call uses a token-stable copilot', async () => {
    const a = await briefingRaw({});
    const b = await briefingRaw({});
    expect(a).toBe(b);
  });

  it('Grok User-Agent initialize without a session header reuses stateless:{tokenId}', async () => {
    const init = async () => {
      const res = await SELF.fetch('https://noriq.test/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'User-Agent': 'grok-cli/1.0.13',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'grok-cli', version: '1.0.13' } },
        }),
      });
      return res.headers.get('Mcp-Session-Id');
    };
    const first = await init();
    const second = await init();
    expect(first).toMatch(/^stateless:/);
    expect(second).toBe(first);
  });

  it('non-Grok initialize without a session header mints distinct copilots', async () => {
    const init = async () => {
      const res = await SELF.fetch('https://noriq.test/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } },
        }),
      });
      return res.headers.get('Mcp-Session-Id');
    };
    const first = await init();
    const second = await init();
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toMatch(/^stateless:/);
    expect(second).not.toBe(first);
  });

  it('CORS allows the x-mcp-session-id request header', async () => {
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-mcp-session-id',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Headers') ?? '').toMatch(/x-mcp-session-id/i);
  });
});
