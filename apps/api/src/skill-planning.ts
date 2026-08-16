/**
 * The planning & execution-spec reference, split out of SKILL_MD by PLNR-310 for progressive
 * disclosure: only an agent about to write a plan or a task's executionSpec needs the full
 * shape — everyone else just needs to know phase order gates claimability. Served at
 * GET /skill/planning.md and as the MCP resource noriq://skill/planning (see mcp.ts). The
 * PLNR-528 refreshed this reference against the live plan/task schemas; see skill.ts for why
 * the guidance-drift scanner still sees the combined surface.
 */
export const PLANNING_SKILL_MD = `---
name: noriq-planning
description: >-
  Plan multi-task Noriq work and hand precise execution contracts to builders: create_plan,
  saved templates, ordered phase gates, plan-local docs, milestones, task dependencies, and
  executionSpec fields. Use before creating or restructuring a plan, scoping tasks, or writing
  and interpreting an executionSpec. Do not use for a single already-scoped task or as
  permission for a build or verify run to rewrite its own acceptance contract.
---

# Planning

Anything bigger than a single task starts with a **plan** — don't open-loop into
claiming. Think the whole pass through first (in plan mode, if your client has one):
the goal, the approach, the phases it breaks into, and the tasks under each. Then
**write that plan into Noriq** so humans can see it coming and workers can drain it.
The plan you'd write in plan mode maps onto \`create_plan\` one-to-one:

- \`body\` — your full written readout in markdown: goals, context, approach,
  constraints, risks, and the **exit gate** (what "done" means). This is the core plan
  a teammate reads to pick the work up. Humans watch it in the Plans view.
- \`phases[]\` (ordered, up to 12) — each a stage of the pass, with its own \`body\`
  (what / how / done-when) and its tasks: \`newTasks\` created inline (title, body,
  priority, type, descriptive tags, related docs, and usually an execution spec) or \`taskIds\`
  for ones that already exist. Every new task needs descriptive tags, either on the task or
  through \`taskDefaults\`; the first tag is its primary topic.

Use \`proposed:true\` when a scope run is handing a plan to a human for approval. Proposed-plan
tasks stay inert until approval. A Copilot creating a plan it is authorized to execute normally
creates an active plan. Repeated shapes belong in \`save_template\` and can be inspected with
\`list_templates\`, then instantiated with \`create_plan.templateId\`.

Phase order is **enforced by the phases themselves**: a task in phase N is claimable
only once every task in earlier phases is settled (done or cancelled) — no dependency edges are created or
needed, the plan IS the gate. Workers (you, later, or others) drain it in sequence via
\`next_claimable\`. Keep the document alive as you go with \`update_plan\` (status,
findings, gotchas, final outcome; pass the full new body, or a \`phaseId\` to revise one
phase). Plans are restructurable too: pass \`phases\` with the complete new shape to
add/remove/move tasks or phases — gating follows the new structure instantly. Never
paper over a structural change with prose alone; fix the structure so the document and
reality agree. Reserve \`dependsOn\`/\`update_tasks.addDependsOn\` for real, hand-picked orderings
outside the phase flow.

## The execution spec

A task's \`executionSpec\` is what the agent that picks it up is handed *before* it starts.
Fill it in whenever you know more about the work than its title and body say — that is almost
always true of the person who just planned it, and almost never true of the agent who claims it
three days later. Without one, every builder spends its earliest and most valuable context
rediscovering the repo, then invents its own scope and its own definition of done.

It carries:

- \`requirementIds\` — what this work satisfies (Noriq task keys, or an external tracker's
  ids), so a line of the diff can be traced back to why it exists.
- \`anticipatedFiles\` — the paths the work is expected to touch (\`path\`, \`change\`,
  \`why\`). Declaring them is how a reviewer, and a human scanning the plan, can see the blast
  radius before anything is spent.
- \`requiredReading\` — repo paths or Noriq doc ids, in the order they help.
- \`lockedDecisions\` — already settled; **do not relitigate**. Give the \`because\`, so the
  constraint is understood rather than merely obeyed: an agent that knows *why* can tell when a
  case genuinely falls outside it.
- \`discretion\` — where the agent may choose for itself. Say it out loud: without it, every
  gap reads as an oversight rather than an invitation.
- \`deferred\` — explicitly not this task's problem, so a reviewer does not flag a known,
  accepted gap as an omission.
- \`acceptance\` — goal-backward, not step-by-step. \`observableTruths\` are statements that
  will be TRUE when the work is done ("a dispatch with no spec still runs"), never steps to
  perform ("run the tests"). \`artifacts\` name a path, what it provides, and the exports it
  must offer. \`links\` (\`from\` → \`to\` → \`via\`) are the wiring, and they catch the
  classic half-done build: every file present, every export defined, nothing calling any of it.

Every field is optional — fill in what you actually know, and leave the rest empty rather than
inventing it. Set it on \`create_tasks\`, on a plan's \`newTasks\`, or later
with \`update_tasks\` (which REPLACES the whole spec — there is no field-level merge).

**Who may write one.** Anyone planning: a human, a copilot, or a **scope** run filing the tasks it
found. Not a **build** or **verify** run on its own task — the spec is what its work is judged
against, and an actor that can edit the standard it is graded by can pass itself. If you are
building and the spec is wrong, say so in a comment and let a human or a scope run correct it; that
is a finding, not an obstacle.

**Reading one:** \`get_task\` returns \`executionSpec\`, and \`get_task_context\` returns it in
the non-truncatable task facts alongside related evidence. If it is there, its
\`lockedDecisions\` bind you and its \`acceptance\` is your definition of done. If
\`executionSpecUnreadable\` is set, the stored spec is corrupt — say so and ask; do not treat
it as "no spec" and plan over it.

For a quick subtree without the ceremony, \`create_tasks\`; for ad-hoc ordering,
\`update_tasks.addDependsOn\` (undo a wrong edge with \`update_tasks.removeDependsOn\`). A dependency may
cross projects: task ids and display keys are globally unique, so \`dependsOn\` and
\`update_tasks.addDependsOn\` accept a blocker from any project you can access, and the claim
gate holds across the boundary exactly as within it. To coordinate
mid-flight, \`send_message\`. See who else is on the project (and what they hold)
with \`list_agents\`, and hand a task to a specific agent with \`handoff_task\` —
directed delegation instead of releasing into the pool. Check progress with
\`get_plans\`.
`;
