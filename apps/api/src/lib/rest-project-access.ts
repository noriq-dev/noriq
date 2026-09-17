import type { Context, Next } from 'hono';
import type { Hono } from 'hono';
import type { AppContext } from '../auth';
import { userAuth } from '../auth';
import { projectRoleAllows, resolveProjectAccess, recordAuthorizationAudit, type ProjectAction } from './authorization';

const VIEWER_POST_ROUTES = [
  /\/memory\/(search|similar-effort|explain|constellation|entities|context|acceptance)$/,
];

const MANAGER_ROUTES = [
  /\/meta$/,
  /\/access(?:\/.*)?$/,
  /\/runs$/,
  /\/plans\/[^/]+\/dispatch$/,
  /\/plans\/[^/]+\/(approve|reject)$/,
  /\/locks\/[^/]+\/force-release$/,
  /\/search\/reindex$/,
  /\/memory\/repositories(?:\/[^/]+)?$/,
  /\/memory\/(backup|restore(?:\/rollback)?|lifecycle-sweep|graph\/rebuild)$/,
  /\/memory\/constellation\/v2\/rebuild$/,
  /\/memory\/generations(?:\/[^/]+\/(?:activate|abort)|\/prune-retained)$/,
  /\/memory\/vectors\/rebuild$/,
  /\/memory\/items\/[^/]+\/(approve|reject)$/,
  /\/agent-lifecycle-sweep$/,
];

export const projectActionForRequest = (method: string, pathname: string): ProjectAction => {
  if (method === 'GET' || method === 'HEAD' || VIEWER_POST_ROUTES.some((re) => re.test(pathname))) return 'view';
  if (MANAGER_ROUTES.some((re) => re.test(pathname))) return 'manage';
  return 'contribute';
};

/** Human-path project reach (admin override allowed). */
export const reachesProject = async (c: Context<AppContext>, pid: string): Promise<boolean> => {
  const access = await resolveProjectAccess(c.env.DB, c.var.user!.id, pid, { allowAdminOverride: true });
  return projectRoleAllows(access.role, 'view');
};

export const humanProjectActionDenied = async (
  c: Context<AppContext>,
  pid: string,
  action: ProjectAction,
): Promise<Response | null> => {
  const access = await resolveProjectAccess(c.env.DB, c.var.user!.id, pid, { allowAdminOverride: true });
  if (!projectRoleAllows(access.role, 'view')) return c.json({ error: 'not found' }, 404);
  if (!projectRoleAllows(access.role, action)) {
    return c.json({
      error: `project ${action === 'contribute' ? 'contributor' : action} role required`,
      code: 'project_action_denied',
      action,
      role: access.role,
      reason: access.cappedByReadOnly ? 'account_read_only' : 'insufficient_project_role',
    }, 403);
  }
  return null;
};

export async function resolveBlockerRefRest(c: Context<AppContext>, pid: string, ref: string): Promise<string> {
  const t = await c.env.DB.prepare('SELECT id, project_id AS tpid FROM tasks WHERE id = ? OR key = ?')
    .bind(ref, ref).first<{ id: string; tpid: string }>();
  if (t && (t.tpid === pid || (await reachesProject(c, t.tpid)))) return String(t.id);
  throw new Error(`dependsOn ${ref} not found or not accessible`);
}

async function requireProjectAccess(c: Context<AppContext>, next: Next) {
  const parts = new URL(c.req.url).pathname.split('/');
  const pid = parts[3];
  if (pid && parts.length > 4) {
    const action = projectActionForRequest(c.req.method, new URL(c.req.url).pathname);
    const access = await resolveProjectAccess(c.env.DB, c.var.user!.id, pid, { allowAdminOverride: true });
    if (!access.exists || !projectRoleAllows(access.role, 'view')) {
      await recordAuthorizationAudit(c.env.DB, {
        actorKind: 'human', actorId: c.var.user!.id, action: 'project.action', resourceType: 'project', resourceId: pid,
        decision: 'deny', reason: access.exists ? 'no_project_access' : 'project_not_found', metadata: { requiredAction: action, transport: 'rest' },
      }).catch(() => {});
      return c.json({ error: 'not found' }, 404);
    }
    if (!projectRoleAllows(access.role, action)) {
      const requiredRole = action === 'contribute' ? 'contributor' : action === 'manage' ? 'manager' : action === 'own' ? 'owner' : 'viewer';
      await recordAuthorizationAudit(c.env.DB, {
        actorKind: 'human', actorId: c.var.user!.id, action: 'project.action', resourceType: 'project', resourceId: pid,
        decision: 'deny', reason: access.cappedByReadOnly ? 'account_read_only' : 'insufficient_project_role',
        metadata: { requiredAction: action, effectiveRole: access.role, transport: 'rest' },
      }).catch(() => {});
      return c.json({
        error: `project ${requiredRole} role required`,
        code: 'project_action_denied',
        action,
        role: access.role,
        reason: access.cappedByReadOnly ? 'account is read-only' : 'insufficient project role',
      }, 403);
    }
  }
  await next();
}

/** Registers the /api/projects/:pid/* authorization chokepoint (PLNR-92). */
export function registerProjectAccessMiddleware(app: Hono<AppContext>) {
  app.use('/api/projects/:pid/*', userAuth, requireProjectAccess);
}
