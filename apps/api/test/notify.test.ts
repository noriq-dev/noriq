// PLNR-54: notices must be *pushed* as JSON-RPC notifications on the live POST SSE
// stream (relatedRequestId routing), not only piggybacked in the tool result text.
import { describe, expect, it, beforeAll } from 'vitest';
import { createAgent, mcpCall, mcpCallStream, authorizeForAllProjects } from './helpers';

let alice: { id: string; apiKey: string };
let bob: { id: string; apiKey: string };
let projectId: string;

beforeAll(async () => {
  alice = await createAgent('notify-alice');
  bob = await createAgent('notify-bob');
  const proj = await mcpCall(alice.apiKey, 'create_project', { key: 'NTFY', name: 'notify' });
  projectId = proj.body.id;
  // Scoping (RUN-38): these agents were minted before the project existed, so each token is
  // scoped to nothing and only the CREATOR gains the new project. A human would authorize them
  // for it — say so explicitly rather than let the old implicit "every token sees everything"
  // creep back in.
  await authorizeForAllProjects(alice.apiKey, bob.apiKey);

}, 60000);

describe('MCP live notifications', () => {
  it('a message to an agent arrives as a pushed notification on its next tool call', async () => {
    await mcpCall(alice.apiKey, 'send_message', { projectId, toAgentId: bob.id, body: 'ping from alice: check task 7' });

    // Bob makes a neutral tool call (get_project doesn't itself drain the cursor);
    // the pending notice should ride THIS call's SSE stream as a real notification.
    const { result, notifications } = await mcpCallStream(bob.apiKey, 'get_project', { projectId });
    expect(result).not.toBeNull();

    // Delivered as a real notification, not just buried in the result text.
    const channel = notifications.find((n) => n.method === 'notifications/claude/channel');
    const logging = notifications.find((n) => n.method === 'notifications/message');
    expect(channel ?? logging).toBeTruthy();

    const payload = JSON.stringify(channel?.params ?? logging?.params);
    expect(payload).toContain('ping from alice');
    // Correlated to noriq and the receiving agent.
    expect(payload).toContain('noriq');
  });

  it('no pending notices → no channel notification pushed', async () => {
    // The prior test's get_project already advanced Bob's cursor past the message,
    // so a clean call should push nothing.
    const { notifications } = await mcpCallStream(bob.apiKey, 'get_project', { projectId });
    const channel = notifications.find(
      (n) => n.method === 'notifications/claude/channel' || n.method === 'notifications/message',
    );
    expect(channel).toBeUndefined();
  });
});
