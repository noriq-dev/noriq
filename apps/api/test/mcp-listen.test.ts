import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createAgent, mcpCall } from './helpers';

/**
 * subscriptions/listen — the 2026-07-28 long-lived change stream (PLNR-234).
 *
 * The stream must open with notifications/subscriptions/acknowledged carrying the honored
 * filter subset (types we can't fire — toolsListChanged — omitted; unreachable resource
 * URIs dropped), then deliver only opted-in change notifications, each tagged with the
 * listen request's id as _meta subscriptionId. Fed by the events log at LISTEN_POLL_MS
 * (150ms in tests, via vitest.workspace.ts).
 */

const V = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const SUB_ID = 'io.modelcontextprotocol/subscriptionId';

let rpcId = 7000;

async function openListen(apiKey: string, notifications: unknown) {
  const id = rpcId++;
  const res = await SELF.fetch('https://noriq.test/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'subscriptions/listen',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'subscriptions/listen',
      params: { notifications, _meta: { [V]: '2026-07-28', [CAPS]: {} } },
    }),
  });
  return { id, res };
}

/** Incremental SSE frame reader: `next()` resolves the next data frame (keepalive
 *  comments skipped), with a hard timeout so a silent stream fails the test, not the run. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sseFrames(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async next(timeoutMs = 8000): Promise<any> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const sep = buf.indexOf('\n\n');
        if (sep >= 0) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (chunk.startsWith('data:')) return JSON.parse(chunk.slice(5).trim());
          continue; // ':' keepalive comment
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('timed out waiting for an SSE frame');
        const read = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out waiting for an SSE frame')), remaining)),
        ]);
        if (read.done) throw new Error('SSE stream ended unexpectedly');
        buf += decoder.decode(read.value, { stream: true });
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

let apiKey: string;
let projectId: string;
let docId: string;

beforeAll(async () => {
  ({ apiKey } = await createAgent('listen-agent') as unknown as { apiKey: string });
  projectId = (await mcpCall(apiKey, 'create_project', { key: 'LSTN', name: 'listen-stream' })).body.id;
  const doc = await mcpCall(apiKey, 'create_doc', {
    projectId,
    name: 'Listen fixture doc',
    description: 'Fixture for subscriptions/listen tests',
    body: 'The listen stream polls the events log. This fact is settled.',
  });
  expect(doc.isError).toBe(false);
  docId = doc.body.id;
});

describe('subscriptions/listen', () => {
  it('acks only supported resource notifications, then streams list_changed and updated', async () => {
    const uri = `noriq://doc/${docId}`;
    const { id, res } = await openListen(apiKey, {
      toolsListChanged: true,
      resourcesListChanged: true,
      resourceSubscriptions: [uri, 'noriq://doc/does_not_exist', 'noriq://attachment/att_x'],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const frames = sseFrames(res);
    try {
      const ack = await frames.next();
      expect(ack.method).toBe('notifications/subscriptions/acknowledged');
      expect(ack.params.notifications.resourcesListChanged).toBe(true);
      expect(ack.params.notifications.resourceSubscriptions).toEqual([uri]);
      expect(ack.params.notifications).not.toHaveProperty('toolsListChanged');
      expect(ack.params._meta[SUB_ID]).toBe(id);

      // A new doc appearing → resources/list_changed.
      await mcpCall(apiKey, 'create_doc', {
        projectId,
        name: 'Second doc',
        description: 'Appears mid-stream',
        body: 'This doc exists to change the resource list. That is all it does.',
      });
      const changed = await frames.next();
      expect(changed.method).toBe('notifications/resources/list_changed');
      expect(changed.params._meta[SUB_ID]).toBe(id);

      // Editing the subscribed doc → resources/updated with its uri.
      await mcpCall(apiKey, 'update_doc', { projectId, docId, body: 'Edited. The stream reports doc edits. This fact is settled.' });
      const updated = await frames.next();
      expect(updated.method).toBe('notifications/resources/updated');
      expect(updated.params.uri).toBe(uri);
      expect(updated.params._meta[SUB_ID]).toBe(id);

    } finally {
      frames.cancel();
    }
  });

  it('missing notifications filter → 400 + -32602', async () => {
    const { res } = await openListen(apiKey, undefined);
    expect(res.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.error.code).toBe(-32602);
  });

  it('server/discover advertises resources.listChanged and resources.subscribe', async () => {
    const res = await SELF.fetch('https://noriq.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId++,
        method: 'server/discover',
        params: { _meta: { [V]: '2026-07-28', [CAPS]: {} } },
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.result.capabilities.resources.listChanged).toBe(true);
    expect(body.result.capabilities.resources.subscribe).toBe(true);
  });
});
