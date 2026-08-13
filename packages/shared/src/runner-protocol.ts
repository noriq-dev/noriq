import { z } from 'zod';
import { ExecutionSpec } from './execution-spec';

/** A bounded, server-authored task as it existed when a single-root mission was commissioned. */
export const MissionCommissionTask = z.object({
  taskId: z.string().min(1),
  key: z.string().min(1).max(160),
  title: z.string().min(1).max(500),
  body: z.string().max(50_000),
  phaseId: z.string().min(1),
  phaseTitle: z.string().min(1).max(500),
  phaseOrder: z.number().int().nonnegative(),
  taskOrder: z.number().int().nonnegative(),
  priority: z.number().int(),
  type: z.string().min(1).max(80),
  estimate: z.number().nullable(),
  dueAt: z.string().datetime().nullable(),
  workflow: z.string().max(160).nullable(),
  executionSpec: ExecutionSpec.nullable(),
}).strict();
export type MissionCommissionTask = z.infer<typeof MissionCommissionTask>;

export const MissionCommissionDependency = z.object({
  taskId: z.string().min(1),
  dependsOnTaskId: z.string().min(1),
}).strict();
export type MissionCommissionDependency = z.infer<typeof MissionCommissionDependency>;

export const MissionCommissionSnapshot = z.object({
  schemaVersion: z.literal(1),
  commissionId: z.string().min(1),
  runId: z.string().min(1),
  sitting: z.number().int().positive(),
  planId: z.string().min(1),
  planTitle: z.string().min(1).max(500),
  planBody: z.string().max(100_000),
  planRevision: z.string().min(1).max(128),
  commissionedAt: z.string().datetime(),
  tasks: z.array(MissionCommissionTask).min(1).max(256),
  dependencies: z.array(MissionCommissionDependency).max(2_048),
}).strict();
export type MissionCommissionSnapshot = z.infer<typeof MissionCommissionSnapshot>;

export const PlanMissionCommission = z.object({
  digest: z.string().min(1).max(128),
  snapshot: MissionCommissionSnapshot,
}).strict();
export type PlanMissionCommission = z.infer<typeof PlanMissionCommission>;
export const MissionCommission = PlanMissionCommission;
export type MissionCommission = z.infer<typeof MissionCommission>;

export const TaskRootMissionCommissionSnapshot = z.object({
  schemaVersion: z.literal(1),
  commissionId: z.string().min(1),
  runId: z.string().min(1),
  sitting: z.number().int().positive(),
  taskId: z.string().min(1),
  commissionedAt: z.string().datetime(),
  task: z.object({
    taskId: z.string().min(1),
    key: z.string().min(1).max(160),
    title: z.string().min(1).max(500),
    body: z.string().max(50_000),
    priority: z.number().int(),
    type: z.string().min(1).max(80),
    estimate: z.number().nullable(),
    dueAt: z.string().datetime().nullable(),
    workflow: z.string().max(160).nullable(),
    executionSpec: ExecutionSpec.nullable(),
  }).strict(),
}).strict();
export type TaskRootMissionCommissionSnapshot = z.infer<typeof TaskRootMissionCommissionSnapshot>;

export const TaskRootMissionCommission = z.object({
  digest: z.string().min(1).max(128),
  snapshot: TaskRootMissionCommissionSnapshot,
}).strict();
export type TaskRootMissionCommission = z.infer<typeof TaskRootMissionCommission>;

export const MissionRootCommission = z.union([PlanMissionCommission, TaskRootMissionCommission]);
export type MissionRootCommission = z.infer<typeof MissionRootCommission>;
