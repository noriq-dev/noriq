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

  projects: () => req<{ projects: ApiProject[] }>('GET', '/api/projects'),
  snapshot: (pid: string) => req<ApiSnapshot>('GET', `/api/projects/${pid}/snapshot`),
  taskDetail: (tid: string) => req<ApiTaskDetail>('GET', `/api/tasks/${tid}`),

  createProject: (key: string, name: string, description?: string) =>
    req<{ id: string; key: string }>('POST', '/api/projects', { key, name, description }),
  groups: () => req<{ groups: Array<{ id: string; name: string; description: string }> }>('GET', '/api/groups'),
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

  authSessions: () => req<{ sessions: Array<{ id: string; clientName: string; scope: string; createdAt: string; expiresAt: string; agentCount: number; lastActive: string | null }> }>('GET', '/api/auth/sessions'),
  revokeSession: (id: string) => req('POST', `/api/auth/sessions/${id}/revoke`),
  revokeAllSessions: () => req('POST', '/api/auth/sessions/revoke-all'),

  patchGroup: (gid: string, patch: { name?: string; description?: string }) => req('PATCH', `/api/groups/${gid}`, patch),
  deleteGroup: (gid: string) => req('DELETE', `/api/groups/${gid}`),
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

  updateMilestone: (pid: string, mid: string, patch: { title?: string; dueAt?: string | null }) =>
    req('PATCH', `/api/projects/${pid}/milestones/${mid}`, patch),
  createMilestone: (pid: string, title: string, dueAt?: string) =>
    req<{ id: string }>('POST', `/api/projects/${pid}/milestones`, { title, dueAt }),
  createTask: (pid: string, input: { title: string; body?: string; priority?: number; milestoneId?: string; tags?: string[]; type?: string }) =>
    req<{ id: string; key: string }>('POST', `/api/projects/${pid}/tasks`, input),
  updateTask: (pid: string, tid: string, patch: Record<string, unknown>) =>
    req('PATCH', `/api/projects/${pid}/tasks/${tid}`, patch),
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
};

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
    milestoneId: string | null; openComments: number; order: number;
  }>;
  dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
  agents: Array<{ id: string; name: string; role: string; status: string; lastSeenAt: string | null; ownerName: string | null; parentAgentId: string | null }>;
  milestones: Array<{ id: string; title: string; dueAt: string | null; order: number }>;
  plans: Array<{ id: string; agentId: string | null; title: string; description: string; body: string; createdAt: string }>;
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
