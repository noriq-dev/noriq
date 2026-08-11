import { MemoryNodeType } from '@noriq-dev/shared';

/**
 * Constellation Navigator — entity type → shape/token/label encoding (PLNR-437).
 *
 * One exported table, read by BOTH the WebGL renderer (MemoryConstellation3D.tsx, via
 * `resolveConstellationToken`) and DOM consumers (legend, catalogue rows, inspector chips, added
 * by later phase-2 tasks) — "the same type looks identical on canvas and in text" is the whole
 * point of this file existing. It replaces `hueFor()`, the FNV-1a hash-into-hue function this
 * plan's audit doc (pdoc_msopdg2u602z4b0q3i2n) disposed as "Delete — an arbitrary palette that is
 * unstable under type renames and undesigned in light mode."
 *
 * Shape stays the PRIMARY type carrier (PLNR-377, restated in the Navigator conventions doc
 * §1) — colour only reinforces it, never substitutes for it. `theme.css` tokens are the only
 * colour source; nothing here computes an HSL value.
 */

export type Constellation3DShape = 'sphere' | 'box' | 'octahedron' | 'cone' | 'dodecahedron';

export interface ConstellationTypeEncoding {
  /** A `nodes.type` / `MemoryNodeType` value (packages/shared/src/memory.ts) — the graph's own
   *  entity-kind vocabulary, not a UI invention. */
  type: string;
  /** Primary, colour-independent type carrier. `geometryFor()` in MemoryConstellation3D.tsx
   *  switches on this. */
  shape: Constellation3DShape;
  /** A `theme.css` custom-property NAME (e.g. `--accent`), never a resolved colour literal —
   *  resolve it at draw/paint time with `resolveConstellationToken`, so a theme toggle picks up
   *  the live cascade with no separate light/dark table to keep in sync. */
  token: string;
  /** Multiplies the connectivity-derived scale a node already gets (`constellation3DNodeEncoding`
   *  in constellation-3d-buffers.ts). Only the cone family uses this today: file/symbol/repository
   *  share one shape and one colour token, so the Navigator conventions doc (§1 Notes) asks scale
   *  to carry the remaining distinction — "symbol, smaller scale" / "repository, largest scale". */
  scaleMultiplier: number;
  /** Shared by the legend, catalogue rows, and inspector type chip — the DOM half of "same type,
   *  same look" alongside `shape`/`token`. */
  label: string;
}

// ---------------------------------------------------------------------------------------------
// The table. Rows above the divider are locked by the Navigator conventions doc (§1) verbatim —
// do not re-derive them. Rows below are this task's discretion: `MemoryNodeType` has 21 members
// (packages/shared/src/memory.ts) and the design doc names only 7 (the ones expected to actually
// populate a constellation), so the rest are bucketed by the family the shipped renderer already
// grouped them into (KNOWLEDGE_TYPES/CODE_TYPES/COORDINATION_TYPES, now retired) and recoloured
// against the new token set. Two of those buckets land on a shape a locked row already claims
// (error → plan's dodecahedron, unknown → task/run/agent/project's box); colour is what still
// tells them apart there, which is exactly what "colour is reinforcement" is for.
//
// Gap worth flagging (see PLNR-437's task notes on prior design-doc-vs-reality misses): the
// conventions doc's "doc" row (octahedron / --purple) names a MemoryNodeType that does not
// exist. Project docs are projected into the graph as `artifact` nodes — see
// apps/api/src/memory/projection.ts's `task.docs_linked` projector and `doc.deleted`'s
// `removeNodeUri`, both keyed `kind: 'artifact'`. `nodes.type`'s CHECK constraint (0001_initial.sql)
// and `MemoryNodeType` agree there is no `doc` member. The `artifact` row below carries the
// doc/octahedron/purple assignment the doc actually intends.
// ---------------------------------------------------------------------------------------------
const ENCODING_ROWS: ConstellationTypeEncoding[] = [
  // --- Navigator conventions doc §1, locked ---
  { type: 'memory', shape: 'sphere', token: '--accent', scaleMultiplier: 1, label: 'Memory' },
  { type: 'task', shape: 'box', token: '--blue', scaleMultiplier: 1, label: 'Task' },
  { type: 'artifact', shape: 'octahedron', token: '--purple', scaleMultiplier: 1, label: 'Doc' },
  { type: 'file', shape: 'cone', token: '--steel', scaleMultiplier: 1, label: 'File' },
  { type: 'plan', shape: 'dodecahedron', token: '--green', scaleMultiplier: 1, label: 'Plan' },
  { type: 'symbol', shape: 'cone', token: '--steel', scaleMultiplier: 0.7, label: 'Symbol' },
  { type: 'repository', shape: 'cone', token: '--steel', scaleMultiplier: 1.5, label: 'Repository' },

  // --- discretion: remaining MemoryNodeType values, bucketed by pre-existing family ---
  { type: 'api', shape: 'cone', token: '--steel', scaleMultiplier: 1, label: 'API' },
  { type: 'database_entity', shape: 'cone', token: '--steel', scaleMultiplier: 1, label: 'Database entity' },
  { type: 'test', shape: 'cone', token: '--steel', scaleMultiplier: 1, label: 'Test' },
  { type: 'branch', shape: 'cone', token: '--steel', scaleMultiplier: 1, label: 'Branch' },
  { type: 'revision', shape: 'cone', token: '--steel', scaleMultiplier: 1, label: 'Revision' },
  { type: 'run', shape: 'box', token: '--blue', scaleMultiplier: 1, label: 'Run' },
  { type: 'agent', shape: 'box', token: '--blue', scaleMultiplier: 1, label: 'Agent' },
  { type: 'project', shape: 'box', token: '--blue', scaleMultiplier: 1, label: 'Project' },
  { type: 'decision', shape: 'octahedron', token: '--purple', scaleMultiplier: 1, label: 'Decision' },
  { type: 'requirement', shape: 'octahedron', token: '--purple', scaleMultiplier: 1, label: 'Requirement' },
  { type: 'procedure', shape: 'octahedron', token: '--purple', scaleMultiplier: 1, label: 'Procedure' },
  { type: 'episode', shape: 'octahedron', token: '--purple', scaleMultiplier: 1, label: 'Episode' },
  { type: 'error', shape: 'dodecahedron', token: '--red', scaleMultiplier: 1, label: 'Error' },
  { type: 'unknown', shape: 'box', token: '--text-dim', scaleMultiplier: 1, label: 'Unknown' },
];

export const CONSTELLATION_TYPE_ENCODING: Readonly<Record<string, ConstellationTypeEncoding>> = Object.freeze(
  Object.fromEntries(ENCODING_ROWS.map((row) => [row.type, row])),
);

// Drift guard, same convention as MemoryGraph.tsx's NODE_TYPE_META: every real MemoryNodeType
// value must resolve through this table, so an added node type cannot silently fall through to
// the fallback encoding.
void (MemoryNodeType.options.some((type) => !(type in CONSTELLATION_TYPE_ENCODING)) &&
  (() => { throw new Error('CONSTELLATION_TYPE_ENCODING is missing an entry for a MemoryNodeType value'); })());

const FALLBACK_ENCODING: ConstellationTypeEncoding = CONSTELLATION_TYPE_ENCODING.unknown!;

/** Total for every caller — the constellation renders whatever `nodes.type` a generation carries,
 * including a value this table has not been told about yet, and must never crash or render
 * "undefined" for one. */
export function encodingForType(type: string): ConstellationTypeEncoding {
  return CONSTELLATION_TYPE_ENCODING[type] ?? FALLBACK_ENCODING;
}

/**
 * Resolves a `theme.css` custom property to a drawable colour string, live off the current
 * cascade — canvas `fillStyle` and `THREE.Color.set()` cannot read `var(...)` themselves. Same
 * pattern MemoryStarMap.tsx's `readPalette()` already uses for the same reason, kept independent
 * here rather than shared: that module is the untouched legacy 2D fallback (PLNR-437's audit doc
 * — "Not in scope"), with its own, different type→colour table.
 */
export function resolveConstellationToken(token: string, fallback = '#8a8f98'): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || fallback;
}
