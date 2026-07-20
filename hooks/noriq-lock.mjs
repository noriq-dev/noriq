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

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPaths, toRepoRelative, denyReason } from './lib.mjs';

const ALLOW = 0;
const DENY = 2; // PreToolUse: exit 2 blocks the tool and feeds stderr back to Claude

function allow() { process.exit(ALLOW); }
function deny(reason) { process.stderr.write(reason + '\n'); process.exit(DENY); }
/** Fail-open: warn (non-fatally) and allow. */
function bail(msg) { process.stderr.write(`[noriq-lock] ${msg} — allowing (advisory).\n`); process.exit(ALLOW); }

function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

/** Tiny .noriq/project.toml reader — just the two scalars we use, no TOML dep. */
function readNoriqMarker(gitRoot) {
  try {
    const txt = readFileSync(join(gitRoot, '.noriq', 'project.toml'), 'utf8');
    const key = txt.match(/^\s*key\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    const defaultBranch = txt.match(/^\s*defaultBranch\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    return { key, defaultBranch };
  } catch { return { key: null, defaultBranch: null }; }
}

async function callTool(cfg, name, args) {
  const res = await fetch(`${cfg.url}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': cfg.session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  if (res.status !== 200) throw new Error(`${name} → HTTP ${res.status}`);
  // Response is JSON or an SSE frame carrying the JSON-RPC message.
  let msg;
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    msg = JSON.parse(data);
  } else {
    msg = JSON.parse(raw);
  }
  if (msg.error) throw new Error(`${name} rpc: ${JSON.stringify(msg.error)}`);
  const text = msg.result?.content?.[0]?.text ?? '';
  const jsonPart = text.split('\n\n--- notices ---\n')[0];
  return { isError: msg.result?.isError === true, text, body: safeJson(jsonPart) };
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Resolve NORIQ_PROJECT (id or key) → prj_ id, caching key→id lookups per (url,key). */
async function resolveProjectId(cfg, projectRef) {
  if (!projectRef) return null;
  if (projectRef.startsWith('prj_')) return projectRef;
  const cacheDir = join(tmpdir(), 'noriq-lock');
  const cacheFile = join(cacheDir, createHash('sha1').update(`${cfg.url}::${projectRef}`).digest('hex') + '.json');
  try { return JSON.parse(readFileSync(cacheFile, 'utf8')).id; } catch { /* miss */ }
  const listed = await callTool(cfg, 'list_projects', {});
  const match = (listed.body?.projects ?? []).find((p) => p.key === projectRef || p.id === projectRef);
  if (!match) return null;
  try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ id: match.id })); } catch { /* non-fatal */ }
  return match.id;
}

async function main() {
  const payload = safeJson(readFileSync(0, 'utf8')) ?? {}; // hook JSON on stdin (fd 0)
  const event = payload.hook_event_name;
  const cwd = payload.cwd || process.cwd();
  const gitRoot = git(['rev-parse', '--show-toplevel'], cwd);
  if (!gitRoot) bail('not a git repo');

  const url = process.env.NORIQ_URL;
  const token = process.env.NORIQ_TOKEN;
  if (!url || !token) bail('NORIQ_URL / NORIQ_TOKEN not set');
  const marker = readNoriqMarker(gitRoot);
  const session = process.env.NORIQ_SESSION || `noriq-lock-${createHash('sha1').update(gitRoot).digest('hex').slice(0, 16)}`;
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
