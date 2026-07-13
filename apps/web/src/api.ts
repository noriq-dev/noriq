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
  setProjectMeta: (pid: string, meta: { groupId?: string | null; description?: string; name?: string }) =>
    req('PATCH', `/api/projects/${pid}/meta`, meta),

  users: () => req<{ users: ApiUser[] }>('GET', '/api/users'),
  createUser: (email: string, name: string, password: string, role: string) =>
    req<{ id: string }>('POST', '/api/users', { email, name, password, role }),
  patchUser: (uid: string, patch: { role?: string; disabled?: boolean; name?: string }) =>
    req('PATCH', `/api/users/${uid}`, patch),
  resetPassword: (uid: string) => req<{ tempPassword: string }>('POST', `/api/users/${uid}/reset-password`),
  changePassword: (current: string, next: string) => req('POST', '/api/auth/change-password', { current, next }),

  patchGroup: (gid: string, patch: { name?: string; description?: string }) => req('PATCH', `/api/groups/${gid}`, patch),
  deleteGroup: (gid: string) => req('DELETE', `/api/groups/${gid}`),
  createCategory: (pid: string, name: string) => req<{ id: string }>('POST', `/api/projects/${pid}/categories`, { name }),

  agents: () => req<{ agents: ApiAgent[] }>('GET', '/api/agents'),
  agentEvents: (aid: string) => req<{ events: ApiAgentEvent[] }>('GET', `/api/agents/${aid}/events`),
  createAgent: (name: string, role: string) =>
    req<{ id: string; name: string; role: string; apiKey: string }>('POST', '/api/agents', { name, role }),
  revokeAgent: (aid: string) => req('POST', `/api/agents/${aid}/revoke`),

  createMilestone: (pid: string, title: string, dueAt?: string) =>
    req<{ id: string }>('POST', `/api/projects/${pid}/milestones`, { title, dueAt }),
  createTask: (pid: string, input: { title: string; body?: string; priority?: number; milestoneId?: string; category?: string }) =>
    req<{ id: string; key: string }>('POST', `/api/projects/${pid}/tasks`, input),
  updateTask: (pid: string, tid: string, patch: Record<string, unknown>) =>
    req('PATCH', `/api/projects/${pid}/tasks/${tid}`, patch),
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
  groupId: string | null;
}

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: number;
  createdAt: string;
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
}

export interface ApiAgentEvent {
  id: string;
  projectId: string;
  seq: number;
  verb: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ApiSnapshot {
  project: { id: string; key: string; name: string; description: string; claimTtlSeconds: number };
  tasks: Array<{
    id: string; key: string; title: string; body: string; status: string; priority: number;
    claimedBy: string | null; claimExpiresAt: string | null; parentTaskId: string | null;
    milestoneId: string | null; categoryId: string | null; openComments: number; order: number;
  }>;
  dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
  agents: Array<{ id: string; name: string; role: string; status: string; lastSeenAt: string | null }>;
  milestones: Array<{ id: string; title: string; dueAt: string | null; order: number }>;
  plans: Array<{ id: string; agentId: string | null; title: string; description: string; createdAt: string }>;
  phases: Array<{ id: string; planId: string; title: string; order: number }>;
  phaseTasks: Array<{ phaseId: string; taskId: string }>;
  categories: Array<{ id: string; name: string; color: string; order: number }>;
  events: Array<{
    id: string; seq: number; actorKind: 'agent' | 'human' | 'system'; actorId: string; verb: string;
    subjectType: string; subjectId: string; payload: Record<string, unknown>; createdAt: string;
  }>;
}

export interface ApiTaskDetail {
  task: Record<string, unknown>;
  comments: Array<{
    id: string; authorKind: string; authorId: string; kind: string; body: string; status: string; createdAt: string;
  }>;
  refs: Array<{ kind: string; ref: string; url: string | null; state: string | null }>;
}
