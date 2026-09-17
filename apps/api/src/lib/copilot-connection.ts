import { nowIso } from './util';

/** Retire every copilot row tied to a revoked OAuth token (PLNR-568). */
export async function retireAgentsForRevokedConnection(db: D1Database, tokenId: string, at = nowIso()): Promise<void> {
  const reason = 'connection_authorization_ended';
  await db.batch([
    db.prepare(
      `UPDATE agents SET status = 'offline', retired_at = COALESCE(retired_at, ?),
                         retire_reason = COALESCE(retire_reason, ?), lifecycle_updated_at = ?
       WHERE oauth_token_id = ? AND status != 'revoked'`,
    ).bind(at, reason, at, tokenId),
    db.prepare(
      `UPDATE agents SET status = 'offline', retired_at = COALESCE(retired_at, ?),
                         retire_reason = COALESCE(retire_reason, ?), lifecycle_updated_at = ?
       WHERE id = (SELECT copilot_id FROM oauth_tokens WHERE id = ?)
         AND status != 'revoked'`,
    ).bind(at, reason, at, tokenId),
  ]);
}
