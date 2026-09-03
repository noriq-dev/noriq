import { describe, expect, it, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createAgent, mintPairForUser, mcpCall } from './helpers';
import {
  isDurableCopilotKey,
  isGrokClient,
  isGrokClientName,
  isGrokCliUserAgent,
  isStablePresentedSessionId,
  resolveCopilotSessionKey,
} from '../src/lib/mcp-session-key';

describe('resolveCopilotSessionKey (PLNR-552)', () => {
  const tokenId = 'oat_testtoken';
  const mint = () => 'minted-uuid';

  it('openai/session wins over both headers', () => {
    const r = resolveCopilotSessionKey({
      messages: [{ params: { _meta: { 'openai/session': 'oa' } } }],
      mcpSessionId: 'mcp-id',
      xMcpSessionId: 'x-id',
      tokenId,
    });
    expect(r).toEqual({ key: 'openai:oa', source: 'openai-meta' });
  });

  it('ignores _meta grok/session (PLNR-558)', () => {
    const r = resolveCopilotSessionKey({
      messages: [{ params: { _meta: { 'grok/session': 'conv-1' } } }],
      mcpSessionId: 'mcp-id',
      xMcpSessionId: 'x-id',
      tokenId,
    });
    expect(r).toEqual({ key: 'mcp-id', source: 'mcp-session-id' });
  });

  it('Mcp-Session-Id wins over x-mcp-session-id', () => {
    const r = resolveCopilotSessionKey({
      mcpSessionId: 'transport-A',
      xMcpSessionId: 'conversation-B',
      tokenId,
    });
    expect(r).toEqual({ key: 'transport-A', source: 'mcp-session-id' });
  });

  it('x-mcp-session-id maps to grok:{id}', () => {
    expect(resolveCopilotSessionKey({ xMcpSessionId: 'conv-1', tokenId }))
      .toEqual({ key: 'grok:conv-1', source: 'x-mcp-session-id' });
  });

  it('Grok prefers x-mcp-session-id over an ephemeral Mcp-Session-Id (PLNR-558)', () => {
    const r = resolveCopilotSessionKey({
      tokenId, clientName: 'Grok',
      mcpSessionId: '840d6f65-9c29-4fa0-a79e-ab1005f6160a',
      xMcpSessionId: '01a0641d-5e3f-7600-8e44-5c6b68666b12',
    });
    expect(r).toEqual({
      key: 'grok:01a0641d-5e3f-7600-8e44-5c6b68666b12',
      source: 'x-mcp-session-id',
    });
    expect(isDurableCopilotKey(r.key)).toBe(true);
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

  it('isGrokClientName matches the TUI OAuth client and grok-cli clientInfo', () => {
    expect(isGrokClientName('Grok')).toBe(true);
    expect(isGrokClientName('grok-cli')).toBe(true);
    expect(isGrokClientName('Grok TUI')).toBe(true);
    expect(isGrokClientName('Grok/4.6')).toBe(true);
    expect(isGrokClientName('claude-code')).toBe(false);
    expect(isGrokClientName('agrok')).toBe(false);
    expect(isGrokClientName(undefined)).toBe(false);
  });

  it('OAuth clientName Grok initialize uses the token, not a minted UUID (PLNR-557)', () => {
    const r = resolveCopilotSessionKey({
      tokenId, isInitialize: true, mint, clientName: 'Grok',
    });
    expect(r).toEqual({ key: `stateless:${tokenId}`, source: 'stateless-token' });
  });

  it('initialize clientInfo.name Grok uses the token even without User-Agent or clientName', () => {
    const r = resolveCopilotSessionKey({
      tokenId, isInitialize: true, mint,
      messages: [{ params: { clientInfo: { name: 'Grok' } } }],
    });
    expect(r).toEqual({ key: `stateless:${tokenId}`, source: 'stateless-token' });
    expect(isGrokClient({ messages: [{ params: { clientInfo: { name: 'Grok' } } }] })).toBe(true);
  });

  it('Grok ignores an ephemeral Mcp-Session-Id UUID and still keys on the token', () => {
    const r = resolveCopilotSessionKey({
      tokenId, isInitialize: true, mint, clientName: 'Grok',
      mcpSessionId: '840d6f65-9c29-4fa0-a79e-ab1005f6160a',
    });
    expect(r).toEqual({ key: `stateless:${tokenId}`, source: 'stateless-token' });
  });

  it('Grok still honors a stable Mcp-Session-Id prefix (echo of our own key)', () => {
    const r = resolveCopilotSessionKey({
      tokenId, clientName: 'Grok', mcpSessionId: `stateless:${tokenId}`,
    });
    expect(r).toEqual({ key: `stateless:${tokenId}`, source: 'mcp-session-id' });
    expect(isStablePresentedSessionId(`stateless:${tokenId}`)).toBe(true);
    expect(isDurableCopilotKey(`stateless:${tokenId}`)).toBe(true);
    expect(isDurableCopilotKey('grok:conv-1')).toBe(true);
    expect(isDurableCopilotKey('openai:oa')).toBe(false);
    expect(isStablePresentedSessionId('840d6f65-9c29-4fa0-a79e-ab1005f6160a')).toBe(false);
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

  it('_meta grok/session does not share identity with x-mcp-session-id (PLNR-558)', async () => {
    const fromMeta = await briefingRaw({}, { 'grok/session': 'same-conv' });
    const fromHeader = await briefingRaw({ 'x-mcp-session-id': 'same-conv' });
    expect(fromMeta).not.toBe(fromHeader);
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

describe('Grok TUI OAuth client identity (PLNR-557)', () => {
  let grokToken: string;

  beforeAll(async () => {
    grokToken = (await mintPairForUser('grok-tui-557@example.com', 'longenough1', 'Grok')).access;
  }, 60_000);

  async function grokInit(headers: Record<string, string> = {}) {
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grokToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Grok', version: '4.6' } },
      }),
    });
    expect(res.status).toBe(200);
    return res.headers.get('Mcp-Session-Id');
  }

  async function grokBriefing(headers: Record<string, string> = {}) {
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grokToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_briefing', arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const dataLine = raw.split('\n').filter((l) => l.startsWith('data:')).at(-1)?.slice(5).trim() ?? raw;
    const text: string = JSON.parse(dataLine).result?.content?.[0]?.text ?? '';
    return JSON.parse(text.split('\n\n--- notices ---\n')[0] ?? '').you.id as string;
  }

  it('two initializes with OAuth clientName Grok share one copilot', async () => {
    const first = await grokInit();
    const second = await grokInit();
    expect(first).toMatch(/^stateless:/);
    expect(second).toBe(first);
    const a = await grokBriefing();
    const b = await grokBriefing();
    expect(a).toBe(b);
  });

  it('a random Mcp-Session-Id UUID still keys as stateless:{tokenId}', async () => {
    const ephemeral = crypto.randomUUID();
    const session = await grokInit({ 'Mcp-Session-Id': ephemeral });
    expect(session).toMatch(/^stateless:/);
    expect(session).not.toBe(ephemeral);
    const viaUuid = await grokBriefing({ 'Mcp-Session-Id': ephemeral });
    const viaNone = await grokBriefing();
    expect(viaUuid).toBe(viaNone);
  });

  it('DELETE /mcp of that session returns 204 and the next call is the same agent', async () => {
    const id = await grokBriefing();
    const ended = await SELF.fetch('https://noriq.test/mcp', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${grokToken}`,
        'Mcp-Session-Id': crypto.randomUUID(),
      },
    });
    expect(ended.status).toBe(204);
    expect(await grokBriefing()).toBe(id);
    const row = await (env as unknown as { DB: D1Database }).DB.prepare(
      'SELECT retired_at AS retiredAt FROM agents WHERE id = ?',
    ).bind(id).first<{ retiredAt: string | null }>();
    expect(row?.retiredAt).toBeNull();
  });

  it('two x-mcp-session-id values are two copilots (PLNR-558)', async () => {
    const a = await grokBriefing({ 'x-mcp-session-id': 'tui-session-a' });
    const b = await grokBriefing({ 'x-mcp-session-id': 'tui-session-b' });
    const aAgain = await grokBriefing({ 'x-mcp-session-id': 'tui-session-a' });
    expect(a).not.toBe(b);
    expect(aAgain).toBe(a);
  });

  it('DELETE /mcp of a grok: session is a no-op and the next call is the same agent', async () => {
    const id = await grokBriefing({ 'x-mcp-session-id': 'tui-durable' });
    const ended = await SELF.fetch('https://noriq.test/mcp', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${grokToken}`,
        'User-Agent': 'grok-cli/1.0.13',
        'x-mcp-session-id': 'tui-durable',
        'Mcp-Session-Id': crypto.randomUUID(),
      },
    });
    expect(ended.status).toBe(204);
    expect(await grokBriefing({ 'x-mcp-session-id': 'tui-durable' })).toBe(id);
    const row = await (env as unknown as { DB: D1Database }).DB.prepare(
      'SELECT retired_at AS retiredAt, session_id AS sessionId FROM agents WHERE id = ?',
    ).bind(id).first<{ retiredAt: string | null; sessionId: string }>();
    expect(row?.retiredAt).toBeNull();
    expect(row?.sessionId).toBe('grok:tui-durable');
  });

  it('resumes a client_terminated stateless copilot instead of 401ing', async () => {
    const id = await grokBriefing();
    const db = (env as unknown as { DB: D1Database }).DB;
    await db.prepare(
      `UPDATE agents SET status = 'offline', retired_at = ?, retire_reason = 'client_terminated' WHERE id = ?`,
    ).bind(new Date().toISOString(), id).run();
    expect(await grokBriefing()).toBe(id);
    const row = await db.prepare(
      'SELECT retired_at AS retiredAt, status FROM agents WHERE id = ?',
    ).bind(id).first<{ retiredAt: string | null; status: string }>();
    expect(row?.retiredAt).toBeNull();
    expect(row?.status).toBe('active');
  });

  it('stateless Grok claim does not pin project_id (PLNR-558)', async () => {
    const grokCall = async (name: string, args: Record<string, unknown>) => {
      const res = await SELF.fetch('https://noriq.test/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${grokToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
        }),
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      const dataLine = raw.split('\n').filter((l) => l.startsWith('data:')).at(-1)?.slice(5).trim() ?? raw;
      const parsed = JSON.parse(dataLine);
      expect(parsed.result?.isError).not.toBe(true);
      const text: string = parsed.result?.content?.[0]?.text ?? '';
      return JSON.parse(text.split('\n\n--- notices ---\n')[0] ?? '');
    };
    const project = await grokCall('create_project', { key: 'GNS', name: 'grok-unscoped' });
    const created = await grokCall('create_tasks', {
      projectId: project.id, allowNewTags: true,
      tasks: [{ title: 'unscoped-hold', tags: ['backend'] }],
    });
    const taskId = created.created[0].id as string;
    await grokCall('claim_task', { projectId: project.id, taskId });
    const you = (await grokCall('get_briefing', {})).you.id as string;
    const row = await (env as unknown as { DB: D1Database }).DB.prepare(
      'SELECT project_id AS projectId, session_id AS sessionId FROM agents WHERE id = ?',
    ).bind(you).first<{ projectId: string | null; sessionId: string }>();
    expect(row?.sessionId.startsWith('stateless:')).toBe(true);
    expect(row?.projectId).toBeNull();
  });
});
