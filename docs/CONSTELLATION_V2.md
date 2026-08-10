# Project Memory Constellation v2

This document is the checked-in engineering contract and evidence log for the navigable,
hierarchical constellation. It complements the canonical Project Memory architecture document in
Noriq; implementation changes must update both when a settled decision changes.

## Baseline evidence (PLNR-371)

The v1 endpoint executes four complete SQLite result materializations on every request: `nodes`,
`edges`, `memory_items`, and `episodes`. Sampling happens only after those arrays reach the Worker.
The browser receives at most 1,000 nodes and 2,000 edges, then performs a fourteen-pass 2D layout
and linear node hit-testing on the main thread. The server ceiling therefore bounds the response
and canvas, but it does not bound database rows read, Worker heap, or server shaping work.

`npm run benchmark:constellation` builds four deterministic, adversarial graphs and reports the
v1 shaping, wire, layout, and hit-test costs. The 2026-08-09 local run used Node v26.7.0 on the
development workstation; timings are medians of five warm runs. They are comparative engineering
evidence, not Cloudflare production latency or a GPU frame benchmark.

| fixture | nodes | edges | rows materialized | input MiB | response KiB | gzip KiB | shape ms | layout ms | 1k hit tests ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dense hub | 12,000 | 48,000 | 60,800 | 5.89 | 391.39 | 18.11 | 30.47 | 18.89 | 16.94 |
| disconnected islands | 18,000 | 17,920 | 37,120 | 3.86 | 300.64 | 17.61 | 18.99 | 19.39 | 13.14 |
| code heavy | 60,000 | 120,000 | 180,500 | 18.94 | 298.20 | 20.68 | 18.74 | 17.08 | 14.62 |
| memory heavy | 24,000 | 72,000 | 108,000 | 10.55 | 369.96 | 19.76 | 54.75 | 20.56 | 13.41 |

Fixture definitions are intentionally stable:

- Dense hub: 24 hubs fan into 11,976 entities, including 800 memories.
- Disconnected islands: deterministic 100-node components, including 1,200 memories.
- Code heavy: 60,000 entities and 120,000 edges, with 48,000 symbols.
- Memory heavy: 12,000 memories among 24,000 entities and 72,000 edges.

The code-heavy result demonstrates the main server risk: 180,500 rows and 18.94 MiB of modeled
input are materialized to return a 298 KiB body. The v1 client baseline also already exceeds one
16.7 ms frame for layout, while one pointer-work batch linearly scans the full 1,000-node sample.
Canvas draw and GPU behavior are not measurable in the repository's jsdom test environment;
integrated/weak-GPU frame evidence remains an explicit cutover gate.

## v2 budgets

These are fail-closed budgets, not targets to fill:

| surface | default budget | hard bound / gate |
| --- | ---: | ---: |
| overview | 128 communities, 256 aggregate routes | 256 communities, 512 routes |
| one expansion page | 256 entities, 512 routes | 500 entities, 1,000 routes |
| resident GPU scene | 12,000 entities, 24,000 routes | evict collapsed/off-route pages before exceeding |
| compact JSON page | 256 KiB uncompressed | 512 KiB; split before emission |
| compressed response | 64 KiB target | 128 KiB |
| cached overview read | 100 ms p95 target | 250 ms p95 Worker time |
| hierarchy generation | 10 s target at 100k nodes/250k edges | 30 s; retain previous complete generation |
| interaction frame | 16.7 ms p95 on representative integrated GPU | 33 ms p95 weak-GPU fallback gate |
| pick/focus response | 50 ms p95 | 100 ms |

Pages are revision-addressed and may be cached indefinitely by identity; the mutable project head
is revalidated for every navigation session and may be stale for at most 60 seconds after an
unobserved revision change. A build never displaces the previous complete generation. The client
falls back to the textual catalogue when WebGL2 is unavailable, context creation fails, the 33 ms
frame budget is exceeded for three sampling windows, or a valid generation cannot be served.

No v1 production ceiling is raised by this benchmark. The v2 common path must avoid a global raw
graph load entirely; the database, response, Worker, and renderer bounds above are independently
enforced.

### Transport evidence (PLNR-376)

The same benchmark now constructs a maximum-size 500-entity expansion with 499 backbone edges and
512 aggregate routes for every fixture. The compact dictionary/tuple representation is 100.17 KiB
or less before compression and 20.39 KiB or less under gzip, passing both the 512 KiB hard uncompressed bound and
128 KiB compressed gate. This synthetic result tests representation size; Cloudflare production
compression and latency remain deployment observations rather than claims made by the local run.

Every public v2 GET first performs a metadata-only generation-head read. Its strong ETag includes
the representation, resource identity, active generation, current canonical revision, topology,
and layout versions. A matching `If-None-Match` returns an empty `304` before hierarchy page rows
are read. Responses expose cache hit/miss, rows shaped, serialized bytes, stale state, and server
timing headers. The web client asks for compact pages, decodes them back into the stable application
shape, revalidates cached pages, evicts only the changed project's incompatible generation, and
uses request sequence ordering so a late response cannot replace newer state.

### Renderer evidence (PLNR-377)

The 3D renderer is an isolated, lazy-loaded Three.js surface until the cutover gate. It groups
nodes into five shape families, splits current and faded validity instances, and uses one halo
instance buffer for lead memories. Relationships use base and final promoted line passes plus one
direction-marker pass; selection rebuilds those bounded buffers, not one object per relationship.
React renders at most 24 depth-culled node/relationship labels and never one component per node.

On the local benchmark's resident-scene ceiling of 12,000 nodes and 24,000 edges, the pure buffer
plan has a 14-draw-call ceiling and an 8.18 ms median selection-plan time across five warm runs.
This passes the 100 ms interaction planning gate. It is not a GPU frame-time claim: the integrated
and weak-GPU measurements remain required before PLNR-380 can enable v2 by default.

### Layout and navigation evidence (PLNR-378)

`space-v1` uses URI/community-stable seeds, sorted inputs, eight fixed convergence passes, and
32-bit-rounded output. Compatible prior-generation positions are warm starts only; server anchors
pull every pass, parent volumes clamp children, and no client coordinate is written back as
canonical truth. The browser runs convergence in a dedicated module worker. If workers are
unavailable it keeps server-authored anchors instead of moving O(N+E) work onto the UI thread.
The 12,000-node/24,000-edge local fixture converges in an 86.38 ms median inside the worker.

Camera and preference logic is WebGL-independent and unit tested: orbit, pan, bounded dolly,
home, focus/fly-to, transition cancellation, direct reduced-motion focus, spatial-grid and keyboard
selection, and version/layout-qualified local state. The 3D preference key and schema are distinct
from v1, so legacy `{x,y}` pins can never be interpreted as 3D coordinates.

### Hierarchy and relationship detail (PLNR-379)

Leaf expansion pages now carry a deterministic maximum-weight spanning forest selected from at
most 2,000 ordered internal candidates, capped at 499 raw edges. Candidate truncation is explicit
in page coverage; the renderer never substitutes a global raw-edge load. Aggregate routes remain
the boundary context. The client merges cursor pages without duplicates, retains breadcrumbs,
evicts oldest collapsed/off-route pages before the 12,000-node resident ceiling, and stops rather
than silently exceeding that ceiling when pinned path pages alone fill it.

All selection entry points share one pinned node ID. Community selection promotes aggregate
routes. Entity selection cancels the previous incident request, loads only bounded incident pages,
and maps off-page endpoints to their truthful containing community. Incoming/outgoing direction,
type, provenance, and historical semantics survive scene assembly; clearing incident pages
reconstructs the exact backbone/boundary scene. Hybrid search only invokes exact URI routing for a
chosen hit, follows the returned hierarchy path, and pages the destination leaf until that entity
is present. Generation mismatches are discarded rather than combined.

## Binding v2 contract (PLNR-372)

### Identity, versions, and hierarchy

Canonical entity identity remains the stable `uri` from ProjectMemory. Derived community IDs are
opaque display identities and must never be accepted where an entity URI is required.

Every response carries:

```ts
interface ConstellationRevision {
  contract: 'constellation-v2';
  generationId: string;
  sourceRevision: number;       // canonical memory revision used to build this generation
  currentRevision: number;      // canonical revision observed while serving
  topologyVersion: 'connectivity-v1';
  layoutVersion: 'space-v1';
  state: 'current' | 'stale' | 'building';
  generatedAt: string;
}
```

`state: stale` means the complete generation is safe but `sourceRevision < currentRevision`.
`building` means that same complete generation is being served while a successor builds. A failed
or partial build is never addressable. Generation identity changes if source, topology, or layout
version changes.

The hierarchy has three semantic levels, even if large communities require several repeated
community pages:

1. `overview`: project-root children are connectivity communities only.
2. `community`: nested connectivity communities or an entity page; a page never mixes child
   communities and raw entities.
3. `entity`: canonical nodes. Repository and file communities are ordinary topology communities,
   but file expansion is the required route to high-volume symbol entities.

The server recursively partitions until a leaf fits the 500-entity hard page bound or cannot be
split without inventing relationships. An unsplittable leaf remains cursor-paginated. Every
eligible canonical entity belongs to exactly one leaf in a completed generation and has one
recorded ancestor path to the project root.

Clustering consumes an undirected normalized view but never changes canonical edge direction.
Weights for `connectivity-v1` are: `calls`, `imports`, `depends_on`, `tests`, `validated_by`, and
`implements` = 4; `modifies`, `declares`, `derived_from`, `decided_by`, `observed_in`, and
`commonly_changes_with` = 3; `blocks`, `owned_by`, and `failed_because` = 2; `related_to`,
`supersedes`, and `contradicts` = 1. Parallel typed edges add, then each contribution is divided by
`sqrt(max(1, degree(a)) * max(1, degree(b)))` so hubs cannot collapse the map into one community.
Unknown future edge types use weight 1 and are reported in generation diagnostics.

Partitioning, tie-breaking, and aggregate ordering are deterministic. A community's provisional
fingerprint is the hash of topology version, parent fingerprint, level, and sorted member URIs.
Across adjacent generations, the builder reuses a prior community ID only for the deterministic
best overlap above the settled 0.60 Jaccard threshold; one prior ID can be reused once. Ties resolve
by larger intersection, then prior ID and new fingerprint lexicographically. Layout anchors seed
from the reused/final community ID or entity URI. Rebuilds from identical canonical inputs must be
byte-identical.

### HTTP resources and bounded response shapes

V1 remains available as `POST /api/projects/:pid/memory/constellation` with its existing body and
response. V2 is additive:

- `GET /api/projects/:pid/memory/constellation/v2/overview`
- `GET /api/projects/:pid/memory/constellation/v2/communities/:communityId?cursor=&limit=`
- `GET /api/projects/:pid/memory/constellation/v2/route?uri=`
- `GET /api/projects/:pid/memory/constellation/v2/entities/:nodeId/incidents?cursor=&limit=`

All routes use existing project authorization. Responses are private and project-scoped. Overview
returns only root community summaries and aggregate routes:

```ts
interface CommunitySummary {
  id: string;
  parentId: string | null;
  level: number;
  label: string;
  memberCount: number;
  childCommunityCount: number;
  typeCounts: Record<string, number>;
  internalEdgeCount: number;
  internalWeight: number;
  normalizedCohesion: number;
  boundaryWeight: number;
  anchor: [number, number, number];
}

interface AggregateRoute {
  fromCommunityId: string;
  toCommunityId: string;
  direction: 'forward' | 'reverse' | 'both';
  count: number;
  weight: number;
  byType: Record<string, number>;
}
```

Community expansion returns either `kind: communities` with `CommunitySummary[]` and aggregate
routes, or `kind: entities` with compact entity records and a backbone/boundary edge page. Entity
records retain v1's `nodeId`, `uri`, `type`, `kind`, `label`, `authority`, `validity`, `isLead`,
`leadReasons`, `degree`, and `groupKey`; `createdAt` remains available in details but is omitted from
compact pages. V2 adds `communityId`, `position: [x,y,z]`, and `boundaryDegree`. Type, authority,
validity, and lead semantics are unchanged and server-authored.

Every page contains `revision`, `coverage`, `nextCursor`, and exact page counts. Cursors are opaque,
URL-safe, and bind generation ID, route kind, parent/entity ID, and the last total-order key. A
cursor from another generation or scope returns `409` with code `constellation_cursor_stale` and
the current overview URL; it is never silently replayed against different data. `limit` defaults
to the measured budget and clamps to the hard bound. Ordering is weight/rank descending followed
by stable ID/URI ascending, so retries return the same page.

Incident pages carry canonical edge direction/type/provenance, the visible endpoint's node ID and
URI, the other endpoint's node ID/URI/label/type, its community path, and `endpointOnCurrentPage`.
High-degree entities expose `nextCursor` and incomplete coverage rather than silently truncating.
An off-page endpoint is truthful context, not an instruction to load its whole community.

The route endpoint maps an exact canonical URI to `{ nodeId, communityPath, generationId }`. A
missing canonical entity is `404`; an entity newer than the served generation returns `409
constellation_generation_stale` and schedules/reports generation work. Search continues through
the shared hybrid memory search and calls this exact-URI route only for chosen hits. Search does
not download pages speculatively.

### Caching and generation availability

Every successful GET emits a strong ETag derived from contract, generation ID, resource identity,
cursor, and limit, plus `Cache-Control: private, max-age=0, must-revalidate`. `If-None-Match` is
checked against derived metadata before page rows are decoded or serialized; an unchanged request
returns `304` with no body. Immutable generation-addressed internals may use long-lived private
caching, but the public head is always revalidated.

If no complete generation exists, v2 returns `503 constellation_generation_unavailable` with
`Retry-After`, current build state, and the textual catalogue URL. It never falls through to a
global v1 scan. A stale complete generation is served with visible revision/state fields while a
replacement builds. Generation failure preserves the previous complete generation and reports
failure only through operations state.

### Edge level of detail and selection

Overview draws only aggregate inter-community routes. Community pages draw a deterministic
maximum-spanning backbone plus highest-weight boundary routes under the page edge budget. Entity
pages draw the same backbone/boundary set. They do not draw every internal edge.

Selecting a community promotes all currently loaded incident aggregate routes in a final render
pass. Selecting an entity pins it, requests incident pages only as needed, promotes loaded incoming
and outgoing canonical edges with direction and type, and dims unrelated visible routes without
removing them. Hover previews this at lower intensity and never overrides pinned selection.
Clearing selection restores the exact prior LOD set. Pagination and coverage remain visible for a
high-degree selection.

### Client navigation, persistence, and accessibility

The v2 renderer is lazy and must use batched GPU buffers/instancing; React owns controls and status,
not one component per graph object. Layout calculation and page integration occur in a dedicated
worker. Camera operations are orbit, pan, dolly, fit-level, focus-selected, and return-to-parent.
Approach alone may offer expansion, but only explicit focus/expand mutates the loaded hierarchy;
reduced-motion mode never auto-flies or auto-expands.

Preferences use `noriq.constellation.v2.<projectId>` and include a schema version, topology/layout
versions, camera, expanded community IDs, filters, and selected URI. Incompatible versions discard
only display preferences. Canonical or derived graph facts are never written to local storage.

The searchable textual catalogue is a peer control, not an error-only escape hatch. It exposes the
same hierarchy path, counts, paging, search focus, selection, inspector, and ego-network actions.
Keyboard operation can traverse parent/child/sibling items, expand/collapse, select, focus, open
details, and return to the parent without using the canvas. Focus is visible and announced through
a concise live region; community size/connectivity and entity type/authority/validity are available
as text, not colour alone.

`prefers-reduced-motion` disables ambient motion and animated camera travel while preserving direct
position changes. Missing WebGL2, context loss, three consecutive over-budget frame windows, worker
failure, or generation unavailability switches to the complete textual catalogue with an explicit
reason and a retry action. Empty canonical graph, unindexed repository, stale generation, building
generation, partial incident page, unreachable store, and rendering fallback are distinct states.

### Product integration and initial cutover

The Memory map keeps the established 2D constellation as its default while production GPU and
dataset budgets are being validated. People can explicitly choose **Try 3D v2** and the choice is
remembered per browser; **Use 2D map** is always available as an immediate escape hatch. This is a
cutover gate, not a separate source of truth: both surfaces preserve the existing inspector and
ego-network URI handoffs.

Search remains hybrid and server-owned. A selected result is routed by its exact canonical URI into
the required hierarchy path, then visually promoted with size as well as colour. Type filters,
breadcrumbs, freshness and coverage labels, and the selected entity's details remain React-owned
controls outside the canvas.

If the GPU renderer cannot start or later loses its context, the v2 controller remains mounted and
shows the same paginated hierarchy as a complete textual catalogue. Search routing, page
continuations, selection, evidence, and ego-network actions continue to work without WebGL. The
fallback therefore changes presentation only; it does not silently return to a bounded v1 sample
or discard navigation state.
