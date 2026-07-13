# planar — Roadmap

> **planar** is an AI-native project management system. It gives autonomous coding agents a shared,
> real-time coordination layer — projects, tasks, dependencies, claims, and messaging — exposed as an
> **MCP server** for agents and a **web app** for humans supervising them.

---

## 1. Vision

Most project management tools are built for humans and bolt AI on as an afterthought. planar inverts
that: **agents are the primary actors**, humans supervise, review, and set direction. The hard problem
planar solves is **coordination between multiple agents working the same project** — preventing collisions,
enabling orchestrator→worker decomposition, and giving agents a way to share context and hand off work.
It also keeps the human in the loop: humans **comment on and question tasks**, and the agent working a
task **picks those up and acts on them** — steering work without stopping it.

**Design pillars**

- **AI-native.** The MCP surface is the product's spine; the web UI is a window onto it.
- **Coordination-first.** Task claiming/locking, orchestration trees, and inter-agent messaging are core, not add-ons.
- **Human-in-the-loop.** Comments and questions on a task flow to the agent working it and back — steering without stopping.
- **Real-time.** Agents and humans see the same live state — who holds what, what changed, where the conflicts are.
- **Self-hostable & open.** Runs on your own Cloudflare account. Open source.

---

## 2. Decisions locked in

| Area | Decision |
|---|---|
| Primary user | AI-native / autonomous agents; humans supervise |
| Platform | Cloudflare Workers + Durable Objects + D1 (+ R2/KV as needed) |
| Human front-end | Web app (SPA) |
| Coordination scope | Full: task claiming/locks, orchestrator+workers, shared context, messaging |
| Tenancy | Single-tenant self-host (each user deploys their own instance) |
| Agent auth | OAuth 2.1 (authorization code + PKCE, DCR, refresh rotation) — tokens map to agent identities; scoped API keys remain for headless/CI |
| Human auth | Minimal user accounts (email/passkey + sessions, admin role) |
| SPA framework | React |
| MCP transport | Streamable HTTP (latest MCP spec) |
| Write path | `ProjectRoom` DO is sole writer to D1 per project; reads direct from D1 |
| Target agents | **Claude first** (Claude Code / Claude Agent SDK as the reference MCP client); Codex & GitHub Copilot as fast follows |
| Agent updates | Pull-based: `my_updates` w/ server-side cursor (no ack, auto-advance; open comments sticky) + notices piggybacked on every tool result; WS only for UI & socket-capable agents |
| Agent onboarding | Self-teaching MCP (`instructions`, `get_briefing`, workflow-grade tool descriptions); installable skill served from the server itself |
| Real-time | Live via WebSocket/SSE (Durable Objects) |
| Core entities (now) | Projects, tasks/subtasks (with dependencies), milestones/planning |
| Code integration | Pure coordination MVP → **git-aware** fast-follow (branches/PRs/commits, read-only) |
| Licensing | Open source |
| Horizon | Aggressive — MVP in weeks, phases as sprints |

**Deferred by choice:** multi-tenant SaaS, a full shared-memory/knowledge store, and deep git
integration (triggering agent runs, worktrees). These are sketched in §6 but out of the near-term path.
(OAuth — originally deferred — shipped early: the MCP is an OAuth 2.1 protected resource.)

---

## 3. Architecture at a glance

```
┌──────────────┐        ┌──────────────┐         ┌───────────────────────┐
│  AI Agents   │ MCP    │              │  live   │  Durable Objects       │
│ (orchestrator│───────▶│   Worker     │◀───────▶│  ProjectRoom (1/project)│
│  + workers)  │  HTTP  │  (router +   │  WS/SSE │   - live state fanout   │
└──────────────┘  +WS   │   MCP + API) │         │   - claim/lock arbiter  │
                        │              │         │  AgentSession (1/agent) │
┌──────────────┐  HTTP  │              │         └───────────┬─────────────┘
│  Web app     │───────▶│              │                     │
│  (SPA + WS)  │◀───────│              │                     ▼
└──────────────┘        └──────┬───────┘             ┌──────────────┐
                               │                     │   D1 (SQL)   │  durable source of truth
                               └────────────────────▶│  projects,   │
                                                     │  tasks, deps,│
                                                     │  claims,     │
                                                     │  events...   │
                                                     └──────────────┘
```

- **Worker** — single entry point. Routes MCP (agents), REST/RPC (UI), and WebSocket upgrades. Handles API-key auth.
- **`ProjectRoom` Durable Object** (one per project) — the coordination authority. Serializes claim/lock
  decisions (no two agents claim the same task), holds the live subscriber set, and fans out events to
  agents and UI. This is where "real-time" and "no collisions" are enforced.
- **`AgentSession` Durable Object** (one per active agent) — presence/heartbeat, per-agent inbox for messaging.
- **D1** — durable relational store (projects, tasks, subtasks, dependencies, milestones, claims, events, agents/keys).
- **R2/KV** — later, for artifacts/attachments and cached read models.

---

## 4. Core data model (v1)

```
Workspace (implicit; single-tenant)
 └─ Agent            id, name, role, api_key_hash, scopes, status, last_seen
 └─ Group            id, name, description                  (collection of projects)
 └─ Project          id, group_id?, name, description, status, repo_url?, default_branch?
     ├─ Plan          id, agent_id?, title                   (an agent's work program)
     │   └─ Phase     id, plan_id, title, order              (ordered; tasks in phase N
     │       └─ phase_tasks(task_id)                          auto-depend on all of N-1)
     ├─ Milestone    id, project_id, title, due?, order
     ├─ Task         id, project_id, milestone_id?, parent_task_id?, title, body,
     │               status(todo|claimed|in_progress|blocked|review|done|cancelled),
     │               priority, estimate?, claimed_by?, claim_expires_at?,
     │               open_comments(int, unaddressed count), order
     ├─ Dependency   task_id, depends_on_task_id            (DAG; blocks claim)
     ├─ Claim        task_id, agent_id, acquired_at, expires_at, released_at?
     ├─ Comment      id, task_id, author(human|agent), kind(comment|question|instruction),
     │               body, status(open|acknowledged|addressed|wont_do), resolved_by?,
     │               parent_comment_id?(threading), ts
     ├─ Message      id, project_id, from_agent, to_agent?(broadcast if null), body, ref_task_id?
     └─ Event        id, project_id, actor(agent|human), verb, subject, payload, ts   (append-only)
```

**Coordination primitives built on this:**
- **Claim/lock** — an agent claims a task via `ProjectRoom`; the DO grants at most one live claim, with a
  TTL/heartbeat so a dead agent's claim auto-expires. Dependencies gate claimability.
- **Orchestration** — `parent_task_id` forms the decomposition tree; an orchestrator creates subtasks and
  worker agents claim leaves. The tree is the assignment structure.
- **Plans & phases** — an agent doesn't work a whole project: it builds a *plan* — existing/new tasks
  grouped into ordered *phases*. Phase order is enforced through auto-generated dependencies, so the
  claim arbiter gates the sequence; the UI visualizes plan → phase → task progress.
- **Messaging** — targeted or broadcast messages within a project, optionally attached to a task.
- **Human comments/questions** — humans post comments, questions, or instructions on a task. An agent
  holding (or about to claim) that task **sees open comments**, must acknowledge them, and resolves each as
  `addressed` / `wont_do` (with a reply). Open comments are surfaced on the task and can optionally gate a
  task from reaching `done`. When a comment lands on a task an agent is actively working, it's pushed to
  that agent's live channel so it can react mid-flight.
- **Context** — for MVP, shared context = task bodies + comments + messages + the event log (a full
  knowledge/memory store is a later phase, see §6).

---

## 5. Phased plan (aggressive / sprint-sized)

### Phase 0 — Foundations (Sprint 0)
*Goal: a deployable skeleton and the shape of the repo.*
- Repo scaffolding: Worker + Wrangler config, TypeScript, Vitest, `wrangler dev` loop.
- D1 schema + migrations for the §4 model; seed script.
- CI (typecheck, test, `wrangler deploy` on tag), CONTRIBUTING/LICENSE (OSS), README.
- Deployable "hello" Worker with health check and D1 connectivity.

**Exit:** `wrangler deploy` to your own account; empty schema live; tests green in CI.

---

### Phase 1 — MCP + Coordination Core (the MVP) ⭐
*Goal: prove that multiple agents can coordinate on one project without collisions. Minimal UI.*

- **API-key auth**: issue/scope/revoke agent keys; middleware on Worker; keys hashed at rest.
- **MCP server** exposing coordination as tools/resources:
  - `list_projects`, `get_project`, `create_project`
  - `list_tasks`, `get_task`, `create_task`, `update_task`, `create_subtask`, `set_dependency`
  - `claim_task`, `release_task`, `heartbeat` (claim TTL renewal)
  - `list_comments`, `read_open_comments` (unaddressed for a task), `reply_comment`, `resolve_comment`
  - `send_message`, `read_messages`
  - `list_milestones`, `create_milestone`
  - resources: project snapshot, task detail (incl. open comments), event feed
- **Claude as reference client**: develop and test the MCP surface against Claude Code / the Claude Agent
  SDK; tool names, descriptions, and result shapes tuned for how Claude consumes them. Keep the surface
  spec-compliant so Codex / GitHub Copilot work as fast follows (see §6).
- **Self-teaching MCP surface** (most clients can't hold a socket, and agents must learn the protocol
  from the server itself — tools are the only universally supported channel):
  - Server `instructions` on initialize: the terse protocol contract (claim before working, heartbeat,
    check comments, resolve before done, release).
  - `get_briefing` tool — the documented first call: full playbook + the calling agent's current state
    (identity, held tasks, open comments awaiting it, what's claimable). Versioned with the server.
  - Tool descriptions written as workflow guidance (when/why + obligations), not just API docs.
  - `my_updates` tool — agent-scoped delta sync with a **server-side cursor** (per-agent last-delivered
    event seq stored in AgentSession DO; zero client state). No explicit ack: the cursor auto-advances on
    delivery, but **open comments are sticky** — they are state, not events, and reappear in every
    briefing/notice until actually resolved.
  - **Notices piggyback**: every MCP tool result carries a compact `notices` block for the calling agent
    ("1 new comment on PLN-142 · PLN-138 now claimable"). Heartbeats double as sync, so working agents
    get pushed-feeling updates without polling.
- **`ProjectRoom` DO**: single-writer claim arbiter + TTL/heartbeat expiry + dependency gating.
- **`AgentSession` DO**: presence/heartbeat + per-agent inbox.
- **Append-only event log** for every mutation (foundation for audit + live UI).
- **Thin web view** (read-mostly + commenting): project board, task list, live event feed, "who holds
  what" presence, and a **task comment box** so a human can post comments/questions on any task.
- **Live channel**: WebSocket fanout from `ProjectRoom` to UI and subscribed agents.

**Exit / demo:** an orchestrator agent creates a project + a handful of dependent tasks; two worker
agents concurrently claim, work, and release tasks with **zero double-claims**; a human posts a question
on an in-progress task and the working agent picks it up live, replies, and resolves it; the human web
view shows claims, status changes, comments, and messages streaming live.

---

### Phase 2 — Human Web App (Supervisor UI)
*Goal: a genuinely useful human surface for steering agents.*
- React SPA. Board + list + timeline views.
- Create/edit projects, tasks, subtasks, dependencies, milestones from the UI.
- Live agent activity feed & presence; drill into a task's claim/comment/message/event history.
- **Task comments/questions UX**: threaded comment panel per task, open-vs-resolved state, agent replies
  shown inline, and a badge for tasks with unaddressed comments. Notify when an agent resolves your question.
- Human actions (reassign, cancel, unblock, force-release a stale claim) — a human is just another actor.
- Minimal user accounts (email/passkey login, sessions, admin role for agent-key management).

**Exit:** a human can plan and supervise a multi-agent project end-to-end from the browser.

---

### Phase 3 — Orchestration & Coordination Depth
*Goal: make the "orchestrator decomposes → workers execute" flow first-class and robust.*
- Orchestration helpers in MCP: `decompose_task` (create subtree), `assign`, `next_claimable` (return the
  next dependency-unblocked, unclaimed task for a worker to pull).
- Claim policies: TTL tuning, auto-requeue on expiry, "review" handoff state, blocked/unblock signaling.
- Messaging upgrades: threads, mentions, task-scoped discussion, notify-on-event subscriptions.
- Comment-handling policy: configurable gating (block `done` while comments are open), auto-nudge the
  claiming agent on new comments, escalate/reassign if a comment goes unaddressed past a threshold, and
  distinguish `question` (answer, keep working) from `instruction` (may change the work) semantics.
- Notices policy tuning: what's urgent enough to piggyback on every tool result vs. what waits for
  `my_updates`; per-agent relevance filtering so context stays lean.
- Coordination safety: conflict detection, stale-claim reaping, idempotent tool calls (retry-safe).

**Exit:** an orchestrator can safely fan out a real feature into subtasks that a pool of workers drains
concurrently, with graceful recovery when an agent dies mid-task.

---

### Phase 4 — Git Awareness (fast-follow)
*Goal: connect coordination to the code the agents actually produce (read-only awareness).*
- Link tasks ↔ branches / PRs / commits (`repo_url`, `default_branch` on project; task-level refs).
- Ingest git/PR state via webhooks (GitHub first) → reflect "in review / merged" back onto task status.
- Show PR/commit status inline in the task view and event feed.
- MCP tools for agents to attach a branch/PR to a task and report landing.

**Exit:** when an agent's PR merges, the linked task auto-advances and everyone (agents + humans) sees it live.

---

### Phase 5 — Hardening & v1.0 Release
*Goal: something others can confidently self-host.*
- Docs: quickstart (deploy to your CF account in minutes), MCP tool reference, agent integration guide.
- **Installable agent skill, served by planar itself**: `GET <your-instance>/skill.md` (+ install
  one-liner in the docs). Generated from the same source as the tool descriptions so it can't drift;
  stays a thin pointer — the work loop + "call `get_briefing` for current truth". Ground truth lives
  server-side.
- Observability: structured logs, metrics, DO/D1 health, per-agent rate limits & abuse guards.
- Robustness: schema migration strategy, backup/export of D1, load-test the claim arbiter.
- Security pass: key scoping/rotation, input validation, event-log integrity.
- **v1.0 release** — tagged, documented, one-command self-host.

**Exit:** a stranger can `git clone`, `wrangler deploy`, point agents at their MCP endpoint, and run a
coordinated multi-agent project.

---

## 6. Beyond v1 (sketched, deferred by choice)

- **Broader agent-client support** — validate and document against Codex and GitHub Copilot (and other
  MCP clients). Mostly a testing/docs effort since the MCP surface stays spec-compliant.
- **Shared context / memory store** — project-scoped knowledge agents read/write (decisions, artifacts,
  retrievable notes), beyond task bodies + events.
- **Multi-tenant SaaS** — workspaces, per-tenant isolation, billing; hosted option alongside self-host.
- **OAuth (MCP spec)** — standards-based agent auth for the SaaS track.
- **Deep git / execution integration** — trigger agent runs, manage worktrees, drive the loop from planar.
- **Analytics** — throughput, cycle time, per-agent productivity, bottleneck detection.
- **Richer planning** — sprints, estimates roll-ups, roadmap views, capacity across an agent pool.

---

## 7. Resolved technical decisions

1. **SPA framework** — **React.** Widest ecosystem, best library support for boards/timelines/real-time UIs.
2. **MCP transport** — **Streamable HTTP**, per the latest MCP spec. (SSE-only transport is deprecated;
   Streamable HTTP fits Workers natively.)
3. **DO ↔ D1 write path** — **`ProjectRoom` DO is the sole writer** for all project-scoped data. It's
   already the claim arbiter; making it the only writer gives strong consistency, serialized mutations
   (no read-modify-write races), and a single place to emit events/fanout after each commit. Reads can go
   straight to D1 from the Worker.
4. **Claim TTL & heartbeat** — default **5-minute claim TTL, renewed by 60-second heartbeats**. Heartbeats
   piggyback on any MCP tool call from the claiming agent, so actively-working agents renew for free; a
   dead agent's task requeues within ~5 minutes. Both values configurable per project.
5. **Human auth for self-host** — **minimal user accounts** (email + password or passkey, session cookies,
   admin role for key management). No shared-secret shortcut.

---

*This roadmap is a living document. Phases are sequenced by dependency; the aggressive horizon means each
phase is a sprint-sized push, and Phase 1 is the real proof point.*
