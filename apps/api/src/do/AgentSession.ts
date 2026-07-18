import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

/**
 * AgentSession — one instance per agent (idFromName(agentId)).
 *
 * Holds the agent's server-side sync state so `my_updates` needs zero client
 * state (ROADMAP §5 Phase 1):
 *  - lastEventRowid: global events.global_seq cursor (auto-advances on delivery; no
 *    ack). Named "rowid" for history; it now tracks the reuse-proof global_seq (PLNR-111).
 *  - lastSeenAt: presence.
 *
 * Open comments are intentionally NOT tracked here — they are state, not events,
 * and stay sticky in every briefing until actually resolved.
 */
export class AgentSession extends DurableObject<Env> {
  async touch(): Promise<string> {
    const at = new Date().toISOString();
    await this.ctx.storage.put('lastSeenAt', at);
    return at;
  }

  async lastSeen(): Promise<string | null> {
    return (await this.ctx.storage.get<string>('lastSeenAt')) ?? null;
  }

  /** Read the delivery cursor and advance it (no-ack model). */
  async advanceCursor(to: number): Promise<void> {
    await this.ctx.storage.put('lastEventRowid', to);
  }

  async cursor(): Promise<number> {
    return (await this.ctx.storage.get<number>('lastEventRowid')) ?? 0;
  }
}
