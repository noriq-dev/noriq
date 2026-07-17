-- RUN-59: a run records what it ACTUALLY spent per model, not just what the dispatch asked
-- for (runs.model, 0033). The SDK's per-model aggregate is authoritative — an "opus" run
-- already burns real tokens on a haiku sub-agent, and runs.model has never shown it.
--
-- JSON, keyed by model id → {inputTokens, outputTokens, cacheReadInputTokens,
-- cacheCreationInputTokens, costUSD}. A column, not a child table (per the task): it is
-- written whole, read whole, and never queried across runs — and D1 forbids table rebuilds,
-- so a wrong normalisation is expensive to undo. Additive ALTER, like 0032/0033.
-- NULL = "not reported" (codex, an old runner, a driver that can't break spend down).
ALTER TABLE runs ADD COLUMN model_usage TEXT;
