#!/usr/bin/env node
// Noriq file-lock hook (PLNR-209/210). Wire into Claude Code as a PreToolUse hook (and, optionally,
// a Stop hook) — see hooks/README.md. It turns Noriq's ADVISORY locks into best-effort ENFORCEMENT
// at the copilot's tool boundary: before an Edit/Write/rename it acquires the lock, and DENIES the
// edit if another session holds it.
//
// Design rule: FAIL OPEN. A missing config, an unreachable server, a parse it isn't sure of — none
// of these block your edit (a broken lock server must never halt work). ONLY a genuine, confirmed
// conflict denies. Hard, can't-fail-open enforcement is the Noriq Runner's job (the RUN plan).
//
// Config (env; the CLI also reads .noriq/project.toml for key + defaultBranch):
//   NORIQ_URL      Noriq base URL, e.g. https://plan.frs.llc          (required)
//   NORIQ_TOKEN    an OAuth/MCP access token for your Noriq account   (required)
//   NORIQ_PROJECT  a prj_… id, or a project KEY (resolved + cached).  (default: .noriq key)
//   NORIQ_BRANCH   branch scope for the lock       (default: current git branch, then .noriq)
//   NORIQ_SESSION  lock-holder session id          (default: stable per-repo id)
//   NORIQ_TASK     link acquired locks to this task id/key (optional)
//
// PLNR-308: the config/transport/session helpers below (git, .noriq marker, MCP tools/call, project
// resolution) moved into lib.mjs so hooks/noriq-memory.mjs can share them — this file's own
// behavior is unchanged (see hooks/lib.test.mjs + hooks/integration.test.mjs, both unmodified).

import { extractPaths, toRepoRelative, denyReason, git, readNoriqMarker, readStdinPayload, defaultSessionId, callTool, resolveProjectId } from './lib.mjs';

const ALLOW = 0;
const DENY = 2; // PreToolUse: exit 2 blocks the tool and feeds stderr back to Claude

function allow() { process.exit(ALLOW); }
function deny(reason) { process.stderr.write(reason + '\n'); process.exit(DENY); }
/** Fail-open: warn (non-fatally) and allow. */
function bail(msg) { process.stderr.write(`[noriq-lock] ${msg} — allowing (advisory).\n`); process.exit(ALLOW); }

async function main() {
  const payload = readStdinPayload();
  const event = payload.hook_event_name;
  const cwd = payload.cwd || process.cwd();
  const gitRoot = git(['rev-parse', '--show-toplevel'], cwd);
  if (!gitRoot) bail('not a git repo');

  const url = process.env.NORIQ_URL;
  const token = process.env.NORIQ_TOKEN;
  if (!url || !token) bail('NORIQ_URL / NORIQ_TOKEN not set');
  const marker = readNoriqMarker(gitRoot);
  const session = process.env.NORIQ_SESSION || defaultSessionId('noriq-lock', gitRoot);
  const cfg = { url: url.replace(/\/$/, ''), token, session };

  const projectId = await resolveProjectId(cfg, process.env.NORIQ_PROJECT || marker.key);
  if (!projectId) bail('could not resolve NORIQ_PROJECT (set a prj_ id or a reachable key / .noriq marker)');
  const branch = process.env.NORIQ_BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot) || marker.defaultBranch;

  if (event === 'Stop' || event === 'SubagentStop') {
    // Session ended → release everything this hook-agent holds (best-effort).
    try {
      const mine = await callTool(cfg, 'list_locks', { projectId, mine: true });
      const ids = (mine.body?.locks ?? []).map((l) => l.id);
      if (ids.length) await callTool(cfg, 'release_lock', { projectId, lockIds: ids });
    } catch (e) { /* fail open on cleanup */ }
    allow();
  }

  if (event && event !== 'PreToolUse') allow(); // not our event

  // PreToolUse: acquire the write set before the edit.
  const raw = extractPaths(payload.tool_name, payload.tool_input || {});
  const paths = [...new Set(raw.map((p) => toRepoRelative(p, gitRoot, cwd)).filter(Boolean))];
  if (!paths.length) allow(); // nothing lockable (a read, an unparsed Bash, an out-of-repo path)

  let result;
  try {
    result = await callTool(cfg, 'acquire_lock', {
      projectId, paths, branch: branch || undefined, allBranches: branch ? undefined : true,
      taskId: process.env.NORIQ_TASK || undefined,
    });
  } catch (e) {
    bail(`acquire_lock failed (${e.message})`); // server hiccup → advisory, don't block
  }
  if (result.isError) {
    // "file locking not enabled" and the like are not conflicts — don't block the user's edit.
    if (/not enabled/i.test(result.text)) allow();
    bail(result.text.replace(/^Error:\s*/, ''));
  }
  if (result.body?.ok === false) deny(denyReason(result.body.conflicts || []));
  allow(); // granted (or renewed)
}

main().catch((e) => bail(`unexpected ${e?.message ?? e}`));
