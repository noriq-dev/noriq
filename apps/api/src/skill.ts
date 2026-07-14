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

Each session — this chat, or a sub-agent you spawn — is its own **agent**, local to one
project. Call \`set_agent_identity\` with a short \`name\` and the \`projectId\` you're working
(names are unique per project). If you're a sub-agent, pass \`parentAgentId\` so your work is
attributed to the agent that spawned you. Your OAuth connection can carry many such agents.
Do this **before your first claim** so everything you do is attributed from the start.

## The work loop

1. \`get_briefing\` — orient yourself.
2. Pick work: use the \`claimable\` list, or \`next_claimable\` for the single best pick.
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

## Human steering

Humans post comments of kind **question** (answer it, keep working) and
**instruction** (it may change your scope — re-plan before continuing).
Acknowledge fast, resolve with a substantive reply. The human is waiting.

When **you** need the human, pick the right channel: \`request_input\` to block on a
decision (tie it to the task), \`raise_alert\` when something is wrong and needs attention,
\`send_message\` for a narrative progress update that wants no answer. Don't bury a blocking
question inside a \`send_message\` — it reads as status and no one will reply.

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

Phase order is **enforced**: every task in phase N auto-depends on all of phase N-1, so
the plan becomes a dependency-ordered work tree — workers (you, later, or others) can
only claim in sequence and drain it via \`next_claimable\`. Keep the document alive as you
go with \`update_plan\` (status, findings, gotchas, final outcome; pass the full new body,
or a \`phaseId\` to revise one phase).

For a quick subtree without the ceremony, \`decompose_task\`; for ad-hoc ordering,
\`add_dependency\`; to coordinate mid-flight, \`send_message\`. Check progress with
\`get_plans\`.

## Git

Attach your branch/PR to the task with \`attach_ref\` so humans see where the work
lives. Mention the task key (e.g. PLN-42) in the PR title or branch name — the
GitHub webhook then auto-advances the task when the PR opens/merges.
`;
