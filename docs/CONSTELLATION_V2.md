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
