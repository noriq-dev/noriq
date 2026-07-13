import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

/**
 * AgentSession — one instance per agent (idFromName(agentId)).
 *
 * Tracks presence (last heartbeat) and holds the agent's message inbox
 * pointer. Phase 1 fills this in.
 */
export class AgentSession extends DurableObject<Env> {
  async heartbeat(): Promise<{ ok: true; at: string }> {
    const at = new Date().toISOString();
    await this.ctx.storage.put('lastSeenAt', at);
    return { ok: true, at };
  }

  async lastSeen(): Promise<string | null> {
    return (await this.ctx.storage.get<string>('lastSeenAt')) ?? null;
  }
}
