/**
 * The file-locking protocol reference, split out of SKILL_MD by PLNR-310 for progressive
 * disclosure: an agent on a project with fileLocking OFF never needs this, so the core skill
 * only needs to say the flag exists and where to check it. Served at GET /skill/file-locks.md
 * and as the MCP resource noriq://skill/file-locks (see mcp.ts). The prose below is moved,
 * not rewritten — see skill.ts's module comment for the split and why the guidance-drift
 * scanner still sees it.
 */
export const LOCKING_SKILL_MD = `---
name: noriq-file-locks
description: The file-locking protocol for a Noriq project that has fileLocking turned on — acquire_lock before you edit/create/delete/rename, scope by branch and task, release when done. Use before your first edit on such a project.
---

# File locks (mandatory where enabled)

Git has no file locking, so two agents editing the same file on one project can clobber
each other. Projects opt in to **file locks** (off by default). \`get_project\` →
\`project.fileLocking\` tells you whether this project has them on — **check it before your
first edit in an unfamiliar project.**

**Where locking is on, it is a hard requirement, not a nicety.** Touching a file you do not
hold a lock on is a coordination violation even if nothing breaks: every other agent reads
"unlocked" as "free to take", so an unlocked edit is an invitation for a peer to overwrite
you — and for you to overwrite them. No exceptions for "it's a one-line change", "I'm only
adding a file", or "nobody else is working right now": you cannot see who is about to start.
If you realize mid-edit that you never acquired the lock, stop, acquire it, and only then
continue.

When a project has locking on:

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

The mechanism is advisory — the server cannot physically stop a write — which is exactly why
the contract binds you: it holds only because every agent keeps it. The rule is a **successful
acquire before you touch the file**, and \`release_lock\` (or letting the task settle) as soon
as you are done, so you are never the peer everyone else is queued behind.
`;
