// PLNR-262: storage-free mapping from an activated generation's staged entities/edges into
// graph nodes/edges — the same split as ingest.ts/backup.ts/restore.ts/graph-queries.ts: this
// module never opens ctx.storage. ProjectMemory reads staged rows, calls these pure functions to
// decide what's valid and what correlates, and does the actual SQL writes itself (bulk, one
// transaction, one summary outbox event — never per-entity writeNode/writeEdge calls).
//
// PLNR-283 adds two more pure mappings, same discipline: a coordination event -> the ONE graph
// node it projects (`mapCoordinationEvent`), and a classified evidence citation -> the node(s) it
// names plus the edge type linking a memory to them (`evidenceCitationNodes`). ProjectMemory
// still owns every actual `nodes`/`edges` write — these functions only decide WHAT to write.
import { MemoryNode, MemoryEdgeType, buildEntityUri, type EntityRef } from '@noriq-dev/shared';
import type { EvidenceCitation } from './writes';

export interface StagedEntityForProjection {
  uri: string;
  type: string;
  label: string;
  content: string | null;
}

export interface StagedEdgeForProjection {
  type: string;
  fromUri: string;
  toUri: string;
}

export interface ProjectionPlan {
  validEntities: StagedEntityForProjection[];
  invalidEntities: Array<{ uri: string; reason: string }>;
  validEdges: StagedEdgeForProjection[];
  invalidEdges: Array<{ edge: StagedEdgeForProjection; reason: string }>;
}

/**
 * Validate staged rows BEFORE any SQL write. `MemoryNode`'s cross-project URI refinement is
 * otherwise dead code — `writeNode` performs no zod validation on its loose string inputs — so
 * this is the first real enforcement of "a uri's embedded projectKey must match this project."
 * An invalid entity is skipped, not thrown: one malformed staged row must not abort projecting
 * everything else a generation validated cleanly. Only the EXISTING MemoryEdgeType vocabulary
 * may ever be written — an edge type outside it is skipped the same way.
 */
export function planProjection(
  projectKey: string,
  entities: StagedEntityForProjection[],
  edges: StagedEdgeForProjection[],
): ProjectionPlan {
  const validEntities: StagedEntityForProjection[] = [];
  const invalidEntities: Array<{ uri: string; reason: string }> = [];
  for (const e of entities) {
    const parsed = MemoryNode.safeParse({ id: 'validate', projectKey, type: e.type, uri: e.uri, label: e.label });
    if (parsed.success) validEntities.push(e);
    else invalidEntities.push({ uri: e.uri, reason: parsed.error.issues[0]?.message ?? 'invalid staged entity' });
  }
  const validEntityUris = new Set(validEntities.map((e) => e.uri));
  const validEdgeTypes = new Set<string>(MemoryEdgeType.options);
  const validEdges: StagedEdgeForProjection[] = [];
  const invalidEdges: Array<{ edge: StagedEdgeForProjection; reason: string }> = [];
  for (const e of edges) {
    if (!validEdgeTypes.has(e.type)) {
      invalidEdges.push({ edge: e, reason: `edge type "${e.type}" is not in MemoryEdgeType` });
    } else if (!validEntityUris.has(e.fromUri) || !validEntityUris.has(e.toUri)) {
      // Referential integrity was already checked at stage time (PLNR-261's
      // indexStagingIntegrityProblems) against ALL staged entities — this narrower check is
      // against only the entities that passed validation ABOVE, since an entity can fail
      // projection validation (bad type/uri) independently of staging validation.
      invalidEdges.push({ edge: e, reason: 'endpoint entity failed projection validation' });
    } else {
      validEdges.push(e);
    }
  }
  return { validEntities, invalidEntities, validEdges, invalidEdges };
}

/**
 * Index-derived co-change (§ discretion, no episodes exist yet — PLNR-263 adds the run-evidence
 * half): files whose presence changed (added to, or removed from, the repository) together
 * between two CONSECUTIVE generations of the same repository are observed to have "changed
 * together" in that reindex — the only correlation signal available before real episodes exist.
 */
export function changedFileUris(prevFileUris: ReadonlySet<string>, newFileUris: ReadonlySet<string>): string[] {
  const changed = new Set<string>();
  for (const u of prevFileUris) if (!newFileUris.has(u)) changed.add(u);
  for (const u of newFileUris) if (!prevFileUris.has(u)) changed.add(u);
  return [...changed];
}

/** Bounded: beyond the cap this returns NO pairs rather than a partial, silently-truncated set —
 *  the caller logs why (a changed set this large is not a "these files are related" signal, it's
 *  a full reindex or a mass rename). */
export const CO_CHANGE_PAIR_CAP = 20;

export function coChangePairs(changed: string[]): Array<[string, string]> {
  if (changed.length < 2 || changed.length > CO_CHANGE_PAIR_CAP) return [];
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < changed.length; i++) {
    for (let j = i + 1; j < changed.length; j++) pairs.push([changed[i]!, changed[j]!]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// PLNR-283: coordination projector + evidence-citation graph mapping
// ---------------------------------------------------------------------------

/** What `ProjectMemory.upsertGraphNode` needs to write one node — never the DO's own row shape
 *  (no minted id, no `created_at`): the caller decides those at write time. */
export interface ProjectedNodeDescriptor {
  type: string;
  uri: string;
  label: string;
}

/**
 * One graph edge `applyCoordinationEvent` draws (or removes) from a single event's payload —
 * PLNR-316. Both endpoints carry a FULL node descriptor, never a bare node id (locked decision):
 * the projector cannot read D1 mid-transaction to discover a node it has not seen, so each
 * endpoint is upserted-or-stubbed in the SAME `transactionSync` block the edge itself is written
 * in — a missing endpoint is never a reason to skip the edge, and `upsertGraphNode`'s
 * `ON CONFLICT (uri)` refines the stub's label the moment a better-labelled event for that same
 * uri lands. `op: 'unlink'` is a removal: its endpoints are only LOOKED UP, never created —
 * stubbing a node purely to immediately delete an edge that references it would be pointless
 * churn, and finding neither endpoint just means there is nothing to unlink (already-idempotent
 * no-op). `provenance` names the verb that produced the edge (locked decision: e.g.
 * `event:task.claimed`) — the same mechanism `linkGraphEdge` already gives `recordMemory`'s
 * evidence edges (`evidence:<id>`) and `rebuildProjection`'s backfill edges
 * (`coordination:phase_tasks` etc.), so a later drift check can tell which source wrote which
 * edge.
 */
export interface ProjectedEdgeDescriptor {
  type: MemoryEdgeType;
  from: ProjectedNodeDescriptor;
  to: ProjectedNodeDescriptor;
  op: 'link' | 'unlink';
  provenance: string;
}

/**
 * What one coordination event projects (PLNR-316 widens PLNR-283's node-only shape): its own
 * node — non-null only for a `*.created` arm, since an edge-only verb like `task.claimed` names
 * no NEW entity, only a relationship between entities that already have (or get stubbed) nodes —
 * plus zero or more edges. `node` and `edges` are independent so a verb can project a node with
 * no edges (unchanged from before this task), edges with no new top-level node (the edge's own
 * endpoint descriptors already carry `upsertGraphNode` everything it needs), or, in principle,
 * both.
 *
 * `removeNodeUri` (PLNR-317) is the third, mutually-exclusive shape: a `*.deleted`/`.rejected`
 * arm for a coordination entity whose D1 row is genuinely gone sets ONLY this — `node`/`edges`
 * stay null/empty, since there is nothing left to create or link. Optional rather than a required
 * third field alongside `node`: only the handful of delete arms below ever set it, and every
 * pre-existing arm's `{ node, edges }` literal is unaffected. `ProjectMemory.applyCoordinationEvent`
 * removes the node's every incident edge before the node row itself (the DO's `edges` table has a
 * `NOT NULL REFERENCES nodes(id)` on both endpoints, and Durable Object SQLite enforces foreign
 * keys unconditionally — CLAUDE.md — so the edges must go first or the node delete itself would
 * raise `SQLITE_CONSTRAINT`). Never set for `memory` (§12: a memory is superseded or invalidated,
 * never destructively erased) — no delete verb below names a memory's uri, so that boundary holds
 * by construction, not by a runtime check here.
 */
export interface CoordinationProjection {
  node: ProjectedNodeDescriptor | null;
  edges: ProjectedEdgeDescriptor[];
  removeNodeUri?: string;
}

export interface CoordinationEventForProjection {
  verb: string;
  subjectId: string;
  payload: Record<string, unknown>;
}

/**
 * Which coordination verbs project a node and/or edges, and what they project (§4/§5) — the D1
 * event log's payload alone must carry everything needed; there is no second D1 read from inside
 * `applyCoordinationEvent`'s transaction (its projection write and cursor advance commit
 * together, and a `ctx.storage.transactionSync` block cannot await one). `task.created` is the
 * pre-existing arm (PLNR-247); `plan.created`/`doc.created`/`milestone.created` are PLNR-283;
 * `task.claimed` and the claim-ending/handoff verbs are PLNR-316; `dependency.added`/`dependency.removed`/
 * `run.created` are PLNR-322. `agent.registered` is deliberately ABSENT — no code anywhere in
 * this repo ever emits it (see this task's execution spec: "project ... milestones/agents WHERE
 * AN EVENT EXISTS"), so there is nothing to hook. Agents still gain graph nodes through
 * `rebuildProjection`'s live D1 read, which needs no event at all; a claim edge's agent endpoint
 * is stubbed (labelled with its own id — no display name
 * rides either payload) until that reconciliation corrects it, same as any other stub. Every
 * other verb returns null — acknowledged (the cursor still advances past it), no projection —
 * exactly the original task.created-only projector's posture, widened rather than replaced
 * (discretion: "cover what the constellation needs to be legible, not the whole verb catalogue").
 *
 * A project doc rides the `artifact` node type, not a new `doc` type (locked decision — the
 * `nodes.type` CHECK constraint permits no such value); a milestone has neither a dedicated node
 * type nor an `EntityRef` arm, so it rides the generic `unknown` catch-all, which — unlike
 * `EXEMPT_NODE_TYPES`'s project/branch/revision/error — DOES have an addressable EntityRef arm
 * (`kind: 'unknown'`), so a milestone node stays independently retrievable by uri.
 *
 * PLNR-316 found it could NOT project an edge for `dependency.added`/`dependency.removed` or
 * `run.created`, despite that task's own body naming all three as verbs "already fully described
 * by payloads the system emits TODAY" — verifying each payload at its ProjectRoom.ts emit site
 * showed that assumption was false for both: the dependency verbs named the blocker only by its
 * display key (`{ key, dependsOn, dependsOnProjectId? }`), and `run.created` named its anchor
 * only by type (`{ kind, agentTool, repoRef, anchor: anchorType }`) — `dep.id`/`anchorId` were in
 * scope at each emit call site but never serialized. Building an edge endpoint from a KEY or a
 * bare TYPE STRING instead of an id would mint a uri (`noriq://task/{key}`, or no id-addressable
 * uri at all) that can never converge with the canonical id-keyed node `task.created`/
 * `rebuildProjection` write for the same entity — a permanent orphan duplicate star. PLNR-316
 * correctly refused rather than invent a field or silently skip with no trace, and pinned the old
 * payload shapes in regression tests.
 *
 * PLNR-319 widens it again for the two relationships `rebuildProjection` could draw from D1 but
 * no event ever named: plan phase membership (`phase_tasks`) and task<->doc attachment
 * (`task_docs`). `plan.tasks_linked`/`plan.tasks_unlinked` and `task.docs_linked`/
 * `task.docs_unlinked` all share one payload shape — `{ links: Array<{...}> }` — because
 * ProjectRoom.ts's write sites vary in which side is "the one" and which is "the many" (a single
 * task joining one plan via `create_task`'s `phaseId`; forty tasks joining one plan via
 * `create_plan`; one task's whole doc set replacing via `update_task`'s `docIds`; one doc's every
 * attachment severing via `deleteDoc`'s cascade). Rather than build edges from `ev.subjectId` and
 * special-case which endpoint that names, EVERY link item carries BOTH endpoint ids (and, where
 * the writer already had them, both labels) — `ev.subjectId` is bookkeeping for the event's own
 * feed only, never read here. This is the SAME direction `rebuildProjection`'s `phase_tasks`/
 * `task_docs` loops draw (`related_to`, from the task to the plan/doc) and the SAME `related_to`
 * edge type (locked decision: no new `MemoryEdgeType`) — only the provenance grammar differs
 * (`event:<verb>` here vs `coordination:phase_tasks`/`coordination:task_docs` there), exactly the
 * precedent `dependency.added`/`.removed` already set (`event:dependency.added` vs
 * `coordination:dependencies`) two paragraphs up: `linkGraphEdge`'s `ON CONFLICT ... DO NOTHING`
 * never overwrites an existing edge's provenance, so the two writers converging on the same
 * `(type, from, to)` triple is what matters, not matching strings.
 *
 * PLNR-322 is that widening: `ProjectRoom.ts` now serializes `dependsOnId` (alongside the
 * unchanged `key`/`dependsOn`) and `anchorId` (alongside the unchanged `anchor`), so all three
 * verbs project edges below, built from ids exactly like every other arm here.
 *   - `dependency.added`/`dependency.removed` project a `depends_on` edge from the DEPENDENT task
 *     (`ev.subjectId`) to its blocker (`payload.dependsOnId`) — link/unlink respectively — matching
 *     the `dependencies` table's own `(task_id, depends_on_task_id)` direction (locked decision).
 *     A CROSS-PROJECT blocker (`payload.dependsOnProjectId` present) projects NO edge (discretion,
 *     chosen): this `ProjectMemory` DO is project-scoped, so a stub node for a foreign task would
 *     be an unreachable star this project can never resolve, label, or repair. The widened id
 *     still rides the payload either way — only the edge is skipped. `rebuildProjection` makes the
 *     identical choice by construction (see its own doc comment) rather than by a second check
 *     here, so the two writers cannot drift apart on this decision.
 *   - `dependency.unblocked` is deliberately NOT projected (discretion, checked): its payload
 *     (`ProjectRoom.ts`'s `onExternalBlockerSettled`) is `{ key, title, blockerKey }` — no id at
 *     all, so it could not be widened the same way without a second follow-up. More fundamentally,
 *     it names no relationship an edge should represent: the `depends_on` edge it would draw
 *     already exists (written by the earlier `dependency.added`), and unblocking never removes a
 *     `dependencies` row — a blocker finishing changes claim-gate READINESS, not graph structure.
 *   - `run.created` projects its own `run` node (the `*.created` pattern every other arm here
 *     follows) labelled `"<kind> run"` (payload carries no title), PLUS a `related_to` edge from
 *     that run to its anchor (`payload.anchorId`/`payload.anchor`) when the run is anchored to a
 *     task or plan — an unanchored run (`anchor`/`anchorId` both null) projects the node only.
 *     `related_to` is the honest default edge type here (discretion) — no more specific verb
 *     ("runs against", "targets") is in `MemoryEdgeType`, and adding one is out of scope (locked
 *     decision: no new `MemoryEdgeType`). Deliberately NOT extended to `rebuildProjection`: that
 *     rebuild does not project run nodes at all today (PLNR-263's `recordEpisode` is the only
 *     other run-node writer, and only at episode ingest, well after `run.created`), so a
 *     rebuild-vs-incremental convergence gap already exists for every run edge independent of
 *     this change; closing it is a pre-existing gap, not one this task introduces, and is left
 *     to whoever gives `rebuildProjection` run coverage.
 *
 * PLNR-317 adds the delete side: `task.deleted`/`doc.deleted`/`plan.deleted`/`milestone.deleted`
 * each set `removeNodeUri` to the exact uri their own `*.created` arm above would have built for
 * the same `ev.subjectId` — every one of these emit sites (`ProjectRoom.ts`) names the deleted
 * row's own id as `subjectId` (verified at each call site, not assumed), so no payload field is
 * needed at all, only the verb and the subject id already on every event. `plan.rejected` gets
 * the SAME treatment as `plan.deleted` (discretion, chosen, and a deliberate widening beyond this
 * task's own body text): `ProjectRoom.ts.rejectPlan` hard-deletes the `plans` row exactly like
 * `deletePlan` does — same `DELETE FROM plans WHERE id = ?` — but names the row's death
 * `plan.rejected`, not `plan.deleted`; leaving that arm unhandled would keep the exact dangling
 * star this task exists to close for the one plan lifecycle path (proposal → rejected) that
 * hard-deletes without the `.deleted` verb. `plan_doc.deleted` is deliberately NOT handled: no
 * `plan_doc.created` arm exists above (plan-local docs are never indexed, never projected —
 * CLAUDE.md), so no plan-doc node is ever written for `plan_doc.deleted` to remove — handling it
 * would be a no-op arm for a node that never existed (discretion: "only verbs whose nodes the
 * projector actually creates").
 *
 * `ProjectRoom.ts`'s own delete sites (`deleteTask`/`deleteDoc`/`deletePlan`/`rejectPlan`) ALSO
 * emit `plan.tasks_unlinked`/`task.docs_unlinked` for the same deletion (PLNR-319) — at every one
 * of those call sites the `.deleted`/`.rejected` verb is emitted BEFORE the unlink verb (verified
 * at each site), so the projector (which consumes a project's events strictly in `global_seq`
 * order) always applies node removal FIRST. By the time the later unlink event is applied, this
 * node and every edge incident on it — including the very `related_to` edge the unlink event
 * would have unlinked — are already gone: `applyCoordinationEdge`'s unlink branch looks its
 * endpoints up (never stubs them) and does nothing when either is missing, so the redundant
 * unlink event lands as a harmless, already-idempotent no-op, not a second mechanism that could
 * disagree with this one. Kept rather than simplified away in `ProjectRoom.ts` (discretion,
 * chosen): they are a real defence-in-depth floor for the two relationship types the constellation
 * most needs correct if node removal itself ever regresses or a future verb hard-deletes a row
 * via a path this function does not yet cover, and removing them would touch a file (`ProjectRoom.ts`)
 * and an event shape outside this task's own footprint for a benefit (fewer no-op rows) that does
 * not offset the risk of silently dropping that floor.
 */
export function mapCoordinationEvent(ev: CoordinationEventForProjection): CoordinationProjection | null {
  const label = (key: string): string => {
    const v = ev.payload[key];
    return typeof v === 'string' && v.trim() ? v : ev.subjectId;
  };
  switch (ev.verb) {
    case 'task.created':
      return { node: { type: 'task', uri: buildEntityUri({ kind: 'task', id: ev.subjectId }), label: label('title') }, edges: [] };
    case 'plan.created':
      return { node: { type: 'plan', uri: buildEntityUri({ kind: 'plan', id: ev.subjectId }), label: label('title') }, edges: [] };
    case 'doc.created':
      return { node: { type: 'artifact', uri: buildEntityUri({ kind: 'artifact', id: ev.subjectId }), label: label('name') }, edges: [] };
    case 'milestone.created':
      return { node: { type: 'unknown', uri: buildEntityUri({ kind: 'unknown', id: ev.subjectId }), label: label('title') }, edges: [] };
    case 'task.claimed': {
      // Both run-minted claims (ProjectRoom.ts's `claimAnchorTaskForRun`, payload `{ agentId,
      // expiresAt, by: 'run' }`, no title) and human/agent `claim_task` claims (payload adds
      // `key`/`title`) share this one verb — `label('title')` falls back to the task's own id
      // when title is absent, same fallback every other arm here already uses.
      const agentId = ev.payload.agentId;
      if (typeof agentId !== 'string' || !agentId) return null;
      const task: ProjectedNodeDescriptor = { type: 'task', uri: buildEntityUri({ kind: 'task', id: ev.subjectId }), label: label('title') };
      const agent: ProjectedNodeDescriptor = { type: 'agent', uri: buildEntityUri({ kind: 'agent', id: agentId }), label: agentId };
      return { node: null, edges: [{ type: 'owned_by', from: task, to: agent, op: 'link', provenance: 'event:task.claimed' }] };
    }
    case 'task.released':
    case 'task.requeued':
    case 'task.status_changed':
    case 'signal.raised': {
      // `previousHolder` is `task.claimed_by` read before the corresponding ProjectRoom update
      // clears it, so it names the agent whose claim is ending — never `by` (the actor
      // performing the release, which may be a human overriding another agent's claim, PLNR-116).
      // Discretion: released UNLINKS rather than leaving a stale "still held" edge — `owned_by`
      // here means "currently holds", a live coordination fact, not a historical one (that record
      // already exists, permanently, as the task's effort episode's own `owned_by` edge to the
      // agent that worked it — PLNR-263).
      const agentId = ev.payload.previousHolder;
      if (typeof agentId !== 'string' || !agentId) return null;
      const task: ProjectedNodeDescriptor = { type: 'task', uri: buildEntityUri({ kind: 'task', id: ev.subjectId }), label: label('title') };
      const agent: ProjectedNodeDescriptor = { type: 'agent', uri: buildEntityUri({ kind: 'agent', id: agentId }), label: agentId };
      return { node: null, edges: [{ type: 'owned_by', from: task, to: agent, op: 'unlink', provenance: `event:${ev.verb}` }] };
    }
    case 'task.handed_off': {
      const task: ProjectedNodeDescriptor = { type: 'task', uri: buildEntityUri({ kind: 'task', id: ev.subjectId }), label: label('title') };
      const edges: ProjectedEdgeDescriptor[] = [];
      const previousHolder = ev.payload.previousHolder;
      if (typeof previousHolder === 'string' && previousHolder) {
        const previousAgent: ProjectedNodeDescriptor = {
          type: 'agent', uri: buildEntityUri({ kind: 'agent', id: previousHolder }), label: previousHolder,
        };
        edges.push({ type: 'owned_by', from: task, to: previousAgent, op: 'unlink', provenance: 'event:task.handed_off' });
      }
      const toAgentId = ev.payload.toAgentId;
      if (typeof toAgentId === 'string' && toAgentId) {
        const nextAgent: ProjectedNodeDescriptor = {
          type: 'agent', uri: buildEntityUri({ kind: 'agent', id: toAgentId }), label: label('toName'),
        };
        edges.push({ type: 'owned_by', from: task, to: nextAgent, op: 'link', provenance: 'event:task.handed_off' });
      }
      return edges.length ? { node: null, edges } : null;
    }
    case 'dependency.added':
    case 'dependency.removed': {
      // PLNR-322: `dependsOnId` is the widened field (see this function's doc comment) —
      // `dependsOn` stays the display key, used only as this stub's display label, same
      // fallback-to-a-short-string idiom `task.claimed`'s agent endpoint already uses. A
      // cross-project blocker (`dependsOnProjectId` present) projects no edge at all — chosen,
      // not defaulted; `rebuildProjection`'s dependency loop makes the identical choice by only
      // ever loading THIS project's tasks into its node map.
      if (typeof ev.payload.dependsOnProjectId === 'string') return { node: null, edges: [] };
      const dependsOnId = ev.payload.dependsOnId;
      if (typeof dependsOnId !== 'string' || !dependsOnId) return null;
      const task: ProjectedNodeDescriptor = { type: 'task', uri: buildEntityUri({ kind: 'task', id: ev.subjectId }), label: label('key') };
      const blocker: ProjectedNodeDescriptor = { type: 'task', uri: buildEntityUri({ kind: 'task', id: dependsOnId }), label: label('dependsOn') };
      const op = ev.verb === 'dependency.added' ? 'link' : 'unlink';
      return { node: null, edges: [{ type: 'depends_on', from: task, to: blocker, op, provenance: `event:${ev.verb}` }] };
    }
    case 'run.created': {
      // PLNR-322: a `run` node (this verb's own `*.created` arm), labelled `"<kind> run"` since
      // the payload carries no title — the same naming `recordEpisode` already gives a run node
      // elsewhere (ProjectMemory.ts). PLUS a `related_to` edge to the run's anchor, when it has
      // one: `anchorId` is the widened field, `anchor` (the pre-existing type string) selects
      // which node type the id resolves to.
      const kind = ev.payload.kind;
      const runLabel = typeof kind === 'string' && kind.trim() ? `${kind} run` : ev.subjectId;
      const run: ProjectedNodeDescriptor = { type: 'run', uri: buildEntityUri({ kind: 'run', id: ev.subjectId }), label: runLabel };
      const anchorType = ev.payload.anchor;
      const anchorId = ev.payload.anchorId;
      if ((anchorType !== 'task' && anchorType !== 'plan') || typeof anchorId !== 'string' || !anchorId) {
        return { node: run, edges: [] };
      }
      const anchor: ProjectedNodeDescriptor = { type: anchorType, uri: buildEntityUri({ kind: anchorType, id: anchorId }), label: anchorId };
      return { node: run, edges: [{ type: 'related_to', from: run, to: anchor, op: 'link', provenance: 'event:run.created' }] };
    }
    case 'plan.tasks_linked':
    case 'plan.tasks_unlinked': {
      const raw = ev.payload.links;
      if (!Array.isArray(raw)) return null;
      const op = ev.verb === 'plan.tasks_linked' ? 'link' : 'unlink';
      const edges: ProjectedEdgeDescriptor[] = [];
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue;
        const l = item as Record<string, unknown>;
        const taskId = l.taskId;
        const planId = l.planId;
        if (typeof taskId !== 'string' || !taskId || typeof planId !== 'string' || !planId) continue;
        const taskLabel = typeof l.taskTitle === 'string' && l.taskTitle.trim() ? l.taskTitle : taskId;
        const planLabel = typeof l.planTitle === 'string' && l.planTitle.trim() ? l.planTitle : planId;
        const task: ProjectedNodeDescriptor = { type: 'task', uri: buildEntityUri({ kind: 'task', id: taskId }), label: taskLabel };
        const plan: ProjectedNodeDescriptor = { type: 'plan', uri: buildEntityUri({ kind: 'plan', id: planId }), label: planLabel };
        edges.push({ type: 'related_to', from: task, to: plan, op, provenance: `event:${ev.verb}` });
      }
      return { node: null, edges };
    }
    case 'task.docs_linked':
    case 'task.docs_unlinked': {
      const raw = ev.payload.links;
      if (!Array.isArray(raw)) return null;
      const op = ev.verb === 'task.docs_linked' ? 'link' : 'unlink';
      const edges: ProjectedEdgeDescriptor[] = [];
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue;
        const l = item as Record<string, unknown>;
        const taskId = l.taskId;
        const docId = l.docId;
        if (typeof taskId !== 'string' || !taskId || typeof docId !== 'string' || !docId) continue;
        const taskLabel = typeof l.taskTitle === 'string' && l.taskTitle.trim() ? l.taskTitle : taskId;
        const docLabel = typeof l.docLabel === 'string' && l.docLabel.trim() ? l.docLabel : docId;
        const task: ProjectedNodeDescriptor = { type: 'task', uri: buildEntityUri({ kind: 'task', id: taskId }), label: taskLabel };
        const doc: ProjectedNodeDescriptor = { type: 'artifact', uri: buildEntityUri({ kind: 'artifact', id: docId }), label: docLabel };
        edges.push({ type: 'related_to', from: task, to: doc, op, provenance: `event:${ev.verb}` });
      }
      return { node: null, edges };
    }
    // PLNR-317: the delete side — see this function's own doc comment for the ordering guarantee
    // with `plan.tasks_unlinked`/`task.docs_unlinked`, why `plan.rejected` gets the same
    // treatment as `plan.deleted`, and why `plan_doc.deleted` is deliberately absent.
    case 'task.deleted':
      return { node: null, edges: [], removeNodeUri: buildEntityUri({ kind: 'task', id: ev.subjectId }) };
    case 'doc.deleted':
      return { node: null, edges: [], removeNodeUri: buildEntityUri({ kind: 'artifact', id: ev.subjectId }) };
    case 'plan.deleted':
    case 'plan.rejected':
      return { node: null, edges: [], removeNodeUri: buildEntityUri({ kind: 'plan', id: ev.subjectId }) };
    case 'milestone.deleted':
      return { node: null, edges: [], removeNodeUri: buildEntityUri({ kind: 'unknown', id: ev.subjectId }) };
    default:
      return null;
  }
}

// `hazard` is an `EntityRef` kind with NO `MemoryNodeType` arm (see shared/memory.ts's own
// comment on the asymmetry: a hazard is projected, if at all, as a `memory` graph node, never a
// distinct node type) — every other global entity-citation kind's literal IS already a valid
// node type, so this is the one translation needed.
function nodeTypeForEntityKind(kind: EntityRef['kind']): string {
  return kind === 'hazard' ? 'memory' : kind;
}

/** Every edge `recordMemory` draws from a memory to something its evidence cites — one edge
 *  type, uniformly (discretion: "pick the one that reads truthfully and use it consistently").
 *  `observed_in` reads truthfully whether the cited thing is a file, a task, or a doc: "this
 *  memory was observed in the context of X". */
export const EVIDENCE_EDGE_TYPE: MemoryEdgeType = 'observed_in';

/**
 * A classified evidence citation (`memory/writes.ts`'s `classifyEvidenceCitation`) -> the node(s)
 * it names (§11: "recording writes the memory's node and its typed edges to every entity its
 * evidence cites"). An entity citation (task/plan/run/decision/episode/artifact/agent/…) yields
 * exactly one node, the entity itself. A repository citation yields ONE node for its file, plus a
 * SECOND for its symbol when the citation named one — a symbol-level citation is evidence about
 * the file it lives in too, whether or not the caller also cited the file bare.
 */
export function evidenceCitationNodes(projectKey: string, citation: EvidenceCitation): ProjectedNodeDescriptor[] {
  if (citation.source === 'entity') {
    return [{ type: nodeTypeForEntityKind(citation.ref.kind), uri: buildEntityUri(citation.ref), label: citation.ref.id }];
  }
  const nodes: ProjectedNodeDescriptor[] = [
    {
      type: 'file',
      uri: buildEntityUri({ kind: 'file', projectKey, repositoryKey: citation.ref.repositoryKey, path: citation.ref.path }),
      label: citation.ref.path,
    },
  ];
  if (citation.ref.symbol) {
    nodes.push({
      type: 'symbol',
      uri: buildEntityUri({ kind: 'symbol', projectKey, repositoryKey: citation.ref.repositoryKey, path: citation.ref.path, name: citation.ref.symbol }),
      label: citation.ref.symbol,
    });
  }
  return nodes;
}
