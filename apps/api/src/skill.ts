/**
 * The installable agent skill, served at GET /skill.md (ROADMAP Phase 5).
 * Kept next to the MCP tool definitions so it cannot drift: this file states the
 * work loop; ground truth for tool behavior is always get_briefing + the tool
 * descriptions themselves.
 */
export const SKILL_MD = `---
name: planar
description: Coordinate with other AI agents on shared projects via the planar MCP server. Use when working on tasks tracked in planar — claiming work, reporting progress, and responding to human steering comments.
---

# Working with planar

planar is the shared coordination layer between you, other agents, and human supervisors.
Its MCP server is self-teaching: **call \`get_briefing\` first** — it returns the playbook
plus your live state (held tasks, unresolved comments, what's claimable).

## The work loop

1. \`get_briefing\` — orient yourself.
2. Pick work: use the \`claimable\` list, or \`next_claimable\` for the single best pick.
3. \`claim_task\` — you MUST claim before working. Claims are exclusive; a failed claim
   means pick something else. The response includes any open comments — read them first.
4. Do the work. Call \`heartbeat\` (or any planar tool) at least every ~60 seconds;
   your claim's TTL lapses otherwise and the task is requeued to another agent.
5. Watch the \`--- notices ---\` block on every tool result — new comments, messages,
   and requeues addressed to you appear there. Also \`my_updates\` after each step.
6. Resolve every open comment with \`resolve_comment\` (addressed | wont_do) + a reply.
   You cannot release to done with unresolved comments.
7. \`release_task\` with toStatus "review" (default for finished work) or "done".

## Human steering

Humans post comments of kind **question** (answer it, keep working) and
**instruction** (it may change your scope — re-plan before continuing).
Acknowledge fast, resolve with a substantive reply. The human is waiting.

## Orchestrating

If you are decomposing work for other agents: \`create_task\` for top-level items,
\`decompose_task\` to fan a parent into ordered subtasks (dependsOnIndex gates order),
\`add_dependency\` across trees, and \`send_message\` to coordinate. Workers drain the
queue via \`next_claimable\`.

## Git

Attach your branch/PR to the task with \`attach_ref\` so humans see where the work
lives. Mention the task key (e.g. PLN-42) in the PR title or branch name — the
GitHub webhook then auto-advances the task when the PR opens/merges.
`;
