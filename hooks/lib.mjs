// Pure, dependency-free helpers for the Noriq file-lock hook (PLNR-209/210). No I/O here so it
// unit-tests without a network or a git repo; the CLI (noriq-lock.mjs) wires these to Noriq + git.

import { relative, resolve, isAbsolute } from 'node:path';

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
