// PLNR-362: read-only classification preview for the additive actor/presence model.
// Mutation, protected-work evaluation and configurable sweeping belong to PLNR-363. Keeping this
// seam read-only is deliberate: applying migration 0081 may classify facts, but it never archives
// or deletes somebody merely because an operator asked for counts.

export const AGENT_LIFECYCLE_POLICY_DEFAULTS = {
  onlineSeconds: 5 * 60,
  copilotRetireDays: 7,
  historyArchiveDays: 30,
  presencePurgeDays: 90,
  runnerOfflineArchiveDays: 30,
} as const;

type CountRow = Record<string, string | number | null> & { count: number };

export async function classifyAgentLifecycle(db: D1Database) {
  const [actors, presences, runners, summary] = await Promise.all([
    db.prepare(
      `SELECT actor_class AS actorClass,
              CASE
                WHEN status = 'revoked' THEN 'revoked'
                WHEN archived_at IS NOT NULL THEN 'archived'
                WHEN retired_at IS NOT NULL THEN 'retired'
                ELSE 'active'
              END AS lifecycle,
              status AS compatibilityStatus,
              lineage_status AS lineageStatus,
              COUNT(*) AS count
         FROM agents
        GROUP BY actor_class, lifecycle, status, lineage_status
        ORDER BY actor_class, lifecycle, status, lineage_status`,
    ).all<CountRow>(),
    db.prepare(
      `SELECT kind, state, archived_at IS NOT NULL AS archived, COUNT(*) AS count
         FROM agent_presences
        GROUP BY kind, state, archived
        ORDER BY kind, state, archived`,
    ).all<CountRow>(),
    db.prepare(
      `SELECT CASE
                WHEN archived_at IS NOT NULL THEN 'archived'
                WHEN offboarded_at IS NOT NULL OR retired_at IS NOT NULL THEN 'retired'
                WHEN last_heartbeat_at IS NOT NULL
                 AND julianday('now') - julianday(last_heartbeat_at) <= (90.0 / 86400.0) THEN 'active'
                ELSE 'dormant'
              END AS lifecycle,
              COUNT(*) AS count
         FROM runners
        GROUP BY lifecycle
        ORDER BY lifecycle`,
    ).all<CountRow>(),
    db.prepare(
      `SELECT
          COUNT(*) AS actors,
          SUM(CASE WHEN actor_class = 'legacy_copilot' THEN 1 ELSE 0 END) AS legacyUnknownActors,
          SUM(CASE WHEN status = 'active' AND (last_seen_at IS NULL OR
              julianday('now') - julianday(last_seen_at) > 7) THEN 1 ELSE 0 END) AS activeButStaleSevenDays,
          SUM(CASE WHEN retired_at IS NOT NULL AND archived_at IS NULL AND
              julianday('now') - julianday(retired_at) > 30 THEN 1 ELSE 0 END) AS actorArchiveAgeCandidates,
          (SELECT COUNT(*) FROM agent_presences) AS presences,
          (SELECT COUNT(*) FROM agent_presences WHERE state = 'ended' AND archived_at IS NULL AND
              julianday('now') - julianday(ended_at) > 90) AS presencePurgeAgeCandidates
         FROM agents`,
    ).first<Record<string, number | null>>(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    dryRun: true,
    mutationPerformed: false,
    policyDefaults: AGENT_LIFECYCLE_POLICY_DEFAULTS,
    summary: {
      actors: Number(summary?.actors ?? 0),
      presences: Number(summary?.presences ?? 0),
      legacyUnknownActors: Number(summary?.legacyUnknownActors ?? 0),
      activeButStaleSevenDays: Number(summary?.activeButStaleSevenDays ?? 0),
      actorArchiveAgeCandidates: Number(summary?.actorArchiveAgeCandidates ?? 0),
      presencePurgeAgeCandidates: Number(summary?.presencePurgeAgeCandidates ?? 0),
      // Durable actor deletion is prohibited by policy. The age-only presence number above is not
      // eligibility: PLNR-363 must complete the fail-closed cross-reference probe first.
      durableActorDeleteCandidates: 0,
      verifiedPresencePurgeCandidates: 0,
    },
    actors: actors.results,
    presences: presences.results,
    runners: runners.results,
  };
}
