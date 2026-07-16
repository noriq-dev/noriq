-- PLNR-131: AskUserQuestion-style batched input requests. `questions` holds the batch
-- structure (per-question options, single/multi select, freeform) as JSON; the legacy
-- single title+options shape stays in place untouched. The response remains ONE
-- formatted string either way — that is what agents (and the Runner's resume frame)
-- consume. Additive only.
ALTER TABLE signals ADD COLUMN questions TEXT;
