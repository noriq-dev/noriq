// PLNR-561: shared dual-plane backup/restore invariants (D1 + ProjectMemory + AgentSession).
import type { Env } from '../env';

/** Snapshots exported before migration 0066 (PLNR-231) carry inverted task.priority encoding. */
export const PRIORITY_INVERT_DEPLOYED_AT = '2026-08-01T00:00:00.000Z';

export type DualPlaneWarning = {
  code: 'memory_plane_unchanged' | 'agent_session_cursors' | 'pre_0066_priority' | 'd1_project_missing';
  severity: 'blocker' | 'warning';
  message: string;
};

export function isPre0066PrioritySnapshot(exportedAt: string | undefined): boolean {
  if (!exportedAt) return false;
  const at = Date.parse(exportedAt);
  if (Number.isNaN(at)) return false;
  return at < Date.parse(PRIORITY_INVERT_DEPLOYED_AT);
}

export function pre0066PriorityBlockMessage(exportedAt: string): string {
  return (
    `snapshot exportedAt ${exportedAt} predates migration 0066_invert_priority (PLNR-231): task.priority uses the old scale (4 = most urgent). ` +
    'Re-POST with ?acknowledgePre0066Priority=1 after you plan to run the manual rewrite documented in BACKUP.md, or restore a newer snapshot.'
  );
}

/** Warnings every successful D1-only restore must surface — the memory plane is never touched by import. */
export function d1ImportSuccessWarnings(exportedAt: string | undefined): DualPlaneWarning[] {
  const warnings: DualPlaneWarning[] = [
    {
      code: 'memory_plane_unchanged',
      severity: 'warning',
      message:
        'D1 import does not restore ProjectMemory. For each project, restore a matching memory-backups/<projectId>/<exportedAt>/ snapshot (or accept empty cognition until re-indexed).',
    },
    {
      code: 'agent_session_cursors',
      severity: 'warning',
      message:
        'AgentSession notice cursors live outside D1. After import, working agents may miss notices until global_seq catches up — reconnect MCP sessions to reset cursors (see BACKUP.md).',
    },
  ];
  if (isPre0066PrioritySnapshot(exportedAt)) {
    warnings.push({
      code: 'pre_0066_priority',
      severity: 'warning',
      message:
        'This snapshot predates priority scale inversion (0066). If you imported without rewriting priorities, the backlog sort is inverted — run the one-time UPDATE in BACKUP.md.',
    });
  }
  return warnings;
}

export async function d1ProjectExists(env: Env, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first<{ id: string }>();
  return row != null;
}

/** Memory restore must not report success when the coordination plane has no such project. */
export async function memoryRestoreDualPlaneGate(
  env: Env,
  projectId: string,
): Promise<{ ok: true } | { ok: false; reason: string; warnings: DualPlaneWarning[] }> {
  if (await d1ProjectExists(env, projectId)) return { ok: true };
  return {
    ok: false,
    reason: `refusing memory restore: project ${projectId} is not in D1 — restore or import the D1 plane first; memory-only restore would look healthy while coordination has no matching project`,
    warnings: [
      {
        code: 'd1_project_missing',
        severity: 'blocker',
        message: 'ProjectMemory restore requires the project row in D1 (dual-plane completeness).',
      },
    ],
  };
}

export function memoryRestoreSuccessWarnings(): DualPlaneWarning[] {
  return [
    {
      code: 'agent_session_cursors',
      severity: 'warning',
      message:
        'ProjectMemory restore does not reset AgentSession notice cursors. Agents may need to reconnect after a coordinated cutover.',
    },
  ];
}
