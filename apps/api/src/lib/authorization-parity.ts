export interface AuthorizationParityDifference {
  userId: string;
  userEmail: string;
  projectId: string;
  projectKey: string;
  legacyReach: boolean;
  grantReach: boolean;
}

export interface AuthorizationParityReport {
  compared: number;
  broadened: number;
  lost: number;
  differences: AuthorizationParityDifference[];
  readyToRetireLegacy: boolean;
  truncated: boolean;
}

/** Compare the legacy owner/group_id reach model to the authoritative owner/project_grants
 * model. Account read-only is intentionally irrelevant: both models are measuring view reach,
 * while the action ceiling is audited separately. */
export async function auditAuthorizationParity(db: D1Database, limit = 500): Promise<AuthorizationParityReport> {
  const base = `WITH pairs AS (
    SELECT u.id AS userId, u.email AS userEmail, p.id AS projectId, p.key AS projectKey,
      CASE WHEN p.owner_user_id = u.id OR EXISTS (
        SELECT 1 FROM user_groups ug
         WHERE ug.user_id = u.id AND ug.group_id = p.group_id AND ug.status = 'accepted'
      ) THEN 1 ELSE 0 END AS legacyReach,
      CASE WHEN p.owner_user_id = u.id OR EXISTS (
        SELECT 1 FROM project_grants pg
         WHERE pg.project_id = p.id AND pg.principal_type = 'user' AND pg.principal_id = u.id
      ) OR EXISTS (
        SELECT 1 FROM project_grants pg JOIN user_groups ug ON ug.group_id = pg.principal_id
         WHERE pg.project_id = p.id AND pg.principal_type = 'group'
           AND ug.user_id = u.id AND ug.status = 'accepted'
      ) THEN 1 ELSE 0 END AS grantReach
    FROM users u CROSS JOIN projects p
    WHERE u.disabled = 0 AND p.status = 'active'
  )`;
  const [summary, rows] = await Promise.all([
    db.prepare(`${base}
      SELECT COUNT(*) AS compared,
             SUM(CASE WHEN legacyReach = 0 AND grantReach = 1 THEN 1 ELSE 0 END) AS broadened,
             SUM(CASE WHEN legacyReach = 1 AND grantReach = 0 THEN 1 ELSE 0 END) AS lost
        FROM pairs`).first<{ compared: number; broadened: number | null; lost: number | null }>(),
    db.prepare(`${base}
      SELECT userId, userEmail, projectId, projectKey, legacyReach, grantReach
        FROM pairs WHERE legacyReach != grantReach
        ORDER BY projectKey, userEmail LIMIT ?`).bind(limit + 1).all<{
          userId: string; userEmail: string; projectId: string; projectKey: string; legacyReach: number; grantReach: number;
        }>(),
  ]);
  const lost = summary?.lost ?? 0;
  return {
    compared: summary?.compared ?? 0,
    broadened: summary?.broadened ?? 0,
    lost,
    differences: rows.results.slice(0, limit).map((row) => ({
      ...row, legacyReach: row.legacyReach === 1, grantReach: row.grantReach === 1,
    })),
    readyToRetireLegacy: lost === 0,
    truncated: rows.results.length > limit,
  };
}

/** Restore the compatibility-preserving group grants that migration 0078 creates. Idempotent;
 * explicit grants win and are never overwritten or removed. */
export async function reconcileLegacyGroupGrants(db: D1Database, projectId?: string): Promise<number> {
  const result = await db.prepare(
    `INSERT INTO project_grants (project_id, principal_type, principal_id, role, source)
     SELECT p.id, 'group', p.group_id, 'contributor', 'legacy_group'
       FROM projects p
      WHERE p.group_id IS NOT NULL AND (?1 IS NULL OR p.id = ?1)
     ON CONFLICT (project_id, principal_type, principal_id) DO NOTHING`,
  ).bind(projectId ?? null).run();
  return result.meta.changes ?? 0;
}
