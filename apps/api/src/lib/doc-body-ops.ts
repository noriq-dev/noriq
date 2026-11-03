/**
 * Shared helpers for large markdown project docs over MCP (PLNR-627):
 * outline parse, section/line slices, exact-string patches, content hash, size caps.
 */

import { sha256Hex } from './util';
import { docSearchCoverage } from '../search';

export const DOC_BODY_SOFT_MAX_BYTES = 512 * 1024;
/** Inline create/replace above this should steer agents to bodySource upload. */
export const DOC_BODY_INLINE_STEER_BYTES = 32 * 1024;
/** Full get_doc without section/lines: recommend outline-first above this. */
export const DOC_BODY_OUTLINE_HINT_CHARS = 12 * 1024;
export const DOC_PATCH_MAX_EDITS = 20;
export const DOC_PATCH_MAX_TEXT_CHARS = 32 * 1024;

export type DocWriteMode = 'replace' | 'append' | 'patch';

export interface DocPatchEdit {
  oldText: string;
  newText: string;
  /** 1-based occurrence to replace when oldText appears more than once. Default 1. */
  occurrence?: number;
}

export interface OutlineHeading {
  path: string;
  level: number;
  title: string;
  startLine: number;
  endLine: number;
  charStart: number;
  charEnd: number;
  childCount: number;
}

export interface DocSegment {
  path: string;
  level: number;
  title: string;
  startLine: number;
  endLine: number;
  bodyChars: number;
  included: boolean;
}

export interface DocSelection {
  mode: 'full' | 'section' | 'lines' | 'grep' | 'outline';
  path?: string;
  startLine?: number;
  endLine?: number;
}

export interface BodyMeta {
  bodyChars: number;
  contentHash: string;
  totalLines: number;
  searchIndexedChars: number;
  searchTruncated: boolean;
}

export class DocBodyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'too_large'
      | 'patch_ambiguous'
      | 'patch_missing'
      | 'patch_limit'
      | 'section_ambiguous'
      | 'section_missing'
      | 'range_invalid'
      | 'conflict'
      | 'mode_invalid',
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DocBodyError';
  }
}

export const hashDocBody = (body: string): Promise<string> => sha256Hex(body);

export function bodyMeta(body: string, contentHash: string): BodyMeta {
  const bodyChars = body.length;
  const coverage = docSearchCoverage(bodyChars);
  return {
    bodyChars,
    contentHash,
    totalLines: body.length === 0 ? 0 : body.split('\n').length,
    searchIndexedChars: coverage.searchIndexedChars,
    searchTruncated: coverage.searchTruncated,
  };
}

export function assertDocBodySize(body: string, label = 'doc body'): void {
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > DOC_BODY_SOFT_MAX_BYTES) {
    throw new DocBodyError(
      `${label} exceeds soft max ${DOC_BODY_SOFT_MAX_BYTES} bytes (${bytes}); use a shorter body or split the doc`,
      'too_large',
      { bytes, maxBytes: DOC_BODY_SOFT_MAX_BYTES },
    );
  }
}

export function inlineBodySteerHint(body: string | undefined | null): string | undefined {
  if (body == null) return undefined;
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes <= DOC_BODY_INLINE_STEER_BYTES) return undefined;
  return `Inline body is ${bytes} bytes (soft steer ${DOC_BODY_INLINE_STEER_BYTES}). Prefer bodySource.kind="upload" for create/replace of large markdown.`;
}

/** Split body into lines preserving whether the original ended with a trailing newline. */
function lineParts(body: string): { lines: string[]; endsWithNewline: boolean } {
  if (body.length === 0) return { lines: [], endsWithNewline: false };
  const endsWithNewline = body.endsWith('\n');
  const raw = endsWithNewline ? body.slice(0, -1) : body;
  return { lines: raw.length ? raw.split('\n') : [''], endsWithNewline };
}

function joinLines(lines: string[], endsWithNewline: boolean): string {
  if (!lines.length) return endsWithNewline ? '\n' : '';
  return lines.join('\n') + (endsWithNewline ? '\n' : '');
}

/** Line offsets (1-based line → char index of that line's first character). */
function lineCharStarts(body: string): number[] {
  const starts = [0];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * Parse ATX headings (`#`…`######`). Ignores Setext. Skips fenced code regions
 * (``` / ~~~) so `#` inside fences is not treated as a heading.
 */
export function parseMarkdownOutline(body: string): OutlineHeading[] {
  const { lines } = lineParts(body);
  const starts = lineCharStarts(body);
  const headings: Array<{ level: number; title: string; startLine: number; charStart: number }> = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceOpen = line.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const close = line.match(/^(\s{0,3})(`{3,}|~{3,})\s*$/);
      if (close && close[2]![0] === fence[0] && close[2]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceOpen) {
      fence = fenceOpen[2]!;
      continue;
    }
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    headings.push({
      level: m[1]!.length,
      title: m[2]!.trim(),
      startLine: i + 1,
      charStart: starts[i] ?? body.length,
    });
  }

  const stack: Array<{ level: number; title: string }> = [];
  const withPath: Array<OutlineHeading & { _idx: number }> = [];

  for (let hi = 0; hi < headings.length; hi++) {
    const h = headings[hi]!;
    while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push({ level: h.level, title: h.title });
    const path = stack.map((s) => s.title).join(' / ');
    const nextSameOrHigher = headings.findIndex((x, j) => j > hi && x.level <= h.level);
    const endLineExclusive = nextSameOrHigher === -1
      ? lines.length + 1
      : headings[nextSameOrHigher]!.startLine;
    const endLine = endLineExclusive - 1;
    const charEnd = endLineExclusive > lines.length
      ? body.length
      : (starts[endLineExclusive - 1] ?? body.length);
    withPath.push({
      path,
      level: h.level,
      title: h.title,
      startLine: h.startLine,
      endLine: Math.max(h.startLine, endLine),
      charStart: h.charStart,
      charEnd,
      childCount: 0,
      _idx: hi,
    });
  }

  for (let i = 0; i < withPath.length; i++) {
    const parent = withPath[i]!;
    let children = 0;
    for (let j = i + 1; j < withPath.length; j++) {
      const child = withPath[j]!;
      if (child.level <= parent.level) break;
      if (child.level === parent.level + 1) children++;
    }
    parent.childCount = children;
  }

  return withPath.map(({ _idx: _, ...rest }) => rest);
}

export function buildSegmentMap(
  body: string,
  included?: { startLine: number; endLine: number } | null,
): DocSegment[] {
  return parseMarkdownOutline(body).map((h) => {
    const sectionBody = body.slice(h.charStart, h.charEnd);
    const overlaps = included
      ? !(h.endLine < included.startLine || h.startLine > included.endLine)
      : false;
    return {
      path: h.path,
      level: h.level,
      title: h.title,
      startLine: h.startLine,
      endLine: h.endLine,
      bodyChars: sectionBody.length,
      included: overlaps,
    };
  });
}

export function sliceDocByLines(body: string, startLine: number, endLine: number): {
  body: string;
  startLine: number;
  endLine: number;
  selection: DocSelection;
} {
  const { lines, endsWithNewline } = lineParts(body);
  if (startLine < 1 || endLine < startLine || startLine > lines.length) {
    throw new DocBodyError(
      `invalid line range ${startLine}-${endLine} (doc has ${lines.length} lines)`,
      'range_invalid',
      { startLine, endLine, totalLines: lines.length },
    );
  }
  const end = Math.min(endLine, lines.length);
  const slice = joinLines(lines.slice(startLine - 1, end), endsWithNewline && end === lines.length);
  return {
    body: slice,
    startLine,
    endLine: end,
    selection: { mode: 'lines', startLine, endLine: end },
  };
}

function normalizePath(path: string): string {
  return path.split('/').map((s) => s.trim()).filter(Boolean).join(' / ');
}

export function sliceBySection(
  body: string,
  selector: { path?: string; title?: string; startLine?: number; endLine?: number },
  depth?: number,
): {
  body: string;
  startLine: number;
  endLine: number;
  path: string;
  selection: DocSelection;
} {
  if (selector.startLine != null && selector.endLine != null) {
    const sliced = sliceDocByLines(body, selector.startLine, selector.endLine);
    const outline = parseMarkdownOutline(body);
    const covering = outline.find((h) => h.startLine === sliced.startLine)
      ?? outline.find((h) => h.startLine <= sliced.startLine && h.endLine >= sliced.endLine);
    return {
      ...sliced,
      path: covering?.path ?? '',
      selection: { ...sliced.selection, path: covering?.path },
    };
  }

  const outline = parseMarkdownOutline(body);
  const pathNorm = selector.path ? normalizePath(selector.path) : undefined;
  const title = selector.title?.trim();

  let matches: OutlineHeading[] = [];
  if (pathNorm) {
    const byPath = outline.filter((h) => normalizePath(h.path) === pathNorm);
    matches = byPath.length ? byPath : outline.filter((h) => h.title === pathNorm);
  } else if (title) {
    const byPath = outline.filter((h) => normalizePath(h.path) === normalizePath(title));
    matches = byPath.length === 1 ? byPath : outline.filter((h) => h.title === title);
  } else {
    throw new DocBodyError('section selector requires path, title, or startLine/endLine', 'section_missing');
  }

  if (!matches.length) {
    throw new DocBodyError(
      `section not found: ${pathNorm ?? title}`,
      'section_missing',
      { candidates: outline.map((h) => h.path).slice(0, 40) },
    );
  }
  if (matches.length > 1) {
    throw new DocBodyError(
      `ambiguous section "${pathNorm ?? title}" — ${matches.length} matches; use a full path`,
      'section_ambiguous',
      { candidates: matches.map((h) => h.path) },
    );
  }

  const heading = matches[0]!;
  let endLine = heading.endLine;
  if (depth != null && depth >= 0) {
    const maxLevel = heading.level + depth;
    const { lines } = lineParts(body);
    // Recompute end as last line before next heading with level <= heading.level,
    // but also stop before any heading deeper than maxLevel's following peer... 
    // depth = nesting limit under section: include nested headings with level <= heading.level + depth
    // Default (undefined): full subtree until next same-or-higher (already in heading.endLine).
    // depth 0: only the heading line and content until the next heading of any level.
    const all = parseMarkdownOutline(body);
    const idx = all.findIndex((h) => h.startLine === heading.startLine && h.path === heading.path);
    if (idx >= 0) {
      let end = lines.length;
      for (let j = idx + 1; j < all.length; j++) {
        const next = all[j]!;
        if (next.level <= heading.level) {
          end = next.startLine - 1;
          break;
        }
        if (next.level > maxLevel) {
          end = next.startLine - 1;
          break;
        }
      }
      endLine = Math.max(heading.startLine, end);
    }
  }

  const sliced = sliceDocByLines(body, heading.startLine, endLine);
  return {
    ...sliced,
    path: heading.path,
    selection: { mode: 'section', path: heading.path, startLine: sliced.startLine, endLine: sliced.endLine },
  };
}

export function applyDocPatches(body: string, edits: DocPatchEdit[]): string {
  if (!edits.length) throw new DocBodyError('patch mode requires at least one edit', 'patch_limit');
  if (edits.length > DOC_PATCH_MAX_EDITS) {
    throw new DocBodyError(`patch allows at most ${DOC_PATCH_MAX_EDITS} edits per call`, 'patch_limit', {
      maxEdits: DOC_PATCH_MAX_EDITS,
      got: edits.length,
    });
  }
  let next = body;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    if (edit.oldText.length > DOC_PATCH_MAX_TEXT_CHARS || edit.newText.length > DOC_PATCH_MAX_TEXT_CHARS) {
      throw new DocBodyError(
        `edit[${i}] oldText/newText exceeds ${DOC_PATCH_MAX_TEXT_CHARS} chars`,
        'patch_limit',
      );
    }
    if (!edit.oldText.length) {
      throw new DocBodyError(`edit[${i}] oldText must be non-empty`, 'patch_missing');
    }
    const occurrence = edit.occurrence ?? 1;
    if (!Number.isInteger(occurrence) || occurrence < 1) {
      throw new DocBodyError(`edit[${i}] occurrence must be a positive integer`, 'patch_limit');
    }
    const positions: number[] = [];
    let from = 0;
    while (from <= next.length) {
      const at = next.indexOf(edit.oldText, from);
      if (at < 0) break;
      positions.push(at);
      from = at + Math.max(edit.oldText.length, 1);
    }
    if (positions.length === 0) {
      throw new DocBodyError(
        `edit[${i}] oldText not found in doc body — widen context or re-read with get_doc`,
        'patch_missing',
        { editIndex: i },
      );
    }
    if (positions.length > 1 && occurrence > positions.length) {
      throw new DocBodyError(
        `edit[${i}] occurrence ${occurrence} but only ${positions.length} matches`,
        'patch_ambiguous',
        { matches: positions.length, occurrence },
      );
    }
    if (positions.length > 1 && edit.occurrence == null) {
      throw new DocBodyError(
        `edit[${i}] oldText matches ${positions.length} times — pass occurrence (1-based) or widen oldText for a unique match`,
        'patch_ambiguous',
        { matches: positions.length, candidates: positions.slice(0, 5) },
      );
    }
    const matchCount = positions.length;
    if (matchCount !== 1 && edit.occurrence == null) {
      // unreachable due to above, kept for clarity
    }
    const targetIdx = occurrence - 1;
    if (targetIdx < 0 || targetIdx >= positions.length) {
      throw new DocBodyError(
        `edit[${i}] occurrence ${occurrence} out of range (${positions.length} matches)`,
        'patch_ambiguous',
        { matches: positions.length, occurrence },
      );
    }
    // When occurrence is set and there are multiple matches, replace only that one.
    // When exactly one match, replace it (occurrence must be 1 or omitted).
    if (positions.length === 1 && occurrence !== 1) {
      throw new DocBodyError(
        `edit[${i}] oldText matches once but occurrence=${occurrence}`,
        'patch_ambiguous',
        { matches: 1, occurrence },
      );
    }
    const at = positions[targetIdx]!;
    next = next.slice(0, at) + edit.newText + next.slice(at + edit.oldText.length);
  }
  return next;
}

export function resolveDocWriteBody(input: {
  mode?: DocWriteMode;
  body?: string;
  edits?: DocPatchEdit[];
  currentBody: string;
}): { nextBody: string; mode: DocWriteMode; bodyChanged: boolean } {
  const mode = input.mode ?? 'replace';
  if (mode !== 'replace' && mode !== 'append' && mode !== 'patch') {
    throw new DocBodyError(`invalid mode ${String(mode)}`, 'mode_invalid');
  }
  if (mode === 'patch') {
    if (input.body !== undefined) {
      throw new DocBodyError('patch mode uses edits[], not body', 'mode_invalid');
    }
    const nextBody = applyDocPatches(input.currentBody, input.edits ?? []);
    return { nextBody, mode, bodyChanged: nextBody !== input.currentBody };
  }
  if (mode === 'append') {
    if (input.body === undefined) {
      throw new DocBodyError('append mode requires body', 'mode_invalid');
    }
    if (input.edits?.length) {
      throw new DocBodyError('append mode does not accept edits', 'mode_invalid');
    }
    const nextBody = input.currentBody + input.body;
    return { nextBody, mode, bodyChanged: input.body.length > 0 };
  }
  // replace
  if (input.edits?.length) {
    throw new DocBodyError('replace mode does not accept edits — use mode:"patch"', 'mode_invalid');
  }
  if (input.body === undefined) {
    return { nextBody: input.currentBody, mode, bodyChanged: false };
  }
  return { nextBody: input.body, mode, bodyChanged: input.body !== input.currentBody };
}

export interface GrepHit {
  docId: string;
  path: string;
  line: number;
  preview: string;
  startLine: number;
  endLine: number;
}

export const GREP_DOCS_DEFAULT_SCAN_LIMIT = 100;
export const GREP_DOCS_MAX_SCAN_LIMIT = 200;

/**
 * Opaque cursor for grep pagination (updated_at DESC, id DESC).
 * - `{ u, i }` — continue with docs strictly after this doc (fully searched).
 * - `{ u, i, l }` — resume THIS doc starting after 1-based line `l`, then older docs.
 */
export function encodeGrepDocsCursor(updatedAt: string, id: string, afterLine?: number): string {
  const payload: { u: string; i: string; l?: number } = { u: updatedAt, i: id };
  if (afterLine != null && afterLine > 0) payload.l = afterLine;
  return btoa(JSON.stringify(payload));
}

export function decodeGrepDocsCursor(
  cursor: string,
): { updatedAt: string; id: string; afterLine?: number } | null {
  try {
    const raw = JSON.parse(atob(cursor)) as { u?: unknown; i?: unknown; l?: unknown };
    if (typeof raw.u !== 'string' || typeof raw.i !== 'string' || !raw.u || !raw.i) return null;
    let afterLine: number | undefined;
    if (raw.l !== undefined) {
      if (typeof raw.l !== 'number' || !Number.isInteger(raw.l) || raw.l < 1) return null;
      afterLine = raw.l;
    }
    return { updatedAt: raw.u, id: raw.i, ...(afterLine != null ? { afterLine } : {}) };
  } catch {
    return null;
  }
}

/**
 * Literal substring search over a doc body (ReDoS-safe — no caller RegExp).
 * Matching is per line; case folding uses toLocaleLowerCase when caseSensitive is false.
 * `startAfterLine` (1-based) skips lines 1..startAfterLine so a mid-doc hit-cap can resume.
 */
export function grepDocBody(
  docId: string,
  body: string,
  pattern: string,
  opts: { caseSensitive?: boolean; maxHits?: number; startAfterLine?: number } = {},
): GrepHit[] {
  if (!pattern.length) throw new DocBodyError('grep pattern must be non-empty', 'range_invalid');
  const maxHits = Math.min(Math.max(opts.maxHits ?? 50, 1), 200);
  const startAfter = Math.max(0, opts.startAfterLine ?? 0);
  const needle = opts.caseSensitive ? pattern : pattern.toLocaleLowerCase();
  const outline = parseMarkdownOutline(body);
  const { lines } = lineParts(body);
  const hits: GrepHit[] = [];
  for (let i = startAfter; i < lines.length; i++) {
    const line = lines[i]!;
    const hay = opts.caseSensitive ? line : line.toLocaleLowerCase();
    if (!hay.includes(needle)) continue;
    const lineNo = i + 1;
    const enclosing = [...outline].reverse().find((h) => h.startLine <= lineNo && h.endLine >= lineNo);
    hits.push({
      docId,
      path: enclosing?.path ?? '',
      line: lineNo,
      preview: line.slice(0, 240),
      startLine: enclosing?.startLine ?? lineNo,
      endLine: enclosing?.endLine ?? lineNo,
    });
    if (hits.length >= maxHits) break;
  }
  return hits;
}
