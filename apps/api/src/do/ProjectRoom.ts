import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

/**
 * ProjectRoom — one instance per project (idFromName(projectId)).
 *
 * The coordination authority (ROADMAP §3/§7):
 *  - SOLE WRITER of project-scoped rows in D1 — every mutation is serialized here.
 *  - Claim/lock arbiter: grants at most one live claim per task, TTL renewed by
 *    heartbeat, auto-requeue on expiry (alarm), dependency gating.
 *  - Live fanout: holds the WebSocket subscriber set (hibernation API) and
 *    pushes every event to UI + subscribed agents.
 *
 * Phase 1 fills this in; for now it accepts WS connections and echoes pings so
 * the wiring is verifiable end-to-end.
 */
export class ProjectRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      // Hibernation API: the DO can sleep between messages without dropping sockets.
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message !== 'string') return;
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch {
      // ignore malformed frames
    }
  }

  override async webSocketClose(ws: WebSocket) {
    ws.close();
  }

  /** Broadcast a serialized event to every connected socket. */
  broadcast(data: string) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // socket already gone; hibernation API cleans it up
      }
    }
  }
}
