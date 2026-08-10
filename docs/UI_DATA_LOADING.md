# UI data-loading contract

PLNR-400 separates the browser's live read model from the complete project snapshot.

## Contracts

- `GET /api/projects/:pid/snapshot` remains the heavyweight compatibility/export read. The SPA
  must not call it.
- `GET /api/projects/:pid/ui-state?surface=<surface>` is the SPA invalidation read. `surface` is a
  closed allowlist; unknown values return `400` rather than falling back to full state.
- Metadata-only surfaces (`memory`, `runs`, `agents`, `executions`, `intelligence`, and project
  settings) execute one D1 query and return empty project collections. Those views use their own
  bounded or paginated APIs.
- Task surfaces receive task summaries and only the relationships their renderers consume. Task
  markdown bodies come from `GET /api/tasks/:tid` when the drawer opens. Full plan/phase/plan-doc
  bodies are limited to the Plans surface.
- Board body search uses cancellable 256-id pages from `task-body-matches`; it is the only list
  operation that reads task bodies, and only after a human enters a text query.
- Events remain capped at 60. The response's `project.eventSeq` preserves WebSocket resume
  semantics even on surfaces that do not load the event feed.

## Performance expectation and observability

The production target for a representative project is a p95 server duration below 250 ms for a
metadata-only surface and below the former approximately 500 ms full-snapshot baseline for every
surface. This is a production observation target, not a claim made by local tests.

Every response exposes:

- `Server-Timing: ui-state;dur=<milliseconds>;desc="<surface>"`
- `X-Noriq-UI-Surface: <surface>`
- `X-Noriq-Query-Count: <count>`
- `Cache-Control: private, no-store`

The API regression suite holds metadata-only reads at one query, checks task bodies stay out of
board state, and verifies the full snapshot remains available only when explicitly requested.
The web regression suite verifies global routes issue no project read and that the client uses
`/ui-state`, forwards cancellation, and never aliases that call back to `/snapshot`.

## Refresh behavior

The store keeps at most one UI-state request in flight. Duplicate invalidations for the same
project and surface share that promise plus at most one trailing refresh; navigation aborts the old surface request. WebSocket,
focus, visibility, online, and mutation refreshes all target the current surface while selected
task detail refreshes independently.
