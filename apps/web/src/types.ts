// View-model types for the SPA — the shape the live store feeds the components.

export type TaskStatus =
  | 'todo'
  | 'claimed'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'failed'
  // A run agent's spun-off task awaiting human accept/reject (PLNR-230) — derived
  // server-side from proposedAt; inert to agents until accepted.
  | 'proposed'
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
  /** Does this task carry an execution spec (RUN-162)? A BOOLEAN, not the spec: approving a plan
   *  approves what its tasks say, so the board needs to count the unplanned ones — and shipping
   *  every spec through the snapshot to draw a number would be the whole feature's payload for it.
   *  The spec itself is a detail read. */
  specPlanned: boolean;
  /** Spin-off surface (PLNR-230): set only on a task filed via spin_off_task. proposedAt
   *  non-null = still awaiting the human accept/reject decision. */
  proposedAt: string | null;
  spinoffRunId: string | null;
  spinoffSourceTaskId: string | null;
  spinoffFinding: string | null;
  /** Dispatch-workflow override (PLNR-240): the plan pump runs this task under it; null =
   *  the dispatch's default, then the built-in build. */
  workflow: string | null;
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
  /** ISO timestamp from e.createdAt (t drops the date) — drives feed day-break separators (PLNR-227). */
  createdAt: string;
  /** Swatch rendered before the subject — e.g. a created tag's color (PLNR-130). */
  dot?: string;
}

export type ViewId = 'home' | 'control' | 'graph' | 'board' | 'plans' | 'roadmap' | 'review' | 'docs' | 'ask' | 'agents' | 'runs' | 'settings' | 'admin';

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
