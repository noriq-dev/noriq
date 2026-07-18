import type { ProjectRoom } from './do/ProjectRoom';
import type { AgentSession } from './do/AgentSession';
import type { RateLimiter } from './do/RateLimiter';
import type { RunnerHub } from './do/RunnerHub';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PROJECT_ROOM: DurableObjectNamespace<ProjectRoom>;
  AGENT_SESSION: DurableObjectNamespace<AgentSession>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  RUNNER_HUB: DurableObjectNamespace<RunnerHub>;
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
  /** Workers AI (PLNR-184) — embeddings for semantic search. Optional: without it (or
   *  VECTORIZE) search degrades to keyword matching, nothing breaks. */
  AI?: Ai;
  /** Vectorize index for semantic search vectors (PLNR-184). Create with
   *  `wrangler vectorize create noriq-search --dimensions=1024 --metric=cosine` and add a
   *  metadata index: `wrangler vectorize create-metadata-index noriq-search --property-name=projectId --type=string`. */
  VECTORIZE?: VectorizeIndex;
  /** HMAC key for signing agent attachment-upload capability tokens (PLNR-173). Optional:
   *  falls back to ADMIN_TOKEN, so an instance with an admin token already supports agent
   *  uploads with no extra config. If neither is set, create_attachment_upload is disabled
   *  and agents fall back to inline add_attachment for small files. */
  ATTACHMENT_UPLOAD_SECRET?: string;
  /**
   * Optional CIMD (Client ID Metadata Document) trust policy: a comma-separated
   * allowlist of hostnames permitted as URL-formatted client_ids (e.g.
   * "chatgpt.com,claude.ai"). Unset = open server (any HTTPS client_id, still
   * SSRF-guarded). See PLNR-82.
   */
  CIMD_ALLOWED_HOSTS?: string;
  /** Out-of-band signal delivery (PLNR-120): POST target for blocking input_requests
   *  and critical alerts (Slack-compatible payload under `text`). Optional. */
  SIGNAL_WEBHOOK_URL?: string;
  /** HMAC-SHA256 secret for signing outbound signal webhooks (X-Noriq-Signature). */
  SIGNAL_WEBHOOK_SECRET?: string;
  /** Public URL of this instance (e.g. https://plan.example.com) — used for links in
   *  out-of-band notifications, where no request origin is available. Optional. */
  PUBLIC_ORIGIN?: string;
  /** Demo mode (PLNR-146): any truthy value enables one-click demo login + the nightly
   *  demo-project reset. Meant for a dedicated demo deployment, not production. */
  DEMO_MODE?: string;
}
