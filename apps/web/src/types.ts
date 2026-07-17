// View-model types for the SPA — the shape the live store feeds the components.

export type TaskStatus =
  | 'todo'
  | 'claimed'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'failed'
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
  ownerName?: string | null;
  agentCount?: number;
  isPublic?: boolean;
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
  priority: number;
  estimate: number | null;
  dueAt: string | null;
  deps: string[];
  /** Task ids in earlier phases of this task's plan — phase-order gating (PLNR-163). */
  phaseDeps: string[];
  milestoneId: string | null;
  boardId: string | null;
  tagIds: string[];
  type: string;
  openComments: number;
  archivedAt: string | null;
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
  /** Swatch rendered before the subject — e.g. a created tag's color (PLNR-130). */
  dot?: string;
}

export type ViewId = 'home' | 'control' | 'graph' | 'board' | 'plans' | 'roadmap' | 'review' | 'docs' | 'agents' | 'runs' | 'settings' | 'admin';

export interface BoardVM {
  id: string;
  name: string;
  order: number;
}

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
