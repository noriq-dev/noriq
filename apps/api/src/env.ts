import type { ProjectRoom } from './do/ProjectRoom';
import type { AgentSession } from './do/AgentSession';
import type { RateLimiter } from './do/RateLimiter';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PROJECT_ROOM: DurableObjectNamespace<ProjectRoom>;
  AGENT_SESSION: DurableObjectNamespace<AgentSession>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  /** Set in tests to bypass rate limiting. */
  DISABLE_RATE_LIMIT?: boolean;
  /** Bootstrap secret for issuing agent keys / creating users. Set via `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN?: string;
  /** Optional shared secret for GitHub webhook signature verification. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Cloudflare Email Service binding — optional; invites fall back to copyable links. */
  EMAIL?: { send(msg: { to: string; from: { email: string; name?: string }; subject: string; text: string; html?: string }): Promise<unknown> };
  /** From-address for transactional email (must be on an onboarded sending domain). */
  EMAIL_FROM?: string;
  /** Task attachments — optional; endpoints 503 until R2 is enabled + bound. */
  FILES?: R2Bucket;
}
