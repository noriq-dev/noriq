import { z } from 'zod';

/** Executor/human testimony. Noriq records evidence; it does not run these checks. */
export const AssessmentInput = z.object({
  purpose: z.enum(['readiness', 'implementation', 'document']),
  outcome: z.enum(['passed', 'failed', 'inconclusive']),
  scope: z.enum(['repository', 'non_code']),
  summary: z.string().trim().min(10).max(4000),
  repositoryKey: z.string().trim().min(1).max(500).optional(),
  branch: z.string().trim().min(1).max(500).optional(),
  baseId: z.string().trim().min(1).max(500).optional(),
  evidence: z.array(z.object({
    kind: z.enum(['inspection', 'test', 'ci', 'human_review']),
    reference: z.string().trim().min(1).max(2000),
    result: z.string().trim().min(1).max(4000),
  })).min(1).max(30),
}).superRefine((value, ctx) => {
  if (value.scope === 'repository' && (!value.repositoryKey || !value.branch || !value.baseId)) {
    ctx.addIssue({ code: 'custom', message: 'Repository assessments require repositoryKey, branch, and baseId' });
  }
});
export type AssessmentInput = z.infer<typeof AssessmentInput>;
export type AssessmentRecord = AssessmentInput & {
  id: string; subjectType: 'task' | 'plan' | 'doc'; subjectId: string;
  contentFingerprint: string; contextFingerprint: string;
  actorKind: string; actorId: string; actorName: string; createdAt: string;
  provenance: 'actor_reported';
};
export type AssessmentState = {
  required: boolean;
  contextFingerprint: string;
  readiness: { state: 'missing' | 'stale' | 'passed' | 'failed' | 'inconclusive'; record: AssessmentRecord | null };
  overrides?: ReadinessOverrideRecord[];
  implementation: { state: 'missing' | 'stale' | 'passed' | 'failed' | 'inconclusive'; record: AssessmentRecord | null };
};

export const ReadinessOverrideInput = z.object({
  subjectId: z.string().min(1).describe('Task id; must identify a task in this project'),
  scope: z.enum(['readiness', 'implementation']).describe('readiness permits starting; implementation permits completion'),
  reason: z.string().trim().min(10).max(2000).describe('Risk acceptance reason, 10-2000 characters'),
  durationSeconds: z.number().int().min(60).max(86400).describe('Expiry duration in seconds, 60 to 86400 (one day)'),
  repositoryKey: z.string().trim().min(1).optional().describe('Optional non-empty repository scope or revision identifier'),
  branch: z.string().trim().min(1).optional().describe('Optional non-empty repository scope or revision identifier'),
  baseId: z.string().trim().min(1).optional().describe('Optional non-empty repository scope or revision identifier'),
});
export type ReadinessOverrideInput = z.infer<typeof ReadinessOverrideInput>;
export type ReadinessOverrideRecord = { id: string; scope: 'readiness' | 'implementation'; reason: string;
  actorKind: string; actorId: string; actorName: string; createdAt: string; expiresAt: string;
  contextFingerprint: string; revision: { repositoryKey?: string; branch?: string; baseId?: string } | null;
};
