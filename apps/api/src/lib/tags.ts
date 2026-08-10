// PLNR-194: tag-vocabulary hygiene helpers, shared by the ProjectRoom mint guard and
// the tag_report tool. Tags are a controlled FILTER vocabulary — the failure mode this
// fights is per-item keyword minting ("building" / "building-system" / "building-shell"),
// which bloats the vocabulary until filtering is useless.

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');

// Shared task/doc vocabulary contract. Keep transports out of this rule: MCP, Ask, and any
// future human-assistant surface should reject the same status/type/priority pseudo-tags.
const NON_DESCRIPTIVE_TAGS = new Set([
  'todo', 'in-progress', 'inprogress', 'blocked', 'review', 'in-review', 'done',
  'cancelled', 'canceled', 'backlog', 'wip', 'in-flight',
  'bug', 'feature', 'chore', 'research', 'task', 'epic', 'story', 'ticket',
  'p0', 'p1', 'p2', 'p3', 'p4', 'priority', 'high', 'medium', 'low', 'high-priority',
  'low-priority', 'urgent', 'critical', 'milestone',
]);
const TAG_GUIDANCE =
  'tags must be descriptive topic/area/component words (e.g. "oauth", "board-filters", "ws-resume"); ' +
  'the FIRST tag is the primary tag. Status, type, priority, and milestone have dedicated fields — never restate them as tags.';

/** Validate tag names when present. Empty arrays are valid for replacement-style updates. */
export function validateTagNames(tags: string[] | undefined): void {
  for (const raw of tags ?? []) {
    const normalized = norm(raw);
    if (!normalized) throw new Error(`empty tag — ${TAG_GUIDANCE}`);
    if (NON_DESCRIPTIVE_TAGS.has(normalized)) throw new Error(`"${raw}" is not a descriptive tag — ${TAG_GUIDANCE}`);
  }
}

/** Task creation requires at least one descriptive tag, with the first as the primary tag. */
export function requireDescriptiveTags(tags: string[] | undefined): void {
  if (!tags?.length) throw new Error(`tags are required — ${TAG_GUIDANCE}`);
  validateTagNames(tags);
}

/** Strip decorations that near-always mark a duplicate of an existing concept. */
const stem = (s: string) => norm(s).replace(/-(system|systems|core)$/, '').replace(/ies$/, 'y').replace(/s$/, '');

/** Existing tags that `candidate` is suspiciously close to: same stem, or one contains
 *  the other (shorter side ≥4 chars, so "ai"/"ui" never match everything). */
export function findNearDupes(candidate: string, existing: string[]): string[] {
  const c = norm(candidate);
  const cs = stem(candidate);
  const hits: string[] = [];
  for (const e of existing) {
    const en = norm(e);
    if (en === c) continue; // exact = same tag, not a dupe
    const shorter = c.length <= en.length ? c : en;
    if (stem(e) === cs || (shorter.length >= 4 && (en.includes(c) || c.includes(en)))) hits.push(e);
  }
  return hits.slice(0, 5);
}

/** Group a whole vocabulary into near-duplicate clusters (for tag_report). */
export function nearDupeGroups(names: string[]): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    const dupes = findNearDupes(n, names.filter((x) => x !== n && !seen.has(x)));
    if (dupes.length) {
      const group = [n, ...dupes];
      for (const g of group) seen.add(g);
      groups.push(group);
    }
  }
  return groups;
}
