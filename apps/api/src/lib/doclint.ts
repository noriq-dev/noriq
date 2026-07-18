// PLNR-183: the docs contract. A project doc is a STATIC, COMPLETE entity that states
// explicit design decisions and facts. Open-ended material — pending decisions, TODOs,
// questions to the reader — fails the contract: it misleads every agent that reads it as
// settled truth. The unresolved form belongs in request_input (get the decision) or a
// task/plan (do the work); the doc records the OUTCOME.
//
// Enforced at the ProjectRoom write seam (createDoc/updateDoc), so MCP agents and the
// human UI meet the same bar. Fenced code blocks are exempt (code legitimately contains
// `?`, TODO markers in examples, etc.).

export interface DocLintViolation {
  line: number;      // 1-based
  text: string;      // the offending line, trimmed
  reason: string;
}

const MARKERS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(TBD|TODO|FIXME|WIP)\b/, reason: 'unfinished-work marker — finish the decision, then document it' },
  { re: /\bopen question/i, reason: 'open question — resolve it (request_input) and record the answer' },
  { re: /\bto be (decided|determined|defined|figured out)\b/i, reason: 'pending decision — docs record decisions already made' },
  { re: /\b(not yet|still) (decided|determined|defined|settled|clear)\b/i, reason: 'pending decision — docs record decisions already made' },
  { re: /\bundecided\b/i, reason: 'pending decision — docs record decisions already made' },
  { re: /\bwe (should|need to|still need to|have to) (discuss|decide|determine|figure out|revisit|think about)\b/i, reason: 'deferred decision — decide first, then document' },
  { re: /\b(needs?|requires?) (a |further |more )?(decision|discussion|investigation|clarification)\b/i, reason: 'deferred decision — decide first, then document' },
];

/** Lint a doc body against the contract. Empty result = passes. */
export function lintDocBody(body: string): DocLintViolation[] {
  const violations: DocLintViolation[] = [];
  let inFence = false;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence || !line) continue;
    for (const { re, reason } of MARKERS) {
      if (re.test(line)) { violations.push({ line: i + 1, text: line, reason }); break; }
    }
    // A line that ENDS with a question mark is asking the reader something —
    // a doc must answer, not ask. (Trailing markdown emphasis/quotes tolerated.)
    if (/\?\s*[*_`")\]]*$/.test(line) && line.includes('?')) {
      violations.push({ line: i + 1, text: line, reason: 'ends with a question — docs state answers, not questions' });
    }
  }
  return violations;
}

/** Throw a readable, actionable error if the body fails the contract. */
export function requireDecisionOnlyDoc(body: string | undefined): void {
  if (!body) return;
  const violations = lintDocBody(body);
  if (!violations.length) return;
  const shown = violations.slice(0, 8)
    .map((v) => `  line ${v.line}: "${v.text.length > 80 ? `${v.text.slice(0, 80)}…` : v.text}" — ${v.reason}`)
    .join('\n');
  const more = violations.length > 8 ? `\n  …and ${violations.length - 8} more` : '';
  throw new Error(
    `doc rejected — docs are static, complete records of explicit decisions and facts, and this body is open-ended:\n${shown}${more}\n` +
    'Resolve the open points first (ask a human via request_input, or track the work as a task), then write the doc stating the outcome.',
  );
}
