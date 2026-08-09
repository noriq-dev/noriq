# Noriq Claude Code hooks

This directory has two independent, **opt-in** Claude Code hooks that connect a working session to
Noriq over MCP. Both fail open by design — a Noriq outage never blocks or hangs your session — and
neither is wired into your Claude Code settings unless you copy the blocks from
[`settings.example.json`](./settings.example.json) yourself.

- **`noriq-lock.mjs`** (PLNR-209/210) — best-effort enforcement of Noriq's advisory file locks at
  the `PreToolUse`/`Stop` boundary. See [File-lock hook](#file-lock-hook) below.
- **`noriq-memory.mjs`** (PLNR-308) — injects the project's memory pulse at `SessionStart` and
  nudges recording it at `Stop`. See [Memory hooks](#memory-hooks) below.

They share their config/transport helpers via [`lib.mjs`](./lib.mjs) (git plumbing, the
`.noriq/project.toml` reader, the Noriq MCP `tools/call` client, project-id resolution) but run
independently — install either one alone, or both.

## Prerequisites (both hooks)

1. **A Noriq access token** for your account (the token your `claude mcp add` connection uses, or
   one you mint). Each hook authenticates as its own session of yours.
2. `node` ≥ 18 (both hooks use the built-in `fetch`); **no npm dependencies**.

## Configure (env)

| Variable        | Used by      | Required | Meaning |
|-----------------|--------------|----------|---------|
| `NORIQ_URL`     | both         | yes      | Noriq base URL, e.g. `https://plan.frs.llc` |
| `NORIQ_TOKEN`   | both         | yes      | An OAuth/MCP access token for your Noriq account |
| `NORIQ_PROJECT` | both         | no       | A `prj_…` id **or** a project key (resolved + cached). Defaults to the `key` in the repo's `.noriq/project.toml` |
| `NORIQ_SESSION` | both         | no       | MCP session id override. Defaults to a stable per-repo id — **each hook derives its own default** (`noriq-lock-…` / `noriq-memory-…`) from the same git root, so setting this overrides both at once but they never collide by default |
| `NORIQ_BRANCH`  | lock only    | no       | Branch scope for the lock. Defaults to the current git branch, then the `.noriq` `defaultBranch` |
| `NORIQ_TASK`    | lock only    | no       | Link acquired locks to a task id/key, so they auto-release when it settles |
| `NORIQ_MEMORY_TIMEOUT_MS` | memory only | no | Hard wall-clock budget, in ms, for **every** network call in one hook invocation **combined** — not per call (default `3000`). Whichever fetch is in flight when the deadline passes is aborted; the hook then fails open. |
| `NORIQ_MEMORY_PULSE` | memory only | no | `on` (default) \| `off` — disable the `SessionStart` injection while keeping the `Stop` nudge |
| `NORIQ_MEMORY_STOP_MODE` | memory only | no | `reminder` (default) \| `block` \| `off` — see [Memory hooks](#memory-hooks) |
| `NORIQ_MEMORY_DEBUG` | memory only | no | `1` to write brief diagnostics to stderr. Never affects stdout or the exit code — this hook has no visible failure mode by design |

Put the required vars where your Claude Code process will see them (shell profile, a direnv
`.envrc`, etc.).

## Install

Copy the blocks you want from [`settings.example.json`](./settings.example.json) into your Claude
Code settings — `~/.claude/settings.json` for all projects, or a repo's `.claude/settings.json` for
one — replacing `ABSOLUTE_PATH` with this checkout's path. The example file wires **both** hooks;
delete whichever block you don't want. Do not commit a repo-level `.claude/settings.json` that turns
these on for everyone — that decision belongs to the repo owner, not to installing this checkout.

**If you already have a `Stop` entry** (e.g. only the lock hook installed), add the memory hook's
command to that same entry's `hooks` array rather than adding a second `Stop` block — Claude Code
runs every entry for an event, but keeping them in one array is how the example file itself composes
the two:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [
          { "type": "command", "command": "node /path/to/noriq/hooks/noriq-lock.mjs" },
          { "type": "command", "command": "node /path/to/noriq/hooks/noriq-memory.mjs" }
      ] }
    ]
  }
}
```

---

## File-lock hook

Git has no file locking, so two agents (or a human and an agent) editing the same file on one
project can clobber each other. Noriq provides **advisory** file locks — a race-free arbiter plus
MCP tools (`acquire_lock` / `check_locks` / `release_lock` / `list_locks`). `noriq-lock.mjs` turns
those advisory locks into **best-effort enforcement** at a Claude Code session's tool boundary: a
`PreToolUse` hook acquires the lock *before* an `Edit`/`Write`/rename and **denies** the edit if
another session holds it.

> **Enforcement ladder.** This hook is rung 3 of 4: advisory tools → notices → **this client hook
> (best-effort, you install it)** → runner-guaranteed enforcement. It stops a *cooperating* peer,
> not an uncooperative one, and it depends on you installing it. For enforcement that can't be
> skipped, spawn agents through the **Noriq Runner**, which injects locking into every run (that's
> the companion RUN plan) and delegates to native Perforce/Diversion locks where they exist.

### Prerequisite: file locking must be enabled for the project

It is opt-in and off by default. A project owner turns it on in the dashboard (project settings),
or via the API: `PATCH /api/projects/:pid/meta { "fileLocking": true }`.

### Wiring

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

### How it works

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

### Without hooks (other agent runtimes)

Hooks are a Claude Code feature. Where a runtime has no `PreToolUse` equivalent, the same protection
is available **advisorily through the MCP tools themselves** — the agent calls `check_locks` before
editing shared files and `acquire_lock` to hold them, exactly as the Noriq skill (`/skill.md`,
"File locks") instructs. This hook is just automation of that discipline for Claude Code. For
enforcement that does not depend on the agent (or a human) remembering, run work through the Noriq
Runner, which owns the spawned process and applies locking unconditionally.

---

## Memory hooks

Reading project memory is otherwise entirely voluntary: `SKILL_MD` says "recording is half the loop
— read it too", which an agent can simply forget, and forgetting is invisible — the session just
proceeds without the project's accumulated hazards and decisions. `noriq-memory.mjs` closes both
halves of that loop at the session boundary:

- **`SessionStart`** — fetches the bounded memory pulse `get_briefing` already computes (recent
  decisions/hazards/unresolved unknowns, stale-memory warnings) and injects it, so a session starts
  already holding what the project knows.
- **`Stop`** — nudges `record_memory` before a session ends, if nothing looks recorded yet.

### The security rule this hook is built around

A memory statement is **untrusted content authored by a past agent**, not a fact the server itself
vouches for. Injecting it bare at session start would be worse than the same content in an ordinary
tool result: the agent never asked for it, and it arrives before any task framing has a chance to
put it in context. So this hook injects **exactly one thing** — `get_briefing().memory.evidenceFrame`,
the server's own bounded, quoted, authority-labelled evidence block — and injects it **verbatim**.
It never reassembles memory items into its own prose, ranks them, filters by its own rules, or
decides what's important. The hook is transport; the server already did the presentation.

### Wiring

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/noriq/hooks/noriq-memory.mjs" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /path/to/noriq/hooks/noriq-memory.mjs" }] }
    ]
  }
}
```

`SessionStart` alone is enough to get the memory-pulse injection; add `Stop` for the recording
nudge too. See [Install](#install) above for composing this `Stop` entry with the lock hook's.

### How it works

- **`SessionStart`** — resolves your project the same way the lock hook does (`NORIQ_PROJECT` /
  `.noriq/project.toml`), then localizes this hook's own Noriq identity to that project via
  `set_agent_identity` (best-effort — this is the same one-time step CLAUDE.local.md asks a human
  copilot to do, done here on the hook's behalf, because `get_briefing`'s memory block only exists
  for a *localized* agent) and calls `get_briefing`. If a non-empty evidence frame comes back, it's
  emitted as `hookSpecificOutput.additionalContext`; installing this hook creates (and reuses, on
  later sessions) a small hook-owned agent identity in the project — visible in `list_agents`/the
  dashboard as `noriq-memory-<hash>` — used only for this read.
- **`Stop`** — checks whether any project memory was recorded since this Claude session's own
  `SessionStart` ran (a project-wide, time-bounded signal via `get_briefing().memory.recentChanges`
  — see the caveat below), and if not, nudges once. Three modes via `NORIQ_MEMORY_STOP_MODE`:
  - `reminder` (**default**) — a `systemMessage`, shown to **you**, never sent to the model. Doesn't
    block or extend the turn.
  - `block` — **explicit opt-in.** Returns Stop's `decision:"block"`, which sends the model back to
    work with a reason to record memory first. Fires at most once per session, and never at all
    once memory looks recorded — see the locked-decision rationale in `hooks/noriq-memory.mjs`'s
    header comment.
  - `off` — the `Stop` hook does nothing.

  Either way, the nudge fires **at most once per Claude session** (tracked locally, keyed by
  Claude's own `session_id`) and **never** once memory looks recorded — nagging after the fact
  trains people to remove the hook.

### Fail-open, without exception

Unlike the lock hook, there is **no legitimate deny case** here. Missing `NORIQ_URL`/`NORIQ_TOKEN`,
an unreachable host, a timeout, an unparseable response, a project that can't be resolved — every
one of these exits `0` and injects/nudges nothing. A memory server having a bad day must never make
a session look hung or broken, and `SessionStart` in particular runs *before you can type* — an
unbounded fetch there would turn "server is down" into "the CLI looks frozen". Every network call in
one hook invocation shares a single wall-clock deadline (`NORIQ_MEMORY_TIMEOUT_MS`, default 3s); the
whole invocation is bounded by that one number, not the sum of however many calls it happens to make.

### Known limitation: the "already recorded" check is project-wide, not session-scoped

`Stop`'s "was memory recorded" signal comes from `get_briefing`'s small `recentChanges` window
filtered by timestamp — it isn't attributed to *your* Claude session specifically. In an actively
multi-agent project, another agent recording memory around the same time can suppress your nudge
(never the reverse: the nudge never fires spuriously). This is a deliberate, documented trade —
false-negative-safe (never over-nags) rather than exact.

### To turn either hook off

- Remove its block from your `settings.json` — the coarse, always-available switch.
- `NORIQ_MEMORY_PULSE=off` — keep the `Stop` nudge, drop the `SessionStart` injection.
- `NORIQ_MEMORY_STOP_MODE=off` — keep the `SessionStart` injection, drop the `Stop` nudge.

---

## Tests

```sh
node --test hooks/*.test.mjs   # lib.test.mjs (pure) + integration.test.mjs (lock, mock server) +
                                # noriq-memory.test.mjs (pure + memory hook, mock server)
# or, from the repo root:
npm run test:hooks
```
