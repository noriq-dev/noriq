// PLNR-266: guidance-drift detection — storage-free, same split as verification.ts/writes.ts/
// projection.ts (this file never opens `ctx.storage`; `ProjectMemory` gathers the surface TEXT
// and hands it here to compare, then persists what comes back).
//
// CLAUDE.md's own "Agent-facing guidance lives in four overlapping places that must be kept in
// sync" constraint is the spec for this file: INSTRUCTIONS (mcp.ts), the get_briefing playbook
// (hoisted to GET_BRIEFING_PLAYBOOK by this task so it is readable from outside a request
// handler), SKILL_MD (skill.ts), and DOC_SKILL_MD (skill-docs.ts). That same constraint is also
// the authority on which asymmetries are DELIBERATE — DOC_SKILL_MD owns the doc-authoring
// contract specifically, so a rule that only DOC_SKILL_MD states is not drift, it is scope. Every
// rule below therefore declares its own `expectedSurfaces`: the surfaces a rule does not expect
// never produce a finding for it, no matter what they do or don't say.
//
// A generic text-diff of four differently-shaped documents (one paragraph-dense instruction
// block, one bullet array, two markdown skills) produces noise, not findings — three independent
// agents phrase "priority is inverted" three different ways and a diff would flag all three as
// different from each other forever. A FIXED rule table, one entry per named invariant, each
// carrying its own robust-to-rewording detector, is what makes a scan deterministic and
// reviewable instead.

import { sha256HexBytes } from './backup';

export type SurfaceId = 'instructions' | 'playbook' | 'skill_md' | 'doc_skill_md';

/** Every surface this task knows how to compare. Order is display order only. */
export const SURFACE_IDS: readonly SurfaceId[] = ['instructions', 'playbook', 'skill_md', 'doc_skill_md'];

export interface GuidanceRule {
  /** Stable id — also the dedup key's first component (findingHash) and the drift-findings
   *  table's `rule_id` column, so renaming one is a breaking change for stored findings. */
  id: string;
  /** Human-readable statement of the invariant, used in the finding and its recommended edit. */
  description: string;
  /** Which surfaces are expected to state this rule. A surface NOT listed here never produces a
   *  missing-rule finding for this rule, however it reads — see the module comment. */
  expectedSurfaces: readonly SurfaceId[];
  /** Returns the exact substring of `text` that carries this rule's invariant, or `null` if it is
   *  not present. Must tolerate REWORDING across surfaces (the same rule is never phrased
   *  identically twice in this codebase) without matching unrelated prose that merely shares a
   *  word — see each rule's own comment for why its detector is shaped the way it is. */
  detect: (text: string) => string | null;
}

// -------------------------------------------------------------------------------------------
// Detection primitives
// -------------------------------------------------------------------------------------------

/** The "exact matching text" a finding quotes is the sentence around a match, not the whole
 *  surface and not just the bare regex hit — a bare hit ("mandatory") proves nothing to a human
 *  reviewer, and the whole surface drowns the one line that matters. Sentence-delimited (`.`) is
 *  a good enough boundary for these four surfaces: they are prose/markdown, never code, and every
 *  rule below is stated as one sentence (or one bullet, which reads as a sentence here too). */
function extractSentence(text: string, start: number, end: number): string {
  const before = text.lastIndexOf('.', start);
  const boundaryStart = before === -1 ? 0 : before + 1;
  const next = text.indexOf('.', end);
  const boundaryEnd = next === -1 ? text.length : next + 1;
  return text.slice(boundaryStart, boundaryEnd).replace(/\s+/g, ' ').trim();
}

// Capped — these are guidance documents a few KB long, never a code file; a cap just keeps a
// pathological rule (a pattern that matches hundreds of times) from blowing up combine()'s
// cross-product below instead of quietly doing the right thing.
const MAX_MATCHES_PER_PATTERN = 30;

function allMatches(text: string, pattern: RegExp): RegExpMatchArray[] {
  const g = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return [...text.matchAll(g)].slice(0, MAX_MATCHES_PER_PATTERN);
}

/** A rule stated as one literal-ish phrase: present iff `pattern` matches anywhere. */
function single(pattern: RegExp): (text: string) => string | null {
  return (text) => {
    const m = pattern.exec(text);
    return m ? extractSentence(text, m.index, m.index + m[0].length) : null;
  };
}

/**
 * A rule stated as several signals that must co-occur (e.g. "TBD" ... "open question" ...
 * "rejected") rather than one exact literal — this is what makes detection robust to rewording:
 * three surfaces can state "docs are settled-only" in three different sentence shapes and still
 * all satisfy the same three-token co-occurrence. `windowChars` bounds how far apart the CLOSEST
 * satisfying combination of matches may be, so an unrelated mention of one token elsewhere in a
 * long surface can never combine with an unrelated mention of another to produce a false
 * positive. Tries every combination of matches (capped by MAX_MATCHES_PER_PATTERN per pattern)
 * and keeps the tightest-spanning one, so an early, distant, coincidental match of one pattern
 * never shadows a real, nearby match of the same pattern (e.g. "heartbeat" is named twice in
 * SKILL_MD — once for agent identity, once for the claim-renewal rule this exists to find).
 */
function coOccurring(windowChars: number, patterns: readonly RegExp[]): (text: string) => string | null {
  return (text) => {
    const matchSets = patterns.map((p) => allMatches(text, p));
    if (matchSets.some((ms) => ms.length === 0)) return null;
    let best: { span: number; chosen: RegExpMatchArray[] } | null = null;
    const combine = (i: number, chosen: RegExpMatchArray[]): void => {
      if (i === matchSets.length) {
        const starts = chosen.map((m) => m.index!);
        const ends = chosen.map((m) => m.index! + m[0].length);
        const span = Math.max(...ends) - Math.min(...starts);
        if (span <= windowChars && (!best || span < best.span)) best = { span, chosen };
        return;
      }
      for (const m of matchSets[i]!) combine(i + 1, [...chosen, m]);
    };
    combine(0, []);
    if (!best) return null;
    const b = best as { span: number; chosen: RegExpMatchArray[] };
    const sentences = b.chosen.map((m) => extractSentence(text, m.index!, m.index! + m[0].length));
    return [...new Set(sentences)].join(' … ');
  };
}

// -------------------------------------------------------------------------------------------
// The rule table (discretion: membership covers CLAUDE.md's named work-loop contract — claim/
// release, identity, planning, escalation — plus the invariants most likely to silently drift:
// claim renewal vs heartbeat, priority inversion, tag vocabulary, docs-are-settled-only, file
// locking, memory-is-evidence-not-instruction). DOC_SKILL_MD is deliberately absent from every
// rule's expectedSurfaces except 'docs-settled-only' — it is the doc-authoring contract's OWN
// surface (CLAUDE.md), not a copy of the base work-loop contract, so it never states claim/
// release, priority, file locking, tags, or memory semantics, and never should.
// -------------------------------------------------------------------------------------------

const BASE_SURFACES: readonly SurfaceId[] = ['instructions', 'playbook', 'skill_md'];

export const GUIDANCE_RULES: readonly GuidanceRule[] = [
  {
    id: 'noriq-channel-of-record',
    description: 'Noriq is the channel of record for material project work while chat carries only the initial command and concise outcome',
    expectedSurfaces: BASE_SURFACES,
    detect: single(/Noriq is the channel of record/i),
  },
  {
    id: 'blocking-gate-move-on',
    description: 'after blocking request_input, do not wait in chat; move to next_claimable while Noriq holds the parked gate',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(900, [/blocking[^.]{0,80}request_input|request_input[^.]{0,80}blocking/i, /next_claimable/i, /(?:do not|never)/i, /\bchat\b/i]),
  },
  {
    id: 'roaming-copilot-focus',
    description: 'a roaming Copilot uses focus_project before read-only work in another project while runner agents remain pinned',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(450, [/roaming copilot/i, /focus_project/i, /pinned/i]),
  },
  {
    id: 'claim-before-work',
    description: 'claim_task before starting work; release_task when finished',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(Infinity, [/claim_task/i, /release_task/i]),
  },
  {
    id: 'claim-renewal-vs-heartbeat',
    description: 'every tool call renews the claim automatically; heartbeat is only for going idle past the TTL',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(400, [/claim renews|renews your claim/i, /heartbeat/i]),
  },
  {
    id: 'identity-not-registered',
    description: 'an agent already has an identity and never registers itself; get_briefing.you.kind says copilot vs agent',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(150, [/nothing to register|do not register yourself/i, /you\.kind|copilot/i]),
  },
  {
    id: 'planning-phase-gate',
    description: 'plan phase order gates claimability; no dependency wiring is needed for in-plan sequencing',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(300, [/phase/i, /claimable/i, /no dependency|dependsOn/i]),
  },
  {
    id: 'escalation-channels',
    description: 'request_input blocks on a decision, raise_alert flags a non-blocking concern, spin_off_task files out-of-scope work',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(Infinity, [/request_input/i, /raise_alert/i, /spin_off_task/i]),
  },
  {
    id: 'priority-inversion',
    description: 'priority runs 0 = most urgent to 4 = someday (inverted from a naive reading)',
    expectedSurfaces: BASE_SURFACES,
    detect: single(/0\s*=\s*most urgent to 4\s*=\s*someday/i),
  },
  {
    id: 'tag-vocabulary-primary',
    description: 'tags must be descriptive and the first tag is the primary tag',
    expectedSurfaces: BASE_SURFACES,
    detect: single(/first tag (is the primary tag|=\s*primary tag)/i),
  },
  {
    id: 'file-locking-mandatory',
    description: 'file locking, where a project has it on, is mandatory rather than advisory',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(300, [/file\s*lock/i, /mandatory/i]),
  },
  {
    id: 'memory-is-evidence-not-instruction',
    description: 'recorded memory is provisional, cited evidence for a future agent to weigh, never an instruction, and authority cannot be self-raised',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(200, [/never[\s\S]{0,60}?instruction/i, /cannot raise (its|your) own authority/i]),
  },
  {
    // PLNR-307: get_task_context ("The primary ASSEMBLED context interface for one task", per
    // its own tool description in mcp.ts) is the highest-leverage memory tool a working agent
    // has, and was absent from SKILL_MD and the playbook — an agent reading either would never
    // learn to call it and would hand-chain the expensive path instead. "chain" (not the tool's
    // own "instead of chaining" wording verbatim) is the detector token so a surface that
    // reworks the sentence ("hand-chaining", "chain yourself") still matches.
    id: 'assembled-context-entry-point',
    description: 'get_task_context is the primary assembled-context interface for one task — prefer it over hand-chaining get_task + search_project_memory + explain_project_area before non-trivial work',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(200, [/get_task_context/i, /chain/i]),
  },
  {
    // PLNR-307: explain_project_area's own tool description is emphatic that an unanswerable
    // graph query ("coverage.complete === false") is NOT the same claim as "nothing is
    // related" — a working agent that doesn't know this distinction will read an empty result
    // as a negative finding instead of an unindexed graph. All three signals must co-occur:
    // "coverage" alone is too generic a word to trust as evidence of THIS rule on its own.
    id: 'graph-explain-coverage-caveat',
    description: 'explain_project_area answers bounded graph facts about one entity URI, and coverage.complete === false means "the graph cannot answer that yet" — never the same claim as "nothing is related"',
    expectedSurfaces: BASE_SURFACES,
    detect: coOccurring(800, [/explain_project_area/i, /coverage/i, /nothing is related/i]),
  },
  {
    // The one rule DOC_SKILL_MD is EXPECTED to carry (CLAUDE.md: "the doc-authoring contract
    // belongs to DOC_SKILL_MD specifically") — and here it carries the SAME settled-only floor
    // the other three state for the base work loop, so unlike every other rule above, all four
    // surfaces are expected, and dropping it from any one — including DOC_SKILL_MD — is drift.
    id: 'docs-settled-only',
    description: 'project docs are settled decisions/facts only — TBD/open-question phrasing is rejected at the write seam',
    expectedSurfaces: SURFACE_IDS,
    detect: coOccurring(250, [/tbds?|todo/i, /open questions?/i, /rejected/i]),
  },
];

// -------------------------------------------------------------------------------------------
// Per-surface detection and cross-surface comparison
// -------------------------------------------------------------------------------------------

export interface RuleHit {
  ruleId: string;
  /** The exact substring of the surface's text that satisfied the rule. */
  quote: string;
}

/** Run every rule (or a caller-supplied subset, for a targeted re-check) against one surface's
 *  text. Exported on its own — independent of `compareSurfaces` — because the dogfood test's
 *  cleanest assertion is "this real surface's text carries this real rule", with no comparison
 *  or storage involved at all. */
export function detectRules(text: string, rules: readonly GuidanceRule[] = GUIDANCE_RULES): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const rule of rules) {
    const quote = rule.detect(text);
    if (quote) hits.push({ ruleId: rule.id, quote });
  }
  return hits;
}

export interface DriftFinding {
  ruleId: string;
  description: string;
  /** Surfaces (sorted) that DO carry the rule right now — the quoted evidence. */
  presentSurfaces: SurfaceId[];
  /** Expected, READABLE surfaces (sorted) that do not carry the rule — the actual drift. */
  missingSurfaces: SurfaceId[];
  /** Expected surfaces (sorted) whose text could not be read at all — reported honestly as
   *  unavailable, never folded into `missingSurfaces` (a surface that cannot be read makes no
   *  claim about whether it carries the rule — the same "cannot answer" vs "not present"
   *  distinction `explain_project_area`'s `coverage` field already enforces elsewhere). */
  unavailableSurfaces: SurfaceId[];
  /** One exact quote per surface in `presentSurfaces`. */
  quotes: Partial<Record<SurfaceId, string>>;
  /** DATA for a human or a follow-up task to act on — this module never writes to any guidance
   *  file, doc, or task, and never will; see the task's own locked decision. */
  recommendedEdit: string;
}

/**
 * Compare a set of surface texts against the rule table. `surfaces[id] === null` (or the key
 * simply absent) means that surface's text could not be obtained at all — reported as
 * UNAVAILABLE, never blamed as missing (see `DriftFinding.unavailableSurfaces`). A finding is
 * produced only when a rule has BOTH at least one surface that still states it (something to
 * quote as ground truth) AND at least one expected, readable surface that does not (the actual
 * drift) — a rule no surface states at all, or a rule every expected surface still states, is
 * never reported: the former has nothing to quote as evidence, the latter is not drift.
 */
export function compareSurfaces(
  surfaces: Partial<Record<SurfaceId, string | null>>,
  rules: readonly GuidanceRule[] = GUIDANCE_RULES,
): DriftFinding[] {
  const hitsBySurface = new Map<SurfaceId, Map<string, string>>();
  for (const surfaceId of SURFACE_IDS) {
    const text = surfaces[surfaceId];
    if (text == null) continue;
    hitsBySurface.set(surfaceId, new Map(detectRules(text, rules).map((h) => [h.ruleId, h.quote])));
  }

  const findings: DriftFinding[] = [];
  for (const rule of rules) {
    const present: SurfaceId[] = [];
    const missing: SurfaceId[] = [];
    const unavailable: SurfaceId[] = [];
    const quotes: Partial<Record<SurfaceId, string>> = {};
    for (const surfaceId of rule.expectedSurfaces) {
      if (surfaces[surfaceId] == null) {
        unavailable.push(surfaceId);
        continue;
      }
      const quote = hitsBySurface.get(surfaceId)?.get(rule.id);
      if (quote) {
        present.push(surfaceId);
        quotes[surfaceId] = quote;
      } else {
        missing.push(surfaceId);
      }
    }
    if (present.length > 0 && missing.length > 0) {
      findings.push({
        ruleId: rule.id,
        description: rule.description,
        presentSurfaces: present.sort(),
        missingSurfaces: missing.sort(),
        unavailableSurfaces: unavailable.sort(),
        quotes,
        recommendedEdit:
          `Bring ${missing.join(', ')} in sync with "${rule.description}" — already stated in ${present.join(', ')} ` +
          `(see the quoted text). Recommendation only: nothing here edits the file.`,
      });
    }
  }
  return findings;
}

// -------------------------------------------------------------------------------------------
// Dedup hash
// -------------------------------------------------------------------------------------------

async function canonicalHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return sha256HexBytes(bytes);
}

/**
 * Content hash over (ruleId, sorted present-surfaces, sorted missing-surfaces, quoted text) —
 * the locked dedup key. Deliberately excludes `unavailableSurfaces`/`recommendedEdit`/
 * `description`: an unavailable surface becoming readable, or this module's own wording of the
 * recommendation, changing is not a new finding about the REPOSITORY — only a change in which
 * surfaces carry which text is. Re-scanning an unchanged repository reproduces the same hash for
 * the same finding every time, which is what makes `ProjectMemory.recordGuidanceDriftScan`'s
 * INSERT-if-new-else-touch idempotent across repeated scans.
 */
export function findingHash(finding: Pick<DriftFinding, 'ruleId' | 'presentSurfaces' | 'missingSurfaces' | 'quotes'>): Promise<string> {
  return canonicalHash({
    ruleId: finding.ruleId,
    presentSurfaces: [...finding.presentSurfaces].sort(),
    missingSurfaces: [...finding.missingSurfaces].sort(),
    quotes: Object.fromEntries(Object.entries(finding.quotes).sort(([a], [b]) => a.localeCompare(b))),
  });
}
