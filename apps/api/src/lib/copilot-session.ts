import type { Env } from '../env';
import {
  MCP_SESSION_LINEAGE_META,
  McpSessionLineageHint,
  type ExecutionAssignment,
  type McpSessionLineageHint as McpSessionLineageHintType,
} from '@noriq-dev/shared';
import { tokenCanReachProject, userCanAccessProject } from './visibility';
import {
  applyExecutionEvent,
  createOrchestration,
  declareExecution,
} from './orchestration-store';
import { nowIso } from './util';

type CopilotActor = {
  id: string;
  userId: string;
  role: 'orchestrator' | 'worker';
};

type PresenceRow = {
  id: string;
  actorId: string;
  userId: string;
  parentPresenceId: string | null;
  state: string;
  endedAt: string | null;
};

export type CopilotSessionContext = {
  meaningful?: boolean;
  projectId?: string;
  lineage?: McpSessionLineageHintType;
};

export function copilotSessionContextFromMessages(messages: unknown[]): CopilotSessionContext {
  const relevant = messages.filter((raw): raw is Record<string, unknown> => {
    if (!raw || typeof raw !== 'object') return false;
    const method = (raw as { method?: unknown }).method;
    return method === 'tools/call' || method === 'resources/read';
  });
  let lineage: McpSessionLineageHintType | undefined;
  let projectId: string | undefined;
  for (const message of relevant) {
    const params = message.params && typeof message.params === 'object'
      ? message.params as Record<string, unknown> : {};
    const meta = params._meta && typeof params._meta === 'object'
      ? params._meta as Record<string, unknown> : undefined;
    const nextLineage = readCopilotSessionLineage(meta);
    if (nextLineage) {
      if (lineage && JSON.stringify(lineage) !== JSON.stringify(nextLineage)) {
        throw new Error('an MCP batch cannot contain conflicting session lineage hints');
      }
      lineage = nextLineage;
    }
    const args = params.arguments && typeof params.arguments === 'object'
      ? params.arguments as Record<string, unknown> : params;
    const nextProject = typeof args.projectId === 'string' && args.projectId ? args.projectId : undefined;
    if (nextProject && projectId && nextProject !== projectId) {
      throw new Error('an MCP batch cannot contain activity for multiple projects');
    }
    projectId = nextProject ?? projectId;
  }
  return { meaningful: relevant.length > 0, projectId, lineage };
}

export function readCopilotSessionLineage(meta: Record<string, unknown> | undefined): McpSessionLineageHintType | undefined {
  const raw = meta?.[MCP_SESSION_LINEAGE_META];
  if (raw === undefined) return undefined;
  return McpSessionLineageHint.parse(raw);
}

async function sessionPresence(env: Env, actorId: string): Promise<PresenceRow> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.actor_id AS actorId, a.user_id AS userId,
            p.parent_presence_id AS parentPresenceId, p.state, p.ended_at AS endedAt
       FROM agent_presences p JOIN agents a ON a.id = p.actor_id
      WHERE p.kind = 'mcp_session' AND p.actor_id = ?`,
  ).bind(actorId).first<PresenceRow>();
  if (!row) throw new Error('MCP session presence is missing');
  return row;
}

async function parentPresence(env: Env, id: string, userId: string): Promise<PresenceRow> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.actor_id AS actorId, a.user_id AS userId,
            p.parent_presence_id AS parentPresenceId, p.state, p.ended_at AS endedAt
       FROM agent_presences p JOIN agents a ON a.id = p.actor_id
      WHERE p.id = ? AND p.kind = 'mcp_session'`,
  ).bind(id).first<PresenceRow>();
  if (!row || row.userId !== userId) throw new Error('parent session belongs to another user or does not exist');
  if (row.endedAt || row.state === 'ended') throw new Error('parent session has ended');
  return row;
}

async function validatePresenceParent(env: Env, child: PresenceRow, parentId: string): Promise<PresenceRow> {
  if (child.id === parentId) throw new Error('session presence cannot parent itself');
  const parent = await parentPresence(env, parentId, child.userId);
  const cycle = await env.DB.prepare(
    `WITH RECURSIVE ancestors(id) AS (
       SELECT parent_presence_id FROM agent_presences WHERE id = ?
       UNION ALL
       SELECT p.parent_presence_id FROM agent_presences p JOIN ancestors a ON p.id = a.id
        WHERE p.parent_presence_id IS NOT NULL
     ) SELECT 1 FROM ancestors WHERE id = ? LIMIT 1`,
  ).bind(parent.id, child.id).first();
  if (cycle) throw new Error('session presence parent would create a cycle');
  if (child.parentPresenceId && child.parentPresenceId !== parent.id) {
    throw new Error('session presence already has a different immutable parent');
  }
  return parent;
}

type ParentExecution = {
  id: string;
  orchestrationId: string;
  projectId: string;
  presenceId: string | null;
  actorUserId: string | null;
};

async function loadParentExecution(env: Env, id: string, userId: string): Promise<ParentExecution> {
  const row = await env.DB.prepare(
    `SELECT n.id, n.orchestration_id AS orchestrationId, n.project_id AS projectId,
            n.presence_id AS presenceId,
            COALESCE(a.user_id, rn.owner_user_id) AS actorUserId
       FROM execution_nodes n
       LEFT JOIN agents a ON a.id = n.actor_id AND n.actor_kind IN ('copilot','agent')
       LEFT JOIN runners rn ON rn.id = n.actor_id AND n.actor_kind = 'runner'
      WHERE n.id = ?`,
  ).bind(id).first<ParentExecution>();
  if (!row || row.actorUserId !== userId) throw new Error('parent execution belongs to another user or does not exist');
  return row;
}

export async function validateCopilotSessionContext(
  env: Env,
  tokenId: string,
  userId: string,
  context: CopilotSessionContext,
): Promise<void> {
  const parentPresenceId = context.lineage?.parentPresenceId;
  const parentExecutionId = context.lineage?.parentExecutionId;
  const parent = parentPresenceId ? await parentPresence(env, parentPresenceId, userId) : null;
  const execution = parentExecutionId ? await loadParentExecution(env, parentExecutionId, userId) : null;
  if (execution && (!await userCanAccessProject(env, userId, execution.projectId)
      || !await tokenCanReachProject(env, tokenId, execution.projectId))) {
    throw new Error('parent execution is outside this connection\'s authorized projects');
  }
  if (parent && execution && execution.presenceId !== parent.id) {
    throw new Error('parent presence and parent execution do not describe the same session');
  }
  // Ordinary tool authorization stays in the MCP wrapper so callers receive the established
  // JSON-RPC isError shape. Validate reach here only when a lineage claim would otherwise be
  // persisted before the tool runs.
  if (context.projectId && context.lineage) {
    if (!await userCanAccessProject(env, userId, context.projectId)
        || !await tokenCanReachProject(env, tokenId, context.projectId)) {
      throw new Error(`project ${context.projectId} is outside this session's authorized projects`);
    }
    if (execution && execution.projectId !== context.projectId) {
      throw new Error('parent execution is in another project/orchestration');
    }
  }
}

async function executionForPresence(env: Env, presenceId: string, projectId: string): Promise<ExecutionAssignment | null> {
  const row = await env.DB.prepare(
    `SELECT id AS executionId, orchestration_id AS orchestrationId,
            parent_execution_id AS parentExecutionId, role,
            completeness_status AS lineageStatus
       FROM execution_nodes
      WHERE presence_id = ? AND project_id = ? AND kind = 'copilot_session'
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(presenceId, projectId).first<Omit<ExecutionAssignment, 'schemaVersion'>>();
  return row ? { schemaVersion: 1, ...row } : null;
}

async function ensureSessionExecution(
  env: Env,
  actor: CopilotActor,
  presence: PresenceRow,
  projectId: string,
  hintedParentExecutionId?: string,
): Promise<ExecutionAssignment> {
  const existing = await executionForPresence(env, presence.id, projectId);
  if (existing) {
    if (hintedParentExecutionId && existing.parentExecutionId !== hintedParentExecutionId) {
      throw new Error('session execution already has a different immutable parent');
    }
    return existing;
  }

  let parent: ParentExecution | null = null;
  if (hintedParentExecutionId) {
    parent = await loadParentExecution(env, hintedParentExecutionId, actor.userId);
  } else if (presence.parentPresenceId) {
    const assignment = await executionForPresence(env, presence.parentPresenceId, projectId);
    if (assignment) parent = await loadParentExecution(env, assignment.executionId, actor.userId);
  }
  if (parent && parent.projectId !== projectId) throw new Error('parent execution is in another project/orchestration');

  let orchestrationId: string;
  if (parent) {
    orchestrationId = parent.orchestrationId;
  } else {
    orchestrationId = (await createOrchestration(env, {
      projectId,
      anchor: { type: 'none' },
      createdBy: { kind: 'copilot', id: actor.id },
      completeness: { status: 'partial', missing: ['parent'], reason: 'immediate_parent_unknown' },
    })).id;
  }
  const observedAt = nowIso();
  const declared = await declareExecution(env, {
    projectId, orchestrationId,
    parentExecutionId: parent?.id ?? null,
    producerScope: `mcp-session/${presence.id}/${projectId}`,
    localNodeKey: 'session',
    kind: 'copilot_session',
    role: actor.role === 'orchestrator' ? 'orchestrator' : 'worker',
    actor: { kind: 'copilot', id: actor.id },
    presenceId: presence.id,
    completeness: parent
      ? { status: 'complete', missing: [], reason: null }
      : { status: 'partial', missing: ['parent'], reason: 'immediate_parent_unknown' },
    observedAt,
  });
  await applyExecutionEvent(env, {
    projectId, orchestrationId, executionId: declared.id,
    eventId: `evt_session_${declared.id}_started`, revision: 1,
    type: 'started', observedAt,
    metadata: { source: 'mcp_session_activity' },
  });
  return (await executionForPresence(env, presence.id, projectId))!;
}

export async function syncCopilotSession(
  env: Env,
  tokenId: string,
  actor: CopilotActor,
  context: CopilotSessionContext,
): Promise<void> {
  let presence = await sessionPresence(env, actor.id);
  let parentExecutionId = context.lineage?.parentExecutionId;
  let parent: PresenceRow | null = null;
  if (context.lineage?.parentPresenceId) {
    parent = await validatePresenceParent(env, presence, context.lineage.parentPresenceId);
  }
  if (parentExecutionId) {
    const execution = await loadParentExecution(env, parentExecutionId, actor.userId);
    if (parent && execution.presenceId !== parent.id) {
      throw new Error('parent presence and parent execution do not describe the same session');
    }
    if (!parent && execution.presenceId) {
      const executionPresence = await env.DB.prepare(
        `SELECT kind FROM agent_presences WHERE id = ?`,
      ).bind(execution.presenceId).first<{ kind: string }>();
      if (executionPresence?.kind === 'mcp_session') {
        parent = await validatePresenceParent(env, presence, execution.presenceId);
      }
    }
  }
  if (parent && !presence.parentPresenceId) {
    await env.DB.batch([
      env.DB.prepare('UPDATE agent_presences SET parent_presence_id = ?, updated_at = ? WHERE id = ? AND parent_presence_id IS NULL')
        .bind(parent.id, nowIso(), presence.id),
      env.DB.prepare(
        `UPDATE agents SET parent_agent_id = NULL, lineage_status = 'complete', lineage_reason = NULL,
                           lifecycle_updated_at = ? WHERE id = ?`,
      ).bind(nowIso(), actor.id),
    ]);
    presence = { ...presence, parentPresenceId: parent.id };
  }

  const projectId = context.projectId;
  if (!context.meaningful) return;
  const focusedProjectId = projectId ?? (await env.DB.prepare('SELECT project_id AS projectId FROM agents WHERE id = ?')
    .bind(actor.id).first<{ projectId: string | null }>())?.projectId ?? undefined;
  if (!focusedProjectId) return;
  if (!await userCanAccessProject(env, actor.userId, focusedProjectId)
      || !await tokenCanReachProject(env, tokenId, focusedProjectId)) {
    return;
  }
  if (!parentExecutionId && parent) {
    parentExecutionId = (await executionForPresence(env, parent.id, focusedProjectId))?.executionId;
  }
  await ensureSessionExecution(env, actor, presence, focusedProjectId, parentExecutionId);
}

export async function describeCopilotSession(env: Env, actorId: string) {
  const presence = await sessionPresence(env, actorId);
  const focus = await env.DB.prepare('SELECT project_id AS projectId, lineage_status AS lineageStatus, lineage_reason AS lineageReason FROM agents WHERE id = ?')
    .bind(actorId).first<{ projectId: string | null; lineageStatus: string; lineageReason: string | null }>();
  return {
    presenceId: presence.id,
    parentPresenceId: presence.parentPresenceId,
    lineageStatus: focus?.lineageStatus ?? 'unknown',
    lineageReason: focus?.lineageReason ?? null,
    execution: focus?.projectId ? await executionForPresence(env, presence.id, focus.projectId) : null,
  };
}

export async function endCopilotSession(
  env: Env,
  actorId: string,
  reason: 'client_terminated' | 'session_expired',
  at = nowIso(),
  retireActor = true,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, project_id AS projectId, orchestration_id AS orchestrationId, last_revision AS revision
       FROM execution_nodes
      WHERE actor_id = ? AND kind = 'copilot_session'
        AND status IN ('pending','running','parked')`,
  ).bind(actorId).all<{ id: string; projectId: string; orchestrationId: string; revision: number }>();
  for (const node of results) {
    await applyExecutionEvent(env, {
      projectId: node.projectId, orchestrationId: node.orchestrationId, executionId: node.id,
      eventId: `evt_session_${node.id}_${reason}`, revision: node.revision + 1,
      type: 'interrupted', observedAt: at, reason,
      metadata: { source: reason },
    });
  }
  if (retireActor) {
    await env.DB.prepare(
      `UPDATE agents SET status = 'offline', retired_at = COALESCE(retired_at, ?),
                         retire_reason = ?, lifecycle_updated_at = ? WHERE id = ?`,
    ).bind(at, reason, at, actorId).run();
  }
  await env.DB.prepare(
    `UPDATE agent_presences SET state = 'ended', ended_at = COALESCE(ended_at, ?),
                                end_reason = ?, updated_at = ?
      WHERE actor_id = ? AND kind = 'mcp_session'`,
  ).bind(at, reason, at, actorId).run();
}
