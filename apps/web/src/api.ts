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
  // Token travels in the POST body, never the URL (PLNR-115), so it never lands in an access log.
  resetInfo: (token: string) => req<{ email: string; name: string }>('POST', '/api/reset/info', { token }),
  submitReset: (token: string, password: string) =>
    req<{ user: import('./types').UserVM }>('POST', '/api/reset', { token, password }),

  projects: (scope?: 'all') => req<{ projects: ApiProject[]; admin: boolean }>('GET', scope === 'all' ? '/api/projects?scope=all' : '/api/projects'),
  // The snapshot always includes archived tasks (flagged by archivedAt); the store
  // filters them for display (PLNR-150).
  snapshot: (pid: string) => req<ApiSnapshot>('GET', `/api/projects/${pid}/snapshot`),
  archiveTask: (pid: string, tid: string) => req('POST', `/api/projects/${pid}/tasks/${tid}/archive`),
  restoreTask: (pid: string, tid: string) => req('POST', `/api/projects/${pid}/tasks/${tid}/restore`),
  taskDetail: (tid: string) => req<ApiTaskDetail>('GET', `/api/tasks/${tid}`),
  health: () => req<{ ok: boolean; version?: string; maintenance?: boolean }>('GET', '/api/health'),

  createProject: (key: string, name: string, description?: string) =>
    req<{ id: string; key: string }>('POST', '/api/projects', { key, name, description }),
  groups: () => req<{ groups: Array<{ id: string; name: string; description: string; canEdit: number }> }>('GET', '/api/groups'),
  createGroup: (name: string, description?: string) => req<{ id: string }>('POST', '/api/groups', { name, description }),
  docs: (pid: string) => req<{ docs: Array<{ id: string; name: string; description: string; body: string; folder: string; tags: string[]; authorKind: string; authorName: string; updatedAt: string }> }>('GET', `/api/projects/${pid}/docs`),
  createDoc: (pid: string, input: { name: string; description?: string; body?: string; folder?: string; tags?: string[] }) => req<{ id: string }>('POST', `/api/projects/${pid}/docs`, input),
  updateDoc: (pid: string, did: string, patch: { name?: string; description?: string; body?: string; folder?: string; tags?: string[] }) => req('PATCH', `/api/projects/${pid}/docs/${did}`, patch),
  deleteDoc: (pid: string, did: string) => req('DELETE', `/api/projects/${pid}/docs/${did}`),
  // Plan-local docs (PLNR-200) — reads come from the snapshot (planDocs); these are the writes.
  createPlanDoc: (pid: string, planId: string, input: { name: string; description?: string; body?: string }) =>
    req<{ id: string }>('POST', `/api/projects/${pid}/plans/${planId}/docs`, input),
  updatePlanDoc: (pid: string, planId: string, docId: string, patch: { name?: string; description?: string; body?: string }) =>
    req('PATCH', `/api/projects/${pid}/plans/${planId}/docs/${docId}`, patch),
  deletePlanDoc: (pid: string, planId: string, docId: string) =>
    req('DELETE', `/api/projects/${pid}/plans/${planId}/docs/${docId}`),
  publicSnapshot: (pid: string) => req<PublicSnapshot>('GET', `/api/public/projects/${pid}/snapshot`),
  setProjectMeta: (pid: string, meta: { groupId?: string | null; description?: string; name?: string; claimTtlSeconds?: number; ownerUserId?: string | null; public?: boolean; fileLocking?: boolean; lockTtlSeconds?: number | null }) =>
    req('PATCH', `/api/projects/${pid}/meta`, meta),
  // Human force-release of a stuck file lock (PLNR-213).
  forceReleaseLock: (pid: string, lockId: string) => req<{ ok: boolean; path?: string }>('POST', `/api/projects/${pid}/locks/${lockId}/force-release`),

  users: () => req<{ users: ApiUser[] }>('GET', '/api/users'),
  createUser: (email: string, name: string, password: string, role: string) =>
    req<{ id: string }>('POST', '/api/users', { email, name, password, role }),
  patchUser: (uid: string, patch: { role?: string; disabled?: boolean; name?: string }) =>
    req('PATCH', `/api/users/${uid}`, patch),
  resetPassword: (uid: string) => req<{ tempPassword: string }>('POST', `/api/users/${uid}/reset-password`),
  changePassword: (current: string, next: string) => req('POST', '/api/auth/change-password', { current, next }),

  invite: (email: string, name: string, role: string, groupIds: string[]) =>
    req<{ userId: string; emailed: boolean; inviteUrl?: string }>('POST', '/api/users/invite', { email, name, role, groupIds }),
  // Token in the POST body, never the URL (PLNR-115) — keeps it out of access logs.
  inviteInfo: (token: string) => req<{ name: string; email: string }>('POST', '/api/invites/info', { token }),
  acceptInvite: (token: string, password?: string) =>
    req<{ user: import('./types').UserVM }>('POST', '/api/invites/accept', { token, password }),
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
  // Admin OAuth management (PLNR-160)
  adminConnections: () =>
    req<{ connections: Array<{
      id: string; userName: string | null; userEmail: string | null; clientName: string;
      createdAt: string; expiresAt: string; scoped: number; scopeAll: number; bound: number;
      projectKeys: string | null; agentCount: number; lastActive: string | null;
    }> }>('GET', '/api/admin/oauth/connections'),
  adminRevokeConnection: (id: string) => req('POST', `/api/admin/oauth/connections/${id}/revoke`),
  adminClients: () =>
    req<{ clients: Array<{ id: string; name: string; redirectUris: string; createdAt: string; liveTokens: number }> }>('GET', '/api/admin/oauth/clients'),
  adminDeleteClient: (id: string) => req('DELETE', `/api/admin/oauth/clients/${id}`),
  revokeAllSessions: () => req('POST', '/api/auth/sessions/revoke-all'),

  patchGroup: (gid: string, patch: { name?: string; description?: string }) => req('PATCH', `/api/groups/${gid}`, patch),
  deleteGroup: (gid: string) => req('DELETE', `/api/groups/${gid}`),
  groupMembers: (gid: string) => req<{ members: Array<{ id: string; name: string; email: string; status: string }> }>('GET', `/api/groups/${gid}/members`),
  // Inviting creates a PENDING membership the target must accept (PLNR-138).
  addGroupMember: (gid: string, userId: string) => req<{ ok: boolean; status: string }>('POST', `/api/groups/${gid}/members`, { userId }),
  removeGroupMember: (gid: string, uid: string) => req('DELETE', `/api/groups/${gid}/members/${uid}`),
  groupInvites: () => req<{ invites: Array<{ groupId: string; groupName: string; invitedByName: string | null; invitedAt: string | null }> }>('GET', '/api/me/group-invites'),
  acceptGroupInvite: (gid: string) => req('POST', `/api/groups/${gid}/members/accept`),
  declineGroupInvite: (gid: string) => req('POST', `/api/groups/${gid}/members/decline`),
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

  /** kind='copilot' is a different read, not a filter: copilots aren't project-local, so they
   *  scope to their owner and ignore projectId entirely (PLNR-156). */
  agents: (projectId?: string, kind?: 'agent' | 'copilot') => {
    const q = new URLSearchParams();
    if (projectId && kind !== 'copilot') q.set('projectId', projectId);
    if (kind) q.set('kind', kind);
    const qs = q.toString();
    return req<{ agents: ApiAgent[] }>('GET', qs ? `/api/agents?${qs}` : '/api/agents');
  },
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
  archivePlan: (pid: string, plid: string) => req('POST', `/api/projects/${pid}/plans/${plid}/archive`),
  restorePlan: (pid: string, plid: string) => req('POST', `/api/projects/${pid}/plans/${plid}/restore`),
  approvePlan: (pid: string, plid: string) => req<{ id: string; status: string; tasksUngated: number }>('POST', `/api/projects/${pid}/plans/${plid}/approve`),
  rejectPlan: (pid: string, plid: string) => req<{ ok: boolean; cancelledTasks: number }>('POST', `/api/projects/${pid}/plans/${plid}/reject`),
  deleteTask: (pid: string, tid: string) => req('DELETE', `/api/projects/${pid}/tasks/${tid}`),
  deleteProject: (pid: string) => req('DELETE', `/api/projects/${pid}`),
  /** Cross-project "what needs me" (PLNR-121): open decisions/alerts + overdue tasks. */
  attention: () =>
    req<{
      signals: Array<{
        id: string; projectId: string; projectKey: string; taskId: string | null; taskKey: string | null;
        agentName: string; type: 'input_request' | 'alert'; severity: 'info' | 'warning' | 'critical';
        title: string; body: string | null; options: string[] | null;
        questions: ApiSignalQuestion[] | null; createdAt: string;
      }>;
      overdue: Array<{ id: string; key: string; title: string; dueAt: string; status: string; projectId: string; projectKey: string }>;
    }>('GET', '/api/attention'),
  answerSignal: (pid: string, sid: string, response: string, answers?: ApiSignalAnswer[]) =>
    req('POST', `/api/projects/${pid}/signals/${sid}/answer`, { response, answers }),
  /** The rounds of a threaded gate (PLNR-185), oldest first. */
  signalThread: (pid: string, sid: string) =>
    req<{ thread: Array<{
      id: string; title: string; body: string | null; status: string; agentName: string;
      options: string[] | null; questions: ApiSignalQuestion[] | null;
      response: string | null; responseJson: ApiSignalAnswer[] | null;
      followUpTo: string | null; createdAt: string; resolvedAt: string | null;
    }> }>('GET', `/api/projects/${pid}/signals/${sid}/thread`),
  /** Project search (PLNR-184): semantic when the instance has embeddings, else keyword. */
  search: (pid: string, q: string, kinds?: Array<'task' | 'doc' | 'plan'>, limit?: number) =>
    req<{ mode: 'semantic' | 'keyword'; results: ApiSearchHit[] }>(
      'GET',
      `/api/projects/${pid}/search?q=${encodeURIComponent(q)}${kinds?.length ? `&kinds=${kinds.join(',')}` : ''}${limit ? `&limit=${limit}` : ''}`,
    ),
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
  /** Continue a FAILED run (PLNR-180): re-open the same run id with N more reviewer rounds, back on
   *  the runner that still holds its kept worktree. `rounds` null → the daemon's manifest default. */
  continueRun: (runId: string, rounds: number | null) =>
    req<{ run: ApiRun; delivered: boolean }>('POST', `/api/runs/${runId}/continue`, { rounds }),
  /** The run's transcript (RUN-74): every voice in the run, in order — the "why" surface. */
  runLog: (runId: string) => req<{ segments: ApiRunLogSegment[] }>('GET', `/api/runs/${runId}/log`),

  // --- plan dispatch (PLNR-170): dispatch a whole plan; the server fans out per-task runs ---
  planDispatches: (pid: string, planId?: string) =>
    req<{ dispatches: ApiPlanDispatch[] }>('GET', `/api/projects/${pid}/plan-dispatches${planId ? `?planId=${planId}` : ''}`),
  dispatchPlan: (pid: string, planId: string, body: PlanDispatchInput) =>
    req<{ dispatch: ApiPlanDispatch }>('POST', `/api/projects/${pid}/plans/${planId}/dispatch`, body),
  cancelPlanDispatch: (id: string, reason?: string) =>
    req<{ ok: boolean; cancelledRuns: number }>('POST', `/api/plan-dispatches/${id}/cancel`, { reason }),
  retryPlanDispatch: (id: string) => req<{ created: number }>('POST', `/api/plan-dispatches/${id}/retry`),
};

// Mirrors @noriq-dev/shared RunnerRepo / Runner / Run — kept as plain interfaces so
// the web app stays free of the zod dependency (matches the ApiTask style).
export interface ApiRunnerRepo {
  id: string;
  projectKey: string;
  projectId: string | null;
  /** The board lock (RUN-71): committed name from the marker + its per-server resolution.
   *  boardId null while board is set = the name didn't resolve here (worth surfacing). */
  board: string | null;
  boardId: string | null;
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
  /** What the runner reported it is running (RUN-36). Null = registered before version
   *  reporting. Noriq records it; whether it is CURRENT is the runner's own business — it
   *  reads its own repo (RUN-37), and the server does not distribute releases. */
  version: string | null;
  createdAt: string;
}
export interface ApiRunBudget {
  maxTokens: number | null;
  maxUsd: number | null;
  maxDurationSeconds: number | null;
  /** A per-dispatch reviewer-round override (PLNR-180) — null = the daemon's manifest default.
   *  Carried on a "continue a failed run" dispatch. */
  maxRounds: number | null;
}
export interface ApiRunExit {
  outcome: 'done' | 'failed' | 'cancelled';
  code: number | null;
  signal: string | null;
  reason: string | null;
  finishedAt: string;
}
export type RunStatus = 'queued' | 'dispatched' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';
/** Sub-state of `running` (RUN-31), never a RunStatus value — see shared/runner.ts for why. */
export type RunPhase = 'agent' | 'verifying' | 'landing';
/** How hard the model should think (RUN-33) — intent, not a vendor knob. The daemon maps it per
 *  driver: the Claude SDK takes these verbatim, codex clamps xhigh/max to its own 'high'. */
export type RunEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  /** What a `running` run is doing right now (RUN-31). Null when queued or terminal. */
  phase: RunPhase | null;
  exit: ApiRunExit | null;
  worktreePath: string | null;
  // Live telemetry (RUN-22): last-writer-wins spend + log tail from the daemon.
  tokensUsed: number | null;
  usdSpent: number | null;
  logTail: string | null;
  /** What the run ACTUALLY spent per model (RUN-59) — the SDK's authoritative breakdown,
   *  keyed by model id. Null = not reported (codex, an old runner). `model` above is only
   *  what was requested. */
  modelUsage: Record<string, ApiRunModelMix> | null;
  /** The plan dispatch that fanned this run out (PLNR-170). Null = a one-off dispatch. */
  planDispatchId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  startedAt: string | null;
}

/** Per-model spend within a run (RUN-59) — the SDK's own field names, un-renamed. */
export interface ApiRunModelMix {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

/** A whole-plan dispatch (PLNR-170): the durable record the server's pump works from. */
export interface ApiPlanDispatch {
  id: string;
  projectId: string;
  planId: string;
  runnerId: string;
  repoRef: string;
  agentTool: string;
  model: string | null;
  effort: string | null;
  budget: Partial<ApiRunBudget>;
  /** 'approved' (default): dependents wait until the human marks each upstream done.
   *  'landed': dependents start once the upstream's run lands, review still pending —
   *  an explicit opt-in to running ahead of sign-off (PLNR-176). */
  gate: 'landed' | 'approved';
  /** 'stalled' is recoverable: the pump can't advance without a human (see stallReason);
   *  answering/approving/retrying re-activates it. */
  status: 'active' | 'stalled' | 'completed' | 'cancelled';
  stallReason: string | null;
  /** Every plan task with its latest run from THIS dispatch (null = not dispatched yet). */
  tasks: Array<{ taskId: string; runId: string | null; runStatus: string | null }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}
export interface PlanDispatchInput {
  runnerId: string;
  repoRef: string;
  agentTool: string;
  model?: string | null;
  effort?: RunEffort | null;
  /** Applied to every run the dispatch creates (per-run ceilings, not a shared pool). */
  budget?: Partial<ApiRunBudget>;
  gate?: 'landed' | 'approved';
}
/** One transcript segment (RUN-74). Consecutive same-voice segments merge in the UI. */
export interface ApiRunLogSegment {
  seq: number;
  role: 'agent' | 'reviewer' | 'verify' | 'system';
  round: number | null;
  text: string;
  at: string;
}
export interface DispatchInput {
  runnerId: string;
  kind: string;
  agentTool: string;
  repoRef: string;
  brief?: string;
  anchor?: { type: 'task'; id: string } | { type: 'plan'; id: string } | null;
  /** Land this run somewhere other than the repo's usual branch (RUN-41). Whether that is allowed
   *  at all is the REPO's call — [land].allowedBranches, checked by the daemon, which is the only
   *  side that can see the committed manifest. Empty/omitted = the repo's own choice. */
  targetBranch?: string | null;
  /** Per-dispatch model + effort (RUN-33). Omitted/null = the repo's [defaults] for this kind,
   *  then whatever the tool defaults to — the daemon resolves that chain, since only it can see
   *  the committed manifest. */
  model?: string | null;
  effort?: RunEffort | null;
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
  /** Opt-in public read-only visibility (PLNR-78). */
  public: number;
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
  /** For a session copilot, the connection copilot it hangs off (PLNR-155). Null for the
   *  connection copilot itself, and for sessions on a token minted before that existed. */
  parentAgentId: string | null;
  /** kind='copilot' reads only: the project it roamed to (copilots aren't project-local), and
   *  the client that authorized it — set only on a connection copilot, since only that one has
   *  a token pointing at it. */
  projectId?: string | null;
  clientName?: string | null;
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

/** One question in a batched input request (PLNR-131). No options = freeform. */
/** The anonymous read-only payload (PLNR-78) — the authed snapshot minus signals and
 *  operational agent detail. */
export interface PublicSnapshot {
  project: { id: string; key: string; name: string; description: string };
  tasks: ApiSnapshot['tasks'];
  dependencies: ApiSnapshot['dependencies'];
  agents: Array<{ id: string; name: string; role: string; status: string }>;
  events: ApiSnapshot['events'];
  milestones: ApiSnapshot['milestones'];
  boards: ApiSnapshot['boards'];
  plans: ApiSnapshot['plans'];
  phases: ApiSnapshot['phases'];
  phaseTasks: ApiSnapshot['phaseTasks'];
  tags: ApiSnapshot['tags'];
  taskTags: ApiSnapshot['taskTags'];
}

export interface ApiSignalQuestion {
  question: string;
  header?: string;
  /** Legacy alias for kind 'multi'. */
  multi?: boolean;
  options?: string[];
  /** PLNR-185 answer form; default select when options exist, else text. */
  kind?: 'select' | 'multi' | 'text' | 'number' | 'confirm';
}

/** Structured per-question answer (PLNR-185). */
export interface ApiSignalAnswer {
  question: string;
  answer: string | string[] | number | boolean;
}

/** One hit from /api/projects/:pid/search (PLNR-184). */
export interface ApiSearchHit {
  kind: 'task' | 'doc' | 'plan';
  id: string;
  projectId: string;
  key?: string;
  title: string;
  snippet: string;
  score: number;
  status?: string;
}

export interface ApiSnapshot {
  /** Server package version — deploy marker for the SPA's self-refresh (PLNR-193). */
  version?: string;
  project: { id: string; key: string; name: string; description: string; claimTtlSeconds: number; lockTtlSeconds?: number | null; fileLockingEnabled?: number };
  tasks: Array<{
    id: string; key: string; title: string; body: string; status: string; type: string; priority: number;
    estimate: number | null; dueAt: string | null; claimedBy: string | null; claimExpiresAt: string | null; parentTaskId: string | null;
    milestoneId: string | null; boardId: string | null; openComments: number; order: number; archivedAt: string | null;
    // 'failed' status is derived from failedAt (PLNR-178) — set when the anchor run's gate failed.
    failedAt?: string | null;
  }>;
  dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
  agents: Array<{ id: string; name: string; role: string; status: string; lastSeenAt: string | null; ownerName: string | null; parentAgentId: string | null }>;
  milestones: Array<{ id: string; title: string; dueAt: string | null; order: number }>;
  boards: Array<{ id: string; name: string; order: number }>;
  plans: Array<{ id: string; agentId: string | null; title: string; description: string; body: string; status: string; archivedAt: string | null; createdAt: string }>;
  phases: Array<{ id: string; planId: string; title: string; body: string; order: number }>;
  phaseTasks: Array<{ phaseId: string; taskId: string }>;
  tags: Array<{ id: string; name: string; color: string; order: number }>;
  taskTags: Array<{ taskId: string; tagId: string }>;
  /** Task↔doc relations (PLNR-182). */
  taskDocs: Array<{ taskId: string; docId: string }>;
  /** Plan-local working docs (PLNR-200): scoped to a plan, not indexed, no settled-only rule. */
  planDocs: Array<{ id: string; planId: string; name: string; description: string; body: string; authorKind: string; authorName: string; createdAt: string; updatedAt: string }>;
  /** Live file locks (PLNR-212): unreleased + unexpired, joined to holder + task. */
  locks: Array<{
    id: string; agentId: string; taskId: string | null; kind: string; path: string;
    branch: string | null; allBranches: number; acquiredAt: string; expiresAt: string;
    holderName: string | null; taskKey: string | null; taskTitle: string | null;
  }>;
  events: Array<{
    id: string; seq: number; actorKind: 'agent' | 'human' | 'system'; actorId: string; verb: string;
    subjectType: string; subjectId: string; payload: Record<string, unknown>; createdAt: string;
  }>;
  signals: Array<{
    id: string; taskId: string | null; taskKey: string | null; agentId: string | null; agentName: string;
    type: 'input_request' | 'alert'; severity: 'info' | 'warning' | 'critical';
    title: string; body: string | null; options: string[] | null;
    questions: ApiSignalQuestion[] | null; followUpTo: string | null; createdAt: string;
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
  /** Related project docs (PLNR-182). */
  docs: Array<{ id: string; name: string; description: string }>;
}
