// PLNR-363: bounded, idempotent actor/presence lifecycle maintenance.
//
// Presence is disposable only after a complete schema reference probe. Actor and Runner rows are
// never deleted here: they are durable attribution and can be referenced outside D1.

import type { Env } from '../env';
import { newId } from './util';
import { endCopilotSession } from './copilot-session';

const DAY_MS = 86_400_000;
const MAX_DAYS = 3_650;
const MAX_ONLINE_SECONDS = 86_400;
const DEFAULT_BATCH = 100;
const MAX_BATCH = 500;

// These are deliberately soft attribution links: the durable execution row retains the presence
// identifier after the short-lived presence record reaches its retention limit. Any new schema
// reference remains fail-closed until it is reviewed and added here explicitly.
const PURGE_SAFE_SOFT_PRESENCE_REFERENCES = new Set([
  'execution_nodes.presence_id',
  // A reviewed hard lineage reference. Individual parents remain protected below until every
  // child presence that names them has itself passed retention and been purged.
  'agent_presences.parent_presence_id',
]);

export type AgentLifecycleSweepConfig = {
  onlineSeconds: number;
  copilotRetireDays: number;
  historyArchiveDays: number;
  presencePurgeDays: number;
  runnerOfflineArchiveDays: number;
  batchSize: number;
  scheduledApply: boolean;
};

export type AgentLifecycleCursor = {
  actorId: string | null;
  presenceId: string | null;
  runnerId: string | null;
};

type SweepOptions = {
  dryRun?: boolean;
  at?: string;
  cursor?: Partial<AgentLifecycleCursor>;
  /** Scheduled dry runs persist only their scan cursor/telemetry so every bounded batch is
   * eventually inspected. Actor/presence/Runner rows and transition events remain untouched. */
  persistCursor?: boolean;
};

type ActorRow = {
  id: string;
  actorClass: string;
  status: string;
  retiredAt: string | null;
  archivedAt: string | null;
  activityAt: string;
  terminalAt: string | null;
  validToken: number;
  liveClaim: number;
  liveLock: number;
  openGate: number;
  liveRun: number;
  pendingSteer: number;
  liveChild: number;
};

type PresenceRow = {
  id: string;
  kind: string;
  actorId: string | null;
  runnerId: string | null;
  endedAt: string;
};

type RunnerRow = {
  id: string;
  status: string;
  heartbeatAt: string | null;
  offboardedAt: string | null;
  retiredAt: string | null;
  archivedAt: string | null;
  liveRun: number;
};

const integer = (raw: string | undefined, fallback: number, max: number): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(0, Math.trunc(parsed)));
};

const truthy = (raw: string | undefined): boolean => raw === '1' || raw?.toLowerCase() === 'true';

export function agentLifecycleSweepConfig(env: Partial<Env>): AgentLifecycleSweepConfig {
  return {
    onlineSeconds: integer(env.AGENT_LIFECYCLE_ONLINE_SECONDS, 5 * 60, MAX_ONLINE_SECONDS),
    copilotRetireDays: integer(env.AGENT_COPILOT_RETIRE_DAYS, 7, MAX_DAYS),
    historyArchiveDays: integer(env.AGENT_HISTORY_ARCHIVE_DAYS, 30, MAX_DAYS),
    presencePurgeDays: integer(env.AGENT_PRESENCE_PURGE_DAYS, 90, MAX_DAYS),
    runnerOfflineArchiveDays: integer(env.RUNNER_OFFLINE_ARCHIVE_DAYS, 30, MAX_DAYS),
    batchSize: Math.max(1, integer(env.AGENT_LIFECYCLE_SWEEP_BATCH, DEFAULT_BATCH, MAX_BATCH)),
    scheduledApply: truthy(env.AGENT_LIFECYCLE_SWEEP_APPLY),
  };
}

const before = (at: string, days: number) => new Date(Date.parse(at) - days * DAY_MS).toISOString();

function addCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function lifecycleState(row: { retiredAt: string | null; archivedAt: string | null; status?: string }): string {
  if (row.status === 'revoked') return 'revoked';
  if (row.archivedAt) return 'archived';
  if (row.retiredAt) return 'retired';
  return 'active';
}

function runnerLifecycleState(row: RunnerRow): string {
  if (row.archivedAt) return 'archived';
  if (row.retiredAt) return 'retired';
  return row.status === 'online' ? 'active' : 'dormant';
}

function protectionReasons(row: ActorRow): string[] {
  const reasons: string[] = [];
  if (row.liveClaim) reasons.push('live_claim');
  if (row.liveLock) reasons.push('live_lock');
  if (row.openGate) reasons.push('open_gate');
  if (row.liveRun) reasons.push('live_run');
  if (row.pendingSteer) reasons.push('pending_delivery');
  if (row.liveChild) reasons.push('live_child');
  return reasons;
}

const ACTOR_PROTECTION_PREDICATE = `
  AND NOT EXISTS (SELECT 1 FROM claims c
                   WHERE c.agent_id = agents.id AND c.released_at IS NULL AND c.expires_at > ?)
  AND NOT EXISTS (SELECT 1 FROM file_locks l
                   WHERE l.agent_id = agents.id AND l.released_at IS NULL AND l.expires_at > ?)
  AND NOT EXISTS (SELECT 1 FROM signals s
                   WHERE s.agent_id = agents.id AND s.type = 'input_request'
                     AND s.blocking = 1 AND s.status = 'open')
  AND NOT EXISTS (SELECT 1 FROM runs r
                   WHERE r.agent_id = agents.id AND r.status IN ('queued','dispatched','running','blocked'))
  AND NOT EXISTS (SELECT 1 FROM steers st
                   WHERE st.agent_id = agents.id AND st.acked_at IS NULL
                     AND COALESCE(st.delivered_via, '') != 'dropped')
  AND NOT EXISTS (
    SELECT 1 FROM agents child
    WHERE child.parent_agent_id = agents.id
      AND child.retired_at IS NULL AND child.status != 'revoked'
      AND (
        EXISTS (SELECT 1 FROM agent_presences cp
                 WHERE cp.actor_id = child.id AND cp.state IN ('online','working')
                   AND (cp.last_seen_at IS NULL OR cp.last_seen_at > ?))
        OR EXISTS (SELECT 1 FROM runs cr
                    WHERE cr.agent_id = child.id
                      AND cr.status IN ('queued','dispatched','running','blocked'))
      )
  )`;

async function presenceReferenceContract(db: D1Database): Promise<{ complete: boolean; blockers: string[] }> {
  try {
    const tables = await db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
    ).all<{ name: string }>();
    const inbound: string[] = [];
    for (const table of tables.results) {
      // Names come from sqlite_master, so this interpolation is trusted. D1 permits the static
      // PRAGMA form but rejects SQLite's table-valued pragma function with SQLITE_AUTH.
      const refs = await db.prepare(`PRAGMA foreign_key_list("${table.name}")`)
        .all<{ table: string; from: string }>();
      for (const ref of refs.results) {
        if (ref.table === 'agent_presences') inbound.push(`${table.name}.${ref.from}`);
      }
    }
    const soft = await db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name != 'agent_presences'
          AND lower(COALESCE(sql, '')) LIKE '%presence_id%'`,
    ).all<{ name: string }>();
    const blockers = [
      ...inbound,
      ...soft.results.map((r) => `${r.name}.presence_id`),
    ].filter((reference) => !PURGE_SAFE_SOFT_PRESENCE_REFERENCES.has(reference));
    return { complete: blockers.length === 0, blockers };
  } catch (error) {
    return { complete: false, blockers: [`probe_failed:${String(error)}`] };
  }
}

export async function sweepAgentLifecycle(env: Env, options: SweepOptions = {}) {
  const config = agentLifecycleSweepConfig(env);
  const dryRun = options.dryRun !== false;
  const at = options.at ?? new Date().toISOString();
  const onlineCutoff = new Date(Date.parse(at) - config.onlineSeconds * 1_000).toISOString();
  const retireCutoff = before(at, config.copilotRetireDays);
  const archiveCutoff = before(at, config.historyArchiveDays);
  const presenceCutoff = before(at, config.presencePurgeDays);
  const runnerCutoff = before(at, config.runnerOfflineArchiveDays);
  const sweepId = newId('als');

  const persistCursor = !dryRun || options.persistCursor === true;
  const stored = persistCursor ? await env.DB.prepare(
    `SELECT actor_cursor AS actorId, presence_cursor AS presenceId, runner_cursor AS runnerId
       FROM agent_lifecycle_sweep_state WHERE id = 1`,
  ).first<AgentLifecycleCursor>() : null;
  const selectedCursor = <K extends keyof AgentLifecycleCursor>(key: K): AgentLifecycleCursor[K] => (
    options.cursor && Object.prototype.hasOwnProperty.call(options.cursor, key)
      ? options.cursor[key] ?? null
      : stored?.[key] ?? null
  );
  const cursor: AgentLifecycleCursor = {
    actorId: selectedCursor('actorId'),
    presenceId: selectedCursor('presenceId'),
    runnerId: selectedCursor('runnerId'),
  };

  const transitions: Record<string, number> = {};
  const protections: Record<string, number> = {};
  const errorCounts: Record<string, number> = {};
  const errors: string[] = [];
  const examined = { actors: 0, presences: 0, runners: 0 };

  const actors = await env.DB.prepare(
    `SELECT a.id, a.actor_class AS actorClass, a.status, a.retired_at AS retiredAt,
            a.archived_at AS archivedAt,
            MAX(COALESCE(a.last_seen_at, a.created_at), COALESCE(
              (SELECT MAX(p.last_seen_at) FROM agent_presences p WHERE p.actor_id = a.id),
              a.last_seen_at, a.created_at)) AS activityAt,
            (SELECT MAX(r.updated_at) FROM runs r
              WHERE (r.agent_id = a.id OR r.id IN (
                SELECT p.run_id FROM agent_presences p WHERE p.actor_id = a.id AND p.run_id IS NOT NULL
              )) AND r.status IN ('done','failed','cancelled')) AS terminalAt,
            EXISTS (SELECT 1 FROM oauth_tokens ot
                     WHERE ot.copilot_id = a.id AND ot.revoked_at IS NULL AND ot.expires_at > ?) AS validToken,
            EXISTS (SELECT 1 FROM claims c WHERE c.agent_id = a.id
                     AND c.released_at IS NULL AND c.expires_at > ?) AS liveClaim,
            EXISTS (SELECT 1 FROM file_locks l WHERE l.agent_id = a.id
                     AND l.released_at IS NULL AND l.expires_at > ?) AS liveLock,
            EXISTS (SELECT 1 FROM signals s WHERE s.agent_id = a.id AND s.type = 'input_request'
                     AND s.blocking = 1 AND s.status = 'open') AS openGate,
            EXISTS (SELECT 1 FROM runs r WHERE r.agent_id = a.id
                     AND r.status IN ('queued','dispatched','running','blocked')) AS liveRun,
            EXISTS (SELECT 1 FROM steers st WHERE st.agent_id = a.id AND st.acked_at IS NULL
                     AND COALESCE(st.delivered_via, '') != 'dropped') AS pendingSteer,
            EXISTS (SELECT 1 FROM agents child WHERE child.parent_agent_id = a.id
                     AND child.retired_at IS NULL AND child.status != 'revoked' AND (
                       EXISTS (SELECT 1 FROM agent_presences cp WHERE cp.actor_id = child.id
                               AND cp.state IN ('online','working')
                               AND (cp.last_seen_at IS NULL OR cp.last_seen_at > ?))
                       OR EXISTS (SELECT 1 FROM runs cr WHERE cr.agent_id = child.id
                                  AND cr.status IN ('queued','dispatched','running','blocked'))
                     )) AS liveChild
       FROM agents a
      WHERE a.id > ?
      ORDER BY a.id
      LIMIT ?`,
  ).bind(at, at, at, onlineCutoff, cursor.actorId ?? '', config.batchSize).all<ActorRow>();

  const record = async (
    subjectKind: 'actor' | 'presence' | 'runner', subjectId: string, actorClass: string | null,
    fromState: string, toState: string, reason: string, evidenceAt: string | null,
  ) => {
    addCount(transitions, `${subjectKind}:${fromState}->${toState}:${reason}`);
    if (dryRun) return;
    await env.DB.prepare(
      `INSERT INTO agent_lifecycle_events
         (id, sweep_id, subject_kind, subject_id, actor_class, from_state, to_state, reason, evidence_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(newId('ale'), sweepId, subjectKind, subjectId, actorClass, fromState, toState, reason, evidenceAt, at).run();
  };

  for (const actor of actors.results) {
    examined.actors++;
    const reasons = protectionReasons(actor);
    reasons.forEach((reason) => addCount(protections, reason));
    const protectedWork = reasons.length > 0;
    const fromState = lifecycleState(actor);
    let toState: string | null = null;
    let reason: string | null = null;
    let evidenceAt: string | null = null;

    if (actor.actorClass === 'runner_agent' && !actor.retiredAt && actor.terminalAt) {
      toState = 'retired'; reason = 'run_terminal'; evidenceAt = actor.terminalAt;
    } else if (actor.actorClass === 'session_copilot' && !actor.retiredAt
      && actor.status !== 'revoked' && actor.activityAt <= retireCutoff && !protectedWork) {
      toState = 'retired'; reason = 'session_inactive'; evidenceAt = actor.activityAt;
    } else if (actor.actorClass === 'connection_copilot' && !actor.retiredAt
      && actor.status !== 'revoked' && !actor.validToken && !protectedWork) {
      toState = 'retired'; reason = 'connection_authorization_ended'; evidenceAt = actor.activityAt;
    } else if (actor.retiredAt && !actor.archivedAt && actor.retiredAt <= archiveCutoff && !protectedWork) {
      toState = 'archived'; reason = 'history_retention_elapsed'; evidenceAt = actor.retiredAt;
    }
    if (!toState || !reason) continue;

    if (dryRun) {
      await record('actor', actor.id, actor.actorClass, fromState, toState, reason, evidenceAt);
      continue;
    }

    let changed = 0;
    if (toState === 'retired' && reason === 'run_terminal') {
      const result = await env.DB.prepare(
        `UPDATE agents SET status = CASE WHEN status = 'revoked' THEN status ELSE 'offline' END,
                           retired_at = ?, retire_reason = ?, lifecycle_updated_at = ?
          WHERE id = ? AND retired_at IS NULL AND EXISTS (
            SELECT 1 FROM runs r WHERE (r.agent_id = agents.id OR r.id IN (
              SELECT p.run_id FROM agent_presences p WHERE p.actor_id = agents.id AND p.run_id IS NOT NULL
            )) AND r.status IN ('done','failed','cancelled'))`,
      ).bind(evidenceAt, reason, at, actor.id).run();
      changed = result.meta.changes ?? 0;
    } else if (toState === 'retired' && reason === 'session_inactive') {
      const result = await env.DB.prepare(
        `UPDATE agents SET status = 'offline', retired_at = ?, retire_reason = ?, lifecycle_updated_at = ?
          WHERE id = ? AND actor_class = 'session_copilot' AND retired_at IS NULL AND status != 'revoked'
            AND MAX(COALESCE(last_seen_at, created_at), COALESCE(
              (SELECT MAX(p.last_seen_at) FROM agent_presences p WHERE p.actor_id = agents.id),
              last_seen_at, created_at)) <= ?
            ${ACTOR_PROTECTION_PREDICATE}`,
      ).bind(evidenceAt, reason, at, actor.id, retireCutoff, at, at, onlineCutoff).run();
      changed = result.meta.changes ?? 0;
    } else if (toState === 'retired' && reason === 'connection_authorization_ended') {
      const result = await env.DB.prepare(
        `UPDATE agents SET status = 'offline', retired_at = ?, retire_reason = ?, lifecycle_updated_at = ?
          WHERE id = ? AND actor_class = 'connection_copilot' AND retired_at IS NULL AND status != 'revoked'
            AND NOT EXISTS (SELECT 1 FROM oauth_tokens ot WHERE ot.copilot_id = agents.id
                            AND ot.revoked_at IS NULL AND ot.expires_at > ?)
            ${ACTOR_PROTECTION_PREDICATE}`,
      ).bind(evidenceAt, reason, at, actor.id, at, at, at, onlineCutoff).run();
      changed = result.meta.changes ?? 0;
    } else if (toState === 'archived') {
      const result = await env.DB.prepare(
        `UPDATE agents SET archived_at = ?, lifecycle_updated_at = ?
          WHERE id = ? AND retired_at IS NOT NULL AND retired_at <= ? AND archived_at IS NULL
            ${ACTOR_PROTECTION_PREDICATE}`,
      ).bind(at, at, actor.id, archiveCutoff, at, at, onlineCutoff).run();
      changed = result.meta.changes ?? 0;
    }
    if (changed && reason === 'session_inactive') {
      await endCopilotSession(env, actor.id, 'session_expired', at, false);
    }
    if (changed) await record('actor', actor.id, actor.actorClass, fromState, toState, reason, evidenceAt);
    else addCount(protections, 'compare_and_set_lost');
  }

  const referenceContract = await presenceReferenceContract(env.DB);
  if (!referenceContract.complete) {
    addCount(errorCounts, 'reference_probe_incomplete');
    errors.push(`presence reference probe incomplete: ${referenceContract.blockers.join(', ')}`);
  }
  const presences = await env.DB.prepare(
    `SELECT id, kind, actor_id AS actorId, runner_id AS runnerId, ended_at AS endedAt
       FROM agent_presences
      WHERE id > ? AND ended_at IS NOT NULL AND ended_at <= ?
      ORDER BY id LIMIT ?`,
  ).bind(cursor.presenceId ?? '', presenceCutoff, config.batchSize).all<PresenceRow>();

  for (const presence of presences.results) {
    examined.presences++;
    if (!referenceContract.complete) { addCount(protections, 'reference_probe_incomplete'); continue; }
    const durableOwnerExists = presence.actorId
      ? Boolean(await env.DB.prepare('SELECT 1 FROM agents WHERE id = ?').bind(presence.actorId).first())
      : presence.runnerId
        ? Boolean(await env.DB.prepare('SELECT 1 FROM runners WHERE id = ?').bind(presence.runnerId).first())
        : false;
    if (!durableOwnerExists) { addCount(protections, 'durable_owner_missing'); continue; }
    const hasLiveLineageReference = Boolean(await env.DB.prepare(
      'SELECT 1 FROM agent_presences WHERE parent_presence_id = ? LIMIT 1',
    ).bind(presence.id).first());
    if (hasLiveLineageReference) { addCount(protections, 'lineage_reference'); continue; }
    if (dryRun) {
      await record('presence', presence.id, presence.kind, 'ended', 'purged', 'presence_retention_elapsed', presence.endedAt);
      continue;
    }
    const removed = await env.DB.prepare(
      `DELETE FROM agent_presences
        WHERE id = ? AND ended_at IS NOT NULL AND ended_at <= ?
          AND ((actor_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM agents a WHERE a.id = agent_presences.actor_id))
            OR (actor_id IS NULL AND runner_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM runners r WHERE r.id = agent_presences.runner_id)))
          AND NOT EXISTS (SELECT 1 FROM agent_presences child
                           WHERE child.parent_presence_id = agent_presences.id)`,
    ).bind(presence.id, presenceCutoff).run();
    if (removed.meta.changes) {
      await record('presence', presence.id, presence.kind, 'ended', 'purged', 'presence_retention_elapsed', presence.endedAt);
    } else addCount(protections, 'compare_and_set_lost');
  }

  const runners = await env.DB.prepare(
    `SELECT r.id, r.status, r.last_heartbeat_at AS heartbeatAt, r.offboarded_at AS offboardedAt,
            r.retired_at AS retiredAt, r.archived_at AS archivedAt,
            EXISTS (SELECT 1 FROM runs run WHERE run.runner_id = r.id
                     AND run.status IN ('queued','dispatched','running','blocked')) AS liveRun
       FROM runners r WHERE r.id > ? ORDER BY r.id LIMIT ?`,
  ).bind(cursor.runnerId ?? '', config.batchSize).all<RunnerRow>();

  for (const runner of runners.results) {
    examined.runners++;
    if (runner.liveRun) { addCount(protections, 'runner_live_run'); continue; }
    const evidenceAt = runner.offboardedAt ?? runner.heartbeatAt;
    const fromState = runnerLifecycleState(runner);
    let toState: string | null = null;
    let reason: string | null = null;
    if (!runner.retiredAt && runner.offboardedAt) {
      toState = 'retired'; reason = 'runner_offboarded';
    } else if (!runner.retiredAt && runner.status === 'offline' && evidenceAt && evidenceAt <= runnerCutoff) {
      toState = 'retired'; reason = 'runner_offline_retention';
    } else if (runner.retiredAt && !runner.archivedAt && runner.retiredAt <= runnerCutoff) {
      toState = 'archived'; reason = 'runner_history_retention_elapsed';
    }
    if (!toState || !reason) continue;
    if (dryRun) {
      await record('runner', runner.id, null, fromState, toState, reason, evidenceAt);
      continue;
    }
    const result = toState === 'retired'
      ? await env.DB.prepare(
        `UPDATE runners SET retired_at = ?, retire_reason = ?
          WHERE id = ? AND retired_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM runs run WHERE run.runner_id = runners.id
              AND run.status IN ('queued','dispatched','running','blocked'))`,
      ).bind(evidenceAt ?? at, reason, runner.id).run()
      : await env.DB.prepare(
        `UPDATE runners SET archived_at = ?
          WHERE id = ? AND retired_at IS NOT NULL AND retired_at <= ? AND archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM runs run WHERE run.runner_id = runners.id
                            AND run.status IN ('queued','dispatched','running','blocked'))`,
      ).bind(at, runner.id, runnerCutoff).run();
    if (result.meta.changes) await record('runner', runner.id, null, fromState, toState, reason, evidenceAt);
    else addCount(protections, 'compare_and_set_lost');
  }

  const nextCursor: AgentLifecycleCursor = {
    actorId: actors.results.length === config.batchSize ? actors.results.at(-1)!.id : null,
    presenceId: presences.results.length === config.batchSize ? presences.results.at(-1)!.id : null,
    runnerId: runners.results.length === config.batchSize ? runners.results.at(-1)!.id : null,
  };
  const complete = !nextCursor.actorId && !nextCursor.presenceId && !nextCursor.runnerId;
  const result = {
    sweepId, dryRun, generatedAt: at, config, examined, transitions, protections,
    referenceCheck: referenceContract, errorCounts, errors, cursor: nextCursor, complete,
  };

  if (persistCursor) {
    await env.DB.prepare(
      `UPDATE agent_lifecycle_sweep_state
          SET actor_cursor = ?, presence_cursor = ?, runner_cursor = ?, last_sweep_at = ?,
              last_apply_at = CASE WHEN ? = 1 THEN ? ELSE last_apply_at END, last_result = ?
        WHERE id = 1`,
    ).bind(
      nextCursor.actorId, nextCursor.presenceId, nextCursor.runnerId, at,
      dryRun ? 0 : 1, at, JSON.stringify(result),
    ).run();
  }
  return result;
}
