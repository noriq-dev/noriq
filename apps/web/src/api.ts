// Thin REST client. Session cookie rides along automatically (same origin).

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const api = {
  setupStatus: () => req<{ needsSetup: boolean }>('GET', '/api/setup/status'),
  setup: (email: string, name: string, password: string) =>
    req<{ user: import('./types').UserVM }>('POST', '/api/setup', { email, name, password }),
  me: () => req<{ user: import('./types').UserVM }>('GET', '/api/auth/me'),
  login: (email: string, password: string) =>
    req<{ user: import('./types').UserVM }>('POST', '/api/auth/login', { email, password }),
  logout: () => req('POST', '/api/auth/logout'),

  forgotPassword: (email: string) => req<{ ok: boolean }>('POST', '/api/auth/forgot', { email }),
  resetInfo: (token: string) => req<{ email: string; name: string }>('GET', `/api/reset/${token}`),
  submitReset: (token: string, password: string) =>
    req<{ user: import('./types').UserVM }>('POST', `/api/reset/${token}`, { password }),

  projects: (scope?: 'all') => req<{ projects: ApiProject[]; admin: boolean }>('GET', scope === 'all' ? '/api/projects?scope=all' : '/api/projects'),
  snapshot: (pid: string, includeArchived = false) => req<ApiSnapshot>('GET', `/api/projects/${pid}/snapshot${includeArchived ? '?archived=1' : ''}`),
  archiveTask: (pid: string, tid: string) => req('POST', `/api/projects/${pid}/tasks/${tid}/archive`),
  restoreTask: (pid: string, tid: string) => req('POST', `/api/projects/${pid}/tasks/${tid}/restore`),
  taskDetail: (tid: string) => req<ApiTaskDetail>('GET', `/api/tasks/${tid}`),

  createProject: (key: string, name: string, description?: string) =>
    req<{ id: string; key: string }>('POST', '/api/projects', { key, name, description }),
  groups: () => req<{ groups: Array<{ id: string; name: string; description: string; canEdit: number }> }>('GET', '/api/groups'),
  createGroup: (name: string, description?: string) => req<{ id: string }>('POST', '/api/groups', { name, description }),
  setProjectMeta: (pid: string, meta: { groupId?: string | null; description?: string; name?: string; claimTtlSeconds?: number; ownerUserId?: string | null }) =>
    req('PATCH', `/api/projects/${pid}/meta`, meta),

  users: () => req<{ users: ApiUser[] }>('GET', '/api/users'),
  createUser: (email: string, name: string, password: string, role: string) =>
    req<{ id: string }>('POST', '/api/users', { email, name, password, role }),
  patchUser: (uid: string, patch: { role?: string; disabled?: boolean; name?: string }) =>
    req('PATCH', `/api/users/${uid}`, patch),
  resetPassword: (uid: string) => req<{ tempPassword: string }>('POST', `/api/users/${uid}/reset-password`),
  changePassword: (current: string, next: string) => req('POST', '/api/auth/change-password', { current, next }),

  invite: (email: string, name: string, role: string, groupIds: string[]) =>
    req<{ userId: string; emailed: boolean; inviteUrl?: string }>('POST', '/api/users/invite', { email, name, role, groupIds }),
  inviteInfo: (token: string) => req<{ name: string; email: string }>('GET', `/api/invites/${token}`),
  acceptInvite: (token: string, password?: string) =>
    req<{ user: import('./types').UserVM }>('POST', `/api/invites/${token}/accept`, { password }),
  setUserGroups: (uid: string, groupIds: string[]) => req('PUT', `/api/users/${uid}/groups`, { groupIds }),

  registerOptions: () => req<Record<string, unknown>>('POST', '/api/webauthn/register/options'),
  registerVerify: (response: unknown, name?: string) => req('POST', '/api/webauthn/register/verify', { response, name }),
  loginOptions: () => req<Record<string, unknown>>('POST', '/api/webauthn/login/options'),
  loginVerify: (response: unknown) => req<{ user: import('./types').UserVM }>('POST', '/api/webauthn/login/verify', { response }),
  passkeys: () => req<{ passkeys: Array<{ id: string; name: string; createdAt: string }> }>('GET', '/api/webauthn/passkeys'),
  deletePasskey: (id: string) => req('DELETE', `/api/webauthn/passkeys/${id}`),

  authSessions: () =>
    req<{
      sessions: Array<{
        id: string; clientName: string; scope: string; createdAt: string; expiresAt: string;
        agentCount: number; lastActive: string | null;
        /** RUN-38: 1 once a human put this connection through the project picker. 0 = minted
         *  before scoping existed, so it still reaches every project its user can. */
        scoped: number;
        /** Comma-joined project keys it may reach; null when unscoped. */
        projectKeys: string | null;
      }>;
    }>('GET', '/api/auth/sessions'),
  revokeSession: (id: string) => req('POST', `/api/auth/sessions/${id}/revoke`),
  revokeAllSessions: () => req('POST', '/api/auth/sessions/revoke-all'),

  patchGroup: (gid: string, patch: { name?: string; description?: string }) => req('PATCH', `/api/groups/${gid}`, patch),
  deleteGroup: (gid: string) => req('DELETE', `/api/groups/${gid}`),
  groupMembers: (gid: string) => req<{ members: Array<{ id: string; name: string; email: string }> }>('GET', `/api/groups/${gid}/members`),
  addGroupMember: (gid: string, userId: string) => req('POST', `/api/groups/${gid}/members`, { userId }),
  removeGroupMember: (gid: string, uid: string) => req('DELETE', `/api/groups/${gid}/members/${uid}`),
  deleteUser: (uid: string) => req('DELETE', `/api/users/${uid}`),
  taskEvents: (tid: string) => req<{ events: ApiAgentEvent[] }>('GET', `/api/tasks/${tid}/events`),
  uploadAttachment: async (tid: string, file: File) => {
    const res = await fetch(`/api/tasks/${tid}/attachments?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
      credentials: 'same-origin',
    });
    if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
    return (await res.json()) as { id: string; filename: string };
  },
  deleteAttachment: (aid: string) => req('DELETE', `/api/attachments/${aid}`),
  createTag: (pid: string, name: string) => req<{ id: string }>('POST', `/api/projects/${pid}/tags`, { name }),

  agents: (projectId?: string) => req<{ agents: ApiAgent[] }>('GET', projectId ? `/api/agents?projectId=${projectId}` : '/api/agents'),
  agentEvents: (aid: string) => req<{ events: ApiAgentEvent[] }>('GET', `/api/agents/${aid}/events`),
  revokeAgent: (aid: string) => req('POST', `/api/agents/${aid}/revoke`),

  createBoard: (pid: string, name: string) => req<{ id: string; name: string }>('POST', `/api/projects/${pid}/boards`, { name }),
  renameBoard: (pid: string, bid: string, name: string) => req('PATCH', `/api/projects/${pid}/boards/${bid}`, { name }),
  deleteBoard: (pid: string, bid: string) => req<{ ok: boolean; movedTo: string }>('DELETE', `/api/projects/${pid}/boards/${bid}`),

  updateMilestone: (pid: string, mid: string, patch: { title?: string; dueAt?: string | null }) =>
    req('PATCH', `/api/projects/${pid}/milestones/${mid}`, patch),
  createMilestone: (pid: string, title: string, dueAt?: string) =>
    req<{ id: string }>('POST', `/api/projects/${pid}/milestones`, { title, dueAt }),
  createTask: (pid: string, input: { title: string; body?: string; priority?: number; milestoneId?: string; tags?: string[]; type?: string; boardId?: string }) =>
    req<{ id: string; key: string }>('POST', `/api/projects/${pid}/tasks`, input),
  updateTask: (pid: string, tid: string, patch: Record<string, unknown>) =>
    req('PATCH', `/api/projects/${pid}/tasks/${tid}`, patch),
  deleteMilestone: (pid: string, mid: string) => req('DELETE', `/api/projects/${pid}/milestones/${mid}`),
  deleteTag: (pid: string, tid: string) => req('DELETE', `/api/projects/${pid}/tags/${tid}`),
  deletePlan: (pid: string, plid: string) => req('DELETE', `/api/projects/${pid}/plans/${plid}`),
  approvePlan: (pid: string, plid: string) => req<{ id: string; status: string; tasksUngated: number }>('POST', `/api/projects/${pid}/plans/${plid}/approve`),
  rejectPlan: (pid: string, plid: string) => req<{ ok: boolean; cancelledTasks: number }>('POST', `/api/projects/${pid}/plans/${plid}/reject`),
  deleteTask: (pid: string, tid: string) => req('DELETE', `/api/projects/${pid}/tasks/${tid}`),
  deleteProject: (pid: string) => req('DELETE', `/api/projects/${pid}`),
  answerSignal: (pid: string, sid: string, response: string) =>
    req('POST', `/api/projects/${pid}/signals/${sid}/answer`, { response }),
  acknowledgeSignal: (pid: string, sid: string, dismiss = false) =>
    req('POST', `/api/projects/${pid}/signals/${sid}/acknowledge`, { dismiss }),
  addDependency: (pid: string, tid: string, dependsOnTaskId: string) =>
    req('POST', `/api/projects/${pid}/tasks/${tid}/dependencies`, { dependsOnTaskId }),
  removeDependency: (pid: string, tid: string, depId: string) =>
    req('DELETE', `/api/projects/${pid}/tasks/${tid}/dependencies/${depId}`),
  sendMessage: (pid: string, body: string, toAgentId?: string) =>
    req<{ id: string }>('POST', `/api/projects/${pid}/messages`, { body, toAgentId }),
  postComment: (pid: string, tid: string, kind: string, body: string) =>
    req<{ id: string }>('POST', `/api/projects/${pid}/tasks/${tid}/comments`, { kind, body }),
  resolveComment: (pid: string, cid: string, resolution: string, reply?: string) =>
    req('POST', `/api/projects/${pid}/comments/${cid}/resolve`, { resolution, reply }),
  releaseTask: (pid: string, tid: string, toStatus?: string) =>
    req('POST', `/api/projects/${pid}/tasks/${tid}/release`, { toStatus }),

  // --- runners / runs (RUN-22) ---
  runners: () => req<{ runners: ApiRunner[] }>('GET', '/api/runners'),
  /** Cut a runner off (RUN-35): revokes its token, fails its live runs. Severs Noriq — it does
   *  NOT remove the daemon's local repo access, so the process must be stopped too. */
  offboardRunner: (id: string) =>
    req<{ ok: boolean; tokenRevoked: boolean; failedRuns: number; warning?: string; note: string }>(
      'POST', `/api/runners/${id}/offboard`),
  renameRunner: (id: string, label: string) => req('PATCH', `/api/runners/${id}`, { label }),
  deleteRunner: (id: string) => req('DELETE', `/api/runners/${id}`),
  runs: (pid: string) => req<{ runs: ApiRun[] }>('GET', `/api/projects/${pid}/runs`),
  dispatchRun: (pid: string, body: DispatchInput) => req<{ run: ApiRun; delivered: boolean }>('POST', `/api/projects/${pid}/runs`, body),
  cancelRun: (runId: string, reason?: string) => req<{ run: ApiRun }>('POST', `/api/runs/${runId}/cancel`, { reason }),
};

// Mirrors @noriq-dev/shared RunnerRepo / Runner / Run — kept as plain interfaces so
// the web app stays free of the zod dependency (matches the ApiTask style).
export interface ApiRunnerRepo {
  id: string;
  projectKey: string;
  projectId: string | null;
  name: string;
  defaultBranch: string | null;
}
export interface ApiRunner {
  id: string;
  projectId: string | null;
  label: string;
  /** 'offboarded' is a human's decision, not a liveness state (RUN-35) — it outranks the
   *  heartbeat, so a cut-off runner never reads as online, or as merely crashed. */
  status: 'online' | 'offline' | 'draining' | 'offboarded';
  capabilities: { tools: string[]; kinds: string[]; maxConcurrency: number };
  repos: ApiRunnerRepo[];
  freeSlots: number;
  lastHeartbeatAt: string | null;
  offboardedAt: string | null;
  /** The daemon's release version (RUN-36). Null = registered before version reporting. */
  version: string | null;
  /** Derived server-side against the current release — never stored, since "current" moves
   *  when the server ships. Unknown is not outdated. */
  outdated: boolean;
  createdAt: string;
}
export interface ApiRunBudget {
  maxTokens: number | null;
  maxUsd: number | null;
  maxDurationSeconds: number | null;
}
export interface ApiRunExit {
  outcome: 'done' | 'failed' | 'cancelled';
  code: number | null;
  signal: string | null;
  reason: string | null;
  finishedAt: string;
}
export type RunStatus = 'queued' | 'dispatched' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';
export interface ApiRun {
  id: string;
  projectId: string;
  runnerId: string | null;
  agentId: string | null;
  kind: 'scope' | 'build' | 'verify';
  anchor: { type: 'task'; taskId: string } | { type: 'plan'; planId: string } | null;
  brief: string;
  repoRef: string;
  agentTool: string;
  budget: Partial<ApiRunBudget>;
  status: RunStatus;
  exit: ApiRunExit | null;
  worktreePath: string | null;
  // Live telemetry (RUN-22): last-writer-wins spend + log tail from the daemon.
  tokensUsed: number | null;
  usdSpent: number | null;
  logTail: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  startedAt: string | null;
}
export interface DispatchInput {
  runnerId: string;
  kind: string;
  agentTool: string;
  repoRef: string;
  brief?: string;
  anchor?: { type: 'task'; id: string } | { type: 'plan'; id: string } | null;
  budget?: Partial<ApiRunBudget>;
}

export interface ApiProject {
  id: string;
  key: string;
  name: string;
  description: string;
  liveTasks: number;
  openTasks: number;
  totalTasks: number;
  doneTasks: number;
  groupId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  agentCount: number;
}

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: number;
  createdAt: string;
  pending: number;
  passkeys: number;
  groupIds: string | null;
  ownedProjects: number;
}

export interface ApiAgent {
  id: string;
  name: string;
  /** copilot = a human's Claude Code / Codex session. agent = spawned and owned by a runner
   *  for exactly one run. Opposite lifecycles (RUN-43), so the roster must not show them
   *  alike — a quiet copilot is a human who stepped away; a quiet agent is a runaway. */
  kind: 'copilot' | 'agent';
  /** The runner that owns it. Set iff kind='agent' — enforced by a CHECK (migration 0026). */
  runnerId: string | null;
  role: string;
  status: string;
  lastSeenAt: string | null;
  createdAt: string;
  heldTasks: number;
  totalClaims: number;
  ownerName: string | null;
  ownerUserId: string | null;
  parentAgentId: string | null;
}

export interface ApiAgentEvent {
  id: string;
  projectId?: string;
  seq: number;
  verb: string;
  actorKind?: string;
  actorId?: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ApiSnapshot {
  project: { id: string; key: string; name: string; description: string; claimTtlSeconds: number };
  tasks: Array<{
    id: string; key: string; title: string; body: string; status: string; type: string; priority: number;
    claimedBy: string | null; claimExpiresAt: string | null; parentTaskId: string | null;
    milestoneId: string | null; boardId: string | null; openComments: number; order: number; archivedAt: string | null;
  }>;
  dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
  agents: Array<{ id: string; name: string; role: string; status: string; lastSeenAt: string | null; ownerName: string | null; parentAgentId: string | null }>;
  milestones: Array<{ id: string; title: string; dueAt: string | null; order: number }>;
  boards: Array<{ id: string; name: string; order: number }>;
  plans: Array<{ id: string; agentId: string | null; title: string; description: string; body: string; status: string; createdAt: string }>;
  phases: Array<{ id: string; planId: string; title: string; body: string; order: number }>;
  phaseTasks: Array<{ phaseId: string; taskId: string }>;
  tags: Array<{ id: string; name: string; color: string; order: number }>;
  taskTags: Array<{ taskId: string; tagId: string }>;
  events: Array<{
    id: string; seq: number; actorKind: 'agent' | 'human' | 'system'; actorId: string; verb: string;
    subjectType: string; subjectId: string; payload: Record<string, unknown>; createdAt: string;
  }>;
  signals: Array<{
    id: string; taskId: string | null; taskKey: string | null; agentId: string | null; agentName: string;
    type: 'input_request' | 'alert'; severity: 'info' | 'warning' | 'critical';
    title: string; body: string | null; options: string[] | null; createdAt: string;
  }>;
}

export interface ApiTaskDetail {
  task: Record<string, unknown>;
  comments: Array<{
    id: string; authorKind: string; authorId: string; kind: string; body: string; status: string; createdAt: string;
  }>;
  refs: Array<{ kind: string; ref: string; url: string | null; state: string | null }>;
  attachments: Array<{ id: string; filename: string; contentType: string; size: number; uploaderKind: string; uploadedBy: string; createdAt: string }>;
  tagIds: string[];
}
