import type { ProjectRoom } from './do/ProjectRoom';
import type { AgentSession } from './do/AgentSession';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PROJECT_ROOM: DurableObjectNamespace<ProjectRoom>;
  AGENT_SESSION: DurableObjectNamespace<AgentSession>;
  /** Bootstrap secret for issuing agent keys / creating users. Set via `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN?: string;
  /** Optional shared secret for GitHub webhook signature verification. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Cloudflare Email Service binding — optional; invites fall back to copyable links. */
  EMAIL?: { send(msg: { to: string; from: { email: string; name?: string }; subject: string; text: string; html?: string }): Promise<unknown> };
  /** From-address for transactional email (must be on an onboarded sending domain). */
  EMAIL_FROM?: string;
}
