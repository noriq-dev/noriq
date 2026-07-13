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
  me: () => req<{ user: import('./types').UserVM }>('GET', '/api/auth/me'),
  login: (email: string, password: string) =>
    req<{ user: import('./types').UserVM }>('POST', '/api/auth/login', { email, password }),
  logout: () => req('POST', '/api/auth/logout'),

  projects: () => req<{ projects: ApiProject[] }>('GET', '/api/projects'),
  snapshot: (pid: string) => req<ApiSnapshot>('GET', `/api/projects/${pid}/snapshot`),
  taskDetail: (tid: string) => req<ApiTaskDetail>('GET', `/api/tasks/${tid}`),

  createProject: (key: string, name: string, description?: string) =>
    req<{ id: string; key: string }>('POST', '/api/projects', { key, name, description }),
  createTask: (pid: string, input: { title: string; body?: string; priority?: number }) =>
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
}

export interface ApiSnapshot {
  project: { id: string; key: string; name: string; description: string; claimTtlSeconds: number };
  tasks: Array<{
    id: string; key: string; title: string; body: string; status: string; priority: number;
    claimedBy: string | null; claimExpiresAt: string | null; parentTaskId: string | null;
    milestoneId: string | null; openComments: number; order: number;
  }>;
  dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
  agents: Array<{ id: string; name: string; role: string; status: string; lastSeenAt: string | null }>;
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
