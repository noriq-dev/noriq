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
 *
 * **Scope, stated plainly: this is a rule about the ACTOR, not about one task.** A build or verify
 * agent may not rewrite ANY task's spec, not merely its own anchor's. That is deliberate and it is
 * the narrower thing that is wrong: nothing here can tell which task will end up judging the work
 * — a verify run grades a different run's output, a parent's acceptance criteria bind its
 * children (RUN-148), and a sibling's spec can be edited to move a shared standard. Scoping to
 * the anchor would leave every one of those open while reading as if it were closed. The cost is
 * one real friction: an agent that wants to hand follow-up work a spec must do it when it CREATES
 * the task, which stays unguarded on purpose — writing a contract for work nobody has started is
 * not the same act as editing the one you are being measured by.
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
  `a ${r.runKind} run does not rewrite execution specs — any of them, not just your own task's: ` +
  'a spec\'s lockedDecisions bind you and its acceptance is what your work is judged against, and ' +
  'nothing here can tell which task will end up judging it. If a spec is wrong, say so in a ' +
  'comment (post_comment) and let a human or a scope run correct it. You may still give a spec to ' +
  'a task you CREATE.';
