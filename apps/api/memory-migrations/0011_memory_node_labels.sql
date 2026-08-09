-- ProjectMemory schema v11 (PLNR-314) — backfill: memory graph nodes labelled with their KIND,
-- not their content.
--
-- Never edit 0001-0010; this is a data-only UPDATE, no schema change. See
-- src/memory/migrations.ts's header comment for the full how-to-add-a-migration contract.
--
-- Before this task, `recordMemory` (ProjectMemory.ts) wrote every memory node's label as
-- `input.kind` — so a `hazard`/`decision`/`unknown` memory rendered as a star literally titled
-- "hazard"/"decision"/"unknown", and several memories of the same kind were indistinguishable on
-- the map. `kind` already travels as its own field on the constellation wire (graph-queries.ts
-- resolves it from `memory_items.kind`), so the label was the only place a node's actual content
-- could appear — the fix (same task) makes `recordMemory` write a bounded excerpt of the
-- memory's `statement` instead, via `ProjectMemory.memoryNodeLabel()`. This migration is the
-- one-time backfill for every node written before that fix shipped.
--
-- `nodes` and `memory_items` live in the SAME DO SQLite — a plain local UPDATE joined on the
-- `noriq://memory/{id}` uri (buildEntityUri's `default:` arm — memory is not one of the
-- repository-scoped kinds, so the uri is just `noriq://memory/<id>`, i.e. everything after the
-- fixed `noriq://memory/` prefix IS `memory_items.id`). No D1, no cross-store dance.
--
-- The 80-char bound and whitespace-collapse mirror `ProjectMemory.memoryNodeLabel()` as closely
-- as SQLite's string functions allow: CR/LF/TAB collapse to a single space each (the case that
-- actually matters — a multi-line statement making an unreadable label) and a run of ordinary
-- spaces is left alone, since SQLite has no regex replace to fully collapse arbitrary whitespace
-- runs in one pass. A node this backfill touches gets the exact TS-side normalization the next
-- time its memory is corrected (recordMemory + supersedesMemoryId) and rewrites its label.
--
-- Deliberately does NOT touch `nodes.type`'s CHECK constraint or any node/edge type vocabulary
-- (fixed in migration 0001) — this only ever assigns to the existing `label` column.
UPDATE nodes
SET label = (
  SELECT CASE WHEN LENGTH(excerpt) > 80 THEN SUBSTR(excerpt, 1, 79) || '…' ELSE excerpt END
  FROM (
    SELECT TRIM(REPLACE(REPLACE(REPLACE(mi.statement, CHAR(13), ' '), CHAR(10), ' '), CHAR(9), ' ')) AS excerpt
    FROM memory_items mi
    WHERE mi.id = SUBSTR(nodes.uri, LENGTH('noriq://memory/') + 1)
  )
)
WHERE nodes.type = 'memory'
  AND EXISTS (
    SELECT 1 FROM memory_items mi WHERE mi.id = SUBSTR(nodes.uri, LENGTH('noriq://memory/') + 1)
  );
