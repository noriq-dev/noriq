# Noriq file-lock hook (best-effort client enforcement)

Git has no file locking, so two agents (or a human and an agent) editing the same file on one
project can clobber each other. Noriq provides **advisory** file locks — a race-free arbiter plus
MCP tools (`acquire_lock` / `check_locks` / `release_lock` / `list_locks`). This directory turns
those advisory locks into **best-effort enforcement** at a Claude Code session's tool boundary: a
`PreToolUse` hook acquires the lock *before* an `Edit`/`Write`/rename and **denies** the edit if
another session holds it.

> **Enforcement ladder.** This hook is rung 3 of 4: advisory tools → notices → **this client hook
> (best-effort, you install it)** → runner-guaranteed enforcement. It stops a *cooperating* peer,
> not an uncooperative one, and it depends on you installing it. For enforcement that can't be
> skipped, spawn agents through the **Noriq Runner**, which injects locking into every run (that's
> the companion RUN plan) and delegates to native Perforce/Diversion locks where they exist.

## Prerequisites

1. **File locking must be enabled for the project** — it is opt-in and off by default. A project
   owner turns it on in the dashboard (project settings), or via the API:
   `PATCH /api/projects/:pid/meta { "fileLocking": true }`.
2. **A Noriq access token** for your account (the token your `claude mcp add` connection uses, or
   one you mint). The hook authenticates as a session of yours and holds locks under it.

## Configure (env)

| Variable        | Required | Meaning |
|-----------------|----------|---------|
| `NORIQ_URL`     | yes      | Noriq base URL, e.g. `https://plan.frs.llc` |
| `NORIQ_TOKEN`   | yes      | An OAuth/MCP access token for your Noriq account |
| `NORIQ_PROJECT` | no       | A `prj_…` id **or** a project key (resolved + cached). Defaults to the `key` in the repo's `.noriq/project.toml` |
| `NORIQ_BRANCH`  | no       | Branch scope for the lock. Defaults to the current git branch, then the `.noriq` `defaultBranch` |
| `NORIQ_SESSION` | no       | Lock-holder session id. Defaults to a stable per-repo id (so re-edits renew, not conflict) |
| `NORIQ_TASK`    | no       | Link acquired locks to a task id/key, so they auto-release when it settles |

Put the required vars where your Claude Code process will see them (shell profile, a direnv
`.envrc`, etc.).

## Install

Copy the blocks from [`settings.example.json`](./settings.example.json) into your Claude Code
settings — `~/.claude/settings.json` for all projects, or a repo's `.claude/settings.json` for one —
replacing `ABSOLUTE_PATH` with this checkout's path:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "node /path/to/noriq/hooks/noriq-lock.mjs" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /path/to/noriq/hooks/noriq-lock.mjs" }] }
    ]
  }
}
```

`node` ≥ 18 is required (the hook uses the built-in `fetch`); it has **no npm dependencies**.

## How it works

- **`PreToolUse`** — extracts the path(s) the tool is about to write (`Edit`/`Write`/`MultiEdit`
  → `file_path`; `NotebookEdit` → `notebook_path`; `Bash` → a conservative parse of `rm`/`mv`/`cp`/
  `touch`/`tee`/redirects/`git rm|mv|checkout -- …`), makes them repo-relative, and calls
  `acquire_lock`. A grant (or a renew of your own lock) → the edit proceeds. Another session's lock
  → the hook exits `2` and reports the holder, task, and expiry, so Claude coordinates or waits.
- **`Stop` / `SubagentStop`** — releases every lock this session holds, so nothing lingers past the
  end of your work (locks also auto-expire on their TTL and auto-release when a linked task settles).

### Fail-open by design

The hook **never blocks your edit on infrastructure trouble** — a missing env var, an unreachable
server, a project that hasn't enabled locking, or a `Bash` command it can't parse confidently all
**allow** the edit (with a one-line note on stderr). Only a *confirmed conflict* denies. That is the
right trade for advisory, opt-in tooling: a lock server outage must not halt your work. If you need
locking that cannot fail open, use the Noriq Runner.

### The `Bash` caveat

Shell commands are parsed best-effort and conservatively: anything dynamic (variables, `$(...)`,
globs, backticks) is **not** guessed — it fails open. So `Bash`-driven writes are *not* fully
covered. The reliable coverage is the file tools (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`).

## Without hooks (other agent runtimes)

Hooks are a Claude Code feature. Where a runtime has no `PreToolUse` equivalent, the same protection
is available **advisorily through the MCP tools themselves** — the agent calls `check_locks` before
editing shared files and `acquire_lock` to hold them, exactly as the Noriq skill (`/skill.md`,
"File locks") instructs. This hook is just automation of that discipline for Claude Code. For
enforcement that does not depend on the agent (or a human) remembering, run work through the Noriq
Runner, which owns the spawned process and applies locking unconditionally.

## Tests

```sh
node --test hooks/*.test.mjs   # lib.test.mjs (pure) + integration.test.mjs (mock Noriq server)
# or, from the repo root:
npm run test:hooks
```
