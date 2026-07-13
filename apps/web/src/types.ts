// View-model types for the SPA — the shape the live store feeds the components.

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
  hasLive: boolean;
  groupId: string | null;
  openTasks: number;
  totalTasks: number;
  doneTasks: number;
}

export interface AgentVM {
  id: string;
  name: string;
  role: 'orch' | 'worker';
  color: string;
  lastSeenAt: string | null;
  ownerName: string | null;
  parentAgentId: string | null;
}

export interface CommentVM {
  id: string;
  author: string;
  role: 'human' | 'agent';
  kind: CommentKind;
  body: string;
  status: CommentStatus;
}

export interface TaskVM {
  id: string;
  key: string;
  title: string;
  body: string;
  status: TaskStatus;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  ttl?: number;
  ttlMax?: number;
  deps: string[];
  milestoneId: string | null;
  tagIds: string[];
  type: string;
  openComments: number;
  comments: CommentVM[]; // populated for the selected task
}

export interface EventVM {
  id: string;
  t: string;
  actor: string;
  actorKind: 'agent' | 'human' | 'system';
  verb: string;
  subject: string;
  taskId?: string;
}

export type ViewId = 'home' | 'control' | 'graph' | 'board' | 'plans' | 'agents' | 'settings';

export interface AppData {
  projects: ProjectVM[];
  agents: Record<string, AgentVM[]>;
  tasks: Record<string, TaskVM[]>;
  events: Record<string, EventVM[]>;
}

export interface UserVM {
  id: string;
  email: string;
  name: string;
  role: string;
}
