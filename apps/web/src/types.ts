// View-model types for the SPA. Mirrors @planar/shared enums; the local shape
// is what the mock store (and later the live API adapter) feeds the UI.

export type TaskStatus =
  | 'todo'
  | 'claimed'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'cancelled';

export type CommentKind = 'comment' | 'question' | 'instruction' | 'reply';
export type CommentStatus = 'open' | 'acknowledged' | 'addressed' | 'wont_do';

export interface ProjectVM {
  id: string;
  key: string;
  name: string;
  phase: string;
  dotColor: string;
  badge: string;
}

export interface AgentVM {
  id: string;
  name: string;
  role: 'orch' | 'worker';
  color: string;
}

export interface CommentVM {
  id: number;
  author: string;
  role: 'human' | 'agent';
  kind: CommentKind;
  body: string;
  status: CommentStatus;
}

export interface TaskVM {
  id: number;
  key: string;
  title: string;
  body: string;
  status: TaskStatus;
  claimedBy: string | null;
  ttl?: number;
  ttlMax?: number;
  deps: number[];
  comments: CommentVM[];
}

export interface EventVM {
  id: string;
  t: string;
  actor: string;
  verb: string;
  subject: string;
  taskId?: number;
}

export type ViewId = 'control' | 'graph' | 'board';

export interface AppData {
  projects: ProjectVM[];
  agents: Record<string, AgentVM[]>;
  tasks: Record<string, TaskVM[]>;
  events: Record<string, EventVM[]>;
}
