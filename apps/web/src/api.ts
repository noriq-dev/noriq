// Thin REST client. Session cookie rides along automatically (same origin).

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export interface ApiAskStreamMeta {
  sources: ApiAskSource[];
  mode: 'semantic' | 'keyword' | null;
  model: string | null;
  graphEnhanced: boolean;
  trace?: string[];
}

export interface ApiAskStreamHandlers {
  onThread?: (thread: { id: string; title: string }) => void;
  onGeneration?: (generation: { id: string }) => void;
  onMeta: (meta: ApiAskStreamMeta) => void;
  onStatus?: (phase: 'searching' | 'generating') => void;
  onReasoning?: (text: string) => void;
  onDelta: (text: string) => void;
  onCancelled?: () => void;
  onDone?: (result: { finishReason: string | null; truncated: boolean }) => void;
}

async function askStream(
  question: string,
  threadId: string | null,
  handlers: ApiAskStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/ask/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ question, threadId: threadId ?? undefined }),
    credentials: 'same-origin',
    signal,
  });
  return consumeAskStream(res, handlers);
}

async function resumeAskStream(
  generationId: string,
  offsets: { answer: number; reasoning: number },
  handlers: ApiAskStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const query = new URLSearchParams({
    answerOffset: String(offsets.answer),
    reasoningOffset: String(offsets.reasoning),
  });
  const res = await fetch(`/api/ask/generations/${generationId}/stream?${query}`, {
    headers: { Accept: 'text/event-stream' },
    credentials: 'same-origin',
    signal,
  });
  return consumeAskStream(res, handlers);
}

async function consumeAskStream(res: Response, handlers: ApiAskStreamHandlers): Promise<void> {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  }
  if (!res.body) throw new Error('Ask returned no response stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneEvent = false;

  const dispatch = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const payload = JSON.parse(data.join('\n')) as Record<string, unknown>;
    if (event === 'thread' && typeof payload.id === 'string' && typeof payload.title === 'string') {
      handlers.onThread?.({ id: payload.id, title: payload.title });
    } else if (event === 'generation' && typeof payload.id === 'string') {
      handlers.onGeneration?.({ id: payload.id });
    } else if (event === 'meta') handlers.onMeta(payload as unknown as ApiAskStreamMeta);
    else if (event === 'status' && (payload.phase === 'searching' || payload.phase === 'generating')) handlers.onStatus?.(payload.phase);
    else if (event === 'reasoning' && typeof payload.text === 'string') handlers.onReasoning?.(payload.text);
    else if (event === 'delta' && typeof payload.text === 'string') handlers.onDelta(payload.text);
    else if (event === 'error') throw new Error(typeof payload.error === 'string' ? payload.error : 'Answer generation failed');
    else if (event === 'cancelled') {
      doneEvent = true;
      handlers.onCancelled?.();
    }
    else if (event === 'done') {
      doneEvent = true;
      handlers.onDone?.({
        finishReason: typeof payload.finishReason === 'string' ? payload.finishReason : null,
        truncated: payload.truncated === true,
      });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) dispatch(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatch(buffer);
    if (!doneEvent) throw new Error('Ask response ended before completion');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
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
  groups: () => req<{ groups: Array<{ id: string; name: string; description: string; canEdit: number; myRole: 'owner' | 'manager' | 'member' | null }> }>('GET', '/api/groups'),
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
  projectAccess: (pid: string) => req<{
    self: { effectiveRole: string | null; accessSource: string; cappedByReadOnly: boolean };
    owner: { id: string; name: string; email: string } | null;
    grants: Array<{
      principalType: 'user' | 'group'; principalId: string; principalName: string;
      principalEmail: string | null; role: 'manager' | 'contributor' | 'viewer'; source: string;
    }>;
    canManageAccess: boolean; canTransferOwnership: boolean;
  }>('GET', `/api/projects/${pid}/access`),
  setProjectGrant: (pid: string, grant: { principalType: 'user' | 'group'; principalId: string; role: 'manager' | 'contributor' | 'viewer' }) =>
    req('PUT', `/api/projects/${pid}/access/grants`, grant),
  revokeProjectGrant: (pid: string, principalType: 'user' | 'group', principalId: string) =>
    req('DELETE', `/api/projects/${pid}/access/grants/${principalType}/${encodeURIComponent(principalId)}`),
  transferProjectOwner: (pid: string, ownerUserId: string) =>
    req('POST', `/api/projects/${pid}/access/transfer-owner`, { ownerUserId }),
  // Human force-release of a stuck file lock (PLNR-213).
  forceReleaseLock: (pid: string, lockId: string) => req<{ ok: boolean; path?: string }>('POST', `/api/projects/${pid}/locks/${lockId}/force-release`),

  users: () => req<{ users: ApiUser[] }>('GET', '/api/users'),
  createUser: (email: string, name: string, password: string, role: string) =>
    req<{ id: string }>('POST', '/api/users', { email, name, password, role }),
  patchUser: (uid: string, patch: {
    role?: string; disabled?: boolean; name?: string; accessMode?: 'read_write' | 'read_only';
    canCreateProjects?: boolean | null; canCreateGroups?: boolean | null;
  }) =>
    req('PATCH', `/api/users/${uid}`, patch),
  adminAuthorization: () => req<{
    settings: { defaultCanCreateProjects: number; defaultCanCreateGroups: number; updatedAt: string };
    accounts: Array<ApiUser>;
    projects: Array<{ id: string; key: string; name: string; ownerName: string; grantCount: number; legacyGroupId: string | null }>;
    groups: Array<{ id: string; name: string; memberCount: number; ownerCount: number; projectGrantCount: number }>;
    audit: Array<{ id: string; actorKind: string; actorId: string | null; action: string; resourceType: string; resourceId: string | null; decision: string; reason: string; metadata: Record<string, unknown>; createdAt: string }>;
  }>('GET', '/api/admin/authorization'),
  setAuthorizationDefaults: (settings: { defaultCanCreateProjects?: boolean; defaultCanCreateGroups?: boolean }) =>
    req('PATCH', '/api/admin/authorization/settings', settings),
  beginAdminProjectOverride: (pid: string) => req('POST', `/api/admin/authorization/override/${pid}`),
  authorizationParityAudit: (reconcile = false) => req<{
    compared: number; broadened: number; lost: number; readyToRetireLegacy: boolean; inserted: number;
    rolloutGate: 'pass' | 'blocked'; truncated: boolean;
    differences: Array<{ userEmail: string; projectKey: string; legacyReach: boolean; grantReach: boolean }>;
    rollback: string;
  }>('POST', '/api/admin/authorization/parity-audit', { reconcile }),
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
  groupMembers: (gid: string) => req<{ members: Array<{ id: string; name: string; email: string; status: string; role: 'owner' | 'manager' | 'member' }> }>('GET', `/api/groups/${gid}/members`),
  // Inviting creates a PENDING membership the target must accept (PLNR-138).
  addGroupMember: (gid: string, userId: string, role: 'owner' | 'manager' | 'member' = 'member') => req<{ ok: boolean; status: string }>('POST', `/api/groups/${gid}/members`, { userId, role }),
  setGroupMemberRole: (gid: string, uid: string, role: 'owner' | 'manager' | 'member') => req('PATCH', `/api/groups/${gid}/members/${uid}`, { role }),
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
  agents: (projectId?: string, kind?: 'agent' | 'copilot', options: {
    includeHistory?: boolean;
    view?: 'active' | 'dormant' | 'history';
    lifecycle?: ApiAgent['lifecycle'];
    runnerId?: string;
    ownerUserId?: string;
    retireReason?: string;
    activeAfter?: string;
    activeBefore?: string;
    cursor?: string;
    limit?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (projectId && kind !== 'copilot') q.set('projectId', projectId);
    if (kind) q.set('kind', kind);
    if (options.includeHistory) q.set('includeHistory', 'true');
    if (options.view) q.set('view', options.view);
    if (options.lifecycle) q.set('lifecycle', options.lifecycle);
    if (options.runnerId) q.set('runnerId', options.runnerId);
    if (options.ownerUserId) q.set('ownerUserId', options.ownerUserId);
    if (options.retireReason) q.set('retireReason', options.retireReason);
    if (options.activeAfter) q.set('activeAfter', options.activeAfter);
    if (options.activeBefore) q.set('activeBefore', options.activeBefore);
    if (options.cursor) q.set('cursor', options.cursor);
    if (options.limit) q.set('limit', String(options.limit));
    const qs = q.toString();
    return req<ApiAgentRoster>('GET', qs ? `/api/agents?${qs}` : '/api/agents');
  },
  agentEvents: (aid: string) => req<{ events: ApiAgentEvent[] }>('GET', `/api/agents/${aid}/events`),
  revokeAgent: (aid: string) => req('POST', `/api/agents/${aid}/revoke`),
  archiveAgent: (aid: string) => req<{ ok: true; archived: true }>('POST', `/api/agents/${aid}/archive`),
  restoreAgentVisibility: (aid: string) => req<{ ok: true; archived: false; note: string }>('POST', `/api/agents/${aid}/restore-visibility`),

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
  // Spin-off gate (PLNR-230): accept → plain claimable todo; reject → cancelled (provenance kept).
  acceptSpinoff: (pid: string, tid: string) => req<{ id: string; key: string; status: string }>('POST', `/api/projects/${pid}/tasks/${tid}/spinoff/accept`),
  rejectSpinoff: (pid: string, tid: string) => req<{ id: string; key: string; status: string }>('POST', `/api/projects/${pid}/tasks/${tid}/spinoff/reject`),
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
  search: (pid: string, q: string, kinds?: Array<'task' | 'doc' | 'plan' | 'memory' | 'episode'>, limit?: number) =>
    req<{ mode: 'semantic' | 'keyword'; results: ApiSearchHit[] }>(
      'GET',
      `/api/projects/${pid}/search?q=${encodeURIComponent(q)}${kinds?.length ? `&kinds=${kinds.join(',')}` : ''}${limit ? `&limit=${limit}` : ''}`,
    ),
  /** Global, multi-turn Ask chat. Project scope is derived server-side from the session; the
   *  browser sends conversation history but can never choose or broaden retrieval access. */
  ask: (question: string, history: ApiAskHistoryMessage[]) =>
    req<{ answer: string; mode: 'semantic' | 'keyword' | null; model: string; graphEnhanced: boolean; sources: ApiAskSource[] }>(
      'POST', '/api/ask', { question, history }),
  askStream,
  resumeAskStream,
  cancelAskGeneration: (generationId: string) =>
    req<{ ok: true; cancelled: true }>('POST', `/api/ask/generations/${generationId}/cancel`),
  askThreads: (archived = false) =>
    req<{ threads: ApiAskThread[] }>('GET', `/api/ask/threads${archived ? '?archived=1' : ''}`),
  askThread: (threadId: string) => req<ApiAskThreadDetail>('GET', `/api/ask/threads/${threadId}`),
  archiveAskThread: (threadId: string) => req<{ ok: true; archived: true }>('POST', `/api/ask/threads/${threadId}/archive`),
  restoreAskThread: (threadId: string) => req<{ ok: true; archived: false }>('POST', `/api/ask/threads/${threadId}/restore`),
  deleteAskThread: (threadId: string) => req<{ ok: true }>('DELETE', `/api/ask/threads/${threadId}`),
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
  runners: (options: {
    all?: boolean; projectId?: string; ownerUserId?: string; lifecycle?: ApiRunner['lifecycle']; view?: 'active' | 'dormant' | 'history';
    retireReason?: string; activeAfter?: string; activeBefore?: string; cursor?: string; limit?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (options.all) q.set('all', '1');
    if (options.projectId) q.set('projectId', options.projectId);
    if (options.ownerUserId) q.set('ownerUserId', options.ownerUserId);
    if (options.lifecycle) q.set('lifecycle', options.lifecycle);
    if (options.view) q.set('view', options.view);
    if (options.retireReason) q.set('retireReason', options.retireReason);
    if (options.activeAfter) q.set('activeAfter', options.activeAfter);
    if (options.activeBefore) q.set('activeBefore', options.activeBefore);
    if (options.cursor) q.set('cursor', options.cursor);
    if (options.limit) q.set('limit', String(options.limit));
    const qs = q.toString();
    return req<ApiRunnerRoster>('GET', qs ? `/api/runners?${qs}` : '/api/runners');
  },
  /** Cut a runner off (RUN-35): revokes its token, fails its live runs. Severs Noriq — it does
   *  NOT remove the daemon's local repo access, so the process must be stopped too. */
  offboardRunner: (id: string) =>
    req<{ ok: boolean; tokenRevoked: boolean; failedRuns: number; warning?: string; note: string }>(
      'POST', `/api/runners/${id}/offboard`),
  renameRunner: (id: string, label: string) => req('PATCH', `/api/runners/${id}`, { label }),
  archiveRunner: (id: string) => req<{ ok: true; archived: true }>('POST', `/api/runners/${id}/archive`),
  restoreRunnerVisibility: (id: string) => req<{ ok: true; archived: false; note: string }>('POST', `/api/runners/${id}/restore-visibility`),
  deleteRunner: (id: string) => req('DELETE', `/api/runners/${id}`),
  agentLifecycleClassification: () => req<ApiAgentLifecycleClassification>('GET', '/api/admin/agent-lifecycle/classification'),
  agentLifecycleSweep: (pid: string, apply = false, cursor?: Record<string, string | null>) =>
    req<ApiAgentLifecycleSweep>('POST', `/api/projects/${pid}/agent-lifecycle-sweep${apply ? '?apply=true' : ''}`, cursor ? { cursor } : {}),
  runs: (pid: string) => req<{ runs: ApiRun[] }>('GET', `/api/projects/${pid}/runs`),
  orchestrations: (pid: string, options: { view?: 'active' | 'history'; cursor?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (options.view) q.set('view', options.view);
    if (options.cursor) q.set('cursor', options.cursor);
    if (options.limit) q.set('limit', String(options.limit));
    const query = q.toString();
    return req<ApiOrchestrationPage>('GET', `/api/projects/${pid}/orchestrations${query ? `?${query}` : ''}`);
  },
  orchestration: (pid: string, id: string, options: { timelineCursor?: string; timelineLimit?: number } = {}) => {
    const q = new URLSearchParams();
    if (options.timelineCursor) q.set('timelineCursor', options.timelineCursor);
    if (options.timelineLimit) q.set('timelineLimit', String(options.timelineLimit));
    const query = q.toString();
    return req<ApiOrchestrationTree>('GET', `/api/projects/${pid}/orchestrations/${id}${query ? `?${query}` : ''}`);
  },
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

  // --- Project Memory explorer (PLNR-271) — REST reads/writes the DO never exposes directly;
  // the web app reaches it only through these routes (apps/api/src/index.ts ~line 1093+). ---
  /** A dedicated reachability + size probe (PLNR-271's "unreachable, not empty" acceptance line):
   *  callers use a failed promise here to distinguish "the memory store is down" from "it answered
   *  with zero results." */
  memoryHealth: (pid: string) => req<ApiMemoryHealth>('GET', `/api/projects/${pid}/memory/health`),
  memoryRepositories: (pid: string) => req<{ repositories: ApiMemoryRepository[] }>('GET', `/api/projects/${pid}/memory/repositories`),
  /** PLNR-311: registers a canonical repository — the ONE write in this file open to any project
   *  member, not gated to admin (unlike every action below): registration is a human declaring
   *  identity, not an operator action against live index/backup state. Idempotent — registering
   *  an already-registered key succeeds and returns `created: false`. */
  registerRepository: (pid: string, repositoryKey: string, opts?: { defaultBranch?: string | null; vcsKind?: string | null }) =>
    req<{ repository: ApiMemoryRepository; created: boolean }>('POST', `/api/projects/${pid}/memory/repositories`, { repositoryKey, ...opts }),
  /** PLNR-321: the inverse of registerRepository — removes only the D1 routing/health row and its
   *  checkout associations. Idempotent server-side (deleting an already-absent key is a 200 with
   *  `deleted: false`, never a 404); the memory graph, evidence, and episodes already minted under
   *  the key are untouched. Same human-only posture as registration, not gated to admin. */
  deregisterRepository: (pid: string, repositoryKey: string) =>
    req<{ deleted: boolean }>('DELETE', `/api/projects/${pid}/memory/repositories/${encodeURIComponent(repositoryKey)}`),
  memoryItem: (pid: string, id: string) => req<ApiMemoryItem>('GET', `/api/projects/${pid}/memory/items/${id}`),
  memoryHistory: (pid: string, id: string) => req<ApiMemoryHistory>('GET', `/api/projects/${pid}/memory/items/${id}/history`),
  memoryContradictionSet: (pid: string, setId: string) =>
    req<{ setId: string; memoryItemIds: string[]; resolvedAt: string | null }>('GET', `/api/projects/${pid}/memory/contradictions/${setId}`),
  // `signal` (PLNR-286) lets a caller abort an in-flight search — the star map's search bar is
  // debounced and cancellable, and a superseded query's late response must never repaint a
  // highlight set (the same last-write-wins need `memoryDependencyNeighborhood`/etc. below
  // already have; this method just didn't take one yet).
  memorySearch: (pid: string, filters: ApiMemorySearchFilters, signal?: AbortSignal) =>
    req<ApiMemorySearchResult>('POST', `/api/projects/${pid}/memory/search`, filters, signal),
  /** Five-kind human feedback (§11, migration 0004) — influences ranking/presentation only;
   *  never touches the target's statement, evidence, or authority. */
  memoryFeedback: (pid: string, id: string, kind: ApiMemoryFeedbackKind, reason?: string) =>
    req<{ feedbackId: string }>('POST', `/api/projects/${pid}/memory/items/${id}/feedback`, { kind, reason }),
  /** Records a NEW version linked back via supersedesMemoryId — never edits the original in
   *  place (locked decision: no destructive "edit memory" affordance exists in this UI). */
  memoryCorrect: (pid: string, id: string, statement: string) =>
    req<{ memoryId: string }>('POST', `/api/projects/${pid}/memory/items/${id}/correct`, { statement }),
  memoryProposedDecisions: (pid: string) =>
    req<{ decisions: Array<{ id: string; statement: string; authority: number; recordedByAgentId: string | null; recordedAt: string; proposedAt: string }> }>(
      'GET', `/api/projects/${pid}/memory/proposed-decisions`,
    ),
  memoryReviewQueue: (pid: string, input: { reason?: ApiMemoryReviewReason; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (input.reason) params.set('reason', input.reason);
    if (input.limit != null) params.set('limit', String(input.limit));
    if (input.offset != null) params.set('offset', String(input.offset));
    const query = params.size ? `?${params}` : '';
    return req<ApiMemoryReviewQueue>('GET', `/api/projects/${pid}/memory/review-queue${query}`);
  },
  /** Authority 5 is reachable ONLY through this path (§12) — never a direct authority write. */
  memoryApproveDecision: (pid: string, id: string, note?: string) =>
    req<{ approvedMemoryId: string; transitionId: string }>('POST', `/api/projects/${pid}/memory/items/${id}/approve`, { note }),
  memoryRejectDecision: (pid: string, id: string, note?: string) =>
    req<{ ok: boolean; transitionId: string }>('POST', `/api/projects/${pid}/memory/items/${id}/reject`, { note }),

  // --- Ego-network graph + change-impact views (PLNR-272) — the human-facing twins of the named
  // graph-query primitives (PLNR-258), same `/memory/explain` route MemoryView's requiredReading
  // already documents, discriminated by `focus`. `signal` lets a caller abort an in-flight
  // expansion (acceptance: "an in-flight expansion can be cancelled") — every other method in
  // this file fires-and-forgets because nothing else in the app issues a request a human is
  // likely to want to cancel mid-flight; a bounded but potentially slow graph traversal is the
  // first one that does. `dependencyNeighborhood`'s `edgeTypes` is caller-supplied (defaults to
  // depends_on/imports/calls only when omitted — see ProjectMemory.ts) so it doubles as the
  // GENERAL bidirectional bounded-neighborhood primitive MemoryGraph needs: unlike
  // `/memory/search`'s seedEntityUri expansion (forward-only, ranked in with text/semantic hits),
  // this returns upstream/downstream separately with real edge-path provenance per hop — exactly
  // what "every visible edge shows its type and provenance" needs.
  memoryDependencyNeighborhood: (pid: string, input: ApiGraphNeighborhoodInput, signal?: AbortSignal) =>
    req<ApiDependencyNeighborhood>('POST', `/api/projects/${pid}/memory/explain`, { focus: 'dependencies', ...input }, signal),
  memoryValidatingTests: (pid: string, input: { entityUri: string; maxDepth?: number; maxResults?: number }, signal?: AbortSignal) =>
    req<ApiValidatingTests>('POST', `/api/projects/${pid}/memory/explain`, { focus: 'tests', ...input }, signal),
  memoryChangeImpact: (pid: string, input: { entityUris: string[]; maxDepth?: number; maxResults?: number }, signal?: AbortSignal) =>
    req<ApiChangeImpact>('POST', `/api/projects/${pid}/memory/explain`, { focus: 'impact', ...input }, signal),

  // The bounded, deterministic whole-project projection behind the memory star map (PLNR-284).
  // POST with no body today (see index.ts route comment on why POST anyway) — `signal` matches
  // the ego-network methods above: a canvas-driving fetch is exactly the kind of request a
  // navigating-away human wants to cancel mid-flight.
  memoryConstellation: (pid: string, options?: { includeIsolated?: boolean }, signal?: AbortSignal) =>
    req<ApiConstellation>('POST', `/api/projects/${pid}/memory/constellation`, options ?? {}, signal),
  memoryEntities: (pid: string, input: ApiGraphEntityPageInput, signal?: AbortSignal) =>
    req<ApiGraphEntityPage>('POST', `/api/projects/${pid}/memory/entities`, input, signal),

  // --- Repository index / backup / restore / memory-health operations (PLNR-273). READS are
  // reachable by any project member; the ACTION methods 403 server-side for a non-admin (the
  // server's own guard is authority — this view only hides the affordance, per the locked
  // decision that a control which would 403 on click is worse than one honestly absent). ---
  memoryOpsStatus: (pid: string) => req<ApiMemoryOpsStatus>('GET', `/api/projects/${pid}/memory/ops-status`),
  memoryBackupsList: (pid: string) => req<{ backups: string[]; r2Available: boolean }>('GET', `/api/projects/${pid}/memory/backups`),
  memoryTriggerBackup: (pid: string, tier: 'core' | 'full' = 'core') =>
    req<{ ok: true; manifestKey: string } | { ok: false; reason: string }>('POST', `/api/projects/${pid}/memory/backup?tier=${tier}`),
  /** The server's `?confirm=replace` guard is never pre-supplied by a caller that hasn't already
   *  gone through this app's own destructive-confirmation Dialog (locked decision) — it is
   *  appended here only because MemoryOps always confirms first, never as a default. */
  memoryRestore: (pid: string, exportedAt: string) =>
    req<{ ok: true; tableCounts: Record<string, number> } | { ok: false; reason: string }>(
      'POST', `/api/projects/${pid}/memory/restore?confirm=replace&exportedAt=${encodeURIComponent(exportedAt)}`,
    ),
  memoryRollback: (pid: string) => req<{ ok: true } | { ok: false; reason: string }>('POST', `/api/projects/${pid}/memory/restore/rollback`),
  memoryPruneRetainedGeneration: (pid: string) => req<{ ok: true }>('POST', `/api/projects/${pid}/memory/generations/prune-retained`),
  memoryActivateGeneration: (pid: string, generationId: string) =>
    req<{ activated: string; superseded: string[] }>('POST', `/api/projects/${pid}/memory/generations/${generationId}/activate`),
  memoryAbortGeneration: (pid: string, generationId: string) =>
    req<{ ok: true }>('POST', `/api/projects/${pid}/memory/generations/${generationId}/abort`),
  memoryRebuildVectors: (pid: string) =>
    req<{ ok: true; rebuilt: boolean; reason?: string; reindexed?: number }>('POST', `/api/projects/${pid}/memory/vectors/rebuild`),
  memoryLifecycleSweep: (pid: string) =>
    req<{
      projectId: string; prunedStagedGenerations: number; prunedRetainedGeneration: boolean;
      prunedBackupGenerations: number; decayedMemories: number; prunedSupersededGenerations: number;
      backfilled: boolean; backfillNodesWritten: number; backfillEdgesWritten: number;
      errors: Array<{ step: string; message: string }>;
    }>('POST', `/api/projects/${pid}/memory/lifecycle-sweep`),
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
  /** This repo's custom workflows, offered on dispatch alongside the three built-ins. Two entry
   *  shapes (PLNR-240): a bare NAME from a pre-PLNR-240 daemon (RUN-121), or {name, base,
   *  description} — base lets the selector default the run's kind to the workflow's posture.
   *  Prompt/stages stay the runner's authority (committed manifest). */
  workflows: Array<string | ApiAdvertisedWorkflow>;
}
export interface ApiAdvertisedWorkflow {
  name: string;
  base: 'scope' | 'build' | 'verify';
  description?: string | null;
}
/** Normalize an advertised workflow entry (PLNR-240): a bare RUN-121 name has no known base. */
export const advertisedWorkflow = (w: string | ApiAdvertisedWorkflow): { name: string; base: 'scope' | 'build' | 'verify' | null; description: string | null } =>
  typeof w === 'string' ? { name: w, base: null, description: null } : { name: w.name, base: w.base, description: w.description ?? null };
/** One installed driver's coordinate MENU (RUN-115): model ids + efforts for the agent picker.
 *  `models` is a suggestion list, not a whitelist — the dispatch model field stays free-text. */
export interface ApiAdvertisedAgent {
  tool: string;
  models: string[];
  efforts: RunEffort[];
}
export interface ApiRunner {
  id: string;
  projectId: string | null;
  label: string;
  /** 'offboarded' is a human's decision, not a liveness state (RUN-35) — it outranks the
   *  heartbeat, so a cut-off runner never reads as online, or as merely crashed. */
  status: 'online' | 'offline' | 'draining' | 'offboarded';
  /** `agents` is the coordinate catalog (RUN-115). Optional: a runner that registered before it
   *  existed has no entry in its stored capabilities JSON — the picker falls back to free-text. */
  capabilities: { tools: string[]; kinds: string[]; maxConcurrency: number; agents?: ApiAdvertisedAgent[] };
  repos: ApiRunnerRepo[];
  freeSlots: number;
  lastHeartbeatAt: string | null;
  offboardedAt: string | null;
  /** What the runner reported it is running (RUN-36). Null = registered before version
   *  reporting. Noriq records it; whether it is CURRENT is the runner's own business — it
   *  reads its own repo (RUN-37), and the server does not distribute releases. */
  version: string | null;
  createdAt: string;
  lifecycle?: 'active' | 'dormant' | 'retired' | 'archived';
  activityAt?: string;
  retiredAt?: string | null;
  retireReason?: string | null;
  archivedAt?: string | null;
  ownerName?: string | null;
  ownerUserId?: string | null;
  agentCount?: number;
  liveRuns?: number;
  eligiblePurge?: boolean;
}

export interface ApiRunnerRoster {
  runners: ApiRunner[];
  counts: {
    active: number; dormant: number; historical: number; total: number;
    byLifecycle: Record<'active' | 'dormant' | 'retired' | 'archived', number>;
  };
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
  policy: { heartbeatSeconds: number };
}

export type ApiExecutionStatus = 'pending' | 'running' | 'parked' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface ApiOrchestrationSummary {
  id: string; anchorType: 'task' | 'plan' | 'run' | 'chat' | 'none'; anchorId: string | null;
  anchorLabel: string | null; rootExecutionId: string | null; status: ApiExecutionStatus;
  completenessStatus: 'complete' | 'partial' | 'unknown'; completenessMissing: string[]; completenessReason: string | null;
  createdByKind: string; createdById: string; createdByName: string | null;
  nodeCount: number; liveNodeCount: number; incompleteNodeCount: number;
  createdAt: string; updatedAt: string; finishedAt: string | null;
}
export interface ApiOrchestrationPage {
  orchestrations: ApiOrchestrationSummary[];
  counts: { active: number; history: number; total: number };
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
}
export interface ApiExecutionNode {
  id: string; parentExecutionId: string | null; kind: 'copilot_session' | 'run' | 'sitting' | 'stage' | 'step' | 'gate';
  role: string; actorKind: string | null; actorId: string | null; actorName: string | null; presenceId: string | null;
  taskId: string | null; taskKey: string | null; taskTitle: string | null; planId: string | null; planTitle: string | null;
  runId: string | null; sitting: number | null; stage: string | null; step: string | null; gateId: string | null;
  status: ApiExecutionStatus; completenessStatus: 'complete' | 'partial' | 'unknown'; completenessMissing: string[];
  completenessReason: string | null; lastRevision: number; startedAt: string | null; parkedAt: string | null;
  finishedAt: string | null; outcomeReason: string | null; createdAt: string; updatedAt: string;
}
export interface ApiExecutionRelation {
  id: string; fromExecutionId: string; toExecutionId: string;
  type: 'continues' | 'verifies' | 'repairs' | 'hands_off_to' | 'depends_on'; metadata: Record<string, unknown>; createdAt: string;
}
export interface ApiExecutionTimelineEvent {
  eventId: string; executionId: string; revision: number; eventType: string; observedAt: string;
  targetExecutionId: string | null; reason: string | null; metadata: Record<string, unknown>; acceptedAt: string;
}
export interface ApiOrchestrationTree {
  orchestration: ApiOrchestrationSummary;
  nodes: ApiExecutionNode[]; rootExecutionIds: string[]; relations: ApiExecutionRelation[]; timeline: ApiExecutionTimelineEvent[];
  timelinePage: { limit: number; hasMore: boolean; nextCursor: string | null };
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
  /** The dispatch's agent coordinate (RUN-114): `claude.opus-4_8.high`. Null = synthesized from
   *  the agentTool/model/effort triple by the daemon. */
  agent: string | null;
  /** The selected repo-defined workflow (RUN-121); null = the built-in for `kind`. Overrides only
   *  the prompt — `kind` still carries the posture. */
  workflow: string | null;
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
  /** How many tasks this run spun off (PLNR-230) — accepted or not; the volume guard. */
  spinoffs?: number;
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
  /** The dispatch-level workflow default (PLNR-240); null = the built-in build. A task's own
   *  `workflow` overrides it per run. */
  workflow: string | null;
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
  /** Workflow every pump-created run selects unless the task names its own (PLNR-240).
   *  Must be advertised by the chosen repo; the server refuses an unknown name. */
  workflow?: string | null;
}
/** One transcript segment (RUN-74). Consecutive same-voice segments merge in the UI. */
export interface ApiRunLogSegment {
  seq: number;
  role: 'agent' | 'reviewer' | 'verify' | 'system';
  round: number | null;
  /** Which step of a decomposed run was speaking (RUN-150). Null for an undecomposed run — most
   *  of them — and for every segment written before the column existed. */
  step: string | null;
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
  /** The agent COORDINATE (RUN-114): `claude.opus-4_8.high`. Sent alongside the triple during the
   *  deprecation window — the daemon prefers it when set, else synthesizes one from the triple. */
  agent?: string | null;
  /** A repo-defined workflow name (RUN-121). Overrides only the prompt, so `kind` must be set to
   *  the workflow's base — the daemon keys permissions off `kind`. */
  workflow?: string | null;
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
  liveAgentCount: number;
  historicalAgentCount: number;
  /** Opt-in public read-only visibility (PLNR-78). */
  public: number;
  effectiveRole: 'owner' | 'manager' | 'contributor' | 'viewer' | null;
  accessSource: string;
  canView: boolean;
  canContribute: boolean;
  canManage: boolean;
  canOwn: boolean;
  cappedByReadOnly: boolean;
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
  accessMode?: 'read_write' | 'read_only';
  canCreateProjectsOverride?: number | null;
  canCreateGroupsOverride?: number | null;
  canCreateProjects?: number;
  canCreateGroups?: number;
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
  lifecycle: 'live' | 'recent' | 'dormant' | 'retired' | 'archived' | 'revoked';
  live: boolean;
  activityAt: string;
  actorClass: string;
  retiredAt: string | null;
  retireReason: string | null;
  archivedAt: string | null;
  lineageStatus: 'complete' | 'partial' | 'unknown';
  lineageReason: string | null;
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

export interface ApiAgentRoster {
  /** Compatibility array retained for older clients. */
  agents: ApiAgent[];
  counts: {
    live: number;
    recent: number;
    historical: number;
    total: number;
    byLifecycle: Record<ApiAgent['lifecycle'], number>;
  };
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
  policy: { onlineSeconds: number; recentDays: number };
}

export interface ApiAgentLifecycleClassification {
  generatedAt: string;
  dryRun: true;
  mutationPerformed: false;
  summary: {
    actors: number; presences: number; legacyUnknownActors: number; activeButStaleSevenDays: number;
    actorArchiveAgeCandidates: number; presencePurgeAgeCandidates: number;
    durableActorDeleteCandidates: number; verifiedPresencePurgeCandidates: number;
  };
  actors: Array<Record<string, string | number | null>>;
  presences: Array<Record<string, string | number | null>>;
  runners: Array<Record<string, string | number | null>>;
}

export interface ApiAgentLifecycleSweep {
  sweepId: string;
  dryRun: boolean;
  projectId: string | null;
  generatedAt: string;
  examined: { actors: number; presences: number; runners: number };
  transitions: Record<string, number>;
  protections: Record<string, number>;
  referenceCheck: { complete: boolean; blockers: string[] };
  errorCounts: Record<string, number>;
  errors: string[];
  cursor: { actorId: string | null; presenceId: string | null; runnerId: string | null };
  complete: boolean;
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
  /** Cross-project blockers, anonymized to {id, status} for anonymous viewers (PLNR-241). */
  externalTasks?: ApiSnapshot['externalTasks'];
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

export interface ApiAskHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One cross-project grounding source behind a global /ask answer. */
export interface ApiAskSource {
  kind: 'project' | 'task' | 'run' | 'signal' | 'comment' | 'doc' | 'plan' | 'memory' | 'episode';
  id: string;
  key?: string;
  title: string;
  status?: string;
  score: number;
  projectId: string;
  projectKey: string;
  projectName: string;
  authority?: number;
  validity?: string;
  isLead?: boolean;
  leadReasons?: string[];
  historical?: boolean;
  graphPath?: string;
  evidenceVerifiedForCaller?: Array<boolean | null>;
  citation?: string;
  updatedAt?: string;
  retrieval: 'semantic' | 'keyword' | 'graph' | 'hybrid' | 'live';
}

export interface ApiAskThread {
  id: string;
  title: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: string | null;
}

export interface ApiAskStoredMessage extends ApiAskHistoryMessage {
  id: string;
  sources: ApiAskSource[];
  reasoning: string;
  trace: string[];
  mode: 'semantic' | 'keyword' | null;
  model: string | null;
  generationId?: string | null;
  generationStatus?: 'pending' | 'searching' | 'generating' | 'completed' | 'failed' | null;
  generationError?: string | null;
  createdAt: string;
}

export interface ApiAskThreadDetail extends ApiAskThread {
  messages: ApiAskStoredMessage[];
}

/** One hit from /api/projects/:pid/search (PLNR-184; memory/episode kinds added PLNR-255). */
export interface ApiSearchHit {
  kind: 'task' | 'doc' | 'plan' | 'memory' | 'episode';
  id: string;
  projectId: string;
  key?: string;
  title: string;
  snippet: string;
  score: number;
  status?: string;
  /** memory/episode only — current authority (1-5), read live at query time. */
  authority?: number;
  /** memory only — current validity ('active' | 'stale' | 'invalid'), read live. */
  validity?: string;
}

export interface ApiSnapshot {
  /** Server package version — deploy marker for the SPA's self-refresh (PLNR-193). */
  version?: string;
  project: {
    id: string; key: string; name: string; description: string; claimTtlSeconds: number;
    lockTtlSeconds?: number | null; fileLockingEnabled?: number;
    effectiveRole: 'owner' | 'manager' | 'contributor' | 'viewer' | null;
    accessSource: string; canView: boolean; canContribute: boolean; canManage: boolean; canOwn: boolean;
    cappedByReadOnly: boolean;
  };
  tasks: Array<{
    id: string; key: string; title: string; body: string; status: string; type: string; priority: number;
    estimate: number | null; dueAt: string | null; claimedBy: string | null; claimExpiresAt: string | null; parentTaskId: string | null;
    milestoneId: string | null; boardId: string | null; openComments: number; order: number; archivedAt: string | null;
    // 'failed' status is derived from failedAt (PLNR-178) — set when the anchor run's gate failed.
    failedAt?: string | null;
    /** 1/0 from SQLite — whether the task has an execution spec at all (RUN-162). */
    specPlanned?: number | boolean;
    /** Spin-off surface (PLNR-230): 'proposed' status derives from proposedAt; the rest is the
     *  provenance the approval UI shows — which run filed it, from which task, on what finding. */
    proposedAt?: string | null;
    spinoffRunId?: string | null;
    spinoffSourceTaskId?: string | null;
    spinoffFinding?: string | null;
    /** Dispatch-workflow override (PLNR-240): the plan pump runs this task under it. */
    workflow?: string | null;
  }>;
  dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
  /** Foreign blockers behind cross-project dependency edges (PLNR-241): enough to compute
   *  blocked state and label the chip. Identity fields are ABSENT when the viewer cannot
   *  reach the blocker's project (and always absent on the public snapshot) — the status
   *  still ships, because the gate is real either way. */
  externalTasks?: Array<{ id: string; status: string; key?: string; title?: string; projectId?: string; projectKey?: string }>;
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
    questions: ApiSignalQuestion[] | null; followUpTo: string | null;
    /** 0 = a non-blocking question (PLNR-237): nothing parked; answer at leisure. */
    blocking?: number; createdAt: string;
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

// --- Project Memory explorer (PLNR-271) — mirrors apps/api/src/{lib/project-memory.ts,
// do/ProjectMemory.ts, memory/{retrieval,evidence-frame}.ts} response shapes exactly; kept as
// plain interfaces (no zod) matching the rest of this file's convention. ---

/** Mirrors ProjectMemoryHealth (apps/api/src/do/ProjectMemory.ts). */
export interface ApiMemoryHealth {
  projectId: string;
  schemaVersion: number;
  memoryRevision: number;
  tableCounts: Record<string, number>;
  databaseSize: number;
  sizeStatus: 'ok' | 'warn' | 'critical';
  /** PLNR-273: a retained rollback generation exists — gates the Rollback/discard controls. */
  hasPriorGeneration: boolean;
}

/** Mirrors IndexGenerationSummary (apps/api/src/do/ProjectMemory.ts), plus the `validated`
 *  flag GET /memory/repositories computes server-side for staged generations only (locked
 *  decision: this view never re-derives it — a generation with `validated: false` offers no
 *  activation control, full stop). */
export interface ApiIndexGeneration {
  id: string;
  repositoryKey: string;
  branch: string;
  baseId: string;
  indexerVersion: string;
  status: 'staged' | 'active' | 'superseded';
  batchCount: number;
  fileCount: number;
  sealedAt: string | null;
  validationProblems: string[];
  createdAt: string;
  activatedAt: string | null;
}
export interface ApiStagedGeneration extends ApiIndexGeneration {
  validated: boolean;
}

/** Mirrors ProjectRepositoryRow + its checkouts (GET /memory/repositories), widened by
 *  PLNR-273 with per-repository generation state and the two server-computed failure flags
 *  (`stale`, `failedIngest`) the Operations panel renders directly. */
export interface ApiMemoryRepository {
  id: string;
  projectId: string;
  repositoryKey: string;
  indexingEnabled: boolean;
  ingestStatus: 'none' | 'staged' | 'active' | 'failed';
  defaultBranch: string | null;
  vcsKind: string | null;
  branchClasses: string[];
  latestObservedBase: string | null;
  activeGenerationId: string | null;
  createdAt: string;
  updatedAt: string | null;
  checkouts: Array<{ id: string; projectRepositoryId: string; runnerId: string; checkoutId: string; createdAt: string; updatedAt: string }>;
  activeGeneration: ApiIndexGeneration | null;
  stagedGenerations: ApiStagedGeneration[];
  stale: boolean;
  failedIngest: boolean;
  failedIngestProblems: string[];
}

/** Mirrors MemoryRegistrySummary (apps/api/src/lib/project-memory.ts) — the compact D1
 *  projection; `null` means the project has never touched its memory store. */
export interface ApiMemoryRegistry {
  backupStatus: 'none' | 'pending' | 'ok' | 'failed';
  lastBackupAt: string | null;
  vectorDirty: boolean;
  sizeBytes: number | null;
  sizeStatus: 'ok' | 'warn' | 'critical';
}

/** Mirrors MemoryCapabilities (apps/api/src/lib/project-memory.ts) — which optional Cloudflare
 *  bindings are actually configured on THIS deployment. No queues/workflows fields: this repo
 *  declares no such bindings in Env at all, so there is nothing to report either way. */
export interface ApiMemoryCapabilities {
  r2: boolean;
  vectorize: boolean;
  workersAI: boolean;
  codeVectorize: boolean;
}

export interface ApiMemoryOpsStatus {
  health: ApiMemoryHealth;
  registry: ApiMemoryRegistry | null;
  capabilities: ApiMemoryCapabilities;
}

/** Mirrors memory/retrieval.ts's RankedHit — the shape every /memory/search result carries.
 *  `isLead`/`leadReasons`/`authority`/`validity` are the server's OWN classification
 *  (`classifyLead`) — this view displays them and computes none of it itself (locked decision). */
export interface ApiMemoryHit {
  entityType: 'memory' | 'episode' | 'node';
  id: string;
  uri?: string;
  kind?: string;
  title: string;
  snippet: string;
  stage: 'exact' | 'lexical' | 'semantic' | 'graph';
  score: number;
  repositoryKey?: string | null;
  branch?: string | null;
  authority?: number;
  validity?: string;
  status?: string;
  evidenceVerification?: string[];
  evidenceVerifiedForCaller?: boolean[];
  seedNodeId?: string;
  edgePath?: string;
  depth?: number;
  isLead: boolean;
  leadReasons: string[];
  finalScore: number;
}

/** Mirrors memory/evidence-frame.ts's EvidenceFrameResult — the ONE bounded, quoted-evidence
 *  rendering of untrusted memory/episode text (§13). Never re-rendered client-side: `text` is
 *  shown verbatim, including any "SUSPICIOUS" label the server attached. */
export interface ApiMemoryEvidenceFrame {
  text: string;
  itemsIncluded: number;
  itemsOmitted: number;
  truncated: boolean;
  charsUsed: number;
  suspiciousCount: number;
}

export interface ApiMemorySearchFilters {
  query?: string;
  memoryItemId?: string;
  episodeId?: string;
  taskId?: string;
  seedEntityUri?: string;
  edgeTypes?: string[];
  maxDepth?: number;
  repositoryKey?: string;
  branch?: string;
  preferBranch?: string;
  kind?: string;
  minAuthority?: number;
  validity?: string;
  limit?: number;
}

export interface ApiMemorySearchResult {
  mode: 'semantic' | 'keyword';
  results: ApiMemoryHit[];
  /** PLNR-271: the REST twin now renders the SAME evidence frame the search_project_memory MCP
   *  tool has since PLNR-270 (see index.ts's /memory/search route comment) — one bounded block
   *  covering every memory/episode hit in `results`. Passing ONLY `memoryItemId` in the request
   *  yields a single-item frame, which is how the inspector gets one memory's quoted statement. */
  evidenceFrame: ApiMemoryEvidenceFrame;
}

/** Mirrors MemoryItemRecord (apps/api/src/lib/project-memory.ts) — GET /memory/items/:id. */
export interface ApiMemoryItem {
  id: string;
  kind: string;
  statement: string;
  authority: number;
  confidence: number | null;
  contentHash: string | null;
  repositoryKey: string | null;
  branch: string | null;
  baseId: string | null;
  validity: string;
  supersedesMemoryId: string | null;
  recordedByAgentId: string | null;
  recordedAt: string;
  proposedAt: string | null;
  rejectedAt: string | null;
  evidence: Array<{
    id: string; repositoryKey: string; branch: string; baseId: string; path: string; symbol: string | null;
    verificationState: 'valid' | 'moved' | 'changed' | 'missing' | 'unverifiable';
    evidenceHash: string | null;
    lastVerifiedAt: string | null;
    lastVerifiedBaseId: string | null;
    lastVerifiedBranch: string | null;
    verificationSource: string | null;
    observedPath: string | null;
  }>;
}

export type ApiMemoryFeedbackKind = 'useful' | 'incorrect' | 'outdated' | 'harmful' | 'unverifiable';
export type ApiMemoryReviewReason = 'proposed_decision' | 'contradiction' | 'stale_invalid' | 'recent_negative_feedback' | 'low_authority';

export interface ApiMemoryReviewQueueItem {
  id: string;
  kind: string;
  statement: string;
  authority: number;
  validity: string;
  recordedAt: string;
  recordedByAgentId: string | null;
  proposedAt: string | null;
  repositoryKey: string | null;
  branch: string | null;
  baseId: string | null;
  reasons: ApiMemoryReviewReason[];
  contradictionSetIds: string[];
  recentNegativeFeedbackCount: number;
  latestNegativeFeedbackAt: string | null;
}

export interface ApiMemoryReviewQueue {
  items: ApiMemoryReviewQueueItem[];
  counts: Record<ApiMemoryReviewReason, number>;
  overallTotal: number;
  total: number;
  offset: number;
  nextOffset: number | null;
}

/** Mirrors ProjectMemory.getMemoryHistory's return (GET /memory/items/:id/history) — a memory's
 *  full lineage in both directions of supersedes_memory_id, its authority transitions, the
 *  contradiction sets it participates in, and its own feedback. */
export interface ApiMemoryHistory {
  versions: Array<{
    id: string; kind: string; statement: string; authority: number; validity: string;
    recordedByAgentId: string | null; recordedAt: string; proposedAt: string | null; rejectedAt: string | null;
    supersedesMemoryId: string | null; supersededByMemoryId: string | null;
  }>;
  transitions: Array<{
    id: string; memoryItemId: string; resultingMemoryId: string | null; outcome: 'approved' | 'rejected' | 'merge_promoted';
    newAuthority: number | null; actorKind: string; actorId: string | null; revision: string | null;
    note: string | null; createdAt: string;
  }>;
  contradictions: Array<{ setId: string; memoryItemIds: string[]; resolvedAt: string | null }>;
  feedback: Array<{ id: string; actorId: string; vote: string; kind: ApiMemoryFeedbackKind | null; reason: string | null; createdAt: string }>;
}

// --- Ego-network graph + change-impact views (PLNR-272) — mirrors
// apps/api/src/memory/graph-queries.ts's exported shapes exactly (same plain-interface
// convention as the rest of this file). `coverage` is the non-optional completeness marker every
// primitive returns (§2 of the Project Memory doc): `complete: false` means "this graph cannot
// answer that yet", never "nothing is related" — render the two differently. ---

export type ApiGraphCoverageReason = 'seed-not-found' | 'code-graph-empty' | 'no-writer-yet' | 'row-limit-reached' | 'graph-empty';

export interface ApiGraphCoverage {
  complete: boolean;
  reasons: ApiGraphCoverageReason[];
  edgeTypesWithNoWriter?: string[];
}

/** A node as ProjectMemory's `nodes` table carries it — always addressable by its stable
 *  entity URI (§18 locked decision: never a display label or generation-scoped id). */
export interface ApiGraphEntityRef {
  nodeId: string;
  uri: string;
  type: string;
  label: string;
}

/** One real edge on the path from a seed to a related entity — `fromNodeId`/`toNodeId` are the
 *  edge's ACTUAL direction, regardless of which way the traversal walked to find it. */
export interface ApiEdgeHop {
  fromNodeId: string;
  edgeType: string;
  toNodeId: string;
}

export interface ApiRelatedEntity extends ApiGraphEntityRef {
  depth: number;
  edgePath: ApiEdgeHop[];
}

export interface ApiGraphNeighborhoodInput {
  entityUri: string;
  edgeTypes?: string[];
  maxDepth?: number;
  maxResults?: number;
}

export interface ApiDependencyNeighborhood {
  seed: ApiGraphEntityRef | null;
  downstream: ApiRelatedEntity[];
  upstream: ApiRelatedEntity[];
  coverage: ApiGraphCoverage;
}

export interface ApiValidatingTests {
  seed: ApiGraphEntityRef | null;
  tests: ApiRelatedEntity[];
  coverage: ApiGraphCoverage;
}

export interface ApiUncertainEdge {
  entityUri: string;
  reason: 'not-yet-indexed';
}

export interface ApiChangeImpact {
  resolvedSeeds: ApiGraphEntityRef[];
  uncertainEdges: ApiUncertainEdge[];
  impactedTests: ApiRelatedEntity[];
  coverage: ApiGraphCoverage;
}

// --- The memory star map's constellation (PLNR-284) — mirrors
// apps/api/src/memory/graph-queries.ts's `Constellation*` shapes exactly (same plain-interface
// convention as the rest of this file). `coverage` reuses `ApiGraphCoverage` above verbatim —
// its `graph-empty` reason (new here) is the authoritative "the whole map is empty" signal;
// `code-graph-empty` alone (no `graph-empty`) means "unindexed project" — real coordination/
// memory nodes exist, there is just no repository code index yet. An unreachable store is NOT a
// field on this shape at all: it is a rejected `memoryConstellation` promise (a non-2xx/network
// failure), the same "unreachable, not empty" distinction memoryHealth already relies on. ---

export interface ApiConstellationNode {
  nodeId: string;
  uri: string;
  type: string;
  kind: string | null;
  label: string;
  createdAt?: string;
  authority: number | null;
  validity: string | null;
  isLead: boolean | null;
  leadReasons: string[] | null;
  degree: number;
  groupKey: string;
}

export interface ApiConstellationEdge {
  type: string;
  fromNodeId: string;
  toNodeId: string;
  provenance: string | null;
}

export interface ApiConstellationOmitted {
  nodes: number;
  edges: number;
  edgesDanglingPruned: number;
  edgesExcludedEndpoint?: number;
  /** Legacy aggregate retained for rolling clients. PLNR-339 excludes symbols only; prefer
   *  `sampling.excludedByType` for a truthful breakdown. */
  codeEntitiesExcluded: number;
  isolatedHidden?: number;
}

export interface ApiConstellationTypeCounts {
  total: number;
  selected: number;
  connected: number;
  selectedConnected: number;
}

export interface ApiConstellationSampling {
  policy: 'connected-memory-v1';
  includeIsolated: boolean;
  totalEligibleNodes: number;
  totalEligibleEdges: number;
  connectedNodes: number;
  isolatedNodes: number;
  selectedConnectedNodes: number;
  selectedIsolatedNodes: number;
  byType: Record<string, ApiConstellationTypeCounts>;
  excludedByType: Record<string, number>;
}

export interface ApiConstellation {
  memoryRevision: number;
  nodeCeiling: number;
  edgeCeiling: number;
  nodes: ApiConstellationNode[];
  edges: ApiConstellationEdge[];
  omitted: ApiConstellationOmitted;
  /** Optional during rolling deploys from pre-PLNR-339 API workers. */
  sampling?: ApiConstellationSampling;
  coverage: ApiGraphCoverage;
}

export type ApiGraphEntitySort = 'newest' | 'connected' | 'authority' | 'label';
export interface ApiGraphEntityPageInput {
  cursor?: string;
  limit?: number;
  sort?: ApiGraphEntitySort;
  type?: string;
  connectedOnly?: boolean;
  kind?: string;
  minAuthority?: number;
  validity?: string;
}
export interface ApiGraphEntityPage {
  memoryRevision: number;
  sort: ApiGraphEntitySort;
  items: ApiConstellationNode[];
  nextCursor: string | null;
  total: number;
  byType: Record<string, number>;
}
