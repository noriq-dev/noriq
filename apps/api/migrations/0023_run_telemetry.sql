-- RUN-22 live Run view: the daemon owns the running agent's telemetry (token/USD
-- burn) and output; forward + persist it so the dashboard can show live spend and
-- a log tail without minting a status transition per tick. Additive + nullable
-- (populated last-writer-wins from the daemon's run.telemetry frames; null before
-- the first tick and for pre-existing rows). No new table → deleteProject's runs
-- cascade already covers these columns.
ALTER TABLE runs ADD COLUMN tokens_used INTEGER;
ALTER TABLE runs ADD COLUMN usd_spent REAL;
ALTER TABLE runs ADD COLUMN log_tail TEXT;
