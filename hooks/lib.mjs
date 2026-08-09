// Shared helpers for the Noriq Claude Code hooks (PLNR-209/210 file-lock, PLNR-308 memory pulse).
// Two kinds of exports live here:
//   - PURE, dependency-free helpers (extractPaths/parseBashTargets/toRepoRelative/denyReason) — no
//     I/O, so they unit-test without a network or a git repo.
//   - Thin I/O helpers every hook CLI needs (stdin, git, the `.noriq/project.toml` marker, calling
//     Noriq over MCP, resolving a project ref, a wall-clock timeout) — hoisted here so noriq-lock.mjs
//     and noriq-memory.mjs share ONE implementation instead of two that can drift (locked decision,
//     PLNR-308: "the existing suite passing unmodified is the evidence the refactor was
//     behaviour-preserving" — every function below is byte-identical in behavior to what
//     noriq-lock.mjs inlined before this split).

import { relative, resolve, isAbsolute, join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

// -----------------------------------------------------------------------------------------------
// Pure helpers (PLNR-209/210) — unchanged.
// -----------------------------------------------------------------------------------------------

/** The write set a tool is about to touch. Returns absolute/relative paths as the tool gave them
 *  (the CLI makes them repo-relative). Bash is best-effort and fails OPEN (returns []) on anything
 *  it can't parse confidently — a false block on a shell command is worse than a missed lock. */
export function extractPaths(toolName, toolInput = {}) {
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return toolInput.file_path ? [toolInput.file_path] : [];
    case 'NotebookEdit':
      return toolInput.notebook_path ? [toolInput.notebook_path] : [];
    case 'Bash':
      return parseBashTargets(toolInput.command ?? '');
    default:
      return [];
  }
}

/** Best-effort extraction of files a shell command WRITES. Conservative: bails to [] on any dynamic
 *  construct (command substitution, variables, globs, unmatched quotes) rather than guess wrong. */
export function parseBashTargets(command) {
  if (!command || /[$`*?[]|<\(/.test(command)) return []; // dynamic / glob / process-sub → don't guess
  const targets = new Set();
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const toks = tokenize(segment);
    if (!toks.length) continue;
    // Redirections write their target: `foo > out`, `>> out`.
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if ((t === '>' || t === '>>') && toks[i + 1]) targets.add(toks[i + 1]);
      else if (/^>>?[^>].*/.test(t)) targets.add(t.replace(/^>>?/, '')); // `>out`
    }
    let cmd = toks[0];
    let rest = toks.slice(1);
    if (cmd === 'git') { cmd = `git ${rest[0] ?? ''}`.trim(); rest = rest.slice(1); }
    const files = rest.filter((a) => a !== '--' && !a.startsWith('-') && a !== '>' && a !== '>>');
    switch (cmd) {
      case 'rm': case 'mv': case 'cp': case 'touch': case 'tee':
      case 'git rm': case 'git mv':
        files.forEach((f) => targets.add(f));
        break;
      case 'git checkout': case 'git restore':
        // Only the pathspec after `--` is a write to the working tree; a bare branch checkout isn't.
        { const dd = toks.indexOf('--'); if (dd !== -1) toks.slice(dd + 1).forEach((f) => f && targets.add(f)); }
        break;
      default:
        break;
    }
  }
  return [...targets].filter(Boolean);
}

/** Minimal shell tokenizer: splits on whitespace, honoring simple single/double quotes. */
function tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Make a tool-supplied path repo-relative POSIX, or null if it escapes the repo (skip locking it). */
export function toRepoRelative(p, gitRoot, cwd) {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(gitRoot, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null; // outside the repo
  return rel.split(/[\\/]/).join('/');
}

/** Build the human-readable deny reason from an acquire conflict payload. */
export function denyReason(conflicts = []) {
  const lines = conflicts.map((c) => {
    const who = c.holderName || c.holderAgentId || 'another session';
    const forTask = c.taskKey ? ` for ${c.taskKey}` : '';
    const until = c.expiresAt ? ` until ${c.expiresAt}` : '';
    return `  • ${c.path} — locked by ${who}${forTask}${until}`;
  });
  return `Noriq file lock: another agent holds ${conflicts.length === 1 ? 'a file' : 'files'} you are about to edit.\n${lines.join('\n')}\nCoordinate (send_message / handoff_task) or wait, then retry.`;
}

// -----------------------------------------------------------------------------------------------
// I/O helpers shared by every hook CLI (PLNR-308 hoists these out of noriq-lock.mjs).
// -----------------------------------------------------------------------------------------------

export const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Read this process's hook JSON payload off stdin (fd 0). `{}` on anything unparseable, so a
 *  malformed/empty payload degrades to "no fields present" rather than throwing. */
export function readStdinPayload() {
  return safeJson(readFileSync(0, 'utf8')) ?? {};
}

/** Run `git <args>` in `cwd`, returning trimmed stdout or null on any failure (not a git repo, git
 *  missing, non-zero exit). Never throws. */
export function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

/** Tiny `.noriq/project.toml` reader — just the two scalars the hooks use, no TOML dependency. */
export function readNoriqMarker(gitRoot) {
  try {
    const txt = readFileSync(join(gitRoot, '.noriq', 'project.toml'), 'utf8');
    const key = txt.match(/^\s*key\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    const defaultBranch = txt.match(/^\s*defaultBranch\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    return { key, defaultBranch };
  } catch { return { key: null, defaultBranch: null }; }
}

/** A deterministic per-repo session id: `${prefix}-${sha1(gitRoot)[:16]}` — stable across
 *  invocations (so re-runs renew/resume the same Noriq agent identity rather than minting a new one
 *  every time), distinct per hook purpose (a lock-hook session and a memory-hook session never
 *  collide even when NORIQ_SESSION is unset for both), and distinct per repo checkout. */
export function defaultSessionId(prefix, gitRoot) {
  return `${prefix}-${createHash('sha1').update(gitRoot).digest('hex').slice(0, 16)}`;
}

/**
 * Call one Noriq MCP tool over `${cfg.url}/mcp`. `opts.signal`, when given, aborts the request —
 * every caller of this function that wants a wall-clock budget passes one; callers that omit it
 * (noriq-lock.mjs, unchanged) get the exact same unbounded-fetch behavior as before this file split.
 * Response is JSON or an SSE frame carrying the JSON-RPC message, matching @hono/mcp's transport.
 */
export async function callTool(cfg, name, args, opts = {}) {
  const res = await fetch(`${cfg.url}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': cfg.session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: opts.signal,
  });
  const raw = await res.text();
  if (res.status !== 200) throw new Error(`${name} → HTTP ${res.status}`);
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

/** Resolve NORIQ_PROJECT (id or key) → prj_ id, caching key→id lookups per (url,key) in the OS temp
 *  dir so repeated hook invocations (one per tool call) don't re-list projects every time. */
export async function resolveProjectId(cfg, projectRef, opts = {}) {
  if (!projectRef) return null;
  if (projectRef.startsWith('prj_')) return projectRef;
  const cacheDir = join(tmpdir(), 'noriq-lock');
  const cacheFile = join(cacheDir, createHash('sha1').update(`${cfg.url}::${projectRef}`).digest('hex') + '.json');
  try { return JSON.parse(readFileSync(cacheFile, 'utf8')).id; } catch { /* miss */ }
  const listed = await callTool(cfg, 'list_projects', {}, opts);
  const match = (listed.body?.projects ?? []).find((p) => p.key === projectRef || p.id === projectRef);
  if (!match) return null;
  try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ id: match.id })); } catch { /* non-fatal */ }
  return match.id;
}

/**
 * A single wall-clock deadline shared across every network call in one hook invocation — not a
 * per-call timeout. Every `fetch` given this `signal` aborts the instant the deadline passes, so a
 * chain of sequential calls (resolve project → localize → get_briefing) can never together exceed
 * `ms`, however many of them there are. `cancel()` MUST be called once the hook is done (success or
 * failure) — the underlying timer is `unref`'d so it can never itself keep the process alive, but
 * clearing it promptly avoids a dangling handle during tests.
 */
export function withDeadline(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === 'function') timer.unref();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}
