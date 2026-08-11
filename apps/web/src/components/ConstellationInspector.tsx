// Docked selection inspector (PLNR-440, screen spec 1b) — replaces the floating 300px selection
// card with the designed 320px docked panel: identity, authority/validity metrics, a cited memory
// excerpt, and a cursor-honest relationship list. Deliberately a LENS onto the two canonical
// handoffs (ego network, evidence inspector) rather than a second detail view: it never fetches a
// memory's full history/feedback/correction state (that stays exclusive to MemoryView.tsx's
// Explore-tab Inspector, reached via the "Evidence" button below), and it never re-derives what the
// canvas already computed for relationship pagination (the incident cursor, the historical-edge
// predicate) — see the imports below.
import { useEffect, useState } from 'react';
import { parseEntityUri } from '@noriq-dev/shared';
import { api, type ApiConstellationV2IncidentPage } from '../api';
import { type Constellation3DNode, communityTooltipContent } from './constellation-3d-buffers';
import { CONSTELLATION_SHAPE_GLYPH, encodingForType } from './constellation-encoding';
import { isHistoricalIncidentEdgeType } from './constellation-v2-scene';
import { Button } from './ui';
import { MonoTag } from './bits';

export const CONSTELLATION_INSPECTOR_WIDTH = 320;

// --- Authority/validity tone — mirrors MemoryView.tsx's AuthorityBadge/ValidityBadge numeric
// thresholds and colour choices exactly (same "existing authority/validity semantics" the
// executionSpec calls for), kept as an independent small table here rather than a cross-import:
// MemoryView.tsx imports MemoryConstellationV2.tsx (for the Map tab), and this file is imported BY
// MemoryConstellationV2.tsx, so importing back from MemoryView.tsx would be a circular import.
// This is the same "kept independent, same reasoning documented" convention constellation-encoding.ts's
// resolveConstellationToken already uses for MemoryStarMap's separate readPalette().
function authorityTone(authority: number): { color: string; label: string } {
  const labels: Record<number, string> = {
    5: 'human-approved', 4: 'verified against code/tests', 3: 'repeated observation',
    2: 'single-agent observation', 1: 'hypothesis',
  };
  const color = authority >= 5 ? 'var(--green)' : authority >= 3 ? 'var(--blue)' : 'var(--amber)';
  return { color, label: labels[authority] ?? `authority ${authority}` };
}
function validityTone(validity: string): { color: string; icon: string } {
  if (validity === 'active') return { color: 'var(--green)', icon: '●' };
  if (validity === 'stale') return { color: 'var(--amber)', icon: '◐' };
  if (validity === 'invalid' || validity === 'superseded' || validity === 'expired') return { color: 'var(--red-soft)', icon: '✕' };
  return { color: 'var(--text-mid)', icon: '?' };
}

/** Shared by the entity type chip, every relationship row's target chip, and a community's top-type
 * chips — the one DOM rendering of `constellation-encoding.ts`'s table, so a type never looks
 * different in the dock than it does on canvas (locked decision, restated by this task's brief). */
function TypeChip({ type }: { type: string }) {
  const encoding = encodingForType(type);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--mono)', fontSize: 8.5, color: `var(${encoding.token})`, whiteSpace: 'nowrap' }}>
      <span aria-hidden="true">{CONSTELLATION_SHAPE_GLYPH[encoding.shape]}</span>{encoding.label.toLowerCase()}
    </span>
  );
}

interface RelationshipRowData {
  key: string;
  direction: 'incoming' | 'outgoing';
  type: string;
  historical: boolean;
  targetLabel: string;
  targetType: string;
}

/** Flattens loaded incident pages into rows, reading direction/type straight off the RAW incident
 * edge (`ApiConstellationV2IncidentPage.edges[].direction`, 'incoming' | 'outgoing') rather than the
 * 3D scene's `Constellation3DEdge` — the scene assembler (constellation-v2-scene.ts) collapses
 * every incident edge's `direction` to the literal string 'forward' (the fromId/toId ordering alone
 * carries the true direction for the renderer's line geometry), so a glyph driven by that field
 * would always read outgoing. Reading the untouched API page instead sidesteps that entirely and
 * keeps the row honest about which way the edge actually points. */
function relationshipRows(incidentPages: ApiConstellationV2IncidentPage[]): RelationshipRowData[] {
  return incidentPages.flatMap((page) => page.edges.map((edge) => ({
    key: edge.edgeId,
    direction: edge.direction,
    type: edge.type,
    historical: isHistoricalIncidentEdgeType(edge.type),
    targetLabel: edge.endpoint.label,
    targetType: edge.endpoint.type,
  })));
}

export interface ConstellationInspectorProps {
  pid: string;
  /** The pinned node — either a resident entity or a community aggregate (`selected.community`). */
  selected: Constellation3DNode;
  /** Loaded incident pages for the CURRENT selection only — the caller resets this to `[]` on every
   *  selection change (MemoryConstellationV2.tsx already owns this fetch/cursor lifecycle; this
   *  component never re-requests it). Ignored for a community selection. */
  incidentPages: ApiConstellationV2IncidentPage[];
  /** True while a relationship page (initial or continuation) is in flight. */
  relationshipsLoading: boolean;
  /** True while `onOpenCommunity` is resolving (mirrors the old floating card's `expanding` gate). */
  expanding: boolean;
  onLoadMoreRelationships: () => void;
  onOpenCommunity: (communityId: string) => void;
  onOpenEgoNetwork?: (uri: string) => void;
  onOpenInspector?: (uri: string) => void;
  onClear: () => void;
}

/**
 * Docked 320px selection inspector. DOM chrome over the WebGL canvas: renders once per selection
 * change (a React state update from a click/keypress, never a per-frame tick — hover state lives
 * entirely inside MemoryConstellation3D's own local state and is never lifted into a prop this
 * component receives), and never touches the Three.js scene, so it adds zero draw calls to the
 * PLNR-371 budget by construction.
 */
export function ConstellationInspector({
  pid, selected, incidentPages, relationshipsLoading, expanding,
  onLoadMoreRelationships, onOpenCommunity, onOpenEgoNetwork, onOpenInspector, onClear,
}: ConstellationInspectorProps) {
  const isCommunity = Boolean(selected.community);
  const isMemory = !isCommunity && selected.type === 'memory';

  // Cited evidence excerpt (memory selections only) — reuses the EXACT server-rendered, quoted/cited/
  // authority-labelled block the canonical Explore-tab Inspector already shows via EvidenceFrameBlock
  // (same `api.memorySearch(pid, { memoryItemId })` call, same `evidenceFrame.text`/`suspiciousCount`
  // fields), just in a smaller box. This is deliberate, not a shortcut: the locked decision ("evidence
  // renders as quoted, cited, authority-labelled — never asserted") is a safety property of the
  // SERVER-rendered frame text itself (it defensively labels agent-authored text as untrusted quote,
  // never product prose), so this component never substitutes a plain snippet field for it, and never
  // re-parses or reformats the returned text — same "renders exactly what the server produced"
  // convention MemoryView.tsx's EvidenceFrameBlock documents for the same reason.
  const [evidence, setEvidence] = useState<{ text: string; suspicious: boolean } | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  useEffect(() => {
    if (!isMemory || !selected.uri) { setEvidence(null); setEvidenceLoading(false); return; }
    let cancelled = false;
    const controller = new AbortController();
    let memoryItemId = selected.uri;
    try { const ref = parseEntityUri(selected.uri); if ('id' in ref) memoryItemId = ref.id; } catch { /* fall back to the raw uri */ }
    setEvidenceLoading(true);
    api.memorySearch(pid, { memoryItemId }, controller.signal)
      .then((result) => { if (cancelled) return; setEvidence({ text: result.evidenceFrame.text, suspicious: result.evidenceFrame.suspiciousCount > 0 }); })
      .catch(() => { if (!cancelled) setEvidence(null); })
      .finally(() => { if (!cancelled) setEvidenceLoading(false); });
    return () => { cancelled = true; controller.abort(); };
  }, [pid, isMemory, selected.uri]);

  const rows = isCommunity ? [] : relationshipRows(incidentPages);
  const lastPage = incidentPages.at(-1);
  const hasMore = Boolean(lastPage?.nextCursor);
  // Coverage honesty (PLNR-375/379, restated by this task's lockedDecisions): `selected.degree` is a
  // best-effort total carried on the entity since PLNR-437/438 (the SAME raw incident-edge count the
  // hierarchy generation snapshotted at build time — see constellation-v2.ts/constellation-hierarchy.ts
  // — already displayed, just never connected to pagination before this task) but it can drift from
  // the incidents endpoint's LIVE cursor answer if edges changed since that generation was built. The
  // cursor (`nextCursor`) is always the authoritative "is there more" signal, never the degree number:
  // once it comes back null the list IS complete, full stop, even if `degree` claims a higher total
  // (never show "5 of 23, nothing left to load" — that is the exact false-completeness PLNR-375 exists
  // to prevent); while it is still non-null the denominator is whichever of `degree`/`loaded` is
  // larger, so a stale-LOW degree can never hide relationships that are genuinely still there to load.
  const total = hasMore ? Math.max(selected.degree, rows.length) : rows.length;
  const remaining = total > rows.length ? total - rows.length : undefined;

  const identity = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        {isCommunity
          ? <MonoTag color="var(--text-dim)" bg="var(--w-06)" size={9}>community</MonoTag>
          : <TypeChip type={selected.type} />}
        <MonoTag color="var(--amber-select)" bg="rgba(255,209,102,.12)" size={9}>pinned</MonoTag>
        <div style={{ flex: 1 }} />
        <button
          type="button" aria-label="Close inspector" onClick={onClear} className="drawer-x"
          style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 14, width: 22, height: 22, borderRadius: 6 }}
        >
          ✕
        </button>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 4, wordBreak: 'break-word' }}>{selected.label}</div>
      {selected.uri && (
        <div
          title={selected.uri}
          style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 8 }}
        >
          {selected.uri}
        </div>
      )}
    </>
  );

  if (isCommunity) {
    const tooltip = communityTooltipContent(selected);
    return (
      <aside
        aria-label="Selection inspector"
        style={{
          width: CONSTELLATION_INSPECTOR_WIDTH, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0,
          background: 'rgba(14,16,20,.96)', borderLeft: '1px solid var(--line)', backdropFilter: 'blur(10px)',
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
          {identity}
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-mid)', marginBottom: 14 }}>
            {(tooltip?.entityCount ?? selected.memberCount ?? 0).toLocaleString()} entities · {(tooltip?.boundaryRouteCount ?? selected.boundaryRouteCount ?? 0).toLocaleString()} boundary routes
          </div>
          {tooltip && tooltip.topTypeCounts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {tooltip.topTypeCounts.map(({ type, count }) => (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <TypeChip type={type} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>{count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ flex: 'none', borderTop: '1px solid var(--line)', padding: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button onClick={() => onOpenCommunity(selected.id)} disabled={expanding}>{expanding ? 'opening…' : 'open community'}</Button>
          <button type="button" onClick={onClear} style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 11.5, background: 'transparent', border: 'none', padding: 0, font: 'inherit' }}>clear</button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Selection inspector"
      style={{
        width: CONSTELLATION_INSPECTOR_WIDTH, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0,
        background: 'rgba(14,16,20,.96)', borderLeft: '1px solid var(--line)', backdropFilter: 'blur(10px)',
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
        {identity}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-mid)', display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <span>degree {selected.degree}</span>
          {selected.authority != null && <span style={{ color: authorityTone(selected.authority).color }}>{authorityTone(selected.authority).label}</span>}
          {selected.validity && <span style={{ color: validityTone(selected.validity).color }}>{validityTone(selected.validity).icon} validity {selected.validity}</span>}
        </div>

        {isMemory && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 6 }}>Evidence</div>
            <div style={{ borderLeft: '3px solid rgba(198,242,78,.4)', paddingLeft: 10 }}>
              {evidenceLoading && !evidence ? (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>loading…</div>
              ) : evidence?.text ? (
                <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                  {evidence.suspicious && (
                    <div style={{ marginBottom: 6 }}>
                      <MonoTag color="var(--red-soft)" bg="rgba(255,92,92,.14)" size={8.5}>⚠ SUSPICIOUS</MonoTag>
                    </div>
                  )}
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono)', fontSize: 9.5, lineHeight: 1.55, color: 'var(--text-mid)' }}>
                    {evidence.text}
                  </pre>
                </div>
              ) : (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>no evidence text returned</div>
              )}
            </div>
          </div>
        )}

        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 6 }}>
            {total === 0 && !relationshipsLoading ? 'Relationships · none' : `Relationships · ${rows.length} of ${total}`}
          </div>
          {relationshipsLoading && rows.length === 0 && <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>loading…</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {rows.map((row) => (
              <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', opacity: row.historical ? 0.65 : 1 }}>
                <span aria-hidden="true" style={{ fontSize: 14, color: 'var(--amber-select)', width: 14, flex: 'none', textAlign: 'center' }}>
                  {row.direction === 'outgoing' ? '→' : '←'}
                </span>
                <span style={{ width: 104, flex: 'none', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-mid)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.type}>
                  {row.type}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.targetLabel}>
                  {row.targetLabel}
                </span>
                <TypeChip type={row.targetType} />
                {row.historical && <MonoTag color="var(--amber-select)" bg="rgba(255,209,102,.12)" size={8}>historical</MonoTag>}
              </div>
            ))}
          </div>
          {hasMore && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Button variant="ghost" onClick={onLoadMoreRelationships} disabled={relationshipsLoading}>
                load next page{remaining ? ` · ${remaining} more` : ''}
              </Button>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>cursor-bounded · 256/req</span>
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 'none', borderTop: '1px solid var(--line)', padding: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {selected.uri && <Button onClick={() => onOpenEgoNetwork?.(selected.uri!)}>Ego network</Button>}
        {isMemory && selected.uri && <Button variant="ghost" onClick={() => onOpenInspector?.(selected.uri!)}>Evidence</Button>}
        <button type="button" onClick={onClear} style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 11.5, background: 'transparent', border: 'none', padding: 0, font: 'inherit' }}>clear</button>
      </div>
    </aside>
  );
}

export default ConstellationInspector;
