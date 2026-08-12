// PLNR-240: one place that answers "which workflow names may a dispatch select for this
// repo record". Used by BOTH dispatch doors (index.ts) and the plan-dispatch pump
// (ProjectRoom.ts) — the same rule wearing two call sites, kept from drifting apart.

/** A stored runner repo's advertised workflow entries: bare RUN-121 names from older
 *  daemons, or {name, base, description} from PLNR-240 ones. */
export type AdvertisedWorkflowEntry = string | {
  name: string;
  base?: string;
  capabilities?: string[];
};

/** The dispatchable workflow names for a repo record: everything it advertises plus the
 *  three built-ins, which are always available and never listed (RUN-121). */
export function advertisedWorkflowNames(repo: { workflows?: AdvertisedWorkflowEntry[] }): Set<string> {
  const names = new Set<string>(['scope', 'build', 'verify']);
  for (const w of repo.workflows ?? []) names.add(typeof w === 'string' ? w : w.name);
  return names;
}

/** Whether a named rich workflow advertises an exact posture + protocol capability. Bare legacy
 * names deliberately never satisfy this: a server cannot infer a mission harness from a name. */
export function workflowSupports(
  repo: { workflows?: AdvertisedWorkflowEntry[] },
  workflow: string,
  base: string,
  capability: string,
): boolean {
  const offer = (repo.workflows ?? []).find((entry) => typeof entry !== 'string' && entry.name === workflow);
  return typeof offer !== 'string'
    && offer?.base === base
    && (offer.capabilities ?? []).includes(capability);
}
