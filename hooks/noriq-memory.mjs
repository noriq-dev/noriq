#!/usr/bin/env node
// Noriq memory hooks (PLNR-308). Wire into Claude Code as a SessionStart hook (and, optionally, a
// Stop hook) — see hooks/README.md. Sibling of noriq-lock.mjs, sharing its config/transport/session
// helpers via lib.mjs. Reading project memory is otherwise entirely voluntary (SKILL_MD says
// "recording is half the loop — read it too", which an agent can simply forget); this hook closes
// both halves at the session boundary:
//
//   SessionStart — fetches the bounded memory pulse get_briefing already computes and injects it,
//                  so a session starts already holding what the project knows.
//   Stop         — nudges record_memory before a session ends, if nothing was recorded yet.
//
// Design rule: FAIL OPEN, WITHOUT EXCEPTION. Unlike noriq-lock.mjs there is NO legitimate deny case
// here — missing config, no token, an unreachable host, a timeout, an unparseable response, a
// project that can't be resolved: every one of these exits 0 and injects/nudges nothing. A memory
// server having a bad day must never be able to make a session look hung or broken.
//
// Security rule (§13, locked decision): the ONLY thing ever injected is `memory.evidenceFrame` — the
// server's own bounded, quoted, authority-labelled evidence block, injected VERBATIM. Memory
// statements are untrusted content authored by past agents; this hook is transport, not
// presentation — it never reassembles raw memory items into its own prose, ranks them, or decides
// what matters.
//
// Config (env; the CLI also reads .noriq/project.toml for key, same as noriq-lock.mjs):
//   NORIQ_URL               Noriq base URL, e.g. https://plan.frs.llc          (required)
//   NORIQ_TOKEN             an OAuth/MCP access token for your Noriq account   (required)
//   NORIQ_PROJECT           a prj_… id, or a project KEY (resolved + cached)   (default: .noriq key)
//   NORIQ_SESSION           MCP session id override (default: stable per-repo id, distinct from
//                           noriq-lock.mjs's own default so the two hooks never share one identity)
//   NORIQ_MEMORY_TIMEOUT_MS hard wall-clock budget, in ms, for ALL network calls in ONE hook
//                           invocation combined — not per-call (default 3000). SessionStart runs
//                           before you can type, so an unreachable server must fail fast, not hang.
//   NORIQ_MEMORY_PULSE      "on" (default) | "off" — set "off" to disable SessionStart injection
//                           while keeping the Stop nudge wired.
//   NORIQ_MEMORY_STOP_MODE  "reminder" (default) | "block" | "off":
//                             off      — the Stop hook does nothing.
//                             reminder — a non-blocking `systemMessage`, visible to the human only;
//                                        never sent to the model, never delays finishing.
//                             block    — EXPLICIT OPT-IN: sends the model back to work via Stop's
//                                        `decision:"block"`. Fires at most once per session and
//                                        never when memory already looks recorded.
//   NORIQ_MEMORY_DEBUG      "1" to write brief diagnostics to stderr (never affects stdout/exit).

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  git, readNoriqMarker, readStdinPayload, defaultSessionId, callTool, resolveProjectId, withDeadline,
} from './lib.mjs';

const DEFAULT_TIMEOUT_MS = 3000;
// Defensive ceiling independent of the server's own untrusted-content budget (currently 12,000
// chars per `UNTRUSTED_BUDGET_DEFAULTS.maxChars` in evidence-frame.ts) — belt-and-suspenders only,
// never expected to bind, so a future server-side budget change can't turn this hook's stdout into
// an unbounded payload.
const MAX_INJECT_CHARS = 20_000;

const STOP_REMINDER_TEXT =
  "Noriq: no project memory looks recorded this session. If you settled a decision, hit a hazard, " +
  'ruled out an approach, or found a durable requirement or procedure, consider record_memory before ' +
  "finishing — future agents only see what's written down. (This is an FYI, not a block — set " +
  'NORIQ_MEMORY_STOP_MODE=block to make it one.)';

const STOP_BLOCK_REASON =
  'No project memory was recorded this session. NORIQ_MEMORY_STOP_MODE=block is opt-in and asking ' +
  'you to check: if you learned something durable — a decision, hazard, failed approach, procedure, ' +
  'or requirement — call record_memory now, then finish. If genuinely nothing durable came out of ' +
  'this session, it is fine to stop; this nudge fires at most once.';

function debug(msg) {
  if (process.env.NORIQ_MEMORY_DEBUG === '1') process.stderr.write(`[noriq-memory] ${msg}\n`);
}

// -------------------------------------------------------------------------------------------
// Pure logic — exported for direct unit testing, no I/O.
// -------------------------------------------------------------------------------------------

/** Extract the verbatim evidence-frame text to inject, or null when there is nothing worth
 *  injecting (no localized memory pulse, no evidenceFrame, or an empty one — `renderEvidenceFrame`
 *  returns `text: ''` when it had zero items, which is "nothing to say", not an error). Applies
 *  ONLY a defensive length ceiling — never reformats, ranks, or filters the content itself. */
export function pickAdditionalContext(memory) {
  const text = memory?.evidenceFrame?.text;
  if (typeof text !== 'string' || text.length === 0) return null;
  if (text.length <= MAX_INJECT_CHARS) return text;
  return `${text.slice(0, MAX_INJECT_CHARS)}\n\n[noriq-memory hook: truncated at ${MAX_INJECT_CHARS} characters — client-side payload ceiling, independent of the server's own budget]`;
}

/** Did any memory item change project-wide since `startedAtIso`? A time-bounded, project-wide
 *  signal (not scoped to the specific agent that recorded it) — deliberately conservative: it can
 *  under-count in a very active multi-agent project (missing this session's own memory buried past
 *  the pulse's small recent-changes window) but never fabricates a recording that didn't happen.
 *  `recentChanges` is `get_briefing().memory.recentChanges` — already capped to a handful of items
 *  server-side, so this is a cheap linear scan. */
export function recordedSinceStart(recentChanges, startedAtIso) {
  if (!Array.isArray(recentChanges) || typeof startedAtIso !== 'string') return false;
  const startedAt = Date.parse(startedAtIso);
  if (Number.isNaN(startedAt)) return false;
  return recentChanges.some(
    (c) => c && c.entityType === 'memory_item' && typeof c.at === 'string' && Date.parse(c.at) >= startedAt,
  );
}

/**
 * Decide what the Stop hook should print, given it has already passed every gate that does NOT
 * require this decision (mode !== 'off', stop_hook_active !== true, not already nudged this
 * session). Returns null for "print nothing, exit 0" — the locked-decision default whenever memory
 * already looks recorded, regardless of mode.
 */
export function decideStopOutput({ mode, alreadyRecorded }) {
  if (alreadyRecorded) return null;
  if (mode === 'block') {
    return { decision: 'block', reason: STOP_BLOCK_REASON };
  }
  return { systemMessage: STOP_REMINDER_TEXT };
}

// -------------------------------------------------------------------------------------------
// Local per-Claude-session state (PLNR-308 discretion: local state, not a server-side check) —
// tracks two things the Stop hook needs and the server has no notion of: when THIS Claude session
// started (the baseline `recordedSinceStart` measures from) and whether the nudge already fired.
// Keyed by Claude's own `session_id` (not the Noriq MCP session id above, which is per-REPO and
// spans many Claude sessions) so "once per session" means the same thing the docs mean by it.
// -------------------------------------------------------------------------------------------

const STATE_DIR = join(tmpdir(), 'noriq-memory-sessions');

function statePath(sessionId) {
  return join(STATE_DIR, `${sessionId}.json`);
}

function readState(sessionId) {
  try { return JSON.parse(readFileSync(statePath(sessionId), 'utf8')); } catch { return null; }
}

function writeState(sessionId, state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(statePath(sessionId), JSON.stringify(state));
  } catch { /* best-effort — a state-file miss just means Stop can't establish a baseline (see below) */ }
}

// -------------------------------------------------------------------------------------------
// SessionStart
// -------------------------------------------------------------------------------------------

async function runSessionStart(payload) {
  // Record the baseline FIRST, and before any network I/O: this is what lets Stop later ask "was
  // anything recorded SINCE this session began". Pure local disk I/O — never fails open the way
  // network calls do because it can't hang or be unreachable; a write failure here just means Stop
  // has no baseline later (handled there, not here).
  if (payload.session_id) writeState(payload.session_id, { startedAt: new Date().toISOString(), nudged: false });

  if ((process.env.NORIQ_MEMORY_PULSE || 'on') === 'off') { debug('pulse disabled (NORIQ_MEMORY_PULSE=off)'); return; }

  const timeoutMs = Number(process.env.NORIQ_MEMORY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const { signal, cancel } = withDeadline(timeoutMs); // ONE deadline for every network call below
  try {
    const cfg = await resolveConfig(payload, timeoutMs, signal);
    if (!cfg) return;

    // Best-effort localization: get_briefing's `memory` block is scoped to the AGENT's own
    // localized project (mcp.ts: `updates.agentProjectId`), and this hook's session has never
    // localized itself before. A working copilot does this once via set_agent_identity as part of
    // its normal loop (CLAUDE.local.md) — this hook does the same thing for its own pseudo-identity.
    // Failure here (name clash, network hiccup) is NOT fatal: get_briefing still degrades to
    // `memory: null` gracefully (§20), which `pickAdditionalContext` already treats as "nothing to
    // inject" — so no separate catch-and-bail is needed beyond the one below.
    try {
      await callTool(cfg, 'set_agent_identity', { name: cfg.session, projectId: cfg.projectId }, { signal });
    } catch (e) {
      debug(`set_agent_identity failed, proceeding without localization (${e?.message ?? e})`);
    }

    const briefing = await callTool(cfg, 'get_briefing', {}, { signal });
    if (briefing.isError) { debug(`get_briefing returned isError: ${briefing.text}`); return; }

    const context = pickAdditionalContext(briefing.body?.memory ?? null);
    if (!context) { debug('no evidence frame to inject'); return; }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }));
  } catch (e) {
    debug(`SessionStart injection skipped (${e?.message ?? e})`); // timeout/network/parse — fail open
  } finally {
    cancel();
  }
}

// -------------------------------------------------------------------------------------------
// Stop
// -------------------------------------------------------------------------------------------

async function runStop(payload) {
  const mode = process.env.NORIQ_MEMORY_STOP_MODE || 'reminder';
  if (mode === 'off') { debug('stop nudge disabled (NORIQ_MEMORY_STOP_MODE=off)'); return; }
  if (!['reminder', 'block'].includes(mode)) { debug(`unrecognized NORIQ_MEMORY_STOP_MODE=${mode}, treating as reminder`); }

  // Never chain off a stop hook that is ALREADY the reason this turn is continuing — the doc's own
  // loop-protection field. Belt-and-suspenders alongside Claude Code's own 8-consecutive-block cap.
  if (payload.stop_hook_active === true) { debug('stop_hook_active — not re-firing'); return; }

  const sessionId = payload.session_id;
  if (!sessionId) return; // can't track "once per session" or a baseline without one
  const state = readState(sessionId);
  // No SessionStart baseline for this Claude session (hook not installed there, or it never got to
  // run) → we have nothing to measure "recorded SINCE start" against. Skip rather than guess: an
  // unfounded nudge is worse than a missed one for a feature whose whole point is not to annoy.
  if (!state) { debug('no SessionStart baseline for this session — skipping'); return; }
  if (state.nudged) { debug('already nudged this session'); return; }

  const timeoutMs = Number(process.env.NORIQ_MEMORY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const { signal, cancel } = withDeadline(timeoutMs); // ONE deadline for every network call below
  try {
    const cfg = await resolveConfig(payload, timeoutMs, signal);
    if (!cfg) return; // fail open — leave state.nudged untouched so a later Stop call can retry

    const briefing = await callTool(cfg, 'get_briefing', {}, { signal });
    if (briefing.isError) { debug(`get_briefing returned isError: ${briefing.text}`); return; }

    const recentChanges = briefing.body?.memory?.recentChanges ?? [];
    const alreadyRecorded = recordedSinceStart(recentChanges, state.startedAt);
    if (alreadyRecorded) {
      debug('memory already recorded this session — marking satisfied, no nudge');
      writeState(sessionId, { ...state, nudged: true });
      return;
    }

    const output = decideStopOutput({ mode: mode === 'block' ? 'block' : 'reminder', alreadyRecorded });
    if (!output) return; // decideStopOutput never returns null here (alreadyRecorded is false), kept for symmetry
    process.stdout.write(JSON.stringify(output));
    writeState(sessionId, { ...state, nudged: true });
  } catch (e) {
    debug(`Stop nudge skipped (${e?.message ?? e})`); // fail open — do NOT mark nudged, allow a retry
  } finally {
    cancel();
  }
}

// -------------------------------------------------------------------------------------------
// Shared config resolution — mirrors noriq-lock.mjs's project/session resolution exactly, via the
// same lib.mjs helpers, but with its OWN default session id (see the env table above) and a hard
// deadline neither event may exceed.
// -------------------------------------------------------------------------------------------

async function resolveConfig(payload, timeoutMs, signal) {
  const cwd = payload.cwd || process.cwd();
  const gitRoot = git(['rev-parse', '--show-toplevel'], cwd);
  if (!gitRoot) { debug('not a git repo'); return null; }

  const url = process.env.NORIQ_URL;
  const token = process.env.NORIQ_TOKEN;
  if (!url || !token) { debug('NORIQ_URL / NORIQ_TOKEN not set'); return null; }

  const marker = readNoriqMarker(gitRoot);
  const session = process.env.NORIQ_SESSION || defaultSessionId('noriq-memory', gitRoot);
  const base = { url: url.replace(/\/$/, ''), token, session, timeoutMs };

  try {
    const projectId = await resolveProjectId(base, process.env.NORIQ_PROJECT || marker.key, { signal });
    if (!projectId) { debug('could not resolve NORIQ_PROJECT'); return null; }
    return { ...base, projectId };
  } catch (e) {
    debug(`project resolution failed (${e?.message ?? e})`);
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------------------------

async function main() {
  const payload = readStdinPayload();
  const event = payload.hook_event_name;
  if (event === 'SessionStart') return runSessionStart(payload);
  if (event === 'Stop') return runStop(payload);
  // Not our event (e.g. wired with too broad a matcher) — no-op, exit 0.
}

// Only run the CLI when this file is executed directly (`node noriq-memory.mjs`) — NOT when it's
// imported for its pure exports (pickAdditionalContext/recordedSinceStart/decideStopOutput), which
// hooks/noriq-memory.test.mjs does directly. Without this guard, importing the module for testing
// would also invoke main() and block forever on `readStdinPayload()`'s synchronous stdin read (no
// EOF from the test runner's own stdin) — the classic "import ran my CLI" ESM footgun.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((e) => { debug(`unexpected top-level error (${e?.message ?? e}) — failing open`); })
    // ALWAYS exit 0 (this hook has no legitimate deny/error path). Explicit process.exit(), not a
    // natural return: fetch's underlying keep-alive connection pool (undici) can keep the event
    // loop alive indefinitely otherwise, hanging the CLI even though the hook's own work is done.
    // A write below MAX_INJECT_CHARS (20,000 bytes, well under a pipe's 64KB buffer) completes
    // synchronously on Linux/macOS before exit() runs, so this doesn't race the stdout write —
    // noriq-lock.mjs's own process.exit() calls rely on the same guarantee for their (much
    // smaller) stderr writes.
    .finally(() => process.exit(0));
}
