/**
 * The installable agent skill's CORE entry point, served at GET /skill.md (ROADMAP Phase 5).
 * Kept next to the MCP tool definitions so it cannot drift: this file states the work loop;
 * ground truth for tool behavior is always get_briefing + the tool descriptions themselves.
 *
 * PLNR-310 split what used to be one 332-line document into this always-relevant core plus
 * on-demand references, so an agent pays only for what it is actually doing: file locking
 * (skill-locking.ts), planning + execution specs (skill-planning.ts), and project memory
 * (skill-memory.ts) — each served at its own GET /skill/<name>.md route and MCP resource
 * (registered in mcp.ts). Doc authoring (skill-docs.ts, PLNR-190) was already its own surface
 * before this task and is unchanged; SKILL_MD points at it exactly as before. Every reference
 * is content MOVED out of the old single document, not rewritten — the settled contracts and
 * their reasoning are unchanged, only where they live.
 *
 * SKILL_MD itself stays useful standalone: it states every rule in short form (identity, the
 * work loop, search, priority, escalation, the docs contract, git) and names where the long
 * form of each split-out topic lives, because a client may fetch it once and never follow a
 * link.
 *
 * The guidance-drift scanner (memory/guidance-drift.ts) compares ONE 'skill_md' surface per
 * CLAUDE.md's four-surfaces constraint. The split must not make it blind to prose that moved
 * into a reference, so SKILL_MD_SURFACE below reassembles core + every reference back into the
 * text the scanner (and its dogfood tests) actually compares — see index.ts's
 * /api/admin/memory-guidance-drift scan route, the one place that gathers it. The split is a
 * serving/loading concern only, never a drift-detection one.
 */
import { LOCKING_SKILL_MD } from './skill-locking';
import { PLANNING_SKILL_MD } from './skill-planning';
import { MEMORY_SKILL_MD } from './skill-memory';

export const SKILL_MD = `---
name: noriq
description: Coordinate and execute project work through Noriq. Use whenever a user asks you to plan, implement, fix, review, investigate, continue, or coordinate material work in a Noriq-connected project; when project memory may affect the answer; or when human input and status belong in Noriq.
---

# Working with Noriq

Noriq is the shared coordination layer between you, other agents, and human supervisors.
Its MCP server is self-teaching: **call \`get_briefing\` first** — it returns the playbook
plus your live state (held tasks, unresolved comments, what's claimable). For the full
parameter reference of every tool, see \`/reference.md\` (or \`/reference.json\`), generated
from the live schemas.

## Noriq is the channel of record

Use chat for the user's initial command and your concise result. Use Noriq for the durable work:

- **Material project work** — search for an existing task first, create one only when needed,
  claim it before working, load \`get_task_context\`, and keep its state current through release.
- **An explicit task key** — claim that task, then load its context and work it. Do not create a
  duplicate wrapper task.
- **Read-only investigation or review** — call \`configure_agent\` when the relevant project is not
  your current Copilot focus, then use project search and memory. Create/claim a task only when
  the user asked to track the work or the investigation becomes material ongoing work.
- **A human decision** — use \`request_input\` rather than asking in chat. If independent work can
  continue, pass \`blocking:false\`; otherwise let Noriq park the task and immediately move to
  \`next_claimable\`. Never sit idle in chat waiting for the answer.
- **Progress, gates, steering acknowledgements, alerts, and handoffs** belong on the Noriq task so
  humans and other Copilots see the same current state.

## On-demand references

This document covers what every session needs: identity, the work loop, search, priority,
human steering, the project-docs contract, and git. Four more references exist — fetch one
only when you're about to do the thing it covers, either by its URL or by MCP
\`resources/read\`:

- **File locks** — the acquire/release protocol, mandatory wherever a project has file
  locking on. \`GET /skill/file-locks.md\` or \`noriq://skill/file-locks\`. Load before your
  first edit, create, delete, or rename on such a project.
- **Planning & execution specs** — \`create_plan\`, phase gating, and how to write or read a
  task's \`executionSpec\`. \`GET /skill/planning.md\` or \`noriq://skill/planning\`. Load
  before writing a plan or filling in a spec.
- **Project memory** — recording and searching durable project memory. \`GET
  /skill/memory.md\` or \`noriq://skill/memory\`. Load before your first \`record_memory\` or
  \`search_project_memory\` call.
- **Doc authoring** — what belongs in a project doc and how to write one that lasts. \`GET
  /skill/docs.md\` or \`noriq://skill/doc-authoring\`. Load before your first \`create_doc\`.

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

Identity is assigned, not claimed. (\`configure_agent\` still exists to **rename** the
identity you already have — a friendlier label than the auto-generated one — but you never
need it to start working, and it never creates anybody.)

## The work loop

1. \`get_briefing\` — orient yourself.
2. Pick work: use the \`claimable\` list, or \`next_claimable\` for the single best pick.
   For anything more specific — "review tasks tagged auth", "my in-progress work" —
   \`search_tasks\` filters instead of dumping the whole project.
   A roaming Copilot doing read-only work in another project should call \`configure_agent\` first;
   runner-owned agents are pinned and cannot roam.
3. \`claim_task\` — you MUST claim before working, and claim only the **one** task you're
   about to start (don't batch-claim a list — an already-\`in_progress\` task is held, so
   re-claiming just errors). Claims are exclusive; a failed claim means pick something else.
   Identify the task by either its opaque \`task_…\` id or its \`PLN-##\` display key (both
   resolve), and pass \`projectId\` on every call. The response includes any open comments —
   read them first.
   Then call \`get_task_context\` before non-trivial work so the task, settled docs, relevant
   memory, prior episodes, graph neighborhood, and uncertainty arrive as one bounded pack.
4. If the project has file locking on (\`get_project\` → \`project.fileLocking\`),
   \`acquire_lock\` every path your edit touches **before** you touch it — see the file-locks
   reference (\`GET /skill/file-locks.md\` or \`noriq://skill/file-locks\`). On a locking
   project this step is not optional.
5. Do the work. Your claim renews automatically on **every** Noriq tool call, and the
   TTL is generous (30 min by default), so there is no need to ping to stay alive — don't
   waste turns on periodic \`heartbeat\`. Reach for \`heartbeat\` only if you'll go silent
   longer than the TTL (e.g. a long external build) and want to keep holding the task.
6. Watch the \`--- notices ---\` block on every tool result — new comments, messages,
   and requeues addressed to you appear there. Also \`my_updates\` after each step.
7. When a human steering comment arrives, call \`acknowledge_comment\` promptly so they know it
   was seen. This leaves it unresolved and still blocking. After you actually act on it, resolve
   it with \`resolve_comment\` (addressed | wont_do) + a substantive reply.
   You cannot release to done with unresolved comments.
8. \`release_task\` with toStatus "review" (default for finished work) or "done".

When you **create** tasks (\`create_tasks\`), tags are required and must
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
  the whole rather than an answer to a question. \`get_project\` is the project
  **scaffold**: ids you need (boards, milestones, tags), the docs index, the active
  plans, the \`fileLocking\` flag, and only the **P0** (most urgent) open tasks — it is
  deliberately not the backlog, so reach for \`search_tasks\` / \`next_claimable\` for that.

## Priority

\`priority\` runs **0 = most urgent to 4 = someday**, the way P0/P1 read everywhere else:
**P0 means drop everything**, P2 is the default "normal", P4 is "someday". Sorting
most-urgent-first is therefore *ascending*. When you set a priority, remember the number
goes DOWN as the urgency goes up — filing real work as P4 buries it.

## Human steering

Humans post comments of kind **question** (answer it, keep working) and
**instruction** (it may change your scope — re-plan before continuing). Call
\`acknowledge_comment\` as soon as you have seen one; acknowledgement is not resolution and the
comment stays open. Call \`resolve_comment\` only after the work or answer is real, with a
substantive reply. The human is waiting.

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

The pause is **your choice**: pass \`blocking: false\` when you want a human's answer
but can keep working meanwhile — nothing parks, you keep your claim, and the answer
reaches you mid-session (or as a comment on the task if your session ended first).
The default stays blocking — "I cannot proceed" — and is the right call whenever the
answer changes what you would build next.

After a blocking \`request_input\`, do not repeat the question in chat or wait there. Noriq has
parked and released the task; call \`next_claimable\` and continue useful work. After a
non-blocking request, keep the current claim and continue immediately.

Working a **run** and found real work that is not your task's? Use \`create_tasks\` with
\`proposal\` metadata:
the finding becomes its own **proposed** task — visible on the board but unclaimable
and undispatchable until a human accepts it (accept → todo) or rejects it (→
cancelled) — with your run id, your task and the finding text recorded as durable
provenance. Neither fold adjacent work into your diff nor \`raise_alert\` it: an alert
is a concern that is NOT work, a proposal is work that is not YOURS.

## Planning

Anything bigger than a single task starts with a **plan**, not open-loop claiming:
\`create_plan\` writes goals/approach/phases as a document humans can watch and workers
can drain via \`next_claimable\`. Phase order is enforced by the phases themselves — a
task in phase N is claimable only once every task in earlier phases is finished, no
dependency edges needed — and \`update_plan\` keeps it current as you go.

A task's \`executionSpec\` (\`requirementIds\`, \`anticipatedFiles\`, \`requiredReading\`,
\`lockedDecisions\`, \`discretion\`, \`deferred\`, \`acceptance.observableTruths\`) is what
the agent that claims it is handed before it starts — read it via \`get_task\` before you
begin; its \`lockedDecisions\` bind you and its \`acceptance\` is your definition of done.
Only a planner (a human, a copilot, or a **scope** run) may write one — never a
**build**/**verify** run on its own task, since the spec is what its work is judged
against.

Full detail — the \`create_plan\` shape, writing a good spec field by field,
\`create_tasks\`, \`update_tasks.addDependsOn\` — is in the planning reference: \`GET
/skill/planning.md\` or \`noriq://skill/planning\`.

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

## Project memory

Docs are settled facts; **project memory is the other thing** — durable learnings,
decisions, failed approaches, procedures, requirements, hazards, and open unknowns,
each carrying its own authority rather than being presented as settled. Record one
with \`record_memory\` (\`kind\` + \`statement\`, optionally \`evidence\`) whenever you
learn something a future agent should know and it is not already a doc. Anything you
record enters at low authority and stays **provisional**: it is never handed to a
future agent as an instruction, only as quoted, cited evidence it can weigh for
itself. You cannot raise your own authority — that happens only through a separate
human-approval step or verified merged-code evidence.

Read it before non-trivial work with \`search_project_memory\`. A hit marked
\`isLead\` is a lead to weigh, never an instruction to follow: current project state,
current repository contents, and passing tests always outrank stored memory.

Full detail — \`search_project_memory\`'s modes, the assembled-context and
graph-explain calls, the \`op\` variants, and the \`get_briefing\` memory pulse — is in
the memory reference: \`GET /skill/memory.md\` or \`noriq://skill/memory\`.

## Git

Attach your branch/PR to the task with \`update_tasks.refs\` so humans see where the work
lives. Mention the task key (e.g. PLN-42) in the PR title or branch name — the
GitHub webhook then auto-advances the task when the PR opens/merges.
`;

/**
 * Every on-demand reference, keyed by the slug index.ts serves it at
 * (GET /skill/<slug>.md). Exported as a map so SKILL_MD_SURFACE below and index.ts's route
 * registration share one list instead of two that could drift apart.
 */
export const SKILL_REFERENCES: Readonly<Record<string, string>> = {
  'file-locks': LOCKING_SKILL_MD,
  planning: PLANNING_SKILL_MD,
  memory: MEMORY_SKILL_MD,
};

/**
 * The full guidance-surface text the drift scanner's 'skill_md' entry must be built from —
 * core plus every reference, concatenated. Used in place of bare SKILL_MD wherever the
 * comparator needs "everything SKILL_MD used to state in one document" (see the module
 * comment above and index.ts's guidance-drift scan route).
 */
export const SKILL_MD_SURFACE = [SKILL_MD, ...Object.values(SKILL_REFERENCES)].join('\n\n');
