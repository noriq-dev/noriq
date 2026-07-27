/**
 * Who may rewrite a task's execution spec (RUN-160).
 *
 * The spec is the contract a build is judged against: its `lockedDecisions` bind the builder and
 * its `acceptance` is what a reviewer grades. An actor that can edit both can talk its own gate
 * into passing — the same shape as the status door PLNR-192 closed, one field along.
 *
 * A blanket ban on run agents would be wrong, and that is the whole reason this is a function
 * rather than one more `agent.kind === 'agent'` check: a SCOPE run authoring specs for the tasks
 * it files is the entire point of the field, and the runner's planner stage is built on it. The
 * discriminator is what the run was spawned to DO, not that it was spawned.
 */

/** What the caller knows about the actor. `runKind` is null for a copilot, for a human, and for a
 *  run agent whose run has settled or cannot be found. */
export interface SpecWriter {
  /** 'agent' = runner-spawned; 'copilot' = a human's own session. */
  actorKind: string;
  /** The kind of the live run this actor belongs to, if any. */
  runKind: string | null;
}

export interface SpecWriteRefusal {
  /** The run kind that was refused — named in the error so the agent knows why. */
  runKind: string;
}

/**
 * Null = permitted. A refusal names the kind, because "you may not" without "because you are the
 * one being judged" reads as a bug to an agent and it will retry.
 *
 * Deliberately fail-OPEN on an unknown run: an actor with no live run has no gate to talk past, so
 * the strict half is the half that matters. The alternative — refusing every write we cannot
 * attribute — would break copilots, humans, and every agent whose run has ended, to protect
 * nothing.
 */
export function refuseSpecWrite(writer: SpecWriter): SpecWriteRefusal | null {
  if (writer.actorKind !== 'agent') return null;
  if (!writer.runKind || writer.runKind === 'scope') return null;
  return { runKind: writer.runKind };
}

/** The message an agent gets. It names the door that IS open — a refusal with no alternative is a
 *  refusal an agent works around. */
export const specWriteRefusalMessage = (r: SpecWriteRefusal): string =>
  `a ${r.runKind} run does not rewrite its own task's execution spec: its lockedDecisions bind you ` +
  'and its acceptance is what your work is judged against. If the spec is wrong, say so in a ' +
  'comment (add_comment) and let a human or a scope run correct it.';
