import type { ProjectRoom } from './do/ProjectRoom';
import type { AgentSession } from './do/AgentSession';
import type { RateLimiter } from './do/RateLimiter';
import type { RunnerHub } from './do/RunnerHub';
import type { ProjectMemory } from './do/ProjectMemory';
import type { AskGeneration } from './do/AskGeneration';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PROJECT_ROOM: DurableObjectNamespace<ProjectRoom>;
  AGENT_SESSION: DurableObjectNamespace<AgentSession>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  RUNNER_HUB: DurableObjectNamespace<RunnerHub>;
  /** ProjectMemory (PLNR-245) — one per project (idFromName(projectId)), canonical writer/
   *  query authority for cognitive memory. Separate from PROJECT_ROOM by design (§2, §19). */
  PROJECT_MEMORY: DurableObjectNamespace<ProjectMemory>;
  /** One alarm-backed Durable Object per Ask response. It owns inference independently of any
   * browser stream, while D1 remains the reconnectable/cancellable generation record. */
  ASK_GENERATION: DurableObjectNamespace<AskGeneration>;
  /** Set in tests to bypass rate limiting. */
  DISABLE_RATE_LIMIT?: boolean;
  /** Poll interval (ms) for the subscriptions/listen event stream (PLNR-234).
   *  Default 5000; tests set it low so change notifications arrive within a tick. */
  LISTEN_POLL_MS?: string;
  /** Optional coordinated catalog-cutover floor, e.g. 0.16.0. */
  MIN_RUNNER_CATALOG_VERSION?: string;
  /** Poll cadence for reconnectable Ask SSE followers. Primarily lowered by tests. */
  ASK_STREAM_POLL_MS?: string;
  /** Maximum generated tokens for an Ask answer. Parsed and clamped by askOutputTokenLimit. */
  ASK_MAX_OUTPUT_TOKENS?: string;
  /** JSON array of server-allowlisted Ask models. Invalid explicit configuration fails closed. */
  ASK_MODELS?: string;
  /** Model id from ASK_MODELS used when the client does not select one. */
  ASK_DEFAULT_MODEL?: string;
  /** Actor lifecycle policy overrides (PLNR-363). All numeric values are validated and capped;
   * scheduled mutation remains off unless AGENT_LIFECYCLE_SWEEP_APPLY is explicitly truthy. */
  AGENT_LIFECYCLE_ONLINE_SECONDS?: string;
  AGENT_COPILOT_RETIRE_DAYS?: string;
  AGENT_HISTORY_ARCHIVE_DAYS?: string;
  AGENT_PRESENCE_PURGE_DAYS?: string;
  RUNNER_OFFLINE_ARCHIVE_DAYS?: string;
  AGENT_LIFECYCLE_SWEEP_BATCH?: string;
  AGENT_LIFECYCLE_SWEEP_APPLY?: string;
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
  /** SEPARATE code-intelligence Vectorize index (PLNR-256, §9) — files, symbols, APIs, tests,
   *  configuration/schema entities, and repository docs. Deliberately its own index, not a
   *  `kind` partition of `noriq-search`: it churns on every repository reindex, is wholly
   *  rebuildable from repositories, and may later use a code-specialized embedding model —
   *  none of which is true of authored memory. Optional: without it (or `AI`), code retrieval
   *  degrades to lexical + graph (§20); reindexing code never touches an operational memory/
   *  episode vector either way (see memory/code-index.ts). Create with
   *  `wrangler vectorize create noriq-code --dimensions=1024 --metric=cosine` and ALL THREE
   *  metadata indexes the adapter filters on (queryCodeIndex filters server-side on
   *  `repositoryKey` too, PLNR-262 — an unprovisioned property passes every test against the
   *  fake store here but is rejected or silently ignored by a REAL Vectorize index):
   *  `wrangler vectorize create-metadata-index noriq-code --property-name=projectId --type=string`
   *  `wrangler vectorize create-metadata-index noriq-code --property-name=repositoryKey --type=string`
   *  `wrangler vectorize create-metadata-index noriq-code --property-name=generationId --type=string`. */
  CODE_VECTORIZE?: VectorizeIndex;
  /** HMAC key for signing agent attachment-upload capability tokens (PLNR-173). Optional:
   *  falls back to ADMIN_TOKEN, so an instance with an admin token already supports agent
   *  uploads with no extra config. If neither is set, attach_files upload mode is disabled
   *  and agents fall back to inline attach_files for small files. */
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
  /** Write-freeze / maintenance mode (PLNR-166): any truthy value ('1'/'true') pauses all
   *  writes so no `ok` is acknowledged into a database about to be swapped out during a
   *  cutover (the PLNR-164 incident). Reads stay live. Flip it on before a `d1 export`,
   *  clear it after the repoint. Lives OUTSIDE the DB deliberately — the flag must not
   *  depend on the thing being cut over. See lib/maintenance.ts. */
  MAINTENANCE_MODE?: string;
}
