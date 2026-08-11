// Catalogue — the designed textual peer of the 3D space (PLNR-442, closing Phase 4 of the
// Constellation Navigator plan). Promotes the renderer-failure fallback's unstyled
// `<button>label (type)</button>` rows into a real surface: the audit doc (pdoc_msopdg2u602z4b0q3i2n)
// disposes the old `<details>` "Accessible visible list" as Delete ("a disclosure widget is not a
// navigation surface — its function is absorbed by Catalogue"), and this file is that absorption.
//
// Reuses the SAME encoding, tone tables and community-summary helper the docked inspector and the
// 3D renderer already use (ConstellationInspector.tsx's TypeChip/authorityTone/validityTone,
// constellation-3d-buffers.ts's communityTooltipContent) — "a type must look identical on canvas
// and in text" (PLNR-437) is exactly as true for a catalogue row as for a legend entry or an
// inspector chip.
//
// Search-ignite textual equivalent (Navigator conventions §4 "dimming is not filtering"): the
// canvas dims non-matches to ~32% opacity while keeping them present. A flat text list has no
// continuous field to dim, so silently shortening the list to only-matches would be the one thing
// the honesty rule explicitly forbids ("showing matches while stating what else exists, rather
// than silently filtering the list down"). This component therefore never removes a row for
// `highlightedNodeIds` — every node the caller passes is rendered, full stop — and instead marks
// matching rows with the same amber/accent ignite treatment the search-results panel and the 3D
// scene already use, plus a per-community match count mirroring the overview's "+N matches" flare.
import { useState } from 'react';
import type { ApiConstellationV2CommunityPage } from '../api';
import { type Constellation3DNode, communityTooltipContent } from './constellation-3d-buffers';
import { authorityTone, TypeChip, validityTone } from './ConstellationInspector';
import { Button } from './ui';
import { MonoTag } from './bits';

export interface ConstellationCatalogueProps {
  /** The exact node population the canvas would draw at the current level — same `filteredScene.nodes`
   *  MemoryConstellation3D receives, so Catalogue can never show a different set than Space does. */
  nodes: Constellation3DNode[];
  /** Search-ignite matches, by node id — includes both matched resident entities and matched root
   *  communities, the same field MemoryConstellation3D's `highlightedNodeIds` prop already reads. */
  highlightedNodeIds: ReadonlySet<string>;
  /** Root-community id -> match count inside it, for the "+N matches" subtext a matched-but-collapsed
   *  community shows (mirrors the overview scene's own ignite subtext — PLNR-441's
   *  `communityIgniteSubtext`). Only meaningful for community rows. */
  matchCounts: ReadonlyMap<string, number>;
  searchActive: boolean;
  selectedNodeId: string | null;
  /** The resident page for the current level, when one is loaded (null at root) — supplies the
   *  community's total member count for the coverage-honest "load next page · N more" footer,
   *  the same "N of M, never a list that looks complete" idiom ConstellationInspector's relationship
   *  list already uses (PLNR-375/379/440). */
  currentPage: ApiConstellationV2CommunityPage | null;
  /** True while a community expansion (this row's "open") is in flight. */
  expanding: boolean;
  onSelectNode: (nodeId: string) => void;
  onExpandCommunity: (communityId: string) => void;
  onLoadNextPage: () => void;
  onOpenEgoNetwork?: (uri: string) => void;
  onOpenInspector?: (uri: string) => void;
}

/**
 * Pure DOM catalogue view. Every row is a set of real `<button>`s — no click-only `<div>`s — so
 * keyboard reachability and tab order fall out of ordinary DOM structure rather than a manual
 * `tabIndex`/`onKeyDown` scheme (Navigator conventions §8: "reachable and operable without a
 * pointer, and without 3D motion").
 */
export function ConstellationCatalogue({
  nodes, highlightedNodeIds, matchCounts, searchActive, selectedNodeId, currentPage, expanding,
  onSelectNode, onExpandCommunity, onLoadNextPage, onOpenEgoNetwork, onOpenInspector,
}: ConstellationCatalogueProps) {
  // Community rows expandable inline (this task's body, distinct from the docked inspector's own
  // aggregate view): a lightweight in-place preview — entity count, boundary routes, top type
  // counts — so browsing the list doesn't require committing to a selection/inspector round trip
  // just to see what a community holds. Purely local UI state; never fetches anything new.
  const [previewedIds, setPreviewedIds] = useState<ReadonlySet<string>>(new Set());
  const togglePreview = (id: string) => setPreviewedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const loadedEntityCount = nodes.filter((node) => !node.community).length;
  const totalEntityCount = currentPage?.community.memberCount;
  const remaining = currentPage?.nextCursor && totalEntityCount != null && totalEntityCount > loadedEntityCount
    ? totalEntityCount - loadedEntityCount
    : undefined;

  return (
    <div role="region" aria-label="Textual memory constellation" style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: 18 }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {nodes.map((node) => {
          const isCommunity = Boolean(node.community);
          const highlighted = highlightedNodeIds.has(node.id);
          const previewed = previewedIds.has(node.id);
          const tooltip = isCommunity ? communityTooltipContent(node) : null;
          const matchCount = isCommunity ? matchCounts.get(node.id) : undefined;
          return (
            <div key={node.id}>
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 6px', flexWrap: 'wrap',
                  borderBottom: '1px solid var(--line)',
                  borderLeft: highlighted ? '2px solid var(--accent)' : '2px solid transparent',
                  background: node.id === selectedNodeId ? 'var(--w-04)' : highlighted ? 'rgba(198,242,78,.04)' : 'transparent',
                }}
              >
                {isCommunity ? (
                  <button
                    type="button" aria-expanded={previewed}
                    aria-label={`${previewed ? 'Collapse' : 'Expand'} ${node.label} preview`}
                    onClick={() => togglePreview(node.id)}
                    style={{ flex: 'none', width: 16, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', fontSize: 10, padding: 0 }}
                  >
                    {previewed ? '▾' : '▸'}
                  </button>
                ) : <span aria-hidden="true" style={{ flex: 'none', width: 16 }} />}
                {isCommunity
                  ? <MonoTag color="var(--text-dim)" bg="var(--w-06)" size={8.5}>community</MonoTag>
                  : <TypeChip type={node.type} />}
                <button
                  type="button" onClick={() => onSelectNode(node.id)}
                  style={{
                    flex: 1, minWidth: 160, textAlign: 'left', background: 'transparent', border: 'none',
                    cursor: 'pointer', padding: 0, color: 'var(--text)', font: 'inherit',
                  }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>{node.label}</span>
                  {!isCommunity && node.uri && (
                    <span
                      title={node.uri}
                      style={{
                        display: 'block', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {node.uri}
                    </span>
                  )}
                  {isCommunity && (
                    <span style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>
                      {(node.memberCount ?? 0).toLocaleString()} entities
                    </span>
                  )}
                </button>
                {!isCommunity && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)', flex: 'none' }}>
                    degree {node.degree}
                  </span>
                )}
                {!isCommunity && node.authority != null && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: authorityTone(node.authority).color, flex: 'none', whiteSpace: 'nowrap' }}>
                    {authorityTone(node.authority).label}
                  </span>
                )}
                {!isCommunity && node.validity && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: validityTone(node.validity).color, flex: 'none', whiteSpace: 'nowrap' }}>
                    {validityTone(node.validity).icon} validity {node.validity}
                  </span>
                )}
                {searchActive && highlighted && (
                  <MonoTag color="var(--accent)" bg="rgba(198,242,78,.1)" size={8}>
                    {isCommunity && matchCount ? `+${matchCount} match${matchCount === 1 ? '' : 'es'}` : 'match'}
                  </MonoTag>
                )}
                {isCommunity && (
                  <Button onClick={() => onExpandCommunity(node.id)} disabled={expanding}>{expanding ? 'opening…' : 'open'}</Button>
                )}
                {node.uri && <Button variant="ghost" onClick={() => onOpenEgoNetwork?.(node.uri!)}>ego</Button>}
                {node.uri && node.type === 'memory' && <Button variant="ghost" onClick={() => onOpenInspector?.(node.uri!)}>evidence</Button>}
              </div>
              {isCommunity && previewed && tooltip && (
                <div style={{ padding: '2px 6px 10px 32px', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>
                  <div>{tooltip.entityCount.toLocaleString()} entities · {tooltip.boundaryRouteCount.toLocaleString()} boundary routes</div>
                  {tooltip.topTypeCounts.length > 0 && (
                    <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
                      {tooltip.topTypeCounts.map(({ type, count }) => (
                        <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <TypeChip type={type} /><span>{count.toLocaleString()}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {currentPage?.nextCursor && (
        <div style={{ marginTop: 10 }}>
          <Button onClick={onLoadNextPage}>load next catalogue page{remaining ? ` · ${remaining} more` : ''}</Button>
        </div>
      )}
    </div>
  );
}

export default ConstellationCatalogue;
