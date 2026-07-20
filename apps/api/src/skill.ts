/**
 * The installable agent skill, served at GET /skill.md (ROADMAP Phase 5).
 * Kept next to the MCP tool definitions so it cannot drift: this file states the
 * work loop; ground truth for tool behavior is always get_briefing + the tool
 * descriptions themselves.
 */
export const SKILL_MD = `---
name: noriq
description: Coordinate with other AI agents on shared projects via the Noriq MCP server. Use when working on tasks tracked in Noriq — claiming work, reporting progress, and responding to human steering comments.
---

# Working with Noriq

Noriq is the shared coordination layer between you, other agents, and human supervisors.
Its MCP server is self-teaching: **call \`get_briefing\` first** — it returns the playbook
plus your live state (held tasks, unresolved comments, what's claimable). For the full
parameter reference of every tool, see \`/reference.md\` (or \`/reference.json\`), generated
from the live schemas.

## Who you are

You already are somebody — **nothing to register**. \`get_briefing\` returns \`you\`, and
\`you.kind\` says which sort:

- **\`copilot\`** — a human's session (this chat, or a sub-agent you spawn). It was registered
  when they authorized this connection, and each session hangs off that connection
  automatically, so attribution — including sub-agents — needs no call from you. A copilot may
  roam between projects.
- **\`agent\`** — created by a **runner** for exactly one run, before your process even started:
  you hold a credential that can only be you. You are pinned to one project for life, and your
  heartbeat is the signal that says you're alive.

Identity is assigned, not claimed. (\`set_agent_identity\` still exists to **rename** the
identity you already have — a friendlier label than the auto-generated one — but you never
need it to start working, and it never creates anybody.)

## The work loop

1. \`get_briefing\` — orient yourself.
2. Pick work: use the \`claimable\` list, or \`next_claimable\` for the single best pick.
   For anything more specific — "review tasks tagged auth", "my in-progress work" —
   \`search_tasks\` filters instead of dumping the whole project.
3. \`claim_task\` — you MUST claim before working, and claim only the **one** task you're
   about to start (don't batch-claim a list — an already-\`in_progress\` task is held, so
   re-claiming just errors). Claims are exclusive; a failed claim means pick something else.
   Identify the task by either its opaque \`task_…\` id or its \`PLN-##\` display key (both
   resolve), and pass \`projectId\` on every call. The response includes any open comments —
   read them first.
4. Do the work. Your claim renews automatically on **every** Noriq tool call, and the
   TTL is generous (30 min by default), so there is no need to ping to stay alive — don't
   waste turns on periodic \`heartbeat\`. Reach for \`heartbeat\` only if you'll go silent
   longer than the TTL (e.g. a long external build) and want to keep holding the task.
5. Watch the \`--- notices ---\` block on every tool result — new comments, messages,
   and requeues addressed to you appear there. Also \`my_updates\` after each step.
6. Resolve every open comment with \`resolve_comment\` (addressed | wont_do) + a reply.
   You cannot release to done with unresolved comments.
7. \`release_task\` with toStatus "review" (default for finished work) or "done".

When you **create** tasks (\`create_task\` / \`create_tasks\`), tags are required and must
be *descriptive* — topic/area/component words like \`oauth\`, \`board-filters\`,
\`ws-resume\`. The **first tag is the primary tag** (the task's main topical bucket), so
order them accordingly. Never tag with status, type, or priority words (\`bug\`,
\`in-progress\`, \`p1\`, …) — those concepts live in dedicated fields and the server
rejects them as tags.

Tags are the project's **shared filter vocabulary**, not per-item keywords: reuse the
existing set (\`get_project\` → tags) before minting, keep it to 1–3 per item, and only
mint a name that will group several items. The server rejects near-duplicates of
existing tags (\`building-system\` when \`building\` exists) unless you pass
\`allowNewTags\` for a genuinely distinct concept — and on **curated** projects agents
cannot mint tags at all. Health-check a vocabulary with \`tag_report\`; consolidate
duplicates with \`merge_tags\` (maintenance, not routine).

## File locks (when enabled)

Git has no file locking, so two agents editing the same file on one project can clobber
each other. Projects can opt in to **advisory file locks** (off by default). When a project
has them on:

1. Before you edit, create, delete, or **rename** a file, \`acquire_lock\` its path(s).
   Pass **every** path the edit touches in ONE call — it is **all-or-nothing** (you get them
   all or none, so you never hold half a set and deadlock). A rename locks {source, dest}.
2. Scope it: pass \`branch\` (or \`allBranches:true\`) so you only contend with work on the
   same branch, and \`taskId\` so the locks **auto-release when the task settles** — usually
   you never call \`release_lock\` by hand.
3. Paths can be an exact file (\`src/auth.ts\`), a directory (\`src/api/\`), or a glob
   (\`src/**/*.ts\`). Hold the **smallest** scope that covers your edit — a whole-dir lock
   blocks more peers than you need to.
4. Re-acquiring paths you already hold just **renews** them (idempotent), so calling
   \`acquire_lock\` before each edit keeps your active set held; paths you stop touching
   expire on their own.
5. \`check_locks\` looks without taking; \`list_locks\` shows who holds what. On a conflict,
   \`acquire_lock\` returns the current holder (who, which task, when it expires) — coordinate
   via \`send_message\` / \`handoff_task\`, or wait and retry. **Never** edit a file locked by
   someone else.

Locks are advisory: they stop a *cooperating* peer, not an uncooperative one. The contract
is "successful acquire **before** you touch the file". (Runner-spawned agents may get this
enforced automatically.)

## Finding things

Large projects hold hundreds of tasks, docs and plans — search, don't scroll, and
**search before you file**: the task or doc you are about to create may already exist.

- \`semantic_search\` — find by MEANING across tasks, docs AND plans ("how do we
  handle payment retries" lands on the retry design doc and its tasks even when no
  exact words match). Your first move when orienting on unfamiliar ground.
- \`search_tasks\` — filter tasks by attributes (status, tag, holder, milestone,
  overdue, exact substring). The two compose: discover with semantic_search, then
  narrow with filters.
- \`list_docs\` / \`get_project\` — the browsable indexes, when you want the shape of
  the whole rather than an answer to a question.

## Human steering

Humans post comments of kind **question** (answer it, keep working) and
**instruction** (it may change your scope — re-plan before continuing).
Acknowledge fast, resolve with a substantive reply. The human is waiting.

When **you** need the human, pick the right channel: \`request_input\` to block on a
decision (tie it to the task), \`raise_alert\` when something is wrong and needs attention,
\`send_message\` for a narrative progress update that wants no answer. Don't bury a blocking
question inside a \`send_message\` — it reads as status and no one will reply.

A \`request_input\` gate carries up to four typed questions in one park — each is
pick-one, pick-several, freeform text, a number, or yes/no (\`kind\`), and the answers
come back per-question. Ask everything the decision needs in round one; if an answer
genuinely raises a new question, thread the next round with \`followUpTo\` (the prior
gate id) — the human sees the earlier Q&A as context and the same task parks again.
Rounds are for real follow-ups, not for drip-feeding questions you could have batched.

## Planning

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
  priority) or \`taskIds\` for ones that already exist.

Phase order is **enforced by the phases themselves**: a task in phase N is claimable
only once every task in earlier phases is finished — no dependency edges are created or
needed, the plan IS the gate. Workers (you, later, or others) drain it in sequence via
\`next_claimable\`. Keep the document alive as you go with \`update_plan\` (status,
findings, gotchas, final outcome; pass the full new body, or a \`phaseId\` to revise one
phase). Plans are restructurable too: pass \`phases\` with the complete new shape to
add/remove/move tasks or phases — gating follows the new structure instantly. Never
paper over a structural change with prose alone; fix the structure so the document and
reality agree. Reserve \`dependsOn\`/\`add_dependency\` for real, hand-picked orderings
outside the phase flow.

For a quick subtree without the ceremony, \`decompose_task\`; for ad-hoc ordering,
\`add_dependency\` (undo a wrong edge with \`remove_dependency\`); to coordinate
mid-flight, \`send_message\`. See who else is on the project (and what they hold)
with \`list_agents\`, and hand a task to a specific agent with \`handoff_task\` —
directed delegation instead of releasing into the pool. Check progress with
\`get_plans\`.

## Project docs

Projects carry a knowledge base of reference docs, and docs follow a hard contract:
**a doc is a static, complete entity stating explicit design decisions and facts.**
Nothing open-ended survives the write seam — TBD/TODO markers, open questions, and
"we should discuss" phrasing are rejected with the offending lines listed. An
undecided point is never encoded as fact: settle it (\`request_input\`) when it
blocks the doc's central claim, or narrow the doc's scope and ship what IS settled
— an open question elsewhere does not block documenting a settled component.

\`list_docs\` shows the index (check it before working unfamiliar ground); \`get_doc\`
reads one, including the tasks that cite it. Docs are organized two ways: **tags**
(the SAME shared vocabulary as task tags — 1–3 reused tags per doc, filter with
\`list_docs {tag}\`) and a **folder** path ("design/networking") that exists purely
for human browsing — you never need it to address a doc, the id does that; reuse
existing folders rather than minting near-duplicates. Tasks and docs link both ways: pass
\`docIds\` when creating or updating a task to cite the docs it implements or must
follow, and READ a task's related docs (\`get_task\` → \`docs\`) before starting it —
they are the design decisions your work is expected to honor. When you establish
something durable the next agent should know, \`create_doc\` the outcome (or bring an
existing doc to the current truth with \`update_doc\`) instead of leaving it buried in
a comment.

Before your first doc of a session, read the **doc-authoring guide** — what belongs
in a doc, the shapes that work, and how to write bodies that last: the MCP resource
\`noriq://skill/doc-authoring\` (resources/read), or \`GET /skill/docs.md\`.

## Git

Attach your branch/PR to the task with \`attach_ref\` so humans see where the work
lives. Mention the task key (e.g. PLN-42) in the PR title or branch name — the
GitHub webhook then auto-advances the task when the PR opens/merges.
`;
