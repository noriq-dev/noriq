import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

/**
 * Deterministic fixed-window rate limiter (PLNR-18). One instance per bucket
 * key (idFromName), so counting is exact and serialized — unlike the native
 * Rate Limiting binding, which is approximate/per-colo and can't be asserted.
 * No external dependency, so self-hosters get real limits out of the box.
 */
export class RateLimiter extends DurableObject<Env> {
  async hit(limit: number, windowMs: number): Promise<{ ok: boolean; retryAfter: number }> {
    const now = Date.now();
    const win = (await this.ctx.storage.get<{ start: number; count: number }>('w')) ?? { start: now, count: 0 };
    if (now - win.start >= windowMs) {
      win.start = now;
      win.count = 0;
    }
    win.count += 1;
    await this.ctx.storage.put('w', win);
    const ok = win.count <= limit;
    return { ok, retryAfter: ok ? 0 : Math.ceil((win.start + windowMs - now) / 1000) };
  }
}
