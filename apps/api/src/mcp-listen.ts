import type { Context } from 'hono';
import type { Env } from './env';
import type { AppContext, Connection } from './auth';
import { USER_PROJECT_WHERE, tokenProjectWhere } from './lib/visibility';
import { nowIso } from './lib/util';

/**
 * `subscriptions/listen` — the 2026-07-28 long-lived change-notification stream (PLNR-234).
 *
 * The modern spec removed the standing HTTP GET stream and `resources/subscribe`; in their
 * place a client POSTs `subscriptions/listen` with an opt-in SubscriptionFilter and holds
 * the SSE response open. The server MUST acknowledge first (echoing only the subset of
 * types it agreed to honor), then send only opted-in notifications, each tagged with
 * `_meta["io.modelcontextprotocol/subscriptionId"]` = the listen request's JSON-RPC id.
 * The client closing the stream IS the cancellation signal (no notifications/cancelled
 * over HTTP), and because we never tear a subscription down first, the graceful
 * SubscriptionsListenResult close never needs sending.
 *
 * What we honor — and why only this:
 *  - `resourcesListChanged`: docs/attachments appearing or disappearing in any project
 *    this token can reach → `notifications/resources/list_changed`.
 *  - `resourceSubscriptions`: `noriq://doc/{id}` URIs (validated as reachable at open,
 *    the honored subset echoed in the ack) → `notifications/resources/updated` on edit.
 *    Attachment URIs are excluded: attachments are immutable, so `updated` can never
 *    fire and granting the subscription would be a promise that cannot be kept.
 *  - `toolsListChanged` and `promptsListChanged` remain unsupported because the deployed
 *    Copilot tool catalogue is stable and there are no prompts.
 *
 * Mechanics: the stream POLLS the per-project event log (`events`, verbs `doc.*` /
 * `attachment.*`) rather than wiring the ProjectRoom fanout into MCP — reads stay out of
 * the sole-writer DO, and a cheap indexed D1 query every few seconds converts to push at
 * the only place push matters: the client's end of the stream. The cursor is
 * (created_at, seen-ids-at-that-timestamp) so same-millisecond writes are neither
 * skipped nor duplicated. SSE comments keep intermediaries from idling the connection
 * out between events.
 */

const META_SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';
const DOC_URI_RE = /^noriq:\/\/doc\/([A-Za-z0-9_-]+)$/;
const CHANGE_VERBS = ['doc.created', 'doc.updated', 'doc.archived', 'doc.restored', 'doc.deleted', 'attachment.added', 'attachment.removed'];
/** Send an SSE comment after this many consecutive empty polls (~20s at the default poll). */
const KEEPALIVE_EVERY_POLLS = 4;
const MAX_EVENTS_PER_POLL = 200;

type SubscriptionFilter = {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
};

export async function handleSubscriptionsListen(
  c: Context<AppContext>,
  env: Env,
  conn: Connection,
  msg: { id: string | number; params?: Record<string, unknown> },
): Promise<Response> {
  const filter = msg.params?.notifications as SubscriptionFilter | undefined;
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    return c.json(
      { jsonrpc: '2.0' as const, id: msg.id, error: { code: -32602, message: 'subscriptions/listen requires a `notifications` SubscriptionFilter object' } },
      400,
    );
  }
  const wantListChanged = filter.resourcesListChanged === true;
  const requestedUris = Array.isArray(filter.resourceSubscriptions)
    ? filter.resourceSubscriptions.filter((u): u is string => typeof u === 'string')
    : [];

  // Validate subscribed URIs against what this token can actually reach, at open — the
  // ack's contract is "the subset the server agreed to honor", so an unreachable or
  // non-doc URI is dropped from it rather than silently never firing.
  const docIdsByUri = new Map<string, string>();
  for (const uri of requestedUris) {
    const m = DOC_URI_RE.exec(uri);
    if (m) docIdsByUri.set(uri, m[1]!);
  }
  const honoredUris: string[] = [];
  const watchedDocIds = new Map<string, string>(); // doc id → uri
  if (docIdsByUri.size > 0) {
    const ids = [...docIdsByUri.values()];
    const idSlots = ids.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await env.DB.prepare(
      `SELECT d.id FROM docs d JOIN projects p ON p.id = d.project_id
       WHERE d.id IN (${idSlots}) AND d.archived_at IS NULL AND ${USER_PROJECT_WHERE.replaceAll('?1', `?${ids.length + 1}`)}
         AND ${tokenProjectWhere(`?${ids.length + 2}`)}`,
    ).bind(...ids, conn.userId, conn.tokenId).all<{ id: string }>();
    const reachable = new Set(results.map((r) => r.id));
    for (const [uri, id] of docIdsByUri) {
      if (reachable.has(id)) {
        honoredUris.push(uri);
        watchedDocIds.set(id, uri);
      }
    }
  }

  const granted: SubscriptionFilter = {
    ...(wantListChanged ? { resourcesListChanged: true } : {}),
    ...(honoredUris.length > 0 ? { resourceSubscriptions: honoredUris } : {}),
  };
  const subMeta = { [META_SUBSCRIPTION_ID]: msg.id };
  const pollMs = Math.max(50, Number(env.LISTEN_POLL_MS ?? '5000') || 5000);
  const encoder = new TextEncoder();
  const frame = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  let stopped = false;
  const stop = () => { stopped = true; };
  // The client aborting the POST is the spec's cancellation signal for this request.
  c.req.raw.signal.addEventListener('abort', stop);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // MUST be the first message on the subscription: the ack, carrying the honored subset.
      controller.enqueue(frame({
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: { notifications: granted, _meta: subMeta },
      }));

      // Forward-looking cursor: the stream reports changes from open onward.
      let cursor = nowIso();
      let seenAtCursor = new Set<string>();
      let quietPolls = 0;

      const poll = async () => {
        if (stopped) { try { controller.close(); } catch { /* already closed */ } return; }
        try {
          // `>=` + the seen-id set: strictly `>` would skip a second write landing in the
          // same millisecond as the last one we reported.
          // Explicit ?N numbering throughout — the WHERE fragments use ?1, and mixing
          // anonymous ?s with numbered ones leans on SQLite index-assignment rules that
          // are easy to break by reordering the SQL.
          const verbSlots = CHANGE_VERBS.map((_, i) => `?${i + 3}`).join(',');
          const { results } = await env.DB.prepare(
            `SELECT e.id, e.verb, e.subject_id AS subjectId, e.created_at AS createdAt
             FROM events e JOIN projects p ON p.id = e.project_id
             WHERE e.created_at >= ?2 AND e.verb IN (${verbSlots})
               AND ${USER_PROJECT_WHERE} AND ${tokenProjectWhere(`?${CHANGE_VERBS.length + 3}`)}
             ORDER BY e.created_at LIMIT ${MAX_EVENTS_PER_POLL}`,
          ).bind(conn.userId, cursor, ...CHANGE_VERBS, conn.tokenId)
            .all<{ id: string; verb: string; subjectId: string; createdAt: string }>();

          const fresh = results.filter((e) => !seenAtCursor.has(e.id));
          let sentSomething = false;
          if (fresh.length > 0) {
            const last = fresh[fresh.length - 1]!;
            seenAtCursor = new Set(fresh.filter((e) => e.createdAt === last.createdAt).map((e) => e.id));
            cursor = last.createdAt;

            if (wantListChanged && fresh.some((e) => e.verb !== 'doc.updated')) {
              controller.enqueue(frame({
                jsonrpc: '2.0',
                method: 'notifications/resources/list_changed',
                params: { _meta: subMeta },
              }));
              sentSomething = true;
            }
            for (const e of fresh) {
              if (e.verb !== 'doc.updated') continue;
              const uri = watchedDocIds.get(e.subjectId);
              if (!uri) continue;
              controller.enqueue(frame({
                jsonrpc: '2.0',
                method: 'notifications/resources/updated',
                params: { uri, _meta: subMeta },
              }));
              sentSomething = true;
            }
          }
          if (sentSomething) {
            quietPolls = 0;
          } else if (++quietPolls >= KEEPALIVE_EVERY_POLLS) {
            quietPolls = 0;
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          }
        } catch {
          // Enqueue after client disconnect, or a transient D1 error — end the stream;
          // the client re-opens with a fresh listen (streams are not resumable).
          stopped = true;
          try { controller.close(); } catch { /* already closed */ }
          return;
        }
        setTimeout(poll, pollMs);
      };
      setTimeout(poll, pollMs);
    },
    cancel: stop,
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      // Tells buffering reverse proxies to pass events through immediately (per spec).
      'X-Accel-Buffering': 'no',
    },
  });
}
